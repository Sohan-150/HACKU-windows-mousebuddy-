// What was heard: misheard names corrected from the user's own vocabulary, and a job heard unsurely said back before
// anything is done. No microphone, no speech model: the words and probabilities are what voice.py sends.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { correctHeard, needsConfirm, soundKey, soundsLike, Vocabulary, type HeardWord } from "../src/heard";
import { newTask } from "../src/agent";
import { SimDriver } from "../src/driver/sim";
import { App } from "../src/server";
import { Voice } from "../src/voice";

process.env.SPEAK = "off";
process.env.OVERLAY = "off";

const tmpVocab = () => { const d = mkdtempSync(join(tmpdir(), "vocab-")); return { v: new Vocabulary(join(d, "voice-words.json")), d }; };
const W = (s: string, ...ps: number[]): HeardWord[] => s.split(" ").map((w, i) => [(i ? " " : "") + w, ps[i] ?? 0.95]);

describe("misheard names, corrected from what the user says", () => {
  test("sound keys and sound-alikes", () => {
    expect(soundKey("deafen")).toBe(soundKey("defin"));
    expect(soundKey("WhatsApp")).toBe(soundKey("Whatsup"));
    const terms = ["Mohit", "deafen", "Discord", "WhatsApp", "Spotify", "Dua Lipa"];
    expect(soundsLike("defin", terms)).toBe("deafen");
    expect(soundsLike("Mohid", terms)).toBe("Mohit");
    expect(soundsLike("Whatsup", terms)).toBe("WhatsApp");
    expect(soundsLike("Spotifai", terms)).toBe("Spotify");
    expect(soundsLike("discord", terms)).toBeUndefined();         // already right
    expect(soundsLike("music", terms)).toBeUndefined();
    expect(soundsLike("the", terms)).toBeUndefined();
    expect(soundsLike("team", ["Teams"])).toBeUndefined();        // a plural apart: an ordinary word, not the app
  });

  test("only words the model was unsure of are corrected; words still unsure are reported", () => {
    const terms = ["Mohit", "deafen", "Discord", "WhatsApp", "Dua Lipa"];
    // "defin" at 0.3 -> deafen; "Discord." keeps its full stop
    let c = correctHeard("defin me on Discord.", W("defin me on Discord.", 0.3), terms);
    expect(c.text).toBe("deafen me on Discord.");
    expect(c.fixed).toEqual([["defin", "deafen"]]);
    expect(c.unsure).toEqual([]);
    // a confident word that looks like a name is left alone
    c = correctHeard("message Mohid hi", W("message Mohid hi", 0.95, 0.9), terms);
    expect(c.text).toBe("message Mohid hi");
    // two words for a two-word name
    c = correctHeard("play Dua Leepa", W("play Dua Leepa", 0.97, 0.5, 0.4), terms);
    expect(c.text).toBe("play Dua Lipa");
    // nothing like it known: still unsure (stop words never count)
    c = correctHeard("play Dracons on Spotify", W("play Dracons on Spotify", 0.97, 0.18, 0.2, 0.93), terms);
    expect(c.text).toBe("play Dracons on Spotify");
    expect(c.unsure).toEqual(["Dracons"]);
    // the Mac's recogniser gives no word probabilities: kept as it is
    expect(correctHeard("defin me", undefined, terms)).toEqual({ text: "defin me", fixed: [], unsure: [] });
  });

  test("when to ask before doing", () => {
    const sure = { text: "x", fixed: [], unsure: [] };
    expect(needsConfirm(sure, { logprob: -0.2 })).toBe(false);
    expect(needsConfirm({ ...sure, unsure: ["Dracons"] }, { logprob: -0.3 })).toBe(true);
    expect(needsConfirm(sure, { logprob: -1.2 })).toBe(true);                       // the whole sentence was a struggle
    expect(needsConfirm(sure, { logprob: -0.6, noSpeech: 0.8 })).toBe(true);        // mostly noise
    expect(needsConfirm({ ...sure, unsure: ["Dracons"] }, {}, "off")).toBe(false);
    expect(needsConfirm(sure, {}, "always")).toBe(true);
  });

  test("the vocabulary learns names from jobs that went well, never from failed ones", () => {
    const { v, d } = tmpVocab();
    const t = newTask("message mohit hi on whatsapp", "voice");
    t.plan = { by: "jev+rules", question: "", subtasks: [{ surface: { kind: "app", app: "WhatsApp" }, goal: "message", values: [{ name: "who to reach", text: "mohit" }, { name: "message", text: "hi there how are you" }] }] };
    v.learnFrom({ ...t, status: "failed" });
    expect(v.words).toEqual([]);
    v.learnFrom({ ...t, status: "done" });
    expect(v.words.sort()).toEqual(["Mohit", "WhatsApp"]);
    expect(v.terms()).toContain("Mohit");
    // voice.py reads `words` from the file
    expect(JSON.parse(readFileSync(v.file, "utf8")).words.sort()).toEqual(["Mohit", "WhatsApp"]);
    v.learn(["play some music please", "the", "Dua Lipa"]);
    expect(v.words[0]).toBe("Dua Lipa");                        // a name; not a sentence, not a stop word
    expect(v.words).not.toContain("the");
    expect(new Vocabulary(v.file).words).toContain("Mohit");   // kept across restarts
    rmSync(d, { recursive: true, force: true });
  });
});

