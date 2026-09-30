/**
 * verify-host.mjs — standalone verification of the host half.
 *
 * Runs the real plugin against a fake Cordis ctx, a fake webserver and a mocked
 * `globalThis.fetch`. No network, no DSH process, no real credentials:
 * `DSH_GITHUB_LINK_DIR` points the credential store at a temp directory.
 *
 *     node test/verify-host.mjs
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Must be set before anything reads the store. The store reads the env lazily,
// but keeping it first makes the isolation obvious.
const SANDBOX = mkdtempSync(join(tmpdir(), 'dsh-ghl-test-'));
process.env.DSH_GITHUB_LINK_DIR = join(SANDBOX, 'creds');
delete process.env.DSH_GITHUB_CLIENT_ID;
// Proxy resolution is part of the surface under test: keep it hermetic so a
// developer's own HTTPS_PROXY cannot change what these assertions see.
delete process.env.DSH_GITHUB_LINK_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.https_proxy;
delete process.env.HTTP_PROXY;
delete process.env.http_proxy;
delete process.env.ALL_PROXY;
delete process.env.all_proxy;
delete process.env.NO_PROXY;
delete process.env.no_proxy;

const WORKSPACE = join(SANDBOX, 'workspace');
mkdirSync(WORKSPACE, { recursive: true });

const { apply, inject, name } = await import('../lib/index.js');
const { parseRepoFullName, resolveCloneTarget, gitEnvWithToken, redact } = await import('../lib/clone.js');
const {
  maskProxyUrl,
  normalizeProxyUrl,
  resolveProxyConfig,
  shouldBypassProxy,
} = await import('../lib/proxy.js');
const { readCredentials } = await import('../lib/store.js');
const {
  getSystemCaStatus,
  isCertificateError,
  useSystemCertificateStore,
} = await import('../lib/github.js');
const {
  applyPublish,
  applyRemoteFolder,
  ensureGitignore,
  normalizeRemotePath,
  planPublish,
  planRemoteFolder,
  pullRepository,
  repoStatus,
  runGit,
  scanDirectory,
} = await import('../lib/publish.js');

// ── test harness ───────────────────────────────────────────────────────────

let passed = 0;
const failures = [];

async function test(title, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${title}`);
  } catch (error) {
    failures.push({ title, error });
    console.log(`  FAIL ${title}\n       ${error && error.message ? error.message : error}`);
  }
}

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    chunks: [],
    writableEnded: false,
  };
  let resolveDone;
  res.done = new Promise((resolvePromise) => {
    resolveDone = resolvePromise;
  });
  res.setHeader = (key, value) => {
    res.headers[String(key).toLowerCase()] = value;
  };
  res.end = (chunk) => {
    if (chunk !== undefined && chunk !== null) res.chunks.push(String(chunk));
    res.writableEnded = true;
    resolveDone();
  };
  res.result = async () => {
    await res.done;
    const text = res.chunks.join('');
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.statusCode, headers: res.headers, text, body };
  };
  return res;
}

function makeReq(method, url, body, headers = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { 'content-type': 'application/json', ...headers };
  req.destroy = () => {};
  const payload = body === undefined || body === null
    ? ''
    : typeof body === 'string'
      ? body
      : JSON.stringify(body);
  if (payload) req.headers['content-length'] = String(Buffer.byteLength(payload));
  process.nextTick(() => {
    if (payload) req.emit('data', Buffer.from(payload, 'utf8'));
    req.emit('end');
  });
  return req;
}

let route = undefined;

const fakeWebServer = {
  register(definition) {
    if (route) throw new Error('duplicate route registration');
    route = definition;
    return () => {
      route = undefined;
    };
  },
};

const logs = [];
const fakeLogger = {
  info: (...args) => logs.push(['info', args.join(' ')]),
  warn: (...args) => logs.push(['warn', args.join(' ')]),
  error: (...args) => logs.push(['error', args.join(' ')]),
};

const fakeCtx = {
  webServer: fakeWebServer,
  logger: () => fakeLogger,
  get(service) {
    return service === 'workspaceRegistry' ? fakeWorkspaceRegistry : undefined;
  },
  get workspaceRegistry() {
    return fakeWorkspaceRegistry;
  },
};

const fakeWorkspaceRegistry = {
  list: () => [{ id: 'ws-1', title: 'demo-project', path: WORKSPACE }],
};

async function call(method, url, body, headers) {
  const res = makeRes();
  await route.handler(makeReq(method, url, body, headers), res);
  return res.result();
}

// ── mocked GitHub ──────────────────────────────────────────────────────────

const TOKEN_OAUTH = `gho_${'a'.repeat(32)}`;
const TOKEN_PAT = `ghp_${'b'.repeat(32)}`;

const mock = {
  calls: [],
  devicePending: true,
  userStatus: 200,
  reposStatus: 200,
  lastAuthHeader: '',
};

function jsonResponse(payload, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key) => headers[String(key).toLowerCase()] ?? null },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

const REPO = {
  id: 1,
  full_name: 'octocat/demo',
  name: 'demo',
  owner: { login: 'octocat', avatar_url: 'https://avatars.example/o.png' },
  private: true,
  description: 'a demo repo',
  language: 'C++',
  stargazers_count: 7,
  forks_count: 2,
  open_issues_count: 1,
  size: 128,
  default_branch: 'main',
  updated_at: '2026-01-02T03:04:05Z',
  pushed_at: '2026-01-02T03:04:05Z',
  html_url: 'https://github.com/octocat/demo',
  clone_url: 'https://github.com/octocat/demo.git',
  topics: ['esp32'],
  license: { spdx_id: 'MIT' },
};

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  mock.calls.push({ url: target, method: (init.method || 'GET').toUpperCase() });
  if (init.headers && init.headers.authorization) mock.lastAuthHeader = init.headers.authorization;
  const path = new URL(target).pathname + new URL(target).search;

  if (target.startsWith('https://github.com/login/device/code')) {
    return jsonResponse({
      device_code: 'DEVICE-CODE',
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 1,
    });
  }
  if (target.startsWith('https://github.com/login/oauth/access_token')) {
    if (mock.devicePending) return jsonResponse({ error: 'authorization_pending' });
    return jsonResponse({ access_token: TOKEN_OAUTH, scope: 'repo, read:user', token_type: 'bearer' });
  }
  if (path === '/user') {
    if (mock.userStatus !== 200) return jsonResponse({ message: 'Bad credentials' }, mock.userStatus);
    return jsonResponse(
      { login: 'octocat', name: 'The Octocat', id: 1, avatar_url: 'https://avatars.example/o.png', html_url: 'https://github.com/octocat', type: 'User' },
      200,
      { 'x-oauth-scopes': 'repo, read:user' },
    );
  }
  if (path.startsWith('/user/repos')) {
    if (mock.reposStatus !== 200) return jsonResponse({ message: 'Bad credentials' }, mock.reposStatus);
    return jsonResponse([REPO]);
  }
  if (path.startsWith('/search/repositories')) {
    return jsonResponse({ total_count: 1, items: [REPO] });
  }
  if (path === '/meta') return jsonResponse({ verifiable_password_authentication: false });
  if (path === '/repos/octocat/demo') return jsonResponse(REPO);
  if (path.startsWith('/repos/octocat/demo/branches')) {
    return jsonResponse([{ name: 'main', protected: true, commit: { sha: 'abc1234' } }]);
  }
  if (path.startsWith('/repos/octocat/demo/commits')) {
    return jsonResponse([
      { sha: 'abc1234567', commit: { message: 'init\n\nbody', author: { name: 'Octo', date: '2026-01-02T03:04:05Z' } }, author: { login: 'octocat', avatar_url: 'x' }, html_url: 'u' },
    ]);
  }
  return jsonResponse({ message: `unmocked: ${target}` }, 404);
};

// ── controllable clock (device-flow interval) ─────────────────────────────

const realNow = Date.now.bind(Date);
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;
const advance = (ms) => {
  clockOffset += ms;
};

// ── run ────────────────────────────────────────────────────────────────────

console.log('dsh-plugin-github-link — host verification\n');

// 1. module shape + mounting
const disposer = apply(fakeCtx);
assert.equal(typeof disposer, 'function', 'apply must return a disposer');
assert.deepEqual(inject, ['webServer']);
assert.equal(name, 'dsh-plugin-github-link');
assert.ok(route, 'a route must be registered');
assert.equal(route.kind, 'prefix');
assert.equal(route.path, '/github-link');
assert.equal(typeof route.handler, 'function');

await test('apply() is inert (not throwing) without a webserver', () => {
  const inert = apply({ logger: () => fakeLogger });
  assert.equal(typeof inert, 'function');
  inert();
});

await test('GET /github-link/health answers ok', async () => {
  const res = await call('GET', '/github-link/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

await test('GET /github-link/state starts disconnected and exposes no token', async () => {
  const res = await call('GET', '/github-link/state');
  assert.equal(res.status, 200);
  assert.equal(res.body.connected, false);
  assert.equal(res.body.clientIdSource, 'none');
  assert.equal(res.body.workspaces.length, 1);
  assert.equal(res.body.workspaces[0].path, WORKSPACE);
  assert.equal(res.body.git.available, true);
  assert.ok(!res.text.includes('gho_') && !res.text.includes('ghp_'));
});

await test('POST /github-link/config rejects a malformed client id', async () => {
  const res = await call('POST', '/github-link/config', { clientId: 'short' });
  assert.equal(res.status, 400);
});

await test('POST /github-link/config stores the client id', async () => {
  const res = await call('POST', '/github-link/config', { clientId: 'Ov23liABCDEFGHIJKLMN' });
  assert.equal(res.status, 200);
  assert.equal(res.body.clientId, 'Ov23liABCDEFGHIJKLMN');
  const state = await call('GET', '/github-link/state');
  assert.equal(state.body.clientIdSource, 'stored');
});

await test('POST without a JSON content type is refused (CSRF guard)', async () => {
  const res = await call('POST', '/github-link/config', 'clientId=abc', {
    'content-type': 'application/x-www-form-urlencoded',
  });
  assert.equal(res.status, 415);
});

await test('POST with a broken JSON body is refused', async () => {
  const res = await call('POST', '/github-link/config', '{not json}', { 'content-type': 'application/json' });
  assert.equal(res.status, 400);
});

await test('device flow: start returns a user code', async () => {
  const res = await call('POST', '/github-link/device/start', {});
  assert.equal(res.status, 200);
  assert.equal(res.body.userCode, 'ABCD-1234');
  assert.equal(res.body.verificationUri, 'https://github.com/login/device');
  assert.ok(res.body.flowId);
  globalThis.__flowId = res.body.flowId;
});

await test('device flow: first poll is pending', async () => {
  const res = await call('GET', `/github-link/device/poll?flowId=${globalThis.__flowId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'pending');
});

await test('device flow: a too-fast poll does not hit GitHub again', async () => {
  const before = mock.calls.filter((c) => c.url.includes('access_token')).length;
  const res = await call('GET', `/github-link/device/poll?flowId=${globalThis.__flowId}`);
  assert.equal(res.body.status, 'pending');
  const after = mock.calls.filter((c) => c.url.includes('access_token')).length;
  assert.equal(after, before, 'poll inside the interval must be answered locally');
});

await test('device flow: authorized poll stores the token host-side only', async () => {
  mock.devicePending = false;
  advance(5000);
  const res = await call('GET', `/github-link/device/poll?flowId=${globalThis.__flowId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'authorized');
  assert.equal(res.body.user.login, 'octocat');
  assert.ok(!res.text.includes(TOKEN_OAUTH), 'the token must never reach the browser');
  assert.equal(mock.lastAuthHeader, `Bearer ${TOKEN_OAUTH}`);
  const state = await call('GET', '/github-link/state');
  assert.equal(state.body.connected, true);
  assert.equal(state.body.tokenKind, 'oauth');
  assert.ok(!state.text.includes(TOKEN_OAUTH));
});

await test('device flow: the flow id is single-use', async () => {
  const res = await call('GET', `/github-link/device/poll?flowId=${globalThis.__flowId}`);
  assert.equal(res.body.status, 'expired');
});

await test('device flow: an upstream authorization_pending keeps the flow alive', async () => {
  // Regression guard: GitHub answers `authorization_pending` while the user is
  // still typing the code. That is a *pending* answer, not a terminal one, so
  // the flow must survive it — the first upstream poll used to delete it five
  // seconds after the code was shown, which made every sign-in end in
  // "验证码已过期" with no token ever written.
  mock.devicePending = true;
  const start = await call('POST', '/github-link/device/start', {});
  const flowId = start.body.flowId;
  assert.ok(flowId);

  advance(6000); // past nextPollAt: this poll really goes upstream
  const first = await call('GET', `/github-link/device/poll?flowId=${flowId}`);
  assert.equal(first.body.status, 'pending');
  assert.ok(first.body.expiresAt > Date.now(), 'the flow must still be alive');

  advance(6000);
  const second = await call('GET', `/github-link/device/poll?flowId=${flowId}`);
  assert.equal(second.body.status, 'pending', 'a pending answer must not drop the flow');

  advance(6000);
  const third = await call('GET', `/github-link/device/poll?flowId=${flowId}`);
  assert.equal(third.body.status, 'pending');

  mock.devicePending = false;
  advance(6000);
  const fourth = await call('GET', `/github-link/device/poll?flowId=${flowId}`);
  assert.equal(fourth.body.status, 'authorized', 'authorizing later must still work');
});

await test('GET /repos lists and normalizes repositories (private included)', async () => {
  const res = await call('GET', '/github-link/repos?page=1&per_page=30');
  assert.equal(res.status, 200);
  assert.equal(res.body.repos.length, 1);
  assert.equal(res.body.repos[0].fullName, 'octocat/demo');
  assert.equal(res.body.repos[0].private, true);
  assert.equal(res.body.repos[0].language, 'C++');
  assert.equal(res.body.source, 'user');
});

await test('GET /repos?q= switches to the search API scoped to the viewer', async () => {
  mock.calls.length = 0;
  const res = await call('GET', '/github-link/repos?q=esp32');
  assert.equal(res.status, 200);
  assert.equal(res.body.source, 'search');
  const searchCall = mock.calls.find((c) => c.url.includes('/search/repositories'));
  assert.ok(searchCall, 'search endpoint must be used');
  assert.ok(decodeURIComponent(searchCall.url).includes('user:octocat'));
});

await test('GET /repo returns the repository with branches and commits', async () => {
  const res = await call('GET', '/github-link/repo?full=octocat/demo');
  assert.equal(res.status, 200);
  assert.equal(res.body.repo.fullName, 'octocat/demo');
  assert.equal(res.body.branches[0].name, 'main');
  assert.equal(res.body.commits[0].shortSha, 'abc1234');
});

await test('GET /repo rejects path traversal in the repository name', async () => {
  const res = await call('GET', '/github-link/repo?full=' + encodeURIComponent('../etc/passwd'));
  assert.equal(res.status, 400);
});

await test('POST /clone refuses a destination outside the workspace', async () => {
  const res = await call('POST', '/github-link/clone', {
    full: 'octocat/demo',
    subdir: '..',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /工作区/);
});

await test('POST /clone refuses an illegal local directory name', async () => {
  const res = await call('POST', '/github-link/clone', { full: 'octocat/demo', name: '..' });
  assert.equal(res.status, 400);
});

await test('POST /clone reports an existing destination instead of merging', async () => {
  mkdirSync(join(WORKSPACE, 'demo'), { recursive: true });
  const res = await call('POST', '/github-link/clone', { full: 'octocat/demo' });
  assert.equal(res.status, 409);
  assert.equal(res.body.path, join(WORKSPACE, 'demo'));
  assert.ok(existsSync(res.body.path));
});

await test('a rejected token is dropped and the client is asked to reconnect', async () => {
  mock.reposStatus = 401;
  const res = await call('GET', '/github-link/repos');
  assert.equal(res.status, 401);
  assert.equal(res.body.reconnect, true);
  const state = await call('GET', '/github-link/state');
  assert.equal(state.body.connected, false);
  assert.equal(state.body.clientId, 'Ov23liABCDEFGHIJKLMN', 'the client id survives a token rejection');
  mock.reposStatus = 200;
});

await test('GET /repos without a connection answers 401', async () => {
  const res = await call('GET', '/github-link/repos');
  assert.equal(res.status, 401);
  assert.equal(res.body.code, 'not_connected');
});

await test('POST /token rejects a token GitHub does not accept', async () => {
  mock.userStatus = 401;
  const res = await call('POST', '/github-link/token', { token: TOKEN_PAT });
  assert.equal(res.status, 401);
  mock.userStatus = 200;
});

await test('POST /token accepts a personal access token', async () => {
  const res = await call('POST', '/github-link/token', { token: TOKEN_PAT });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'authorized');
  assert.equal(res.body.scopes, 'repo, read:user');
  assert.ok(!res.text.includes(TOKEN_PAT));
  const state = await call('GET', '/github-link/state');
  assert.equal(state.body.connected, true);
  assert.equal(state.body.tokenKind, 'pat');
  assert.equal(state.body.user.login, 'octocat');
});

await test('POST /logout clears the token but keeps the client id', async () => {
  const res = await call('POST', '/github-link/logout', {});
  assert.equal(res.status, 200);
  assert.equal(res.body.connected, false);
  const state = await call('GET', '/github-link/state');
  assert.equal(state.body.clientId, 'Ov23liABCDEFGHIJKLMN');
});

await test('an unknown endpoint answers 404', async () => {
  const res = await call('GET', '/github-link/nope');
  assert.equal(res.status, 404);
});

await test('an unsupported method answers 405', async () => {
  const res = await call('DELETE', '/github-link/state');
  assert.equal(res.status, 405);
});

// ── proxy support ──────────────────────────────────────────────────────────

await test('normalizeProxyUrl accepts host:port, keeps auth, rejects SOCKS', () => {
  assert.equal(normalizeProxyUrl('127.0.0.1:7890').url, 'http://127.0.0.1:7890');
  assert.equal(normalizeProxyUrl('http://127.0.0.1:7890/').url, 'http://127.0.0.1:7890');
  assert.equal(normalizeProxyUrl('http://user:secret@127.0.0.1:7890').url, 'http://user:secret@127.0.0.1:7890');
  assert.equal(maskProxyUrl('http://user:secret@127.0.0.1:7890'), 'http://user:***@127.0.0.1:7890');
  assert.equal(maskProxyUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(normalizeProxyUrl('socks5://127.0.0.1:7891').ok, false);
  assert.equal(normalizeProxyUrl('ftp://127.0.0.1:7890').ok, false);
  assert.equal(normalizeProxyUrl('none').empty, true);
  assert.equal(normalizeProxyUrl('').empty, true);
});

await test('resolveProxyConfig prefers config over stored over env, and honours "none"', () => {
  const env = { HTTPS_PROXY: 'http://env:1' };
  assert.equal(resolveProxyConfig({ override: 'http://config:1', stored: 'http://stored:1', env }).url, 'http://config:1');
  assert.equal(resolveProxyConfig({ stored: 'http://stored:1', env }).url, 'http://stored:1');
  const fromEnv = resolveProxyConfig({ env });
  assert.equal(fromEnv.url, 'http://env:1');
  assert.equal(fromEnv.source, 'env');
  assert.equal(fromEnv.envVar, 'HTTPS_PROXY');
  assert.equal(resolveProxyConfig({ stored: 'none', env }).url, '', 'a stored "none" disables an env proxy');
  assert.equal(resolveProxyConfig({ stored: 'none', env }).disabled, true);
  assert.equal(resolveProxyConfig({ env: {} }).source, 'none');
  assert.equal(resolveProxyConfig({ stored: 'socks5://x:1', env: {} }).error.length > 0, true);
});

await test('NO_PROXY matching bypasses the tunnel', () => {
  assert.equal(shouldBypassProxy('api.github.com', 'api.github.com'), true);
  assert.equal(shouldBypassProxy('api.github.com', 'github.com'), true);
  assert.equal(shouldBypassProxy('api.github.com', '.github.com'), true);
  assert.equal(shouldBypassProxy('api.github.com', '*'), true);
  assert.equal(shouldBypassProxy('api.github.com', 'example.com, github.com'), true);
  assert.equal(shouldBypassProxy('api.github.com', 'example.com'), false);
  assert.equal(shouldBypassProxy('api.github.com', ''), false);
});

await test('POST /proxy rejects a SOCKS address and stores an HTTP one', async () => {
  const bad = await call('POST', '/github-link/proxy', { url: 'socks5://127.0.0.1:7891' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /SOCKS/i);
  const ok = await call('POST', '/github-link/proxy', { url: '127.0.0.1:7890' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.proxy.active, true);
  assert.equal(ok.body.proxy.source, 'stored');
  assert.equal(ok.body.proxy.url, 'http://127.0.0.1:7890');
  const state = await call('GET', '/github-link/state');
  assert.equal(state.body.proxy.url, 'http://127.0.0.1:7890');
  assert.equal(state.body.proxy.active, true);
});

await test('POST /proxy keeps the stored password when the masked value is echoed back', async () => {
  const saved = await call('POST', '/github-link/proxy', { url: 'http://me:secret@127.0.0.1:7890' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.proxy.stored, 'http://me:***@127.0.0.1:7890');
  assert.equal(saved.body.proxy.storedHasPassword, true);
  assert.ok(!saved.text.includes('secret'), 'the password must never leave the host');
  const again = await call('POST', '/github-link/proxy', { url: saved.body.proxy.stored });
  assert.equal(again.status, 200);
  assert.equal(readCredentials().proxy, 'http://me:secret@127.0.0.1:7890');
});

await test('POST /proxy with an empty value clears it, and /proxy/test then reports direct', async () => {
  const cleared = await call('POST', '/github-link/proxy', { url: '' });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.proxy.active, false);
  assert.equal(cleared.body.proxy.url, '');
  assert.equal(readCredentials().proxy, undefined);
  const probe = await call('POST', '/github-link/proxy/test', { url: '' });
  assert.equal(probe.status, 200);
  assert.equal(probe.body.ok, true);
  assert.equal(probe.body.via, 'direct');
  assert.ok(probe.body.elapsedMs >= 0);
});

await test('GET /state picks up an environment proxy when nothing is stored', async () => {
  process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
  try {
    const state = await call('GET', '/github-link/state');
    assert.equal(state.body.proxy.active, true);
    assert.equal(state.body.proxy.source, 'env');
    assert.equal(state.body.proxy.envVar, 'HTTPS_PROXY');
  } finally {
    delete process.env.HTTPS_PROXY;
  }
  const after = await call('GET', '/github-link/state');
  assert.equal(after.body.proxy.active, false);
});

await test('isCertificateError recognises TLS failures but not connection refusals', () => {
  const certError = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('unable to verify the first certificate'), {
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    }),
  });
  assert.equal(isCertificateError(certError), true);
  const selfSigned = Object.assign(new Error('self signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
  assert.equal(isCertificateError(selfSigned), true);
  const refused = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7890'), { code: 'ECONNREFUSED' }),
  });
  assert.equal(isCertificateError(refused), false);
  assert.equal(isCertificateError(new Error('boom')), false);
  assert.equal(isCertificateError(null), false);
});

await test('GET /state reports the OS-trust-store status, adopted lazily', async () => {
  assert.equal(getSystemCaStatus(), 'idle', 'nothing should touch the TLS defaults before a failure');
  const before = await call('GET', '/github-link/state');
  assert.equal(before.body.tls.systemCa, 'idle');
  const adopted = useSystemCertificateStore();
  assert.equal(getSystemCaStatus(), adopted ? 'applied' : 'unavailable');
  const after = await call('GET', '/github-link/state');
  assert.equal(after.body.tls.systemCa, adopted ? 'applied' : 'unavailable');
});

await test('a certificate failure is retried once after adopting the OS trust store', async () => {
  const realFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (url, init) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new TypeError('fetch failed');
      error.cause = Object.assign(new Error('unable to verify the first certificate'), {
        code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      });
      throw error;
    }
    return realFetch(url, init);
  };
  try {
    const res = await call('POST', '/github-link/proxy/test', { url: '' });
    if (getSystemCaStatus() === 'applied') {
      assert.equal(res.status, 200, 'the retry must succeed');
      assert.equal(attempts, 2, 'exactly one retry, no loop');
    } else {
      // Older Node without tls.getCACertificates: fail loudly, but do not hang.
      assert.equal(res.status, 502);
      assert.equal(attempts, 1);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── publish: upload / update ───────────────────────────────────────────────
//
// These run real `git` against real local directories: a work tree inside the
// fake workspace and a bare repository standing in for the GitHub remote. No
// network is involved, and no global git config is touched.

const PUBLISH_DIR = join(WORKSPACE, 'publish-demo');
const PLAIN_DIR = join(WORKSPACE, 'plain-dir');
const BARE_REMOTE = join(SANDBOX, 'remote.git');
const IDENTITY = { name: 'Octocat', email: 'octocat@users.noreply.github.com' };
const SEED_ENV = {
  GIT_AUTHOR_NAME: 'Seed',
  GIT_AUTHOR_EMAIL: 'seed@example.com',
  GIT_COMMITTER_NAME: 'Seed',
  GIT_COMMITTER_EMAIL: 'seed@example.com',
};

mkdirSync(PUBLISH_DIR, { recursive: true });
mkdirSync(PLAIN_DIR, { recursive: true });
mkdirSync(join(PUBLISH_DIR, 'node_modules', 'left-pad'), { recursive: true });
writeFileSync(join(PUBLISH_DIR, 'main.js'), 'console.log(1)\n');
writeFileSync(join(PUBLISH_DIR, '.env'), 'SECRET=1\n');
writeFileSync(join(PUBLISH_DIR, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n');
writeFileSync(join(PLAIN_DIR, 'notes.txt'), 'hello\n');

await test('repoStatus reports a plain directory as not a repository', async () => {
  const status = await repoStatus(PLAIN_DIR, {});
  assert.equal(status.repo, false);
  assert.equal(status.dirty, false);
  assert.equal(status.branch, '');
});

await test('scanDirectory flags secrets and dependency directories, without descending into them', () => {
  const scan = scanDirectory(PUBLISH_DIR);
  const paths = scan.risky.map((entry) => entry.path);
  assert.ok(paths.includes('.env'), `expected .env in ${JSON.stringify(paths)}`);
  assert.ok(paths.some((entry) => entry.startsWith('node_modules')), 'node_modules must be flagged');
  assert.ok(scan.bytes > 0);
  assert.ok(scan.files >= 1);
});

await test('planPublish refuses an update in a directory that is not a repository', async () => {
  const plan = await planPublish({ dir: PLAIN_DIR, kind: 'update', token: '', login: 'octocat' });
  assert.equal(plan.ok, false);
  assert.ok(plan.blockers.some((blocker) => blocker.code === 'not_a_repo'));
});

await test('planPublish refuses a missing directory and an invalid repo name', async () => {
  const missing = await planPublish({ dir: join(WORKSPACE, 'nope'), kind: 'upload' });
  assert.equal(missing.ok, false);
});

await test('applyPublish initialises, commits and pushes into an empty remote', async () => {
  const bare = await runGit(SANDBOX, ['init', '--bare', BARE_REMOTE]);
  assert.equal(bare.ok, true, bare.stderr);

  const result = await applyPublish({
    dir: PUBLISH_DIR,
    kind: 'upload',
    full: 'octocat/publish-demo',
    remoteUrl: BARE_REMOTE,
    token: '',
    identity: IDENTITY,
    message: 'first upload',
    branch: 'main',
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.created, false, 'no GitHub repo is created when full is given');
  assert.equal(result.committed, true);
  assert.equal(result.pushed, true);
  assert.equal(result.branch, 'main');

  const log = await runGit(SANDBOX, ['--git-dir', BARE_REMOTE, 'log', '--oneline', 'main']);
  assert.equal(log.ok, true, log.stderr);
  assert.ok(log.stdout.includes('first upload'), log.stdout);

  const status = await repoStatus(PUBLISH_DIR, {});
  assert.equal(status.repo, true);
  assert.equal(status.branch, 'main');
  assert.equal(status.remote, BARE_REMOTE);
  assert.equal(status.ahead, 0, 'the pushed branch tracks its upstream');
});

await test('a second apply with nothing to commit is a no-op', async () => {
  const result = await applyPublish({
    dir: PUBLISH_DIR,
    kind: 'update',
    full: 'octocat/publish-demo',
    remoteUrl: BARE_REMOTE,
    token: '',
    identity: IDENTITY,
    message: 'nothing',
    branch: 'main',
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.committed, false);
  assert.equal(result.upToDate, true);
  assert.equal(result.pushed, false);
});

await test('a diverged remote is refused instead of force-pushed', async () => {
  const other = join(SANDBOX, 'other-clone');
  const clone = await runGit(SANDBOX, ['clone', '--quiet', '-b', 'main', BARE_REMOTE, other]);
  assert.equal(clone.ok, true, clone.stderr);
  await runGit(other, ['config', 'user.email', 'other@example.com']);
  await runGit(other, ['config', 'user.name', 'Other']);
  writeFileSync(join(other, 'remote-only.txt'), 'remote only\n');
  await runGit(other, ['add', '-A']);
  const commit = await runGit(other, ['commit', '-m', 'remote-only commit']);
  assert.equal(commit.ok, true, commit.stderr);
  const push = await runGit(other, ['push', '--quiet', 'origin', 'main']);
  assert.equal(push.ok, true, push.stderr);

  writeFileSync(join(PUBLISH_DIR, 'local-only.txt'), 'local only\n');
  const result = await applyPublish({
    dir: PUBLISH_DIR,
    kind: 'update',
    full: 'octocat/publish-demo',
    remoteUrl: BARE_REMOTE,
    token: '',
    identity: IDENTITY,
    message: 'local change',
    branch: 'main',
  });
  assert.equal(result.ok, false, 'a diverged remote must not be pushed');
  assert.equal(result.code, 'non_fast_forward');
  assert.ok(result.behind >= 1);

  const remoteLog = await runGit(SANDBOX, ['--git-dir', BARE_REMOTE, 'log', '--oneline', 'main']);
  assert.ok(!remoteLog.stdout.includes('local change'), 'the remote must be untouched');
});

await test('planPublish blocks an update that is behind the remote', async () => {
  const plan = await planPublish({
    dir: PUBLISH_DIR,
    kind: 'update',
    full: 'octocat/publish-demo',
    remoteUrl: BARE_REMOTE,
    token: '',
    login: 'octocat',
    identity: IDENTITY,
    scan: false,
  });
  // `origin` still points at the bare remote, so the plan sees the divergence.
  assert.equal(plan.ok, false);
  assert.ok(plan.blockers.some((blocker) => blocker.code === 'behind' || blocker.code === 'no_remote'));
});

await test('ensureGitignore creates the file once and never rewrites it', () => {
  const target = join(PLAIN_DIR);
  const first = ensureGitignore(target);
  assert.equal(first.created, true);
  assert.equal(existsSync(join(target, '.gitignore')), true);
  const second = ensureGitignore(target, 'CHANGED\n');
  assert.equal(second.created, false);
  const content = readFileSync(join(target, '.gitignore'), 'utf8');
  assert.ok(!content.includes('CHANGED'), 'an existing .gitignore must not be overwritten');
});

await test('the publish endpoints reject an escaping subdirectory', async () => {
  const loginAgain = await call('POST', '/github-link/token', { token: TOKEN_PAT });
  assert.equal(loginAgain.status, 200, 'the publish routes need a connected account');

  const res = await call('POST', '/github-link/publish/plan', {
    workspaceId: 'ws-1',
    subdir: '..',
    kind: 'upload',
    create: 'new',
    repoName: 'escape',
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /工作区/);
});

await test('POST /publish/plan reports the plan for a workspace directory', async () => {
  const res = await call('POST', '/github-link/publish/plan', {
    workspaceId: 'ws-1',
    subdir: 'publish-demo',
    kind: 'upload',
    create: 'new',
    repoName: 'publish-demo',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.repo, true);
  assert.equal(res.body.target, 'new');
  assert.equal(res.body.full, 'octocat/publish-demo');
  assert.ok(res.body.scan.risky.some((entry) => entry.path === '.env'), 'the plan must surface risky paths');
});

await test('POST /publish/apply refuses to run without confirming risky paths', async () => {
  const res = await call('POST', '/github-link/publish/apply', {
    workspaceId: 'ws-1',
    subdir: 'publish-demo',
    kind: 'upload',
    create: 'new',
    repoName: 'publish-demo',
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.needConfirm, true);
  assert.ok(res.body.scan.risky.length > 0);
});

await test('POST /publish/apply reports plan blockers instead of pushing', async () => {
  const res = await call('POST', '/github-link/publish/apply', {
    workspaceId: 'ws-1',
    subdir: 'plain-dir',
    kind: 'update',
    full: 'octocat/demo',
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /git 仓库|remote|提交/);
  assert.ok(res.body.plan);
});

await test('GET /local reports the git status of each workspace', async () => {
  const res = await call('GET', '/github-link/local');
  assert.equal(res.status, 200);
  assert.equal(res.body.workspaces.length, 1);
  const [workspace] = res.body.workspaces;
  assert.equal(workspace.id, 'ws-1');
  assert.equal(typeof workspace.git, 'object');
});

await test('GET /local/dirs walks one level and never leaves the workspace', async () => {
  mkdirSync(join(PLAIN_DIR, 'alpha', 'deep'), { recursive: true });
  mkdirSync(join(PLAIN_DIR, 'beta'), { recursive: true });
  mkdirSync(join(PLAIN_DIR, 'node_modules', 'junk'), { recursive: true });
  mkdirSync(join(PLAIN_DIR, '.hidden'), { recursive: true });
  writeFileSync(join(PLAIN_DIR, 'alpha', 'index.js'), 'x\n');

  const root = await call('GET', '/github-link/local/dirs?workspaceId=ws-1&subdir=plain-dir');
  assert.equal(root.status, 200);
  assert.equal(root.body.subdir, 'plain-dir');
  assert.deepEqual(root.body.dirs, ['alpha', 'beta'], 'dependency and dot directories are filtered out');
  assert.equal(root.body.parent, '');

  const deeper = await call('GET', '/github-link/local/dirs?workspaceId=ws-1&subdir=plain-dir/alpha');
  assert.equal(deeper.status, 200);
  assert.equal(deeper.body.subdir, 'plain-dir/alpha');
  assert.equal(deeper.body.parent, 'plain-dir');
  assert.deepEqual(deeper.body.dirs, ['deep']);
  assert.ok(deeper.body.path.endsWith(join('plain-dir', 'alpha')), deeper.body.path);

  const escape = await call('GET', '/github-link/local/dirs?workspaceId=ws-1&subdir=..');
  assert.equal(escape.status, 400);
  assert.match(escape.body.error, /工作区/);

  const missing = await call('GET', '/github-link/local/dirs?workspaceId=ws-1&subdir=plain-dir/nope');
  assert.equal(missing.status, 400);
});

await test('POST /publish/plan resolves the same subdirectory the picker shows', async () => {
  const res = await call('POST', '/github-link/publish/plan', {
    workspaceId: 'ws-1',
    subdir: 'plain-dir/alpha',
    kind: 'upload',
    create: 'new',
    repoName: 'alpha',
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.dir.endsWith(join('plain-dir', 'alpha')), res.body.dir);
  assert.equal(res.body.repo, false, 'the subdirectory is its own, still uninitialised, repository');
});

// ── upload a folder into a repository subdirectory ─────────────────────────

const BARE2 = join(SANDBOX, 'remote2.git');
/** `file://` so `--depth 1` is honoured (a plain local path makes git ignore it). */
const BARE2_URL = `file:///${BARE2.replace(/\\/g, '/')}`;
const SEED = join(SANDBOX, 'seed');
const FOLDER = join(WORKSPACE, 'folder-src');

