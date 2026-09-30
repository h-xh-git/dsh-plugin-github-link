/**
 * publish.js — upload a local workspace to GitHub and push updates to it.
 *
 * Two operations, one safety model:
 *
 *   upload   a workspace directory → (create the GitHub repo) → first push
 *   update   commit the working tree → push to the existing remote
 *
 * Rules this module never breaks:
 *
 *   - **No destructive git.** No `--force`, no `reset`, no `clean`, no
 *     `checkout` of files. A remote that has commits we do not have is a
 *     refusal, not something to overwrite (`--ff-only` discipline).
 *   - **No global config writes.** Identity and credentials travel through the
 *     child process environment (`GIT_AUTHOR_*` / `GIT_COMMITTER_*` /
 *     `GIT_CONFIG_KEY_n`), so a user's global git config and shell history stay
 *     untouched, and a token never reaches argv or `.git/config`.
 *   - **Nothing is uploaded silently.** `plan()` reports what *would* happen —
 *     file count, bytes, files that look like secrets, whether the remote has
 *     diverged — and `apply()` refuses to proceed past the risky cases without
 *     an explicit confirmation flag.
 *
 * Every git and network call is injectable, so the verification suite runs the
 * whole thing against a real local repository and a local bare "remote" without
 * touching the network.
 */

import { execFile } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';

import { gitEnvWithToken, redact } from './clone.js';

const GIT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Refuse to even try a first upload above this; pushing this much over HTTP is a mistake. */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const WARN_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_SCAN_FILES = 20_000;
const MAX_SCAN_DEPTH = 8;
const BIG_FILE_BYTES = 10 * 1024 * 1024;

/** Names that very often mean "this should not be in a public repository". */
const RISKY_FILE = /(^|\/)(\.env(\..+)?|\.npmrc|\.pypirc|\.netrc|id_rsa|id_ed25519|credentials?\.json|credentials?\.ya?ml|secrets?\.(json|ya?ml)|.*\.(pem|key|p12|pfx|keystore))$/i;
const RISKY_DIR = /(^|\/)(node_modules|\.venv|venv|__pycache__|target|dist|build|\.next|out)$/i;

export const DEFAULT_GITIGNORE = [
  '# 由 dsh-plugin-github-link 生成',
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  'dist/',
  'build/',
  'out/',
  '.next/',
  'target/',
  '*.log',
  '.env',
  '.env.*',
  '.DS_Store',
  'Thumbs.db',
  '',
].join('\n');

/** `git` runner. Never throws: the caller reads `{ ok, code, stdout, stderr }`. */
export function runGit(dir, args, options = {}) {
  const { env, timeout = GIT_TIMEOUT_MS, bin = 'git' } = options;
  return new Promise((resolvePromise) => {
    execFile(
      bin,
      args,
      {
        cwd: dir,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(env || {}) },
        timeout,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
        resolvePromise({
          ok: !error,
          code,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: error || undefined,
        });
      },
    );
  });
}

function oneLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

/** Child environment: token + proxy + a per-commit identity, all out-of-band. */
export function publishEnv({ token = '', proxyUrl = '', identity } = {}) {
  const env = gitEnvWithToken(token, process.env, proxyUrl);
  if (identity && identity.name && identity.email) {
    env.GIT_AUTHOR_NAME = identity.name;
    env.GIT_AUTHOR_EMAIL = identity.email;
    env.GIT_COMMITTER_NAME = identity.name;
    env.GIT_COMMITTER_EMAIL = identity.email;
  }
  return env;
}

/** Identity for commits: the signed-in GitHub account, via GitHub's noreply address. */
export function identityFor(creds) {
  const user = (creds && creds.user) || {};
  const login = String(user.login || '').trim();
  if (!login) return undefined;
  const name = String(user.name || '').trim() || login;
  return { name, email: `${login}@users.noreply.github.com` };
}

export async function isGitRepo(dir, options = {}) {
  const result = await runGit(dir, ['rev-parse', '--is-inside-work-tree'], options);
  if (!result.ok) return { repo: false, root: '' };
  const root = await runGit(dir, ['rev-parse', '--show-toplevel'], options);
  return { repo: true, root: root.ok ? root.stdout.trim() : dir };
}

export async function hasCommits(dir, options = {}) {
  const result = await runGit(dir, ['rev-parse', '--verify', 'HEAD'], options);
  return result.ok;
}

/**
 * Everything the UI needs to decide what a push would do. Runs read-only git
 * commands only.
 */
