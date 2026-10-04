"""Windows push-to-talk + on-device speech-to-text. The Windows twin of native/mac/ptt-helper + stt.

Hold the push-to-talk keys (default Ctrl+Win, as in Clicky; --key ctrl_alt, ctrl_shift, ctrl, right_ctrl... also work),
speak, release. Another key while they are held (a shortcut such as Ctrl+Win+D), a click or a scroll cancels the
recording; a tap shorter than MIN_HOLD_MS is ignored. Moving the mouse is fine: that is how you point at what you ask
about. Holding Win normally opens Start when it is let go; an unassigned key is tapped while talking to prevent that. Audio never leaves the laptop:
faster-whisper runs on the CPU. One warm process, so the model loads once.

Prints one JSON object per line on stdout (same event names as the Mac ptt-helper):
  {"event":"status", ...}   {"event":"ready", ...}   {"event":"down","t":...}   {"event":"up","t":...,"ms":...}
  {"event":"transcript","lang":"en"|"yue"|"zh","text":"...","ms":...,"audio_ms":...,
   "logprob":-0.3,"no_speech":0.01,"words":[["play",0.98],["Drake",0.61]]}   {"event":"error","msg":"..."}
The words and their probabilities let the agent fix a misheard name it knows, and ask before acting on a guess.

Accuracy: the clip starts PRE_ROLL_S before both keys were down and ends POST_ROLL_S after they came up (people start
talking as they press and stop as they let go: a clipped first or last word is the commonest mishearing); quiet input
is levelled; beam search; silence trimmed (VAD); and a hint of the words this user says (apps, the names of the people
and artists they asked for, kept by the agent in the VOICE_VOCAB file, plus VOICE_WORDS) so names come out spelled right.

usage:
  python voice.py [--model small] [--key ctrl_win|ctrl_alt|ctrl_shift|ctrl|right_ctrl|...]   # listen
  python voice.py --file clip.wav [--model ...]                  # transcribe one file and exit
  python voice.py --check                                        # list the microphone and exit
"""
import argparse
import collections
import json
import os
import queue
import sys
import threading
import time
import wave

import numpy as np

RATE = 16000
BLOCK = 1600                           # 0.1 s of audio per callback
MIN_HOLD_MS = 400                      # shorter presses are ordinary key use, not speech
PRE_ROLL_S = 0.4                       # kept from before both keys were down
POST_ROLL_S = 0.3                      # kept after they came up
BEAM = int(os.environ.get("VOICE_BEAM", "5"))   # beam search: fewer mishearings than greedy (1), a little slower
# What whisper says for silence or noise. Sent marked "maybe_noise": the agent keeps one only when it means something
# then ("okay" or "thank you" during a lesson, "okay" to a yes/no question).
HALLUCINATIONS = {"you", "thank you", "thank you.", "thanks for watching", "thanks for watching!", "bye", "bye.", ".", "okay.", "so"}
KEEP_LANGS = ("en", "yue", "zh")       # English, Cantonese, (written) Chinese
sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)


def emit(event, **kw):
    try:
        print(json.dumps({"event": event, **kw}, ensure_ascii=False), flush=True)
    except (OSError, ValueError):   # the agent that started us is gone: stop listening to the keyboard
        os._exit(0)


def now_ms():
    return round(time.time() * 1000)


def load_model(name):
    """The model, and the name actually loaded: an English-only model (small.en) that can't be had (offline on the
    first start) falls back to the multilingual one of the same size."""
    from faster_whisper import WhisperModel
    t0 = time.time()
    threads = max(4, min(12, (os.cpu_count() or 8) // 2))
    try:
        model = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=threads)
    except Exception as e:
        if not name.endswith(".en"):
            raise
        emit("status", note=f"{name} could not be loaded ({str(e)[:120]}); using {name[:-3]}")
        name = name[:-3]
        model = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=threads)
    return model, round((time.time() - t0) * 1000), name


LANG = None   # set from --lang; "en" by default (English dictation)
# Words the assistant hears a lot: a hint for the speech model, so "deafen" isn't "defin" and "Drake" isn't "Dracons".
BASE_WORDS = ["Spotify", "Discord", "WhatsApp", "YouTube", "Chrome", "Calculator", "Notepad", "Word", "Excel", "VS Code",
              "Steam", "Epic Games", "Fortnite", "Drake", "mute", "unmute", "deafen", "undeafen", "message"]
_vocab = {"path": "", "mtime": -1.0, "words": []}


