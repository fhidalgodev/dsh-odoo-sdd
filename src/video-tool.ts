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
import { existsSync, readdirSync } from "node:fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { writeFileAtomic } from "./atomic.js";
import {
	resolveManualWorkspace,
	readStoryboard,
	nextFlowId,
	stepSafety,
	writeStoryboard,
	planStoryboard,
	type Flow,
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
import { needsTtsMessage, readVoiceReport, voiceFlow } from "./video-voice.js";
import { resolveVoiceEngine } from "./video-voices.js";
import { assembleVideo, readSeries } from "./video-assemble.js";
import { numberFlows, renderReadme, shouldWriteReadme, type SeriesMeta } from "./video-index.js";
import { computeCoverage, formatCoverage, seedCoverageFlows } from "./video-coverage.js";
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
	/** ttsPreset config: the chosen voice character ("" = undecided). */
	ttsPreset: (exec?: unknown) => string | null;
	/** videoMusic config (default true): synthesized music bed under the voice. */
	videoMusic: (exec?: unknown) => boolean;
	/** videoSfx config (default true): synthesized UI sound effects. */
	videoSfx: (exec?: unknown) => boolean;
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
				"operation=voice narrates it with the configured voice engine (ttsPreset, or a custom ttsCommand); " +
				"operation=capture records the browser session (webm + per-step timestamps) — read-only steps always, " +
				"ACTION steps only with allow_actions=true AND confirm_destructive=true on a DISPOSABLE database; " +
				"operation=assemble cuts, pads to the narration and muxes <NN-slug>.mp4 at the workspace root with " +
				"ffmpeg — SRT/VTT captions ALWAYS ship; operation=index regenerates the series README.md. " +
				"It never writes MANUAL.md: odoo_manual stays untouched.",
			parameters: {
				operation: {
					type: "string",
					required: true,
					enum: ["plan", "voice", "capture", "assemble", "index", "audit"],
					description:
						"plan: draft the video storyboard from the instance canon, or import a manual's canon+storyboard (from_manual). " +
						"voice: narrate each step's procedure with the resolved voice engine (idempotent per .wav). " +
						"capture: run the flow in a real browser and RECORD it (video always on); ACTION steps need allow_actions=true + confirm_destructive=true. " +
						"assemble: cut the recording by step, freeze frames to fit the narration, mux <NN-slug>.mp4 + .srt/.vtt at the workspace root. " +
						"index: regenerate the series README.md (groups, durations, progress) and report orphan media files. " +
						"audit: print the coverage matrix of the module (read-only — what the series still owes).",
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
						"voice: engine-specific voice string (e.g. es-ES-AlvaroNeural for edge-tts, a .onnx path for piper). " +
						"Overrides ONLY the concrete voice of the resolved engine — the preset still picks character and rate.",
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
					description: "assemble: BURN the captions in (drawtext; default true, needs a known font). SRT/VTT always ship regardless.",
				},
				music: {
					type: "boolean",
					description: "assemble: synthesized music bed with voice ducking (default: config videoMusic).",
				},
				sfx: {
					type: "boolean",
					description: "assemble: synthesized UI sfx per step kind (default: config videoSfx).",
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
				operation: "plan" | "voice" | "capture" | "assemble" | "index" | "audit";
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
				music?: boolean;
				sfx?: boolean;
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
				if (args.operation === "voice") return voiceOp(args, ws.dir, slug, deps, artifacts, exec);
				if (args.operation === "capture") return captureOp(args, ws.dir, slug, deps, artifacts, exec);
				if (args.operation === "index") return indexOp(args, ws.dir, slug, deps, artifacts);
				if (args.operation === "audit") return auditOp(ws.dir, slug, artifacts);
				return assembleOp(args, ws.dir, slug, deps, artifacts, exec);
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
		}
		const grouped = assignGroups(sb);
		const seeded = seedCoverageFlows(sb, readVideoCanonSurface(dir) ?? { actionXmlids: [], menuXmlids: [] });
		writeStoryboard(dir, sb);
		artifacts.push(`${slug}/storyboard.json`, `${slug}/canon.json`);
		const findings = validateVideoStoryboard(sb, readVideoCanonSurface(dir));
		lines.push(`Imported from manual "${args.from_manual}": ${imported.value.flows} flow(s), ${imported.value.steps} step(s), ${imported.value.narrated} narrated.`);
		lines.push(`Language: ${sb.language} (inherited from the manual — narration and captions use it).`);
		if (grouped > 0) lines.push(`Groups: ${grouped} flow(s) got a section name from the menu/model heuristic — re-group by feature if it fits the series better.`);
		if (seeded > 0) lines.push(`Coverage: ${seeded} flow(s) seeded for the module's uncovered refs — narrate their steps (or videoSkip with a reason).`);
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
	const grouped = assignGroups(sb);
	const seeded = seedCoverageFlows(sb, readVideoCanonSurface(dir) ?? { actionXmlids: [], menuXmlids: [] });
	writeStoryboard(dir, sb);
	artifacts.push(`${slug}/storyboard.json`);

	const findings = validateVideoStoryboard(sb, readVideoCanonSurface(dir));
	const steps = sb.flows.reduce((a, f) => a + f.steps.length, 0);
	lines.push(`Storyboard planned from the canon: ${sb.flows.length} flow(s), ${steps} step(s), fingerprint ${fingerprint.slice(0, 12)}….`);
	lines.push(`Language: ${sb.language} (write every procedure sentence in it — it is the narration AND caption script).`);
	if (grouped > 0) lines.push(`Groups: ${grouped} flow(s) got a section name from the menu/model heuristic — re-group by feature if it fits the series better.`);
	if (seeded > 0) lines.push(`Coverage: ${seeded} flow(s) seeded for the module's uncovered refs — narrate their steps (or videoSkip with a reason).`);
	lines.push(...findingLines(findings));
	lines.push("");
	lines.push("Next: write ONE sentence per step (procedure), then voice → capture → assemble per flow.");
	return { ok: true, operation: "plan", summary: `planned ${sb.flows.length} flow(s), ${steps} step(s); ${findings.length} finding(s)`, artifacts, detail: lines.join("\n") };
}

function findingLines(findings: { severity: string; rule: string; message: string; flow?: string; step?: string }[]): string[] {
	if (findings.length === 0) return ["No findings."];
	return findings.map((f) => `- [${f.severity}] ${f.rule}${f.flow ? ` (${f.flow}${f.step ? `/${f.step}` : ""})` : ""}: ${f.message}`);
}

/**
 * The section a planned flow most likely belongs to, as a FIRST guess the
 * storyteller can re-group from (they may organize by feature, not by menu).
 * A menu flow titles itself after the menu path ("App / Section / Screen"),
 * so its section is the path's second segment — the first is the app itself;
 * a model flow belongs under its model's name. Anything else is left for the
 * author (GROUP-MISSING names it). An existing group is NEVER overwritten.
 */
function guessFlowGroup(flow: Flow): string | undefined {
	if ((flow.group ?? "").trim() !== "") return undefined;
	if (flow.kind === "menu") {
		const segments = (flow.title ?? "").split(" / ").map((s) => s.trim()).filter((s) => s !== "");
		return segments.length >= 3 ? segments[1] : segments[0] || undefined;
	}
	if (flow.kind === "model") return flow.model ?? (flow.title.trim() !== "" ? flow.title : undefined);
	return undefined;
}

/** Fill flow.group where the heuristic can — never overwrite the author's. */
function assignGroups(sb: Storyboard): number {
	let assigned = 0;
	for (const flow of sb.flows) {
		const group = guessFlowGroup(flow);
		if (group) {
			flow.group = group;
			assigned += 1;
		}
	}
	return assigned;
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
	// The engine is resolved HERE (the tool layer): a preset supplies both the
	// command template and the concrete voice; the call param `voice`
	// overrides only that voice string, never the chosen engine.
	const engine = resolveVoiceEngine({
		ttsPreset: deps.ttsPreset(exec),
		ttsCommand: deps.ttsCommand(exec),
		ttsVoice: args.voice ?? deps.ttsVoice(exec),
		language: loaded.sb.language,
	});
	if (!engine) {
		return { ok: false, operation: "voice", summary: "NEEDS_TTS", artifacts, detail: needsTtsMessage(loaded.sb.language) };
	}
	if (engine.presetId === "offline-piper" && !engine.voice) {
		return {
			ok: false,
			operation: "voice",
			summary: "NEEDS_TTS",
			artifacts,
			detail:
				"NEEDS_TTS — the offline-piper preset needs ttsVoice set to the piper .onnx MODEL FILE (e.g. " +
				"ttsVoice=/path/to/es_ES-sharvard-medium.onnx, or the voice param of this call). " +
				"Pick another preset to use a cloud engine instead.",
		};
	}
	const res = await voiceFlow({
		workspace: dir,
		flow: got.flow,
		language: loaded.sb.language,
		ttsCommand: engine.command,
		voice: engine.voice,
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

	// When the voice already exists each step holds the live page for its
	// narration (+ tail), so the recording carries real screen time instead of
	// the fixed dwell — the assembler then freezes almost nothing. _hook and
	// _outro are not steps, so they never enter the map.
	const voice = readVoiceReport(dir, got.flow.id);
	const holdMsByStep: Record<string, number> = {};
	for (const item of voice?.items ?? []) {
		if (item.stepId.startsWith("_")) continue;
		if (item.durationSeconds !== null && item.durationSeconds > 0) {
			holdMsByStep[item.stepId] = Math.round(item.durationSeconds * 1000 + 350);
		}
	}

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
			...(Object.keys(holdMsByStep).length > 0 ? { holdMsByStep } : {}),
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
					Object.keys(holdMsByStep).length > 0
						? `Holds: ${Object.keys(holdMsByStep).length} step(s) held for their narration length (voice report present).`
						: "Holds: fixed dwell per step — voice first, then capture: each step is held for its narration.",
					"Next: operation=assemble for this flow (voice first if you want narration).",
				].join("\n"),
		};
	} finally {
		await opened.value.close().catch(() => {});
	}
}

