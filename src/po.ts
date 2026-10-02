/**
 * Gettext PO parsing, serialization and merging.
 *
 * WHY THIS EXISTS
 * Odoo's own models export a module's terms as a PO file
 * (`base.language.export`, `format='po'`), and since Odoo 16 the `i18n/<lang>.po`
 * files are the SOURCE of translations: the database no longer holds them. So the
 * file that comes back from the server has to be reconciled with the file already
 * in the repository, and that reconciliation is where human work is either kept
 * or destroyed.
 *
 * THE RULE THIS MODULE ENFORCES
 * A `msgstr` that a person wrote is never replaced by what the export says. The
 * export reflects the database; the file is the reviewed work. Everything else
 * (new terms, terms that left the module, a missing header) is mechanical.
 *
 * Minimal on purpose: no dependency, no attempt to reflow the file. It parses what
 * Odoo emits, keeps every comment attached to its entry, and writes back the same
 * shape.
 *
 * @module dsh-odoo-sdd/po
 */

/** One translation entry, with the comments that belong to it. */
export interface PoEntry {
	/** Translator comments (`# …`), in file order. */
	comments: string[];
	/**
	 * Extracted comments and flags (`#. …`, `#, fuzzy`, `#: file:line`), in file
	 * order. Kept verbatim: `#, fuzzy` is a review state, not noise.
	 */
	flags: string[];
	msgid: string;
	/** Plural source form, when the entry has one. */
	msgidPlural?: string;
	/** One translation per plural form; `[""]` for a singular entry. */
	msgstr: string[];
	/** True for `#~` entries: no longer in the code, kept for recovery. */
	obsolete?: boolean;
}

/** A parsed PO file: the header entry plus the translations. */
export interface PoFile {
	/** `msgid ""` metadata, as raw `key: value` lines. */
	header: Record<string, string>;
	entries: PoEntry[];
}

/** Split a PO string into its logical `key "value"` lines, joining continuations. */
function splitStatements(body: string): string[] {
	// A statement is one or more physical lines; a quoted line continues the one
	// before it. Comments are their own statements.
	const out: string[] = [];
	for (const raw of body.split(/\r?\n/)) {
		const line = raw.trimEnd();
		if (line.startsWith("#")) {
			out.push(line);
			continue;
		}
		if (line === "") continue;
		const previous = out[out.length - 1];
		if (line.startsWith('"') && previous !== undefined && !previous.startsWith("#")) {
			out[out.length - 1] = `${previous} ${line}`;
			continue;
		}
		out.push(line);
	}
	return out;
}

/** Decode one or more concatenated quoted chunks into their string value. */
function decodeQuoted(chunks: string): string {
	const parts = chunks.match(/"((?:[^"\\]|\\.)*)"/g) ?? [];
	return parts
		.map((part) => part.slice(1, -1))
		.map((inner) =>
			inner.replace(/\\(.)/g, (_all, char: string) => {
				switch (char) {
					case "n":
						return "\n";
					case "t":
						return "\t";
					case "r":
						return "\r";
					default:
						return char;
				}
			}),
		)
		.join("");
}

/** Encode a value as a PO quoted literal, splitting real newlines. */
function encodeQuoted(value: string): string {
	const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
	return `"${escaped}"`;
}

/**
 * Parse a PO file.
 *
 * Tolerant by design: an unrecognized line is skipped rather than throwing, so a
 * file with a quirk still yields its translations instead of nothing. What it does
 * NOT do is guess — a message id it cannot read is a message id it drops, and the
 * merge keeps the original entry for those.
 * @param content - the PO file contents.
 * @returns the header and the entries, in file order.
 */
