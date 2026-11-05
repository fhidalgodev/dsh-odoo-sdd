/**
 * video-voices.ts — the VOICE PRESET catalog for odoo_video.
 *
 * The developer picks a CHARACTER (viral/calm, male/female, cloud/offline),
 * not a raw engine voice: the concrete voice is resolved from the storyboard
 * language, because "Jorge" only exists for es-MX and an English script
 * narrated by it would read as an accent bug. Presets are the only supported
 * way to reach a cloud engine without writing a command line: picking one is
 * the explicit decision that sends the narration text to Microsoft, so no
 * preset is ever the default — an empty `ttsPreset` with no `ttsCommand`
 * answers NEEDS_TTS and lists this catalog.
 *
 * Command templates keep the same contract as `ttsCommand` (argv-split, no
 * shell, placeholders as standalone tokens): the narration travels via
 * {textFile}, never interpolated into a shell string.
 */

export interface VoicePreset {
	id: string;
	label: string;
	/** The character the developer actually chooses. */
	style: "viral" | "calm" | "offline";
	gender?: "male" | "female";
	/** Cloud presets send the narration text to Microsoft (edge-tts). */
	cloud: boolean;
	/** Shown first in pickers and NEEDS_TTS, with a "recommended" badge. */
	recommended?: boolean;
	note: string;
}

export const VOICE_PRESET_IDS: readonly string[] = [
	"viral-male",
	"viral-female",
	"calm-male",
	"calm-female",
	"offline-piper",
	"custom",
];

export const VOICE_PRESETS: VoicePreset[] = [
	{ id: "viral-male", label: "Viral — male", style: "viral", gender: "male", cloud: true, recommended: true, note: "Fast-paced neural voice for short, punchy narration." },
	{ id: "viral-female", label: "Viral — female", style: "viral", gender: "female", cloud: true, recommended: true, note: "Fast-paced neural voice for short, punchy narration." },
	{ id: "calm-male", label: "Calm — male", style: "calm", gender: "male", cloud: true, note: "Even, documentary pace for long walkthroughs." },
	{ id: "calm-female", label: "Calm — female", style: "calm", gender: "female", cloud: true, note: "Even, documentary pace for long walkthroughs." },
	{ id: "offline-piper", label: "Offline — Piper", style: "offline", cloud: false, note: "Local engine (more robotic): the text never leaves the machine. Needs ttsVoice set to a .onnx model file." },
	{ id: "custom", label: "Custom command", style: "offline", cloud: false, note: "Your own ttsCommand/ttsVoice, exactly as configured." },
];

/**
 * The concrete engine voice + speaking rate per preset and language prefix.
 * `en` is also the fallback for languages the table does not cover (the
 * storyboard language is pinned at plan time, so a missing prefix degrades
 * to a working voice, never to silence).
 */
const VOICE_TABLE: Record<string, Record<string, { voice: string; rate: string }>> = {
	"viral-male": {
		es: { voice: "es-MX-JorgeNeural", rate: "+10%" },
		en: { voice: "en-US-AndrewNeural", rate: "+8%" },
		pt: { voice: "pt-BR-AntonioNeural", rate: "+8%" },
		fr: { voice: "fr-FR-HenriNeural", rate: "+8%" },
	},
	"viral-female": {
		es: { voice: "es-MX-DaliaNeural", rate: "+8%" },
		en: { voice: "en-US-AvaNeural", rate: "+8%" },
		pt: { voice: "pt-BR-FranciscaNeural", rate: "+8%" },
		fr: { voice: "fr-FR-DeniseNeural", rate: "+8%" },
	},
	"calm-male": {
		es: { voice: "es-ES-AlvaroNeural", rate: "+0%" },
		en: { voice: "en-US-GuyNeural", rate: "+0%" },
		pt: { voice: "pt-BR-AntonioNeural", rate: "+0%" },
		fr: { voice: "fr-FR-HenriNeural", rate: "+0%" },
	},
	"calm-female": {
		es: { voice: "es-ES-ElviraNeural", rate: "+0%" },
		en: { voice: "en-US-AriaNeural", rate: "+0%" },
		pt: { voice: "pt-BR-FranciscaNeural", rate: "+0%" },
		fr: { voice: "fr-FR-DeniseNeural", rate: "+0%" },
	},
};

