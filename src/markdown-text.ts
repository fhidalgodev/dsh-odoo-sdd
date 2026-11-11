/**
 * Text surgery shared by the Markdown parsers and the content gates.
 *
 * A `<!-- ... -->` regular expression is not a sanitizer: a malformed comment —
 * a marker nested inside another run, or one left unclosed — survives a single
 * pass, and the guidance it hides would count as a decision. The scan below
 * consumes every marker up to the next `-->`, and an unclosed one swallows the
 * rest of the text, so the result never carries a stray `<!--`.
 *
 * @module dsh-odoo-sdd/markdown-text
 */

/**
 * Remove HTML comments from a Markdown fragment.
 * @param text - fragment as written.
 * @returns the fragment without comment bodies or markers.
 */
export function stripHtmlComments(text: string): string {
	let out = "";
	let pos = 0;
	for (;;) {
		const start = text.indexOf("<!--", pos);
		if (start < 0) return out + text.slice(pos);
		out += text.slice(pos, start);
		const end = text.indexOf("-->", start + 4);
		if (end < 0) return out;
		pos = end + 3;
	}
}
