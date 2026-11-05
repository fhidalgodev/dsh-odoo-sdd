/**
 * video-index.ts — the SERIES layer of odoo_video: stable `NN-slug` file
 * names, the group ordering the README navigates by, and the README.md guide
 * itself.
 *
 * Why a number prefix at all: file managers sort lexically, so a series
 * browsed by name IS the recommended watch order — `02-…` never plays before
 * `01-…` just because the alphabet says so. Why groups: a module with twenty
 * videos read as one flat list hides its shape; grouping by section (first
 * the operations menus, then the settings) is how a human finds "their" video.
 *
 * Grouping rule (one, documented): flows declare `group`; a flow WITHOUT one
 * is filed under the storyboard slug — it is still reachable, and the
 * GROUP-MISSING lint warns that a human should name its section instead of
 * this module inventing a taxonomy.
 */

import type { Flow, Storyboard } from "./manual-model.js";

// ---------------------------------------------------------------------------
// slugify — file-safe, ASCII-only stems
// ---------------------------------------------------------------------------

/**
 * Lowercase ASCII kebab: NFD-decompose so `ñ`/accents become the base letter
 * plus a combining mark, drop the marks, then fold everything that is not
 * `[a-z0-9]` into a dash. Cutting prefers a word boundary: a slug that ends
 * mid-word reads like a truncated sentence, not a title. An empty result —
 * a title made entirely of symbols — falls back to "video", because the
 * caller always needs a usable stem.
 */
export function slugify(text: string, max = 60): string {
	let slug = (text ?? "")
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
	if (slug.length > max) {
		const cut = slug.slice(0, max);
		const boundary = cut.lastIndexOf("-");
		slug = (boundary > 0 ? cut.slice(0, boundary) : cut).replace(/-+$/g, "");
	}
	return slug === "" ? "video" : slug;
}

// ---------------------------------------------------------------------------
// numberFlows — group order, then series numbering
// ---------------------------------------------------------------------------

export interface NumberedFlow {
	flow: Flow;
	/** 1-based position in the series (groups first, array order inside). */
	number: number;
	/** The effective group (flow.group, or the storyboard slug when unset). */
	group: string;
	/** `NN-<slug>` — the file stem shared by the .mp4/.srt/.vtt. */
	stem: string;
}

/**
 * Order the storyboard's flows into the series. Groups sort by their FIRST
 * appearance in `sb.flows` (the author controls the order by writing the
 * storyboard, not by an implicit alphabetical rule); inside a group the array
 * order is kept. Numbers are zero-padded to `max(2, digits)` so `ls` sorts the
 * series correctly with one or one hundred videos.
 *
 * Two flows resolving to the same stem is an ERROR, not a rename: silently
 * deduplicating would leave one video overwriting the other's file.
 */
export function numberFlows(sb: Storyboard): { ok: true; items: NumberedFlow[] } | { ok: false; error: string } {
	const width = Math.max(2, String(sb.flows.length).length);
	const groupOf = (flow: Flow): string => {
		const g = (flow.group ?? "").trim();
		return g === "" ? sb.slug : g;
	};
	const order: string[] = [];
	for (const flow of sb.flows) {
		const g = groupOf(flow);
		if (!order.includes(g)) order.push(g);
	}
	const items: NumberedFlow[] = [];
	const seenSlug = new Map<string, NumberedFlow>();
	let n = 0;
	for (const group of order) {
		for (const flow of sb.flows.filter((f) => groupOf(f) === group)) {
			n += 1;
			const slug = slugify(flow.slug ?? flow.title);
			// The NN prefix makes a literal stem collision impossible, so the
			// check lives at the slug level: two flows resolving to the same
			// file slug produce an ambiguous series guide — and it is almost
			// always a copy-paste the author fixes with flow.slug.
			const clash = seenSlug.get(slug);
			if (clash) {
				return {
					ok: false,
					error:
						`slug collision: flows ${clash.flow.id} ("${clash.flow.title}") and ${flow.id} ("${flow.title}") both resolve to "${slug}". ` +
						"Set flow.slug on one of them.",
				};
			}
			const item: NumberedFlow = { flow, number: n, group, stem: `${String(n).padStart(width, "0")}-${slug}` };
			seenSlug.set(slug, item);
			items.push(item);
		}
	}
	return { ok: true, items };
}

// ---------------------------------------------------------------------------
// renderReadme — the series guide, in the storyboard's language
// ---------------------------------------------------------------------------

/**
 * What the index knows about each flow's artifact. `file` is the workspace-
 * relative mp4 (the report's own value once assembled, the predicted
 * `NN-slug.mp4` before); `steps` is the flow's step count.
 */
