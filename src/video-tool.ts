/**
 * `odoo_video` — narrated VIDEO documentation of Odoo flows, standalone
 * beside `odoo_manual` (it never writes MANUAL.md/index.html). It reuses the
 * same evidence motor: a canon read from the instance (or imported from an
 * existing manual workspace via from_manual), the same storyboard schema, and
 * the same capture engine — capture here ALWAYS records the browser session
 * (webm + per-step timestamps). Voice comes from an externally configured TTS
 * command; assembly is ffmpeg. The storyboard's `procedure` sentences ARE the
 * script: one sentence per step becomes one narration and one caption.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { writeFileAtomic } from "./atomic.js";
import {
	resolveManualWorkspace,
	readStoryboard,
	nextFlowId,
	stepSafety,
	writeStoryboard,
	planStoryboard,
	type ManualsMode,
	type Storyboard,
} from "./manual-model.js";
import {
	collectCanon,
	canonFingerprint,
	type Canon,
	type CanonClient,
	type Row,
} from "./manual-canon.js";
import { mergeStoryboards, type WebSessionResult } from "./manual-tool.js";
import { captureFlow, familyFor, loadPlaywright, resolveBrowser } from "./manual-capture.js";
import {
	resolveVideoWorkspace,
	readVideoCanonSurface,
	validateVideoStoryboard,
	importFromManual,
} from "./video-model.js";
import { voiceFlow } from "./video-voice.js";
import { assembleVideo } from "./video-assemble.js";
import { presentCall } from "./present.js";

export interface VideoToolDeps {
	projectRoot: (exec?: unknown) => string;
	specDir: (specId: string | undefined, exec?: unknown) => string;
	/** Base directory that holds spec directories (project or central layout). */
	specsBase: (exec?: unknown) => string;
	manuals: (exec?: unknown) => { mode: ManualsMode; dir: string };
	configuredLanguage: (exec?: unknown) => string | undefined;
	/** The connected instance (clientForExec); undefined when not configured. */
	client: (exec?: unknown) => CanonClient | undefined;
	display: (value: string) => string;
	/** Local Community / Enterprise checkouts, for native error evidence. */
	repos?: (exec?: unknown) => { communityPath?: string; enterprisePath?: string };
	/** A web session for the browser (odoo_video capture). */
	webSession: (exec?: unknown) => Promise<WebSessionResult>;
	/** videosDir config (default "docs/videos"), resolved by the host. */
	videosDir: (exec?: unknown) => string;
	/** ttsCommand config / env; null → NEEDS_TTS with examples. */
	ttsCommand: (exec?: unknown) => string | null;
	/** ttsVoice config / env; the call param `voice` wins over it. */
	ttsVoice: (exec?: unknown) => string | null;
	/** ffmpeg binary (default "ffmpeg"). */
	ffmpegPath: (exec?: unknown) => string;
}

type VideoToolResult = {
	ok: boolean;
	operation: string;
	summary: string;
	artifacts: string[];
	detail: string;
};

/**
 * Register the `odoo_video` tool.
 * @param ctx - registrant context exposing the tool registry.
 * @param deps - live configuration lookups.
 */
