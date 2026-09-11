window.__ModuleLoader__.load({
	id: "dsh-ops-updater",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		/**
		 * Browser half of the dsh-ops updater: one page under Settings that says
		 * which release is installed, asks the Host whether the channel has a
		 * newer one, and installs it on request.
		 *
		 * The page owns no version logic. Its Host half (index.mjs) runs
		 * `bin/dsh-sync.sh --check --json` for the check and starts
		 * `dsh-update.service` for the update, so the resolution rules, the
		 * build, the smoke test and the swap stay in the one place a terminal
		 * uses too. This file only draws that and polls while it runs.
		 *
		 * The channel it calls is one exact `/api` route on the Host. That path
		 * is served by dsh-client-connection, so the deployment's Host/Origin
		 * fence and the signed browser cookie are applied before the request
		 * reaches this plugin: a page that is not an authenticated page of this
		 * harness gets 401 and never reaches the updater.
		 */

		/** The `/api` route owned by this package's Host half. */
		const ROUTE = "/api/dsh-ops-updates";
		/** The one settings page this package contributes. */
		const SLOT = "settings.section";
		/** How often the page asks for progress while an update runs. */
		const POLL_MS = 2000;

		/**
		 * Call one endpoint, unwrapping the Host's own result shape. An HTTP
		 * failure (the harness restarting under us, or a page that lost its
		 * cookie) rejects, which is what the polling treats as "not back yet".
		 */
		async function call(endpoint, payload) {
			const response = await fetch(ROUTE, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ endpoint, payload: payload === undefined ? {} : payload }),
			});
			if (response.status === 401 || response.status === 403) {
				throw new Error("this page is not authenticated for the harness host — reload it through your usual address");
			}
			if (!response.ok) throw new Error(`the Host answered HTTP ${response.status}`);
			const answer = await response.json();
			if (answer !== null && answer.ok === true) return answer.value;
			const failure = answer === null ? undefined : answer.error;
			throw new Error(failure === undefined ? "the Host refused this request" : failure.message);
		}

		/** A timestamp as the reader's own clock shows it. */
		function when(iso) {
			if (typeof iso !== "string" || iso.length === 0) return "unknown";
			const at = new Date(iso);
			if (Number.isNaN(at.getTime())) return "unknown";
			return at.toLocaleString();
		}

		/** How long ago, in words, without pulling in a date library. */
		function ago(iso) {
			if (typeof iso !== "string" || iso.length === 0) return "";
			const at = new Date(iso);
			if (Number.isNaN(at.getTime())) return "";
			const seconds = Math.max(0, Math.round((Date.now() - at.getTime()) / 1000));
			if (seconds < 60) return `${seconds}s ago`;
			if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
			if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
			return `${Math.round(seconds / 86400)}d ago`;
		}

		const styles = {
			wrap: { display: "flex", flexDirection: "column", gap: "0.9rem", maxWidth: "46rem" },
			lede: { fontSize: "0.82rem", lineHeight: 1.5, opacity: 0.75, margin: 0 },
			card: {
				border: "1px solid var(--dsh-border, rgba(127,127,127,0.25))",
				borderRadius: "0.5rem", padding: "0.8rem 0.9rem",
				display: "flex", flexDirection: "column", gap: "0.6rem",
			},
			row: { display: "flex", alignItems: "baseline", gap: "0.6rem", flexWrap: "wrap" },
			key: { fontSize: "0.75rem", opacity: 0.6, minWidth: "7rem" },
			value: { fontSize: "0.82rem" },
			mono: { fontFamily: "var(--dsh-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)", fontSize: "0.78rem" },
			actions: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem" },
			button: {
				padding: "0.35rem 0.8rem", borderRadius: "0.375rem",
				border: "1px solid var(--dsh-border, rgba(127,127,127,0.35))",
				background: "var(--dsh-button-bg, transparent)", color: "inherit",
				font: "inherit", fontSize: "0.78rem", cursor: "pointer",
			},
			primary: { fontWeight: 600, borderColor: "var(--dsh-accent, rgba(127,127,127,0.6))" },
			busy: { opacity: 0.5, cursor: "default" },
			status: { fontSize: "0.78rem", opacity: 0.8 },
			good: { fontSize: "0.78rem", color: "var(--dsh-success, #3fa45b)" },
			error: { fontSize: "0.78rem", color: "var(--dsh-danger, #d9534f)" },
			hint: { fontSize: "0.72rem", opacity: 0.55, lineHeight: 1.4 },
			toggle: { display: "flex", alignItems: "flex-start", gap: "0.5rem", cursor: "pointer" },
			pre: {
				margin: 0, padding: "0.5rem 0.6rem", maxHeight: "14rem", overflow: "auto",
				fontSize: "0.72rem", lineHeight: 1.45, whiteSpace: "pre-wrap",
				borderRadius: "0.375rem", background: "var(--dsh-code-bg, rgba(127,127,127,0.12))",
				fontFamily: "var(--dsh-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
			},
			details: { fontSize: "0.72rem", opacity: 0.6 },
			separator: { borderTop: "1px solid var(--dsh-border, rgba(127,127,127,0.2))" },
		};

		/**
		 * The Updates page.
		 * @param props - the shell's share of a settings section; this page
		 *   renders its own content and needs nothing from it.
		 */
		function UpdatesSection(props) {
			const [status, setStatus] = React.useState(null);
			const [report, setReport] = React.useState(null);
			const [run, setRun] = React.useState(null);
			const [log, setLog] = React.useState("");
			const [pending, setPending] = React.useState("");
			const [failure, setFailure] = React.useState(null);
			const [notice, setNotice] = React.useState(null);
			const [restarting, setRestarting] = React.useState(false);
			const [showLog, setShowLog] = React.useState(false);
			const alive = React.useRef(true);

			React.useEffect(() => () => { alive.current = false }, []);

			/** Read what is installed, and reflect any run already in flight. */
			const load = React.useCallback(async () => {
				const value = await call("status", {});
				if (!alive.current) return value;
				setStatus(value);
				setRun(value.run ?? null);
				if (value.run !== null && value.run !== undefined && value.run.state === "running") setRestarting(true);
				return value;
			}, []);

			// First paint: the installed release, and one check. The check is
			// what makes this page useful the moment it opens; it fetches tags,
			// so it is deliberately once per visit rather than on a timer.
			React.useEffect(() => {
				let cancelled = false;
				void (async () => {
					try {
						const value = await call("status", {});
						if (cancelled) return;
						setStatus(value);
						setRun(value.run ?? null);
						if (value.found !== true) return;
						const checked = await call("check", {});
						if (!cancelled) setReport(checked);
					} catch (error) {
						if (!cancelled) setFailure(error.message);
					}
				})();
				return () => { cancelled = true };
			}, []);

			const running = run !== null && run !== undefined && run.state === "running";

			// While an update runs, watch its progress record and log. A failed
			// call here is expected rather than exceptional: the harness
			// restarts at the end of the update, which takes this page's
			// transport down with it until the new process answers.
			React.useEffect(() => {
				if (!running && !restarting) return undefined;
				let cancelled = false;
				const tick = async () => {
					try {
						const value = await call("progress", { lines: 80 });
						if (cancelled) return;
						setRun(value.run);
						setLog(value.log);
						setRestarting(false);
						if (value.run !== null && value.run !== undefined && value.run.state !== "running") {
							const fresh = await call("status", {});
							if (!cancelled) setStatus(fresh);
						}
					} catch {
						if (!cancelled) setRestarting(true);
					}
				};
				const id = setInterval(() => { void tick() }, POLL_MS);
				void tick();
				return () => { cancelled = true; clearInterval(id) };
			}, [running, restarting]);

			/** Run one action with the shared pending/error handling. */
			const act = async (name, work) => {
				setPending(name);
				setFailure(null);
				setNotice(null);
				try {
					return await work();
				} catch (error) {
					setFailure(error.message);
					return undefined;
				} finally {
					if (alive.current) setPending("");
				}
			};

			const check = () => act("check", async () => {
				const value = await call("check", {});
				setReport(value);
			});

			const install = () => act("update", async () => {
				const value = await call("update", {});
				if (value.alreadyRunning === true) {
					setNotice("An update is already running.");
					setRestarting(true);
					return;
				}
				setRun({ state: "running", phase: "starting", message: "asking systemd to run the updater…" });
				setRestarting(true);
				setNotice(value.via === "systemd"
					? "Update started. This page reconnects on its own when the harness restarts."
					: value.warning ?? "Update started.");
			});

			const toggleAuto = () => act("auto", async () => {
				const wanted = !(status !== null && status.autoUpdate === true);
				const value = await call("auto", { enabled: wanted });
				setStatus((current) => current === null ? current : { ...current, autoUpdate: value.enabled, timer: value.timer });
				setNotice(wanted
					? "This machine now checks for and installs a newer release every night at 03:00."
					: "Daily updates are off. Updates happen only when you press the button above.");
				if (value.error !== null && value.error !== undefined) setFailure(value.error);
			});

			if (status === null) {
				return React.createElement("div", { style: styles.wrap },
					React.createElement("p", { style: styles.hint }, failure ?? "Reading the update state…"));
			}

			if (status.found !== true) {
				return React.createElement("div", { style: styles.wrap },
					React.createElement("h3", { style: { margin: 0, fontSize: "0.95rem" } }, "Updates"),
					React.createElement("p", { style: styles.error }, status.error ?? "This deployment's checkout could not be located."),
					React.createElement("p", { style: styles.hint },
						"Set opsPath on the dsh-ops-updater row in ~/.dsh/profiles/web/cordis.patch.yml to the dsh-ops checkout, then restart dsh-web."),
					React.createElement("p", { style: styles.details }, `systemd timer: ${status.timer ?? "unknown"}`));
			}

			const available = report !== null && report.ok === true && report.updateAvailable === true;
			const target = report === null ? undefined : report.target;
			const busy = pending !== "" || running;
			const buttonStyle = (extra) => ({ ...styles.button, ...extra, ...(busy ? styles.busy : {}) });

			const installLabel = available && typeof target === "string"
				? `Install ${target}`
				: status.current === null ? "Install newest release" : `Reinstall ${status.current}`;

			const checkLine = () => {
				if (report === null) return null;
				if (report.ok !== true) {
					return React.createElement("span", { style: styles.error }, `Check failed: ${report.error ?? "unknown reason"}`);
				}
				if (report.updateAvailable === true) {
					const count = typeof report.newerCount === "number" ? report.newerCount : 0;
					return React.createElement("span", { style: styles.status },
						`${report.target} is available`,
						count > 1 ? ` — ${count} newer releases on ${report.channel}` : ` — newest on ${report.channel}`);
				}
				return React.createElement("span", { style: styles.good },
					`Up to date — ${report.current ?? "this build"} is the newest on ${report.channel}`);
			};

			const runBlock = () => {
				if (run === null || run === undefined) return null;
				const finished = run.state !== "running";
				const tone = run.state === "failed" ? styles.error : finished ? styles.good : styles.status;
				return React.createElement("div", { style: { ...styles.card, gap: "0.5rem" } },
					React.createElement("div", { style: styles.row },
						React.createElement("span", { style: styles.key }, "Last update"),
						React.createElement("span", { style: tone },
							`${run.state}${run.phase === undefined ? "" : ` — ${run.phase}`}`,
							run.message === undefined ? "" : `: ${run.message}`),
						restarting ? React.createElement("span", { style: styles.hint }, "waiting for the harness to come back…") : null),
					React.createElement("div", { style: styles.row },
						React.createElement("span", { style: styles.key }, "Started"),
						React.createElement("span", { style: styles.value }, `${when(run.startedAt)}${ago(run.startedAt) === "" ? "" : ` (${ago(run.startedAt)})`}`),
						run.finishedAt === null || run.finishedAt === undefined ? null : React.createElement("span", { style: styles.value }, `· finished ${when(run.finishedAt)}`)),
					finished && run.state === "ok"
						? React.createElement("div", { style: styles.actions },
							React.createElement("button", {
								type: "button", style: { ...styles.button, ...styles.primary },
								onClick: () => { globalThis.location.reload() },
							}, "Reload to run the new build"))
						: null,
					React.createElement("div", { style: styles.actions },
						React.createElement("button", {
							type: "button", style: styles.button,
							onClick: () => { setShowLog((current) => !current) },
						}, showLog ? "Hide log" : "Show log")),
					showLog && log.length > 0 ? React.createElement("pre", { style: styles.pre }, log) : null);
			};

			return React.createElement("div", { style: styles.wrap },
				React.createElement("h3", { style: { margin: 0, fontSize: "0.95rem" } }, "Updates"),
				React.createElement("p", { style: styles.lede },
					"This deployment runs the harness from source, so an update is a build: the updater fetches the newest tag on the channel, builds it, boots it once as a smoke test, and only then swaps it in and restarts. A failure leaves the running build alone."),

				React.createElement("div", { style: styles.card },
					React.createElement("div", { style: styles.row },
						React.createElement("span", { style: styles.key }, "Installed"),
						React.createElement("span", { style: { ...styles.value, ...styles.mono } }, status.current ?? "unknown"),
						React.createElement("span", { style: styles.hint }, status.installedAt === null ? "" : `· ${when(status.installedAt)}`)),
					React.createElement("div", { style: styles.row },
						React.createElement("span", { style: styles.key }, "Channel"),
						React.createElement("span", { style: { ...styles.value, ...styles.mono } }, status.channel),
						React.createElement("span", { style: styles.hint }, "· newest tag on this channel, alpha excluded unless the channel is latest")),
					React.createElement("div", { style: styles.actions },
						React.createElement("button", {
							type: "button", style: buttonStyle(), disabled: busy, onClick: check,
						}, pending === "check" ? "Checking…" : "Check for updates"),
						React.createElement("button", {
							type: "button", style: buttonStyle(available ? styles.primary : {}),
							disabled: busy, onClick: install,
						}, pending === "update" ? "Starting…" : installLabel),
						checkLine()),
					React.createElement("div", { style: styles.actions },
						React.createElement("label", { style: styles.toggle },
							React.createElement("input", {
								type: "checkbox", checked: status.autoUpdate === true, disabled: busy,
								onChange: () => { void toggleAuto() },
							}),
							React.createElement("span", { style: styles.value }, "Update automatically every night (03:00)"))),
					React.createElement("div", { style: styles.hint },
						`systemd timer dsh-update.timer: ${status.timer ?? "unknown"}`,
						status.timer === "unavailable" ? " — no systemd user session here, so the button runs the updater detached" : ""),
					notice === null ? null : React.createElement("div", { style: styles.status }, notice),
					failure === null ? null : React.createElement("div", { style: styles.error }, failure)),

				runBlock(),

				React.createElement("div", { style: styles.separator }),
				React.createElement("div", { style: styles.details },
					React.createElement("div", null, `checkout: ${status.root}`),
					React.createElement("div", null, `check: bin/dsh-sync.sh --check --json · update: systemctl --user start ${status.unit ?? "dsh-update.service"}`)));
		}

		/**
		 * Services this plugin needs before it can register anything: the Slot
		 * table to contribute the page, and the Connection transport to reach
		 * its own Host half.
		 */
		const inject = ["slots"];
		exports.inject = inject;

		/**
		 * Register the Updates page under Settings.
		 * @param ctx - the Client plugin context.
		 */
		function apply(ctx) {
			ctx.slots.inject(SLOT, () => ctx.slots.register(
				{ name: SLOT, id: "updates", order: 25, label: "Updates" },
				(props) => React.createElement(UpdatesSection, props),
			));
		}
		exports.apply = apply;

		exports.UpdatesSection = UpdatesSection;
		return module.exports;
	}
});
