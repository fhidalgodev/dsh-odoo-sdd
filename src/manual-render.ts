/**
 * Deterministic renderers for the narrated manuals (Motor 2). The same
 * storyboard + canon always render byte-identical output: render.json records
 * the sha256 of every emitted file, and a file that was edited by hand is
 * NEVER overwritten (without `overwrite: true` the renderer writes into
 * `<workspace>/render/` and reports what it skipped).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";
import type { Canon } from "./manual-canon.js";
import type { Storyboard, Flow } from "./manual-model.js";
import { sha256Of } from "./manual-model.js";
import type { ProseFinding } from "./prose-lint.js";
import { lintProse } from "./prose-lint.js";

const lintProseText = (text: string, labels?: string[]): ProseFinding[] => lintProse(text, { canonLabels: labels });

export interface RenderResult {
	written: string[];
	skipped: Array<{ file: string; reason: string }>;
	renderJson: RenderJson;
}

interface RenderJson {
	schema: "dsh-odoo-sdd/render/1";
	files: Record<string, string>;
}

const escapeHtml = (s: string): string =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One numbered step line: ONE sentence of procedure plus its image (alt on). */
function stepLines(flow: Flow, markdown: string[]): void {
	flow.steps.forEach((s, idx) => {
		const proc = s.procedure ?? "TODO: narrate this step in one sentence.";
		const images = (flow.captures ?? []).filter((c) => c.stepId === s.id);
		let line = `${idx + 1}. ${proc}`;
		// capture paths are workspace-relative already (images/…)
		if (images.length > 0) line += ` ![step ${s.id}](${images[0].file})`;
		markdown.push(line);
		if (s.note) markdown.push("", `> ${s.note}`);
	});
}

/**
 * The coverage sections a manual owes once the canon was read module-wide: every
 * field (with the TYPE the canon measured, never guessed), every button with the
 * states it shows in, the workflow between those states, and what each access
 * group does. A model the server refused is named, not silently omitted.
 */
function coverageSections(sb: Storyboard, canon: Canon | null, t: (es: string, en: string) => string): string[] {
	const out: string[] = [];
	const inventories = canon?.modules ?? (canon?.module ? [canon.module] : []);
	const docs = sb.docs?.models ?? {};
	const cell = (s: string): string => s.replace(/\|/g, "\\|");
	for (const inventory of inventories) {
		for (const doc of inventory.models) {
			out.push(`### ${t("El modelo", "The model")} \`${doc.model}\`${doc.name && doc.name !== doc.model ? ` — ${doc.name}` : ""}`, "");
			if (doc.unreadable) {
				out.push(t(`> No se pudo leer este modelo (${doc.unreadable}); sus campos quedan sin documentar hasta que la lectura funcione.`, `> This model could not be read (${doc.unreadable}); its fields stay undocumented until the read succeeds.`), "");
				continue;
			}
			const written = docs[doc.model] ?? {};
			if (doc.fields.length > 0) {
				out.push(t("**Campos**", "**Fields**"), "");
				out.push(t("| Campo | Etiqueta | Tipo | Obligatorio | Relación / Selección | Grupos | Para qué sirve |", "| Field | Label | Type | Required | Relation / Selection | Groups | What it is for |"), "|---|---|---|---|---|---|---|");
				for (const f of doc.fields) {
					const rel = f.relation ?? (f.selection ? f.selection.map((s) => `${s[0]}=${s[1]}`).join(" · ") : "");
					const prose = (written.fields?.[f.name] ?? "").trim() || (written.skip?.[f.name] ? `— (${written.skip[f.name]})` : "—");
					out.push(`| ${cell(f.name)} | ${cell(f.string)} | \`${cell(f.type)}\` | ${f.required ? t("Sí", "Yes") : t("No", "No")} | ${cell(rel)} | ${cell((f.groups ?? []).join(", "))} | ${cell(prose)} |`);
				}
				out.push("");
			}
			const buttons = doc.buttons.filter((b) => b.name);
			if (buttons.length > 0) {
				out.push(t("**Botones y en qué estado aparecen**", "**Buttons and the state they show in**"), "");
				out.push(t("| Botón | Etiqueta | Estados | Grupos | Confirma | Para qué sirve |", "| Button | Label | States | Groups | Confirms | What it does |"), "|---|---|---|---|---|---|");
				for (const b of buttons) {
					const prose = (written.buttons?.[b.name] ?? "").trim() || (written.skip?.[b.name] ? `— (${written.skip[b.name]})` : "—");
					out.push(`| \`${cell(b.name)}\` | ${cell(b.string ?? "")} | ${cell((b.visibleStates ?? []).join(", ") || t("todos", "all"))} | ${cell((b.groups ?? []).join(", "))} | ${b.confirm ? t("Sí", "Yes") : t("No", "No")} | ${cell(prose)} |`);
				}
				out.push("");
			}
			const workflow = (written.workflow ?? "").trim();
			if (workflow !== "" || doc.statusbar) {
				out.push(t("**Workflow**", "**Workflow**"), "");
				if (doc.statusbar) out.push(`> ${t("Estados", "States")}: ${escapeHtml([doc.statusbar.field, ...(doc.statusbar.visibleStates ?? [])].filter(Boolean).join(" → "))}`, "");
				out.push(workflow !== "" ? workflow : t("TODO: describe el workflow de este modelo.", "TODO: describe this model's workflow."), "");
			}
		}
	}
	// Per group: what that group can do, top-down — the flows written for it,
	// and the menus it can see when the canon recorded the restriction.
	const groups = canon?.interview?.groups ?? sb.interview?.groups ?? [];
	if (groups.length > 0) {
		out.push(t("### Por cada grupo de acceso", "### Per access group"), "");
		for (const group of groups) {
			const flows = sb.flows.filter((f) => f.role === group);
			const menus = inventories.flatMap((m) => m.menus).filter((m) => m.groups?.includes(group)).map((m) => m.completeName);
			out.push(`#### ${group}`, "");
			if (menus.length > 0) out.push(t("Menús que ve", "Menus it sees") + ": " + menus.map((m) => `\`${m}\``).join(", "), "");
			if (flows.length > 0) for (const f of flows) out.push(t(`- ${f.title}`, `- ${f.title}`));
			else out.push(t(`- (sin flujo propio: ${(sb.docs?.groupsWhy ?? "TODO").trim() || "TODO"})`, `- (no flow of its own: ${(sb.docs?.groupsWhy ?? "TODO").trim() || "TODO"})`));
			out.push("");
		}
	}
	return out;
}

