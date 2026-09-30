/**
 * proxy.js — optional HTTP(S) proxy support for the plugin's GitHub calls.
 *
 * Why this exists: Node's global `fetch` (undici) ignores the Windows system
 * proxy *and* the conventional `HTTPS_PROXY` / `ALL_PROXY` environment
 * variables (below Node 24, and only with `NODE_USE_ENV_PROXY=1` there). Behind
 * Clash/v2ray in "system proxy" mode the browser reaches github.com while the
 * host half still dies with a bare `fetch failed` — this module is the fix.
 *
 * It provides a drop-in `fetch` replacement that tunnels through an HTTP proxy
 * with `CONNECT`. Deliberately dependency-free (the plugin ships no runtime
 * dependencies) and limited to `https:` targets, which is everything this
 * plugin talks to. Redirects are followed like `fetch` does.
 *
 * Not supported, on purpose: SOCKS proxies (the error message points the user
 * at Clash's HTTP port instead) and `http:` targets (GitHub is https-only).
 */

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { URL } from 'node:url';

/** Values that mean "do not use a proxy" when they show up where a URL is expected. */
export const DISABLE_VALUES = new Set(['none', 'off', 'false', 'no', 'direct', '-']);

/**
 * Checked in order. `DSH_GITHUB_LINK_PROXY` is plugin-specific and therefore
 * unambiguous; the rest are the usual suspects, so a machine that already
 * proxies everything for other tools gets picked up for free.
 */
const PROXY_ENV_KEYS = [
  'DSH_GITHUB_LINK_PROXY',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
];

const MAX_REDIRECTS = 5;
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Accepts `127.0.0.1:7890`, `http://127.0.0.1:7890`, `https://…` and the same
 * with `user:pass@`. Returns `{ ok: false, empty: true }` for blank input or an
 * explicit "none", which the caller reads as "clear the setting".
 */
export function normalizeProxyUrl(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return { ok: false, empty: true, error: '' };
  if (DISABLE_VALUES.has(text.toLowerCase())) return { ok: false, empty: true, error: '' };
  if (/^socks/i.test(text)) {
    return {
      ok: false,
      error: '暂不支持 SOCKS 代理，请填代理软件的 HTTP 端口（Clash 默认 127.0.0.1:7890）',
    };
  }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: '代理地址不是合法 URL，例如 http://127.0.0.1:7890' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `不支持的代理协议：${parsed.protocol}` };
  }
  if (!parsed.hostname) return { ok: false, error: '代理地址缺少主机名' };
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  const auth = parsed.username
    ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@`
    : '';
  return { ok: true, url: `${parsed.protocol}//${auth}${parsed.hostname}:${port}` };
}

/** Hide the password half of `http://user:pass@host:port` for anything the GUI can see. */
export function maskProxyUrl(raw) {
  return String(raw == null ? '' : raw).replace(/(:\/\/[^/@]*):([^/@]*)@/, '$1:***@');
}

export function proxyHasPassword(raw) {
  return /:\/\/[^/@]*:[^/@]*@/.test(String(raw == null ? '' : raw));
}

/**
 * Decide which proxy (if any) is in force.
 *
 * Priority: bundle-row `config.proxy` → the value saved in the settings page →
 * environment. The settings page deliberately outranks the environment, because
 * `HTTPS_PROXY` is often set for unrelated tools and must not silently override
 * what the user typed here. `source` is surfaced in the UI so this is never a
 * guess.
 */
export function resolveProxyConfig({ override = '', stored = '', env = process.env } = {}) {
  const candidates = [
    { value: override, source: 'config' },
    { value: stored, source: 'stored' },
  ];
  for (const key of PROXY_ENV_KEYS) {
    const value = env ? env[key] : '';
    if (value != null && String(value).trim()) {
      candidates.push({ value, source: 'env', envVar: key });
      break;
    }
  }
  for (const candidate of candidates) {
    const raw = String(candidate.value == null ? '' : candidate.value).trim();
    if (!raw) continue;
    const base = { source: candidate.source, envVar: candidate.envVar || '' };
    if (DISABLE_VALUES.has(raw.toLowerCase())) return { url: '', disabled: true, error: '', ...base };
    const normalized = normalizeProxyUrl(raw);
    if (!normalized.ok) return { url: '', disabled: false, error: normalized.error, ...base };
    return { url: normalized.url, disabled: false, error: '', ...base };
  }
  return { url: '', disabled: false, error: '', source: 'none', envVar: '' };
}