export async function repoStatus(dir, options = {}) {
  const env = options.env || publishEnv({});
  const inside = await isGitRepo(dir, options);
  if (!inside.repo) {
    return {
      repo: false,
      root: '',
      dirIsRoot: false,
      branch: '',
      head: '',
      dirty: false,
      changed: 0,
      untracked: 0,
      remote: '',
      upstream: '',
      ahead: 0,
      behind: 0,
      lastCommit: '',
    };
  }

  const branchResult = await runGit(dir, ['symbolic-ref', '--short', '-q', 'HEAD'], { ...options, env });
  const branch = branchResult.ok
    ? branchResult.stdout.trim()
    : (await runGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], { ...options, env })).stdout.trim();

  const statusResult = await runGit(dir, ['status', '--porcelain'], { ...options, env });
  const lines = statusResult.stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  const untracked = lines.filter((line) => line.startsWith('??')).length;

  const headResult = await runGit(dir, ['rev-parse', '--short', 'HEAD'], { ...options, env });
  const remoteResult = await runGit(dir, ['remote', 'get-url', 'origin'], { ...options, env });
  const upstreamResult = await runGit(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
    ...options,
    env,
  });
  const upstream = upstreamResult.ok ? upstreamResult.stdout.trim() : '';
  let ahead = 0;
  let behind = 0;
  if (upstreamResult.ok) {
    const counts = await runGit(dir, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`], {
      ...options,
      env,
    });
    if (counts.ok) {
      const [left, right] = counts.stdout.trim().split(/\s+/);
      behind = Number.parseInt(left, 10) || 0;
      ahead = Number.parseInt(right, 10) || 0;
    }
  }
  const logResult = await runGit(dir, ['log', '-1', '--pretty=%h %s'], { ...options, env });

  return {
    repo: true,
    root: inside.root,
    dirIsRoot: resolve(inside.root).toLowerCase() === resolve(dir).toLowerCase(),
    branch: branch || '',
    head: headResult.ok ? headResult.stdout.trim() : '',
    dirty: lines.length > 0,
    changed: lines.length,
    untracked,
    remote: remoteResult.ok ? remoteResult.stdout.trim() : '',
    upstream,
    ahead,
    behind,
    lastCommit: logResult.ok ? oneLine(logResult.stdout) : '',
  };
}

/**
 * Walk the tree counting bytes and flagging things that should not be published
 * (secrets, dependency/vendor directories, very large files). Symlinks are not
 * followed; the walk is bounded so a huge directory cannot hang a request.
 */
export function scanDirectory(dir, options = {}) {
  const maxFiles = options.maxFiles || MAX_SCAN_FILES;
  const maxDepth = options.maxDepth || MAX_SCAN_DEPTH;
  const result = {
    files: 0,
    bytes: 0,
    truncated: false,
    risky: [],
    bigFiles: [],
    topDirs: [],
  };
  const dirBytes = new Map();

  const walk = (current, depth) => {
    if (result.truncated || depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (result.truncated) return;
      const full = join(current, entry.name);
      const rel = full.slice(dir.length + 1).replace(/\\/g, '/');
      if (entry.name === '.git') continue;
      let info;
      try {
        info = lstatSync(full);
      } catch {
        continue;
      }
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (RISKY_DIR.test(rel) && result.risky.length < 20) {
          result.risky.push({ path: rel, kind: 'directory' });
          continue; // do not descend into node_modules and friends
        }
        dirBytes.set(rel, 0);
        walk(full, depth + 1);
        continue;
      }
      if (!info.isFile()) continue;
      result.files += 1;
      result.bytes += info.size;
      if (result.files > maxFiles) {
        result.truncated = true;
        return;
      }
      const top = rel.split('/')[0];
      dirBytes.set(top, (dirBytes.get(top) || 0) + info.size);
      if (RISKY_FILE.test(rel) && result.risky.length < 20) {
        result.risky.push({ path: rel, kind: 'file' });
      }
      if (info.size > BIG_FILE_BYTES && result.bigFiles.length < 10) {
        result.bigFiles.push({ path: rel, bytes: info.size });
      }
    }
  };

  walk(dir, 0);
  result.topDirs = [...dirBytes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([path, bytes]) => ({ path, bytes }))
    .filter((entry) => entry.bytes > 0);
  return result;
}

/**
 * Immediate subdirectories of `dir`, for the "which folder inside the
 * workspace?" picker. Dependency and VCS directories are noise in that list, so
 * they are filtered out; symlinks are never followed.
 */
export function listDirectories(dir, options = {}) {
  const limit = options.limit || 200;
  const names = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      if (entry.name.startsWith('.')) continue;
      names.push(entry.name);
      if (names.length >= limit) break;
    }
  } catch {
    return [];
  }
  return names.sort((a, b) => a.localeCompare(b));
}

/** `.gitignore` is only ever *created* — an existing one is never rewritten. */
export function ensureGitignore(dir, content = DEFAULT_GITIGNORE) {
  const file = join(dir, '.gitignore');
  if (existsSync(file)) return { created: false, path: file };
  try {
    writeFileSync(file, content, 'utf8');
    return { created: true, path: file };
  } catch (error) {
    return { created: false, path: file, error: String(error && error.message ? error.message : error) };
  }
}

export async function initRepository(dir, { branch = 'main', env, ...options } = {}) {
  const existing = await isGitRepo(dir, options);
  if (existing.repo) {
    const current = await runGit(dir, ['symbolic-ref', '--short', '-q', 'HEAD'], { ...options, env });
    return { created: false, branch: current.ok ? current.stdout.trim() : branch };
  }
  let result = await runGit(dir, ['init', '-b', branch], { ...options, env });
  if (!result.ok) {
    // git < 2.28 has no `-b`.
    result = await runGit(dir, ['init'], { ...options, env });
    if (result.ok) await runGit(dir, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { ...options, env });
  }
  if (!result.ok) return { created: false, branch, error: oneLine(result.stderr) || 'git init 失败' };
  return { created: true, branch };
}

/** `git add -A` + commit, or a no-op when the tree is already clean. */
export async function commitAll(dir, { message, env, ...options } = {}) {
  const before = await hasCommits(dir, options);
  const add = await runGit(dir, ['add', '-A'], { ...options, env });
  if (!add.ok) return { committed: false, error: oneLine(add.stderr) || 'git add 失败' };
  const staged = await runGit(dir, ['diff', '--cached', '--quiet'], { ...options, env });
  if (staged.ok) return { committed: false, clean: true };
  const text = String(message || '').trim() || 'Update from DSH';
  const commit = await runGit(dir, ['commit', '-m', text], { ...options, env });
  if (!commit.ok) {
    return { committed: false, error: oneLine(commit.stderr) || oneLine(commit.stdout) || 'git commit 失败' };
  }
  const head = await runGit(dir, ['rev-parse', '--short', 'HEAD'], { ...options, env });
  return { committed: true, firstCommit: !before, head: head.ok ? head.stdout.trim() : '' };
}

/**
 * Point `origin` at the GitHub URL and push the current branch, refusing to
 * move a remote branch that has commits we do not have.
 */
export async function pushToRemote(dir, options = {}) {
  const { full, branch, remoteUrl, token, proxyUrl, log, env: providedEnv, checkAncestor = true } = options;
  const env = providedEnv || publishEnv({ token, proxyUrl });
  const url = remoteUrl || `https://github.com/${full}.git`;

  const current = await runGit(dir, ['remote', 'get-url', 'origin'], options);
  if (!current.ok) {
    const add = await runGit(dir, ['remote', 'add', 'origin', url], { ...options, env });
    if (!add.ok) {
      return { ok: false, code: 'remote_failed', error: oneLine(add.stderr) || '无法配置 remote' };
    }
  } else if (current.stdout.trim() !== url) {
    const set = await runGit(dir, ['remote', 'set-url', 'origin', url], { ...options, env });
    if (!set.ok) {
      return { ok: false, code: 'remote_failed', error: oneLine(set.stderr) || '无法更新 remote' };
    }
  }

  // Fetch the branch we are about to push. A brand-new empty remote has no such
  // branch, which is not an error. The explicit refspec matters: a bare
  // `git fetch origin <branch>` only fills FETCH_HEAD, leaving
  // `refs/remotes/origin/<branch>` stale — and the fast-forward check below
  // would then compare against the wrong commit.
  //
  // `checkAncestor: false` is for shallow clones (the subtree upload), where
  // `merge-base` has no common history to work with: there, git's own
  // non-fast-forward rejection during `push` is the guard that matters.
  const fetched = checkAncestor
    ? await runGit(
        dir,
        ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
        { ...options, env },
      )
    : { ok: false };
  const remoteRef = `origin/${branch}`;
  const remoteRefExists = checkAncestor
    ? (await runGit(dir, ['rev-parse', '--verify', '--quiet', remoteRef], { ...options, env })).ok
    : false;

  if (remoteRefExists) {
    const ancestor = await runGit(dir, ['merge-base', '--is-ancestor', remoteRef, 'HEAD'], { ...options, env });
    if (!ancestor.ok) {
      const counts = await runGit(dir, ['rev-list', '--left-right', '--count', `${remoteRef}...HEAD`], {
        ...options,
        env,
      });
      let behind = 0;
      if (counts.ok) behind = Number.parseInt(counts.stdout.trim().split(/\s+/)[0], 10) || 0;
      return {
        ok: false,
        code: 'non_fast_forward',
        behind,
        error: `远端 ${remoteRef} 有 ${behind} 个你本地没有的提交`,
        hint: '先把这个分支的远端改动拉到本地（git pull --ff-only），再重新推送；这里不会强制覆盖远端。',
      };
    }
    if ((await runGit(dir, ['rev-parse', remoteRef], { ...options, env })).stdout.trim()
      === (await runGit(dir, ['rev-parse', 'HEAD'], { ...options, env })).stdout.trim()) {
      return { ok: true, pushed: false, upToDate: true, url };
    }
  }

  const push = await runGit(dir, ['push', '--porcelain', '-u', 'origin', branch], { ...options, env });
  if (!push.ok) {
    const detail = redact(oneLine(push.stderr) || oneLine(push.stdout), token);
    // git refuses to move a branch backwards on its own; that refusal is the
    // last line of defence when the pre-check is skipped.
    const diverged = /non-fast-forward|fetch first|failed to push some refs/i.test(detail);
    const denied = /remote: Repository not found|403|404/i.test(detail);
    return {
      ok: false,
      code: diverged ? 'non_fast_forward' : denied ? 'push_denied' : 'push_failed',
      error: detail || 'git push 失败',
      hint: diverged ? '远端在本次操作期间有了新提交，请重试；这里不会强制覆盖远端。' : '',
      fetched: fetched.ok,
    };
  }
  if (log) log.info(`pushed ${branch} to ${full || url}`);
  return { ok: true, pushed: true, url, detail: redact(oneLine(push.stdout), token) };
}

// ── GitHub side ────────────────────────────────────────────────────────────

/** Create the repository. `auto_init` is deliberately off: an initial commit would make our first push non-fast-forward. */
export async function createRemoteRepo(options) {
  const { token, name, private: isPrivate = true, description = '', fetchImpl = fetch, baseUrl = 'https://api.github.com' } = options;
  const response = await fetchImpl(`${baseUrl}/user/repos`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'dsh-plugin-github-link',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({
      name,
      private: !!isPrivate,
      description: String(description || '').slice(0, 350),
      auto_init: false,
      has_issues: true,
      has_wiki: false,
      has_projects: false,
    }),
  });
  let data;
  try {
    data = JSON.parse(await response.text());
  } catch {
    data = undefined;
  }
  if (!response.ok) {
    const message = (data && data.message) || `GitHub 返回 HTTP ${response.status}`;
    const detail = data && Array.isArray(data.errors) && data.errors[0] && data.errors[0].message ? data.errors[0].message : '';
    return { ok: false, status: response.status, error: detail ? `${message}（${detail}）` : message };
  }
  return {
    ok: true,
    fullName: data.full_name,
    htmlUrl: data.html_url,
    cloneUrl: data.clone_url,
    private: !!data.private,
    defaultBranch: data.default_branch || 'main',
  };
}

