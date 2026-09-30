/**
 * github.js — GitHub REST access + OAuth Device Flow, zero dependencies.
 *
 * Every network call goes through `fetchImpl`, which defaults to the global
 * `fetch`. The verification script swaps `globalThis.fetch` for a mock, so this
 * whole module is testable without a network.
 *
 * Two endpoint families are involved:
 *   - api.github.com            REST, `Authorization: Bearer <token>`
 *   - github.com/login/...      the OAuth endpoints (form-encoded, JSON reply)
 *
 * Device Flow is the reason a plugin can sign a user in without ever holding an
 * OAuth client *secret*: the app only needs its public client id, the user
 * approves on github.com, and the host polls for the token.
 */

import * as nodeTls from 'node:tls';

const API_BASE = 'https://api.github.com';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_AGENT = 'dsh-plugin-github-link';
const TIMEOUT_MS = 20_000;

/**
 * `repo` is the narrowest scope that can list *private* repositories: GitHub has
 * no read-only variant for them. `read:user` gives the account profile.
 */
export const DEFAULT_SCOPES = 'repo read:user';

export class GitHubError extends Error {
  constructor(message, { status = 0, code = '', body = undefined } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function apiHeaders(token) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': USER_AGENT,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

function queryString(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded ? `?${encoded}` : '';
}

async function readJson(response) {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * undici reports every transport-level failure as a bare `TypeError: fetch
 * failed` and keeps the real reason (ENOTFOUND, ECONNREFUSED, certificate
 * errors, proxy failures) in `error.cause`. Flatten the whole cause chain and
 * attach a hint, otherwise the GUI can only ever show "fetch failed", which is
 * impossible to act on.
 */
const NETWORK_HINTS = [
  [/ENOTFOUND|EAI_AGAIN|ENODATA/i, 'DNS 解析失败：断网、DNS 污染或 hosts 被改'],
  [/ECONNREFUSED/i, '目标拒绝连接：本机代理没启动、端口填错，或被防火墙拦截'],
  [/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|HeadersTimeout|BodyTimeout|TimeoutError|请求已取消/i, '连接超时：直连不通，通常需要走代理'],
  [/ECONNRESET|UND_ERR_SOCKET|EPIPE|UND_ERR_ABORTED/i, '连接被重置：常见于 TLS 被中间设备打断'],
  [/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/i, 'TLS 证书校验失败：系统时间不对或有 HTTPS 中间人'],
  [/ERR_INVALID_URL/i, 'URL 非法'],
];

export function describeNetworkError(error) {
  const parts = [];
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
    const code = current.code || current.errno || '';
    const message = typeof current.message === 'string' ? current.message : String(current);
    if (!message) continue;
    const text = code && !message.includes(String(code)) ? `${message} [${code}]` : message;
    if (!parts.includes(text)) parts.push(text);
  }
  const chain = parts.join(' ← ');
  const hint = NETWORK_HINTS.find(([pattern]) => pattern.test(chain));
  return hint ? `${chain}（${hint[1]}）` : chain;
}

function networkError(error) {
  const detail = describeNetworkError(error) || String(error);
  return new GitHubError(`无法连接 GitHub：${detail}`, { code: 'network' });
}

// ── system certificate store ───────────────────────────────────────────────

/**
 * Windows tools that inspect HTTPS — SteamTools/Steam++, corporate TLS
 * inspection, some antivirus "web shields" — install their root CA in the
 * *system* store. Browsers trust it (they use that store), Node does not: it
 * validates against its own bundled CA list and every request dies with
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, which surfaces in the GUI as the useless
 * `无法连接 GitHub：fetch failed`.
 *
 * Node >= 24.8 can adopt the OS store at runtime. Do it lazily, only *after* a
 * certificate failure, so a user who does not need it never gets a
 * process-wide TLS default changed under them.
 */
let systemCaStatus = 'idle'; // 'idle' | 'applied' | 'unavailable'

export function getSystemCaStatus() {
  return systemCaStatus;
}

/** Returns `true` when the process-wide default CA set now includes the OS store. */
export function useSystemCertificateStore() {
  if (systemCaStatus === 'applied') return true;
  if (systemCaStatus === 'unavailable') return false;
  try {
    if (
      typeof nodeTls.getCACertificates !== 'function' ||
      typeof nodeTls.setDefaultCACertificates !== 'function'
    ) {
      systemCaStatus = 'unavailable';
      return false;
    }
    const system = nodeTls.getCACertificates('system');
    if (!Array.isArray(system) || system.length === 0) {
      systemCaStatus = 'unavailable';
      return false;
    }
    nodeTls.setDefaultCACertificates(system);
    systemCaStatus = 'applied';
    return true;
  } catch {
    systemCaStatus = 'unavailable';
    return false;
  }
}

/** Walk the cause chain looking for any TLS-validation failure. */
export function isCertificateError(error) {
  const parts = [];
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
    parts.push(String(current.code || ''), String(current.message || ''));
  }
  return /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|unable to verify|leaf signature|DEPTH_ZERO/i
    .test(parts.join(' '));
}

/**
 * One fetch, with a single automatic retry after adopting the OS trust store
 * when — and only when — the first attempt failed certificate validation.
 */
async function fetchWithSystemCaRetry(fetchImpl, url, init) {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    if (!isCertificateError(error) || !useSystemCertificateStore()) throw error;
    return await fetchImpl(url, init);
  }
}

