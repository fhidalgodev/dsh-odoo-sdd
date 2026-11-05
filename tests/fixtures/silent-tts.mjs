#!/usr/bin/env node
/**
 * Deterministic silent-WAV "TTS" stub for tests/video.mjs.
 *
 * Usage: node silent-tts.mjs --out PATH [--text WORDS] [--voice X] [--copy SRC]
 * Writes a valid 16-bit mono 16 kHz PCM WAV whose duration is derived from
 * the word count (0.25s per word, minimum 0.4s) — no real speech, no network.
 * `--copy SRC` instead copies an existing file verbatim to --out, mimicking a
 * TTS engine (edge-tts) that writes a non-WAV payload under a .wav name.
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

let out = null;
let text = "";
let copy = null;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--out") out = args[++i];
	else if (args[i] === "--text") text = args[++i];
	else if (args[i] === "--copy") copy = args[++i];
}
if (!out) {
	process.stderr.write("silent-tts: --out is required\n");
	process.exit(3);
}
if (copy) {
	mkdirSync(dirname(out), { recursive: true });
	copyFileSync(copy, out);
	process.exit(0);
}
const words = text.split(/\s+/).filter(Boolean).length;
const rate = 16_000;
const samples = Math.round(Math.max(0.4, 0.25 * Math.max(1, words)) * rate);
const dataBytes = samples * 2;
const buf = Buffer.alloc(44 + dataBytes);
buf.write("RIFF", 0, "ascii");
buf.writeUInt32LE(36 + dataBytes, 4);
buf.write("WAVE", 8, "ascii");
buf.write("fmt ", 12, "ascii");
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20); // PCM
buf.writeUInt16LE(1, 22); // mono
buf.writeUInt32LE(rate, 24);
buf.writeUInt32LE(rate * 2, 28);
buf.writeUInt16LE(2, 32);
buf.writeUInt16LE(16, 34);
buf.write("data", 36, "ascii");
buf.writeUInt32LE(dataBytes, 40);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, buf);