// ---------------------------------------------------------------------------
// assemble — ffmpeg cut + freeze + mux into the series layout, captions always
// ---------------------------------------------------------------------------

/**
 * Regenerate the series README from the CURRENT storyboard + series.json,
 * and report `NN-*` media files at the workspace root that no current flow
 * owns (renamed or deleted flows leave them behind; the tool never deletes
 * them on its own — a README update is safe, a media file is user data).
 */
function refreshSeriesIndex(dir: string, sb: Storyboard): { readme: string | null; orphans: string[]; gapCount: number; error?: string } {
	const numbered = numberFlows(sb);
	if (!numbered.ok) return { readme: null, orphans: [], gapCount: 0, error: numbered.error };
	const series = readSeries(dir);
	const meta: SeriesMeta = {};
	for (const item of numbered.items) {
		const report = series.flows[item.flow.id];
		meta[item.flow.id] = {
			file: report?.file ?? `${item.stem}.mp4`,
			durationSeconds: report?.durationSeconds ?? null,
			steps: item.flow.steps.length,
		};
	}
	const coverage = computeCoverage(sb, readVideoCanonSurface(dir) ?? { actionXmlids: [], menuXmlids: [] });
	let readme: string | null = null;
	if (shouldWriteReadme(numbered.items)) {
		writeFileAtomic(
			join(dir, "README.md"),
			renderReadme({
				sb,
				items: numbered.items,
				meta,
				coverage: { gaps: coverage.gaps.map((g) => ({ ref: g.ref, label: g.label })), total: coverage.items.length, covered: coverage.items.filter((i) => coverage.covered.has(i.ref) || coverage.skipped[i.ref] !== undefined).length },
			}),
		);
		readme = "README.md";
	}
	const stems = new Set(numbered.items.map((i) => i.stem));
	const orphans = readdirSync(dir)
		.filter((name) => /^\d{2,}-.+\.(mp4|srt|vtt)$/i.test(name))
		.filter((name) => !stems.has(name.replace(/\.(mp4|srt|vtt)$/i, "")));
	return { readme, orphans, gapCount: coverage.gaps.length };
}

