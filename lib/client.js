/**
 * dsh-plugin-github-link — browser half.
 *
 * Hand-written DSH client module: no bundler step, no build, no npm imports
 * beyond the modules the client loader already provides (`react`). The file is
 * a classic script that registers itself with `window.__ModuleLoader__.load`,
 * exactly like the shipped/community plugins do.
 *
 * The UI is one Settings page ("GitHub 仓库") registered into the
 * `settings.section` slot — reached through 设置 → GitHub 仓库:
 *   disconnected → OAuth App setup, then Device Flow (or a pasted PAT)
 *   connected    → repository list with search + visibility/sort, a details
 *                  view (branches, recent commits), `git clone` into a
 *                  registered workspace, and upload/update to GitHub
 *
 * Every host call goes through `requestJson`, which turns a non-2xx JSON body
 * into an Error carrying `status`, `code`, `reconnect` and `hint`.
 */

window.__ModuleLoader__.load({
	id: "dsh-plugin-github-link",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;
		const BASE = "/github-link";

		const CSS = `
.ghl-root { display:flex; flex-direction:column; gap:12px; font-size:13px; color: var(--dsw-alias-label-primary); }
.ghl-root * { box-sizing: border-box; }
.ghl-card { border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background: var(--dsw-alias-bg-layer-1); padding:14px; }
.ghl-card + .ghl-card { margin-top:12px; }
.ghl-h { font-size:14px; font-weight:600; margin:0 0 8px; }
.ghl-sub { color: var(--dsw-alias-label-secondary); font-size:12px; line-height:1.65; }
.ghl-row { display:flex; align-items:center; gap:8px; }
.ghl-wrap { flex-wrap: wrap; }
.ghl-grow { flex:1; min-width:0; }
.ghl-btn { appearance:none; border:1px solid var(--dsw-alias-border-l2); background:transparent; color:inherit; border-radius:8px; padding:6px 12px; font-size:12px; line-height:1.4; cursor:pointer; font-family:inherit; text-decoration:none; display:inline-flex; align-items:center; white-space:nowrap; }
.ghl-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
.ghl-btn:disabled { opacity:.45; cursor:default; }
.ghl-btn-primary { color: var(--dsw-alias-brand-primary); border-color: currentColor; font-weight:600; }
.ghl-btn-danger { color: var(--dsw-alias-state-error-primary); }
.ghl-input { border:1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); color:inherit; border-radius:8px; padding:6px 10px; font-size:12px; font-family:inherit; min-width:0; }
.ghl-input:focus { outline:none; border-color: var(--dsw-alias-brand-primary); }
/* The native dropdown popup is painted by the browser with a default (white)
   background, while the option text inherits our theme colour — which is how
   you end up with white-on-white options that only become readable on hover.
   Setting both properties on the options is the only reliable fix. */
.ghl-input option { background-color: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.ghl-code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:20px; letter-spacing:2px; font-weight:600; }
.ghl-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:11px; }
.ghl-badge { border:1px solid var(--dsw-alias-border-l1); border-radius:999px; padding:1px 8px; font-size:11px; color: var(--dsw-alias-label-secondary); white-space:nowrap; }
.ghl-badge-private { color: var(--dsw-alias-state-warn-primary); }
.ghl-list { display:flex; flex-direction:column; gap:8px; }
.ghl-scroll { max-height:360px; overflow:auto; padding-right:4px; }
.ghl-repo { border:1px solid var(--dsw-alias-border-l1); border-radius:10px; padding:10px 12px; cursor:pointer; }
.ghl-repo:hover { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
.ghl-repo-name { font-weight:600; font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ghl-repo-desc { color: var(--dsw-alias-label-secondary); font-size:12px; margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ghl-meta { color: var(--dsw-alias-label-secondary); font-size:11px; display:flex; gap:12px; flex-wrap:wrap; margin-top:6px; }
.ghl-notice { border-radius:8px; padding:8px 10px; font-size:12px; border:1px solid; line-height:1.6; }
.ghl-notice-ok { color: var(--dsw-alias-state-success-primary); border-color: currentColor; }
.ghl-notice-err { color: var(--dsw-alias-state-error-primary); border-color: currentColor; word-break:break-word; }
.ghl-notice-info { color: var(--dsw-alias-label-secondary); border-color: var(--dsw-alias-border-l1); }
.ghl-empty { color: var(--dsw-alias-label-secondary); font-size:12px; padding:14px; text-align:center; }
.ghl-avatar { width:32px; height:32px; border-radius:50%; flex:0 0 auto; }
.ghl-avatar-sm { width:16px; height:16px; border-radius:50%; flex:0 0 auto; }
.ghl-steps { margin:8px 0 0; padding-left:20px; color: var(--dsw-alias-label-secondary); font-size:12px; line-height:1.9; }
.ghl-steps li { margin:0; }
.ghl-link { color: var(--dsw-alias-brand-primary); text-decoration:none; }
.ghl-link:hover { text-decoration:underline; }
.ghl-commit { display:flex; gap:8px; align-items:flex-start; padding:7px 0; border-bottom:1px solid var(--dsw-alias-border-l1); }
.ghl-commit:last-child { border-bottom:none; }
.ghl-disclosure { cursor:pointer; color: var(--dsw-alias-label-secondary); font-size:12px; user-select:none; }
.ghl-hr { border-top:1px solid var(--dsw-alias-border-l1); margin-top:12px; padding-top:10px; }
.ghl-tag { border-radius:6px; background: var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); padding:1px 6px; font-size:11px; color: var(--dsw-alias-label-secondary); }
.ghl-pager { display:flex; align-items:center; gap:8px; justify-content:flex-end; margin-top:10px; }
.ghl-guide { border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background: var(--dsw-alias-bg-layer-2); padding:10px 12px; display:flex; flex-direction:column; gap:6px; }
.ghl-step { border:1px solid var(--dsw-alias-border-l1); border-radius:999px; padding:2px 10px; font-size:11px; color: var(--dsw-alias-label-secondary); white-space:nowrap; }
.ghl-step-done { color: var(--dsw-alias-state-success-primary); border-color: currentColor; }
.ghl-step-current { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-brand-primary); font-weight:600; }
.ghl-disclosure-row { display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none; flex-wrap:wrap; }
.ghl-seg { display:flex; gap:6px; flex-wrap:wrap; }
.ghl-verdict { font-weight:600; }
.ghl-kv { display:flex; gap:8px; align-items:baseline; padding:3px 0; }
.ghl-kv-key { color: var(--dsw-alias-label-secondary); font-size:11px; flex:0 0 auto; min-width:64px; }
.ghl-help-list { margin:6px 0 0; padding-left:18px; color: var(--dsw-alias-label-secondary); font-size:12px; line-height:1.85; }
`;

		// ── tiny helpers ───────────────────────────────────────────────────────

		function errText(error) {
			return error && error.message ? String(error.message) : String(error);
		}

		function formatDate(iso) {
			if (!iso) return "";
			const date = new Date(iso);
			if (Number.isNaN(date.getTime())) return "";
			const pad = (n) => (n < 10 ? "0" + n : String(n));
			return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
				" " + pad(date.getHours()) + ":" + pad(date.getMinutes());
		}

		function formatSize(kb) {
			const value = Number(kb) || 0;
			if (value < 1024) return value + " KB";
			return (value / 1024).toFixed(1) + " MB";
		}

		function formatBytes(bytes) {
			const value = Number(bytes) || 0;
			if (value < 1024) return value + " B";
			if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
			return (value / 1024 / 1024).toFixed(1) + " MB";
		}

		/** A GitHub-legal repository name derived from a directory name. */
		function repoSlug(name) {
			return String(name || "")
				.trim()
				.toLowerCase()
				.replace(/[^a-z0-9._-]+/g, "-")
				.replace(/^[-.]+|[-.]+$/g, "")
				.slice(0, 100);
		}

		function baseName(path) {
			const parts = String(path || "").split(/[\\/]+/).filter(Boolean);
			return parts.length ? parts[parts.length - 1] : "";
		}

		/** `https://github.com/owner/name.git` → `owner/name`. */
		function parseRemoteFull(remote) {
			const match = /github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(String(remote || ""));
			return match ? match[1] + "/" + match[2] : "";
		}

		function mmss(ms) {
			const total = Math.max(0, Math.round(Number(ms) / 1000));
			const minutes = Math.floor(total / 60);
			const seconds = total % 60;
			return minutes + ":" + (seconds < 10 ? "0" + seconds : String(seconds));
		}

		function joinPath(dir, name) {
			const base = String(dir || "").replace(/[\\/]+$/, "");
			const separator = base.indexOf("\\") >= 0 ? "\\" : "/";
			return base + separator + name;
		}

		async function requestJson(path, options) {
			const init = options || {};
			let response;
			try {
				response = await fetch(BASE + path, {
					method: init.method || "GET",
					headers: init.body === undefined ? undefined : { "content-type": "application/json" },
					body: init.body === undefined ? undefined : JSON.stringify(init.body),
				});
			} catch (error) {
				throw new Error("无法连接插件后端：" + errText(error));
			}
			let data;
			try {
				data = await response.json();
			} catch {
				data = undefined;
			}
			if (!response.ok) {
				const error = new Error((data && (data.error || data.message)) || "HTTP " + response.status);
				error.status = response.status;
				error.code = (data && data.code) || "";
				error.reconnect = !!(data && data.reconnect);
				error.hint = (data && data.hint) || "";
				error.data = data;
				throw error;
			}
			return data;
		}

		const api = {
			state: () => requestJson("/state"),
			saveClientId: (clientId) => requestJson("/config", { method: "POST", body: { clientId } }),
			saveProxy: (url) => requestJson("/proxy", { method: "POST", body: { url } }),
			testProxy: (url) => requestJson("/proxy/test", { method: "POST", body: { url } }),
			startDevice: () => requestJson("/device/start", { method: "POST", body: {} }),
			pollDevice: (flowId) => requestJson("/device/poll?flowId=" + encodeURIComponent(flowId)),
			saveToken: (token) => requestJson("/token", { method: "POST", body: { token } }),
			logout: () => requestJson("/logout", { method: "POST", body: {} }),
			repos: (params) => requestJson("/repos?" + new URLSearchParams(params).toString()),
			repo: (full) => requestJson("/repo?full=" + encodeURIComponent(full)),
			clone: (payload) => requestJson("/clone", { method: "POST", body: payload }),
			local: () => requestJson("/local"),
			localDirs: (workspaceId, subdir) =>
				requestJson(
					"/local/dirs?workspaceId=" +
						encodeURIComponent(workspaceId || "") +
						"&subdir=" +
						encodeURIComponent(subdir || ""),
				),
			publishPlan: (payload) => requestJson("/publish/plan", { method: "POST", body: payload }),
			publishApply: (payload) => requestJson("/publish/apply", { method: "POST", body: payload }),
			pull: (payload) => requestJson("/publish/pull", { method: "POST", body: payload }),
		};

		function copyText(text) {
			try {
				if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(text);
				}
			} catch {
				/* clipboard is best effort */
			}
		}

		// ── stylesheet ─────────────────────────────────────────────────────────
		//
		// Rendered as a React element inside the slot instead of being appended to
		// <head>: the plugin then writes no DOM of its own, and React removes the
		// sheet when the page unmounts. Every colour is a `--dsw-alias-*` theme
		// token (the guidance's lowest-risk styling dependency); a renamed token
		// degrades appearance but never breaks rendering.
		function Styles() {
			return h("style", { dangerouslySetInnerHTML: { __html: CSS } });
		}

		// ── crash containment ──────────────────────────────────────────────────
		//
		// A throwing component blanks its slot entry, so the page is wrapped in an
		// error boundary: a bug in one render path shows one message instead of
		// taking the Settings surface down with it.
		class GitHubErrorBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}

			static getDerivedStateFromError(error) {
				return { error };
			}

			componentDidCatch(error) {
				try {
					console.error("[github-link] settings page crashed", error);
				} catch {
					/* logging must never throw */
				}
			}

			render() {
				if (this.state && this.state.error) {
					return h(
						"div",
						{ className: "ghl-root" },
						h(Styles, null),
						h(
							"div",
							{ className: "ghl-notice ghl-notice-err" },
							"GitHub 插件界面出错：" + errText(this.state.error),
						),
					);
				}
				return this.props.children;
			}
		}

		// ── presentational atoms ───────────────────────────────────────────────

		function Card(props) {
			return h("div", { className: "ghl-card" }, props.children);
		}

		function Notice(props) {
			const notice = props.notice;
			if (!notice || !notice.text) return null;
			return h("div", { className: "ghl-notice ghl-notice-" + (notice.kind || "info") }, notice.text);
		}

		// ── the page ───────────────────────────────────────────────────────────

		function GitHubSection() {
			const [state, setState] = React.useState(null);
			const [stateError, setStateError] = React.useState("");
			const [notice, setNotice] = React.useState(null);

			const [clientIdDraft, setClientIdDraft] = React.useState("");
			const [savingClientId, setSavingClientId] = React.useState(false);
			const [proxyDraft, setProxyDraft] = React.useState("");
			const [savingProxy, setSavingProxy] = React.useState(false);
			const [testingProxy, setTestingProxy] = React.useState(false);
			const [proxyTest, setProxyTest] = React.useState(null);
			const [flow, setFlow] = React.useState(null);
			const [flowBusy, setFlowBusy] = React.useState(false);
			const [patOpen, setPatOpen] = React.useState(false);
			const [patValue, setPatValue] = React.useState("");
			const [patBusy, setPatBusy] = React.useState(false);

			const [repos, setRepos] = React.useState([]);
			const [repoQuery, setRepoQuery] = React.useState("");
			const [query, setQuery] = React.useState("");
			const [visibility, setVisibility] = React.useState("all");
			const [sort, setSort] = React.useState("updated");
			const [page, setPage] = React.useState(1);
			const [repoTotal, setRepoTotal] = React.useState(0);
			const [hasMore, setHasMore] = React.useState(false);
			const [reposBusy, setReposBusy] = React.useState(false);
			const [reposError, setReposError] = React.useState("");
			const [reload, setReload] = React.useState(0);

			const [selected, setSelected] = React.useState("");
			const [detail, setDetail] = React.useState(null);
			const [detailBusy, setDetailBusy] = React.useState(false);
			const [detailError, setDetailError] = React.useState("");

			const [cloneWorkspace, setCloneWorkspace] = React.useState("");
			const [cloneName, setCloneName] = React.useState("");
			const [cloneBusy, setCloneBusy] = React.useState(false);
			const [cloneResult, setCloneResult] = React.useState(null);

			// ── upload / update (appended last on purpose: the headless client
			// test indexes useState calls positionally, so new hooks go at the end)
			const [locals, setLocals] = React.useState(null);
			const [localsBusy, setLocalsBusy] = React.useState(false);
			const [localsError, setLocalsError] = React.useState("");
			const [publishWorkspace, setPublishWorkspace] = React.useState("");
			const [publishKind, setPublishKind] = React.useState("update");
			const [publishNew, setPublishNew] = React.useState(false);
			const [publishRepoName, setPublishRepoName] = React.useState("");
			const [publishPrivate, setPublishPrivate] = React.useState(true);
			const [publishDescription, setPublishDescription] = React.useState("");
			const [publishBranch, setPublishBranch] = React.useState("main");
			const [publishMessage, setPublishMessage] = React.useState("更新自 DSH");
			const [publishGitignore, setPublishGitignore] = React.useState(false);
			const [publishPlan, setPublishPlan] = React.useState(null);
			const [publishConfirm, setPublishConfirm] = React.useState(false);
			const [publishBusy, setPublishBusy] = React.useState(false);
			const [publishResult, setPublishResult] = React.useState(null);
			const [proxyOpen, setProxyOpen] = React.useState(false);
			const [publishOpen, setPublishOpen] = React.useState(false);
			const [helpOpen, setHelpOpen] = React.useState(false);
			const [clock, setClock] = React.useState(0);
			const [publishTarget, setPublishTarget] = React.useState("");
			const [prefilledFor, setPrefilledFor] = React.useState("");
			const [publishSubdir, setPublishSubdir] = React.useState("");
			const [publishDirs, setPublishDirs] = React.useState([]);
			const [dirsBusy, setDirsBusy] = React.useState(false);
			const [dirsError, setDirsError] = React.useState("");
			const [publishRemotePath, setPublishRemotePath] = React.useState("");
			const [pullBusy, setPullBusy] = React.useState(false);
			const [pullHint, setPullHint] = React.useState(null);
			const [publishAdvanced, setPublishAdvanced] = React.useState(false);

			const loadState = React.useCallback(async () => {
				try {
					const next = await api.state();
					setState(next);
					setStateError("");
					setClientIdDraft((current) => (current ? current : next.clientId || ""));
					setProxyDraft((current) => (current ? current : (next.proxy && next.proxy.stored) || ""));
					setCloneWorkspace((current) => {
						if (current) return current;
						const first = next.workspaces && next.workspaces[0];
						return first ? first.id : "";
					});
				} catch (error) {
					setStateError(errText(error));
				}
			}, []);

			React.useEffect(() => {
				loadState();
			}, [loadState]);

			// Device Flow polling. The host rate-limits the upstream call, so the
			// timer here only decides how often we ask our own backend.
			React.useEffect(() => {
				if (!flow || !flow.flowId) return undefined;
				let cancelled = false;
				let timer = null;
				const intervalMs = Math.max(1000, (flow.interval || 5) * 1000);
				const tick = async () => {
					try {
						const result = await api.pollDevice(flow.flowId);
						if (cancelled) return;
						if (result.status === "authorized") {
							setFlow(null);
							setNotice({ kind: "ok", text: "已连接 GitHub：" + ((result.user && result.user.login) || "") });
							await loadState();
							return;
						}
						if (result.status === "denied") {
							setFlow(null);
							setNotice({ kind: "err", text: "授权被拒绝。" });
							return;
						}
						if (result.status === "expired") {
							setFlow(null);
							setNotice({ kind: "err", text: "验证码已过期，请重新开始登录。" });
							return;
						}
						if (result.interval && result.interval !== flow.interval) {
							setFlow((current) => (current ? { ...current, interval: result.interval } : current));
						}
					} catch (error) {
						if (cancelled) return;
						setFlow(null);
						setNotice({ kind: "err", text: errText(error) });
						return;
					}
					if (!cancelled) timer = setTimeout(tick, intervalMs);
				};
				timer = setTimeout(tick, intervalMs);
				return () => {
					cancelled = true;
					if (timer) clearTimeout(timer);
				};
			}, [flow, loadState]);

			// Debounce the search box: one request per pause, not per keystroke.
			React.useEffect(() => {
				const timer = setTimeout(() => setQuery(repoQuery.trim()), 350);
				return () => clearTimeout(timer);
			}, [repoQuery]);

			React.useEffect(() => {
				setPage(1);
			}, [query, visibility, sort]);

			const connected = !!(state && state.connected);

			React.useEffect(() => {
				if (!connected) {
					setRepos([]);
					setHasMore(false);
					return undefined;
				}
				let cancelled = false;
				setReposBusy(true);
				setReposError("");
				api.repos({ page, per_page: 30, q: query, visibility, sort })
					.then((result) => {
						if (cancelled) return;
						setRepos(Array.isArray(result.repos) ? result.repos : []);
						setHasMore(!!result.hasMore);
						setRepoTotal(Number(result.total) || 0);
					})
					.catch((error) => {
						if (cancelled) return;
						setRepos([]);
						setHasMore(false);
						setReposError(noteFailure(error));
						if (error && error.reconnect) loadState();
					})
					.finally(() => {
						if (!cancelled) setReposBusy(false);
					});
				return () => {
					cancelled = true;
				};
			}, [connected, query, visibility, sort, page, reload, loadState]);

			React.useEffect(() => {
				setCloneName(selected ? selected.split("/")[1] || "" : "");
				setCloneResult(null);
			}, [selected]);

			// Local git status is only interesting once an account is connected.
			React.useEffect(() => {
				if (!connected) {
					setLocals(null);
					return undefined;
				}
				let cancelled = false;
				setLocalsBusy(true);
				setLocalsError("");
				api.local()
					.then((result) => {
						if (cancelled) return;
						const list = Array.isArray(result.workspaces) ? result.workspaces : [];
						setLocals(list);
						setPublishWorkspace((current) => {
							if (current && list.some((item) => item.id === current)) return current;
							return list.length ? list[0].id : "";
						});
					})
					.catch((error) => {
						if (!cancelled) setLocalsError(errText(error));
					})
					.finally(() => {
						if (!cancelled) setLocalsBusy(false);
					});
				return () => {
					cancelled = true;
				};
			}, [connected]);

			// The publish form follows the selected workspace: branch from the
			// checkout, mode from whether an origin already exists, and a
			// directory-derived default name for a brand-new repository. This is
			// what turns "which of these ten controls do I touch?" into "press
			// preview, then press push".
			//
			// Keyed on the workspace *id*, not on `locals`: refreshing the status
			// must not silently throw away the mode the user just picked.
			React.useEffect(() => {
				const workspace = (locals || []).filter((item) => item.id === publishWorkspace)[0] || (locals || [])[0];
				if (!workspace || prefilledFor === workspace.id) return;
				const git = workspace.git || {};
				setPrefilledFor(workspace.id);
				setPublishBranch(git.branch || "main");
				setPublishKind(git.repo && git.remote ? "update" : "upload");
				setPublishRepoName(repoSlug(workspace.title || baseName(workspace.path)));
				setPublishSubdir("");
				setPublishPlan(null);
				setPublishResult(null);
			}, [locals, publishWorkspace, prefilledFor]);

			// One level of the workspace tree at a time. The host bounds every
			// lookup to the workspace, so the picker cannot walk out of it.
			React.useEffect(() => {
				if (!connected) return undefined;
				const workspace = (locals || []).filter((item) => item.id === publishWorkspace)[0] || (locals || [])[0];
				if (!workspace) return undefined;
				let cancelled = false;
				setDirsBusy(true);
				setDirsError("");
				api.localDirs(workspace.id, publishSubdir)
					.then((result) => {
						if (cancelled) return;
						setPublishDirs(Array.isArray(result.dirs) ? result.dirs : []);
					})
					.catch((error) => {
						if (cancelled) return;
						setPublishDirs([]);
						setDirsError(errText(error));
					})
					.finally(() => {
						if (!cancelled) setDirsBusy(false);
					});
				return () => {
					cancelled = true;
				};
			}, [connected, locals, publishWorkspace, publishSubdir]);

			// A device code is only valid for 15 minutes; ticking once a second
			// while a flow is pending is what lets the UI show the countdown and
			// stop polling when it runs out.
			React.useEffect(() => {
				if (!flow || !flow.flowId) return undefined;
				const timer = setInterval(() => setClock(Date.now()), 1000);
				return () => clearInterval(timer);
			}, [flow]);

			React.useEffect(() => {
				if (!selected) {
					setDetail(null);
					return undefined;
				}
				let cancelled = false;
				setDetailBusy(true);
				setDetailError("");
				api.repo(selected)
					.then((result) => {
						if (!cancelled) setDetail(result);
					})
					.catch((error) => {
						if (cancelled) return;
						setDetail(null);
						setDetailError(errText(error));
						if (error && error.reconnect) loadState();
					})
					.finally(() => {
						if (!cancelled) setDetailBusy(false);
					});
				return () => {
					cancelled = true;
				};
			}, [selected, loadState]);

			// actions ───────────────────────────────────────────────────────────

			const doSaveClientId = async () => {
				setSavingClientId(true);
				setNotice(null);
				try {
					const result = await api.saveClientId(clientIdDraft.trim());
					setState((current) => Object.assign({}, current || {}, result));
					setNotice({ kind: "ok", text: "Client ID 已保存，可以开始登录了。" });
				} catch (error) {
					setNotice({ kind: "err", text: errText(error) });
				} finally {
					setSavingClientId(false);
				}
			};

			/**
			 * A failure that smells like a transport problem (blocked github.com,
			 * a MITM certificate, a dead proxy) is exactly when the network card
			 * must come out of hiding — that is the whole point of it being
			 * collapsed by default.
			 */
			const noteFailure = (error) => {
				const text = errText(error);
				if (/fetch failed|无法连接|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|CERT|证书|TLS|超时|连接被重置/i.test(text)) {
					setProxyOpen(true);
				}
				return text;
			};

			const doSaveProxy = async () => {
				setSavingProxy(true);
				setNotice(null);
				setProxyTest(null);
				try {
					const result = await api.saveProxy(proxyDraft.trim());
					setState((current) => Object.assign({}, current || {}, result));
					setProxyDraft((result.proxy && result.proxy.stored) || "");
					setNotice({
						kind: "ok",
						text: result.proxy && result.proxy.active
							? "代理已保存：" + result.proxy.url + "（API 与 git clone 都会走它）"
							: "已保存为直连（不使用代理）。",
					});
				} catch (error) {
					setNotice({ kind: "err", text: errText(error) });
				} finally {
					setSavingProxy(false);
				}
			};

			const doTestProxy = async () => {
				setTestingProxy(true);
				setProxyTest(null);
				try {
					const result = await api.testProxy(proxyDraft.trim());
					setProxyTest({
						ok: true,
						text: "连接成功（" + (result.via === "direct" ? "直连" : result.via) + "，" + result.elapsedMs + " ms）",
					});
				} catch (error) {
					setProxyTest({
						ok: false,
						text: errText(error) + (proxyDraft.trim() ? "" : "（当前是直连，没有用代理）"),
					});
				} finally {
					setTestingProxy(false);
				}
			};

			const doStartDevice = async () => {
				setFlowBusy(true);
				setNotice(null);
				try {
					const result = await api.startDevice();
					const expiresIn = result.expiresIn || 900;
					setClock(Date.now());
					setFlow({
						flowId: result.flowId,
						userCode: result.userCode,
						verificationUri: result.verificationUri,
						interval: result.interval || 5,
						expiresIn,
						deadline: Date.now() + expiresIn * 1000,
					});
				} catch (error) {
					setNotice({ kind: "err", text: noteFailure(error) });
				} finally {
					setFlowBusy(false);
				}
			};

			const doSavePat = async () => {
				setPatBusy(true);
				setNotice(null);
				try {
					const result = await api.saveToken(patValue.trim());
					setPatValue("");
					setPatOpen(false);
					setNotice({ kind: "ok", text: "Token 校验通过，已连接：" + ((result.user && result.user.login) || "") });
					await loadState();
				} catch (error) {
					setNotice({ kind: "err", text: noteFailure(error) });
				} finally {
					setPatBusy(false);
				}
			};

			const doLogout = async () => {
				setFlow(null);
				setSelected("");
				setDetail(null);
				setRepos([]);
				try {
					await api.logout();
					setNotice({ kind: "info", text: "已断开 GitHub 账号，本机凭据已删除。" });
				} catch (error) {
					setNotice({ kind: "err", text: errText(error) });
				}
				await loadState();
			};

			const doClone = async () => {
				if (!selected || !cloneName.trim()) return;
				setCloneBusy(true);
				setCloneResult(null);
				try {
					const result = await api.clone({
						full: selected,
						workspaceId: cloneWorkspace,
						name: cloneName.trim(),
					});
					setCloneResult(result);
					// A fresh clone is a new local repository: refresh the workspace
					// status so it can immediately be used by 上传 / 更新.
					doRefreshLocals();
				} catch (error) {
					setCloneResult({
						ok: false,
						error: errText(error),
						hint: error && error.hint ? error.hint : "",
					});
				} finally {
					setCloneBusy(false);
				}
			};

			// upload / update ────────────────────────────────────────────────────

			const publishTargetFull = () => (publishKind === "update" ? "" : publishTarget || selected || "");

			/** Default repository-side path for the folder upload: the folder's own name. */
			const defaultRemotePath = () => {
				const workspace = (locals || []).filter((item) => item.id === publishWorkspace)[0] || (locals || [])[0];
				const leaf = publishSubdir ? publishSubdir.split("/").pop() : workspace ? baseName(workspace.path) : "";
				return repoSlug(leaf);
			};

			const effectiveRemotePath = () => publishRemotePath.trim() || defaultRemotePath();

			const publishPayload = () => {
				const workspace = (locals || []).filter((item) => item.id === publishWorkspace)[0] || (locals || [])[0];
				return {
					workspaceId: workspace ? workspace.id : "",
					subdir: publishSubdir,
					kind: publishKind,
					create: publishKind === "upload" && publishNew ? "new" : "",
					repoName: publishRepoName.trim(),
					// "update" pushes the workspace's own origin; the other two modes
					// need an explicit target repository.
					full: publishTargetFull(),
					remotePath: publishKind === "remote-dir" ? effectiveRemotePath() : "",
					branch: publishBranch.trim() || (publishKind === "remote-dir" ? "" : "main"),
					message: publishMessage.trim(),
					private: publishPrivate,
					description: publishDescription.trim(),
					addGitignore: publishKind === "upload" ? publishGitignore : false,
				};
			};

			const publishNeedsTarget = () => {
				if (publishKind === "update") return false;
				if (publishKind === "upload" && publishNew) return false;
				return !publishTargetFull();
			};

			const publishNeedsRemotePath = () => publishKind === "remote-dir" && !effectiveRemotePath();

			const describePublishTarget = () => {
				const workspace = (locals || []).filter((item) => item.id === publishWorkspace)[0] || (locals || [])[0];
				if (publishKind === "remote-dir") {
					const full = publishTargetFull();
					return full ? "写入 " + full + "/" + (effectiveRemotePath() || "…") : "还没选目标仓库";
				}
				if (publishNew) {
					const login = (state && state.user && state.user.login) || "";
					return "新建仓库 " + (login ? login + "/" : "") + (publishRepoName.trim() || "…");
				}
				if (publishKind === "upload") {
					const full = publishTargetFull();
					return full ? full : "还没选目标仓库";
				}
				const remote = workspace && workspace.git ? workspace.git.remote : "";
				return remote || "当前没有 remote";
			};

			/**
			 * Pull the remote branch into the selected workspace.
			 *   ff    fast-forward only (the strictly-behind case)
			 *   onto  keep the working tree, rebuild the branch on the remote tip
			 *         — the answer when local and remote have both moved on
			 */
			const doPull = async (mode, commitDirty) => {
				const workspace = (locals || []).filter((item) => item.id === publishWorkspace)[0] || (locals || [])[0];
				if (!workspace) return;
				setPullBusy(true);
				setPullHint(null);
				setPublishResult(null);
				try {
					const result = await api.pull({
						workspaceId: workspace.id,
						subdir: publishSubdir,
						mode,
						commitDirty: !!commitDirty,
						message: publishMessage.trim(),
					});
					setPullHint({
						ok: true,
						text: result.upToDate
							? "远端没有新提交，已是最新。"
							: (result.onto ? "已把本地内容叠加到远端最新之上" : "已快进到远端最新") +
								`（拉入 ${result.pulled || 0} 个提交，现在 HEAD=${result.head || "-"}）` +
								(result.onto ? "；现在可以点「② 推送更新」了。" : ""),
					});
					setPublishPlan(null);
					await doRefreshLocals();
				} catch (error) {
					const data = error && error.data ? error.data : {};
					setPullHint({
						ok: false,
						text: errText(error) + (data.hint ? " " + data.hint : ""),
						notFastForward: data.code === "not_fast_forward",
						commitFirst: data.code === "dirty",
					});
				} finally {
					setPullBusy(false);
				}
			};

			const doPlanPublish = async () => {
				setPublishBusy(true);
				setPublishResult(null);
				try {
					const plan = await api.publishPlan(publishPayload());
					setPublishPlan(plan);
					setPublishConfirm(false);
				} catch (error) {
					setPublishPlan(null);
					setPublishResult({ ok: false, error: errText(error) });
				} finally {
					setPublishBusy(false);
				}
			};

			const doApplyPublish = async () => {
				setPublishBusy(true);
				setPublishResult(null);
				try {
					const result = await api.publishApply(Object.assign(publishPayload(), { confirmRisky: publishConfirm }));
					const where = result.kind === "remote-dir" ? `到 ${result.full}/${result.remotePath} ` : "";
					setPublishResult({
						ok: true,
						text:
							(result.created ? "已新建仓库 " + result.full + "；" : "") +
							(result.committed ? `已提交 ${result.commit || ""} ${where}；`.replace("  ", " ") : "没有新提交；") +
							(result.pushed ? "已推送 " + result.branch : "远端已是最新"),
						data: result,
					});
					setPublishPlan(null);
					doRefreshLocals();
				} catch (error) {
					const data = error && error.data ? error.data : {};
					if (data.plan) setPublishPlan(data.plan);
					if (data.scan) setPublishPlan((current) => Object.assign({}, current || {}, { scan: data.scan }));
					setPublishResult({
						ok: false,
						text: errText(error) + (data.hint ? " " + data.hint : ""),
						needConfirm: !!data.needConfirm,
					});
				} finally {
					setPublishBusy(false);
				}
			};

			const doRefreshLocals = async () => {				setLocalsBusy(true);
				try {
					const result = await api.local();
					setLocals(Array.isArray(result.workspaces) ? result.workspaces : []);
					setLocalsError("");
				} catch (error) {
					setLocalsError(errText(error));
				} finally {
					setLocalsBusy(false);
				}
			};

			// render helpers ─────────────────────────────────────────────────────

			const renderHeader = () => {
				const user = state && state.user;
				return h(
					"div",
					{ className: "ghl-row ghl-wrap" },
					h(
						"div",
						{ className: "ghl-grow" },
						h("div", { className: "ghl-h" }, "GitHub 仓库"),
						h(
							"div",
							{ className: "ghl-sub" },
							"浏览仓库（含私有）· 克隆到工作区 · 把本地代码上传或更新到 GitHub",
						),
					),
					connected && user
						? h(
								"div",
								{ className: "ghl-row" },
								user.avatarUrl ? h("img", { className: "ghl-avatar", src: user.avatarUrl, alt: "" }) : null,
								h(
									"div",
									null,
									h("div", { className: "ghl-repo-name" }, user.name || user.login),
									h(
										"div",
										{ className: "ghl-sub ghl-mono" },
										"@" + user.login + (state.tokenKind ? " · " + state.tokenKind : ""),
									),
								),
								h("button", { className: "ghl-btn ghl-btn-danger", onClick: doLogout, type: "button" }, "断开"),
							)
						: null,
				);
			};

			/**
			 * One compact row that answers "am I connected, over what network, and
			 * how many workspaces can I publish from" without reading any prose.
			 */
			const renderStatus = () => {
				const user = state && state.user;
				const proxy = (state && state.proxy) || {};
				const tls = (state && state.tls) || {};
				const chips = [];
				// The header already shows the avatar and @login when connected, so
				// the row only adds what the header cannot: network + workspace count.
				if (!connected) {
					chips.push(state && state.clientIdSource && state.clientIdSource !== "none" ? "未连接" : "未配置");
				}
				chips.push(proxy.active ? "代理 " + proxy.url : "网络 直连");
				if (tls.systemCa === "applied") chips.push("系统证书库");
				if (connected) chips.push("工作区 " + (locals || []).length);
				return h(
					"div",
					{ className: "ghl-row ghl-wrap" },
					chips.map((text) => h("span", { key: text, className: "ghl-badge" }, text)),
				);
			};

			// Proxy settings, collapsed by default: this is a repair tool, not
			// daily furniture. It opens itself when a request fails in a way that
			// smells like the network (see `noteFailure`), which is the only
			// moment the user actually needs it.
			const renderProxy = () => {
				const info = (state && state.proxy) || {};
				const sourceLabel =
					info.source === "config" ? "启动配置" : info.source === "stored" ? "设置页" : info.source === "env" ? "环境变量" : "";
				const summary = info.active
					? "走代理 " + info.url + (sourceLabel ? "（" + sourceLabel + "）" : "")
					: info.disabled
						? "已显式关闭代理"
						: "直连";
				return h(
					Card,
					null,
					h(
						"div",
						{ className: "ghl-disclosure-row", onClick: () => setProxyOpen(!proxyOpen) },
						h("span", { className: "ghl-disclosure" }, (proxyOpen ? "▾ " : "▸ ") + "网络代理"),
						h("span", { className: "ghl-badge" }, info.active ? "已启用" : "未启用"),
						h("span", { className: "ghl-sub ghl-grow" }, "当前：" + summary),
					),
					state && state.tls && state.tls.systemCa === "applied"
						? h(
								"div",
								{ className: "ghl-sub", style: { marginTop: "6px" } },
								"已自动改用 Windows 系统证书库（检测到 HTTPS 中间人证书，这就是之前 fetch failed 的原因）。",
							)
						: null,
					proxyOpen
						? h(
								"div",
								{ style: { marginTop: "8px" } },
								h(
									"div",
									{ className: "ghl-sub" },
									"GitHub 连不上时先点「测试连接」：证书被中间人拦截会自动修好，确实需要代理再填地址。留空保存即恢复直连；Clash 的 HTTP 端口通常是 127.0.0.1:7890。",
								),
								info.source === "config"
									? h(
											"div",
											{ className: "ghl-sub" },
											"启动配置（cordis.patch.yml）预置了 " + (info.configOverride || "-") + "，它优先于这里和环境变量。",
										)
									: info.source === "env"
										? h(
												"div",
												{ className: "ghl-sub" },
												"当前来自环境变量 " + (info.envVar || "-") + "；在下面保存一个值即以设置页为准。",
											)
										: null,
								h(
									"div",
									{ className: "ghl-row", style: { marginTop: "8px" } },
									h("input", {
										className: "ghl-input ghl-grow",
										placeholder: "http://127.0.0.1:7890",
										"aria-label": "代理地址",
										value: proxyDraft,
										onChange: (event) => setProxyDraft(event.target.value),
										spellCheck: false,
									}),
									h(
										"button",
										{
											className: "ghl-btn",
											type: "button",
											disabled: testingProxy || savingProxy,
											onClick: doTestProxy,
										},
										testingProxy ? "测试中…" : "测试连接",
									),
									h(
										"button",
										{
											className: "ghl-btn ghl-btn-primary",
											type: "button",
											disabled: savingProxy || testingProxy,
											onClick: doSaveProxy,
										},
										savingProxy ? "保存中…" : "保存",
									),
								),
								info.error
									? h("div", { className: "ghl-notice ghl-notice-err", style: { marginTop: "8px" } }, info.error)
									: null,
								proxyTest
									? h(
											"div",
											{
												className: "ghl-notice " + (proxyTest.ok ? "ghl-notice-ok" : "ghl-notice-err"),
												style: { marginTop: "8px" },
											},
											proxyTest.text,
										)
									: null,
							)
						: null,
				);
			};

			/**
			 * The three steps this plugin has, always visible at the top: it
			 * answers "what is the next thing I do?" without the user having to
			 * reverse-engineer the cards below.
			 */
			const renderGuide = () => {
				const hasClientId = !!(state && state.clientIdSource !== "none");
				const steps = [
					{ id: "client", label: "配置 Client ID", done: hasClientId },
					{ id: "connect", label: "连接 GitHub", done: connected },
					{ id: "use", label: "推送 / 克隆", done: connected },
				];
				const current = steps.filter((step) => !step.done)[0];
				const hint = !hasClientId
					? "下一步：在 GitHub 建一个勾选 Enable Device Flow 的 OAuth App，把 Client ID 粘到下面。"
					: !connected
						? "下一步：点「用 GitHub 设备码登录」，在浏览器里输入验证码。"
						: "已就绪：下面可以浏览/克隆仓库，也可以在「上传与更新」里提交并推送本地改动。";
				return h(
					"div",
					{ className: "ghl-guide" },
					h(
						"div",
						{ className: "ghl-row ghl-wrap" },
						steps.map((step, index) =>
							h(
								"span",
								{
									key: step.id,
									className:
										"ghl-step" +
										(step.done ? " ghl-step-done" : current && current.id === step.id ? " ghl-step-current" : ""),
								},
								(step.done ? "✓ " : index + 1 + ". ") + step.label,
							),
						),
					),
					h("div", { className: "ghl-sub" }, hint),
				);
			};

			const renderHelp = () =>
				h(
					Card,
					null,
					h(
						"div",
						{ className: "ghl-disclosure-row", onClick: () => setHelpOpen(!helpOpen) },
						h("span", { className: "ghl-disclosure" }, (helpOpen ? "▾ " : "▸ ") + "说明与安全"),
						h("span", { className: "ghl-sub ghl-grow" }, "权限范围、凭据位置、推送规则"),
					),
					helpOpen
						? h(
								"ul",
								{ className: "ghl-help-list" },
								h("li", null, "权限 repo read:user —— repo 是能读私有仓库的最小 scope。"),
								h("li", null, "Token 只保存在主机（~/.dsh-github-link/credentials.json），浏览器拿不到。"),
								h("li", null, "克隆不会把 token 写进 .git/config。"),
								h("li", null, "推送只做快进，不强制覆盖；拉取有「仅快进」和「叠加」两种。"),
								h("li", null, "上传前扫描 .env / *.pem / node_modules 等并要求确认；>50MB 警告，>200MB 拒绝。"),
								h("li", null, "设备码 15 分钟有效；授权期间别重启 DSH。"),
							)
						: null,
				);			// Upload / update. Deliberately previews before writing: the plan shows
			// what would be committed, what is large, and which paths look like
			// secrets — and the risky ones need an explicit confirmation.
			const renderPlan = (plan) => {
				if (!plan) return null;
				const scan = plan.scan || {};
				return h(
					"div",
					{ className: "ghl-hr" },
					h("div", { className: "ghl-h" }, "预览"),
					plan.dir ? h("div", { className: "ghl-sub ghl-mono" }, "目录：" + plan.dir) : null,
					h(
						"div",
						{ className: "ghl-sub ghl-verdict" },
						plan.blockers && plan.blockers.length ? "⛔ 先解决下面的问题再执行" : "✅ 检查通过，可以执行",
					),
					h(
						"div",
						{ className: "ghl-sub" },
						plan.kind === "remote-dir"
							? "目标 " +
									plan.full +
									"/" +
									plan.remotePath +
									" @ " +
									(plan.branch || "-") +
									(plan.remoteExists
										? " · 远端该路径已有 " + plan.existing + " 个条目（同名文件会被覆盖）"
										: " · 远端该路径还不存在（会新建）") +
									(scan.files ? " · 本地 " + scan.files + " 个文件 / " + formatBytes(scan.bytes) : "")
							: (plan.repo ? "分支 " + (plan.branch || "-") : "还不是 git 仓库（会上传时初始化）") +
									" · 待提交 " +
									(plan.changed || 0) +
									" 个文件" +
									(scan.files ? " · 目录共 " + scan.files + " 个文件 / " + formatBytes(scan.bytes) : "") +
									(plan.ahead ? " · 领先远端 " + plan.ahead : "") +
									(plan.behind ? " · 落后远端 " + plan.behind : ""),
					),
					(plan.warnings || []).map((warning) =>
						h("div", { key: warning.code, className: "ghl-notice ghl-notice-info", style: { marginTop: "6px" } }, warning.text),
					),
					(plan.blockers || []).map((blocker) =>
						h("div", { key: blocker.code, className: "ghl-notice ghl-notice-err", style: { marginTop: "6px" } }, blocker.text),
					),
					scan.risky && scan.risky.length
						? h(
								"div",
								{ style: { marginTop: "8px" } },
								h("div", { className: "ghl-sub" }, "以下路径可能包含密钥或依赖目录，上传前请确认："),
								h(
									"div",
									{ className: "ghl-row ghl-wrap" },
									scan.risky.slice(0, 8).map((entry) =>
										h("span", { key: entry.path, className: "ghl-tag" }, entry.path),
									),
								),
								h(
									"label",
									{ className: "ghl-row ghl-sub" },
									h("input", {
										type: "checkbox",
										checked: publishConfirm,
										onChange: (event) => setPublishConfirm(event.target.checked),
									}),
									"我确认这些路径可以上传到 GitHub",
								),
							)
						: null,
				);
			};

			const renderPublish = () => {
				const list = locals || [];
				const workspace = list.filter((item) => item.id === publishWorkspace)[0] || list[0];
				const git = (workspace && workspace.git) || {};
				const stateText = !workspace
					? "没有可用的工作区"
					: git.repo
						? (git.branch || "-") +
							(git.dirty ? " · " + git.changed + " 个文件有改动" : " · 干净") +
							(git.ahead ? " · 领先 " + git.ahead : "") +
							(git.behind ? " · 落后 " + git.behind : "") +
							(git.remote ? "" : " · 无 remote")
						: "非 git 仓库（上传时自动 init）";
				const modeLabel =
					publishKind === "remote-dir"
						? "写入子目录"
						: publishNew
							? "新建仓库"
							: publishKind === "upload"
								? "首次上传"
								: "推送更新";
				// "Nothing to do" is a state, not an error: say it and disable the actions.
				const publishIdle = () =>
					publishKind === "update" && !!git.repo && !git.dirty && !git.ahead && !(git.behind > 0) && !publishNew;
				return h(
					Card,
					null,
					h(
						"div",
						{ className: "ghl-disclosure-row", onClick: () => setPublishOpen(!publishOpen) },
						h("span", { className: "ghl-disclosure" }, (publishOpen ? "▾ " : "▸ ") + "上传与更新"),
						h("span", { className: "ghl-badge" }, modeLabel),
						h(
							"span",
							{ className: "ghl-sub ghl-grow" },
							(workspace ? (workspace.title || baseName(workspace.path)) + " · " : "") + stateText,
						),
					),
					publishOpen
						? h(
								"div",
								{ style: { marginTop: "8px" } },
								localsError ? h("div", { className: "ghl-notice ghl-notice-err" }, localsError) : null,
								h(
									"div",
									{ className: "ghl-row ghl-wrap" },
									h(
										"select",
										{
											className: "ghl-input ghl-grow",
											"aria-label": "工作区",
											value: workspace ? workspace.id : "",
											onChange: (event) => setPublishWorkspace(event.target.value),
										},
										list.map((item) =>
											h(
												"option",
												{ key: item.id, value: item.id },
												(item.title || item.path) +
													" — " +
													item.path +
													(item.git && item.git.repo
														? "  [" + (item.git.branch || "-") + (item.git.dirty ? ", 有改动" : ", 干净") + "]"
														: "  [非 git 仓库]"),
											),
										),
									),
									h(
										"button",
										{ className: "ghl-btn", type: "button", disabled: localsBusy, onClick: doRefreshLocals },
										localsBusy ? "刷新中…" : "刷新状态",
									),
								),
								// A registered workspace is often a container of projects, so
								// the folder to upload has to be selectable — one level at a
								// time, and never outside the workspace.
								h(
									"div",
									{ className: "ghl-row ghl-wrap", style: { marginTop: "6px" } },
									h("span", { className: "ghl-sub" }, "上传目录："),
									h(
										"span",
										{ className: "ghl-sub ghl-mono ghl-grow" },
										(workspace ? workspace.path : "") +
											(publishSubdir ? "\\" + publishSubdir.split("/").join("\\") : ""),
									),
									publishSubdir
										? h(
												"button",
												{
													className: "ghl-btn",
													type: "button",
													onClick: () => {
														setPublishSubdir(publishSubdir.split("/").slice(0, -1).join("/"));
														setPublishPlan(null);
														setPublishResult(null);
													},
												},
												"⬆ 上一层",
											)
										: null,
									// Only offer the picker when there is actually something to
									// descend into — an empty, disabled dropdown is just noise.
									dirsBusy || publishDirs.length
										? h(
												"select",
												{
													className: "ghl-input",
													style: { flex: "0 0 190px" },
													"aria-label": "选择子文件夹",
													value: "",
													disabled: dirsBusy,
													onChange: (event) => {
														if (!event.target.value) return;
														setPublishSubdir(
															publishSubdir ? publishSubdir + "/" + event.target.value : event.target.value,
														);
														setPublishPlan(null);
														setPublishResult(null);
													},
												},
												h("option", { value: "" }, dirsBusy ? "读取中…" : "进入子文件夹…"),
												publishDirs.map((name) => h("option", { key: name, value: name }, name + "/")),
											)
										: null,
								),
								dirsError ? h("div", { className: "ghl-sub" }, "无法读取子文件夹：" + dirsError) : null,
								// Diverged or behind: the push will be refused, so offer the
								// two safe ways to catch up right here.
								git.repo && git.behind > 0
									? h(
											"div",
											{ style: { marginTop: "6px" } },
											h(
												"div",
												{ className: "ghl-notice ghl-notice-info" },
												"⚠ 本地落后远端 " +
													git.behind +
													" 个提交" +
													(git.ahead ? "、领先 " + git.ahead + " 个（已分叉）" : "") +
													"：直接推送会被拒绝。",
											),
											h(
												"div",
												{ className: "ghl-row ghl-wrap", style: { marginTop: "6px" } },
												h(
													"button",
													{
														className: "ghl-btn",
														type: "button",
														disabled: pullBusy,
														onClick: () => doPull("ff"),
													},
													pullBusy ? "拉取中…" : "⬇ 拉取远端更新（仅快进）",
												),
												h(
													"button",
													{
														className: "ghl-btn",
														type: "button",
														disabled: pullBusy,
														onClick: () => doPull("onto"),
													},
													"叠加到远端最新（保留本地改动）",
												),
											),
											h(
												"div",
												{ className: "ghl-sub", style: { marginTop: "4px" } },
												"本地也有提交时用「叠加」：本地文件一个都不会少，之后推送就是快进。",
											),
											pullHint
												? h(
														"div",
														null,
														h(
															"div",
															{
																className: "ghl-notice " + (pullHint.ok ? "ghl-notice-ok" : "ghl-notice-err"),
																style: { marginTop: "6px" },
															},
															pullHint.text +
																(pullHint.notFastForward ? "（点右边的「叠加到远端最新」）" : ""),
														),
														// A dirty tree is not a dead end: offer to commit the WIP
														// first (nothing is discarded) and then rebuild.
														pullHint.commitFirst
															? h(
																	"div",
																	{ className: "ghl-row ghl-wrap", style: { marginTop: "6px" } },
																	h(
																		"button",
																		{
																			className: "ghl-btn ghl-btn-primary",
																			type: "button",
																			disabled: pullBusy,
																			onClick: () => doPull("onto", true),
																		},
																		pullBusy ? "处理中…" : "先提交这些改动，再叠加",
																	),
																)
															: null,
													)
												: null,
										)
									: pullHint
										? h(
												"div",
												{
													className: "ghl-notice " + (pullHint.ok ? "ghl-notice-ok" : "ghl-notice-err"),
													style: { marginTop: "6px" },
												},
												pullHint.text,
											)
										: null,
								// Mode first, fields second: which operation you want decides
								// which of the controls below even exist.
								h(
									"div",
									{ className: "ghl-seg", style: { marginTop: "10px" } },
									h(
										"button",
										{
											className: "ghl-btn" + (publishKind === "update" ? " ghl-btn-primary" : ""),
											type: "button",
											title: "提交本地改动并推送到这个工作区自己的远端仓库（只做快进）",
											onClick: () => {
												setPublishKind("update");
												setPublishPlan(null);
												setPublishResult(null);
											},
										},
										"推送更新",
									),
									h(
										"button",
										{
											className: "ghl-btn" + (publishKind === "upload" ? " ghl-btn-primary" : ""),
											type: "button",
											title: "把这个目录整体推成一个新仓库，或推到一个已有的空仓库",
											onClick: () => {
												setPublishKind("upload");
												setPublishPlan(null);
												setPublishResult(null);
											},
										},
										"首次上传",
									),
									h(
										"button",
										{
											className: "ghl-btn" + (publishKind === "remote-dir" ? " ghl-btn-primary" : ""),
											type: "button",
											title: "只把这个文件夹写进已有仓库的某个子目录，例如 docs/site",
											onClick: () => {
												setPublishKind("remote-dir");
												setPublishRemotePath((current) => current || defaultRemotePath());
												// The target branch is the *remote* repository's, so
												// leave it empty and let the host resolve its default.
												setPublishBranch("");
												setPublishPlan(null);
												setPublishResult(null);
											},
										},
										"上传到仓库子目录",
									),
								),
								h(
									"div",
									{ className: "ghl-sub", style: { marginTop: "6px" } },
									publishKind === "upload"
										? "把这个目录整体上传成一个 GitHub 仓库。"
										: publishKind === "remote-dir"
											? "只把这个文件夹写进目标仓库的子目录（如 docs/site）：同名文件覆盖，远端其他文件不动，也绝不删除远端文件。"
											: "提交本地改动并推送到这个工作区的远端仓库，只做快进。",
								),
								publishKind === "update"
									? null
									: h(
											"div",
											null,
											publishKind === "upload"
												? h(
														"label",
														{ className: "ghl-row ghl-sub", style: { marginTop: "8px" } },
														h("input", {
															type: "checkbox",
															checked: publishNew,
															onChange: (event) => setPublishNew(event.target.checked),
														}),
														"在 GitHub 上新建仓库",
													)
												: null,
											publishKind === "upload" && publishNew
												? h(
														"div",
														{ className: "ghl-row ghl-wrap", style: { marginTop: "6px" } },
														h("input", {
															className: "ghl-input",
															style: { flex: "0 0 180px" },
															placeholder: "新仓库名",
															"aria-label": "新仓库名",
															value: publishRepoName,
															onChange: (event) => setPublishRepoName(event.target.value),
															spellCheck: false,
														}),
														h(
															"label",
															{ className: "ghl-row ghl-sub" },
															h("input", {
																type: "checkbox",
																checked: publishPrivate,
																onChange: (event) => setPublishPrivate(event.target.checked),
															}),
															"私有",
														),
														h("input", {
															className: "ghl-input ghl-grow",
															placeholder: "描述（可选）",
															"aria-label": "仓库描述",
															value: publishDescription,
															onChange: (event) => setPublishDescription(event.target.value),
															spellCheck: false,
														}),
													)
												: h(
														"div",
														null,
														h(
															"div",
															{ className: "ghl-row ghl-wrap", style: { marginTop: "6px" } },
															h(
																"select",
																{
																	className: "ghl-input ghl-grow",
																	"aria-label": "目标仓库",
																	value: publishTarget || selected || "",
																	onChange: (event) => {
																		setPublishTarget(event.target.value);
																		setPublishPlan(null);
																		setPublishResult(null);
																	},
																},
																h(
																	"option",
																	{ value: "" },
																	publishKind === "remote-dir"
																		? "选择目标仓库"
																		: "选择目标仓库（必须是空仓库）",
																),
																(repos || []).map((repo) =>
																	h(
																		"option",
																		{ key: repo.fullName, value: repo.fullName },
																		repo.fullName + (repo.private ? "（私有）" : ""),
																	),
																),
															),
															publishKind === "remote-dir"
																? h("input", {
																		className: "ghl-input",
																		style: { flex: "0 0 210px" },
																		placeholder: "仓库内路径，如 docs/site",
																		"aria-label": "仓库内路径",
																		value: publishRemotePath,
																		onChange: (event) => {
																			setPublishRemotePath(event.target.value);
																			setPublishPlan(null);
																		},
																		spellCheck: false,
																	})
																: null,
														),
														h(
															"div",
															{ className: "ghl-sub", style: { marginTop: "4px" } },
															publishKind === "remote-dir"
																? "路径留空则用文件夹名" +
																		(defaultRemotePath() ? "「" + defaultRemotePath() + "」" : "（请手填）") +
																		"。"
																: "目标仓库必须是空的，否则会被快进检查拒绝。",
														),
													),
										),
								h(
									"div",
									{ className: "ghl-row ghl-wrap", style: { marginTop: "8px" } },
									h("input", {
										className: "ghl-input ghl-grow",
										placeholder: "提交信息",
										"aria-label": "提交信息",
										value: publishMessage,
										onChange: (event) => setPublishMessage(event.target.value),
										onKeyDown: (event) => {
											if (event.key === "Enter" && !publishBusy && workspace) doPlanPublish();
										},
										spellCheck: false,
									}),
									h(
										"button",
										{
											className: "ghl-btn",
											type: "button",
											"aria-expanded": publishAdvanced ? "true" : "false",
											onClick: () => setPublishAdvanced(!publishAdvanced),
										},
										(publishAdvanced ? "▾ " : "▸ ") + "高级",
									),
								),
								publishAdvanced
									? h(
											"div",
											{ className: "ghl-row ghl-wrap", style: { marginTop: "6px" } },
											h("input", {
												className: "ghl-input",
												style: { flex: "0 0 130px" },
												placeholder: publishKind === "remote-dir" ? "默认分支" : "分支",
												"aria-label": "分支",
												value: publishBranch,
												onChange: (event) => setPublishBranch(event.target.value),
												spellCheck: false,
											}),
											publishKind === "upload"
												? h(
														"label",
														{ className: "ghl-row ghl-sub" },
														h("input", {
															type: "checkbox",
															checked: publishGitignore,
															onChange: (event) => setPublishGitignore(event.target.checked),
														}),
														"没有 .gitignore 时生成一份推荐的",
													)
												: null,
										)
									: null,
								publishKind === "update" && publishIdle()
									? h(
											"div",
											{ className: "ghl-sub", style: { marginTop: "6px" } },
											"没有可推送的改动：工作区干净，也没有本地领先的提交。",
										)
									: null,
								h("div", { className: "ghl-sub", style: { marginTop: "6px" } }, "目标：" + describePublishTarget()),
								h(
									"div",
									{ className: "ghl-row ghl-wrap", style: { marginTop: "8px" } },
									h(
										"button",
										{
											className: "ghl-btn",
											type: "button",
											disabled: publishBusy || !workspace || publishIdle(),
											onClick: doPlanPublish,
										},
										publishBusy ? "处理中…" : "① 预览",
									),
									h(
										"button",
										{
											className: "ghl-btn ghl-btn-primary",
											type: "button",
											disabled:
												publishBusy ||
												!workspace ||
												publishIdle() ||
												(publishNew && !publishRepoName.trim()) ||
												publishNeedsTarget() ||
												publishNeedsRemotePath(),
											onClick: doApplyPublish,
										},
										publishBusy
											? "执行中…"
											: publishKind === "upload"
												? "② 上传到 GitHub"
												: publishKind === "remote-dir"
													? "② 写入仓库子目录"
													: "② 推送更新",
									),
								),
								renderPlan(publishPlan),
								publishResult
									? h(
											"div",
											null,
											h(
												"div",
												{
													className: "ghl-notice " + (publishResult.ok ? "ghl-notice-ok" : "ghl-notice-err"),
													style: { marginTop: "8px" },
												},
												publishResult.text + (publishResult.needConfirm ? "（勾选上面的确认框后再点一次）" : ""),
											),
											publishResult.ok && publishResult.data && publishResult.data.htmlUrl
												? h(
														"div",
														{ className: "ghl-row", style: { marginTop: "6px" } },
														h(
															"a",
															{
																className: "ghl-link ghl-sub",
																href: publishResult.data.htmlUrl,
																target: "_blank",
																rel: "noreferrer",
															},
															"在 GitHub 打开 " + publishResult.data.full,
														),
													)
												: null,
										)
									: null,
							)
						: null,
				);
			};

			const renderSetup = () =>
				h(
					Card,
					null,
					h("h3", { className: "ghl-h" }, "第一步：创建 GitHub OAuth App"),
					h(
						"div",
						{ className: "ghl-sub" },
						"只需要公开的 Client ID，不要填 Client Secret。",
					),
					h(
						"ol",
						{ className: "ghl-steps" },
						h(
							"li",
							null,
							h(
								"a",
								{
									className: "ghl-link",
									href: "https://github.com/settings/applications/new",
									target: "_blank",
									rel: "noreferrer",
								},
								"打开 New OAuth App 页面",
							),
						),
						h("li", null, "Homepage URL 填 http://127.0.0.1:19387，并勾选 Enable Device Flow（关键）"),
						h("li", null, "创建后复制 Client ID，粘贴到下面"),
					),
					h(
						"div",
						{ className: "ghl-row", style: { marginTop: "12px" } },
						h("input", {
							className: "ghl-input ghl-grow",
							placeholder: "OAuth App Client ID",
							value: clientIdDraft,
							onChange: (event) => setClientIdDraft(event.target.value),
							spellCheck: false,
						}),
						h(
							"button",
							{
								className: "ghl-btn ghl-btn-primary",
								type: "button",
								disabled: savingClientId || !clientIdDraft.trim(),
								onClick: doSaveClientId,
							},
							savingClientId ? "保存中…" : "保存",
						),
					),
				);

			const renderLogin = () =>
				h(
					Card,
					null,
					h("h3", { className: "ghl-h" }, "登录 GitHub"),
					h(
						"div",
						{ className: "ghl-sub" },
						"权限 " +
							(state.defaultScopes || "repo read:user") +
							"（读私有仓库的最小 scope）；token 只存在主机上。",
					),
					flow
						? h(
								"div",
								{ style: { marginTop: "12px" } },
								h("div", { className: "ghl-sub" }, "① 打开验证页（浏览器里保持 GitHub 登录状态）："),
								h(
									"div",
									{ className: "ghl-row ghl-wrap", style: { marginTop: "4px" } },
									h(
										"a",
										{ className: "ghl-btn ghl-btn-primary", href: flow.verificationUri, target: "_blank", rel: "noreferrer" },
										"打开验证页",
									),
									h("span", { className: "ghl-sub ghl-mono" }, flow.verificationUri),
								),
								h("div", { className: "ghl-sub", style: { marginTop: "10px" } }, "② 输入验证码并授权："),
								h(
									"div",
									{ className: "ghl-row ghl-wrap", style: { marginTop: "4px" } },
									h("code", { className: "ghl-code" }, flow.userCode),
									h("button", { className: "ghl-btn", type: "button", onClick: () => copyText(flow.userCode) }, "复制"),
								),
								h(
									"div",
									{ className: "ghl-sub", style: { marginTop: "8px" } },
									"等待授权中… 剩余 " +
										mmss((flow.deadline || Date.now() + (flow.expiresIn || 900) * 1000) - (clock || Date.now())) +
										"（授权期间请保持本页面打开，不要重启 DSH）",
								),
								h(
									"button",
									{ className: "ghl-btn", type: "button", style: { marginTop: "10px" }, onClick: () => setFlow(null) },
									"取消",
								),
							)
						: h(
								"div",
								{ className: "ghl-row", style: { marginTop: "12px" } },
								h(
									"button",
									{ className: "ghl-btn ghl-btn-primary", type: "button", disabled: flowBusy, onClick: doStartDevice },
									flowBusy ? "正在申请验证码…" : "用 GitHub 设备码登录",
								),
							),
					state.git && state.git.available === false
						? h(
								"div",
								{ className: "ghl-notice ghl-notice-err", style: { marginTop: "10px" } },
								"未检测到 git 命令：登录和浏览仓库仍可用，但无法克隆到工作区。",
							)
						: null,
					h(
						"div",
						{ className: "ghl-hr" },
						h(
							"div",
							{ className: "ghl-disclosure", onClick: () => setPatOpen(!patOpen) },
							(patOpen ? "▾ " : "▸ ") + "改用 Personal Access Token",
						),
						patOpen
							? h(
									"div",
									{ style: { marginTop: "8px" } },
									h(
										"div",
										{ className: "ghl-sub" },
										"不想创建 OAuth App 时，可以粘贴一个带 repo scope 的 token（ghp_… 或 github_pat_…）。",
									),
									h(
										"div",
										{ className: "ghl-row", style: { marginTop: "8px" } },
										h("input", {
											className: "ghl-input ghl-grow",
											type: "password",
											placeholder: "ghp_…",
											value: patValue,
											onChange: (event) => setPatValue(event.target.value),
											spellCheck: false,
										}),
										h(
											"button",
											{
												className: "ghl-btn",
												type: "button",
												disabled: patBusy || !patValue.trim(),
												onClick: doSavePat,
											},
											patBusy ? "校验中…" : "保存",
										),
									),
								)
							: null,
					),
				);

			/** The registered workspace whose origin is this repository, if any. */
			const localForRepo = (full) => {
				const target = String(full || "").toLowerCase();
				if (!target) return undefined;
				return (locals || []).filter((item) => parseRemoteFull(item.git && item.git.remote).toLowerCase() === target)[0];
			};

			const renderRepoRow = (repo) => {
				const local = localForRepo(repo.fullName);
				return h(
					"div",
					{ key: repo.fullName, className: "ghl-repo", onClick: () => setSelected(repo.fullName) },
					h(
						"div",
						{ className: "ghl-row" },
						h("div", { className: "ghl-grow ghl-repo-name" }, repo.fullName),
						local ? h("span", { className: "ghl-badge" }, "本地已有") : null,
						repo.private ? h("span", { className: "ghl-badge ghl-badge-private" }, "私有") : null,
						repo.archived ? h("span", { className: "ghl-badge" }, "归档") : null,
						repo.fork ? h("span", { className: "ghl-badge" }, "fork") : null,
						h("span", { className: "ghl-sub" }, "›"),
					),
					repo.description ? h("div", { className: "ghl-repo-desc" }, repo.description) : null,
					h(
						"div",
						{ className: "ghl-meta" },
						repo.language ? h("span", null, repo.language) : null,
						h("span", null, "★ " + (Number(repo.stars) || 0)),
						formatDate(repo.updatedAt) ? h("span", null, "更新于 " + formatDate(repo.updatedAt)) : null,
						Number(repo.sizeKb) ? h("span", null, formatSize(repo.sizeKb)) : null,
						local ? h("span", null, "本地：" + (local.title || baseName(local.path))) : null,
					),
				);
			};

			const renderList = () =>
				h(
					Card,
					null,
					h(
						"div",
						{ className: "ghl-row ghl-wrap" },
						h("input", {
							className: "ghl-input ghl-grow",
							placeholder: "搜索仓库名…",
							"aria-label": "搜索仓库",
							value: repoQuery,
							onChange: (event) => setRepoQuery(event.target.value),
							spellCheck: false,
						}),
						h(
							"select",
							{
								className: "ghl-input",
								style: { flex: "0 0 104px" },
								value: visibility,
								onChange: (event) => setVisibility(event.target.value),
							},
							h("option", { value: "all" }, "全部"),
							h("option", { value: "private" }, "私有"),
							h("option", { value: "public" }, "公开"),
						),
						h(
							"select",
							{
								className: "ghl-input",
								style: { flex: "0 0 116px" },
								value: sort,
								onChange: (event) => setSort(event.target.value),
							},
							h("option", { value: "updated" }, "最近更新"),
							h("option", { value: "stars" }, "星标最多"),
						),
						h(
							"button",
							{ className: "ghl-btn", type: "button", disabled: reposBusy, onClick: () => setReload((n) => n + 1) },
							"刷新",
						),
					),
					h(
						"div",
						{ className: "ghl-sub", style: { marginTop: "8px" } },
						reposBusy
							? "加载中…"
							: repos.length
								? "本页 " +
									repos.length +
									" 个" +
									(repoTotal && repoTotal > repos.length ? " · 共约 " + repoTotal + " 个匹配" : "") +
									(query ? " · 搜索「" + query + "」" : "")
								: "",
					),
					reposError
						? h(
								"div",
								null,
								h("div", { className: "ghl-notice ghl-notice-err", style: { marginTop: "10px" } }, reposError),
								h(
									"div",
									{ className: "ghl-row", style: { marginTop: "6px" } },
									h(
										"button",
										{ className: "ghl-btn", type: "button", onClick: () => setReload((n) => n + 1) },
										"重试",
									),
								),
							)
						: null,
					repos.length
						? h(
								"div",
								null,
								h(
									"div",
									{ className: "ghl-sub", style: { marginTop: "6px" } },
									"点一行看详情 / 克隆；本地已有的会标出来。",
								),
								h("div", { className: "ghl-list ghl-scroll", style: { marginTop: "6px" } }, repos.map(renderRepoRow)),
							)
						: reposBusy
							? null
							: h(
									"div",
									{ className: "ghl-empty" },
									query
										? "没有匹配「" + query + "」的仓库。换个关键词，或把筛选改成「全部」。"
										: "这个账号下没有可见的仓库。如果你有私有仓库，确认授权时勾选了 repo scope。",
								),
					h(
						"div",
						{ className: "ghl-pager" },
						h(
							"button",
							{
								className: "ghl-btn",
								type: "button",
								disabled: page <= 1 || reposBusy,
								onClick: () => setPage((current) => Math.max(1, current - 1)),
							},
							"上一页",
						),
						h("span", { className: "ghl-sub" }, "第 " + page + " 页"),
						h(
							"button",
							{
								className: "ghl-btn",
								type: "button",
								disabled: !hasMore || reposBusy,
								onClick: () => setPage((current) => current + 1),
							},
							"下一页",
						),
					),
				);

			const renderDetail = () => {
				const repo = detail && detail.repo;
				const workspaces = (state && state.workspaces) || [];
				const workspace = workspaces.filter((item) => item.id === cloneWorkspace)[0] || workspaces[0];
				const previewPath = workspace && cloneName.trim() ? joinPath(workspace.path, cloneName.trim()) : "";
				const local = repo ? localForRepo(repo.fullName) : undefined;
				return h(
					"div",
					null,
					h(
						"div",
						{ className: "ghl-row" },
						h("button", { className: "ghl-btn", type: "button", onClick: () => setSelected("") }, "← 返回列表"),
						repo && repo.htmlUrl
							? h(
									"a",
									{ className: "ghl-link ghl-sub", href: repo.htmlUrl, target: "_blank", rel: "noreferrer" },
									"在 GitHub 打开",
								)
							: null,
					),
					detailBusy ? h("div", { className: "ghl-empty" }, "加载中…") : null,
					detailError ? h("div", { className: "ghl-notice ghl-notice-err", style: { marginTop: "10px" } }, detailError) : null,
					repo
						? h(
								Card,
								null,
								h(
									"div",
									{ className: "ghl-row ghl-wrap" },
									repo.ownerAvatar ? h("img", { className: "ghl-avatar", src: repo.ownerAvatar, alt: "" }) : null,
									h("div", { className: "ghl-grow ghl-repo-name" }, repo.fullName),
									repo.private ? h("span", { className: "ghl-badge ghl-badge-private" }, "私有") : null,
									repo.archived ? h("span", { className: "ghl-badge" }, "归档") : null,
								),
								repo.description ? h("div", { className: "ghl-sub", style: { marginTop: "6px" } }, repo.description) : null,
								h(
									"div",
									{ className: "ghl-meta" },
									repo.language ? h("span", null, repo.language) : null,
									h("span", null, "★ " + (Number(repo.stars) || 0)),
									h("span", null, "Fork " + (Number(repo.forks) || 0)),
									h("span", null, "Open issues " + (Number(repo.openIssues) || 0)),
									h("span", null, "默认分支 " + (repo.defaultBranch || "-")),
									formatDate(repo.pushedAt) ? h("span", null, "推送于 " + formatDate(repo.pushedAt)) : null,
									repo.license ? h("span", null, repo.license) : null,
									Number(repo.sizeKb) ? h("span", null, formatSize(repo.sizeKb)) : null,
								),
								repo.topics && repo.topics.length
									? h(
											"div",
											{ className: "ghl-row ghl-wrap", style: { marginTop: "8px" } },
											repo.topics.map((topic) => h("span", { key: topic, className: "ghl-tag" }, topic)),
										)
									: null,
								h(
									"div",
									{ className: "ghl-hr" },
									// Browse → edit → push is the real workflow, so when this
									// repository already exists locally say so and hand the user
									// straight to the push flow instead of cloning it twice.
									local
										? h(
												"div",
												null,
												h(
													"div",
													{ className: "ghl-sub" },
													"本地已有该仓库：" + (local.title || baseName(local.path)) + " — " + local.path,
												),
												h(
													"div",
													{ className: "ghl-row", style: { marginTop: "6px" } },
													h(
														"button",
														{
															className: "ghl-btn ghl-btn-primary",
															type: "button",
															onClick: () => {
																setPublishWorkspace(local.id);
																setPublishKind("update");
																setPublishOpen(true);
																setSelected("");
															},
														},
														"去推送这个目录的改动",
													),
												),
												h("div", { className: "ghl-hr" }),
											)
										: null,
									h("div", { className: "ghl-h" }, "克隆到工作区"),
									workspaces.length
										? h(
												"div",
												{ className: "ghl-row ghl-wrap" },
												h(
													"select",
													{
														className: "ghl-input ghl-grow",
														value: workspace ? workspace.id : "",
														onChange: (event) => setCloneWorkspace(event.target.value),
													},
													workspaces.map((item) =>
														h("option", { key: item.id, value: item.id }, (item.title || item.path) + " — " + item.path),
													),
												),
												h("input", {
													className: "ghl-input",
													style: { flex: "0 0 150px" },
													value: cloneName,
													placeholder: "本地目录名",
													onChange: (event) => setCloneName(event.target.value),
													spellCheck: false,
												}),
												h(
													"button",
													{
														className: "ghl-btn ghl-btn-primary",
														type: "button",
														disabled: cloneBusy || !cloneName.trim(),
														onClick: doClone,
													},
													cloneBusy ? "克隆中…" : "克隆",
												),
											)
										: h("div", { className: "ghl-sub" }, "没有可用的工作区：请先在 DSH 里打开一个目录。"),
									previewPath ? h("div", { className: "ghl-sub ghl-mono", style: { marginTop: "6px" } }, "目标：" + previewPath) : null,
									cloneResult && cloneResult.ok
										? h(
												"div",
												null,
												h(
													"div",
													{ className: "ghl-notice ghl-notice-ok", style: { marginTop: "8px" } },
													"已克隆到 " + cloneResult.path,
												),
												h(
													"div",
													{ className: "ghl-row", style: { marginTop: "6px" } },
													h(
														"button",
														{ className: "ghl-btn", type: "button", onClick: () => copyText(cloneResult.path) },
														"复制路径",
													),
												),
											)
										: null,
									cloneResult && !cloneResult.ok
										? h(
												"div",
												{ className: "ghl-notice ghl-notice-err", style: { marginTop: "8px" } },
												cloneResult.error + (cloneResult.hint ? " " + cloneResult.hint : ""),
											)
										: null,
								),
							)
						: null,
					repo && detail.branches && detail.branches.length
						? h(
								Card,
								null,
								h("h3", { className: "ghl-h" }, "分支（" + detail.branches.length + "）"),
								h(
									"div",
									{ className: "ghl-row ghl-wrap" },
									detail.branches.map((branch) =>
										h(
											"span",
											{ key: branch.name, className: "ghl-tag" },
											branch.name + (branch.protected ? " 🔒" : ""),
										),
									),
								),
							)
						: null,
					repo && detail.commits && detail.commits.length
						? h(
								Card,
								null,
								h("h3", { className: "ghl-h" }, "最近提交"),
								h(
									"div",
									null,
									detail.commits.map((commit) =>
										h(
											"div",
											{ key: commit.sha, className: "ghl-commit" },
											commit.authorAvatar
												? h("img", { className: "ghl-avatar-sm", src: commit.authorAvatar, alt: "" })
												: null,
											h(
												"div",
												{ className: "ghl-grow" },
												h("div", { className: "ghl-repo-desc" }, commit.message),
												h(
													"div",
													{ className: "ghl-meta", style: { marginTop: "2px" } },
													h("span", { className: "ghl-mono" }, commit.shortSha),
													h("span", null, commit.authorName || "-"),
													h("span", null, formatDate(commit.date)),
												),
											),
										),
									),
								),
							)
						: null,
				);
			};

			if (!state) {
				return h(
					"div",
					{ className: "ghl-root" },
					h("div", { className: "ghl-empty" }, stateError ? "无法读取插件状态：" + stateError : "正在读取状态…"),
				);
			}

			const configured = state.clientIdSource !== "none";
			return h(
				"div",
				{ className: "ghl-root" },
				renderHeader(),
				renderStatus(),
				h(Notice, { notice }),
				renderGuide(),
				!configured ? renderSetup() : null,
				configured && !connected ? renderLogin() : null,
				connected ? renderPublish() : null,
				connected ? (selected ? renderDetail() : renderList()) : null,
				renderProxy(),
				renderHelp(),
			);
		}

		// ── the slot entry ────────────────────────────────────────────────────

		function GitHubPage() {
			return h(React.Fragment, null, h(Styles, null), h(GitHubSection, null));
		}

		const inject = ["slots"];

		function apply(ctx) {
			try {
				if (ctx && ctx.slots && typeof ctx.slots.inject === "function") {
					// One entry only: a Settings page ("GitHub 仓库"). There is
					// deliberately no `plugins.item` card on the main interface.
					ctx.slots.inject("settings.section", () =>
						ctx.slots.register(
							{ name: "settings.section", id: "github-link", order: 620, label: "GitHub 仓库" },
							() => h(GitHubErrorBoundary, null, h(GitHubPage, null)),
						),
					);
				}
			} catch (error) {
				try {
					console.error("[github-link] settings slot registration failed", error);
				} catch {
					/* ignore */
				}
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