/**
 * One REST call. `headers` is returned too so callers can read
 * `x-oauth-scopes` / rate-limit headers.
 */
export async function apiRequestRaw(path, options = {}) {
  const {
    token,
    method = 'GET',
    query,
    body,
    fetchImpl = fetch,
    baseUrl = API_BASE,
  } = options;
  const url = `${baseUrl}${path}${queryString(query)}`;
  let response;
  try {
    response = await fetchWithSystemCaRetry(fetchImpl, url, {
      method,
      headers: {
        ...apiHeaders(token),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(TIMEOUT_MS)
        : undefined,
    });
  } catch (error) {
    throw networkError(error);
  }
  const data = await readJson(response);
  if (!response.ok) {
    const message = data && data.message ? data.message : `GitHub 返回 HTTP ${response.status}`;
    throw new GitHubError(message, { status: response.status, body: data });
  }
  return { data, headers: response.headers };
}

export async function apiRequest(path, options = {}) {
  const { data } = await apiRequestRaw(path, options);
  return data;
}

async function postForm(url, params, fetchImpl) {
  let response;
  try {
    response = await fetchWithSystemCaRetry(fetchImpl, url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': USER_AGENT,
      },
      body: new URLSearchParams(params).toString(),
      signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(TIMEOUT_MS)
        : undefined,
    });
  } catch (error) {
    throw networkError(error);
  }
  return { ok: response.ok, status: response.status, data: await readJson(response) };
}

// ── Device Flow ────────────────────────────────────────────────────────────

/** Step 1: ask GitHub for a user code the human types into the browser. */
export async function startDeviceFlow(options = {}) {
  const {
    clientId,
    scopes = DEFAULT_SCOPES,
    fetchImpl = fetch,
    deviceCodeUrl = DEVICE_CODE_URL,
  } = options;
  if (!clientId) {
    throw new GitHubError('尚未配置 OAuth App Client ID', { code: 'no_client_id' });
  }
  const result = await postForm(deviceCodeUrl, { client_id: clientId, scope: scopes }, fetchImpl);
  const data = result.data || {};
  if (!result.ok || data.error || !data.device_code) {
    throw new GitHubError(
      data.error_description || data.error || `GitHub 返回 HTTP ${result.status}`,
      { status: result.status, body: data },
    );
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri || 'https://github.com/login/device',
    expiresIn: Number(data.expires_in) || 900,
    interval: Number(data.interval) || 5,
  };
}

/** Step 2: poll once. The caller owns the interval and the expiry clock. */
export async function pollDeviceFlow(options = {}) {
  const { clientId, deviceCode, fetchImpl = fetch, tokenUrl = ACCESS_TOKEN_URL } = options;
  const result = await postForm(
    tokenUrl,
    {
      client_id: clientId,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    },
    fetchImpl,
  );
  const data = result.data || {};
  if (data.access_token) {
    return { status: 'authorized', token: data.access_token, scopes: data.scope || '' };
  }
  const code = data.error || '';
  if (code === 'authorization_pending') return { status: 'pending' };
  if (code === 'slow_down') return { status: 'slow_down' };
  if (code === 'expired_token') return { status: 'expired' };
  if (code === 'access_denied') return { status: 'denied' };
  throw new GitHubError(data.error_description || code || `GitHub 返回 HTTP ${result.status}`, {
    status: result.status,
    code,
    body: data,
  });
}

// ── Identity ───────────────────────────────────────────────────────────────

export function normalizeUser(user) {
  if (!user || typeof user !== 'object') return null;
  return {
    login: user.login || '',
    name: user.name || '',
    id: user.id || 0,
    avatarUrl: user.avatar_url || '',
    htmlUrl: user.html_url || '',
    type: user.type || 'User',
    company: user.company || '',
    publicRepos: user.public_repos || 0,
    followers: user.followers || 0,
  };
}

/** Validate a token and return the viewer plus the scopes GitHub reports. */
export async function getViewer(token, fetchImpl = fetch) {
  const { data, headers } = await apiRequestRaw('/user', { token, fetchImpl });
  let scopes = '';
  try {
    scopes = headers && typeof headers.get === 'function' ? headers.get('x-oauth-scopes') || '' : '';
  } catch {
    scopes = '';
  }
  return { user: normalizeUser(data), scopes };
}

// ── Repositories ───────────────────────────────────────────────────────────

