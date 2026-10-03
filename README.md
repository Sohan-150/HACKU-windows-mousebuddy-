# Background Agent

A desktop assistant that does what you ask, behind your windows. Type an instruction, or **hold Ctrl+Win and say it**. It
works in its own browser window (a throwaway profile), in desktop apps through the accessibility interface, or directly
on files in your user folder. **Point the mouse at something and ask** "what is this?" or "where is the save button?" and,
like [Clicky](https://clicky.foo), it answers out loud, glides its own coloured cursor to the control and circles it.

Every task ends **done, with the answer and the evidence it was read from**, or **failed, with a reason**.

- **TypeSafe jev** decides almost every step: a cheap, fast classifier (about $0.0003 per task above). With rules it also
  plans the common tasks, so the agent runs on the jev key alone.
- **Claude** (optional) plans open-ended tasks, takes over steps jev is unsure about, writes text nobody planned, checks
  results, and answers point-and-ask questions from a screenshot. Default model `claude-sonnet-5-5`; `claude-haiku-4-5`
  is cheaper (`CLAUDE_MODEL` in `.env`).

Measured runs are in [evidence/live-jev-only.md](evidence/live-jev-only.md). Windows and Mac notes are in
[../BUILD-WINDOWS-AND-MAC.md](../BUILD-WINDOWS-AND-MAC.md).

## What it can do (jev only, tested live)

| Ask | What happens |
|---|---|
| "When was HKU founded?", "what's the capital of Australia" | web search, the answer line read off the page |
| "What's the weather in Tokyo" | current weather (wttr.in) |
| "Find flights from Hong Kong to Tokyo on 20 November" | Google Flights results; cheapest top option read out. Never books or pays |
| "Directions from Central to the airport" | Google Maps route and time |
| "Play lofi beats on YouTube", "search GitHub for bun" | the site's own search page, then the first match |
| "What is 15% of 80", "calculate 128.5 times 12" | Windows Calculator, result checked in code |
| "Write \"call the dentist\" in Notepad", then "write that in Notepad" | Notepad, text read back in code; follow-ups use the last answer |
| "Organise my Downloads", "convert the PNGs on my Desktop to jpg", "how many PDFs in Documents" | files on disk: preview, approval, check, **Undo** |
| "Find the weather in Tokyo then write it in Notepad" | multi-step: up to 5 parts, each checked |
| Point + "what is this?" / "where is settings?" / "read this" | answered from the window under the pointer; the control is circled |
| "Where is my Year 1 folder?", "open my tax return" | searched on disk by name ("one" = "1", case and spaces ignored); shown in File Explorer |

With a Claude key it also composes text ("write a thank-you note"), takes on open-ended web tasks (search, compare,
go as far as the page before payment: tested with a real flight to Taipei), explains what you point at from a
screenshot, answers "how do I …" questions about the app you are pointing at (tutor style), and can point at things
that are not in the accessibility list. Tested live with Sonnet 5.5 and Haiku 4.5; see the evidence file.

## Safety, in code (whatever a model decides)

- Clicks that look irreversible (send, pay, book, submit, delete, save, accept; "accept" also in other languages) wait for your
  approval in the panel, or a spoken "yes" / "no". Cookie banners get "Reject all" automatically.
- Never types into password, card or ID fields; never completes a purchase or booking.
- Files: only inside your user folder, never deleted, never overwritten (`a (1).txt`), every move undoable.
- Existing text in an app is never replaced silently: it opens a new tab, or asks.
- Point-and-ask is read-only. Its cursor is the agent's overlay; the marks are click-through, and neither they nor the
  bubble ever take focus (0 foreground changes measured); your mouse is never moved.
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
4. Voice (optional; typing always works). Needs [uv](https://docs.astral.sh/uv/):
   ```powershell
   uv venv --python 3.12 native\win\.venv
   uv pip install --python native\win\.venv\Scripts\python.exe -r native\win\requirements.txt
   native\win\.venv\Scripts\python.exe native\win\voice.py --check
   ```
   The first start downloads the `small` speech model (about 480 MB). Settings > Privacy > Microphone must allow desktop apps.
5. `powershell -ExecutionPolicy Bypass -File scripts\start.ps1` starts the daemon, runs the preflight and opens the panel
   at http://127.0.0.1:3000/. Or step by step: `scripts\daemon.ps1`, `bun run preflight`, `bun start`.

The agent's own Chrome (or Edge) window opens at start-up and **takes the foreground once**; after that it works behind
whatever you have in front (0 of 2,075 polls with it in front, measured).

## Quick start: macOS (written, not yet run)

Cua Driver 0.32.0 with Accessibility and Screen Recording granted; `sh scripts/daemon.sh`; `bun install`; `.env`;
voice helpers as in [native/mac/README.md](native/mac/README.md) (Right-Option); then `sh scripts/start.sh`.

## Using it

- **Type** an instruction and press Enter, or click an example.
- **Hold Ctrl+Win and talk** (`PTT_KEY` changes it: `ctrl_alt`, `ctrl_shift`, `right_ctrl`, `f8`...; the Fn key never
  reaches Windows, so it cannot be used). The agent's cursor glides next to your pointer while it listens. Another key
  (a shortcut such as Ctrl+Win+D), a click or a scroll cancels the recording. Release to run it. Answers are spoken
  (`SPEAK=off` to silence). `VOICE_MODE=draft` puts what you said in the box instead of running it.
- **Answers on the screen**: a small bubble shows "Listening…", "Thinking…", the answer (next to your pointer for
  point-and-ask, bottom right otherwise), approvals and the result of every task, so you never have to switch to the
  panel. Click it to close it; it never takes focus (`BUBBLE=off` to turn it off).
- **Point and ask**: hold Ctrl+Win, point at something, ask "what is this?", "what does this button do?", "where is
  print?", "read this" (with Claude also "how do I make a pivot table?", "circle the zebra and the hippo", "what am I
  looking at?"). The answer is spoken; what it talks about is marked with rings, boxes, arrows or underlines, each with
  its own colour and a label (`HIGHLIGHT=off` to turn them off). Typed in the panel, the same questions are about the
  window you were using before the panel. Or type the question, press **Point & ask**, and point within 3 seconds.
- **Approvals** appear at the top of the panel and in the bubble; with voice, hold Ctrl+Win and say "yes" or "no".
- **Stop**, **Clear**, **Undo last file moves**, and **Replay a past run** (from `runs/<runId>/steps.jsonl`).

## How a task runs

1. **Plan.** jev classifies each part of the instruction (web question, web task, calculate, write text, open app,
   files, chat, screen question) and rules fill in the details (search URL, Calculator buttons, text, folders, flights,
   directions, weather). With Claude, open-ended parts are planned by Claude instead.
2. **Each step**: observe the window once → keep the controls that matter (at most 120, stable ids) → **jev** chooses the
   kind of action, the control and the text → act only if its confidence is ≥ 0.4. If not: re-ask jev with its top 6
   controls; then Claude if configured; without Claude, look for the answer on screen, allow harmless scrolls and waits,
   then stop with a reason rather than guess.
3. **Done** only when a check agrees: code (Calculator display, text read back, files on disk), else Claude, else jev's
   "goal achieved" check plus the line of the page that answers the question.

| Module | What it does |
|---|---|
| `src/agent.ts` | the task loop: plan, steps, guardrails, checks |
| `src/planner.ts` | jev + rules planning (search, flights, directions, weather, calculator, text, files) |
| `src/jev.ts`, `src/claude.ts` | the two deciders |
| `src/pointer.ts`, `src/ask.ts`, `src/overlay.ts`, `native/win/overlay.ps1` | point-and-ask: window and control under the pointer (or behind the panel), the answer, pointing back, the marks and the answer bubble |
| `src/files.ts`, `src/safety.ts` | file operations (preview, run, check, undo); approval and secret-field rules |
| `src/driver/win.ts`, `mac.ts`, `sim.ts` | Cua on Windows (browser route + UI Automation), macOS (untested), simulator for tests |
| `src/server.ts`, `viewer/index.html` | panel, task queue, approvals, voice routing, conversation memory |
| `src/intake/index.ts`, `native/win/voice.py`, `native/mac/*`, `src/speak.ts` | hold-to-talk, on-device speech, spoken answers |

`bun test` runs the tests (simulated desktop, mocked deciders, real file conversions, a recorded voice clip). The
image and PDF conversion tests need Windows (System.Drawing, Chrome or Edge).
`bun scripts/smoke-win.ts` checks the real driver without models.

## What leaves the device

- Audio: never. Speech-to-text runs on the laptop (faster-whisper on Windows, SpeechTranscriber on the Mac).
- To TypeSafe: the instruction, the window's control labels and visible text, once per step.
- To Anthropic (only with a key): the same, and for point-and-ask a screenshot of **the one window you point at**
  (Clicky sends all monitors; this sends one window on purpose).
- Files are processed on the laptop.

## Honest limits

- Electron apps (Slack, Discord, the Claude app) show few controls to accessibility tools, so point-and-ask without
  Claude can only name the window there.
- The agent's browser is not signed in anywhere, so mail, calendars and shopping carts need you.
- jev alone does well when the plan is clear; open-ended multi-page tasks need Claude.
- Cua ends a session after 5 idle minutes and closes its browser with it; the app keeps it alive every 60 s.

## Credits

Built during HacKU 2026. Used, with thanks: **Hands** by lithdew / team PUK (inspiration), **awlevin/typesafe-computer-use**
(MIT; classifier-per-step loop, gate rule), **Cua Driver** by trycua (MIT), **TypeSafe jev** (`@typesafe-ai/sdk` 0.6.0),
**Anthropic Claude** (`@anthropic-ai/sdk`), **faster-whisper** (MIT) with OpenAI Whisper models, **sounddevice**,
**pynput**, **wttr.in**. `native/mac/*.swift` are by the team's Mac owner.
