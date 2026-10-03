"""Windows push-to-talk + on-device speech-to-text. The Windows twin of native/mac/ptt-helper + stt.

Hold the push-to-talk keys (default Ctrl+Win, as in Clicky; --key ctrl_alt, ctrl_shift, ctrl, right_ctrl... also work),
speak, release. Another key while they are held (a shortcut such as Ctrl+Win+D), a click or a scroll cancels the
recording; a tap shorter than MIN_HOLD_MS is ignored. Moving the mouse is fine: that is how you point at what you ask
about. Holding Win normally opens Start when it is let go; an unassigned key is tapped while talking to prevent that. Audio never leaves the laptop:
faster-whisper runs on the CPU. One warm process, so the model loads once.

Prints one JSON object per line on stdout (same event names as the Mac ptt-helper):
  {"event":"status", ...}   {"event":"ready", ...}   {"event":"down","t":...}   {"event":"up","t":...,"ms":...}
  {"event":"transcript","lang":"en"|"yue"|"zh","text":"...","ms":...,"audio_ms":...}   {"event":"error","msg":"..."}

usage:
  python voice.py [--model small] [--key ctrl_win|ctrl_alt|ctrl_shift|ctrl|right_ctrl|...]   # listen
  python voice.py --file clip.wav [--model ...]                  # transcribe one file and exit
  python voice.py --check                                        # list the microphone and exit
"""
import argparse
import json
import os
import queue
import sys
import threading
import time
import wave

import numpy as np

RATE = 16000
MIN_HOLD_MS = 400                      # shorter presses are ordinary key use, not speech
# What whisper says for silence or noise; dropped unless the user really said more.
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
    from faster_whisper import WhisperModel
    t0 = time.time()
    model = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=8)
    return model, round((time.time() - t0) * 1000)


LANG = None   # set from --lang; "en" by default (English dictation)
# Words the assistant hears a lot: a hint for the speech model, so "deafen" isn't "defin" and "Drake" isn't "Dracons".
# VOICE_WORDS in .env adds your own (names of friends, apps, songs), comma separated.
HINT = ("Spotify, Discord, WhatsApp, YouTube, Chrome, Calculator, Notepad, Word, Excel, VS Code, Steam, Epic Games, "
        "Drake, mute, unmute, deafen, undeafen, message")
if os.environ.get("VOICE_WORDS"):
    HINT += " " + os.environ["VOICE_WORDS"].replace(",", ", ").strip()


def transcribe(model, audio):
    """One pass. With --lang (default en) the language is fixed, which is faster and avoids misdetection on short
    clips. With --lang auto: detect, and if the result is not English or Chinese/Cantonese, run again forced to the
    likelier of those."""
    t0 = time.time()
    segs, info = model.transcribe(audio, language=LANG, beam_size=1, vad_filter=False, initial_prompt=HINT,
                                  condition_on_previous_text=False, without_timestamps=True)
    text = "".join(s.text for s in segs).strip()
    if text.strip(" .,").lower() in HINT.lower() and len(text.split()) > 3:
        text = ""   # the hint itself came back (a near-silent clip): nothing was said
    lang = info.language
    if LANG is None and lang not in KEEP_LANGS:
        probs = dict(info.all_language_probs or [])
        lang = max(KEEP_LANGS, key=lambda l: probs.get(l, 0.0))
        segs, _ = model.transcribe(audio, language=lang, beam_size=1, vad_filter=False, initial_prompt=HINT,
                                   condition_on_previous_text=False, without_timestamps=True)
        text = "".join(s.text for s in segs).strip()
    return {"lang": lang, "text": text, "ms": round((time.time() - t0) * 1000),
            "audio_ms": round(len(audio) / RATE * 1000), "lang_p": round(float(info.language_probability), 3)}


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
    chunks, jobs = [], queue.Queue()
    ctl = keyboard.Controller()

    def mask():
        try:
            ctl.press(keyboard.KeyCode.from_vk(MASK_VK)); ctl.release(keyboard.KeyCode.from_vk(MASK_VK))
        except Exception:
            pass

    ptt = PushToTalk(groups, emit, now_ms, mask if uses_win else None, MIN_HOLD_MS)

    def on_audio(indata, frames, t, status):
        if ptt.down:
            chunks.append(indata[:, 0].copy())

    stream = sd.InputStream(samplerate=RATE, channels=1, dtype="float32", callback=on_audio, blocksize=1600)
    stream.start()

    def on_press(k):
        if ptt.press(k):
            chunks.clear()

    def on_release(k):
        if ptt.release(k) is not None:
            audio = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
            jobs.put(audio[: RATE * max_seconds])

    def worker():
        while True:
            audio = jobs.get()
            if len(audio) < RATE * 0.3:
                emit("error", msg="too short: hold the keys while you speak")
                continue
            if float(np.sqrt(np.mean(audio ** 2))) < 1e-4:
                emit("error", msg="microphone gave silence: check Settings > Privacy > Microphone > desktop apps")
                continue
            try:
                r = transcribe(model, audio)
                if r["text"].strip().lower() in HALLUCINATIONS or not r["text"].strip():
                    emit("error", msg="didn't catch that: hold the keys and speak a little louder")
                    continue
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
    # small is the default; large-v3-turbo is better at Cantonese but too slow for push-to-talk here.
    ap.add_argument("--model", default="small")
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
    model, load_ms = load_model(a.model)
    emit("status", model=a.model, load_ms=load_ms)
    if a.file:
        emit("transcript", **transcribe(model, read_wav(a.file)))
        return
    listen(model, a.key)


if __name__ == "__main__":
    main()