/** The Markdown manual: H2 leads (the OCA bot owns the H1), 3 acts. */
export function renderManualMarkdown(sb: Storyboard, canon: Canon | null): string {
	const t = (es: string, en: string) => (sb.language?.startsWith("es") || canon?.language.startsWith("es") ? es : en);
	const out: string[] = [];
	// Act I — CONTEXT (StoryBrand: the user is the hero, the manual is the guide)
	out.push(`## ${t("Para qué sirve", "What it is for")}`, "");
	out.push(
		t(
			`Esta guía explica cómo usar ${canon?.model ?? sb.slug} en Odoo: qué hace cada pantalla, qué hace Odoo por detrás y qué hacer cuando algo falla.`,
			`This guide explains how to use ${canon?.model ?? sb.slug} in Odoo: what each screen does, what Odoo does behind it, and what to do when something fails.`,
		),
		"",
	);
	// The audience the interview declared: a manual that does not say who it is
	// written for is a manual nobody can check.
	const asUser = sb.interview?.asUser ?? canon?.interview?.asUser ?? null;
	if (asUser !== null || sb.interview !== undefined || canon?.interview !== undefined) {
		const admin = sb.interview?.admin ?? canon?.interview?.admin ?? false;
		const modules = sb.interview?.modules ?? canon?.interview?.modules ?? [];
		out.push(
			t(
				`**Para quién**: ${asUser ?? "—"}${admin ? " (administrador)" : ""}${modules.length > 0 ? ` · módulos: ${modules.join(", ")}` : ""}.`,
				`**Written for**: ${asUser ?? "—"}${admin ? " (administrator)" : ""}${modules.length > 0 ? ` · modules: ${modules.join(", ")}` : ""}.`,
			),
			"",
		);
	}
	// Act II — USAGE, flow by flow
	for (const flow of sb.flows) {
		out.push(`### ${flow.title || flow.id}`, "");
		if (flow.audience) out.push(t(`Para: ${flow.audience}`, `For: ${flow.audience}`), "");
		out.push(t("**Procedimiento**", "**Procedure**"), "");
		stepLines(flow, out);
		if (flow.recovery) out.push("", t("**Si algo falla**", "**If it fails**"), "", `> ${flow.recovery}`, "");
	}
	// Act II-b — the coverage the canon evidences: every field, every button,
	// every state, and what each access group does.
	for (const line of coverageSections(sb, canon, t)) out.push(line);
	// Process block: what Odoo does behind the scenes (quote, not procedure)
	if (canon) {
		const statusbar = canon.views.find((v) => v.type === "form")?.arch.statusbar;
		if (statusbar) {
			out.push(t("### Qué hace Odoo por detrás", "### What Odoo does behind the scenes"), "");
			out.push(
				"> " +
					t(
						`El registro pasa por los estados ${statusbar.visibleStates?.join(", ") ?? "(definidos en el modelo)"}; cada botón del encabezado valida condiciones del modelo antes de cambiar de estado.`,
						`The record moves through the states ${statusbar.visibleStates?.join(", ") ?? "(defined on the model)"}; each header button checks model conditions before switching state.`,
					),
				"",
			);
		}
	}
	// Act III — troubleshooting from the canon's error catalog
	const errors = [
		...(canon?.errors.own?.errors ?? []),
		...(canon?.errors.community?.errors ?? []),
		...(canon?.errors.enterprise?.errors ?? []),
	];
	if (errors.length > 0) {
		out.push(t("### Si ves un error", "### If you see an error"), "");
		out.push(t("| Mensaje | Cuándo ocurre |", "| Message | When it happens |"), "|---|---|");
		for (const e of errors.slice(0, 20)) {
			out.push(`| ${e.message.replace(/\|/g, "\\|")} | ${t(`al ejecutar ${e.method ?? "la acción"}`, `when running ${e.method ?? "the action"}`)} |`);
		}
		out.push("");
	}
	// ERD: relations the canon read
	const relations = (canon?.fields ?? []).filter((f) => f.relation);
	if (relations.length > 0) {
		out.push(t("### De qué depende", "### What it relates to"), "");
		for (const f of relations) out.push(`- \`${canon?.model}\` → \`${f.relation}\` (${f.name})`);
		out.push("");
	}
	return out.join("\n");
}