export function normalizeRepo(repo) {
  if (!repo || typeof repo !== 'object') return null;
  return {
    id: repo.id || 0,
    fullName: repo.full_name || '',
    name: repo.name || '',
    owner: (repo.owner && repo.owner.login) || '',
    ownerAvatar: (repo.owner && repo.owner.avatar_url) || '',
    private: !!repo.private,
    fork: !!repo.fork,
    archived: !!repo.archived,
    description: repo.description || '',
    language: repo.language || '',
    stars: repo.stargazers_count || 0,
    forks: repo.forks_count || 0,
    openIssues: repo.open_issues_count || 0,
    sizeKb: repo.size || 0,
    defaultBranch: repo.default_branch || '',
    updatedAt: repo.updated_at || '',
    pushedAt: repo.pushed_at || '',
    htmlUrl: repo.html_url || '',
    cloneUrl: repo.clone_url || '',
    topics: Array.isArray(repo.topics) ? repo.topics.slice(0, 8) : [],
    license: (repo.license && repo.license.spdx_id) || '',
  };
}

/**
 * `q` switches to the search API (which can also see private repos when the
 * token carries `repo`, as long as the query is scoped to the viewer).
 * Without `q` we list `/user/repos`, which is the "my repositories" listing and
 * supports `visibility` and server-side sort.
 */
export async function listRepositories(options = {}) {
  const {
    token,
    login,
    q = '',
    visibility = 'all',
    sort = 'updated',
    page = 1,
    perPage = 30,
    fetchImpl = fetch,
  } = options;
  const query = String(q || '').trim();
  if (query) {
    const terms = [`${query} in:name`];
    if (login) terms.push(`user:${login}`);
    const data = await apiRequest('/search/repositories', {
      token,
      fetchImpl,
      query: {
        q: terms.join(' '),
        sort: sort === 'stars' ? 'stars' : 'updated',
        order: 'desc',
        per_page: perPage,
        page,
      },
    });
    const items = Array.isArray(data && data.items) ? data.items : [];
    return {
      repos: items.map(normalizeRepo).filter(Boolean),
      total: (data && data.total_count) || items.length,
      hasMore: items.length >= perPage,
      source: 'search',
    };
  }
  const items = await apiRequest('/user/repos', {
    token,
    fetchImpl,
    query: {
      visibility: visibility === 'all' ? undefined : visibility,
      sort: sort === 'stars' ? 'stars' : 'updated',
      direction: 'desc',
      per_page: perPage,
      page,
      affiliation: 'owner,collaborator,organization_member',
    },
  });
  const repos = Array.isArray(items) ? items.map(normalizeRepo).filter(Boolean) : [];
  return { repos, total: repos.length, hasMore: repos.length >= perPage, source: 'user' };
}

export async function getRepository(fullName, fetchImpl = fetch, token) {
  const data = await apiRequest(`/repos/${fullName}`, { token, fetchImpl });
  return normalizeRepo(data);
}

export async function listBranches(fullName, options = {}) {
  const { token, fetchImpl = fetch, perPage = 30 } = options;
  const data = await apiRequest(`/repos/${fullName}/branches`, {
    token,
    fetchImpl,
    query: { per_page: perPage },
  });
  if (!Array.isArray(data)) return [];
  return data.map((branch) => ({
    name: branch.name || '',
    protected: !!branch.protected,
    sha: (branch.commit && branch.commit.sha) || '',
  }));
}

export async function listCommits(fullName, options = {}) {
  const { token, fetchImpl = fetch, perPage = 10, branch = '' } = options;
  const data = await apiRequest(`/repos/${fullName}/commits`, {
    token,
    fetchImpl,
    query: { per_page: perPage, sha: branch || undefined },
  });
  if (!Array.isArray(data)) return [];
  return data.map((commit) => {
    const info = commit.commit || {};
    const author = info.author || {};
    const message = String(info.message || '');
    return {
      sha: commit.sha || '',
      shortSha: String(commit.sha || '').slice(0, 7),
      message: message.split('\n')[0].slice(0, 200),
      authorName: author.name || (commit.author && commit.author.login) || '',
      authorAvatar: (commit.author && commit.author.avatar_url) || '',
      date: author.date || '',
      htmlUrl: commit.html_url || '',
    };
  });
}

// ── Reachability probe ─────────────────────────────────────────────────────

/**
 * One unauthenticated GET against GitHub, used by the settings page's
 * "测试连接" button: it separates "my proxy is broken" from "my token is
 * broken" without walking the whole device flow. Throws a `GitHubError` with
 * the full cause chain, exactly like every other call here.
 */
export async function probeConnectivity(options = {}) {
  const { fetchImpl = fetch, baseUrl = API_BASE } = options;
  const started = Date.now();
  await apiRequest('/meta', { fetchImpl, baseUrl });
  return { elapsedMs: Date.now() - started };
}
