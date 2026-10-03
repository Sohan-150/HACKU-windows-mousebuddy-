# Windows smoke runs

Produced by `bun scripts/smoke-win.ts`: the real driver, no models, on a live web page, Calculator and Notepad.

## 2026-10-03T07:02:35.919Z (bun scripts/smoke-win.ts)

- PASS  browser: opened Wikipedia search (1582 ms); 36 controls, observe 203 ms
- PASS  browser: typed into '(unlabelled text field)' (355 ms), read back 'University of Hong Kong'
- PASS  browser: Enter ran the search (1470 ms); page now 'University of Hong Kong - Search results - Wikipedia', 58 text lines
- PASS  browser: scroll (270 ms); visible text 1420 -> 1336 chars; mentions 1911: false
- PASS  browser: navigate (340 ms) -> 'University of Hong Kong - Wikipedia'; founding year in text: true
- PASS  app: Calculator window 'Calculator' (1449 ms)
- PASS  app: Calculator 6 x 7 = shows 'Display is 42'
- PASS  app: Notepad 'Untitled - Notepad', document empty (new tab)
- PASS  app: typed into Notepad (237 ms), read back 'Shopping list: eggs, milk, bread'
- FAIL  focus: the agent's windows were the foreground window in 3042 of 3318 polls (5 ms), during: browser open, browser type, browser enter, browser scroll, browser navigate, calculator open, calculator clicks, notepad open, notepad type

## 2026-10-03T07:03:25.387Z (bun scripts/smoke-win.ts)

- FAIL  setup: windows opened (browser 2821 ms, Calculator 1398 ms); another app is now in front
- PASS  browser: Wikipedia search page; 24 controls, observe 222 ms
- PASS  browser: typed into '(unlabelled text field)' (363 ms), read back 'University of Hong Kong'
- PASS  browser: Enter ran the search (1260 ms); page now 'University of Hong Kong - Search results - Wikipedia', 58 text lines
- PASS  browser: scroll (251 ms); visible text 1420 -> 1336 chars; mentions 1911: false
- PASS  browser: navigate (407 ms) -> 'University of Hong Kong - Wikipedia'; founding year in text: true
- PASS  app: Calculator 6 x 7 = shows 'Display is 42'
- PASS  app: Notepad 'Untitled - Notepad', document empty (new tab)
- PASS  app: typed into Notepad (233 ms), read back 'Shopping list: eggs, milk, bread'
- FAIL  focus: during all actions the agent's windows were the foreground window in 2162 of 2162 polls (5 ms), during: browser observe, browser type, browser enter, browser scroll, browser navigate, calculator clicks, notepad observe, notepad type

## 2026-10-03T07:04:05.992Z (bun scripts/smoke-win.ts)

- PASS  setup: windows opened (browser 2883 ms, Calculator 1447 ms); another app is now in front
- PASS  browser: Wikipedia search page; 24 controls, observe 259 ms
- PASS  browser: typed into '(unlabelled text field)' (367 ms), read back 'University of Hong Kong'
- PASS  browser: Enter ran the search (1252 ms); page now 'University of Hong Kong - Search results - Wikipedia', 58 text lines
- PASS  browser: scroll (284 ms); visible text 1420 -> 1336 chars; mentions 1911: false
- PASS  browser: navigate (364 ms) -> 'University of Hong Kong - Wikipedia'; founding year in text: true
- PASS  app: Calculator 6 x 7 = shows 'Display is 42'
- PASS  app: Notepad 'Untitled - Notepad', document empty (new tab)
- PASS  app: typed into Notepad (235 ms), read back 'Shopping list: eggs, milk, bread'
- PASS  focus: during all actions the agent's windows were the foreground window in 0 of 2075 polls (5 ms)
