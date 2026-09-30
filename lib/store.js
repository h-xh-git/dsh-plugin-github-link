/**
 * store.js — the plugin's only durable state.
 *
 * The GitHub token is a bearer credential for `repo` scope, so it lives in the
 * user's home directory (never inside the profile, never inside the workspace
 * git tree, never in a cordis patch):
 *
 *     <home>/.dsh-github-link/credentials.json     (mode 0600 where supported)
 *
 * `DSH_GITHUB_LINK_DIR` relocates the whole directory — the verification script
 * uses it so a test run can never touch real credentials.
 *
 * The store keeps non-secret settings (the OAuth App client id) in the same
 * file: one file, one atomic writer, no partial states.
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const FILE_NAME = 'credentials.json';

export function dataDir() {
  const override = process.env.DSH_GITHUB_LINK_DIR;
  return override && override.trim() ? resolve(override.trim()) : join(homedir(), '.dsh-github-link');
}

export function credentialsPath() {
  return join(dataDir(), FILE_NAME);
}

/** Never throws: a missing/corrupt file reads as `{}` so the plugin still boots. */
export function readCredentials() {
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Merge `patch` into the stored record. A key set to `undefined` is removed —
 * that is how logout clears the token without a second code path.
 * Write is atomic (tmp + rename) so a crash cannot leave a half-written file.
 */
export function writeCredentials(patch) {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const next = { ...readCredentials(), ...patch };
  for (const key of Object.keys(next)) {
    if (next[key] === undefined) delete next[key];
  }
  const file = credentialsPath();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* Windows: chmod is a no-op; the file still sits in the user's own home. */
  }
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* see above */
  }
  return next;
}

/** The client id is a public identifier, so an env override is safe and handy. */
export function resolveClientId(creds = readCredentials(), override = '') {
  if (typeof override === 'string' && override.trim()) {
    return { clientId: override.trim(), source: 'config' };
  }
  const fromEnv = process.env.DSH_GITHUB_CLIENT_ID;
  if (fromEnv && fromEnv.trim()) return { clientId: fromEnv.trim(), source: 'env' };
  if (typeof creds.clientId === 'string' && creds.clientId.trim()) {
    return { clientId: creds.clientId.trim(), source: 'stored' };
  }
  return { clientId: '', source: 'none' };
}

/** The viewer block the GUI renders; the token itself never leaves the host. */
export function publicState(creds = readCredentials(), overrideClientId = '') {
  const { clientId, source } = resolveClientId(creds, overrideClientId);
  return {
    dataDir: dataDir(),
    credentialsPath: credentialsPath(),
    clientId,
    clientIdSource: source,
    connected: typeof creds.token === 'string' && creds.token.length > 0,
    user: creds.user && typeof creds.user === 'object' ? creds.user : null,
    scopes: typeof creds.scopes === 'string' ? creds.scopes : '',
    tokenKind: typeof creds.tokenKind === 'string' ? creds.tokenKind : '',
    connectedAt: typeof creds.connectedAt === 'string' ? creds.connectedAt : '',
  };
}
