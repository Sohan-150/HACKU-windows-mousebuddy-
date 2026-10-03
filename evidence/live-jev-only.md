# Live runs on Windows, TypeSafe jev only (no Claude key)

Sat 3 Oct 2026, Windows 11 laptop (i7-14700HX), Cua Driver 0.32.0, Chrome with the driver's isolated profile.
Tasks were sent to the running panel with `bun scratch/live.ts "<instruction>" [approve|deny]`; each line of its output
is one logged step (`runs/<runId>/steps.jsonl`). `.env`: `TYPESAFE_API_KEY`, `REGION=HK`, `CURRENCY=HKD`; no Anthropic key.

## Tasks

| Instruction | Result | Time | Cost | Checked by |
|---|---|---|---|---|
| Find out when the University of Hong Kong was founded | "Established in 1911, the University of Hong Kong …" | 10.1 s | $0.00043 | jev (goal p=0.94, answer line 0.77) |
| what's the weather in Hong Kong | "Hong Kong: Partly Cloudy, +28°C (feels like +31°C), wind 11km/h, humidity 74%" | 5.6 s | $0.00024 | jev |
| Get directions from Central to Hong Kong Airport | "Driving 30 min 36.3 km via Route 8 …" | 9.9 s | $0.00027 | jev (0.95 / 0.95) |
| Find flights from Hong Kong to Tokyo on 20 November | "From 2289 Hong Kong dollars round trip total. Nonstop flight with Hong Kong Express. Leaves HKG 2:00 PM … arrives Narita 7:05 PM … 4 hr 5 min" | 15.2 s | $0.00045 | jev (0.96 / 0.64) |
| check the weather in Tokyo then write it in Notepad | weather read, then typed into Notepad; asked first because that Notepad tab already held other text | 19.6 s | $0.00059 | jev, then code read-back |
| Write "Call the dentist at 3pm" in Notepad | written in a new Notepad window; the earlier window's text untouched | 14.3 s | $0.00034 | code read-back |
| Organise the folder "…\scratch\files-demo" → **deny** | nothing moved | 0.7 s | $0.00018 | — |
| same → **approve** | 9 files into Archives, Spreadsheets, Images, PDFs, Documents, Audio | 0.7 s | $0.00018 | code, on disk |
| Undo last file moves (panel button / `POST /api/undo-moves`) | 9 moved back, 0 failed | <1 s | — | — |
| what is 15% of 80 | Calculator pressed 80 × 0.15 =; "The result is 12." | 16.8 s | $0.00156 | code (display = 12) |
| write that in Notepad (follow-up) | wrote "The result is 12." (answer of the previous task) | 12.0 s | $0.00033 | code read-back |
| Search for lofi beats on YouTube | results page | 11.8 s | $0.00023 | jev (0.81) |
| Play lofi hip hop radio on YouTube | waited for results, opened the first match, rejected YouTube's cookie dialog in code, video page open | 46.0 s | $0.00071 | jev (0.84) |

Earlier the same day (same build line): Calculator 128.5 × 12 = 1,542 (26 s, $0.0017, code-checked), PNG → JPG convert (1.9 s, header-checked).

## Point-and-ask

| Check | Result |
|---|---|
| `POST /api/ask {text:"what is this?", x, y}` on the top window's Minimize button | "You're pointing at the button "Minimize" in "<window title>"", 1.3 s, no model call |
| Hold-Ctrl flow (`scratch/voiceflow.ts`: the same down / up / transcript events voice.py sends, real cursor and Cua) | answered 3.1 s after key-down, of which 2.3 s was simulated speaking + transcription |
| jev `pickControl` ("where is …") on a fixed control list | Save 0.99, Settings 0.91, Print 0.89; "spaceship button" -> none (1.00); 0.4-1.4 s each |
| `move_cursor` scope "window" (pointing at the answer) | agent cursor moved; the real mouse stayed where it was |
| "where is the equals button?" on Calculator (`scratch/askcalc.ts`: real jev, cursor and ring) | jev chose "Equals"; ring drawn at its frame (1391,929 77×43); agent cursor ended at (1430,951) = the button's centre; 1.6 s |
| Highlight ring (`native/win/highlight.ps1`) | topmost, click-through, fades after 2.5 s; foreground window changed 0 times over 3 show/fade/close rounds (polled every 20 ms); helper exits when the agent closes it |

## Found and fixed during these runs