/** `NO_PROXY` / `no_proxy`, exact host, `.suffix`, bare suffix, or `*`. */
export function shouldBypassProxy(host, noProxy = process.env.NO_PROXY || process.env.no_proxy || '') {
  const list = String(noProxy || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return false;
  const name = String(host || '').toLowerCase();
  if (!name) return false;
  return list.some((entry) => {
    if (entry === '*') return true;
    if (name === entry) return true;
    return name.endsWith(entry.startsWith('.') ? entry : `.${entry}`);
  });
}

function proxyAuthorization(proxy) {
  if (!proxy.username) return '';
  const user = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password || '');
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

/**
 * An `https.Agent` whose connection is an HTTP `CONNECT` tunnel from the proxy
 * to the target, with TLS negotiated *inside* the tunnel. Everything above the
 * socket — request serialization, chunked decoding — stays Node's own http
 * stack, so there is no hand-rolled HTTP parser here.
 */
function createTunnelAgent(proxy, targetHost, targetPort, authHeader) {
  const agent = new https.Agent({ keepAlive: false, maxSockets: 4 });
  const proxyTransport = proxy.protocol === 'https:' ? https : http;
  const proxyPort = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);

  agent.createConnection = (options, callback) => {
    const headers = { host: `${targetHost}:${targetPort}` };
    if (authHeader) headers['proxy-authorization'] = authHeader;
    let settled = false;
    const connectRequest = proxyTransport.request({
      host: proxy.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers,
      agent: false,
      setHost: false,
      ...(proxy.protocol === 'https:' ? { servername: proxy.hostname } : {}),
    });
    const fail = (error) => {
      if (settled) return;
      settled = true;
      callback(error);
    };
    connectRequest.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        const suffix = response.statusCode === 407
          ? '：代理要求认证，请在代理地址里写成 http://用户名:密码@主机:端口'
          : '';
        fail(new Error(`代理 CONNECT ${targetHost}:${targetPort} 被拒绝（HTTP ${response.statusCode}）${suffix}`));
        return;
      }
      if (head && head.length) socket.unshift(head);
      const secure = tls.connect({
        socket,
        servername: options.servername || targetHost,
        ALPNProtocols: ['http/1.1'],
      });
      const onSecureError = (error) => {
        secure.destroy();
        fail(error);
      };
      secure.once('error', onSecureError);
      secure.once('secureConnect', () => {
        if (settled) return;
        settled = true;
        secure.removeListener('error', onSecureError);
        callback(null, secure);
      });
    });
    connectRequest.once('error', fail);
    connectRequest.setTimeout(CONNECT_TIMEOUT_MS, () => {
      connectRequest.destroy(new Error(`连接代理 ${proxy.hostname}:${proxyPort} 超时（${CONNECT_TIMEOUT_MS}ms）`));
    });
    connectRequest.end();
  };

  return agent;
}

function toPayload(body) {
  if (body == null) return undefined;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  if (typeof body === 'object') return Buffer.from(JSON.stringify(body), 'utf8');
  return Buffer.from(String(body), 'utf8');
}

/** Minimal `Response` shape: exactly what lib/github.js reads. */
function toResponse(status, rawHeaders, buffer) {
  const headers = {};
  for (const [key, value] of Object.entries(rawHeaders || {})) {
    headers[String(key).toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => (name == null ? null : headers[String(name).toLowerCase()] ?? null),
      has: (name) => name != null && Object.prototype.hasOwnProperty.call(headers, String(name).toLowerCase()),
      raw: headers,
    },
    async text() {
      return buffer.toString('utf8');
    },
    async json() {
      return JSON.parse(buffer.toString('utf8'));
    },
    async arrayBuffer() {
      return buffer;
    },
  };
}

