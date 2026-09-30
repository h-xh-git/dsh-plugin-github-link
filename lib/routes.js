/**
 * routes.js — the host's HTTP surface.
 *
 * One prefix registration (`/github-link`) with an internal dispatcher: the
 * browser half is same-origin, so plain `fetch` is enough and no RPC layer is
 * needed. Every POST demands `Content-Type: application/json`, which forces a
 * CORS preflight for any cross-origin caller and therefore keeps a random web
 * page from driving the clone endpoint (CSRF hardening, on top of the webserver's
 * own origin handling).
 *
 * The response body never contains the token. `publicState()` is the single
 * place that decides what the GUI may see.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import {
  DEFAULT_SCOPES,
  GitHubError,
  getRepository,
  getViewer,
  listBranches,
  listCommits,
  listRepositories,
  pollDeviceFlow,
  probeConnectivity,
  getSystemCaStatus,
  startDeviceFlow,
} from './github.js';
import {
  cloneRepository,
  describeDest,
  gitAvailable,
  parseRepoFullName,
  redact,
  resolveCloneTarget,
} from './clone.js';
import {
  createProxiedFetch,
  maskProxyUrl,
  normalizeProxyUrl,
  proxyHasPassword,
  resolveProxyConfig,
} from './proxy.js';
import {
  MAX_UPLOAD_BYTES,
  WARN_UPLOAD_BYTES,
  applyPublish,
  applyRemoteFolder,
  ensureGitignore,
  identityFor,
  listDirectories,
  normalizeRemotePath,
  planPublish,
  planRemoteFolder,
  pullRepository,
  repoStatus,
  scanDirectory,
} from './publish.js';
import { publicState, readCredentials, resolveClientId, writeCredentials } from './store.js';

export const BASE_PATH = '/github-link';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_ACTIVE_FLOWS = 8;
const PER_PAGE = 30;

// ── small HTTP helpers ─────────────────────────────────────────────────────

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  let body;
  try {
    body = JSON.stringify(payload);
  } catch {
    body = JSON.stringify({ error: 'response not serializable' });
  }
  res.statusCode = status;
  try {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
  } catch {
    /* headers already sent */
  }
  res.end(body);
}

function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolvePromise) => {
    let body = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      body += chunk;
      if (body.length > limit) {
        finish({ error: '请求体过大' });
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
      }
    });
    req.on('end', () => {
      if (!body) return finish({ value: {} });
      try {
        const parsed = JSON.parse(body);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return finish({ error: '请求体必须是 JSON 对象' });
        }
        return finish({ value: parsed });
      } catch {
        return finish({ error: '请求体不是合法 JSON' });
      }
    });
    req.on('error', () => finish({ error: '请求读取失败' }));
  });
}

function errorStatus(error) {
  if (error instanceof GitHubError) {
    if (error.code === 'no_client_id') return 400;
    if (error.status === 401) return 401;
    if (error.status === 403 || error.status === 404 || error.status === 422) return error.status;
    if (error.code === 'network') return 502;
    return 502;
  }
  return 500;
}

function errorPayload(error) {
  if (error instanceof GitHubError) {
    return { error: error.message, code: error.code || '', githubStatus: error.status || 0 };
  }
  return { error: String(error && error.message ? error.message : error) };
}

// ── route table ────────────────────────────────────────────────────────────

function workspacesOf(ctx) {
  try {
    const registry = ctx && typeof ctx.get === 'function'
      ? ctx.get('workspaceRegistry')
      : ctx && ctx.workspaceRegistry;
    if (!registry || typeof registry.list !== 'function') return [];
    const list = registry.list() || [];
    return list
      .map((workspace) => ({
        id: String(workspace && workspace.id ? workspace.id : ''),
        title: String((workspace && (workspace.title || workspace.name)) || ''),
        path: String((workspace && workspace.path) || ''),
      }))
      .filter((workspace) => workspace.path);
  } catch {
    // A profile without the workspace registry still gets the whole plugin,
    // except for clone targets.
    return [];
  }
}

/**
 * Resolve a directory that the caller asked us to publish into. Same discipline
 * as clone: it must be the workspace root itself or a real subdirectory of one,
 * proved by string prefix after `resolve()`, so `..` and absolute paths cannot
 * escape the registered workspace.
 */
function resolveWorkspaceDir(ctx, workspaceId, subdir = '') {
  const workspaces = workspacesOf(ctx);
  if (!workspaces.length) return { ok: false, error: '没有可用的工作区，请先在 DSH 中打开一个目录' };
  const wanted = String(workspaceId || '');
  const workspace = workspaces.find((item) => item.id === wanted) || (wanted ? undefined : workspaces[0]);
  if (!workspace) return { ok: false, error: '所选工作区不存在' };
  const base = resolve(workspace.path);
  const clean = String(subdir || '').trim().replace(/^[/\\]+|[/\\]+$/g, '');
  const dir = clean ? resolve(base, clean) : base;
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
  const same = dir.toLowerCase() === base.toLowerCase();
  if (!same && !dir.toLowerCase().startsWith(prefix.toLowerCase())) {
    return { ok: false, error: '目录必须位于所选工作区之内' };
  }
  if (!existsSync(dir)) return { ok: false, error: `目录不存在：${dir}` };
  return { ok: true, dir, workspace };
}