def user_words():
    """The names this user says: VOICE_WORDS in .env (comma separated), and the VOICE_VOCAB file the agent keeps
    (apps, people and artists from finished tasks), read again whenever it changes."""
    path = os.environ.get("VOICE_VOCAB", "")
    try:
        mtime = os.path.getmtime(path) if path else -1.0
    except OSError:
        mtime = -1.0
    if path != _vocab["path"] or mtime != _vocab["mtime"]:
        words = []
        if mtime >= 0:
            try:
                with open(path, encoding="utf-8") as f:
                    words = [str(w) for w in json.load(f).get("words", []) if str(w).strip()]
            except (OSError, ValueError, AttributeError):
                words = []
        _vocab.update(path=path, mtime=mtime, words=words)
    own = [w.strip() for w in os.environ.get("VOICE_WORDS", "").split(",") if w.strip()]
    return own + _vocab["words"]


def hint():
    """The prompt the model sees as what came before: a few typical commands, then the names (yours first). Kept
    short: the model only keeps the last ~220 tokens of it."""
    seen, names = set(), []
    for w in user_words() + BASE_WORDS:
        if w.lower() not in seen and len(names) < 60:
            seen.add(w.lower())
            names.append(w)
    return ("Commands for a computer assistant: open Spotify and play a song, mute me on Discord, message a friend on "
            "WhatsApp, next, go back, repeat, quit. Names: " + ", ".join(names) + ".")


def normalise(audio):
    """No offset, and a quiet microphone brought up (at most +18 dB): whisper mishears quiet speech far more."""
    audio = np.asarray(audio, dtype=np.float32)
    if not len(audio):
        return audio
    audio = audio - float(np.mean(audio))
    peak = float(np.max(np.abs(audio)))
    if 0 < peak < 0.5:
        audio = audio * min(8.0, 0.9 / peak)
    return audio.astype(np.float32)


def _decode(model, audio, lang, prompt, vad):
    opts = dict(language=lang, beam_size=BEAM, initial_prompt=prompt, condition_on_previous_text=False,
                without_timestamps=True, word_timestamps=True, temperature=[0.0, 0.2, 0.4], vad_filter=vad)
    if vad:
        opts["vad_parameters"] = dict(min_silence_duration_ms=500, speech_pad_ms=400)
    try:
        segs, info = model.transcribe(audio, **opts)
        return list(segs), info
    except TypeError:   # an older faster-whisper without one of these options: the plain way
        segs, info = model.transcribe(audio, language=lang, beam_size=BEAM, initial_prompt=prompt,
                                      condition_on_previous_text=False, without_timestamps=True, vad_filter=vad)
        return list(segs), info


def transcribe(model, audio):
    """One pass. With --lang (default en) the language is fixed, which is faster and avoids misdetection on short
    clips. With --lang auto: detect, and if the result is not English or Chinese/Cantonese, run again forced to the
    likelier of those."""
    t0 = time.time()
    audio = normalise(audio)
    prompt = hint()
    segs, info = _decode(model, audio, LANG, prompt, vad=True)
    if not segs:   # the silence trimming found no speech (a very quiet voice): the whole clip, untrimmed
        segs, info = _decode(model, audio, LANG, prompt, vad=False)
    lang = info.language
    if LANG is None and lang not in KEEP_LANGS:
        probs = dict(info.all_language_probs or [])
        lang = max(KEEP_LANGS, key=lambda l: probs.get(l, 0.0))
        segs, _ = _decode(model, audio, lang, prompt, vad=True)
    text = "".join(s.text for s in segs).strip()
    words = [[w.word, round(float(w.probability), 3)] for s in segs for w in (getattr(s, "words", None) or [])]
    logprob = round(float(np.mean([s.avg_logprob for s in segs])), 3) if segs else 0.0
    no_speech = round(float(max(s.no_speech_prob for s in segs)), 3) if segs else 1.0
    if text and len(text.split()) > 3 and text.strip(" .,").lower() in prompt.lower():
        text, words = "", []   # the hint itself came back (a near-silent clip): nothing was said
    return {"lang": lang, "text": text, "ms": round((time.time() - t0) * 1000),
            "audio_ms": round(len(audio) / RATE * 1000), "lang_p": round(float(info.language_probability), 3),
            "logprob": logprob, "no_speech": no_speech, "words": words}


def read_wav(path):
    with wave.open(path, "rb") as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise SystemExit("need 16-bit mono wav")
        raw = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
        rate = w.getframerate()
    if rate != RATE:   # simple linear resample, fine for speech
        n = int(len(raw) * RATE / rate)
        raw = np.interp(np.linspace(0, len(raw) - 1, n), np.arange(len(raw)), raw).astype(np.float32)
    return raw


