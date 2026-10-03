# Gate G-W results (Windows)

Each run below was produced by `bun run gate:win` on this laptop and appended automatically. Nothing here is copied from the Mac.
The test keeps another window in front the whole time and polls the foreground window every 5 ms.

**How to read the W10 lines.** The first six runs (05:44 to 05:53 UTC) were used to fix the W10 test itself, and are kept as they ran:
- 05:44: compared against the window in front *before* the browser launched; the launch takes focus once, so this counted every later poll. Fixed by measuring only after launch.
- 05:45: passed, but the agent's own browser was the window in front, so it proved nothing. Fixed by putting another app in front.
- 05:46: Notepad in front; focus went Notepad -> (none) -> agent browser once. Most likely Windows activating the next window when a Notepad window closed (Windows 11 Notepad restores tabs into another process). Not reproduced since.
- 05:52 and 05:52:58: Windows' focus lock kept the test's own window from coming forward, or focus moved to the Claude app; neither is the agent browser.
- From 05:53:41 on, W10 checks the property that matters, by process id: **the agent browser was never the foreground window during actions**. Every run since passes.

## Gate run 2026-10-03T05:44:42.432Z (bun run gate:win)

Cua Driver 0.32.0, browser chrome.exe, LAPTOP-VBKSH16U

- W1 isolated browser: pid 50616, window 7472072 'about:blank - Google Chrome' (3165 ms incl. session) - PASS
- W2 snapshot: 9 controls [button:clear form, text field:payee name, text field:amount (hkd), text field:date of expense (dd/mm/yyyy), pop-up:category, radio:cash, radio:fps, text field:notes, button:submit claim], 89 ms - PASS
- W3 typing (replace): 337 ms, 340 ms, 345 ms, 340 ms; read-back {"FPS":"checked","Payee name":"Chan Tai Man","Amount (HKD)":"128.50","Date of expense (DD/MM/YYYY)":"30/09/2026","Category":"Food","Cash":"not checked","Notes":"gate W"} - PASS
- W5 dropdown (open picker + click option): 622 ms, ok=true  - PASS
- W4 radio 283 ms + Submit 277 ms; server record {"id":1,"payee":"Chan Tai Man","amount":"128.50","date":"30/09/2026","category":"Food","paidBy":"FPS","notes":"gate W","t":"2026-10-03T05:44:33.654Z"} - PASS
- W9 medians: observe 82 ms, click 265 ms, type 346 ms; last payee value 'Payee 9' - PASS
- W10 foreground window changed in 2308 of 2504 polls (5 ms) - FAIL

## Gate run 2026-10-03T05:45:33.448Z (bun run gate:win)

Cua Driver 0.32.0, browser chrome.exe, LAPTOP-VBKSH16U

- W1 isolated browser: pid 59304, window 2886308 'about:blank - Google Chrome' (3103 ms incl. session) - PASS
- W2 snapshot: 9 controls [button:clear form, text field:payee name, text field:amount (hkd), text field:date of expense (dd/mm/yyyy), pop-up:category, radio:cash, radio:fps, text field:notes, button:submit claim], 87 ms - PASS
- W3 typing (replace): 347 ms, 324 ms, 337 ms, 359 ms; read-back {"FPS":"checked","Payee name":"Chan Tai Man","Amount (HKD)":"128.50","Date of expense (DD/MM/YYYY)":"30/09/2026","Category":"Food","Cash":"not checked","Notes":"gate W"} - PASS
- W5 dropdown (open picker + click option): 619 ms, ok=true  - PASS
- W4 radio 258 ms + Submit 263 ms; server record {"id":1,"payee":"Chan Tai Man","amount":"128.50","date":"30/09/2026","category":"Food","paidBy":"FPS","notes":"gate W","t":"2026-10-03T05:45:24.797Z"} - PASS
- W9 medians: observe 76 ms, click 266 ms, type 345 ms; last payee value 'Payee 9' - PASS
- W10 foreground during actions: changed in 0 of 2480 polls (5 ms); front window 'Claim form (replica) - Google Chrome' (at start: 'Claude') - PASS
-     foreground transitions: launch: 'Claude' -> '' | launch: '' -> 'Untitled - Google Chrome'

## Gate run 2026-10-03T05:46:02.552Z (bun run gate:win)

Cua Driver 0.32.0, browser chrome.exe, LAPTOP-VBKSH16U