function isRepoName(raw) {
  return /^[A-Za-z0-9._-]{1,100}$/.test(String(raw || '')) && raw !== '.' && raw !== '..';
}

/** `sub/path` of `dir` relative to `base`, forward-slashed, '' at the root. */
function relativeTo(base, dir) {
  const root = resolve(base);
  const target = resolve(dir);
  if (target.toLowerCase() === root.toLowerCase()) return '';
  return target
    .slice(root.length)
    .replace(/^[/\\]+/, '')
    .replace(/\\/g, '/');
}

function requireToken() {
  const creds = readCredentials();
  if (typeof creds.token !== 'string' || !creds.token) {
    const error = new GitHubError('尚未连接 GitHub 账号', { status: 401, code: 'not_connected' });
    throw error;
  }
  return creds.token;
}

/** A 401 from GitHub means the stored credential is dead: drop it. */
function handleTokenRejection(error) {
  if (error instanceof GitHubError && error.status === 401) {
    writeCredentials({ token: undefined, user: undefined, scopes: undefined, tokenKind: undefined });
    return { ...errorPayload(error), reconnect: true };
  }
  return undefined;
}

function pruneFlows(flows) {
  const now = Date.now();
  for (const [id, flow] of flows) {
    if (flow.expiresAt <= now) flows.delete(id);
  }
  while (flows.size > MAX_ACTIVE_FLOWS) {
    const oldest = flows.keys().next();
    if (oldest.done) break;
    flows.delete(oldest.value);
  }
}

// ── registration ───────────────────────────────────────────────────────────

/**
 * Mount the whole surface. Returns the webServer disposer.
 * `deps` = { ctx, log }.
 */
