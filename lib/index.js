/**
 * dsh-plugin-github-link — host half.
 *
 * A Cordis plugin loaded as an out-of-tree bundle row (see cordis.patch.yml).
 * It contributes a same-origin HTTP surface under `/github-link` and nothing
 * else: no model-visible tool, no prompt text, no settings schema.
 *
 * Responsibilities:
 *   1. Own the GitHub credential — OAuth Device Flow or a pasted personal
 *      access token — in `~/.dsh-github-link/credentials.json`, and never send
 *      the token to the browser.
 *   2. Proxy the GitHub REST calls the browser half needs (repositories,
 *      branches, commits) so the token never has to leave the host.
 *   3. Run `git clone` into a directory of a registered workspace.
 *   4. Optionally tunnel every GitHub request through an HTTP proxy
 *      (`config.proxy`, the settings page, or `HTTPS_PROXY`/`ALL_PROXY`), because
 *      Node's built-in `fetch` ignores the system proxy and a host behind
 *      Clash/v2ray in "system proxy" mode would otherwise fail with a bare
 *      `fetch failed` while the browser works fine.
 *
 * Failure containment: `apply` never throws. If the webserver is missing or a
 * route cannot be mounted, the plugin logs and stays inert — a broken optional
 * plugin must not take the profile's whole plugin tree down at boot.
 */

import { registerGitHubRoutes } from './routes.js';

export const name = 'dsh-plugin-github-link';

/**
 * Hard dependency: the browser half is `dsh.client`-declared with
 * `platform: "web"`, and every capability of this plugin is an HTTP route.
 * Without a webserver the Loader skips the bundle entirely, which is correct —
 * there is nothing for this plugin to do in a headless profile.
 */
export const inject = ['webServer'];

const NOOP_LOGGER = {
  info: (...args) => console.log('[github-link]', ...args),
  warn: (...args) => console.warn('[github-link]', ...args),
  error: (...args) => console.error('[github-link]', ...args),
};

function makeLogger(ctx) {
  try {
    const logger = typeof ctx.logger === 'function' ? ctx.logger(name) : ctx.logger;
    if (!logger) return NOOP_LOGGER;
    const pick = (level) => (...args) => {
      try {
        if (typeof logger[level] === 'function') logger[level](...args);
        else if (level === 'warn') console.warn('[github-link]', ...args);
        else console.log('[github-link]', ...args);
      } catch {
        /* logging must never break a request */
      }
    };
    return { info: pick('info'), warn: pick('warn'), error: pick('error') };
  } catch {
    return NOOP_LOGGER;
  }
}

export function apply(ctx, config) {
  const log = makeLogger(ctx);
  let dispose;
  try {
    const webServer = ctx && ctx.webServer;
    if (!webServer || typeof webServer.register !== 'function') {
      log.warn('no webserver service; plugin stays inert');
      return () => {};
    }
    dispose = registerGitHubRoutes(webServer, { ctx, log, config });
  } catch (error) {
    log.error(`failed to mount routes: ${error && error.message ? error.message : error}`);
    return () => {};
  }
  return () => {
    try {
      if (typeof dispose === 'function') dispose();
    } catch (error) {
      log.warn(`teardown failed: ${error && error.message ? error.message : error}`);
    }
  };
}

export default { name, inject, apply };
