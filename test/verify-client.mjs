/**
 * verify-client.mjs — headless verification of the browser half.
 *
 * The client half is a classic script that registers itself on
 * `window.__ModuleLoader__`; React and the slot service arrive at runtime from
 * the DSH web shell, which is not installed in this workspace. So this script
 * provides:
 *   - a `window.__ModuleLoader__` capture,
 *   - a minimal React shim (createElement / useState / useEffect / useCallback),
 *   - a recursive expander so the returned element tree can be inspected as text,
 *   - a fake `ctx.effect` / `ctx.slots` to drive `apply()`.
 *
 * It proves: the module registers under the right id, `apply()` mounts the
 * Settings page and injects the stylesheet, and each UI state renders the
 * expected content without throwing.
 *
 *     node test/verify-client.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = join(HERE, '..', 'lib', 'client.js');
const CLIENT_SOURCE = readFileSync(CLIENT_PATH, 'utf8');

let passed = 0;
const failures = [];

function test(title, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${title}`);
  } catch (error) {
    failures.push({ title, error });
    console.log(`  FAIL ${title}\n       ${error && error.message ? error.message : error}`);
  }
}

// ── React shim ─────────────────────────────────────────────────────────────

const hooks = {
  overrides: new Map(),
  useStateCalls: 0,
  effects: [],
};

function createElement(type, props, ...children) {
  const flat = [];
  const push = (child) => {
    if (Array.isArray(child)) child.forEach(push);
    else if (child !== null && child !== undefined && child !== false && child !== true) flat.push(child);
  };
  children.forEach(push);
  const merged = Object.assign({}, props);
  if (flat.length) merged.children = flat;
  return { type, props: merged };
}

function useState(initial) {
  const index = hooks.useStateCalls;
  hooks.useStateCalls += 1;
  const value = hooks.overrides.has(index)
    ? hooks.overrides.get(index)
    : typeof initial === 'function'
      ? initial()
      : initial;
  return [value, () => {}];
}

function useCallback(fn) {
  return fn;
}

function useEffect(fn) {
  hooks.effects.push(fn);
}

/** Minimal React.Component so the plugin's error boundary can be exercised. */
class Component {
  constructor(props) {
    this.props = props || {};
    this.state = {};
  }
}
Component.prototype.isReactComponent = {};

const Fragment = Symbol('react.fragment');
const React = { createElement, useState, useEffect, useCallback, Component, Fragment };

// ── browser shims ──────────────────────────────────────────────────────────

let registered = null;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      registered = definition;
    },
  },
};

const styleNodes = [];
let domWrites = 0;
const fakeDocument = {
  getElementById: (id) => styleNodes.filter((node) => node.id === id)[0] || null,
  createElement: () => ({ id: '', textContent: '', parentNode: null }),
  head: {
    appendChild(node) {
      domWrites += 1;
      node.parentNode = { removeChild: () => {} };
      styleNodes.push(node);
    },
  },
  documentElement: { appendChild: () => {} },
};
globalThis.document = fakeDocument;

// ── load the module exactly as the shell would ─────────────────────────────

vm.runInThisContext(CLIENT_SOURCE, { filename: 'client.js' });

assert.ok(registered, 'the module must register itself on window.__ModuleLoader__');
assert.equal(registered.id, 'dsh-plugin-github-link');