export function registerVideoTool(
	ctx: { tools: { register(tool: unknown): void } },
	deps: VideoToolDeps,
): void {
	ctx.tools.register(
		defineTool({
			name: "odoo_video",
						presentCall: (args: unknown) => presentCall("odoo_video", args),
			description:
				"Narrated VIDEO documentation of Odoo flows, built on the same evidence as odoo_manual " +
				"(a canon read from the instance — or imported from an existing manual with from_manual) and the " +
				"same storyboard: every step's procedure sentence becomes the narration script and the caption. " +
				"operation=plan drafts the storyboard (from the instance canon, or imports a manual's canon+storyboard); " +
				"operation=voice narrates it with an externally configured TTS command; operation=capture records the " +
				"browser session (webm + per-step timestamps) — read-only steps always, ACTION steps only with " +
				"allow_actions=true AND confirm_destructive=true on a DISPOSABLE database; operation=assemble cuts, " +
				"pads to the narration and muxes video/<flow>.mp4 with ffmpeg — SRT/VTT captions ALWAYS ship. " +
				"It never writes MANUAL.md: odoo_manual stays untouched.",
			parameters: {
				operation: {
					type: "string",
					required: true,
					enum: ["plan", "voice", "capture", "assemble"],
					description:
						"plan: draft the video storyboard from the instance canon, or import a manual's canon+storyboard (from_manual). " +
						"voice: narrate each step's procedure with the configured ttsCommand (idempotent per .wav). " +
						"capture: run the flow in a real browser and RECORD it (video always on); ACTION steps need allow_actions=true + confirm_destructive=true. " +
						"assemble: cut the recording by step, freeze frames to fit the narration, mux video/<flow>.mp4 + .srt/.vtt.",
				},
				slug: {
					type: "string",
					description: "Video folder name (one safe segment) under videosDir. Defaults to video-<model> or video-<from_manual>.",
				},
				from_manual: {
					type: "string",
					description:
						"plan: slug of an EXISTING manual workspace (same manuals config as odoo_manual) whose canon.json + storyboard.json " +
						"are copied into the video workspace — the narrated manual becomes the video script without re-reading the instance.",
				},
				model: {
					type: "string",
					description: "Technical model name to document (e.g. sale.order). plan without from_manual needs model or module/modules.",
				},
				module: {
					type: "string",
					description: "Technical module name: its first model becomes the primary one (plan).",
				},
				modules: {
					type: "array",
					items: { type: "string" },
					description: "Module inventory to document (plan).",
				},
				as_user: { type: "string", description: "plan: the user the video documents (login, or \"admin\")." },
				admin: { type: "boolean", description: "plan: whether that user is an administrator." },
				groups: { type: "array", items: { type: "string" }, description: "plan: access groups to walk (res.groups xmlids)." },
				module_dir: {
					type: "string",
					description: "plan: the project's own module directory, for native error evidence (optional).",
				},
				spec_id: { type: "string", description: "plan with from_manual: which spec's manual tree to resolve when manualsMode=specs." },
				language: {
					type: "string",
					description:
						"plan ONLY: narration/caption language. Fixed at plan time; later it lives in storyboard.language " +
						"(chain: this param > imported storyboard > documentationLanguage config > en_US).",
				},
				flow: { type: "string", description: "voice/capture/assemble: the storyboard flow id (see operation=plan)." },
				voice: {
					type: "string",
					description:
						"voice: engine-specific voice string (e.g. es-ES-AlvaroNeural for edge-tts, es_ES-sharvard-medium for piper). " +
						"Overrides the ttsVoice config; required when the ttsCommand uses {voice} and no config voice exists.",
				},
				from_step: { type: "string", description: "capture: resume from this step id after a failure." },
				allow_actions: {
					type: "boolean",
					description: "capture: allow ACTION steps (new/fill/select/press/click) to run. Default false = read-only capture.",
				},
				confirm_destructive: {
					type: "boolean",
					description: "capture: required together with allow_actions=true — UI clicks cannot be journaled or undone.",
				},
				headed: { type: "boolean", description: "capture: run the browser visible. Default headless." },
				zoom: { type: "number", description: "capture: device scale factor 1..2 for the PNG stills (the webm stays 1440x900 CSS)." },
				browser: {
					type: "string",
					enum: ["auto", "chromium", "chrome", "msedge"],
					description: "capture: which browser. auto = bundled Chromium → Chrome → Edge.",
				},
				captions: {
					type: "boolean",
					description: "assemble: also BURN the captions in (drawtext, needs a known font). SRT/VTT always ship regardless.",
				},
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean", required: true },
						operation: { type: "string", required: true },
						summary: { type: "string", required: true },
						artifacts: { type: "array", required: true, items: { type: "string" } },
						detail: { type: "string", required: true },
					},
				},
				render: (_args: unknown, value: unknown) => [{ type: "text", text: (value as { detail: string }).detail }],
			},
			async execute(args: {
				operation: "plan" | "voice" | "capture" | "assemble";
				slug?: string;
				from_manual?: string;
				model?: string;
				module?: string;
				modules?: string[];
				as_user?: string;
				admin?: boolean;
				groups?: string[];
				module_dir?: string;
				spec_id?: string;
				language?: string;
				flow?: string;
				voice?: string;
				from_step?: string;
				allow_actions?: boolean;
				confirm_destructive?: boolean;
				headed?: boolean;
				zoom?: number;
				browser?: "auto" | "chromium" | "chrome" | "msedge";
				captions?: boolean;
			}, exec?: unknown) {
				const projectRoot = deps.projectRoot(exec);
				const slug =
					args.slug ??
					(args.from_manual ? `video-${args.from_manual}` : undefined) ??
					(args.model ? `video-${args.model.replace(/\./g, "-").replace(/[^A-Za-z0-9._-]/g, "-")}` : undefined);
				const artifacts: string[] = [];
				if (!slug) {
					return {
						ok: false,
						operation: args.operation,
						summary: "BLOCKED",
						artifacts,
						detail: "BLOCKED — name the video: pass slug (or model / from_manual, which default it).",
					};
				}
				const ws = resolveVideoWorkspace({ projectRoot, dir: deps.videosDir(exec), slug });
				if (!ws.ok) {
					return { ok: false, operation: args.operation, summary: "BLOCKED", artifacts, detail: `BLOCKED — ${ws.blocked}` };
				}
				if (args.operation === "plan") return planOp(args, ws.dir, slug, deps, artifacts, projectRoot, exec);
				if (args.operation === "voice") return voiceOp(args, ws.dir, slug, deps, artifacts);
				if (args.operation === "capture") return captureOp(args, ws.dir, slug, deps, artifacts, exec);
				return assembleOp(args, ws.dir, slug, deps, artifacts);
			},
		}),
	);
}