async function assembleOp(
	args: { flow?: string; captions?: boolean; music?: boolean; sfx?: boolean },
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
	const numbered = numberFlows(loaded.sb);
	if (!numbered.ok) return { ok: false, operation: "assemble", summary: "BLOCKED", artifacts, detail: `BLOCKED — ${numbered.error}` };
	const numberedFlow = numbered.items.find((i) => i.flow.id === got.flow.id);
	if (!numberedFlow) {
		return { ok: false, operation: "assemble", summary: "BLOCKED", artifacts, detail: `BLOCKED — flow ${got.flow.id} is not in the storyboard numbering.` };
	}
	const previousFile = readSeries(dir).flows[got.flow.id]?.file;
	// The series context the video dresses itself with: "NN · Group — Title"
	// (no redundant group when it IS the storyboard name) and the next title
	// for the outro's "next" pill.
	const groupName = numberedFlow.group === loaded.sb.slug ? "" : numberedFlow.group;
	const chapterLabel = `${String(numberedFlow.number).padStart(2, "0")} · ${groupName !== "" ? `${groupName} — ` : ""}${numberedFlow.flow.title}`;
	const idx = numbered.items.findIndex((i) => i.flow.id === got.flow.id);
	const nextTitle = idx >= 0 && idx + 1 < numbered.items.length ? numbered.items[idx + 1].flow.title : undefined;
	const res = await assembleVideo({
		workspace: dir,
		flow: got.flow,
		language: loaded.sb.language,
		ffmpegPath: deps.ffmpegPath(exec),
		captions: args.captions !== false,
		stem: numberedFlow.stem,
		previousFile,
		title: got.flow.title,
		chapterLabel,
		nextTitle,
		music: args.music ?? deps.videoMusic(exec),
		sfx: args.sfx ?? deps.videoSfx(exec),
	});
	if (!res.ok) {
		const kind = res.errorKind === "needs_video_capture" ? "NEEDS_VIDEO_CAPTURE" : res.errorKind === "needs_ffmpeg" ? "NEEDS_FFMPEG" : "BLOCKED";
		return { ok: false, operation: "assemble", summary: kind, artifacts, detail: `${kind} — ${res.error}` };
	}
	artifacts.push(
		`${slug}/${res.value.file}`,
		`${slug}/${numberedFlow.stem}.srt`,
		`${slug}/${numberedFlow.stem}.vtt`,
		`${slug}/video/video.json`,
		`${slug}/video/series.json`,
	);
	// The README belongs to the SERIES: with more than one flow every assemble
	// refreshes it, so the guide is never stale relative to the files on disk.
	const indexed = loaded.sb.flows.length > 1 ? refreshSeriesIndex(dir, loaded.sb) : { readme: null, orphans: [] as string[], gapCount: 0 };
	if (indexed.readme) artifacts.push(`${slug}/${indexed.readme}`);
	return {
		ok: true,
		operation: "assemble",
		summary: `${res.value.file}: ${res.value.segments} segment(s), ${res.value.durationSeconds !== null ? `${res.value.durationSeconds.toFixed(1)}s` : "duration unknown"}, ${res.value.narrated ? "narrated" : "silent"}${res.value.captions ? ", captions burned" : ""}.`,
		artifacts,
		detail:
			[
				`Video: ${res.value.file} (${(res.value.bytes / 1_048_576).toFixed(2)} MiB, language track ${(res.value.language ?? "en").split(/[-_]/)[0]}).`,
				`Assembly: ${[res.value.hook ? "hook" : null, res.value.outro ? "outro" : null, "zoom", res.value.captions ? "captions" : null, res.value.music ? "music" : null, res.value.sfx ? "sfx" : null].filter(Boolean).join(", ")}${res.value.loudnessLufs !== undefined ? ` — ${res.value.loudnessLufs.toFixed(1)} LUFS` : ""}.`,
				`Captions: ${numberedFlow.stem}.srt + .vtt next to the video (always shipped — they are also the export path to external video platforms).`,
				res.value.truncatedAt ? `TRUNCATED at step ${res.value.truncatedAt}: the capture failed there; fix the storyboard and re-run capture with from_step.` : "Full flow assembled.",
				res.value.captionsNote ? `NOTE: ${res.value.captionsNote}` : "",
				indexed.readme ? "Series guide: README.md regenerated." : "",
				indexed.error ? `WARNING: the series index could not be refreshed: ${indexed.error}` : "",
				(indexed.orphans ?? []).length > 0 ? `ORPHANS at the workspace root: ${(indexed.orphans ?? []).join(", ")} — no current flow owns them; delete them by hand if obsolete.` : "",
				"The raw webm under video/raw/ is kept: re-assembly (other voice, other timing) never needs a re-capture.",
			]
				.filter(Boolean)
				.join("\n"),
	};
}

