# Backstage for Windows

A desktop assistant that does what you ask, behind your windows: the Windows twin of the team's Mac version (Backstage),
with its look, colours and behaviour. Type an instruction, or **hold Ctrl+Win and say it** (tap the keys to type it
instead). Coloured agents work in their own browser windows (a throwaway profile), in desktop apps through UI
Automation, or directly on files in your user folder, each with a little widget in the corner of your screen. **Ask about
anything on your screen** ("what is this?", "how do I make a pivot table?", "circle the zebra") and it answers out loud
while it draws on top of your screen; "how do I..." becomes a short lesson, one step at a time.

Every task ends **done, with the answer and the evidence it was read from**, or **failed, with a reason**.

- **TypeSafe jev** decides almost every step: a cheap, fast classifier (about $0.0003 per task above). With rules it also
  plans the common tasks, so the agent runs on the jev key alone.
- **Claude** (optional) plans open-ended tasks, takes over steps jev is unsure about, writes text nobody planned, checks
  results, and runs explain mode (a picture of your screen plus its controls). Default model `claude-sonnet-5-5`;
  `claude-haiku-4-5` is cheaper (`CLAUDE_MODEL` in `.env`).
- **ElevenLabs** (optional) speaks the answers in a natural voice (free plan: 10,000 credits a month); otherwise the
  Windows voice does.

Measured runs are in [evidence/live-jev-only.md](evidence/live-jev-only.md). Windows and Mac notes are in
[../BUILD-WINDOWS-AND-MAC.md](../BUILD-WINDOWS-AND-MAC.md).

## What it can do (jev only, tested live)