export function parsePo(content: string): PoFile {
	const header: Record<string, string> = {};
	const entries: PoEntry[] = [];

	/** A fresh entry. Returned rather than assigned, so the caller's variable is
	 * what TypeScript narrows: a closure that assigns it leaves the analyzer
	 * believing the old type. */
	const makeEntry = (obsolete = false): PoEntry => ({
		comments: [],
		flags: [],
		msgid: "",
		msgstr: [""],
		...(obsolete ? { obsolete: true } : {}),
	});

	/** Collect a finished entry: metadata into `header`, the rest into `entries`. */
	const flushInto = (entry: PoEntry | null): void => {
		if (entry === null) return;
		// `msgid ""` whose msgstr is header-shaped is the metadata block.
		if (entry.msgid === "" && entry.msgstr.length === 1 && entry.obsolete !== true) {
			for (const line of entry.msgstr[0]!.split("\n")) {
				const match = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line.trim());
				if (match !== null) header[match[1]!] = match[2]!.trim();
			}
			return;
		}
		entries.push(entry);
	};

	let current: PoEntry | null = null;
	/**
	 * Whether `current` has already seen its `msgid`.
	 *
	 * A separate flag and not a comparison, because the HEADER entry legitimately
	 * has an EMPTY `msgid`: without it, a comment following the header attaches to
	 * the header, and every comment drifts onto the entry before its own.
	 */
	let sawMsgid = false;
	let mode: "msgid" | "msgid_plural" | "msgstr" | null = null;
	let msgstrIndex = 0;

	for (const statement of splitStatements(content)) {
		if (statement.startsWith("#~")) {
			// An obsolete entry: kept whole, never interpreted as live content.
			// The KEY decides whether a new entry starts, not "have I seen a msgid":
			// `#~ msgstr` follows its own `#~ msgid` and must stay with it.
			const body = statement.slice(2).trim();
			const key = /^(msgid|msgid_plural|msgstr(?:\[\d+\])?)\s+(.*)$/.exec(body);
			if (key === null) continue;
			const beginsEntry = key[1] === "msgid";
			if (current === null || current.obsolete !== true || (beginsEntry && sawMsgid)) {
				flushInto(current);
				current = makeEntry(true);
				sawMsgid = false;
			}
			const value = decodeQuoted(key[2]!);
			if (key[1] === "msgid") {
				current.msgid = value;
				sawMsgid = true;
			} else if (key[1] === "msgid_plural") current.msgidPlural = value;
			else current.msgstr[0] = value;
			continue;
		}
		if (statement.startsWith("#")) {
			// Comments belong to the entry that FOLLOWS them. Attaching them to the
			// one before is how a `#, fuzzy` flag lands on the wrong message and a
			// reviewed translation ends up looking unreviewed.
			if (current !== null && sawMsgid) {
				flushInto(current);
				current = makeEntry();
				sawMsgid = false;
			}
			if (current === null) current = makeEntry();
			if (statement.startsWith("#.") || statement.startsWith("#:") || statement.startsWith("#,")) {
				current.flags.push(statement);
			} else {
				current.comments.push(statement);
			}
			continue;
		}
		const match = /^(msgid_plural|msgid|msgstr(?:\[(\d+)\])?)\s+(.*)$/.exec(statement);
		if (match === null) continue;
		const key = match[1]!;
		if (key === "msgid") {
			// A msgid while one is already open closes that entry.
			if (current !== null && sawMsgid) {
				flushInto(current);
				current = makeEntry();
			}
			if (current === null) current = makeEntry();
			current.msgid = decodeQuoted(match[3]!);
			sawMsgid = true;
			mode = "msgid";
		} else if (key === "msgid_plural") {
			if (current === null) continue;
			current.msgidPlural = decodeQuoted(match[3]!);
			mode = "msgid_plural";
		} else {
			if (current === null) continue;
			if (mode !== "msgstr") {
				msgstrIndex = 0;
				current.msgstr = [];
			}
			current.msgstr[msgstrIndex] = decodeQuoted(match[3]!);
			msgstrIndex += 1;
			mode = "msgstr";
		}
	}
	flushInto(current);
	return { header, entries };
}

/**
 * Serialize a PO file back to text.
 * @param file - the parsed file.
 * @returns the PO contents, ending with a newline.
 */
export function serializePo(file: PoFile): string {
	const lines: string[] = [];
	lines.push('msgid ""');
	lines.push('msgstr ""');
	// The header is one quoted chunk per metadata line, which is what gettext
	// tools expect and what Odoo emits.
	for (const [key, value] of Object.entries(file.header)) lines.push(encodeQuoted(`${key}: ${value}\n`));
	lines.push("");
	for (const entry of file.entries) {
		lines.push(...entry.comments);
		lines.push(...entry.flags);
		const prefix = entry.obsolete === true ? "#~ " : "";
		lines.push(`${prefix}msgid ${encodeQuoted(entry.msgid)}`);
		if (entry.msgidPlural !== undefined) lines.push(`${prefix}msgid_plural ${encodeQuoted(entry.msgidPlural)}`);
		if (entry.msgidPlural === undefined) {
			lines.push(`${prefix}msgstr ${encodeQuoted(entry.msgstr[0] ?? "")}`);
		} else {
			entry.msgstr.forEach((value, index) => {
				lines.push(`${prefix}msgstr[${index}] ${encodeQuoted(value)}`);
			});
		}
		lines.push("");
	}
	return lines.join("\n");
}

/** One line of a header value that must exist for the file to be usable. */
const REQUIRED_HEADER: ReadonlyArray<readonly [string, (lang: string) => string]> = [
	["Project-Id-Version", () => "Odoo"],
	["MIME-Version", () => "1.0"],
	["Content-Type", () => "text/plain; charset=UTF-8"],
	["Content-Transfer-Encoding", () => "8bit"],
];

