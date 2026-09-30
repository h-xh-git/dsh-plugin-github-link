/**
 * clone.js — `git clone` with the GitHub token, without ever persisting it.
 *
 * The token is handed to git through the environment (`GIT_CONFIG_COUNT` /
 * `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`, git >= 2.31) rather than through
 * argv, so it cannot be read out of the process list or shell history, and it
 * never reaches the cloned repository's `.git/config` (unlike a token embedded
 * in the remote URL). The same channel carries `http.proxy` when the user has
 * configured one in the plugin settings.
 *
 * All diagnostics are passed through `redact()` before they are logged or
 * returned, because git echoes failing request headers in some error paths.
 */

import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const CLONE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** `owner/name`, with no slashes or traversal inside either part. */
export function parseRepoFullName(full) {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9._-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(
    String(full || '').trim(),
  );
  if (!match) return undefined;
  const owner = match[1];
  const name = match[2];
  if (name === '.' || name === '..') return undefined;
  return { owner, name };
}

/** Add one `git -c` style entry to the child environment (git >= 2.31). */
function appendGitConfig(env, key, value) {
  let count = Number.parseInt(String(env.GIT_CONFIG_COUNT || '0'), 10);
  if (!Number.isFinite(count) || count < 0) count = 0;
  env.GIT_CONFIG_COUNT = String(count + 1);
  env[`GIT_CONFIG_KEY_${count}`] = key;
  env[`GIT_CONFIG_VALUE_${count}`] = value;
  return env;
}

/**
 * Add git config entries for the token's HTTP auth header — and, when the user
 * configured one, for the proxy. GitHub is only reachable through the proxy in
 * exactly the setup that needs this, so a clone that skipped it would fail with
 * "Failed to connect to github.com port 443".
 *
 * `http.proxy` is passed as a config value rather than argv, so proxy
 * credentials cannot leak into the process list.
 */
export function gitEnvWithToken(token, baseEnv = process.env, proxyUrl = '') {
  const env = { ...baseEnv, GIT_TERMINAL_PROMPT: '0' };
  if (proxyUrl) appendGitConfig(env, 'http.proxy', String(proxyUrl));
  if (!token) return env;
  const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  const headerValue = `AUTHORIZATION: basic ${basic}`;
  return appendGitConfig(env, 'http.https://github.com/.extraheader', headerValue);
}

/** Remove the token (and its base64 form) from any text we might surface. */
export function redact(text, token) {
  let out = String(text == null ? '' : text);
  if (token) {
    if (out.includes(token)) out = out.split(token).join('***');
    const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
    if (out.includes(basic)) out = out.split(basic).join('***');
  }
  // `scheme://user:secret@host` — covers proxy credentials git may echo back.
  out = out.replace(/(\w+:\/\/[^/\s@]+):([^/\s@]+)@/g, '$1:***@');
  return out;
}

export function gitAvailable() {
  return new Promise((resolvePromise) => {
    execFile('git', ['--version'], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      if (error) resolvePromise({ available: false, version: '' });
      else resolvePromise({ available: true, version: String(stdout || '').trim() });
    });
  });
}

function tail(text, lines = 6) {
  const parts = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return parts.slice(-lines).join('\n');
}

/**
 * Clone `owner/name` into `dest`. The caller has already checked that `dest`
 * sits inside a registered workspace and does not exist.
 */
export function cloneRepository(options) {
  const { full, dest, token, log, proxyUrl = '' } = options;
  return new Promise((resolvePromise) => {
    const url = `https://github.com/${full}.git`;
    const args = ['clone', '--progress', url, dest];
    const env = gitEnvWithToken(token, process.env, proxyUrl);
    const started = Date.now();
    execFile(
      'git',
      args,
      { env, timeout: CLONE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (error, stdout, stderr) => {
        const elapsedMs = Date.now() - started;
        const cleanErr = redact(error && error.message, token);
        if (error) {
          if (log) log.warn(`clone failed for ${full} -> ${dest}: ${cleanErr}`);
          resolvePromise({
            ok: false,
            elapsedMs,
            error: cleanErr,
            detail: redact(tail(stderr) || tail(stdout), token),
          });
          return;
        }
        if (log) log.info(`cloned ${full} -> ${dest} in ${elapsedMs}ms`);
        resolvePromise({
          ok: true,
          path: dest,
          elapsedMs,
          detail: redact(tail(stderr, 3), token),
        });
      },
    );
  });
}

/** `dest` must not exist yet: a clone never merges into an existing tree. */
export function describeDest(dest) {
  if (!existsSync(dest)) return { exists: false };
  try {
    return { exists: true, directory: statSync(dest).isDirectory() };
  } catch {
    return { exists: true, directory: false };
  }
}

/**
 * Resolve the destination of a clone and prove it is inside `workspacePath`.
 * Returns `{ ok: false, error }` instead of throwing so the route can answer 400.
 */
export function resolveCloneTarget(workspacePath, repoName, subdir = '') {
  if (!workspacePath || !isAbsolute(workspacePath)) {
    return { ok: false, error: '工作区路径无效' };
  }
  const base = resolve(workspacePath);
  const cleanSub = String(subdir || '').trim().replace(/^[/\\]+|[/\\]+$/g, '');
  const dest = cleanSub ? resolve(base, cleanSub, repoName) : resolve(base, repoName);
  const normalizedBase = base.endsWith('\\') || base.endsWith('/') ? base : `${base}${process.platform === 'win32' ? '\\' : '/'}`;
  const same = dest.toLowerCase() === base.toLowerCase();
  const inside = dest.toLowerCase().startsWith(normalizedBase.toLowerCase());
  if (same || !inside) {
    return { ok: false, error: '目标目录必须位于所选工作区之内' };
  }
  return { ok: true, dest, base };
}