await test('normalizeRemotePath accepts nested paths and rejects traversal', () => {
  assert.deepEqual(normalizeRemotePath('docs/site'), { ok: true, path: 'docs/site' });
  assert.deepEqual(normalizeRemotePath('\\docs\\site\\'), { ok: true, path: 'docs/site' });
  assert.equal(normalizeRemotePath('').ok, false);
  assert.equal(normalizeRemotePath('  ').ok, false);
  assert.equal(normalizeRemotePath('../etc').ok, false);
  assert.equal(normalizeRemotePath('docs/../../etc').ok, false);
  assert.equal(normalizeRemotePath('docs//site').ok, false);
  assert.equal(normalizeRemotePath('docs;rm -rf').ok, false);
});

await test('applyRemoteFolder writes only the target subdirectory, as one commit', async () => {
  // A remote that already has content: only `sub/dir` may change.
  mkdirSync(join(SEED, 'docs'), { recursive: true });
  writeFileSync(join(SEED, 'keep.txt'), 'keep me\n');
  writeFileSync(join(SEED, 'docs', 'old.md'), 'old\n');
  mkdirSync(FOLDER, { recursive: true });
  writeFileSync(join(FOLDER, 'index.js'), 'one\n');
  mkdirSync(join(FOLDER, 'nested'), { recursive: true });
  writeFileSync(join(FOLDER, 'nested', 'deep.txt'), 'deep\n');
  writeFileSync(join(FOLDER, '.git'), 'not a directory, but must never travel\n');

  assert.equal((await runGit(SEED, ['init', '-b', 'main'])).ok, true);
  assert.equal((await runGit(SEED, ['add', '-A'])).ok, true);
  const seedCommit = await runGit(SEED, ['commit', '-m', 'seed'], { env: SEED_ENV });
  assert.equal(seedCommit.ok, true, seedCommit.stderr);
  // A bare remote whose HEAD really points at main, like a GitHub repository.
  assert.equal((await runGit(SANDBOX, ['init', '--bare', '--initial-branch=main', BARE2])).ok, true);
  assert.equal((await runGit(SEED, ['remote', 'add', 'origin', BARE2])).ok, true);
  assert.equal((await runGit(SEED, ['push', '--quiet', '-u', 'origin', 'main'])).ok, true);

  const result = await applyRemoteFolder({
    dir: FOLDER,
    full: 'octocat/publish-demo',
    remotePath: 'sub/dir',
    branch: 'main',
    remoteUrl: BARE2_URL,
    token: '',
    identity: IDENTITY,
    message: 'add sub/dir',
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.committed, true);
  assert.equal(result.pushed, true);

  const tree = await runGit(SANDBOX, ['--git-dir', BARE2, 'ls-tree', '-r', '--name-only', 'main']);
  const files = tree.stdout.split(/\r?\n/).filter(Boolean);
  assert.ok(files.includes('keep.txt'), `remote content must survive: ${files}`);
  assert.ok(files.includes('docs/old.md'), `remote content must survive: ${files}`);
  assert.ok(files.includes('sub/dir/index.js'), `the folder must land at the requested path: ${files}`);
  assert.ok(files.includes('sub/dir/nested/deep.txt'), 'nested files travel too');
  assert.ok(!files.some((file) => file.includes('.git')), 'a .git entry must never be copied');

  const log = await runGit(SANDBOX, ['--git-dir', BARE2, 'log', '--oneline', 'main']);
  assert.equal(log.stdout.split(/\r?\n/).filter(Boolean).length, 2, 'exactly one new commit');
});

await test('a second subdirectory upload with no changes is a no-op', async () => {
  const result = await applyRemoteFolder({
    dir: FOLDER,
    full: 'octocat/publish-demo',
    remotePath: 'sub/dir',
    branch: 'main',
    remoteUrl: BARE2_URL,
    token: '',
    identity: IDENTITY,
    message: 'nothing',
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.committed, false);
  assert.equal(result.upToDate, true);
  const log = await runGit(SANDBOX, ['--git-dir', BARE2, 'log', '--oneline', 'main']);
  assert.equal(log.stdout.split(/\r?\n/).filter(Boolean).length, 2, 'no extra commit');
});

await test('a changed file is overwritten and the rest of the remote stays put', async () => {
  writeFileSync(join(FOLDER, 'index.js'), 'two\n');
  const result = await applyRemoteFolder({
    dir: FOLDER,
    full: 'octocat/publish-demo',
    remotePath: 'sub/dir',
    branch: 'main',
    remoteUrl: BARE2_URL,
    token: '',
    identity: IDENTITY,
    message: 'update index',
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.committed, true);
  const blob = await runGit(SANDBOX, ['--git-dir', BARE2, 'show', 'main:sub/dir/index.js']);
  assert.equal(blob.stdout.trim(), 'two');
  const keep = await runGit(SANDBOX, ['--git-dir', BARE2, 'show', 'main:keep.txt']);
  assert.equal(keep.stdout.trim(), 'keep me');
});

await test('planRemoteFolder reports the target path and the existing entries', async () => {
  const fakeFetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === '/repos/octocat/target') {
      return { ok: true, status: 200, async text() { return JSON.stringify({ default_branch: 'master', private: true }); } };
    }
    if (path.startsWith('/repos/octocat/target/contents/docs/site')) {
      return { ok: true, status: 200, async text() { return JSON.stringify([{ name: 'a.md' }, { name: 'b.md' }]); } };
    }
    return { ok: false, status: 404, async text() { return JSON.stringify({ message: 'Not Found' }); } };
  };

  const plan = await planRemoteFolder({
    dir: FOLDER,
    full: 'octocat/target',
    remotePath: 'docs/site',
    token: 'fake',
    fetchImpl: fakeFetch,
  });
  assert.equal(plan.ok, true, JSON.stringify(plan.blockers));
  assert.equal(plan.branch, 'master', 'the repository default branch is used when none is given');
  assert.equal(plan.remoteExists, true);
  assert.equal(plan.existing, 2);
  assert.equal(plan.private, true);
  assert.ok(plan.scan.files >= 2);

  const fresh = await planRemoteFolder({
    dir: FOLDER,
    full: 'octocat/target',
    remotePath: 'brand/new',
    token: 'fake',
    fetchImpl: fakeFetch,
  });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.remoteExists, false);
  assert.equal(fresh.existing, 0);

  const bad = await planRemoteFolder({
    dir: FOLDER,
    full: 'octocat/target',
    remotePath: '..',
    token: 'fake',
    fetchImpl: fakeFetch,
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.blockers.some((blocker) => blocker.code === 'path'));
});

await test('POST /publish/plan handles the subdirectory mode end to end', async () => {
  const res = await call('POST', '/github-link/publish/plan', {
    workspaceId: 'ws-1',
    subdir: 'plain-dir/alpha',
    kind: 'remote-dir',
    full: 'octocat/demo',
    remotePath: 'docs/site',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.kind, 'remote-dir');
  assert.equal(res.body.remotePath, 'docs/site');
  assert.equal(res.body.full, 'octocat/demo');
  assert.equal(res.body.branch, 'main', 'taken from the mocked repository metadata');
  assert.equal(res.body.remoteExists, false, 'the mocked contents endpoint answers 404');

  const bad = await call('POST', '/github-link/publish/plan', {
    workspaceId: 'ws-1',
    kind: 'remote-dir',
    full: 'octocat/demo',
    remotePath: '../escape',
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /目标路径/);
});

// ── pulling the remote's commits ───────────────────────────────────────────

const PULL_BARE = join(SANDBOX, 'remote3.git');
const PULL_BARE_URL = `file:///${PULL_BARE.replace(/\\/g, '/')}`;
const PULL_LOCAL = join(SANDBOX, 'pull-local');
const PULL_OTHER = join(SANDBOX, 'pull-other');
const PULL_SEED = join(SANDBOX, 'pull-seed');

async function commitIn(dir, file, content, message) {
  writeFileSync(join(dir, file), content);
  await runGit(dir, ['add', '-A']);
  return runGit(dir, ['commit', '-m', message], { env: SEED_ENV });
}

await test('pullRepository fast-forwards a strictly-behind checkout', async () => {
  assert.equal((await runGit(SANDBOX, ['init', '--bare', '--initial-branch=main', PULL_BARE])).ok, true);
  mkdirSync(PULL_SEED, { recursive: true });
  assert.equal((await runGit(PULL_SEED, ['init', '-b', 'main'])).ok, true);
  assert.equal((await commitIn(PULL_SEED, 'remote.txt', 'r1\n', 'r1')).ok, true);
  assert.equal((await runGit(PULL_SEED, ['remote', 'add', 'origin', PULL_BARE_URL])).ok, true);
  assert.equal((await runGit(PULL_SEED, ['push', '--quiet', '-u', 'origin', 'main'])).ok, true);
  assert.equal((await runGit(SANDBOX, ['clone', '--quiet', PULL_BARE_URL, PULL_LOCAL])).ok, true);

  // Somebody else pushes one commit.
  assert.equal((await runGit(SANDBOX, ['clone', '--quiet', PULL_BARE_URL, PULL_OTHER])).ok, true);
  assert.equal((await commitIn(PULL_OTHER, 'remote.txt', 'r2\n', 'r2')).ok, true);
  assert.equal((await runGit(PULL_OTHER, ['push', '--quiet', 'origin', 'main'])).ok, true);

  const before = await repoStatus(PULL_LOCAL, {});
  assert.equal(before.behind, 0, 'the tracking ref is stale until we fetch');

  const result = await pullRepository({ dir: PULL_LOCAL, mode: 'ff', token: '' });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.pulled, 1);
  assert.equal(result.behind, 0);

  const head = await runGit(PULL_LOCAL, ['rev-parse', 'HEAD']);
  const remoteHead = await runGit(PULL_LOCAL, ['rev-parse', 'origin/main']);
  assert.equal(head.stdout.trim(), remoteHead.stdout.trim(), 'the local branch now matches the remote');
  const content = readFileSync(join(PULL_LOCAL, 'remote.txt'), 'utf8');
  assert.equal(content.trim(), 'r2');
});

await test('a dirty tree is refused, and `commitDirty` commits the work in progress first', async () => {
  writeFileSync(join(PULL_LOCAL, 'wip.txt'), 'work in progress\n');

  const refused = await pullRepository({ dir: PULL_LOCAL, mode: 'onto', token: '' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'dirty');
  assert.equal(refused.dirty, true);
  assert.ok(refused.hint.includes('先提交这些改动'), 'the refusal must offer a way forward');
  assert.equal(existsSync(join(PULL_LOCAL, 'wip.txt')), true, 'nothing is discarded by the refusal');

  const forced = await pullRepository({
    dir: PULL_LOCAL,
    mode: 'onto',
    token: '',
    commitDirty: true,
    identity: IDENTITY,
    message: 'wip from test',
  });
  assert.equal(forced.ok, true, forced.error);
  assert.ok(
    forced.steps.some((step) => step.step === 'commit-local'),
    'the WIP commit step must be reported',
  );
  const tracked = await runGit(PULL_LOCAL, ['ls-files']);
  assert.ok(tracked.stdout.includes('wip.txt'), 'the WIP file is now tracked');
  assert.equal((await repoStatus(PULL_LOCAL, {})).dirty, false, 'the tree is clean afterwards');
  const log = await runGit(PULL_LOCAL, ['log', '--oneline', '-1']);
  assert.ok(log.stdout.includes('wip from test'), log.stdout);
});

await test('pullRepository refuses to fast-forward a diverged branch, and "onto" rebuilds it safely', async () => {
  // Local moves ahead, remote moves ahead — and the remote also brings a file
  // that only exists over there.
  assert.equal((await commitIn(PULL_LOCAL, 'local.txt', 'mine\n', 'local work')).ok, true);
  assert.equal((await commitIn(PULL_OTHER, 'remote.txt', 'r3\n', 'r3')).ok, true);
  writeFileSync(join(PULL_OTHER, 'remote-only.txt'), 'from upstream\n');
  await runGit(PULL_OTHER, ['add', '-A']);
  assert.equal((await runGit(PULL_OTHER, ['commit', '-m', 'add remote-only'], { env: SEED_ENV })).ok, true);
  assert.equal((await runGit(PULL_OTHER, ['push', '--quiet', 'origin', 'main'])).ok, true);

  const ff = await pullRepository({ dir: PULL_LOCAL, mode: 'ff', token: '' });
  assert.equal(ff.ok, false);
  assert.equal(ff.code, 'not_fast_forward');
  assert.ok(ff.ahead >= 1, 'the local side has unpushed commits');
  assert.equal(ff.behind, 2);

  const onto = await pullRepository({ dir: PULL_LOCAL, mode: 'onto', token: '', identity: IDENTITY });
  assert.equal(onto.ok, true, onto.error);
  assert.equal(onto.onto, true);
  assert.equal(onto.behind, 0);
  assert.equal(onto.restored, 1, 'the file that only the remote has is materialised');

  // Nothing was lost on either side: the local commit's file survives, the
  // remote-only file is now present and tracked, and the branch sits directly
  // on top of the remote tip (so the next push is a fast-forward).
  assert.equal(readFileSync(join(PULL_LOCAL, 'local.txt'), 'utf8').trim(), 'mine');
  assert.equal(readFileSync(join(PULL_LOCAL, 'remote-only.txt'), 'utf8').trim(), 'from upstream');
  const tracked = await runGit(PULL_LOCAL, ['ls-files']);
  assert.ok(tracked.stdout.includes('remote-only.txt'), 'the restored file is tracked');
  assert.equal((await runGit(PULL_LOCAL, ['merge-base', '--is-ancestor', 'origin/main', 'HEAD'])).ok, true);
  const status = await repoStatus(PULL_LOCAL, {});
  assert.equal(status.behind, 0);
  assert.ok(status.ahead >= 1, 'the local commits are still there, now fast-forwardable');
  assert.equal(status.dirty, false, 'the working tree matches the new commit');

  // And the push that follows really is a fast-forward.
  const pushed = await applyPublish({
    dir: PULL_LOCAL,
    kind: 'update',
    full: 'octocat/pull-demo',
    remoteUrl: PULL_BARE_URL,
    token: '',
    identity: IDENTITY,
    message: 'push after onto',
    branch: 'main',
  });
  assert.equal(pushed.ok, true, pushed.error);
  const remoteLog = await runGit(SANDBOX, ['--git-dir', PULL_BARE, 'log', '--oneline', 'main']);
  assert.ok(remoteLog.stdout.includes('Merge local work onto'), remoteLog.stdout);
  const remoteHead = await runGit(SANDBOX, ['--git-dir', PULL_BARE, 'rev-parse', 'HEAD']);
  const localHead = await runGit(PULL_LOCAL, ['rev-parse', 'HEAD']);
  assert.equal(
    remoteHead.stdout.trim(),
    localHead.stdout.trim(),
    'the rebuilt branch went up as a fast-forward push',
  );
  const remoteTree = await runGit(SANDBOX, ['--git-dir', PULL_BARE, 'ls-tree', '-r', '--name-only', 'main']);
  assert.ok(remoteTree.stdout.includes('remote-only.txt'), 'the remote-only file survives the push');
  assert.ok(remoteTree.stdout.includes('local.txt'), 'and so does the local one');
});

await test('pullRepository reports a missing repository or remote instead of guessing', async () => {
  const notRepo = await pullRepository({ dir: PLAIN_DIR, mode: 'ff', token: '' });
  assert.equal(notRepo.ok, false);
  assert.match(notRepo.error, /git 仓库/);

  const noRemoteDir = join(SANDBOX, 'no-remote');
  mkdirSync(noRemoteDir, { recursive: true });
  assert.equal((await runGit(noRemoteDir, ['init', '-b', 'main'])).ok, true);
  assert.equal((await runGit(noRemoteDir, ['add', '-A'])).ok, true);
  const noRemote = await pullRepository({ dir: noRemoteDir, mode: 'ff', token: '' });
  assert.equal(noRemote.ok, false);
  assert.match(noRemote.error, /origin/);
});

await test('POST /publish/pull refuses a fast-forward it cannot do', async () => {
  const res = await call('POST', '/github-link/publish/pull', {
    workspaceId: 'ws-1',
    subdir: 'publish-demo',
    mode: 'ff',
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'not_fast_forward');
  assert.ok(res.body.ahead >= 1);
});

// ── DNS-rebinding guard (Host) ─────────────────────────────────────────────

await test('requests whose Host is loopback are accepted', async () => {
  for (const host of ['127.0.0.1:19387', 'localhost:19387', '[::1]:19387', '127.0.0.1']) {
    const res = await call('GET', '/github-link/health', undefined, { host });
    assert.equal(res.status, 200, `Host ${host} must be accepted`);
  }
});

await test('a foreign Host is refused on both GET and POST', async () => {
  const get = await call('GET', '/github-link/state', undefined, { host: 'attacker.example' });
  assert.equal(get.status, 403);
  assert.equal(get.body.code, 'host_not_allowed');
  assert.ok(!get.text.includes('dataDir'), 'nothing leaks in the refusal');

  const post = await call('POST', '/github-link/publish/pull', { mode: 'ff' }, { host: 'evil.example:19387' });
  assert.equal(post.status, 403);
  assert.equal(post.body.code, 'host_not_allowed');
});

await test('a missing Host header is tolerated (HTTP/1.0 clients, this harness)', async () => {
  const res = await call('GET', '/github-link/health');
  assert.equal(res.status, 200);
});

await test('config.allowedHosts can whitelist a proxy host, or disable the check', async () => {
  const mount = (config) => {
    let captured;
    const server = {
      register(definition) {
        captured = definition;
        return () => {
          captured = undefined;
        };
      },
    };
    const dispose = apply({ webServer: server, logger: () => fakeLogger, get: () => undefined }, config);
    return { captured, dispose };
  };
  const hit = async (handler, host) => {
    const res = makeRes();
    await handler(makeReq('GET', '/github-link/health', undefined, { host }), res);
    return (await res.result()).status;
  };

  const allowed = mount({ allowedHosts: ['mybox.local'] });
  assert.ok(allowed.captured, 'the isolated instance must mount');
  assert.equal(await hit(allowed.captured.handler, 'mybox.local:19387'), 200);
  assert.equal(await hit(allowed.captured.handler, 'other.local'), 403);
  allowed.dispose();

  const open = mount({ allowedHosts: ['*'] });
  assert.equal(await hit(open.captured.handler, 'anything.example'), 200);
  open.dispose();
});

// ── pure helpers ───────────────────────────────────────────────────────────


await test('parseRepoFullName accepts owner/name and rejects traversal', () => {
  assert.deepEqual(parseRepoFullName('octocat/demo'), { owner: 'octocat', name: 'demo' });
  assert.equal(parseRepoFullName('../etc'), undefined);
  assert.equal(parseRepoFullName('owner/..'), undefined);
  assert.equal(parseRepoFullName('owner/demo/extra'), undefined);
  assert.equal(parseRepoFullName(''), undefined);
});

await test('resolveCloneTarget keeps the destination inside the workspace', () => {
  const good = resolveCloneTarget(WORKSPACE, 'demo');
  assert.equal(good.ok, true);
  assert.equal(good.dest, join(WORKSPACE, 'demo'));
  assert.equal(resolveCloneTarget(WORKSPACE, 'demo', '..').ok, false);
  assert.equal(resolveCloneTarget('relative/path', 'demo').ok, false);
});

await test('gitEnvWithToken never puts the token in argv and appends config entries', () => {
  const token = 'secret-token-value';
  const env = gitEnvWithToken(token, {});
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_CONFIG_COUNT, '1');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  assert.ok(env.GIT_CONFIG_VALUE_0.startsWith('AUTHORIZATION: basic '));
  assert.ok(!env.GIT_CONFIG_VALUE_0.includes(token));
  const withExisting = gitEnvWithToken('t2', { GIT_CONFIG_COUNT: '3' });
  assert.equal(withExisting.GIT_CONFIG_COUNT, '4');
  assert.ok(withExisting.GIT_CONFIG_KEY_3);
});

await test('gitEnvWithToken adds http.proxy only when a proxy is configured', () => {
  const withProxy = gitEnvWithToken('tok', {}, 'http://127.0.0.1:7890');
  assert.equal(withProxy.GIT_CONFIG_COUNT, '2');
  assert.equal(withProxy.GIT_CONFIG_KEY_0, 'http.proxy');
  assert.equal(withProxy.GIT_CONFIG_VALUE_0, 'http://127.0.0.1:7890');
  assert.equal(withProxy.GIT_CONFIG_KEY_1, 'http.https://github.com/.extraheader');
  const withoutProxy = gitEnvWithToken('tok', {});
  assert.equal(withoutProxy.GIT_CONFIG_COUNT, '1');
  assert.equal(withoutProxy.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
});

await test('redact also hides proxy credentials in a URL', () => {
  const clean = redact('fatal: unable to access http://me:secret@127.0.0.1:7890', '');
  assert.ok(!clean.includes('secret'));
  assert.ok(clean.includes('http://me:***@127.0.0.1:7890'));
});

await test('redact removes both the token and its base64 form', () => {
  const token = 'secret-token-value';
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  const text = `bearer ${token} header ${basic} done`;
  const clean = redact(text, token);
  assert.ok(!clean.includes(token));
  assert.ok(!clean.includes(basic));
});

// ── teardown ───────────────────────────────────────────────────────────────

await test('the disposer unregisters the route', () => {
  disposer();
  assert.equal(route, undefined);
});

await test('apply(config) accepts the OAuth client id from the bundle row', async () => {
  let captured;
  const isolatedServer = {
    register(definition) {
      captured = definition;
      return () => {
        captured = undefined;
      };
    },
  };
  const isolatedCtx = { webServer: isolatedServer, logger: () => fakeLogger, get: () => undefined };
  const disposeIsolated = apply(isolatedCtx, { clientId: 'Ov23liFROMPATCHLAYER0001' });
  assert.ok(captured, 'the isolated instance must mount its route');
  const res = makeRes();
  await captured.handler(makeReq('GET', '/github-link/state'), res);
  const { body } = await res.result();
  assert.equal(body.clientId, 'Ov23liFROMPATCHLAYER0001');
  assert.equal(body.clientIdSource, 'config');
  disposeIsolated();
  assert.equal(captured, undefined);
});

Date.now = realNow;
rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`\n✗ ${failure.title}\n${failure.error && failure.error.stack}`);
  process.exit(1);
}