// ── orchestration ──────────────────────────────────────────────────────────

/**
 * What an upload/update would do, without touching anything.
 * `kind: 'upload'` plans a first upload (optionally into a brand-new repo),
 * `kind: 'update'` plans a plain push to the existing remote.
 */
export async function planPublish(options) {
  const {
    dir,
    kind = 'update',
    create = '',
    repoName = '',
    remoteUrl = '',
    token = '',
    proxyUrl = '',
    login = '',
    gitOptions = {},
    scan = true,
  } = options;

  if (!dir || !existsSync(dir)) {
    return { ok: false, error: '目录不存在' };
  }
  const env = publishEnv({ token, proxyUrl, identity: options.identity });
  const status = await repoStatus(dir, { ...gitOptions, env });
  const scanResult = scan ? scanDirectory(dir) : undefined;
  const branch = status.branch || options.branch || 'main';
  const full = create ? `${login}/${repoName}` : options.full || '';

  const plan = {
    ok: true,
    kind,
    dir,
    workspace: basename(dir),
    repo: status.repo,
    branch,
    head: status.head,
    dirty: status.dirty,
    changed: status.changed,
    untracked: status.untracked,
    ahead: status.ahead,
    behind: status.behind,
    remote: status.remote,
    upstream: status.upstream,
    lastCommit: status.lastCommit,
    target: create ? 'new' : 'existing',
    full,
    repoName,
    remoteUrl: remoteUrl || (full ? `https://github.com/${full}.git` : status.remote),
    scan: scanResult,
    addGitignore: !!options.addGitignore,
    warnings: [],
    blockers: [],
  };

  if (scanResult) {
    if (scanResult.risky.length) {
      plan.warnings.push({
        code: 'risky_paths',
        text: `发现 ${scanResult.risky.length} 个可能不该上传的路径（密钥/依赖目录）`,
        paths: scanResult.risky.map((entry) => entry.path),
      });
    }
    if (scanResult.bytes > MAX_UPLOAD_BYTES) {
      plan.blockers.push({
        code: 'too_large',
        text: `目录约 ${Math.round(scanResult.bytes / 1024 / 1024)} MB，超过 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB 上限`,
      });
    } else if (scanResult.bytes > WARN_UPLOAD_BYTES) {
      plan.warnings.push({
        code: 'large',
        text: `目录约 ${Math.round(scanResult.bytes / 1024 / 1024)} MB，首次推送会比较慢`,
      });
    }
    if (scanResult.files === 0) {
      plan.blockers.push({ code: 'empty', text: '目录里没有文件' });
    }
  }

  if (!status.repo && kind === 'update') {
    plan.blockers.push({ code: 'not_a_repo', text: '该目录还不是 git 仓库' });
  }
  if (kind === 'update' && status.repo && !status.remote) {
    plan.blockers.push({ code: 'no_remote', text: '仓库没有 origin remote，无法推送' });
  }
  if (kind === 'update' && status.behind > 0) {
    plan.blockers.push({
      code: 'behind',
      text:
        status.ahead > 0
          ? `本地有 ${status.ahead} 个未推送提交、远端有 ${status.behind} 个新提交（已分叉），需要先拉取或叠加`
          : `本地落后远端 ${status.behind} 个提交，请先拉取后再推送（不做强制推送）`,
    });
  }
  if (create && !repoName) {
    plan.blockers.push({ code: 'no_name', text: '请填写要新建的仓库名' });
  }
  if (!status.dirty && kind === 'update' && status.ahead === 0 && status.repo) {
    plan.warnings.push({ code: 'nothing_to_do', text: '没有待提交的改动，也没有待推送的提交' });
  }
  plan.ok = plan.blockers.length === 0;
  return plan;
}