export interface SeriesMeta {
	[flowId: string]: { file: string; durationSeconds: number | null; steps: number };
}

interface ReadmeStrings {
	howTo: string;
	howToBody: string;
	index: string;
	videos: string;
	total: string;
	unknownDuration: string;
	video: string;
	duration: string;
	steps: string;
	learn: string;
	captions: string;
	progress: string;
	paths: string;
	next: string;
	endOfSeries: string;
	coverage: string;
	coverageFull: string;
	coverageGaps: string;
}

const STRINGS: Record<string, ReadmeStrings> = {
	en: {
		howTo: "How to use this guide",
		howToBody:
			"Watch the videos in order — the numbering is the recommended path. Each video covers one flow and ships its captions (.srt) next to it. Tick the boxes as you finish.",
		index: "Index",
		videos: "videos",
		total: "total",
		unknownDuration: "duration unknown",
		video: "Video",
		duration: "Duration",
		steps: "Steps",
		learn: "What you'll learn",
		captions: "captions",
		progress: "Progress",
		paths: "Suggested paths",
		next: "Next",
		endOfSeries: "end of the series",
		coverage: "Coverage",
		coverageFull: "100% covered",
		coverageGaps: "Still to cover",
	},
	es: {
		howTo: "Cómo usar esta guía",
		howToBody:
			"Ve los videos en orden: la numeración es la ruta recomendada. Cada video cubre un flujo y trae sus subtítulos (.srt) al lado. Marca las casillas a medida que avanzas.",
		index: "Índice",
		videos: "videos",
		total: "en total",
		unknownDuration: "duración desconocida",
		video: "Video",
		duration: "Duración",
		steps: "Pasos",
		learn: "Qué aprenderás",
		captions: "subtítulos",
		progress: "Progreso",
		paths: "Rutas sugeridas",
		next: "Siguiente",
		endOfSeries: "fin de la serie",
		coverage: "Cobertura",
		coverageFull: "100% cubierto",
		coverageGaps: "Aún por cubrir",
	},
	pt: {
		howTo: "Como usar este guia",
		howToBody:
			"Assista aos vídeos em ordem — a numeração é o percurso recomendado. Cada vídeo cobre um fluxo e traz as legendas (.srt) ao lado. Marque as caixas à medida que avança.",
		index: "Índice",
		videos: "vídeos",
		total: "no total",
		unknownDuration: "duração desconhecida",
		video: "Vídeo",
		duration: "Duração",
		steps: "Passos",
		learn: "O que você vai aprender",
		captions: "legendas",
		progress: "Progresso",
		paths: "Percursos sugeridos",
		next: "Seguinte",
		endOfSeries: "fim da série",
		coverage: "Cobertura",
		coverageFull: "100% coberto",
		coverageGaps: "Ainda por cobrir",
	},
	fr: {
		howTo: "Comment utiliser ce guide",
		howToBody:
			"Regardez les vidéos dans l'ordre — la numérotation est le parcours recommandé. Chaque vidéo couvre un flux et embarque ses sous-titres (.srt). Cochez les cases au fur et à mesure.",
		index: "Sommaire",
		videos: "vidéos",
		total: "au total",
		unknownDuration: "durée inconnue",
		video: "Vidéo",
		duration: "Durée",
		steps: "Étapes",
		learn: "Ce que vous allez apprendre",
		captions: "sous-titres",
		progress: "Progression",
		paths: "Parcours suggérés",
		next: "Suivante",
		endOfSeries: "fin de la série",
		coverage: "Couverture",
		coverageFull: "100 % couvert",
		coverageGaps: "Reste à couvrir",
	},
};

function stringsFor(language: string | undefined): ReadmeStrings {
	const prefix = (language ?? "en").split(/[-_]/)[0]?.toLowerCase() ?? "en";
	return STRINGS[prefix] ?? STRINGS["en"];
}