/** Load the storyboard of a video workspace or explain what is missing. */
function needStoryboard(dir: string, operation: string, slug: string, artifacts: string[]): { ok: true; sb: Storyboard } | { ok: false; result: VideoToolResult } {
	try {
		const sb = readStoryboard(dir);
		if (sb) return { ok: true, sb };
	} catch (e) {
		return { ok: false, result: { ok: false, operation, summary: "BLOCKED", artifacts, detail: `BLOCKED — storyboard.json is not readable: ${e instanceof Error ? e.message : String(e)}` } };
	}
	return {
		ok: false,
		result: {
			ok: false,
			operation,
			summary: "BLOCKED",
			artifacts,
			detail: `BLOCKED — ${slug} has no storyboard.json: run operation=plan (from the instance canon, or from_manual=<manual slug>).`,
		},
	};
}

function needFlow(sb: Storyboard, flowId: string | undefined, operation: string, artifacts: string[]): { ok: true; flow: Storyboard["flows"][number] } | { ok: false; result: VideoToolResult } {
	const flow = flowId ? sb.flows.find((f) => f.id === flowId) : undefined;
	if (!flow) {
		return {
			ok: false,
			result: {
				ok: false,
				operation,
				summary: "BLOCKED",
				artifacts,
				detail: `BLOCKED — operation=${operation} needs flow: the storyboard flow id to narrate/record/assemble (flows: ${sb.flows.map((f) => f.id).join(", ") || "none"}).`,
			},
		};
	}
	return { ok: true, flow };
}

// ---------------------------------------------------------------------------
// plan — from the instance canon, or imported from an existing manual
// ---------------------------------------------------------------------------