/**
 * Run the plan: (create repo) → init → commit → push. Never force-pushes, and
 * reports the repository URL even when a later step fails, so a half-finished
 * upload is never a mystery.
 */
export async function applyPublish(options) {
  const {
    dir,
    kind = 'update',
    create = '',
    repoName = '',
    token = '',
    proxyUrl = '',
    login = '',
    message = '',
    branch = 'main',
    private: isPrivate = true,
    description = '',
    fetchImpl,
    gitOptions = {},
    log,
  } = options;
  const env = publishEnv({ token, proxyUrl, identity: options.identity });
  const result = {
    ok: false,
    kind,
    steps: [],
    created: false,
    full: '',
    htmlUrl: '',
    branch,
    committed: false,
    pushed: false,
  };

  let full = options.full || '';
  let remoteUrl = options.remoteUrl || '';
  if (create) {
    if (!login) return { ...result, error: '尚未连接 GitHub 账号' };
    const created = await createRemoteRepo({
      token,
      name: repoName,
      private: isPrivate,
      description,
      fetchImpl,
    });
    result.steps.push({ step: 'create_repo', ok: created.ok, detail: created.ok ? created.fullName : created.error });
    if (!created.ok) return { ...result, error: `新建仓库失败：${created.error}` };
    result.created = true;
    full = created.fullName;
    remoteUrl = created.cloneUrl || `https://github.com/${created.fullName}.git`;
    result.full = full;
    result.htmlUrl = created.htmlUrl;
  } else {
    result.full = full;
    if (!remoteUrl && full) remoteUrl = `https://github.com/${full}.git`;
  }

  const init = await initRepository(dir, { branch, env, ...gitOptions });
  result.steps.push({ step: 'init', ok: !init.error, detail: init.error || (init.created ? `已初始化分支 ${init.branch}` : `已在 ${init.branch}`) });
  if (init.error) return { ...result, error: init.error };
  result.branch = init.branch || branch;

  const commit = await commitAll(dir, { message, env, ...gitOptions });
  result.steps.push({
    step: 'commit',
    ok: !commit.error,
    detail: commit.error || (commit.committed ? `已提交 ${commit.head}` : '没有需要提交的改动'),
  });
  if (commit.error) return { ...result, error: commit.error };
  result.committed = !!commit.committed;
  result.commit = commit.head || '';

  const push = await pushToRemote(dir, {
    full,
    branch: result.branch,
    remoteUrl,
    token,
    proxyUrl,
    env,
    log,
    ...gitOptions,
  });
  result.steps.push({ step: 'push', ok: push.ok, detail: push.ok ? (push.pushed ? '已推送' : '远端已是最新') : push.error });
  if (!push.ok) {
    return { ...result, error: push.error, code: push.code, hint: push.hint, behind: push.behind };
  }
  result.pushed = !!push.pushed;
  result.upToDate = !!push.upToDate;
  result.ok = true;
  return result;
}