- W1 isolated browser: pid 59304, window 2886308 'Claim form (replica) - Google Chrome' (3050 ms incl. session) - PASS
- W2 snapshot: 9 controls [button:clear form, text field:payee name, text field:amount (hkd), text field:date of expense (dd/mm/yyyy), pop-up:category, radio:cash, radio:fps, text field:notes, button:submit claim], 82 ms - PASS
- W3 typing (replace): 349 ms, 353 ms, 344 ms, 354 ms; read-back {"FPS":"checked","Payee name":"Chan Tai Man","Amount (HKD)":"128.50","Date of expense (DD/MM/YYYY)":"30/09/2026","Category":"Food","Cash":"not checked","Notes":"gate W"} - PASS
- W5 dropdown (open picker + click option): 613 ms, ok=true  - PASS
- W4 radio 269 ms + Submit 282 ms; server record {"id":1,"payee":"Chan Tai Man","amount":"128.50","date":"30/09/2026","category":"Food","paidBy":"FPS","notes":"gate W","t":"2026-10-03T05:45:53.812Z"} - PASS
- W9 medians: observe 81 ms, click 269 ms, type 353 ms; last payee value 'Payee 9' - PASS
- W10 foreground during actions: changed in 498 of 2483 polls (5 ms); front window 'requirements.txt - Notepad' (at start: 'Claim form (replica) - Google Chrome') - FAIL
-     foreground transitions: launch: 'Claim form (replica) - Google Chrome' -> 'Notepad' | actions: 'requirements.txt - Notepad' -> '' | actions: '' -> 'Claim form (replica) - Google Chrome'

## Gate run 2026-10-03T05:52:22.908Z (bun run gate:win)

Cua Driver 0.32.0, browser chrome.exe, LAPTOP-VBKSH16U

- W1 isolated browser: pid 55936, window 5179622 'about:blank - Google Chrome' (4684 ms incl. session) - PASS
- W2 snapshot: 9 controls [button:clear form, text field:payee name, text field:amount (hkd), text field:date of expense (dd/mm/yyyy), pop-up:category, radio:cash, radio:fps, text field:notes, button:submit claim], 110 ms - PASS
- W3 typing (replace): 252 ms, 245 ms, 237 ms, 254 ms; read-back {"FPS":"checked","Payee name":"Chan Tai Man","Amount (HKD)":"128.50","Date of expense (DD/MM/YYYY)":"30/09/2026","Category":"Food","Cash":"not checked","Notes":"gate W"} - PASS
- W5 dropdown (open picker + click option): 497 ms, ok=true  - PASS
- W4 radio 159 ms + Submit 156 ms; server record {"id":1,"payee":"Chan Tai Man","amount":"128.50","date":"30/09/2026","category":"Food","paidBy":"FPS","notes":"gate W","t":"2026-10-03T05:52:15.697Z"} - PASS
- W9 medians: observe 116 ms, click 159 ms, type 253 ms; last payee value 'Payee 9' - PASS
- W10 foreground during actions: changed in 0 of 2459 polls (5 ms); front window 'Claude' (at start: 'Claude') - FAIL
-     foreground transitions: [launch] 'Claude' -> 'Untitled - Google Chrome' | [launch] 'Claim form (replica) - Google Chrome' -> '' | [launch] '' -> 'Claude'

## Gate run 2026-10-03T05:52:58.716Z (bun run gate:win)

Cua Driver 0.32.0, browser chrome.exe, LAPTOP-VBKSH16U

- W1 isolated browser: pid 55936, window 5179622 'Claim form (replica) - Google Chrome' (3106 ms incl. session) - PASS
- W2 snapshot: 9 controls [button:clear form, text field:payee name, text field:amount (hkd), text field:date of expense (dd/mm/yyyy), pop-up:category, radio:cash, radio:fps, text field:notes, button:submit claim], 104 ms - PASS
- W3 typing (replace): 253 ms, 249 ms, 254 ms, 239 ms; read-back {"FPS":"checked","Payee name":"Chan Tai Man","Amount (HKD)":"128.50","Date of expense (DD/MM/YYYY)":"30/09/2026","Category":"Food","Cash":"not checked","Notes":"gate W"} - PASS
- W5 dropdown (open picker + click option): 457 ms, ok=true  - PASS
- W4 radio 142 ms + Submit 146 ms; server record {"id":1,"payee":"Chan Tai Man","amount":"128.50","date":"30/09/2026","category":"Food","paidBy":"FPS","notes":"gate W","t":"2026-10-03T05:52:51.652Z"} - PASS
- W9 medians: observe 107 ms, click 154 ms, type 256 ms; last payee value 'Payee 9' - PASS
- W10 foreground during actions: changed in 625 of 2148 polls (5 ms); front window 'Gate front window (user app)' (at start: 'Claude') - FAIL
-     foreground transitions: [launch] 'Claude' -> 'Gate front window (user app)' | [W9 click 8] 'Gate front window (user app)' -> 'Claude'