- **Cookie walls.** Google served its consent page in Norwegian (the IP looks Norwegian), and jev clicked "Godta alle"
  (accept all), which the English-only approval words missed. Fixed three ways: Google URLs carry `hl=en`; a code rule
  clicks "Reject all" (14 languages, plus any "Reject … cookies" button) without asking; "accept" in other languages now
  needs approval like "Accept all".
- **"Central" looked up in the wrong country.** Maps resolved it near the IP location. `REGION=HK` adds `gl=hk`
  (and `CURRENCY=HKD` adds `curr=HKD` for flights); Claude's planner is told the same.
- **jev unsure on pages still loading** (Maps, YouTube): without Claude the run now (1) checks whether the answer is
  already on screen, (2) lets an unsure scroll or wait happen (they change nothing), (3) waits twice for the page to
  settle, and only then stops.
- **"Play X on YouTube"**: results open directly from the site's search URL; when jev cannot choose, the first link in
  page order that matches the search words is opened.
- **Goal wording**: a site search's goal is now the state to reach ("results for X are shown"), not the instruction.

## Not tested yet

- Anything with Claude (no Anthropic key was given): planning open-ended tasks, taking over unsure steps, writing text,
  the result check, and point-and-ask with a screenshot.
- Push-to-talk with a real microphone and a person (voice.py was run on a recorded clip; the key/pointer flow with
  synthetic events).
- macOS.

# With Claude (Sonnet 5.5 default, Haiku 4.5), same day, evening

Key added by the team; only `claude-sonnet-5-5` and `claude-haiku-4-5` were used. Total Claude spend for all of the
runs below, including the failed first attempts: about $0.25.

| Model | Instruction | Result | Time | Cost |
|---|---|---|---|---|
| Sonnet | Explain what a VPN is in two sentences | answered directly, no computer action | 4.0 s | $0.0076 |
| Sonnet | Find the opening hours of the Hong Kong Museum of Art | DuckDuckGo results read and checked by Claude: Mon-Wed, Fri 10-18; Sat-Sun 10-19; closed Thursdays (noted they are third-party sources) | 12.1 s | $0.018 |
| Sonnet | Go to the Wikipedia page for Victoria Harbour and tell me how deep it is | read the whole article in one call (no depth given there), searched instead: average about 12.2 m, maximum 43 m at Lei Yue Mun, with the disagreeing sources named | 32.0 s | $0.047 |
| Sonnet | Book the cheapest one-way flight from Hong Kong to Taipei on 15 November: go as far as you can without paying | Google Flights, cookies rejected in code, sorted by cheapest, HK Express 12:10 PM nonstop HK$752 selected, stopped at the booking options with what to click next; all approvals denied by the test | 70.6 s | $0.036 |
| Sonnet | point at M+ in Calculator: "what does this button do?" (window screenshot) | correct explanation; the button circled | 4.3 s | $0.005 |
| Sonnet | pointer on Equals: "how do I calculate a square root here?" | explained, then moved its cursor to the Square root button and circled it | 4.0 s | $0.003 |
| Haiku | What is the population of Hong Kong? | about 7.38 million (2026), from the results page | 13.0 s | $0.0067 |
| Haiku | how does that compare to Singapore? (follow-up) | Singapore 6.21 M vs Hong Kong 7.38 M, using the previous answer | 11.2 s | $0.0072 |
| Haiku | Open Notepad and write a short thank-you note to my teacher | Claude wrote the note; typed once; read back in code, line breaks kept | 17.9 s | $0.0038 |

Found and fixed during these runs:
- **Scrolling forever on a long page** (the first Victoria Harbour run: 40 scroll steps). Snapshots only cover what is on
  screen, so a question now reads the whole page in one read-only call (`page get_text`, ~0.2 s for an 18 KB article)
  before any scrolling; if the answer is not there Claude is told so and the fact is kept for the whole task; 8 scrolls
  per page at most.
- **Google web search blocks the agent's browser** ("sorry" page). Searches go to DuckDuckGo, in code.
- **"Write a note to my teacher" was typed literally** by the rules. Text to compose goes to Claude (without Claude, the
  agent asks for the exact words).
- **Long text failed the read-back check**: the check compared against a 200-character copy. It reads the full value.
- **Plans where Claude answers directly crashed the panel's live feed.** Fixed.
- **Personal details guard**: a passenger / sign-up form field (name, email, phone, birth date, address) is filled only
  with text from the user's own instruction; otherwise the agent stops there and says so.
- A part with a code check now ends the moment the check passes (Calculator 26 s -> 21 s).