// ── bring the remote's commits into the local checkout ─────────────────────

/**
 * Pull the upstream branch into `dir`, three ways, none of which touches the
 * remote:
 *
 *   ff     `git merge --ff-only` — the strictly-behind case; refuses otherwise.
 *   onto   rebuild the local branch on top of the remote tip while keeping the
 *          working tree exactly as it is (`reset --soft` + one commit). This is
 *          the answer to "本地有未推送提交、远端也有新提交" without a force push.
 *   merge  a plain merge commit; conflicts are reported, never auto-resolved.
 *
 * Nothing here deletes a local file: `--soft` moves the branch pointer only, and
 * the previous commit stays reachable through the reflog.
 */
export async function pullRepository(options = {}) {
  const {
    dir,
    branch = '',
    mode = 'ff',
    token = '',
    proxyUrl = '',
    identity,
    message = '',
    commitDirty = false,
    gitOptions = {},
    log,
  } = options;
  const env = publishEnv({ token, proxyUrl, identity });
  const result = { ok: false, mode, steps: [] };

  const status = await repoStatus(dir, { ...gitOptions, env });
  if (!status.repo) return { ...result, error: '这个目录还不是 git 仓库' };
  if (!status.remote) return { ...result, error: '仓库没有配置 origin remote，无法拉取' };
  const target = branch || status.branch || 'main';
  result.branch = target;
  const remoteRef = `origin/${target}`;

  // `onto` rebuilds the index, so a dirty tree needs an explicit decision:
  // either the caller commits the WIP first (`commitDirty`), or we refuse and
  // hand back a one-click way to proceed. Nothing is ever discarded either way.
  if (mode === 'onto' && status.dirty) {
    if (!commitDirty) {
      return {
        ...result,
        code: 'dirty',
        dirty: true,
        error: '工作区有未提交的改动，请先提交或还原后再叠加',
        hint: '点「先提交这些改动，再叠加」即可：它会先建一个本地提交（改动不会丢），再完成叠加。',
      };
    }
    const localCommit = await commitAll(dir, {
      message: String(message || '').trim() || 'WIP from DSH',
      env,
      ...gitOptions,
    });
    if (localCommit.error) return { ...result, code: 'commit_failed', error: localCommit.error };
    result.steps.push({
      step: 'commit-local',
      ok: true,
      detail: localCommit.committed ? `已先提交本地改动 ${localCommit.head || ''}` : '没有需要提交的改动',
    });
  }

  const fetched = await runGit(
    dir,
    ['fetch', '--quiet', 'origin', `+refs/heads/${target}:refs/remotes/origin/${target}`],
    { ...gitOptions, env },
  );
  if (!(await runGit(dir, ['rev-parse', '--verify', '--quiet', remoteRef], { ...gitOptions, env })).ok) {
    return { ...result, error: `远端没有分支 ${target}`, detail: redact(oneLine(fetched.stderr), token) };
  }
  result.steps.push({ step: 'fetch', ok: true, detail: `已获取 ${remoteRef}` });

  const before = (await runGit(dir, ['rev-parse', 'HEAD'], { ...gitOptions, env })).stdout.trim();
  const remoteHead = (await runGit(dir, ['rev-parse', remoteRef], { ...gitOptions, env })).stdout.trim();
  const counts = await runGit(dir, ['rev-list', '--left-right', '--count', `${remoteRef}...HEAD`], {
    ...gitOptions,
    env,
  });
  let behind = 0;
  let ahead = 0;
  if (counts.ok) {
    const [left, right] = counts.stdout.trim().split(/\s+/);
    behind = Number.parseInt(left, 10) || 0;
    ahead = Number.parseInt(right, 10) || 0;
  }
  result.behind = behind;
  result.ahead = ahead;
  result.from = before.slice(0, 7);
  result.remoteHead = remoteHead.slice(0, 7);

  if (behind === 0) {
    return { ...result, ok: true, upToDate: true, pulled: 0, head: status.head || before.slice(0, 7) };
  }

  if (mode === 'ff') {
    if (ahead > 0) {
      return {
        ...result,
        code: 'not_fast_forward',
        error: `本地有 ${ahead} 个未推送提交、远端有 ${behind} 个新提交，无法快进`,
        hint: '用「叠加到远端最新」把本地内容放到远端最新之上（保留你的文件），或先手工处理分叉。',
      };
    }
    const merge = await runGit(dir, ['merge', '--ff-only', remoteRef], { ...gitOptions, env });
    if (!merge.ok) {
      return {
        ...result,
        code: 'not_fast_forward',
        error: redact(oneLine(merge.stderr) || '快进失败', token),
      };
    }
    result.steps.push({ step: 'merge', ok: true, detail: oneLine(merge.stdout) });
    if (log) log.info(`fast-forwarded ${target} to ${remoteHead.slice(0, 7)}`);
    return { ...result, ok: true, pulled: behind, behind: 0, ahead: 0, head: remoteHead.slice(0, 7) };
  }

  if (mode === 'onto') {
    if (ahead === 0) {
      const merge = await runGit(dir, ['merge', '--ff-only', remoteRef], { ...gitOptions, env });
      if (!merge.ok) {
        return { ...result, code: 'not_fast_forward', error: redact(oneLine(merge.stderr) || '快进失败', token) };
      }
      return { ...result, ok: true, pulled: behind, behind: 0, ahead: 0, head: remoteHead.slice(0, 7) };
    }

    // Build one commit on top of the remote tip whose content is:
    //   the remote tree  ∪  the files currently in the working directory
    // — the local copy wins where both have a path, remote-only files stay put,
    // and nothing on either side is deleted. `reset --soft` only moves the
    // branch pointer, and the replaced commit stays in the reflog.
    const soft = await runGit(dir, ['reset', '--soft', remoteRef], { ...gitOptions, env });
    if (!soft.ok) {
      return { ...result, code: 'reset_failed', error: redact(oneLine(soft.stderr) || '重置失败', token) };
    }
    const readTree = await runGit(dir, ['read-tree', remoteRef], { ...gitOptions, env });
    if (!readTree.ok) {
      return { ...result, code: 'reset_failed', error: redact(oneLine(readTree.stderr) || '无法以远端树为基准', token) };
    }

    const localFiles = listFilesRecursive(dir);
    for (const chunk of chunked(localFiles, 200)) {
      const add = await runGit(dir, ['add', '--', ...chunk], { ...gitOptions, env });
      if (!add.ok) return { ...result, error: redact(oneLine(add.stderr) || 'git add 失败', token) };
    }

    const diff = await runGit(dir, ['diff', '--cached', '--quiet'], { ...gitOptions, env });
    if (diff.ok) {
      return { ...result, ok: true, upToDate: true, pulled: behind, head: remoteHead.slice(0, 7) };
    }
    const text = String(message || '').trim() || `Merge local work onto ${remoteRef} from DSH`;
    const commit = await runGit(dir, ['commit', '-m', text], { ...gitOptions, env });
    if (!commit.ok) {
      return {
        ...result,
        error: redact(oneLine(commit.stderr) || oneLine(commit.stdout) || 'git commit 失败', token),
      };
    }

    // Files that only the remote has are in the new commit but not on disk yet;
    // materialise them so the checkout matches HEAD (otherwise the next push
    // would look like it deletes them).
    const remoteList = await runGit(dir, ['ls-tree', '-r', '--name-only', remoteRef], { ...gitOptions, env });
    const remoteFiles = remoteList.ok ? remoteList.stdout.split(/\r?\n/).filter(Boolean) : [];
    const localSet = new Set(localFiles);
    const onlyRemote = remoteFiles.filter((file) => !localSet.has(file));
    for (const chunk of chunked(onlyRemote, 200)) {
      await runGit(dir, ['checkout', '--', ...chunk], { ...gitOptions, env });
    }

    const head = (await runGit(dir, ['rev-parse', '--short', 'HEAD'], { ...gitOptions, env })).stdout.trim();
    result.steps.push({ step: 'onto', ok: true, detail: `已在 ${remoteRef} 之上建立 ${head}` });
    if (log) log.info(`rebuilt ${target} onto ${remoteRef}: ${head}`);
    return {
      ...result,
      ok: true,
      onto: true,
      pulled: behind,
      behind: 0,
      head,
      restored: onlyRemote.length,
      overlayed: localFiles.length,
    };
  }

  if (mode === 'merge') {
    const merge = await runGit(dir, ['merge', '--no-edit', remoteRef], { ...gitOptions, env });
    if (!merge.ok) {
      return {
        ...result,
        code: 'merge_conflict',
        error: redact(oneLine(merge.stderr) || oneLine(merge.stdout) || '合并失败', token),
        hint: '有冲突需要手工解决；插件不会自动覆盖任何一边。可用 git status 查看冲突文件。',
      };
    }
    return { ...result, ok: true, merged: true, pulled: behind, behind: 0, head: remoteHead.slice(0, 7) };
  }

  return { ...result, error: `未知的拉取方式：${mode}` };
}