describe("a job heard unsurely is said back first", () => {
  const overlay = () => { const sent: any[] = []; return { sent, send: (m: any) => { sent.push(m); return true; } }; };
  const claude = {
    usage: { inputTokens: 0, outputTokens: 0, usd: 0 },
    plan: async () => ({ plan: { by: "claude" as const, question: "", subtasks: [{ surface: { kind: "answer" as const, reply: "Done." }, goal: "answer", values: [] }] }, ms: 1 }),
    decide: async () => { throw new Error("no"); }, write: async () => ({ text: "", ms: 0 }), url: async () => ({ url: "", ms: 0 }), verify: async () => ({ complete: true, answer: "", evidence: "", ms: 0 }),
  };
  const transcript = (text: string, words: HeardWord[], logprob = -0.3) => ({ event: "transcript" as const, lang: "en", text, ms: 400, logprob, no_speech: 0.01, words });

  test("unsure: 'Did you say ...?', in the panel's box; 'yes' runs it; a confident job runs at once, showing what was heard", async () => {
    const o = overlay();
    const { v, d } = tmpVocab();
    const app = new App(new SimDriver(), claude as any, null, "Mint-3", { send: o.send, voice: new Voice({ key: "" }), vocab: v });
    app.onVoice(transcript("play Dracons on Spotify", W("play Dracons on Spotify", 0.97, 0.18, 0.95, 0.93)));
    await Bun.sleep(30);
    expect(app.tasks).toHaveLength(0);
    expect(app.draft).toBe("play Dracons on Spotify");
    const ask = o.sent.filter(m => m.cmd === "answer").at(-1);
    expect(ask.show).toContain("Did you say “play Dracons on Spotify”? (not sure about “Dracons”)");
    expect(ask.say).toBe("I heard: play Dracons on Spotify. Is that right?");
    app.onVoice({ ...transcript("Okay.", W("Okay.")), maybe_noise: true });   // also what silence becomes, but a yes here
    await Bun.sleep(30);
    expect(app.tasks.map(t => t.instruction)).toEqual(["play Dracons on Spotify"]);
    expect(app.draft).toBe("");
    // sure of every word: done at once; the buddy shows the words heard, says "On it."
    app.onVoice(transcript("open notepad", W("open notepad")));
    await Bun.sleep(30);
    expect(app.tasks.map(t => t.instruction)).toEqual(["play Dracons on Spotify", "open notepad"]);
    const on = o.sent.filter(m => m.cmd === "answer" && m.say === "On it.").at(-1);
    expect(on.show).toBe("On it: “open notepad”");
    rmSync(d, { recursive: true, force: true });
  });

  test("'no, play Drake' is the command said right; 'no' alone drops it; a new command replaces it", async () => {
    const o = overlay();
    const { v, d } = tmpVocab();
    const app = new App(new SimDriver(), claude as any, null, "Mint-3", { send: o.send, voice: new Voice({ key: "" }), vocab: v });
    const unsure = () => app.onVoice(transcript("play Dracons on Spotify", W("play Dracons on Spotify", 0.97, 0.18, 0.95, 0.93)));
    unsure(); await Bun.sleep(20);
    app.onVoice(transcript("No, play Drake on Spotify.", W("No, play Drake on Spotify.")));
    await Bun.sleep(30);
    expect(app.tasks.map(t => t.instruction)).toEqual(["play Drake on Spotify."]);
    unsure(); await Bun.sleep(20);
    app.onVoice(transcript("No.", W("No.")));
    await Bun.sleep(20);
    expect(app.tasks).toHaveLength(1);
    expect(app.heard).toBeUndefined();
    unsure(); await Bun.sleep(20);
    app.onVoice(transcript("go to youtube", W("go to youtube")));   // starts with "go", but is not a yes
    await Bun.sleep(30);
    expect(app.tasks.map(t => t.instruction)).toEqual(["play Drake on Spotify.", "go to youtube"]);
    // fixed by typing in the panel's box and sent from there: a later "yes" doesn't run the old words
    unsure(); await Bun.sleep(20);
    app.add("play Drake on Spotify", "typed");
    app.onVoice(transcript("yes", W("yes")));
    await Bun.sleep(30);
    expect(app.tasks.map(t => t.instruction)).toEqual(["play Drake on Spotify.", "go to youtube", "play Drake on Spotify"]);
    rmSync(d, { recursive: true, force: true });
  });

  test("a misheard command word is fixed before routing ('defin me on Discord' runs as 'deafen me on Discord')", async () => {
    const o = overlay();
    const { v, d } = tmpVocab();
    const app = new App(new SimDriver(), claude as any, null, "Mint-3", { send: o.send, voice: new Voice({ key: "" }), vocab: v });
    app.onVoice(transcript("defin me on Discord", W("defin me on Discord", 0.3, 0.9, 0.9, 0.9)));
    await Bun.sleep(30);
    expect(app.tasks.map(t => t.instruction)).toEqual(["deafen me on Discord"]);
    rmSync(d, { recursive: true, force: true });
  });
});
