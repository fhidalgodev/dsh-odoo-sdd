#!/usr/bin/env node
/** Always-failing TTS stub: writes to stderr and exits 1 without any output file. */
process.stderr.write("synthetic TTS failure: voice model not found\n");
process.exit(1);