| Ask | What happens |
|---|---|
| "When was HKU founded?", "what's the capital of Australia" | web search, the answer line read off the page |
| "What's the weather in Tokyo" | current weather (wttr.in) |
| "Find flights from Hong Kong to Tokyo on 20 November" | Google Flights results; cheapest top option read out. Never books or pays |
| "Directions from Central to the airport", "how long to walk from HKU to Kennedy Town", "... by public transport" | Google Maps route and time, in the travel mode asked for (driving, walking, transit, cycling) |
| "Check Sony stock price", "what's Nvidia's share price" | the quote page opened straight on that symbol (Google Finance) |
| "Message Mohit hi on WhatsApp", "reply to Sam saying on my way" | the chat app: searches for the contact if it isn't on screen, puts the name in the search box and the text in the message box, sends only when asked |
| "Play lofi beats on YouTube", "search GitHub for bun" | the site's own search page, then the first match |
| "What is 15% of 80", "calculate 128.5 times 12" | Windows Calculator, result checked in code |
| "Write \"call the dentist\" in Notepad", then "write that in Notepad" | Notepad, text read back in code; follow-ups use the last answer |
| "Organise my Downloads", "convert the PNGs on my Desktop to jpg", "how many PDFs in Documents" | files on disk: preview, approval, check, **Undo** |
| "Find the weather in Tokyo then write it in Notepad" | multi-step: up to 5 parts, each checked |
| "Find flights to Botswana and at the same time play Drake on Spotify" | parts that don't need each other run at once (two browser windows, two desktop apps); one that fails doesn't stop the others |
| "I am flying to Tokyo tomorrow. In Maps, how long ... to the airport, in Weather check the weather in Tokyo, in Stocks check Sony stock price, and make a word doc with a 3 day itinerary" | one part per app (the Mac version's showcase); the first sentence asks for nothing, so it is context, not a part; with 3+ agents each spoken result is cut to its gist |
| "Launch Fortnite from Epic Games" | started with the launcher's own link (Steam too); an update or sign-in it needs is reported |
| "Open my coding folder and tell me what is inside" | found by name, opened in File Explorer, its folders and files listed |
| Point + "what is this?" / "where is settings?" / "read this" | explain mode: the control under the pointer is named (and ringed for "where is") |
| "Where is my Year 1 folder?", "open my tax return" | searched on disk by name ("one" = "1", case and spaces ignored); shown in File Explorer |

With a Claude key it also composes text ("write a thank-you note"), takes on open-ended web tasks (search, compare,
go as far as the page before payment: tested with a real flight to Taipei), and explain mode answers anything about
your screen: it draws rings, boxes, circles, arrows, underlines and labels on top of it, and teaches "how do I ..." as a
lesson (one action per step; say "next" or press Alt+Right). Tested live with Sonnet 5.5 and Haiku 4.5; see the
evidence file.

## Safety, in code (whatever a model decides)

- Clicks that look irreversible (send, pay, book, submit, delete, save, accept; "accept" also in other languages) wait for your
  approval in the panel, or a spoken "yes" / "no". Cookie banners get "Reject all" automatically.
- Never types into password, card or ID fields; never completes a purchase or booking.
- Files: only inside your user folder, never deleted, never overwritten (`a (1).txt`), every move undoable.
- Existing text in an app is never replaced silently: it opens a new tab, or asks.
- Messages: a message box is filled, and Enter or Send pressed in it, only when the request asks to send something;
  the name of who to reach never goes into a message box (from the Mac version's WhatsApp runs).
- Explain mode is read-only: it never clicks or types. The overlay (buddy, drawings, widgets) is click-through and never
  takes focus, except the typing box you open and the widgets, which you can drag. Your mouse is never moved.
- The fast lane acts only on the exact control the agent saw (same app, control type, name and position within 3
  pixels), never types inside web pages, and reports typing as done only when the field really changed; anything else
  goes through Cua. It never acts after it has been waiting, so a click is never done twice.
- Agents work behind your windows. When an app ignores input sent in the background (the web page inside WhatsApp or
  Discord, a chat row that only opens on a real click, a game launcher), its window comes to the front for a moment,
  the click or keys go in for real (the pointer moves there and straight back), and your window goes back in front.
- Say "stop" (or press Stop) to abort at the next step.

## Quick start: Windows

Run from a normal PowerShell, never as administrator.

1. Install Bun (`npm install -g bun`) and Git.
2. Install Cua Driver 0.32.0 for your user, without the autostart task:
   ```powershell
   Invoke-WebRequest -Uri https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1 -OutFile install.ps1
   $env:CUA_DRIVER_RS_VERSION = "0.32.0"; powershell -ExecutionPolicy Bypass -File .\install.ps1 -NoAutoStart
   cua-driver telemetry disable
   ```
3. In this folder: `bun install`, copy `.env.example` to `.env`, put in `TYPESAFE_API_KEY` (and `ANTHROPIC_API_KEY` if you
   have one). Set `REGION` / `CURRENCY` (e.g. `HK` / `HKD`) so maps and flights are local.
   For the natural voice (optional): sign up at [elevenlabs.io](https://elevenlabs.io) (the free plan gives 10,000
   credits a month), create a key at <https://elevenlabs.io/app/settings/api-keys> with Text to Speech access, and put it
   in `.env` as `ELEVENLABS_API_KEY=...`. The panel shows the credits left; below 300 it switches to the Windows voice.
4. Voice (optional; typing always works). Needs [uv](https://docs.astral.sh/uv/):
   ```powershell
   uv venv --python 3.12 native\win\.venv
   uv pip install --python native\win\.venv\Scripts\python.exe -r native\win\requirements.txt
   native\win\.venv\Scripts\python.exe native\win\voice.py --check
   ```
   The first start downloads the English `small.en` speech model (about 480 MB; it uses `small` if that can't be had).
   Settings > Privacy > Microphone must allow desktop apps.
5. `powershell -ExecutionPolicy Bypass -File scripts\start.ps1` starts the daemon, runs the preflight and opens the panel
   at http://127.0.0.1:3000/. Or step by step: `scripts\daemon.ps1`, `bun run preflight`, `bun start`. The daemon is
   started with the Mac version's speed setting (300 ms window-change wait); if it was already running,
   `scripts\daemon.ps1 -Restart` restarts it with it.

The agent's own Chrome (or Edge) window opens at start-up and **takes the foreground once**; after that it works behind
whatever you have in front (0 of 2,075 polls with it in front, measured).

## Quick start: macOS (written, not yet run)

Cua Driver 0.32.0 with Accessibility and Screen Recording granted; `sh scripts/daemon.sh`; `bun install`; `.env`;
voice helpers as in [native/mac/README.md](native/mac/README.md) (Right-Option); then `sh scripts/start.sh`.

## Using it

- **One hotkey for everything.** Hold Ctrl+Win, point, talk, let go (`PTT_KEY` changes the keys: `ctrl_alt`,
  `ctrl_shift`, `right_ctrl`, `f8`...; the Fn key never reaches Windows). **Tap** the keys instead to get a typing box
  next to the cursor. A job ("open Calculator and work out 128 times 37") goes to the agents: "On it.", then the result
  is said when they finish. A question about the screen goes to explain mode. Clear cases are told apart in code, an
  unclear one by jev; when in doubt it explains, because explaining never changes anything (`src/router.ts`).
  "Stop" stops the agents. `VOICE_MODE=draft` puts a spoken job in the panel's box instead of running it.
- **Explain mode.** The screen under the cursor is captured the moment the keys go down (the overlay's own windows are
  never in the picture). Claude gets the picture plus the controls on screen with their exact positions, so the drawings
  land on the real button, not a guess. Plain questions get one answer that fades; "how do I..." gets a lesson: Alt+Right
  or "next" for the next step, Alt+Left or "back", "repeat". Esc stops the voice; Esc again clears the drawings. Without
  Claude, jev names what is under the pointer and rings what "where is ..." asks for. Typed in the panel, screen
  questions are about the window you were using before the panel; or type one, press **Point & ask**, and point within
  3 seconds.
- **The buddy and the widgets.** A small buddy follows your cursor and shows listening / thinking / the answer, then
  flies to what it is explaining; near a screen edge its answer moves so none of it is cut off. While agents work, each
  has a widget in the bottom-right corner (drag them anywhere; its × hides that widget, the agent keeps working):
  its colour, its app, what it is doing now, a running clock, its result, and a **live preview of the window it works
  in** (about once a second, even when that window is behind others; a grid of 1-3 columns for up to 9 agents; the
  tray menu turns previews off). Parts waiting for a browser window or app say so. Every press or text insert flashes a ring in the agent's colour where it happened. The tray icon has Ask,
  Clear drawings, Stop the agents, Hide the buddy when idle, and Quit (`OVERLAY=off` turns the overlay off).
- **Voice.** Answers are spoken with ElevenLabs when `ELEVENLABS_API_KEY` is set (the first sentence is fetched on its
  own so speech starts in about half a second; the next lesson step is fetched while you listen), else with the Windows
  voice. Any failure, a bad key or low credits falls back to the Windows voice.
- **Several tasks at once**: a new task starts right away. Tasks share the computer: two browser windows (the second
  opens the first time two web parts run at once), two hands for desktop apps (Red and Purple), Word and your files.
  Parts that need different things run at the same time; two parts in the same app, or a third web part, wait their
  turn (their widgets say so). Each running task has its own **Stop**.
- **Fast lane.** Presses and text in desktop apps go straight through UI Automation (Invoke, Toggle, Select, Value: built
  into Windows, a few milliseconds each) instead of Cua's single input lane (about 0.6 s each), so agents in different
  apps really act at the same time. Anything it can't do safely goes through Cua (`FAST_INPUT=off` turns it off). The
  panel shows how many actions went each way.
- **Any app.** What an app drops in the background is done with its window in front for a moment (above). An app that
  shows nothing to accessibility tools (Epic Games Launcher, custom-drawn apps) is operated, with Claude, from
  pictures of its window: it clicks, types and presses keys there, and says when a game is updating or needs a sign-in.
  Games it knows (Fortnite, CS2, Dota 2...) start straight from their launcher's own link.
- **Hearing it right.** The recording keeps a moment from before the keys were down and after they came up (a clipped
  first or last word is the commonest mishearing). Speech-to-text uses beam search and a hint of the names you say: the
  apps, people and artists of the jobs that went well are remembered (`runs/voice-words.json`; `VOICE_WORDS` in `.env`
  adds your own). A word it was unsure of that sounds like one of those names is corrected ("defin" -> "deafen"). A job
  it is still unsure of is never done on a guess: it shows and says what it heard and waits ("Did you say ...? Say yes,
  or say it again"; "no, play Drake" corrects it; the words are also in the panel's box to fix by typing). Every job
  shows the words it heard ("On it: ..."), and the panel's feed lists each one.
- **Approvals** appear at the top of the panel and are said out loud; hold Ctrl+Win and say "yes" or "no", or click.
- **The panel** (the Mac version's design): command box with examples, agent cards with each one's colour, live steps
  (who decided each one: jev or Claude, and whether it went through the fast lane), tasks with their answers and
  evidence, cost and speed per task, **Undo last file moves**, and **Replay a past run** (from
  `runs/<runId>/steps.jsonl`).

## How a task runs

1. **Plan.** jev classifies each part of the instruction (web question, web task, calculate, write text, open app,
   files, chat, screen question) and rules fill in the details (search URL, Calculator buttons, text, folders, flights,
   directions, weather). With Claude, open-ended parts are planned by Claude instead. A part that uses what an earlier
   part finds ("write it in Notepad") waits for it; the others start at once and take turns only for the same thing
   (`src/lanes.ts`). If a part fails, the rest still run and the answer says what happened to each ("partial").
2. **Each step**: observe the window once → keep the controls that matter (at most 120, stable ids) → **jev** chooses the
   kind of action, the control and the text → act only if its confidence is ≥ 0.4. If not: re-ask jev with its top 6
   controls; then Claude if configured; without Claude, look for the answer on screen, allow harmless scrolls and waits,
   then stop with a reason rather than guess.
3. **Done** only when a check agrees: code (Calculator display, text read back, files on disk, Spotify's window title),
   else Claude, else jev's "goal achieved" check plus the line of the page that answers the question.
4. **Before giving up** on the web (no results, an error), Claude tries once more another way: other words, dates or
   places, another site. An app that keeps downloading or updating is reported ("still busy: Updating 37%") after a
   few waits, and an app that shows nothing to accessibility tools is reported within seconds, instead of holding up
   other tasks. A player page that is still filling in (YouTube's results) is waited for without asking a model.

| Module | What it does |
|---|---|
| `src/agent.ts` | the task loop: plan, parts at the same time, steps, guardrails, checks |
| `src/lanes.ts` | what each part needs to itself (an app, Word, files, then a browser window or an app hand) and taking turns for it |
| `src/planner.ts` | jev + rules planning (search, flights, directions, weather, calculator, text, files) |
| `src/jev.ts`, `src/claude.ts` | the two deciders |
| `src/router.ts` | the hotkey's words: a job for the agents, or a question for explain mode |
| `src/explain.ts`, `src/pointer.ts`, `src/ask.ts` | explain mode: the screen and its controls, Claude's answer placed on real controls, lessons; jev's answer without Claude |
| `src/overlay.ts`, `native/win/overlay.ps1` | the overlay: buddy, drawings, agents' widgets, flashes, typing box, keys, tray, screen capture, playing the voice |
| `src/voice.ts`, `src/results.ts` | ElevenLabs with the Windows voice as fallback; results tidied for the widgets and made sayable |
| `src/fastlane.ts`, `native/win/fastlane.ps1` | the fast lane: presses and text straight through UI Automation |
| `src/files.ts`, `src/safety.ts` | file operations (preview, run, check, undo); approval and secret-field rules |
| `src/driver/win.ts`, `mac.ts`, `sim.ts` | Cua on Windows (browser route + UI Automation), macOS (untested), simulator for tests |
| `src/server.ts`, `viewer/index.html` | panel, tasks, approvals, the hotkey and the overlay, conversation memory |
| `src/intake/index.ts`, `native/win/voice.py`, `native/mac/*`, `src/speak.ts` | hold-to-talk, on-device speech, spoken answers |

`bun test` runs the tests (simulated desktop, mocked deciders, real file conversions, a recorded voice clip). The
image and PDF conversion tests need Windows (System.Drawing, Chrome or Edge).
`bun scripts/smoke-win.ts` checks the real driver without models.

## What leaves the device

- Audio: never. Speech-to-text runs on the laptop (faster-whisper on Windows, SpeechTranscriber on the Mac).
- To TypeSafe: the instruction, the window's control labels and visible text, once per step.
- To Anthropic (only with a key): the same, and for explain mode one picture of **the screen under your cursor** (one
  monitor, scaled to at most 1568 pixels, the overlay never in it) with the labels of the controls on it, taken only
  when you press the talk keys or ask. Typed in the panel: only the window you were using. The picture is deleted after
  the answer; `runs/explain-journal.jsonl` keeps only the text.
- To ElevenLabs (only with a key): the text of the answers to be spoken.
- Files are processed on the laptop.

## Honest limits

- Electron and WebView2 apps (WhatsApp, Slack, Discord, the Claude app) show few controls to accessibility tools, so
  explain mode without Claude can only name the window there, and typing into them takes their window to the front for
  a moment. Without Claude, an app that shows nothing at all can't be used.
- The agent's browser is not signed in anywhere, so mail, calendars and shopping carts need you.
- jev alone does well when the plan is clear; open-ended multi-page tasks need Claude.
- Two browser windows and two app hands: a third web part (or third app) waits for one to be free, and two parts in
  the same app always take turns. The second browser window takes the foreground once when it first opens. The cost
  shown for tasks that ran at the same time can include some of each other's Claude calls.
- Cua ends a session after 5 idle minutes and closes its browser with it; the app keeps it alive every 60 s.

## Credits

Built during HacKU 2026; the design, colours, explain mode, router, voice and fast lane follow the team's Mac version
(Backstage). Used, with thanks: **Hands** by lithdew / team PUK (inspiration), **awlevin/typesafe-computer-use**
(MIT; classifier-per-step loop, gate rule), **Cua Driver** by trycua (MIT), **TypeSafe jev** (`@typesafe-ai/sdk` 0.6.0),
**Anthropic Claude** (`@anthropic-ai/sdk`), **ElevenLabs** (text to speech), **faster-whisper** (MIT) with OpenAI Whisper models, **sounddevice**,
**pynput**, **wttr.in**. `native/mac/*.swift` are by the team's Mac owner.