## Gate run 2026-10-03T05:53:12.895Z (bun run gate:win)

Cua Driver 0.32.0, browser chrome.exe, LAPTOP-VBKSH16U

- W1 isolated browser: pid 55936, window 5179622 'Claim form (replica) - Google Chrome' (3065 ms incl. session) - PASS
- W2 snapshot: 9 controls [button:clear form, text field:payee name, text field:amount (hkd), text field:date of expense (dd/mm/yyyy), pop-up:category, radio:cash, radio:fps, text field:notes, button:submit claim], 122 ms - PASS
- W3 typing (replace): 277 ms, 271 ms, 263 ms, 236 ms; read-back {"FPS":"checked","Payee name":"Chan Tai Man","Amount (HKD)":"128.50","Date of expense (DD/MM/YYYY)":"30/09/2026","Category":"Food","Cash":"not checked","Notes":"gate W"} - PASS
- W5 dropdown (open picker + click option): 576 ms, ok=true  - PASS
- W4 radio 148 ms + Submit 145 ms; server record {"id":1,"payee":"Chan Tai Man","amount":"128.50","date":"30/09/2026","category":"Food","paidBy":"FPS","notes":"gate W","t":"2026-10-03T05:53:05.603Z"} - PASS
- W9 medians: observe 123 ms, click 154 ms, type 263 ms; last payee value 'Payee 9' - PASS
- W10 foreground during actions: changed in 0 of 2201 polls (5 ms); front window 'Claude' (at start: 'Claude') - PASS
-     foreground transitions: none

## Gate run 2026-10-03T05:53:41.596Z (bun run gate:win)

Cua Driver 0.32.0, browser chrome.exe, LAPTOP-VBKSH16U

- W1 isolated browser: pid 55936, window 5179622 'Claim form (replica) - Google Chrome' (3245 ms incl. session) - PASS
- W2 snapshot: 9 controls [button:clear form, text field:payee name, text field:amount (hkd), text field:date of expense (dd/mm/yyyy), pop-up:category, radio:cash, radio:fps, text field:notes, button:submit claim], 114 ms - PASS
- W3 typing (replace): 254 ms, 237 ms, 238 ms, 245 ms; read-back {"FPS":"checked","Payee name":"Chan Tai Man","Amount (HKD)":"128.50","Date of expense (DD/MM/YYYY)":"30/09/2026","Category":"Food","Cash":"not checked","Notes":"gate W"} - PASS
- W5 dropdown (open picker + click option): 515 ms, ok=true  - PASS
- W4 radio 146 ms + Submit 182 ms; server record {"id":1,"payee":"Chan Tai Man","amount":"128.50","date":"30/09/2026","category":"Food","paidBy":"FPS","notes":"gate W","t":"2026-10-03T05:53:34.229Z"} - PASS
- W9 medians: observe 114 ms, click 157 ms, type 247 ms; last payee value 'Payee 9' - PASS
- W10 agent browser was the foreground window in 0 of 2195 polls (5 ms) during actions; front window 'Gate front window (user app)', changed in 0 polls - PASS
-     foreground transitions: [launch] 'Claude' -> 'Gate front window (user app)'

## Gate run 2026-10-03T05:53:56.098Z (bun run gate:win)

Cua Driver 0.32.0, browser chrome.exe, LAPTOP-VBKSH16U

