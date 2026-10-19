#!/usr/bin/env bash
# Runs the given suite files one after another and keeps a failing run
# readable: the tail of the output goes to the step summary and, as
# annotations, to the check run. A job log is not always reachable (and a bare
# "exit code 1" hides which check failed), so the diagnostic travels with the
# result. Each suite is its own CI step, which names the suite that broke.
set -uo pipefail

if [ "$#" -eq 0 ]; then
	echo "usage: ci-test.sh <suite.mjs> [suite.mjs ...]" >&2
	exit 2
fi

log="${RUNNER_TEMP:-/tmp}/ci-test.log"
: >"$log"
status=0

for suite in "$@"; do
	echo "== $suite"
	if ! node "$suite" 2>&1 | tee -a "$log"; then
		status=1
		echo "== $suite FAILED" >&2
		break
	fi
done

if [ "$status" -ne 0 ]; then
	tail -n 40 "$log" >&2 || true
	if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
		{
			echo "## Failing checks"
			echo '```'
			tail -n 80 "$log"
			echo '```'
		} >>"$GITHUB_STEP_SUMMARY"
	fi
	# Annotations are reachable from the check run API even when the job log is
	# not: the last lines name the check that failed.
	tail -n 20 "$log" | while IFS= read -r line; do
		line=${line//%/%%}
		if [ -n "$line" ]; then
			echo "::error::$line"
		fi
	done
fi

exit "$status"