def key_groups(name):
    """The push-to-talk key as groups that must all be held: "ctrl_win" = (a Ctrl key) + (a Windows key).
    The Fn key is handled inside the keyboard and never reaches Windows, so it cannot be part of a combo."""
    from pynput import keyboard
    K = keyboard.Key
    CTRL, WIN = (K.ctrl_l, K.ctrl_r, K.ctrl), (K.cmd, K.cmd_l, K.cmd_r)
    ALT, SHIFT = (K.alt_l, K.alt_r, K.alt, K.alt_gr), (K.shift_l, K.shift_r, K.shift)
    table = {"ctrl_win": (CTRL, WIN), "ctrl_alt": (CTRL, ALT), "ctrl_shift": (CTRL, SHIFT), "ctrl": (CTRL,),
             "right_ctrl": ((K.ctrl_r,),), "left_ctrl": ((K.ctrl_l,),), "right_alt": ((K.alt_r, K.alt_gr),),
             "right_shift": ((K.shift_r,),), "f8": ((K.f8,),), "f9": ((K.f9,),), "scroll_lock": ((K.scroll_lock,),)}
    if name not in table:
        raise SystemExit(f"unknown key {name}; use one of {', '.join(table)}")
    return table[name], any(k in WIN for g in table[name] for k in g)


MASK_VK = 0xE8   # an unassigned key code; tapping it while Win is held stops Windows opening Start when Win is let go


class Recorder:
    """Microphone blocks in, one clip per push-to-talk out: with the last PRE_ROLL_S from before the keys were down
    (people start talking as they press) and POST_ROLL_S after they came up (the end of the last word). Pure state, so
    it is tested without a microphone; `done(clip)` gets each finished clip."""

    def __init__(self, done, rate=RATE, block=BLOCK, pre_s=PRE_ROLL_S, post_s=POST_ROLL_S, timer=None):
        self.ring = collections.deque(maxlen=max(1, int(round(pre_s * rate / block))))
        self.chunks, self.recording, self.tail = [], False, 0
        self.post, self.post_s, self.done = max(1, int(post_s * rate)), post_s, done
        self.timer = timer if timer is not None else (lambda s, f: threading.Timer(s, f).start())
        self.lock = threading.Lock()

    def audio(self, block):
        clip = None
        with self.lock:
            if not self.recording:
                self.ring.append(block)
                return
            self.chunks.append(block)
            if self.tail > 0:
                self.tail -= len(block)
                if self.tail <= 0:
                    clip = self._take()
        if clip is not None:
            self.done(clip)

    def start(self):
        clip = None
        with self.lock:
            if self.recording and self.tail > 0:   # the last clip was still taking its tail: it ends now
                clip = self._take()
            self.chunks, self.recording, self.tail = list(self.ring), True, 0
            self.ring.clear()
        if clip is not None:
            self.done(clip)

    def stop(self, keep=True):
        """keep: the clip ends after the tail; not keep (a cancel): it is thrown away"""
        with self.lock:
            if not self.recording or self.tail > 0:
                return
            if not keep:
                self.recording, self.chunks = False, []
                return
            self.tail = self.post
        # if the microphone stops sending blocks, the clip still ends
        self.timer(self.post_s + 0.5, self.flush)

    def flush(self):
        clip = None
        with self.lock:
            if self.recording and self.tail > 0:
                clip = self._take()
        if clip is not None:
            self.done(clip)

    def _take(self):
        clip = np.concatenate(self.chunks) if self.chunks else np.zeros(0, dtype=np.float32)
        self.chunks, self.recording, self.tail = [], False, 0
        return clip