function languagePrefix(language: string | undefined): string {
	const lang = (language ?? "en").trim();
	return (lang.split(/[-_]/)[0] ?? "en").toLowerCase();
}

function presetById(id: string): VoicePreset | undefined {
	return VOICE_PRESETS.find((p) => p.id === id);
}

/**
 * The catalog the picker and the NEEDS_TTS remediation show: every preset
 * with the concrete voice it would use for `language` (null where the voice
 * is the developer's own — piper's .onnx path or a custom command).
 * Recommended presets come first; the rest keep catalog order.
 */
export function listVoicePresets(language?: string): { preset: VoicePreset; voice: string | null }[] {
	const lang = languagePrefix(language);
	const entry = (preset: VoicePreset) => ({
		preset,
		voice: VOICE_TABLE[preset.id]?.[lang]?.voice ?? VOICE_TABLE[preset.id]?.["en"]?.voice ?? null,
	});
	return [
		...VOICE_PRESETS.filter((p) => p.recommended).map(entry),
		...VOICE_PRESETS.filter((p) => !p.recommended).map(entry),
	];
}

export interface ResolvedVoiceEngine {
	/** The argv template voiceFlow runs (same placeholders as ttsCommand). */
	command: string;
	/** The concrete {voice} value; null when the preset expects ttsVoice. */
	voice: string | null;
	cloud: boolean;
	/** The preset that produced this engine, or null for a bare ttsCommand. */
	presetId: string | null;
}

/**
 * Resolve which engine narrates the videos.
 *
 * Precedence (one rule, on purpose): a non-empty `ttsPreset` other than
 * "custom" wins outright — picking a preset in the panel is the explicit
 * voice decision; a bare `ttsCommand` (config or ODOO_SDD_TTS_CMD, the
 * pre-presets contract) is the fallback that keeps existing setups working;
 * nothing configured returns null, which the tool surfaces as NEEDS_TTS with
 * the preset list. An explicit `ttsVoice` always overrides only the concrete
 * voice of the resolved preset.
 */
export function resolveVoiceEngine(input: {
	ttsPreset?: string | null;
	ttsCommand?: string | null;
	ttsVoice?: string | null;
	language?: string;
}): ResolvedVoiceEngine | null {
	const presetId = (input.ttsPreset ?? "").trim();
	const voiceOverride = input.ttsVoice !== null && input.ttsVoice !== undefined && input.ttsVoice.trim() !== "" ? input.ttsVoice.trim() : null;
	if (presetId !== "" && presetId !== "custom") {
		const preset = presetById(presetId);
		if (!preset) return null;
		if (preset.id === "offline-piper") {
			// {voice} here is the .onnx MODEL PATH, not a voice name: with no
			// ttsVoice the engine resolves but cannot run — voiceFlow turns it
			// into the NEEDS_TTS that tells the developer to set ttsVoice.
			return { command: "piper -m {voice} -i {textFile} -f {out}", voice: voiceOverride, cloud: false, presetId: preset.id };
		}
		const lang = languagePrefix(input.language);
		const entry = VOICE_TABLE[preset.id]?.[lang] ?? VOICE_TABLE[preset.id]?.["en"];
		if (!entry) return null;
		// The rate is ONE argv token (`--rate=+10%`): edge-tts rejects a
		// split `--rate +10%`, and the placeholder contract forbids gluing
		// tokens inside the template parser.
		return {
			command: `edge-tts -f {textFile} -v {voice} --rate=${entry.rate} --pitch=+0Hz --write-media {out}`,
			voice: voiceOverride ?? entry.voice,
			cloud: true,
			presetId: preset.id,
		};
	}
	const command = (input.ttsCommand ?? "").trim();
	if (command === "") return null;
	return { command, voice: voiceOverride, cloud: false, presetId: presetId === "custom" ? "custom" : null };
}