/** Repo-relative paths of every regular file under `dir`, `.git` excluded. */
export function listFilesRecursive(dir, options = {}) {
  const maxDepth = options.maxDepth || 12;
  const limit = options.limit || 20_000;
  const out = [];
  const walk = (current, depth) => {
    if (out.length >= limit || depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.name === '.git') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        out.push(relative(dir, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(dir, 0);
  return out;
}

function chunked(list, size) {
  const out = [];
  for (let index = 0; index < list.length; index += size) out.push(list.slice(index, index + size));
  return out;
}

/** Create a directory if the caller asked for a new project folder inside a workspace. */
export function ensureDirectory(path) {
  try {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
    return { ok: statSync(path).isDirectory(), path: resolve(path) };
  } catch (error) {
    return { ok: false, path: resolve(path), error: String(error && error.message ? error.message : error) };
  }
}

// ── a local folder → a subdirectory of an existing repository ──────────────
//
// git pushes commits, not folders, so "put this folder into that repository
// path" needs its own route: shallow-clone the repository, drop the folder at
// the requested path, commit, and fast-forward push. One commit, only the
// target subtree touched, nothing on the remote deleted.

/** Validate the repository-side path a folder will be written into. */
export function normalizeRemotePath(raw) {
  const text = String(raw == null ? '' : raw)
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!text) return { ok: false, error: '请填写仓库里的目标路径，例如 docs/site' };
  if (text.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    return { ok: false, error: '目标路径不能包含空段、. 或 ..' };
  }
  if (!/^[A-Za-z0-9._\-/ ]{1,200}$/.test(text)) {
    return { ok: false, error: '目标路径只允许字母、数字、点、下划线、连字符、空格和斜杠' };
  }
  return { ok: true, path: text };
}

/** Copy the *contents* of `srcDir` into `destDir`; `.git` never travels along. */
export function copyFolderInto(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  let entries = 0;
  cpSync(srcDir, destDir, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (source) => {
      if (basename(source) === '.git') return false;
      entries += 1;
      return true;
    },
  });
  return { entries };
}

export function createTempDir(prefix = 'dsh-ghl-push-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeTree(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    return true;
  } catch {
    return false;
  }
}

