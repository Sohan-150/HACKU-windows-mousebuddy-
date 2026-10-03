#!/bin/sh
# macOS (driver untested): run from Terminal.app so permission prompts are attributed to it.
cd "$(dirname "$0")/.." || exit 1
caffeinate -dimsu -w $$ &
sh scripts/daemon.sh
bun src/preflight.ts || { echo "Fix the FAIL lines above, then run this again."; exit 1; }
export OPEN_PANEL=1   # the app opens the panel once it is listening
exec bun src/main.ts