/** The Odoo Apps `index.html`: oe_container/oe_slogan/oe_dark, Bootstrap alert, no script, no inline style. */
export function renderIndexHtml(sb: Storyboard, canon: Canon | null): string {
	const md = renderManualMarkdown(sb, canon);
	const body = md
		.split("\n")
		.map((line, i, arr) => {
			if (/^##\s/.test(line)) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
			if (/^###\s/.test(line)) return `<h3>${escapeHtml(line.slice(4))}</h3>`;
			if (/^>\s?/.test(line)) return `<div class="alert alert-info" role="alert">${escapeHtml(line.replace(/^>\s?/, ""))}</div>`;
			if (/^\d+\.\s/.test(line)) return `<p class="oe_ml8">${escapeHtml(line)}</p>`;
			if (/^-\s/.test(line)) return `<p class="oe_ml8">${escapeHtml("• " + line.slice(2))}</p>`;
			if (/^\|/.test(line)) {
				const cells = line.split("|").filter((c) => c.trim() !== "");
				if (cells.every((c) => /^-+$/.test(c.trim()))) return "";
				return `<p>${cells.map((c) => escapeHtml(c.trim())).join(" | ")}</p>`;
			}
			return line.trim() === "" ? "" : `<p>${escapeHtml(line)}</p>`;
		})
		.filter((l) => l !== "")
		.join("\n");
	return [
		'<section class="oe_container">',
		'<div class="oe_row">',
		'<h2 class="oe_slogan">' + escapeHtml(sb.slug.replace(/[-_]/g, " ")) + "</h2>",
		body,
		"</div>",
		'<div class="oe_dark oe_mb16"><div class="oe_row"><p>' +
			escapeHtml(canon ? `Documented against ${canon.model} (Odoo ${canon.serverVersion}).` : "Documented against the model's functional canon.") +
			"</p></div></div>",
		"</section>",
		"",
	].join("\n");
}

/**
 * Write the rendered artifacts. Without `overwrite` the output lands in
 * `<workspace>/render/`; a file whose current hash differs from the one
 * render.json recorded was edited by hand and is skipped.
 */
export function renderManual(
	workspace: string,
	sb: Storyboard,
	canon: Canon | null,
	opts?: { overwrite?: boolean; language?: string },
): RenderResult {
	if (opts?.language) sb.language = opts.language;
	const inPlace = opts?.overwrite === true;
	const outDir = inPlace ? workspace : join(workspace, "render");
	mkdirSync(outDir, { recursive: true });
	const renderFile = join(outDir, "render.json");
	const previous: RenderJson = existsSync(renderFile)
		? (JSON.parse(readFileSync(renderFile, "utf8")) as RenderJson)
		: { schema: "dsh-odoo-sdd/render/1", files: {} };
	const result: RenderResult = { written: [], skipped: [], renderJson: previous };
	const emit = (name: string, content: string): void => {
		const target = join(outDir, name);
		if (existsSync(target)) {
			const current = sha256Of(readFileSync(target));
			if (previous.files[name] && previous.files[name] !== current) {
				result.skipped.push({ file: name, reason: "edited by hand since the last render (use overwrite=true to take it over)." });
				return;
			}
		}
		writeFileAtomic(target, content);
		previous.files[name] = sha256Of(content);
		result.written.push(name);
	};
	emit("MANUAL.md", renderManualMarkdown(sb, canon));
	emit("index.html", renderIndexHtml(sb, canon));
	writeFileSync(renderFile, JSON.stringify(previous, null, 2) + "\n", { mode: 0o600 });
	return result;
}

/** Lint the storyboard's own narration plus any rendered MANUAL.md. */
export function collectProseFindings(sb: Storyboard, rendered?: string, canonLabels?: string[]): ProseFinding[] {
	const out: ProseFinding[] = [];
	for (const flow of sb.flows) {
		for (const step of flow.steps) {
			if (!step.procedure) continue;
			for (const f of lintProseText(`1. ${step.procedure}`)) {
				out.push({ ...f, flow: flow.id, step: step.id });
			}
		}
	}
	if (rendered) out.push(...lintProseText(rendered, canonLabels));
	return out;
}
