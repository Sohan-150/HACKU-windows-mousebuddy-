// Spoken answers: ElevenLabs when ELEVENLABS_API_KEY is set, otherwise the Windows voice. Ported from the Mac version.
//
// The server fetches the audio (the key never leaves this process) and hands the MP3 to the overlay. The first sentence
// is fetched on its own so speech starts in about half a second while the rest is still being made. Audio is cached by
// text, so "repeat", "back" and the recurring 'Say "next"…' cost nothing, and the next lesson step is fetched while you
// listen to the current one. Any failure (no key, network, quota) falls back to the Windows voice for that sentence;
// a bad key or an empty quota switches ElevenLabs off until restart.
//
// Free plan: 10,000 credits a month; both models below cost 0.5 credit per character (measured on the Mac).
import { createHash } from "node:crypto";

const VOICE_ID = () => process.env.ELEVENLABS_VOICE ?? "Xb7hH8MSUJpSbSDYk0k2"; // Alice: clear British English, a tutor's voice
const FAST = "eleven_flash_v2_5"; // ~75 ms model latency, English and 30 other languages
const MULTI = "eleven_v4_turbo"; // the only fast model that speaks Cantonese
const MAX_PARALLEL = 2; // the free plan allows 2 requests at a time
const KEEP_CREDITS = 300; // stop using ElevenLabs before the monthly quota runs out mid-sentence
const CANTONESE = /[嘅咗喺唔係佢嘢啲冇咁乜睇搵撳噉哋]/;
const HAN = /\p{Script=Han}/u;

type Http = (url: string, init?: RequestInit) => Promise<Response>;

export interface Speech { audio?: Uint8Array; ms: number; credits?: number; model?: string; error?: string; cached?: boolean }

export class Voice {
  private key: string | undefined;
  private enabled: boolean;
  private cache = new Map<string, Promise<Speech>>();
  private left?: number; // credits left this month (from /v1/user/subscription, then counted down)
  private checked?: Promise<void>;
  private running = 0;
  private waiting: (() => void)[] = [];

  constructor(opts: { key?: string; fetch?: Http } = {}) {
    this.key = (opts.key ?? process.env.ELEVENLABS_API_KEY)?.trim() || undefined;
    this.enabled = !!this.key && process.env.VOICE_OUT !== "system";
    if (opts.fetch) this.http = opts.fetch;
  }
  private http: Http = (url, init) => fetch(url, init);

  get name() { return this.enabled ? "ElevenLabs" : "Windows voice"; }
  get on() { return this.enabled; }
  /** credits left this month, when known */
  get credits() { return this.left; }

  /** check the quota at startup: it also opens the connection, so the first answer isn't slowed down by it */
  warm() { if (this.enabled) this.checked ??= this.quota(); }

  /** split for a fast start: the first sentence (at least ~40 characters), then the rest */
  static parts(text: string): string[] {
    const sentences = text.trim().split(/(?<=[.!?。！？])\s*/).filter(Boolean);
    let i = 1;
    while (i < sentences.length && sentences.slice(0, i).join(" ").length < 40) i++;
    const head = sentences.slice(0, i).join(" ");
    const rest = sentences.slice(i).join(" ");
    return rest ? [head, rest] : [head];
  }

  /** MP3 for this text (cached), or no audio: the overlay then uses the Windows voice */
  speak(text: string): Promise<Speech> {
    if (!this.enabled || !text.trim()) return Promise.resolve({ ms: 0 });
    const id = createHash("sha1").update(text).digest("hex");
    const hit = this.cache.get(id);
    if (hit) return hit.then(s => ({ ...s, cached: true }));
    const p = this.fetch(text);
    this.cache.set(id, p);
    p.then(s => { if (!s.audio) this.cache.delete(id); }); // retry a failed sentence next time
    if (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value!);
    return p;
  }

  private async fetch(text: string): Promise<Speech> {
    const t0 = performance.now();
    const ms = () => Math.round(performance.now() - t0);
    this.checked ??= this.quota();
    await this.checked;
    if (!this.enabled) return { ms: ms(), error: "ElevenLabs is off" };
    const cost = Math.ceil(text.length / 2);
    if (this.left !== undefined && this.left - cost < KEEP_CREDITS) { this.enabled = false; return { ms: ms(), error: `ElevenLabs credits nearly used up (${this.left} left): using the Windows voice` }; }
    const han = HAN.test(text);
    const model = han ? MULTI : FAST;
    if (this.running >= MAX_PARALLEL) await new Promise<void>(r => this.waiting.push(r));
    this.running++;
    try {
      const r = await this.http(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID()}/stream?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": this.key!, "Content-Type": "application/json" },
        body: JSON.stringify({ text, model_id: model, ...(han && CANTONESE.test(text) ? { language_code: "yue" } : {}) }),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) {
        const body = (await r.text()).slice(0, 200);
        if (r.status === 401 || /quota_exceeded/.test(body)) this.enabled = false;
        return { ms: ms(), error: `ElevenLabs ${r.status}: ${body}` };
      }
      const audio = new Uint8Array(await r.arrayBuffer());
      const used = Number(r.headers.get("character-cost") ?? r.headers.get("x-character-count") ?? cost);
      if (this.left !== undefined) this.left -= used;
      return { audio, ms: ms(), credits: used, model };
    } catch (e: any) {
      return { ms: ms(), error: `ElevenLabs: ${String(e?.message ?? e).slice(0, 120)}` };
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  private async quota() {
    try {
      const r = await this.http("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": this.key! }, signal: AbortSignal.timeout(4000) });
      if (r.status === 401) {
        // A key limited to Text to Speech may not read the subscription: speak anyway, without knowing the quota.
        if (/missing_permission/i.test(await r.text())) { console.log("[voice] ElevenLabs: this key can't read the quota (no User permission); speaking anyway"); return; }
        this.enabled = false; console.log("[voice] ElevenLabs key rejected: using the Windows voice"); return;
      }
      const j: any = await r.json();
      this.left = j.character_limit - j.character_count;
      console.log(`[voice] ElevenLabs (${j.tier}): ${this.left} of ${j.character_limit} credits left this month`);
    } catch { /* unknown quota: try anyway, the API refuses cleanly when it's empty */ }
  }
}