// ---------------------------------------------------------------------------
// index — regenerate the series README and report orphan media
// ---------------------------------------------------------------------------

async function indexOp(
	_args: { flow?: string },
	dir: string,
	slug: string,
	_deps: VideoToolDeps,
	artifacts: string[],
): Promise<VideoToolResult> {
	const loaded = needStoryboard(dir, "index", slug, artifacts);
	if (!loaded.ok) return loaded.result;
	const indexed = refreshSeriesIndex(dir, loaded.sb);
	if (indexed.error) return { ok: false, operation: "index", summary: "BLOCKED", artifacts, detail: `BLOCKED — ${indexed.error}` };
	if (indexed.readme) artifacts.push(`${slug}/${indexed.readme}`);
	const series = readSeries(dir);
	const assembled = loaded.sb.flows.filter((f) => series.flows[f.id]).length;
	// The index still writes the README (its coverage section names the
	// gaps), but a series with uncovered refs is not DONE — ok:false is how
	// the caller learns that without parsing prose.
	const gaps = indexed.gapCount;
	const detail =
		[
			indexed.readme ? `Series guide written to ${slug}/README.md.` : "A README needs at least 2 videos — write more flows and re-run index.",
			`Assembled: ${assembled}/${loaded.sb.flows.length} flow(s) (see video/series.json).`,
			gaps > 0 ? `COVERAGE: ${gaps} ref(s) still uncovered — run operation=audit for the matrix, then narrate, cover or videoSkip them.` : "Coverage: 100%.",
			indexed.orphans.length > 0 ? `ORPHANS at the workspace root: ${indexed.orphans.join(", ")} — media files no current flow owns; delete them by hand if obsolete.` : "No orphan media files.",
		].join("\n");
	return {
		ok: gaps === 0,
		operation: "index",
		summary: gaps > 0 ? `COVERAGE GAPS ${gaps}` : indexed.readme ? `README.md regenerated (${assembled}/${loaded.sb.flows.length} video(s) assembled).` : `Series too small for a README (${loaded.sb.flows.length} flow) — nothing written.`,
		artifacts,
		detail,
	};
}

// ---------------------------------------------------------------------------
// audit — the coverage matrix, read-only
// ---------------------------------------------------------------------------

async function auditOp(dir: string, slug: string, artifacts: string[]): Promise<VideoToolResult> {
	const loaded = needStoryboard(dir, "audit", slug, artifacts);
	if (!loaded.ok) return loaded.result;
	const surface = readVideoCanonSurface(dir);
	const coverage = computeCoverage(loaded.sb, surface ?? { actionXmlids: [], menuXmlids: [] });
	const total = coverage.items.length;
	const covered = coverage.items.filter((i) => coverage.covered.has(i.ref) || coverage.skipped[i.ref] !== undefined).length;
	const findings = validateVideoStoryboard(loaded.sb, surface);
	return {
		ok: true,
		operation: "audit",
		summary: `coverage ${covered}/${total}`,
		artifacts,
		detail:
			total === 0
				? "No module inventory in canon.json — coverage does not apply to a per-model canon."
				: [...formatCoverage(coverage), "", ...findingLines(findings)].join("\n"),
	};
}