const plugin = registered.factory((id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require(${id})`);
});

// ── expand / inspect the element tree ──────────────────────────────────────

function expand(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node !== 'object') return node;
  if (typeof node.type === 'function') {
    const isClass = node.type.prototype && node.type.prototype.isReactComponent;
    if (isClass) {
      const instance = new node.type(node.props || {});
      if (instance.state === undefined) instance.state = {};
      return expand(instance.render());
    }
    return expand(node.type(node.props || {}));
  }
  const props = Object.assign({}, node.props);
  if (props.children) props.children = props.children.map(expand);
  return { type: node.type, props };
}

function textOf(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (Array.isArray(node)) {
    node.forEach((child) => textOf(child, out));
    return out;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (typeof node !== 'object') return out;
  if (node.props && node.props.children) textOf(node.props.children, out);
  return out;
}

/** Find host nodes by a prop predicate (placeholders/labels live in props, not text). */
function findNodes(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((child) => findNodes(child, predicate, out));
    return out;
  }
  if (predicate(node)) out.push(node);
  if (node.props && node.props.children) findNodes(node.props.children, predicate, out);
  return out;
}

let slotComponent = null;
const slotComponents = {};
const injected = [];
const fakeCtx = {
  slots: {
    inject(name, callback) {
      injected.push(name);
      return callback();
    },
    register(params, render) {
      const entry = { params, render };
      slotComponents[params.name] = entry;
      // The plugin registers exactly one entry — the Settings page — so that is
      // what the rest of this suite renders.
      slotComponent = entry;
      return () => {};
    },
  },
};

function renderWith(overrides) {
  hooks.overrides = new Map(Object.entries(overrides).map(([key, value]) => [Number(key), value]));
  hooks.useStateCalls = 0;
  hooks.effects = [];
  const element = slotComponent.render();
  const tree = expand(element);
  return { tree, text: textOf(tree).join(' | '), hookCount: hooks.useStateCalls, effects: hooks.effects.length };
}

// ── checks ─────────────────────────────────────────────────────────────────

console.log('dsh-plugin-github-link — client verification\n');

test('the file is a classic script, not an ES module', () => {
  assert.ok(!/^\s*import\s/m.test(CLIENT_SOURCE), 'no import statements');
  assert.ok(!/^\s*export\s/m.test(CLIENT_SOURCE), 'no export statements');
  assert.ok(CLIENT_SOURCE.includes('window.__ModuleLoader__.load('));
});

test('exports apply + inject, and injects the slots service', () => {
  assert.equal(typeof plugin.apply, 'function');
  assert.deepEqual(Array.from(plugin.inject), ['slots']);
});

test('apply() mounts one settings page and writes no DOM of its own', () => {
  const dispose = plugin.apply(fakeCtx);
  assert.equal(typeof dispose, 'undefined');
  assert.deepEqual(injected, ['settings.section'], 'the main-interface card must be gone');
  assert.ok(slotComponent, 'a settings.section entry must be registered');
  assert.deepEqual(
    { name: slotComponent.params.name, id: slotComponent.params.id, order: slotComponent.params.order, label: slotComponent.params.label },
    { name: 'settings.section', id: 'github-link', order: 620, label: 'GitHub 仓库' },
  );
  assert.equal(domWrites, 0, 'the plugin must not append to document.head/body');
});

test('nothing is registered into plugins.item any more', () => {
  assert.equal(slotComponents['plugins.item'], undefined);
  assert.ok(!CLIENT_SOURCE.includes('"plugins.item"'), 'no main-interface slot may be referenced');
});

test('dropdown options are explicitly coloured, so they cannot be white-on-white', () => {
  // The native <option> popup uses the browser's default background while the
  // option text inherits the theme colour: without an explicit pair the options
  // are invisible until hovered.
  const tree = expand(slotComponent.render());
  const css = findNodes(tree, (node) => node.type === 'style')[0].props.dangerouslySetInnerHTML.__html;
  const rule = /\.ghl-input\s+option\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'there must be a rule for .ghl-input option');
  assert.ok(/color\s*:/.test(rule[1]), 'the option text colour must be set');
  assert.ok(/background-color\s*:/.test(rule[1]), 'the option background must be set');
  assert.ok(/var\(--dsw-alias-/.test(rule[1]), 'and it must use theme tokens, not literals');
});

test('the page renders its stylesheet as a React element using theme tokens only', () => {
  const tree = expand(slotComponent.render());
  const styles = findNodes(tree, (node) => node.type === 'style');
  assert.equal(styles.length, 1, 'exactly one style element');
  const css = styles[0].props.dangerouslySetInnerHTML.__html;
  assert.ok(css.includes('.ghl-root'));
  assert.ok(css.includes('var(--dsw-alias-brand-primary)'));
  const literals = css.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) || [];
  assert.deepEqual(literals, [], 'literal colours are not allowed: theme tokens only');
});

test('a crashing page is contained by the error boundary', () => {
  const boundary = slotComponent.render();
  assert.equal(typeof boundary.type.getDerivedStateFromError, 'function', 'the entry must be wrapped in an error boundary');
  const instance = new boundary.type({ children: [createElement('div', null, 'never rendered')] });
  instance.state = boundary.type.getDerivedStateFromError(new Error('boom'));
  const out = expand(instance.render());
  assert.ok(textOf(out).join(' | ').includes('boom'));
  assert.equal(findNodes(out, (node) => node.type === 'style').length, 1, 'the fallback still carries its stylesheet');
});

const STATE_CONFIGURED = {
  clientIdSource: 'stored',
  clientId: 'Ov23liABCDEFGHIJKLMN',
  connected: false,
  defaultScopes: 'repo read:user',
  workspaces: [{ id: 'ws-1', title: 'demo-project', path: 'C:\\work\\demo-project' }],
  git: { available: true, version: 'git version 2.45.1' },
  user: null,
};

const STATE_CONNECTED = Object.assign({}, STATE_CONFIGURED, {
  connected: true,
  tokenKind: 'oauth',
  user: { login: 'octocat', name: 'The Octocat', avatarUrl: 'https://avatars.example/o.png' },
});

const REPO = {
  fullName: 'octocat/demo',
  name: 'demo',
  private: true,
  fork: false,
  archived: false,
  description: 'a demo repo',
  language: 'C++',
  stars: 7,
  sizeKb: 128,
  updatedAt: '2026-01-02T03:04:05Z',
};

const DETAIL = {
  repo: Object.assign({}, REPO, {
    ownerAvatar: '',
    htmlUrl: 'https://github.com/octocat/demo',
    forks: 2,
    openIssues: 1,
    defaultBranch: 'main',
    pushedAt: '2026-01-02T03:04:05Z',
    license: 'MIT',
    topics: ['esp32'],
  }),
  branches: [{ name: 'main', protected: true, sha: 'abc' }],
  commits: [
    { sha: 'abc1234', shortSha: 'abc1234', message: 'init', authorName: 'Octo', authorAvatar: '', date: '2026-01-02T03:04:05Z' },
  ],
};

test('unloaded state renders a loading line and never throws', () => {
  const { text, hookCount } = renderWith({});
  assert.equal(hookCount, 63, 'hook order changed — update the index map in this test');
  assert.ok(text.includes('正在读取状态'));
});

test('no client id renders the OAuth App setup steps', () => {
  const { tree, text, hookCount } = renderWith({
    0: { clientIdSource: 'none', connected: false, workspaces: [], git: { available: true } },
  });
  assert.equal(hookCount, 63);
  assert.ok(text.includes('创建 GitHub OAuth App'), 'setup card');
  assert.ok(text.includes('Enable Device Flow'), 'device-flow step');
  assert.ok(
    findNodes(tree, (node) => node.props && node.props.placeholder === 'OAuth App Client ID').length === 1,
    'client id input',
  );
  assert.ok(findNodes(tree, (node) => node.type === 'a' && String(node.props.href).includes('applications/new')).length === 1);
});

test('configured but disconnected renders both sign-in paths', () => {
  const { text } = renderWith({ 0: STATE_CONFIGURED });
  assert.ok(text.includes('用 GitHub 设备码登录'), 'device flow button');
  assert.ok(text.includes('改用 Personal Access Token'), 'PAT fallback');
  assert.ok(text.includes('repo read:user'), 'scope disclosure');
});

test('the guide names the next step for each stage', () => {
  const fresh = renderWith({
    0: { clientIdSource: 'none', connected: false, workspaces: [], git: { available: true } },
  });
  assert.ok(fresh.text.includes('配置 Client ID'), 'step one');
  assert.ok(fresh.text.includes('下一步：在 GitHub 建一个'), 'setup guidance');

  const configured = renderWith({ 0: STATE_CONFIGURED });
  assert.ok(configured.text.includes('下一步：点「用 GitHub 设备码登录」'), 'sign-in guidance');

  const ready = renderWith({ 0: STATE_CONNECTED });
  assert.ok(ready.text.includes('已就绪'), 'ready guidance');
});

test('the network proxy card stays collapsed until it is needed', () => {
  const off = renderWith({
    0: Object.assign({}, STATE_CONFIGURED, { proxy: { active: false, source: 'none', url: '', stored: '' } }),
  });
  assert.ok(off.text.includes('网络代理'), 'proxy card');
  assert.ok(off.text.includes('当前：直连'), 'direct-connection summary');
  assert.equal(
    findNodes(off.tree, (node) => node.props && node.props.placeholder === 'http://127.0.0.1:7890').length,
    0,
    'collapsed by default: no repair controls in the way',
  );

  const open = renderWith({
    0: Object.assign({}, STATE_CONFIGURED, { proxy: { active: false, source: 'none', url: '', stored: '' } }),
    49: true,
  });
  assert.equal(
    findNodes(open.tree, (node) => node.props && node.props.placeholder === 'http://127.0.0.1:7890').length,
    1,
    'proxy input once expanded',
  );
  assert.ok(open.text.includes('测试连接'));

  const on = renderWith({
    0: Object.assign({}, STATE_CONFIGURED, {
      proxy: { active: true, source: 'stored', url: 'http://127.0.0.1:7890', stored: 'http://127.0.0.1:7890' },
    }),
  });
  assert.ok(on.text.includes('已启用'));
  assert.ok(on.text.includes('当前：走代理 http://127.0.0.1:7890（设置页）'));
});

test('the proxy card distinguishes an environment-variable proxy from a stored one', () => {
  const { text } = renderWith({
    0: Object.assign({}, STATE_CONFIGURED, {
      proxy: { active: true, source: 'env', envVar: 'HTTPS_PROXY', url: 'http://127.0.0.1:7890', stored: '' },
    }),
    49: true,
  });
  assert.ok(text.includes('HTTPS_PROXY'), 'the env var name must be shown');
});

test('the proxy card explains an adopted OS trust store', () => {
  const { text } = renderWith({
    0: Object.assign({}, STATE_CONFIGURED, { tls: { systemCa: 'applied' } }),
  });
  assert.ok(text.includes('已自动改用 Windows 系统证书库'), 'the TLS fix must be visible');
});

test('the upload/update card summarises the workspace when collapsed', () => {
  const { text } = renderWith({
    0: STATE_CONNECTED,
    33: [
      {
        id: 'ws-1',
        title: 'demo-project',
        path: 'C:\\work\\demo-project',
        git: {
          repo: true,
          branch: 'main',
          dirty: true,
          changed: 3,
          remote: 'https://github.com/octocat/demo.git',
          ahead: 1,
          behind: 0,
        },
      },
    ],
    36: 'ws-1',
  });
  assert.ok(text.includes('上传与更新'), 'publish card');
  assert.ok(text.includes('demo-project · main · 3 个文件有改动 · 领先 1'), 'one-line workspace summary');
});

test('the upload/update card explains the two modes and the risky paths', () => {
  const { text } = renderWith({
    0: STATE_CONNECTED,
    33: [{ id: 'ws-1', title: 'plain', path: 'C:\\plain', git: { repo: false } }],
    36: 'ws-1',
    45: {
      ok: true,
      repo: false,
      branch: 'main',
      changed: 0,
      warnings: [],
      blockers: [],
      scan: { files: 3, bytes: 2048, risky: [{ path: '.env', kind: 'file' }] },
    },
    50: true,
  });
  assert.ok(text.includes('首次上传'), 'mode label');
  assert.ok(text.includes('推送更新'), 'the other mode');
  assert.ok(text.includes('① 预览'), 'the preview step is numbered');
  assert.ok(text.includes('.env'), 'the risky path must be listed');
  assert.ok(text.includes('我确认这些路径可以上传'), 'the explicit confirmation');
});

test('a folder inside the workspace can be chosen for the upload', () => {
  const { text } = renderWith({
    0: STATE_CONNECTED,
    33: [
      {
        id: 'ws-1',
        title: 'demo-project',
        path: 'C:\\work\\demo-project',
        git: { repo: true, branch: 'main', remote: 'https://github.com/octocat/demo.git' },
      },
    ],
    36: 'ws-1',
    50: true,
    55: 'src',
    56: ['lib', 'main'],
  });
  assert.ok(text.includes('上传目录：'), 'the folder row');
  assert.ok(text.includes('C:\\work\\demo-project\\src'), 'the folder actually chosen');
  assert.ok(text.includes('⬆ 上一层'), 'walk back up');
  assert.ok(text.includes('lib/') && text.includes('main/'), 'child folders are offered');
});

test('a folder that could not be read is reported instead of failing silently', () => {
  const { text } = renderWith({
    0: STATE_CONNECTED,
    33: [{ id: 'ws-1', title: 'x', path: 'C:\\x', git: { repo: false } }],
    36: 'ws-1',
    50: true,
    58: '目录不存在：C:\\x\\nope',
  });
  assert.ok(text.includes('无法读取子文件夹：目录不存在'), text);
});

test('the third mode writes a local folder into a repository subdirectory', () => {
  const { text } = renderWith({
    0: STATE_CONNECTED,
    14: [{ fullName: 'octocat/target', private: false }],
    33: [{ id: 'ws-1', title: 'demo-project', path: 'C:\\work\\demo-project', git: { repo: false } }],
    36: 'ws-1',
    37: 'remote-dir',
    50: true,
    53: 'octocat/target',
    55: 'docs',
    59: 'site/docs',
  });
  assert.ok(text.includes('上传到仓库子目录'), 'the mode button');
  assert.ok(text.includes('写入子目录'), 'the header badge');
  assert.equal(
    findNodes(renderWith({
      0: STATE_CONNECTED,
      33: [{ id: 'ws-1', title: 'demo-project', path: 'C:\\work\\demo-project', git: { repo: false } }],
      36: 'ws-1',
      37: 'remote-dir',
      50: true,
      53: 'octocat/target',
      55: 'docs',
      59: 'site/docs',
    }).tree, (node) => node.props && node.props.placeholder === '仓库内路径，如 docs/site').length,
    1,
    'the remote path input',
  );
  assert.ok(text.includes('写入 octocat/target/site/docs'), 'the target line');
  assert.ok(text.includes('② 写入仓库子目录'), 'the action button');
  assert.ok(text.includes('绝不删除远端文件'), 'the promise is stated');
});

test('the plan explains what a subdirectory upload will do', () => {
  const { text } = renderWith({
    0: STATE_CONNECTED,
    33: [{ id: 'ws-1', title: 'demo-project', path: 'C:\\work\\demo-project', git: { repo: false } }],
    36: 'ws-1',
    37: 'remote-dir',
    45: {
      ok: true,
      kind: 'remote-dir',
      full: 'octocat/target',
      remotePath: 'docs/site',
      branch: 'main',
      remoteExists: true,
      existing: 3,
      warnings: [],
      blockers: [],
      scan: { files: 5, bytes: 4096, risky: [] },
    },
    50: true,
    53: 'octocat/target',
    59: 'docs/site',
  });
  assert.ok(text.includes('目标 octocat/target/docs/site @ main'), text);
  assert.ok(text.includes('远端该路径已有 3 个条目（同名文件会被覆盖）'), text);
});

test('a diverged workspace offers both safe ways to catch up', () => {
  const { text } = renderWith({
    0: STATE_CONNECTED,
    33: [
      {
        id: 'ws-1',
        title: 'demo-project',
        path: 'C:\\work\\demo-project',
        git: {
          repo: true,
          branch: 'main',
          dirty: false,
          changed: 0,
          remote: 'https://github.com/octocat/demo.git',
          ahead: 1,
          behind: 8,
        },
      },
    ],
    36: 'ws-1',
    50: true,
  });
  assert.ok(text.includes('本地落后远端 8 个提交'), text);
  assert.ok(text.includes('领先 1 个（已分叉）'), 'the divergence is spelled out');
  assert.ok(text.includes('⬇ 拉取远端更新（仅快进）'), 'fast-forward button');
  assert.ok(text.includes('叠加到远端最新（保留本地改动）'), 'rebuild-onto button');
  assert.ok(text.includes('本地文件一个都不会少'), 'and what it promises');
});

test('a refused fast-forward points at the rebuild button', () => {
  const { text } = renderWith({
    0: STATE_CONNECTED,
    33: [
      {
        id: 'ws-1',
        title: 'demo-project',
        path: 'C:\\work\\demo-project',
        git: { repo: true, branch: 'main', dirty: false, changed: 0, remote: 'https://github.com/octocat/demo.git', ahead: 1, behind: 8 },
      },
    ],
    36: 'ws-1',
    50: true,
    61: { ok: false, text: '本地有 1 个未推送提交、远端有 8 个新提交，无法快进', notFastForward: true },
  });
  assert.ok(text.includes('无法快进'), text);
  assert.ok(text.includes('点右边的「叠加到远端最新」'), 'the next step is named');
});

test('a dirty tree offers to commit the work in progress first', () => {
  const { text } = renderWith({
    0: STATE_CONNECTED,
    33: [
      {
        id: 'ws-1',
        title: 'demo-project',
        path: 'C:\\work\\demo-project',
        git: { repo: true, branch: 'main', dirty: true, changed: 3, remote: 'https://github.com/octocat/demo.git', ahead: 1, behind: 8 },
      },
    ],
    36: 'ws-1',
    50: true,
    61: { ok: false, text: '工作区有未提交的改动，请先提交或还原后再叠加', commitFirst: true },
  });
  assert.ok(text.includes('工作区有未提交的改动'), text);
  assert.ok(text.includes('先提交这些改动，再叠加'), 'the dead end gets a one-click remedy');
});

test('the panel shows a compact status row instead of prose', () => {
  const { text } = renderWith({
    0: STATE_CONNECTED,
    33: [{ id: 'ws-1', title: 'demo-project', path: 'C:\\work\\demo-project', git: { repo: true, branch: 'main' } }],
  });
  assert.ok(text.includes('@octocat · oauth'), 'account chip');
  assert.ok(text.includes('网络 直连'), 'network chip');
  assert.ok(text.includes('工作区 1'), 'workspace count chip');
});

test('a clean workspace with nothing to push says so', () => {
  const { text } = renderWith({
    0: STATE_CONNECTED,
    33: [
      {
        id: 'ws-1',
        title: 'demo-project',
        path: 'C:\\work\\demo-project',
        git: { repo: true, branch: 'main', dirty: false, changed: 0, remote: 'https://github.com/octocat/demo.git', ahead: 0, behind: 0 },
      },
    ],
    36: 'ws-1',
    50: true,
  });
  assert.ok(text.includes('没有可推送的改动'), text);
});

test('branch and .gitignore stay behind an "advanced" toggle', () => {
  const workspace = {
    id: 'ws-1',
    title: 'demo-project',
    path: 'C:\\work\\demo-project',
    git: { repo: true, branch: 'main', dirty: true, changed: 1, remote: 'https://github.com/octocat/demo.git' },
  };
  const collapsed = renderWith({ 0: STATE_CONNECTED, 33: [workspace], 36: 'ws-1', 50: true });
  assert.equal(
    findNodes(collapsed.tree, (node) => node.props && node.props['aria-label'] === '分支').length,
    0,
    'the branch field is hidden by default',
  );
  assert.ok(collapsed.text.includes('▸ 高级'));

  const open = renderWith({ 0: STATE_CONNECTED, 33: [workspace], 36: 'ws-1', 50: true, 62: true });
  assert.equal(
    findNodes(open.tree, (node) => node.props && node.props['aria-label'] === '分支').length,
    1,
    'the branch field appears when expanded',
  );
  assert.ok(open.text.includes('▾ 高级'));
});

test('the actions are disabled when there is nothing to push', () => {
  const { tree } = renderWith({
    0: STATE_CONNECTED,
    33: [
      {
        id: 'ws-1',
        title: 'demo-project',
        path: 'C:\\work\\demo-project',
        git: { repo: true, branch: 'main', dirty: false, changed: 0, remote: 'https://github.com/octocat/demo.git', ahead: 0, behind: 0 },
      },
    ],
    36: 'ws-1',
    50: true,
  });
  const preview = findNodes(
    tree,
    (node) => node.type === 'button' && Array.isArray(node.props.children) && node.props.children.join('') === '① 预览',
  )[0];
  assert.ok(preview, 'the preview button exists');
  assert.equal(preview.props.disabled, true, 'nothing to do → the action is disabled, not an error');
});

test('the commit message field previews on Enter', () => {
  const { tree } = renderWith({
    0: STATE_CONNECTED,
    33: [{ id: 'ws-1', title: 'demo-project', path: 'C:\\work\\demo-project', git: { repo: true, branch: 'main', remote: 'https://github.com/octocat/demo.git' } }],
    36: 'ws-1',
    50: true,
  });
  const input = findNodes(tree, (node) => node.props && node.props['aria-label'] === '提交信息')[0];
  assert.ok(input, 'the commit message input exists');
  assert.equal(typeof input.props.onKeyDown, 'function', 'Enter must trigger a preview');
});

test('the repository list explains what a row does', () => {
  const { text } = renderWith({ 0: STATE_CONNECTED, 14: [REPO] });
  assert.ok(text.includes('点一行看详情'), text);
  assert.ok(text.includes('›'), 'a row affordance');
});

test('no rendered state leaks "undefined" / "NaN" / "[object Object]"', () => {
  // Regression guard for a real glitch: `"★ " + repo.stars` printed the literal
  // word "undefined" for a repository payload that lacked the field.
  const sparseRepo = { fullName: 'octocat/target', private: true };
  const cases = {
    fresh: { 0: { clientIdSource: 'none', connected: false, workspaces: [], git: { available: true } } },
    configured: { 0: STATE_CONFIGURED },
    'configured + proxy open': { 0: STATE_CONFIGURED, 49: true },
    'configured + help open': { 0: STATE_CONFIGURED, 51: true },
    'sparse repo list': { 0: STATE_CONNECTED, 14: [sparseRepo] },
    'sparse repo detail': { 0: STATE_CONNECTED, 25: 'octocat/target', 26: { repo: sparseRepo, branches: [], commits: [] } },
    'publish open (new repo)': {
      0: STATE_CONNECTED,
      14: [sparseRepo],
      33: [{ id: 'ws-1', title: 'demo-project', path: 'C:\\work\\demo-project', git: { repo: true, branch: 'main', dirty: true, changed: 3, remote: 'https://github.com/octocat/demo.git', ahead: 1, behind: 0 } }],
      36: 'ws-1',
      37: 'upload',
      38: true,
      50: true,
    },
    'publish open (existing target)': {
      0: STATE_CONNECTED,
      14: [sparseRepo],
      33: [{ id: 'ws-1', title: 'demo-project', path: 'C:\\work\\demo-project', git: { repo: true, branch: 'main', dirty: true, changed: 3, remote: 'https://github.com/octocat/demo.git' } }],
      36: 'ws-1',
      37: 'upload',
      50: true,
    },
    'device flow pending': {
      0: STATE_CONFIGURED,
      9: { flowId: 'f', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device', interval: 5, expiresIn: 900, deadline: Date.now() + 900000 },
    },
  };
  for (const [name, overrides] of Object.entries(cases)) {
    const { text } = renderWith(overrides);
    assert.ok(!/undefined|NaN|\[object Object\]/.test(text), `${name} leaked a value hole:\n${text}`);
  }
  const sparse = renderWith({ 0: STATE_CONNECTED, 14: [sparseRepo] });
  assert.ok(sparse.text.includes('★ 0'), 'a missing star count reads as zero');
});

test('an upload target repository can be picked by name', () => {
  const { text } = renderWith({
    0: STATE_CONNECTED,
    14: [{ fullName: 'octocat/target', private: true }],
    33: [{ id: 'ws-1', title: 'plain', path: 'C:\\plain', git: { repo: false } }],
    36: 'ws-1',
    37: 'upload',
    50: true,
  });
  assert.ok(text.includes('选择目标仓库（必须是空仓库）'), 'the picker');
  assert.ok(text.includes('octocat/target'), 'loaded repositories are offered');
  assert.ok(text.includes('还没选目标仓库'), 'the target line warns when nothing is chosen');
});

test('an active device flow shows the user code and the verification link', () => {
  const { text } = renderWith({
    0: STATE_CONFIGURED,
    9: {
      flowId: 'flow-1',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      interval: 5,
      expiresIn: 900,
    },
  });
  assert.ok(text.includes('ABCD-1234'), 'user code');
  assert.ok(text.includes('打开验证页'));
  assert.ok(text.includes('等待授权中'));
});

test('a missing git binary is reported without blocking the UI', () => {
  const { text } = renderWith({ 0: Object.assign({}, STATE_CONFIGURED, { git: { available: false } }) });
  assert.ok(text.includes('未检测到 git 命令'));
});

test('connected renders the repository list with private badges and paging', () => {
  const { text } = renderWith({ 0: STATE_CONNECTED, 14: [REPO] });
  assert.ok(text.includes('octocat/demo'));
  assert.ok(text.includes('私有'));
  assert.ok(text.includes('★ 7'));
  assert.ok(text.includes('C++'));
  assert.ok(text.includes('上一页'));
  assert.ok(text.includes('下一页'));
  assert.ok(text.includes('The Octocat') || text.includes('@octocat'));
});

test('a repository that already exists locally is marked in the list', () => {
  const { text } = renderWith({
    0: STATE_CONNECTED,
    14: [REPO],
    33: [
      {
        id: 'ws-1',
        title: 'demo-project',
        path: 'C:\\work\\demo-project',
        git: { repo: true, branch: 'main', remote: 'https://github.com/octocat/demo.git' },
      },
    ],
  });
  assert.ok(text.includes('本地已有'), 'badge on the row');
  assert.ok(text.includes('本地：demo-project'), 'which workspace holds it');
});

test('the details view links an existing local clone to the push flow', () => {
  const { text } = renderWith({
    0: STATE_CONNECTED,
    25: 'octocat/demo',
    26: DETAIL,
    33: [
      {
        id: 'ws-1',
        title: 'demo-project',
        path: 'C:\\work\\demo-project',
        git: { repo: true, branch: 'main', remote: 'https://github.com/octocat/demo.git' },
      },
    ],
  });
  assert.ok(text.includes('本地已有该仓库'), 'the local checkout is named');
  assert.ok(text.includes('去推送这个目录的改动'), 'and the next action is one click away');
});

test('an empty repository list explains itself', () => {
  const { text } = renderWith({ 0: STATE_CONNECTED, 14: [] });
  assert.ok(text.includes('没有可见的仓库'));
});

test('a repository error is surfaced verbatim', () => {
  const { text } = renderWith({ 0: STATE_CONNECTED, 14: [], 23: 'API rate limit exceeded' });
  assert.ok(text.includes('API rate limit exceeded'));
});

test('the details view renders branches, commits and the clone block', () => {
  const { text } = renderWith({ 0: STATE_CONNECTED, 25: 'octocat/demo', 26: DETAIL });
  assert.ok(text.includes('← 返回列表'));
  assert.ok(text.includes('克隆到工作区'));
  assert.ok(text.includes('main'));
  assert.ok(text.includes('init'));
  assert.ok(text.includes('MIT'));
  assert.ok(text.includes('C:\\work\\demo-project'), 'workspace picker shows the workspace path');
});

test('a finished clone reports the destination path', () => {
  const { text } = renderWith({
    0: STATE_CONNECTED,
    25: 'octocat/demo',
    26: DETAIL,
    32: { ok: true, path: 'C:\\work\\demo-project\\demo' },
  });
  assert.ok(text.includes('已克隆到 C:\\work\\demo-project\\demo'));
});

test('a failed clone reports the error and hint', () => {
  const { text } = renderWith({
    0: STATE_CONNECTED,
    25: 'octocat/demo',
    26: DETAIL,
    32: { ok: false, error: '目标已存在：x', hint: '换一个本地目录名' },
  });
  assert.ok(text.includes('目标已存在：x'));
  assert.ok(text.includes('换一个本地目录名'));
});

test('a workspace-less profile tells the user to open a directory', () => {
  const { text } = renderWith({
    0: Object.assign({}, STATE_CONNECTED, { workspaces: [] }),
    25: 'octocat/demo',
    26: DETAIL,
  });
  assert.ok(text.includes('没有可用的工作区'));
});

// ── teardown ───────────────────────────────────────────────────────────────

delete globalThis.window;
delete globalThis.document;

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.error(`\n✗ ${failure.title}\n${failure.error && failure.error.stack}`);
  process.exit(1);
}