async function planOp(
	args: {
		from_manual?: string;
		model?: string;
		module?: string;
		modules?: string[];
		as_user?: string;
		admin?: boolean;
		groups?: string[];
		module_dir?: string;
		spec_id?: string;
		language?: string;
	},
	dir: string,
	slug: string,
	deps: VideoToolDeps,
	artifacts: string[],
	projectRoot: string,
	exec?: unknown,
): Promise<VideoToolResult> {
	const lines: string[] = [`Video ${slug} — ${deps.display(dir)}`, ""];

	if (args.from_manual) {
		const manualsCfg = deps.manuals(exec);
		const manualWs = resolveManualWorkspace({
			mode: manualsCfg.mode,
			dir: manualsCfg.dir,
			projectRoot,
			specsBase: deps.specsBase(exec),
			specDir: args.spec_id ? deps.specDir(args.spec_id, exec) : undefined,
			slug: args.from_manual,
		});
		if (!manualWs.ok) {
			return { ok: false, operation: "plan", summary: "BLOCKED", artifacts, detail: `BLOCKED — cannot resolve the manual workspace of "${args.from_manual}": ${manualWs.blocked}` };
		}
		if (existsSync(join(dir, "storyboard.json"))) {
			return {
				ok: false,
				operation: "plan",
				summary: "BLOCKED",
				artifacts,
				detail:
					`BLOCKED — ${slug} already has a storyboard.json and from_manual refuses to overwrite it ` +
					"(video-side narration edits would be lost). Delete it to re-import, or use a new slug.",
			};
		}
		const imported = importFromManual(manualWs.dir, dir);
		if (!imported.ok) return { ok: false, operation: "plan", summary: "BLOCKED", artifacts, detail: `BLOCKED — ${imported.error}` };
		let sb: Storyboard | null = null;
		try {
			sb = readStoryboard(dir);
		} catch {
			sb = null;
		}
		if (!sb) {
			return { ok: false, operation: "plan", summary: "BLOCKED", artifacts, detail: "BLOCKED — the imported storyboard.json is not readable (schema must be dsh-odoo-sdd/manual/1)." };
		}
		if (!sb.language) {
			// The manual storyboard had no language pinned: resolve it now and
			// pin it (the video's language is fixed at plan time).
			sb.language = args.language ?? deps.configuredLanguage(exec) ?? "en_US";
			writeStoryboard(dir, sb);
		}
		artifacts.push(`${slug}/storyboard.json`, `${slug}/canon.json`);
		const findings = validateVideoStoryboard(sb, readVideoCanonSurface(dir));
		lines.push(`Imported from manual "${args.from_manual}": ${imported.value.flows} flow(s), ${imported.value.steps} step(s), ${imported.value.narrated} narrated.`);
		lines.push(`Language: ${sb.language} (inherited from the manual — narration and captions use it).`);
		lines.push(...findingLines(findings));
		lines.push("");
		lines.push("Next: fill any missing procedure sentence (the script), then voice → capture → assemble.");
		return { ok: true, operation: "plan", summary: `imported ${imported.value.flows} flow(s) / ${imported.value.steps} step(s); ${findings.length} finding(s)`, artifacts, detail: lines.join("\n") };
	}

	// Instance path: read the canon the same way odoo_manual does.
	const client = deps.client(exec);
	if (client === undefined) {
		return {
			ok: false,
			operation: "plan",
			summary: "NEEDS_INSTANCE",
			artifacts,
			detail:
				"NEEDS_INSTANCE — plan reads the canon from a connected Odoo instance (or imports one with from_manual). " +
				"Run the connection onboarding (odoo_setup) first.",
		};
	}
	const version = await client.version();
	if (!version.ok) {
		return { ok: false, operation: "plan", summary: "INSTANCE UNREACHABLE", artifacts, detail: `Cannot probe the server version: ${version.error}` };
	}
	const requestedModules = [...new Set([...(args.modules ?? []), ...(args.module ? [args.module] : [])])].filter((m) => m.trim() !== "");
	let model = args.model;
	if (!model && requestedModules.length > 0) {
		const pick = await client.executeKw<Row[]>("ir.model", "search_read", [[["modules", "like", requestedModules[0]]], ["model", "modules"]], { limit: 200 });
		if (!pick.ok) {
			return { ok: false, operation: "plan", summary: "BLOCKED", artifacts, detail: `BLOCKED — could not list the module's models: ${pick.error}` };
		}
		const first = pick.value.find((r) => String(r["modules"] ?? "").split(",").map((x) => x.trim()).includes(requestedModules[0]));
		if (!first) {
			return { ok: false, operation: "plan", summary: "BLOCKED", artifacts, detail: `BLOCKED — module "${requestedModules[0]}" declares no model in ir.model.modules: check the technical name.` };
		}
		model = String(first["model"] ?? "");
	}
	if (!model) {
		return {
			ok: false,
			operation: "plan",
			summary: "BLOCKED",
			artifacts,
			detail: "BLOCKED — plan needs model (the canon is read per model), module/modules (first model), or from_manual (import an existing manual).",
		};
	}
	const repos = deps.repos?.(exec);
	const result = await collectCanon(client, {
		model,
		modules: requestedModules,
		asUser: args.as_user,
		admin: args.admin,
		groups: args.groups,
		serverVersion: version.value.server_version,
		language: args.language ?? deps.configuredLanguage(exec),
		module: args.module,
		moduleName: args.module ?? requestedModules[0] ?? (args.module_dir ? args.module_dir.split("/").filter(Boolean).pop() : undefined),
		moduleDir: args.module_dir && existsSync(join(args.module_dir, "__manifest__.py")) ? args.module_dir : undefined,
		repos: repos ? { communityPath: repos.communityPath, enterprisePath: repos.enterprisePath } : undefined,
	});
	if (!result.ok) {
		return { ok: false, operation: "plan", summary: "BLOCKED", artifacts, detail: `BLOCKED — ${result.blocked}` };
	}
	const canon: Canon = result.canon;
	const fingerprint = canonFingerprint(canon);
	writeFileAtomic(
		join(dir, "canon.json"),
		JSON.stringify({ schema: "dsh-odoo-sdd/canon/1", fingerprint, collectedAt: new Date().toISOString(), ...canon }, null, 2) + "\n",
	);
	artifacts.push(`${slug}/canon.json`);

	const existing = (() => {
		try {
			return readStoryboard(dir) ?? undefined;
		} catch {
			return undefined;
		}
	})();
	// Same merge semantics as the manual: narration is the expensive work.
	const sb = existing ? mergeStoryboards(existing, planStoryboard(canon, slug)) : planStoryboard(canon, slug);
	sb.canonFingerprint = fingerprint;
	sb.language = existing?.language ?? args.language ?? deps.configuredLanguage(exec) ?? canon.language;
	writeStoryboard(dir, sb);
	artifacts.push(`${slug}/storyboard.json`);

	const findings = validateVideoStoryboard(sb, readVideoCanonSurface(dir));
	const steps = sb.flows.reduce((a, f) => a + f.steps.length, 0);
	lines.push(`Storyboard planned from the canon: ${sb.flows.length} flow(s), ${steps} step(s), fingerprint ${fingerprint.slice(0, 12)}….`);
	lines.push(`Language: ${sb.language} (write every procedure sentence in it — it is the narration AND caption script).`);
	lines.push(...findingLines(findings));
	lines.push("");
	lines.push("Next: write ONE sentence per step (procedure), then voice → capture → assemble per flow.");
	return { ok: true, operation: "plan", summary: `planned ${sb.flows.length} flow(s), ${steps} step(s); ${findings.length} finding(s)`, artifacts, detail: lines.join("\n") };
}