class PushToTalk:
    """Hold every group of the combo to talk; let go of any to stop. Pure state: events go to `emit`, so it can be
    tested without a keyboard. A key outside the combo while talking (Ctrl+Win+D, Ctrl+C) or a click/scroll cancels."""

    def __init__(self, groups, emit, now, mask=None, min_hold_ms=400):
        self.groups, self.emit, self.now, self.mask, self.min_hold = groups, emit, now, mask, min_hold_ms
        self.held, self.down, self.cancelled, self.t = set(), False, False, 0

    def _group(self, k):
        for i, g in enumerate(self.groups):
            if k in g:
                return i
        return None

    def press(self, k):
        if getattr(k, "vk", None) == MASK_VK:
            return False
        g = self._group(k)
        if g is not None:
            self.held.add(g)
            if not self.down and len(self.held) == len(self.groups):
                self.down, self.cancelled, self.t = True, False, self.now()
                if self.mask:
                    self.mask()
                self.emit("down", t=self.t)
                return True
        elif self.down and not self.cancelled:
            self.cancelled = True
            self.emit("cancel", reason="shortcut")
        return False

    def release(self, k):
        g = self._group(k)
        if g is None:
            return None
        self.held.discard(g)
        if not self.down:
            return None
        self.down = False
        held = self.now() - self.t
        if self.cancelled:
            return None
        if held < self.min_hold:
            self.emit("cancel", reason="tap")
            return None
        self.emit("up", t=self.now(), ms=held)
        return held

    def mouse(self):
        if self.down and not self.cancelled:
            self.cancelled = True
            self.emit("cancel", reason="mouse")


def listen(model, key_name, max_seconds=30):
    import sounddevice as sd
    from pynput import keyboard, mouse

    groups, uses_win = key_groups(key_name)
    jobs = queue.Queue()
    rec = Recorder(lambda clip: jobs.put(clip[: RATE * max_seconds]))
    ctl = keyboard.Controller()

    def mask():
        try:
            ctl.press(keyboard.KeyCode.from_vk(MASK_VK)); ctl.release(keyboard.KeyCode.from_vk(MASK_VK))
        except Exception:
            pass

    ptt = PushToTalk(groups, emit, now_ms, mask if uses_win else None, MIN_HOLD_MS)

    def on_audio(indata, frames, t, status):
        rec.audio(indata[:, 0].copy())

    stream = sd.InputStream(samplerate=RATE, channels=1, dtype="float32", callback=on_audio, blocksize=BLOCK)
    stream.start()

    def on_press(k):
        if ptt.press(k):
            rec.start()

    def on_release(k):
        held = ptt.release(k)
        if held is not None:
            rec.stop(keep=True)
        elif not ptt.down:
            rec.stop(keep=False)   # a tap, a shortcut or a click: no clip

    def worker():
        while True:
            audio = jobs.get()
            if len(audio) < RATE * (0.3 + PRE_ROLL_S):
                emit("error", msg="too short: hold the keys while you speak")
                continue
            if float(np.sqrt(np.mean(audio ** 2))) < 1e-4:
                emit("error", msg="microphone gave silence: check Settings > Privacy > Microphone > desktop apps")
                continue
            try:
                r = transcribe(model, audio)
                if not r["text"].strip():
                    emit("error", msg="didn't catch that: hold the keys and speak a little louder")
                    continue
                if r["text"].strip().lower() in HALLUCINATIONS:
                    r["maybe_noise"] = True
                emit("transcript", **r)
            except Exception as e:   # keep listening after one bad clip
                emit("error", msg=f"transcription failed: {e}")

    # Clicks and scrolls while the keys are held are mouse use, not speech; moving the mouse (pointing) is fine.
    mouse.Listener(on_click=lambda x, y, button, pressed: pressed and ptt.mouse(), on_scroll=lambda *a: ptt.mouse(), daemon=True).start()
    threading.Thread(target=worker, daemon=True).start()
    emit("ready", key=key_name)
    with keyboard.Listener(on_press=on_press, on_release=on_release) as listener:
        listener.join()


def main():
    ap = argparse.ArgumentParser()
    # Measured on an i7-14700HX (CPU, int8, warm, 8.7 s clip): small 2.5 s, large-v3-turbo 10 s.
    # small.en (English only: fewer mishearings than small at the same speed) is the default for English;
    # large-v3-turbo is better at Cantonese but too slow for push-to-talk here.
    ap.add_argument("--model", default="small.en")
    ap.add_argument("--key", default="ctrl_win")
    ap.add_argument("--lang", default="en", help="spoken language code, or 'auto' to detect")
    ap.add_argument("--file")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    global LANG
    LANG = None if a.lang == "auto" else a.lang

    import sounddevice as sd
    try:
        mic = sd.query_devices(kind="input")["name"]
    except Exception as e:
        mic = f"none ({e})"
    if a.check:
        emit("status", microphone=mic, model=a.model, key=a.key)
        return
    emit("status", microphone=mic, model=a.model, key=a.key, loading=True)
    model, load_ms, name = load_model(a.model)
    emit("status", model=name, load_ms=load_ms, beam=BEAM)
    if a.file:
        emit("transcript", **transcribe(model, read_wav(a.file)))
        return
    listen(model, a.key)


if __name__ == "__main__":
    main()