- W1 isolated browser: pid 55936, window 5179622 'Claim form (replica) - Google Chrome' (3231 ms incl. session) - PASS
- W2 snapshot: 9 controls [button:clear form, text field:payee name, text field:amount (hkd), text field:date of expense (dd/mm/yyyy), pop-up:category, radio:cash, radio:fps, text field:notes, button:submit claim], 94 ms - PASS
- W3 typing (replace): 261 ms, 273 ms, 241 ms, 268 ms; read-back {"FPS":"checked","Payee name":"Chan Tai Man","Amount (HKD)":"128.50","Date of expense (DD/MM/YYYY)":"30/09/2026","Category":"Food","Cash":"not checked","Notes":"gate W"} - PASS
- W5 dropdown (open picker + click option): 561 ms, ok=true  - PASS
- W4 radio 173 ms + Submit 170 ms; server record {"id":1,"payee":"Chan Tai Man","amount":"128.50","date":"30/09/2026","category":"Food","paidBy":"FPS","notes":"gate W","t":"2026-10-03T05:53:48.715Z"} - PASS
- W9 medians: observe 112 ms, click 155 ms, type 251 ms; last payee value 'Payee 9' - PASS
- W10 agent browser was the foreground window in 0 of 2231 polls (5 ms) during actions; front window 'Gate front window (user app)', changed in 0 polls - PASS
-     foreground transitions: [launch] 'Claude' -> '' | [launch] '' -> 'Gate front window (user app)'

## Gate run 2026-10-03T05:54:10.638Z (bun run gate:win)

Cua Driver 0.32.0, browser chrome.exe, LAPTOP-VBKSH16U

- W1 isolated browser: pid 55936, window 5179622 'Claim form (replica) - Google Chrome' (3157 ms incl. session) - PASS
- W2 snapshot: 9 controls [button:clear form, text field:payee name, text field:amount (hkd), text field:date of expense (dd/mm/yyyy), pop-up:category, radio:cash, radio:fps, text field:notes, button:submit claim], 121 ms - PASS
- W3 typing (replace): 226 ms, 264 ms, 262 ms, 279 ms; read-back {"FPS":"checked","Payee name":"Chan Tai Man","Amount (HKD)":"128.50","Date of expense (DD/MM/YYYY)":"30/09/2026","Category":"Food","Cash":"not checked","Notes":"gate W"} - PASS
- W5 dropdown (open picker + click option): 560 ms, ok=true  - PASS
- W4 radio 155 ms + Submit 171 ms; server record {"id":1,"payee":"Chan Tai Man","amount":"128.50","date":"30/09/2026","category":"Food","paidBy":"FPS","notes":"gate W","t":"2026-10-03T05:54:03.204Z"} - PASS
- W9 medians: observe 112 ms, click 159 ms, type 255 ms; last payee value 'Payee 9' - PASS
- W10 agent browser was the foreground window in 0 of 2243 polls (5 ms) during actions; front window 'Gate front window (user app)', changed in 0 polls - PASS
-     foreground transitions: [launch] 'Claude' -> 'Gate front window (user app)'

## Gate run 2026-10-03T06:13:50.950Z (bun run gate:win)

Cua Driver 0.32.0, browser chrome.exe, LAPTOP-VBKSH16U

- W1 isolated browser: pid 51600, window 3738752 'Claim received - Google Chrome' (2897 ms incl. session) - PASS
- W2 snapshot: 9 controls [text field:payee name, text field:amount (hkd), text field:date of expense (dd/mm/yyyy), pop-up:category, radio:cash, radio:fps, text field:notes, button:submit claim, button:clear form], 78 ms - PASS
- W3 typing (replace): 339 ms, 345 ms, 329 ms, 343 ms; read-back {"Payee name":"Chan Tai Man","Amount (HKD)":"128.50","Date of expense (DD/MM/YYYY)":"30/09/2026","Category":"Food","Cash":"not checked","FPS":"checked","Notes":"gate W"} - PASS
- W5 dropdown (open picker + click option): 621 ms, ok=true  - PASS
- W4 radio 272 ms + Submit 264 ms; server record {"id":1,"payee":"Chan Tai Man","amount":"128.50","date":"30/09/2026","category":"Food","paidBy":"FPS","notes":"gate W","t":"2026-10-03T06:13:42.358Z"} - PASS
- W9 medians: observe 83 ms, click 255 ms, type 346 ms; last payee value 'Payee 9' - PASS
- W10 agent browser was the foreground window in 0 of 2492 polls (5 ms) during actions; front window 'Gate front window (user app)', changed in 0 polls - PASS
-     foreground transitions: [launch] 'Claim received - Google Chrome' -> 'Gate front window (user app)'