function findingLines(findings: { severity: string; rule: string; message: string; flow?: string; step?: string }[]): string[] {
	if (findings.length === 0) return ["No findings."];
	return findings.map((f) => `- [${f.severity}] ${f.rule}${f.flow ? ` (${f.flow}${f.step ? `/${f.step}` : ""})` : ""}: ${f.message}`);
}

// ---------------------------------------------------------------------------
// voice — the storyboard sentences, spoken by the configured TTS command
// ---------------------------------------------------------------------------

async function voiceOp(
	args: { flow?: string; voice?: string },
	dir: string,
	slug: string,
	deps: VideoToolDeps,
	artifacts: string[],
	exec?: unknown,
): Promise<VideoToolResult> {
	const loaded = needStoryboard(dir, "voice", slug, artifacts);
	if (!loaded.ok) return loaded.result;
	const got = needFlow(loaded.sb, args.flow, "voice", artifacts);
	if (!got.ok) return got.result;
	const res = await voiceFlow({
		workspace: dir,
		flow: got.flow,
		language: loaded.sb.language,
		ttsCommand: deps.ttsCommand(exec),
		voice: args.voice ?? deps.ttsVoice(exec),
		ffmpegPath: deps.ffmpegPath(exec),
	});
	if (!res.ok) {
		const kind = res.errorKind === "needs_tts" ? "NEEDS_TTS" : "BLOCKED";
		return { ok: false, operation: "voice", summary: kind, artifacts, detail: `${kind} — ${res.error}` };
	}
	artifacts.push(`${slug}/voice/${got.flow.id}/voice.json`, ...res.value.items.map((i) => `${slug}/${i.file}`));
	const total = res.value.items.reduce((a, i) => a + (i.durationSeconds ?? 0), 0);
	const missing = got.flow.steps.filter(
		(s) => s.procedure !== null && String(s.procedure).trim() !== "" && !res.value.items.some((i) => i.stepId === s.id),
	);
	return {
		ok: true,
		operation: "voice",
		summary: `Narrated ${res.value.items.length}/${got.flow.steps.length} steps of ${got.flow.id} (${total.toFixed(1)}s of audio).`,
		artifacts,
		detail:
			[
				`Voice: ${res.value.voice ?? "(engine default)"} — language ${res.value.language ?? "(unset)"}.`,
				`Files: ${res.value.items.map((i) => `${i.stepId}.wav (${i.durationSeconds !== null ? `${i.durationSeconds.toFixed(1)}s` : "duration unknown"})`).join(", ") || "none — no step has a procedure sentence yet"}.`,
				"Existing .wav files were kept (delete one to regenerate it).",
				missing.length > 0 ? `WARNING: ${missing.map((s) => s.id).join(", ")} failed or were skipped.` : "",
				"Next: operation=capture for this flow (the recording is timed per step), then operation=assemble.",
			]
				.filter(Boolean)
				.join("\n"),
	};
}