/**
 * One request through the tunnel. Redirects are the caller's business.
 */
function requestOnce(target, { method, headers, payload, signal }, { proxy, authHeader, masked }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const port = Number(target.port) || 443;
    const agent = createTunnelAgent(proxy, target.hostname, port, authHeader);
    let settled = false;
    let request;
    const cleanup = () => {
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        agent.destroy();
      } catch {
        /* nothing to tear down */
      }
      rejectPromise(error);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(value);
    };
    const onAbort = () => {
      const reason = new Error('请求已取消或超时');
      reason.name = 'AbortError';
      if (request) request.destroy(reason);
      fail(reason);
    };
    if (signal && signal.aborted) return onAbort();
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    request = https.request(
      {
        host: target.hostname,
        port,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        agent,
        servername: target.hostname,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          succeed({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) });
        });
        response.on('error', (error) => fail(error));
        response.on('aborted', () => fail(new Error('代理连接在响应途中被中断')));
      },
    );
    request.on('error', (error) => {
      // A tunnel that never came up produces a bare socket error; name the
      // proxy so the message is not mistaken for a GitHub-side problem.
      if (error && /^(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ECONNRESET)/.test(String(error.code || ''))) {
        const wrapped = new Error(`经代理 ${masked} 连接 GitHub 失败：${error.message}`);
        wrapped.code = error.code;
        return fail(wrapped);
      }
      return fail(error);
    });
    if (payload) request.write(payload);
    request.end();
  });
}

/**
 * Build a `fetch(url, init)`-compatible function that always goes through
 * `proxyUrl`. `https:` only; `NO_PROXY` matches fall back to `baseFetch`.
 * Throws synchronously when `proxyUrl` is not usable, so a typo surfaces as a
 * configuration error instead of a mysterious network failure.
 */
export function createProxiedFetch(proxyUrl, { baseFetch, noProxy } = {}) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized.ok) throw new Error(normalized.error || '代理地址无效');
  const proxy = new URL(normalized.url);
  const authHeader = proxyAuthorization(proxy);
  const masked = maskProxyUrl(normalized.url);

  return async function proxiedFetch(input, init = {}) {
    let target;
    try {
      target = new URL(typeof input === 'string' ? input : (input && input.url) || '');
    } catch {
      throw new Error(`非法 URL：${typeof input === 'string' ? input : String(input)}`);
    }
    if (target.protocol !== 'https:') {
      throw new Error(`代理模式只支持 https 目标，收到 ${target.protocol}//${target.host}`);
    }
    if (shouldBypassProxy(target.hostname, noProxy)) {
      const fallback = baseFetch || globalThis.fetch;
      if (typeof fallback === 'function') return fallback(input, init);
      throw new Error(`NO_PROXY 命中 ${target.hostname}，但没有可用的直连 fetch`);
    }

    let method = String(init.method || 'GET').toUpperCase();
    let payload = toPayload(init.body);
    let headers = { ...(init.headers || {}) };
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-length') delete headers[key];
    }
    if (payload) headers['content-length'] = String(payload.length);

    let current = target;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const result = await requestOnce(
        current,
        { method, headers, payload, signal: init.signal },
        { proxy, authHeader, masked },
      );
      const location = result.headers && result.headers.location;
      if ([301, 302, 303, 307, 308].includes(result.status) && location) {
        const next = new URL(location, current);
        if (next.protocol !== 'https:') {
          throw new Error(`代理模式只支持 https 目标，重定向到 ${next.protocol}//${next.host}`);
        }
        // 303 always, and 301/302 on POST in every real client, become a GET.
        if (result.status === 303 || ((result.status === 301 || result.status === 302) && method === 'POST')) {
          method = 'GET';
          payload = undefined;
          delete headers['content-length'];
          delete headers['content-type'];
        }
        current = next;
        continue;
      }
      return toResponse(result.status, result.headers, result.body);
    }
    throw new Error(`重定向次数超过 ${MAX_REDIRECTS} 次`);
  };
}