/** The plural forms Odoo expects for a language, when they are not already set. */
const PLURAL_FORMS: Readonly<Record<string, string>> = {
	es: "nplurals=2; plural=(n != 1);",
	en: "nplurals=2; plural=(n != 1);",
	fr: "nplurals=2; plural=(n > 1);",
	pt: "nplurals=2; plural=(n > 1);",
};

/** What a merge did, so the caller can report it instead of guessing. */
export interface PoMergeResult {
	file: PoFile;
	/** Terms that came back from the server and were not in the file. */
	added: string[];
	/** Terms already present WITH a translation, preserved as they were. */
	preserved: string[];
	/** Terms present with an empty translation, still waiting for one. */
	pending: string[];
	/** Terms the module no longer has; kept as `#~` rather than deleted. */
	obsoleted: string[];
}

/**
 * Merge a freshly exported PO into the file already in the repository.
 *
 * The precedence is the whole point: an existing NON-EMPTY `msgstr` wins over the
 * export. Losing a reviewed translation to a mechanical refresh is the failure
 * this function exists to prevent, and it is silent when it happens.
 * @param existing - the file in the repository, when there is one.
 * @param exported - the file returned by Odoo's export models.
 * @param lang - the language code, used to complete the header.
 * @returns the merged file and a summary of what changed.
 */
export function mergePo(existing: PoFile | null, exported: PoFile, lang: string): PoMergeResult {
	const previous = new Map<string, PoEntry>();
	for (const entry of existing?.entries ?? []) {
		if (entry.obsolete !== true) previous.set(entry.msgid, entry);
	}
	const added: string[] = [];
	const preserved: string[] = [];
	const pending: string[] = [];
	const entries: PoEntry[] = [];

	for (const entry of exported.entries) {
		if (entry.obsolete === true) continue;
		const old = previous.get(entry.msgid);
		const oldHasWork = old !== undefined && old.msgstr.some((value) => value.trim() !== "");
		if (old === undefined) {
			added.push(entry.msgid);
			entries.push({ ...entry, msgstr: entry.msgstr.length === 0 ? [""] : entry.msgstr });
		} else if (oldHasWork) {
			preserved.push(entry.msgid);
			// Keep the human translation AND its review flags; take the plural shape
			// from the export in case the source gained a plural form.
			entries.push({
				comments: old.comments,
				flags: old.flags,
				msgid: old.msgid,
				...(entry.msgidPlural === undefined ? {} : { msgidPlural: entry.msgidPlural }),
				msgstr: old.msgstr,
			});
		} else {
			pending.push(entry.msgid);
			entries.push(entry);
		}
		previous.delete(entry.msgid);
	}

	// Whatever is left was in the file and is not in the module any more.
	const obsoleted: string[] = [];
	for (const [msgid, entry] of previous) {
		obsoleted.push(msgid);
		entries.push({ ...entry, obsolete: true });
	}

	const header: Record<string, string> = { ...(existing?.header ?? {}) };
	for (const [key, value] of Object.entries(exported.header)) {
		// The export's own metadata wins, except the language, which the caller knows.
		if (header[key] === undefined || key !== "Language") header[key] = value;
	}
	header["Language"] = lang;
	for (const [key, make] of REQUIRED_HEADER) {
		if (header[key] === undefined || header[key] === "") header[key] = make(lang);
	}
	// An EMPTY value counts as missing: Odoo's export emits `Plural-Forms: ` with
	// nothing after it, and checking only for `undefined` left every generated file
	// without the plural rule it needs to render a plural string correctly.
	if (header["Plural-Forms"] === undefined || header["Plural-Forms"].trim() === "") {
		const base = lang.split("_")[0]!.toLowerCase();
		const forms = PLURAL_FORMS[base];
		if (forms !== undefined) header["Plural-Forms"] = forms;
	}
	header["X-Generator"] = "dsh-odoo-sdd";

	return { file: { header, entries }, added, preserved, pending, obsoleted };
}

/**
 * Whether a language code is usable as an Odoo locale and as a file name.
 *
 * Odoo uses `ll` or `ll_CC` (gettext convention); anything else would produce an
 * `i18n/` file the server would never load.
 * @param value - the candidate code.
 * @returns true when the code is well formed.
 */
export function isLanguageCode(value: unknown): value is string {
	return typeof value === "string" && /^[a-z]{2,3}(_[A-Z]{2})?$/.test(value);
}

/**
 * Coverage of a PO file: how much of it a person has translated.
 * @param file - the parsed file.
 * @returns counts over the non-obsolete entries.
 */
export function poCoverage(file: PoFile): { total: number; translated: number; pending: string[] } {
	const live = file.entries.filter((entry) => entry.obsolete !== true);
	const pending = live.filter((entry) => entry.msgstr.every((value) => value.trim() === "")).map((entry) => entry.msgid);
	return { total: live.length, translated: live.length - pending.length, pending };
}