// ---------------------------------------------------------------------------
// capture — same engine as odoo_manual, but the recording is always on
// ---------------------------------------------------------------------------

async function captureOp(
	args: {
		flow?: string;
		from_step?: string;
		allow_actions?: boolean;
		confirm_destructive?: boolean;
		headed?: boolean;
		zoom?: number;
		browser?: "auto" | "chromium" | "chrome" | "msedge";
	},
	dir: string,
	slug: string,
	deps: VideoToolDeps,
	artifacts: string[],
	exec?: unknown,
): Promise<VideoToolResult> {
	const loaded = needStoryboard(dir, "capture", slug, artifacts);
	if (!loaded.ok) return loaded.result;
	const got = needFlow(loaded.sb, args.flow, "capture", artifacts);
	if (!got.ok) return got.result;

	const client = deps.client(exec);
	if (client === undefined) {
		return { ok: false, operation: "capture", summary: "NEEDS_INSTANCE", artifacts, detail: "NEEDS_INSTANCE — the browser needs the instance URL and version: run the connection onboarding (odoo_setup) first." };
	}
	const version = await client.version();
	if (!version.ok) {
		return { ok: false, operation: "capture", summary: "INSTANCE UNREACHABLE", artifacts, detail: `Cannot probe the server version: ${version.error}` };
	}
	const fam = familyFor(version.value.server_version);
	if (!fam.ok) return { ok: false, operation: "capture", summary: "BLOCKED", artifacts, detail: `BLOCKED — ${fam.error}` };

	const hasActions = got.flow.steps.some((s) => stepSafety(s.kind) === "action");
	if (hasActions && args.allow_actions !== true) {
		return {
			ok: false,
			operation: "capture",
			summary: "BLOCKED",
			artifacts,
			detail:
				"BLOCKED — this flow contains ACTION steps (new/fill/select/press/click) and allow_actions is not true. " +
				"Plan a read-only flow (goto/menu/explore/screenshot steps), or re-run with allow_actions=true AND confirm_destructive=true on a DISPOSABLE database: UI clicks are NOT journalable and cannot be undone by a checkpoint.",
		};
	}
	if (args.allow_actions === true && args.confirm_destructive !== true) {
		return {
			ok: false,
			operation: "capture",
			summary: "CONFIRM_REQUIRED",
			artifacts,
			detail: "CONFIRM_REQUIRED — allow_actions=true also needs confirm_destructive=true: the clicks are real UI effects on the instance that no journal can replay. Run against a disposable database.",
		};
	}

	const session = await deps.webSession(exec);
	if (!session.ok) {
		const kind = session.errorKind === "needs_session" ? "NEEDS_WEB_SESSION" : "BLOCKED";
		return { ok: false, operation: "capture", summary: kind, artifacts, detail: `${kind} — ${session.error}` };
	}
	const pw = await loadPlaywright();
	if (!pw.ok) return { ok: false, operation: "capture", summary: "NEEDS_BROWSER", artifacts, detail: `NEEDS_BROWSER — ${pw.error}` };
	const browserChoice = args.browser ?? "auto";
	const headed = args.headed === true;
	const opened = await resolveBrowser(pw.value.chromium, browserChoice, headed);
	if (!opened.ok) return { ok: false, operation: "capture", summary: "NEEDS_BROWSER", artifacts, detail: opened.error };

	try {
		const res = await captureFlow({
			session: session.value,
			browser: opened.value,
			family: fam.value.family,
			flow: got.flow,
			fromStep: args.from_step,
			allowActions: args.allow_actions === true,
			headed,
			zoom: args.zoom ?? 1,
			workspace: dir,
			video: true,
		});
		if (!res.ok) return { ok: false, operation: "capture", summary: "BLOCKED", artifacts, detail: `BLOCKED — ${res.error}` };
		if (!res.value.video) {
			return { ok: false, operation: "capture", summary: "BLOCKED", artifacts, detail: "BLOCKED — the run produced no recording (video was requested): this is a plugin bug, please report it." };
		}
		artifacts.push("capture.json", res.value.video.file, ...res.value.steps.filter((s) => s.screenshot).map((s) => s.screenshot?.file ?? ""));
		// Record the stills on the storyboard (create-only merge per step id).
		// Best-effort: the capture itself already succeeded, so a storyboard
		// re-read problem must not turn the run into a failure.
		try {
			const sb = readStoryboard(dir);
			if (sb) {
				const flow = sb.flows.find((f) => f.id === got.flow.id);
				if (flow) {
					const captures = res.value.steps
						.filter((s) => s.screenshot !== undefined)
						.map((s) => ({ stepId: s.id, file: s.screenshot?.file ?? "", width: s.screenshot?.width, height: s.screenshot?.height }));
					flow.captures = [...(flow.captures ?? []), ...captures.filter((c) => !(flow.captures ?? []).some((k) => k.stepId === c.stepId))];
					writeStoryboard(dir, sb);
					artifacts.push("storyboard.json");
				}
			}
		} catch {
			// keep the capture result
		}
		const failed = res.value.steps.find((s) => s.status === "error");
		const okCount = res.value.steps.filter((s) => s.status === "ok").length;
		return {
			ok: true,
			operation: "capture",
			summary: `Recorded ${okCount}/${got.flow.steps.length} steps of ${got.flow.id} (browser: ${browserChoice}, webm ${(res.value.video.bytes / 1_048_576).toFixed(1)} MiB).`,
			artifacts,
			detail:
				[
					`Recording: ${res.value.video.file} (${res.value.video.bytes} bytes) — every OK step carries startMs/endMs offsets for the assembler.`,
					`Stills: ${res.value.steps.filter((s) => s.screenshot).length} PNG thumbnail(s) under images/.`,
					failed
						? `Stopped at step ${failed.id} (${failed.kind}): ${failed.error ?? "error"} — the video will truncate here; fix the storyboard and re-run with from_step="${failed.id}".`
						: "All steps captured.",
					"Next: operation=assemble for this flow (voice first if you want narration).",
				].join("\n"),
		};
	} finally {
		await opened.value.close().catch(() => {});
	}
}