const encodePath = (path) => String(path).split('/').map(encodeURIComponent).join('/');

async function githubGet(fetchImpl, baseUrl, path, token) {
  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'dsh-plugin-github-link',
        'x-github-api-version': '2022-11-28',
      },
    });
    let data;
    try {
      data = JSON.parse(await response.text());
    } catch {
      data = undefined;
    }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: String(error && error.message ? error.message : error),
    };
  }
}

/** What an upload-into-a-repository-subdirectory would do, without writing anything. */
export async function planRemoteFolder(options) {
  const {
    dir,
    full = '',
    remotePath = '',
    branch = '',
    token = '',
    scan = true,
    fetchImpl = fetch,
    baseUrl = 'https://api.github.com',
  } = options;

  const plan = {
    ok: true,
    kind: 'remote-dir',
    dir,
    full,
    branch,
    remotePath,
    target: 'remote-dir',
    repo: false,
    remoteExists: false,
    existing: 0,
    scan: undefined,
    warnings: [],
    blockers: [],
  };

  if (!dir || !existsSync(dir)) {
    plan.blockers.push({ code: 'dir', text: '本地文件夹不存在' });
    plan.ok = false;
    return plan;
  }
  const normalized = normalizeRemotePath(remotePath);
  if (!normalized.ok) {
    plan.blockers.push({ code: 'path', text: normalized.error });
    plan.ok = false;
    return plan;
  }
  plan.remotePath = normalized.path;

  if (scan) {
    const result = scanDirectory(dir);
    plan.scan = result;
    if (result.files === 0) plan.blockers.push({ code: 'empty', text: '这个文件夹里没有文件' });
    if (result.bytes > MAX_UPLOAD_BYTES) {
      plan.blockers.push({
        code: 'too_large',
        text: `文件夹约 ${Math.round(result.bytes / 1024 / 1024)} MB，超过 ${MAX_UPLOAD_BYTES / 1024 / 1024} MB 上限`,
      });
    } else if (result.bytes > WARN_UPLOAD_BYTES) {
      plan.warnings.push({ code: 'large', text: `文件夹约 ${Math.round(result.bytes / 1024 / 1024)} MB，上传会比较慢` });
    }
    if (result.risky.length) {
      plan.warnings.push({
        code: 'risky_paths',
        text: `发现 ${result.risky.length} 个可能不该上传的路径（密钥/依赖目录）`,
        paths: result.risky.map((entry) => entry.path),
      });
    }
  }

  if (!token) {
    plan.blockers.push({ code: 'no_token', text: '尚未连接 GitHub 账号' });
    plan.ok = false;
    return plan;
  }

  const meta = await githubGet(fetchImpl, baseUrl, `/repos/${full}`, token);
  if (!meta.ok) {
    plan.blockers.push({
      code: 'repo',
      text:
        meta.status === 404
          ? `仓库不存在或无权访问：${full}`
          : `读取仓库失败：${meta.error || `HTTP ${meta.status}`}`,
    });
  } else {
    plan.repo = true;
    plan.private = !!meta.data.private;
    plan.branch = branch || meta.data.default_branch || 'main';
  }

  if (plan.repo && plan.branch) {
    const listing = await githubGet(
      fetchImpl,
      baseUrl,
      `/repos/${full}/contents/${encodePath(plan.remotePath)}?ref=${encodeURIComponent(plan.branch)}`,
      token,
    );
    if (listing.ok) {
      plan.remoteExists = true;
      plan.existing = Array.isArray(listing.data) ? listing.data.length : 1;
    } else if (listing.status !== 404) {
      plan.blockers.push({
        code: 'contents',
        text: `无法读取远端路径 ${plan.remotePath}：${listing.error || `HTTP ${listing.status}`}`,
      });
    }
  }

  plan.ok = plan.blockers.length === 0;
  return plan;
}