/** `75` → `1:15`; null → "—". */
function fmtDuration(seconds: number | null): string {
	if (seconds === null) return "—";
	const s = Math.max(0, Math.round(seconds));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Escape a table cell: a literal `|` would split the row in two. */
function cell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/**
 * Markdown anchor for a group heading. GitHub's slugger keeps unicode
 * letters (an accented `### Opérations` anchors as `#opérations`), so this
 * mirrors THAT rule — the file-stem slugify would produce a dead link.
 */
function anchorOf(group: string): string {
	return `#${group.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-")}`;
}

/** A series README only earns its place when there is more than one video. */
export function shouldWriteReadme(items: NumberedFlow[]): boolean {
	return items.length >= 2;
}

/**
 * Render `README.md` for the series: totals, a use note, the index with
 * anchors, one `<details>` section per group (the table links the mp4 AND the
 * .srt — the captions are the text-searchable half of each video), the
 * progress checklist with a "next" pointer, and optional suggested paths per
 * role/audience. Written in the storyboard's language, never mixed.
 */
export function renderReadme(input: {
	sb: Storyboard;
	items: NumberedFlow[];
	meta: SeriesMeta;
	language?: string;
	title?: string;
	/** Coverage status of the series; appended as its own section when given. */
	coverage?: { gaps: { ref: string; label: string }[]; total: number; covered: number };
}): string {
	const t = stringsFor(input.language ?? input.sb.language);
	const title = input.title ?? input.sb.slug;
	const metaOf = (flow: Flow) => input.meta[flow.id];
	const durations = input.items.map((i) => metaOf(i.flow)?.durationSeconds ?? null);
	const knownSeconds = durations.reduce<number>((a, d) => a + (d ?? 0), 0);
	const totalLine =
		durations.every((d) => d === null)
			? `${input.items.length} ${t.videos} · ${t.unknownDuration}`
			: `${input.items.length} ${t.videos} · ${fmtDuration(knownSeconds)} ${t.total}`;

	const groups: string[] = [];
	for (const item of input.items) if (!groups.includes(item.group)) groups.push(item.group);

	const lines: string[] = [`# ${title}`, "", totalLine, "", `## ${t.howTo}`, "", t.howToBody, "", `## ${t.index}`, ""];
	for (const group of groups) {
		const count = input.items.filter((i) => i.group === group).length;
		lines.push(`- [${cell(group)}](${anchorOf(group)}) — ${count} ${t.videos}`);
	}
	lines.push("");

	// One foldable section per group. `open` keeps the guide readable at a
	// glance while still letting a long series collapse its other sections.
	for (const group of groups) {
		const members = input.items.filter((i) => i.group === group);
		lines.push(`### ${group}`, "", `<details open>`, `<summary>${members.length} ${t.videos}</summary>`, "");
		lines.push(`| # | ${t.video} | ${t.duration} | ${t.steps} | ${t.learn} |`);
		lines.push("| --- | --- | --- | --- | --- |");
		for (const item of members) {
			const meta = metaOf(item.flow);
			const file = meta?.file ?? `${item.stem}.mp4`;
			const srt = file.replace(/\.mp4$/i, ".srt");
			const learn = item.flow.summary ?? item.flow.hook?.text ?? "";
			lines.push(
				`| ${String(item.number).padStart(2, "0")} | [${cell(item.flow.title)}](${file}) ([${t.captions}](${srt})) | ${fmtDuration(meta?.durationSeconds ?? null)} | ${meta?.steps ?? item.flow.steps.length} | ${cell(learn)} |`,
			);
		}
		lines.push("", `</details>`, "");
	}

	// The checklist doubles as series navigation: each entry points at the
	// video that follows, so "what do I watch next" never needs a scroll back.
	lines.push(`## ${t.progress}`, "");
	input.items.forEach((item, idx) => {
		const next = input.items[idx + 1];
		const nextMeta = next ? metaOf(next.flow) : undefined;
		const tail = next ? ` — ${t.next}: [${cell(next.flow.title)}](${nextMeta?.file ?? `${next.stem}.mp4`})` : ` — ${t.endOfSeries}`;
		lines.push(`- [ ] ${String(item.number).padStart(2, "0")} ${cell(item.flow.title)}${tail}`);
	});
	lines.push("");

	// Suggested paths only exist when the author declared an audience: an
	// empty section would be a promise with nothing behind it.
	const byAudience = new Map<string, NumberedFlow[]>();
	for (const item of input.items) {
		const who = (item.flow.role ?? item.flow.audience ?? "").trim();
		if (who === "") continue;
		const list = byAudience.get(who) ?? [];
		list.push(item);
		byAudience.set(who, list);
	}
	if (byAudience.size > 0) {
		lines.push(`## ${t.paths}`, "");
		for (const [who, items] of byAudience) {
			lines.push(`- **${cell(who)}**: ${items.map((i) => String(i.number).padStart(2, "0")).join(", ")}`);
		}
		lines.push("");
	}
	// The coverage section is the honest part of the guide: when the series
	// is not done, the README says exactly which refs are still missing.
	if (input.coverage) {
		lines.push(`## ${t.coverage}`, "");
		if (input.coverage.gaps.length === 0) {
			lines.push(`${t.coverageFull} (${input.coverage.covered}/${input.coverage.total})`, "");
		} else {
			lines.push(`${input.coverage.covered}/${input.coverage.total} — ${t.coverageGaps}:`, "");
			for (const gap of input.coverage.gaps) lines.push(`- \`${gap.ref}\` — ${cell(gap.label)}`);
			lines.push("");
		}
	}
	return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
