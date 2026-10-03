#!/bin/sh
# macOS: restart the Cua daemon tuned (window-change timeout 300 ms). From review-technical.md §4 step 0.
# Needed after granting permissions (otherwise calls return permissions_pending) and if clicks get slow (> 1.3 s).
cua-driver stop 2>/dev/null; pkill -f 'CuaDriver.app/Contents/MacOS/cua-driver' 2>/dev/null; sleep 1
open -n -g --env CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS=300 -a CuaDriver --args serve; sleep 2
cua-driver status
cua-driver permissions status