/**
 * Run it. A temporary shallow clone keeps this crate simple and binary-safe;
 * the price is downloading one depth-1 copy of the repository.
 */
export async function applyRemoteFolder(options) {
  const {
    dir,
    full = '',
    remotePath = '',
    branch = 'main',
    token = '',
    proxyUrl = '',
    identity,
    message = '',
    remoteUrl = '',
    gitOptions = {},
    log,
    workDir,
  } = options;

  const normalized = normalizeRemotePath(remotePath);
  const result = {
    ok: false,
    kind: 'remote-dir',
    steps: [],
    full,
    remotePath: normalized.ok ? normalized.path : String(remotePath || ''),
    branch,
    committed: false,
    pushed: false,
  };
  if (!normalized.ok) return { ...result, error: normalized.error };
  if (!dir || !existsSync(dir)) return { ...result, error: '本地文件夹不存在' };

  const work = workDir || createTempDir();
  const repoDir = join(work, 'repo');
  const env = publishEnv({ token, proxyUrl, identity });
  const url = remoteUrl || `https://github.com/${full}.git`;

  try {
    const clone = await runGit(
      work,
      ['clone', '--depth', '1', '--single-branch', '--branch', branch, '--quiet', url, repoDir],
      { ...gitOptions, env, timeout: 15 * 60 * 1000 },
    );
    result.steps.push({
      step: 'clone',
      ok: clone.ok,
      detail: clone.ok ? `已获取 ${full} 的 ${branch}（depth 1）` : oneLine(clone.stderr),
    });
    if (!clone.ok) {
      return { ...result, code: 'clone_failed', error: redact(oneLine(clone.stderr) || '无法克隆目标仓库', token) };
    }

    const dest = join(repoDir, ...normalized.path.split('/'));
    const copied = copyFolderInto(dir, dest);
    result.copied = copied.entries;
    result.steps.push({ step: 'copy', ok: true, detail: `已把本地文件夹写进 ${normalized.path}` });

    const staged = await runGit(repoDir, ['add', '-A', '--', normalized.path], { ...gitOptions, env });
    if (!staged.ok) return { ...result, error: redact(oneLine(staged.stderr) || 'git add 失败', token) };

    const diff = await runGit(repoDir, ['diff', '--cached', '--quiet'], { ...gitOptions, env });
    if (diff.ok) {
      result.steps.push({ step: 'commit', ok: true, detail: '内容没有变化' });
      return { ...result, ok: true, upToDate: true };
    }

    const commit = await runGit(
      repoDir,
      ['commit', '-m', String(message || '').trim() || `Upload ${normalized.path} from DSH`],
      { ...gitOptions, env },
    );
    if (!commit.ok) {
      return { ...result, error: redact(oneLine(commit.stderr) || oneLine(commit.stdout) || 'git commit 失败', token) };
    }
    const head = await runGit(repoDir, ['rev-parse', '--short', 'HEAD'], { ...gitOptions, env });
    result.committed = true;
    result.commit = head.ok ? head.stdout.trim() : '';
    result.steps.push({ step: 'commit', ok: true, detail: `已提交 ${result.commit}` });

    // `checkAncestor: false`: a depth-1 clone has no shared history for
    // `merge-base` to reason about, so git's own non-fast-forward rejection
    // during push is the guard here.
    const push = await pushToRemote(repoDir, {
      ...gitOptions,
      full,
      branch,
      remoteUrl: url,
      token,
      proxyUrl,
      env,
      log,
      checkAncestor: false,
    });
    result.steps.push({
      step: 'push',
      ok: push.ok,
      detail: push.ok ? (push.pushed ? '已推送' : '远端已是最新') : push.error,
    });
    if (!push.ok) return { ...result, error: push.error, code: push.code, hint: push.hint };
    result.pushed = !!push.pushed;
    result.upToDate = !!push.upToDate;
    result.ok = true;
    return result;
  } finally {
    if (!workDir) removeTree(work);
  }
}