// ---------------------------------------------------------------------------
// assemble — ffmpeg cut + freeze + mux, captions always
// ---------------------------------------------------------------------------

async function assembleOp(
	args: { flow?: string; captions?: boolean },
	dir: string,
	slug: string,
	deps: VideoToolDeps,
	artifacts: string[],
	exec?: unknown,
): Promise<VideoToolResult> {
	const loaded = needStoryboard(dir, "assemble", slug, artifacts);
	if (!loaded.ok) return loaded.result;
	const got = needFlow(loaded.sb, args.flow, "assemble", artifacts);
	if (!got.ok) return got.result;
	const res = await assembleVideo({
		workspace: dir,
		flow: got.flow,
		language: loaded.sb.language,
		ffmpegPath: deps.ffmpegPath(exec),
		captions: args.captions === true,
	});
	if (!res.ok) {
		const kind = res.errorKind === "needs_video_capture" ? "NEEDS_VIDEO_CAPTURE" : res.errorKind === "needs_ffmpeg" ? "NEEDS_FFMPEG" : "BLOCKED";
		return { ok: false, operation: "assemble", summary: kind, artifacts, detail: `${kind} — ${res.error}` };
	}
	artifacts.push(`${slug}/${res.value.file}`, `${slug}/video/${got.flow.id}.srt`, `${slug}/video/${got.flow.id}.vtt`, `${slug}/video/video.json`);
	return {
		ok: true,
		operation: "assemble",
		summary: `${res.value.file}: ${res.value.segments} segment(s), ${res.value.durationSeconds !== null ? `${res.value.durationSeconds.toFixed(1)}s` : "duration unknown"}, ${res.value.narrated ? "narrated" : "silent"}${res.value.captions ? ", captions burned" : ""}.`,
		artifacts,
		detail:
			[
				`Video: ${res.value.file} (${(res.value.bytes / 1_048_576).toFixed(2)} MiB, language track ${(res.value.language ?? "en").split(/[-_]/)[0]}).`,
				`Captions: video/${got.flow.id}.srt + .vtt (always shipped — they are also the export path to external video platforms).`,
				res.value.truncatedAt ? `TRUNCATED at step ${res.value.truncatedAt}: the capture failed there; fix the storyboard and re-run capture with from_step.` : "Full flow assembled.",
				res.value.captionsNote ? `NOTE: ${res.value.captionsNote}` : "",
				"The raw webm under video/raw/ is kept: re-assembly (other voice, other timing) never needs a re-capture.",
			]
				.filter(Boolean)
				.join("\n"),
	};
}