export function registerGitHubRoutes(webServer, deps) {
  const { ctx, log } = deps;
  /**
   * Optional `config.clientId` from the bundle row in `cordis.patch.yml`. The
   * plugin declares no Config schema, so this is read defensively and is only a
   * third way (after the plugin UI and `DSH_GITHUB_CLIENT_ID`) to pre-seed the
   * public OAuth App id — never a hard requirement.
   */
  const configClientId = deps && deps.config && typeof deps.config.clientId === 'string'
    ? deps.config.clientId.trim()
    : '';
  /**
   * Optional `config.proxy` from the bundle row, e.g.
   * `config: { proxy: 'http://127.0.0.1:7890' }`. This is the strongest of the
   * three sources; `resolveProxyConfig` documents the full order.
   */
  const configProxy = deps && deps.config && typeof deps.config.proxy === 'string'
    ? deps.config.proxy.trim()
    : '';
  /**
   * Optional `config.allowedHosts` — extra Host names this route accepts beyond
   * loopback, for reverse proxies / LAN access the user explicitly opts into.
   * `['*']` disables the check and is documented as unsafe.
   */
  const allowedHosts = deps && deps.config && Array.isArray(deps.config.allowedHosts)
    ? deps.config.allowedHosts.map((item) => String(item).trim().toLowerCase()).filter(Boolean)
    : [];

  /**
   * DNS-rebinding guard. A hostile page can point its own hostname at
   * 127.0.0.1, after which the browser treats this server as *same-origin* —
   * which would defeat the JSON content-type CSRF gate and let the page read
   * `/state` (absolute paths, git remotes, repository names) or drive
   * `/clone` and `/publish/*`. In that scenario `Host` is the one header the
   * page cannot forge, so anything that is neither loopback nor explicitly
   * allow-listed is refused.
   *
   * A *missing* Host header is allowed on purpose: browsers always send one,
   * while plain HTTP/1.0 clients and the verification harness do not.
   */
  function hostAllowed(hostHeader) {
    const raw = String(hostHeader || '').trim().toLowerCase();
    if (!raw) return true;
    if (allowedHosts.includes('*')) return true;
    const host = raw.startsWith('[') ? raw.slice(1, raw.indexOf(']')) : raw.split(':')[0];
    if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1' || /^127\./.test(host)) return true;
    return allowedHosts.includes(host);
  }
  /** flowId → device-flow bookkeeping. Never persisted: a pending sign-in does not survive a restart. */
  const flows = new Map();

  /** Which proxy (if any) is in force right now, and where it came from. */
  function activeProxy() {
    return resolveProxyConfig({
      override: configProxy,
      stored: readCredentials().proxy,
      env: process.env,
    });
  }

  /**
   * A `fetch` bound to the configured proxy, or `undefined` meaning "use the
   * global fetch" — which is also what the verification suite swaps for a mock,
   * so an unconfigured plugin keeps its old behaviour exactly.
   */
  function requestFetch() {
    const plan = activeProxy();
    if (!plan.url) return undefined;
    try {
      return createProxiedFetch(plan.url);
    } catch (error) {
      log.warn(`proxy unusable, using a direct connection: ${error && error.message ? error.message : error}`);
      return undefined;
    }
  }

  /**
   * The network block the GUI renders: which proxy is in force, and whether the
   * OS trust store had to be adopted because something on this machine MITMs
   * TLS. Only masked URLs ever leave the host — proxy credentials are as
   * sensitive as the GitHub token.
   */
  function networkState() {
    const stored = readCredentials().proxy;
    const plan = activeProxy();
    return {
      proxy: {
        active: !!plan.url,
        url: maskProxyUrl(plan.url),
        source: plan.source || 'none',
        envVar: plan.envVar || '',
        disabled: !!plan.disabled,
        error: plan.error || '',
        stored: maskProxyUrl(stored || ''),
        storedHasPassword: proxyHasPassword(stored || ''),
        configOverride: maskProxyUrl(configProxy),
      },
      tls: {
        // 'idle' | 'applied' | 'unavailable' — 'applied' means a certificate
        // failure was seen and the OS store fixed it.
        systemCa: getSystemCaStatus(),
      },
    };
  }

  async function handleState(req, res) {
    const git = await gitAvailable();
    sendJson(res, 200, {
      plugin: 'dsh-plugin-github-link',
      basePath: BASE_PATH,
      defaultScopes: DEFAULT_SCOPES,
      ...publicState(readCredentials(), configClientId),
      ...networkState(),
      workspaces: workspacesOf(ctx),
      git,
    });
  }

  async function handleProxyConfig(req, res, body) {
    const current = readCredentials().proxy;
    const currentText = typeof current === 'string' ? current : '';
    let raw = typeof body.url === 'string' ? body.url.trim() : '';
    // The GUI is shown a masked URL; echoing that value back must not wipe the
    // stored password.
    if (raw && maskProxyUrl(currentText) === raw) raw = currentText;
    const normalized = normalizeProxyUrl(raw);
    if (!normalized.ok && !normalized.empty) {
      return sendJson(res, 400, { error: normalized.error });
    }
    writeCredentials({ proxy: normalized.ok ? normalized.url : undefined });
    log.info(normalized.ok ? `proxy set to ${maskProxyUrl(normalized.url)}` : 'proxy cleared');
    return sendJson(res, 200, {
      ok: true,
      ...publicState(readCredentials(), configClientId),
      ...networkState(),
    });
  }

  async function handleConfig(req, res, body) {
    const raw = typeof body.clientId === 'string' ? body.clientId.trim() : '';
    if (raw && !/^[A-Za-z0-9._-]{8,64}$/.test(raw)) {
      return sendJson(res, 400, { error: 'Client ID 格式不正确（应为 GitHub OAuth App 的 Client ID）' });
    }
    writeCredentials({ clientId: raw || undefined });
    log.info(raw ? 'OAuth App client id updated' : 'OAuth App client id cleared');
    return sendJson(res, 200, {
      ok: true,
      ...publicState(readCredentials(), configClientId),
      ...networkState(),
    });
  }

  async function handleDeviceStart(req, res) {
    const { clientId } = resolveClientId(readCredentials(), configClientId);
    if (!clientId) {
      return sendJson(res, 400, {
        error: '请先填写 GitHub OAuth App 的 Client ID',
        code: 'no_client_id',
      });
    }
    const flow = await startDeviceFlow({ clientId, fetchImpl: requestFetch() });
    pruneFlows(flows);
    const flowId = randomUUID();
    flows.set(flowId, {
      clientId,
      deviceCode: flow.deviceCode,
      interval: flow.interval,
      expiresAt: Date.now() + flow.expiresIn * 1000,
      nextPollAt: Date.now() + flow.interval * 1000,
      scopes: DEFAULT_SCOPES,
    });
    log.info(`device flow started (expires in ${flow.expiresIn}s)`);
    return sendJson(res, 200, {
      flowId,
      userCode: flow.userCode,
      verificationUri: flow.verificationUri,
      expiresIn: flow.expiresIn,
      interval: flow.interval,
    });
  }

  async function handleDevicePoll(req, res, _body, search) {
    const flowId = String(search.get('flowId') || '');
    const flow = flows.get(flowId);
    if (!flow) {
      return sendJson(res, 200, { status: 'expired', error: '设备码已失效，请重新开始' });
    }
    if (flow.expiresAt <= Date.now()) {
      flows.delete(flowId);
      return sendJson(res, 200, { status: 'expired', error: '设备码已过期，请重新开始' });
    }
    // Never hammer GitHub: a client that polls too fast simply gets the same
    // pending answer back without an upstream round trip.
    if (Date.now() < flow.nextPollAt) {
      return sendJson(res, 200, {
        status: 'pending',
        interval: flow.interval,
        expiresAt: flow.expiresAt,
      });
    }
    flow.nextPollAt = Date.now() + flow.interval * 1000;
    const result = await pollDeviceFlow({
      clientId: flow.clientId,
      deviceCode: flow.deviceCode,
      fetchImpl: requestFetch(),
    });
    // `authorization_pending` is the *normal* answer while the user is still
    // typing the code into the browser, so it must keep the flow alive. Only a
    // terminal answer (expired / denied) may drop it — doing otherwise made the
    // code die on the first upstream poll, five seconds after it was shown.
    if (result.status === 'pending') {
      return sendJson(res, 200, { status: 'pending', interval: flow.interval, expiresAt: flow.expiresAt });
    }
    if (result.status === 'slow_down') {
      flow.interval += 5;
      flow.nextPollAt = Date.now() + flow.interval * 1000;
      return sendJson(res, 200, { status: 'pending', interval: flow.interval, expiresAt: flow.expiresAt });
    }
    if (result.status !== 'authorized') {
      flows.delete(flowId);
      return sendJson(res, 200, { status: result.status, expiresAt: flow.expiresAt });
    }
    flows.delete(flowId);
    const { user, scopes } = await getViewer(result.token, requestFetch());
    writeCredentials({
      token: result.token,
      user,
      scopes: scopes || result.scopes || '',
      tokenKind: 'oauth',
      connectedAt: new Date().toISOString(),
    });
    log.info(`device flow authorized as ${user ? user.login : 'unknown'}`);
    return sendJson(res, 200, { status: 'authorized', user, scopes: scopes || result.scopes || '' });
  }

  /**
   * "测试连接": reach GitHub once, through the proxy in the box (or through the
   * currently effective one when the box is empty). The point is to answer
   * "是不是代理没配好" without making the user start a device flow first.
   */
  async function handleProxyTest(req, res, body) {
    const raw = typeof body.url === 'string' ? body.url.trim() : '';
    let url = '';
    if (raw) {
      const normalized = normalizeProxyUrl(raw);
      if (!normalized.ok && !normalized.empty) {
        return sendJson(res, 400, { error: normalized.error });
      }
      url = normalized.ok ? normalized.url : '';
    } else {
      url = activeProxy().url;
    }
    let fetchImpl;
    if (url) {
      try {
        fetchImpl = createProxiedFetch(url);
      } catch (error) {
        return sendJson(res, 400, { error: error && error.message ? error.message : String(error) });
      }
    }
    const via = url ? maskProxyUrl(url) : 'direct';
    try {
      const result = await probeConnectivity({ fetchImpl });
      log.info(`connectivity probe ok via ${via} in ${result.elapsedMs}ms`);
      return sendJson(res, 200, { ok: true, via, ...result });
    } catch (error) {
      log.warn(`connectivity probe failed via ${via}: ${error && error.message ? error.message : error}`);
      return sendJson(res, errorStatus(error), { ...errorPayload(error), via, ok: false });
    }
  }

  async function handleToken(req, res, body) {
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    if (!token || token.length < 20 || /\s/.test(token)) {
      return sendJson(res, 400, { error: 'Token 格式不正确' });
    }
    let viewer;
    try {
      viewer = await getViewer(token, requestFetch());
    } catch (error) {
      if (error instanceof GitHubError && (error.status === 401 || error.status === 404)) {
        return sendJson(res, 401, { error: 'Token 无效或已过期' });
      }
      throw error;
    }
    if (!viewer.user) return sendJson(res, 401, { error: 'Token 无效' });
    writeCredentials({
      token,
      user: viewer.user,
      scopes: viewer.scopes,
      tokenKind: 'pat',
      connectedAt: new Date().toISOString(),
    });
    log.info(`personal access token accepted for ${viewer.user.login}`);
    return sendJson(res, 200, {
      status: 'authorized',
      user: viewer.user,
      scopes: viewer.scopes,
      ...publicState(readCredentials(), configClientId),
      ...networkState(),
    });
  }

  async function handleLogout(req, res) {
    writeCredentials({ token: undefined, user: undefined, scopes: undefined, tokenKind: undefined });
    log.info('credentials cleared');
    return sendJson(res, 200, {
      ok: true,
      ...publicState(readCredentials(), configClientId),
      ...networkState(),
    });
  }

  async function withToken(res, operation) {
    let token;
    try {
      token = requireToken();
    } catch (error) {
      sendJson(res, errorStatus(error), errorPayload(error));
      return undefined;
    }
    try {
      return await operation(token);
    } catch (error) {
      const reconnect = handleTokenRejection(error);
      sendJson(res, errorStatus(error), reconnect || errorPayload(error));
      return undefined;
    }
  }

  async function handleRepos(req, res, _body, search) {
    const creds = readCredentials();
    const login = creds.user && creds.user.login ? creds.user.login : '';
    return withToken(res, async (token) => {
      const page = Math.max(1, Number.parseInt(search.get('page') || '1', 10) || 1);
      const visibility = ['all', 'private', 'public'].includes(search.get('visibility'))
        ? search.get('visibility')
        : 'all';
      const sort = search.get('sort') === 'stars' ? 'stars' : 'updated';
      const result = await listRepositories({
        token,
        login,
        q: search.get('q') || '',
        visibility,
        sort,
        page,
        perPage: PER_PAGE,
        fetchImpl: requestFetch(),
      });
      sendJson(res, 200, { ...result, page, perPage: PER_PAGE });
    });
  }

  async function handleRepoDetail(req, res, _body, search) {
    const parsed = parseRepoFullName(search.get('full'));
    if (!parsed) return sendJson(res, 400, { error: '仓库名必须是 owner/name 形式' });
    const fullName = `${parsed.owner}/${parsed.name}`;
    return withToken(res, async (token) => {
      const fetchImpl = requestFetch();
      const repo = await getRepository(fullName, fetchImpl, token);
      if (!repo) return sendJson(res, 404, { error: '仓库不存在或无权访问' });
      const [branches, commits] = await Promise.all([
        listBranches(fullName, { token, fetchImpl }).catch(() => []),
        listCommits(fullName, { token, fetchImpl, perPage: 10 }).catch(() => []),
      ]);
      return sendJson(res, 200, { repo, branches, commits });
    });
  }

  async function handleWorkspaces(req, res) {
    return sendJson(res, 200, { workspaces: workspacesOf(ctx) });
  }

  /**
   * Local git status of the registered workspaces, for the upload/update panel.
   * Read-only git; nothing here can change a directory.
   */
  async function handleLocal(req, res, _body, search) {
    const wanted = String(search.get('workspaceId') || '');
    const workspaces = workspacesOf(ctx).filter((item) => (wanted ? item.id === wanted : true));
    const result = await Promise.all(
      workspaces.map(async (workspace) => {
        let git;
        try {
          git = await repoStatus(workspace.path, {});
        } catch (error) {
          git = { repo: false, error: String(error && error.message ? error.message : error) };
        }
        return { ...workspace, git };
      }),
    );
    return sendJson(res, 200, { workspaces: result });
  }

  /**
   * One level of the workspace tree, for the "upload this folder" picker. The
   * same bounds check as publishing applies, so browsing can never leave a
   * registered workspace.
   */
  async function handleLocalDirs(req, res, _body, search) {
    const target = resolveWorkspaceDir(ctx, search.get('workspaceId'), search.get('subdir'));
    if (!target.ok) return sendJson(res, 400, { error: target.error });
    const subdir = relativeTo(target.workspace.path, target.dir);
    return sendJson(res, 200, {
      workspaceId: target.workspace.id,
      subdir,
      path: target.dir,
      parent: subdir ? subdir.split('/').slice(0, -1).join('/') : '',
      dirs: listDirectories(target.dir),
    });
  }

  /** Shared by plan + apply so both read the same request the same way. */
  async function publishRequest(body) {
    const creds = readCredentials();
    const login = (creds.user && creds.user.login) || '';
    const kind = body.kind === 'upload' ? 'upload' : body.kind === 'remote-dir' ? 'remote-dir' : 'update';
    const target = resolveWorkspaceDir(ctx, body.workspaceId, body.subdir);
    if (!target.ok) return { error: target.error };
    const remotePath = typeof body.remotePath === 'string' ? body.remotePath.trim() : '';
    if (kind === 'remote-dir') {
      const parsed = parseRepoFullName(body.full);
      if (!parsed) return { error: '请选择要上传到的 GitHub 仓库（owner/name）' };
      const normalized = normalizeRemotePath(remotePath);
      if (!normalized.ok) return { error: normalized.error };
      return {
        creds,
        login,
        kind,
        create: '',
        repoName: '',
        full: `${parsed.owner}/${parsed.name}`,
        remotePath: normalized.path,
        remoteUrl: '',
        dir: target.dir,
        workspace: target.workspace,
        subdir: remotePath,
        message: typeof body.message === 'string' ? body.message.trim().slice(0, 200) : '',
        branch:
          typeof body.branch === 'string' && /^[A-Za-z0-9._/-]{1,100}$/.test(body.branch.trim())
            ? body.branch.trim()
            : '',
        private: !!body.private,
        description: '',
        addGitignore: false,
        confirmRisky: !!body.confirmRisky,
        targetFull: '',
        remoteBranchInput: typeof body.branch === 'string' ? body.branch.trim() : '',
      };
    }
    const create = body.create === 'new' ? 'new' : '';
    const repoName = typeof body.repoName === 'string' ? body.repoName.trim() : '';
    if (create && !isRepoName(repoName)) {
      return { error: '仓库名只能包含字母、数字、点、下划线、连字符' };
    }
    let full = '';
    let remoteUrl = '';
    if (!create) {
      const parsed = parseRepoFullName(body.full);
      if (parsed) {
        full = `${parsed.owner}/${parsed.name}`;
        remoteUrl = `https://github.com/${full}.git`;
      } else if (kind === 'update') {
        // "Update" means "push this workspace to its own origin" — the user
        // should not have to pick a repository they already configured.
        const status = await repoStatus(target.dir, {});
        if (!status.repo || !status.remote) {
          return { error: '这个目录还没有配置 origin remote，请改用「上传」并选择目标仓库' };
        }
        remoteUrl = status.remote;
        const match = /github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(status.remote);
        if (match) full = `${match[1]}/${match[2]}`;
      } else {
        return { error: '请选择要上传到的 GitHub 仓库（owner/name）' };
      }
    }
    return {
      creds,
      login,
      kind,
      create,
      repoName,
      full,
      remoteUrl,
      dir: target.dir,
      workspace: target.workspace,
      message: typeof body.message === 'string' ? body.message.trim().slice(0, 200) : '',
      branch: typeof body.branch === 'string' && /^[A-Za-z0-9._\/-]{1,100}$/.test(body.branch.trim())
        ? body.branch.trim()
        : 'main',
      private: body.private === undefined ? true : !!body.private,
      description: typeof body.description === 'string' ? body.description.trim().slice(0, 350) : '',
      addGitignore: !!body.addGitignore,
      confirmRisky: !!body.confirmRisky,
    };
  }

  /**
   * Bring the remote's commits into a workspace checkout. Modes: `ff`
   * (fast-forward only), `onto` (keep the working tree, rebuild the branch on
   * top of the remote tip) and `merge`. None of them ever force-pushes or
   * deletes a local file.
   */
  async function handlePull(req, res, body) {
    const request = await publishRequest(body);
    if (request.error) return sendJson(res, 400, { error: request.error });
    const mode = body.mode === 'onto' ? 'onto' : body.mode === 'merge' ? 'merge' : 'ff';
    return withToken(res, async (token) => {
      log.info(`pull ${mode} ${request.dir}`);
      const result = await pullRepository({
        dir: request.dir,
        mode,
        token,
        proxyUrl: activeProxy().url,
        identity: identityFor(request.creds),
        message: typeof body.message === 'string' ? body.message.trim().slice(0, 200) : '',
        commitDirty: !!body.commitDirty,
        log,
      });
      if (!result.ok) {
        return sendJson(res, 409, {
          error: result.error,
          code: result.code || 'pull_failed',
          hint: result.hint || '',
          behind: result.behind,
          ahead: result.ahead,
          steps: result.steps,
        });
      }
      return sendJson(res, 200, { ok: true, ...result });
    });
  }

  async function handlePublishPlan(req, res, body) {
    const request = await publishRequest(body);
    if (request.error) return sendJson(res, 400, { error: request.error });
    const plan = request.kind === 'remote-dir'
      ? await planRemoteFolder({
          dir: request.dir,
          full: request.full,
          remotePath: request.remotePath,
          branch: request.branch,
          token: request.creds.token || '',
          fetchImpl: requestFetch(),
        })
      : await planPublish({
          dir: request.dir,
          kind: request.kind,
          create: request.create,
          repoName: request.repoName,
          full: request.full,
          remoteUrl: request.remoteUrl,
          login: request.login,
          token: request.creds.token || '',
          proxyUrl: activeProxy().url,
          identity: identityFor(request.creds),
          branch: request.branch,
          addGitignore: request.addGitignore,
        });
    return sendJson(res, 200, {
      ...plan,
      login: request.login,
      connected: !!request.creds.token,
      workspace: { id: request.workspace.id, title: request.workspace.title, path: request.workspace.path },
    });
  }

  /**
   * Run the plan. Two gates stand in front of the write: the freshly computed
   * plan (a diverged remote, an oversized directory or a missing remote stop
   * here) and the explicit `confirmRisky` flag when the directory contains
   * things that look like secrets.
   */
  async function handlePublishApply(req, res, body) {
    const request = await publishRequest(body);
    if (request.error) return sendJson(res, 400, { error: request.error });
    return withToken(res, async (token) => {
      const scan = scanDirectory(request.dir);
      if (scan.bytes > MAX_UPLOAD_BYTES) {
        return sendJson(res, 413, {
          error: `目录约 ${Math.round(scan.bytes / 1024 / 1024)} MB，超过 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB 上限，已拒绝上传`,
          scan,
        });
      }
      const risky = scan.risky.length > 0 || scan.bytes > WARN_UPLOAD_BYTES;
      if (risky && !request.confirmRisky) {
        return sendJson(res, 409, {
          error: '目录里有可能不该上传的路径，需要你确认后才会上传',
          needConfirm: true,
          scan,
        });
      }

      if (request.kind === 'remote-dir') {
        const plan = await planRemoteFolder({
          dir: request.dir,
          full: request.full,
          remotePath: request.remotePath,
          branch: request.branch,
          token,
          fetchImpl: requestFetch(),
          scan: false,
        });
        if (!plan.ok) {
          return sendJson(res, 409, { error: plan.blockers.map((item) => item.text).join('；'), plan });
        }
        log.info(`publish remote-dir ${request.dir} -> ${request.full}/${plan.remotePath}#${plan.branch}`);
        const result = await applyRemoteFolder({
          dir: request.dir,
          full: request.full,
          remotePath: plan.remotePath,
          branch: plan.branch,
          token,
          proxyUrl: activeProxy().url,
          identity: identityFor(request.creds),
          message: request.message,
          log,
        });
        if (!result.ok) {
          return sendJson(res, result.code === 'non_fast_forward' ? 409 : 502, {
            error: result.error,
            code: result.code || 'publish_failed',
            hint: result.hint || '',
            steps: result.steps,
            full: result.full,
            remotePath: result.remotePath,
            branch: result.branch,
          });
        }
        return sendJson(res, 200, {
          ok: true,
          kind: 'remote-dir',
          full: result.full,
          remotePath: result.remotePath,
          branch: result.branch,
          htmlUrl: `https://github.com/${result.full}/tree/${result.branch}/${result.remotePath}`,
          committed: result.committed,
          commit: result.commit || '',
          pushed: result.pushed,
          upToDate: !!result.upToDate,
          steps: result.steps,
          scan: { files: scan.files, bytes: scan.bytes, risky: scan.risky },
        });
      }

      const plan = await planPublish({
        dir: request.dir,
        kind: request.kind,
        create: request.create,
        repoName: request.repoName,
        full: request.full,
        remoteUrl: request.remoteUrl,
        login: request.login,
        token,
        proxyUrl: activeProxy().url,
        identity: identityFor(request.creds),
        branch: request.branch,
        scan: false,
      });
      if (!plan.ok) {
        return sendJson(res, 409, { error: plan.blockers.map((item) => item.text).join('；'), plan });
      }

      let gitignore = { created: false };
      if (request.addGitignore) gitignore = ensureGitignore(request.dir);

      log.info(
        `publish ${request.kind} ${request.dir} -> ${request.create ? `${request.login}/${request.repoName}` : request.full}`,
      );
      const result = await applyPublish({
        dir: request.dir,
        kind: request.kind,
        create: request.create,
        repoName: request.repoName,
        full: request.full,
        remoteUrl: request.remoteUrl,
        login: request.login,
        token,
        proxyUrl: activeProxy().url,
        identity: identityFor(request.creds),
        message: request.message,
        branch: request.branch,
        private: request.private,
        description: request.description,
        fetchImpl: requestFetch(),
        log,
      });
      if (!result.ok) {
        return sendJson(res, result.code === 'non_fast_forward' ? 409 : 502, {
          error: result.error,
          code: result.code || 'publish_failed',
          hint: result.hint || '',
          steps: result.steps,
          created: result.created,
          full: result.full,
          htmlUrl: result.htmlUrl,
        });
      }
      return sendJson(res, 200, {
        ok: true,
        kind: request.kind,
        full: result.full,
        htmlUrl: result.htmlUrl,
        branch: result.branch,
        created: result.created,
        committed: result.committed,
        commit: result.commit || '',
        pushed: result.pushed,
        upToDate: !!result.upToDate,
        steps: result.steps,
        gitignore,
        scan: { files: scan.files, bytes: scan.bytes, risky: scan.risky },
      });
    });
  }

  async function handleClone(req, res, body) {
    const parsed = parseRepoFullName(body.full);
    if (!parsed) return sendJson(res, 400, { error: '仓库名必须是 owner/name 形式' });
    const fullName = `${parsed.owner}/${parsed.name}`;
    const repoName = typeof body.name === 'string' && body.name.trim()
      ? body.name.trim()
      : parsed.name;
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(repoName) || repoName === '.' || repoName === '..') {
      return sendJson(res, 400, { error: '本地目录名不合法' });
    }
    const requestedId = typeof body.workspaceId === 'string' ? body.workspaceId : '';

    // Auth first: a disconnected user should be told to sign in, not to pick a
    // different directory.
    return withToken(res, async (token) => {
      const git = await gitAvailable();
      if (!git.available) {
        return sendJson(res, 500, { error: '未找到 git 可执行文件，请先安装 Git 并确保在 PATH 中' });
      }
      const workspaces = workspacesOf(ctx);
      if (workspaces.length === 0) {
        return sendJson(res, 400, { error: '没有可用的工作区，请先在 DSH 中打开一个目录' });
      }
      const workspace = workspaces.find((item) => item.id === requestedId) || workspaces[0];
      const target = resolveCloneTarget(workspace.path, repoName, body.subdir);
      if (!target.ok) return sendJson(res, 400, { error: target.error });
      const existing = describeDest(target.dest);
      if (existing.exists) {
        return sendJson(res, 409, {
          error: `目标已存在：${target.dest}`,
          path: target.dest,
          hint: '换一个本地目录名，或先在文件管理器里移走它。',
        });
      }
      const result = await cloneRepository({
        full: fullName,
        dest: target.dest,
        token,
        log,
        proxyUrl: activeProxy().url,
      });
      if (!result.ok) {
        return sendJson(res, 502, {
          error: `git clone 失败：${result.error}`,
          detail: redact(result.detail, token),
        });
      }
      return sendJson(res, 200, {
        ok: true,
        full: fullName,
        path: result.path,
        workspaceId: workspace.id,
        elapsedMs: result.elapsedMs,
        detail: redact(result.detail, token),
      });
    });
  }

  function notFound(res, sub) {
    sendJson(res, 404, { error: `未知端点：${sub}` });
  }

  async function handle(req, res) {
    const hostHeader = req && req.headers ? req.headers.host : '';
    if (!hostAllowed(hostHeader)) {
      log.warn(`rejected a request whose Host is not loopback: ${hostHeader}`);
      return sendJson(res, 403, {
        error: '请求的 Host 不是本机回环地址，已拒绝（防 DNS rebinding）',
        code: 'host_not_allowed',
        hint: '如确实需要经反向代理/局域网访问，请在 bundle 配置里加 allowedHosts: ["你的主机名"]。',
      });
    }
    let pathname = '/';
    let search = new URLSearchParams();
    try {
      const url = new URL(String(req.url || '/'), 'http://127.0.0.1');
      pathname = url.pathname;
      search = url.searchParams;
    } catch {
      return sendJson(res, 400, { error: '非法请求 URL' });
    }
    const method = String(req.method || 'GET').toUpperCase();
    const sub = pathname === BASE_PATH || pathname === `${BASE_PATH}/`
      ? '/'
      : pathname.startsWith(`${BASE_PATH}/`)
        ? pathname.slice(BASE_PATH.length)
        : null;
    if (sub === null) return sendJson(res, 404, { error: 'not found' });

    // GET surface
    if (method === 'GET' || method === 'HEAD') {
      try {
        if (sub === '/' || sub === '/health') {
          return sendJson(res, 200, {
            ok: true,
            plugin: 'dsh-plugin-github-link',
            basePath: BASE_PATH,
            pid: process.pid,
          });
        }
        if (sub === '/state') return await handleState(req, res);
        if (sub === '/repos') return await handleRepos(req, res, {}, search);
        if (sub === '/repo') return await handleRepoDetail(req, res, {}, search);
        if (sub === '/workspaces') return await handleWorkspaces(req, res);
        if (sub === '/local') return await handleLocal(req, res, {}, search);
        if (sub === '/local/dirs') return await handleLocalDirs(req, res, {}, search);
        if (sub === '/device/poll') return await handleDevicePoll(req, res, {}, search);
      } catch (error) {
        log.warn(`GET ${sub} failed: ${error && error.message ? error.message : error}`);
        return sendJson(res, errorStatus(error), errorPayload(error));
      }
      return notFound(res, `${method} ${sub}`);
    }

    if (method !== 'POST') {
      return sendJson(res, 405, { error: `不支持的方法：${method}` });
    }

    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      return sendJson(res, 415, { error: 'POST 请求必须使用 Content-Type: application/json' });
    }
    const parsed = await readJsonBody(req);
    if (parsed.error) return sendJson(res, 400, { error: parsed.error });
    const body = parsed.value;

    try {
      if (sub === '/config') return await handleConfig(req, res, body);
      if (sub === '/proxy') return await handleProxyConfig(req, res, body);
      if (sub === '/proxy/test') return await handleProxyTest(req, res, body);
      if (sub === '/device/start') return await handleDeviceStart(req, res, body);
      if (sub === '/token') return await handleToken(req, res, body);
      if (sub === '/logout') return await handleLogout(req, res, body);
      if (sub === '/clone') return await handleClone(req, res, body);
      if (sub === '/publish/plan') return await handlePublishPlan(req, res, body);
      if (sub === '/publish/apply') return await handlePublishApply(req, res, body);
      if (sub === '/publish/pull') return await handlePull(req, res, body);
    } catch (error) {
      log.warn(`POST ${sub} failed: ${error && error.message ? error.message : error}`);
      return sendJson(res, errorStatus(error), errorPayload(error));
    }
    return notFound(res, `${method} ${sub}`);
  }

  // Exactly one registration: a prefix row. Mounting the same path twice trips
  // the webserver's duplicate-route guard (and would take the whole plugin tree
  // down at boot), so the bare `/github-link` is handled by the dispatcher
  // inside the same handler instead of by a second `exact` row.
  const dispose = webServer.register({ kind: 'prefix', path: BASE_PATH, handler: handle });
  const startupProxy = activeProxy();
  if (startupProxy.error) log.warn(`proxy setting ignored: ${startupProxy.error}`);
  log.info(
    startupProxy.url
      ? `github requests go through proxy ${maskProxyUrl(startupProxy.url)} (source: ${startupProxy.source})`
      : 'no proxy configured; github requests go direct',
  );
  log.info(`routes mounted under ${BASE_PATH}/*`);
  return () => {
    try {
      dispose();
    } catch {
      /* already disposed */
    }
  };
}
