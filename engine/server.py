from __future__ import annotations

import asyncio
import base64
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import websockets


FILLER_WORDS = {
    "a",
    "an",
    "the",
    "um",
    "uh",
    "like",
}

EXTRA_STOP_WORDS = {
    "is",
    "am",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "to",
    "of",
    "and",
    "or",
    "but",
}

# Lightweight, rule-based "ASL-like gloss" transforms.
# This is not true ASL translation, but it improves accessibility vs raw English:
# - Time/topic words moved forward
# - Yes/No and WH-question handling
# - Basic negation normalization

AUX_WORDS = {
    "can",
    "could",
    "do",
    "does",
    "did",
    "will",
    "would",
    "should",
    "is",
    "are",
    "am",
    "was",
    "were",
    "have",
    "has",
    "had",
}

WH_WORDS = {"who", "what", "where", "when", "why", "how"}

TIME_WORDS = {
    "today",
    "tomorrow",
    "yesterday",
    "now",
    "tonight",
    "later",
    "soon",
}

NEGATION_WORDS = {
    "not",
    "no",
    "never",
    "dont",
    "don't",
    "cant",
    "can't",
    "cannot",
    "wont",
    "won't",
}

SPECIAL_WORD_TOKENS = {
    "i": "ME",
    "me": "ME",
    "my": "MY",
    "mine": "MY",
    "you": "YOU",
    "your": "YOUR",
    "we": "WE",
    "our": "OUR",
    "they": "THEY",
    "their": "THEIR",
    "he": "HE",
    "she": "SHE",
    "it": "IT",
    "not": "NOT",
}


def load_glossary(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"version": 1, "phrases": {}, "words": {}}


def simplify_and_tokenize(text: str, level: int) -> list[str]:
    words = [w.strip(" .,!?\"'()[]{}:;-").lower() for w in text.split()]
    words = [w for w in words if w]

    if level >= 1:
        words = [w for w in words if w not in FILLER_WORDS]
    if level >= 2:
        words = [w for w in words if w not in EXTRA_STOP_WORDS]

    return words


def preprocess_words_for_gloss(words: list[str]) -> tuple[list[str], dict[str, Any], str | None]:
    """Prepare words for mapping + collect metadata.

    Important: we avoid re-ordering here so phrase-first matching (e.g. "right now") still works.
    """

    meta: dict[str, Any] = {}
    if not words:
        return words, meta, None

    # Detect question patterns (Vosk doesn't reliably provide punctuation).
    question: str | None = None
    wh: str | None = None

    # WH-question: move WH-word to the end (post-tokenization).
    if words and words[0] in WH_WORDS:
        wh = words[0]
        words = words[1:]
        question = "wh"

    # Yes/no-question: strip leading auxiliary.
    if not question and words and words[0] in AUX_WORDS:
        words = words[1:]
        question = "yn"

    # Normalize negation without disturbing order (for phrase matching).
    out: list[str] = []
    seen_not = False
    for w in words:
        if w in NEGATION_WORDS:
            if not seen_not:
                out.append("not")
                seen_not = True
            continue
        out.append(w)

    if question:
        meta["question"] = question

    return out, meta, wh


def reorder_time_tokens(tokens: list[str]) -> list[str]:
    time_tokens = {w.upper() for w in TIME_WORDS}
    front = [t for t in tokens if t in time_tokens]
    rest = [t for t in tokens if t not in time_tokens]
    return front + rest


def word_to_token(word: str, glossary: dict[str, Any]) -> str:
    if word in SPECIAL_WORD_TOKENS:
        return SPECIAL_WORD_TOKENS[word]
    try:
        t = (glossary.get("words", {}) or {}).get(word)
    except Exception:
        t = None
    return str(t) if t else word.upper()


def _letters_only_upper(s: str) -> str:
    return "".join([c for c in s.upper() if "A" <= c <= "Z"])


def map_to_tokens(
    words: list[str],
    glossary: dict[str, Any],
    *,
    fingerspell_unknown: bool,
) -> tuple[list[str], dict[str, Any]]:
    if not isinstance(glossary, dict):
        glossary = {"phrases": {}, "words": {}}

    phrase_map = glossary.get("phrases", {}) or {}
    word_map = glossary.get("words", {}) or {}

    # Normalize phrase keys once.
    phrases = {str(k).lower().strip(): v for (k, v) in phrase_map.items()}
    max_phrase_len = 1
    for p in phrases.keys():
        max_phrase_len = max(max_phrase_len, len(p.split()))

    tokens: list[str] = []
    unknown_words = 0

    i = 0
    while i < len(words):
        matched = False

        # Longest phrase first
        for n in range(min(max_phrase_len, len(words) - i), 1, -1):
            phrase = " ".join(words[i : i + n])
            if phrase in phrases:
                val = phrases[phrase]
                if isinstance(val, list):
                    tokens.extend([str(x) for x in val])
                else:
                    tokens.append(str(val))
                i += n
                matched = True
                break

        if matched:
            continue

        w = words[i]

        # Some words should always map predictably for readability.
        if w in SPECIAL_WORD_TOKENS:
            tokens.append(SPECIAL_WORD_TOKENS[w])
            i += 1
            continue

        t = word_map.get(w)
        if t:
            tokens.append(str(t))
            i += 1
            continue

        unknown_words += 1
        if fingerspell_unknown:
            letters = _letters_only_upper(w)
            tokens.append(f"FS:{letters}" if letters else w.upper())
        else:
            tokens.append(w.upper())

        i += 1

    return tokens, {"unknown_words": unknown_words, "total_words": len(words)}


@dataclass
class SessionState:
    t0: float | None = None
    last_emit_ms: int = 0
    simplification_level: int = 1
    fingerspell_unknown: bool = True


def now_ms(state: SessionState) -> int:
    if state.t0 is None:
        return 0
    return int((time.monotonic() - state.t0) * 1000)


def load_vosk(model_dir: Path):
    # Import lazily so the engine can still run (in mock mode) without vosk installed.
    from vosk import Model  # type: ignore

    return Model(str(model_dir))


async def handler(ws):
    glossary = load_glossary(Path(__file__).resolve().parents[1] / "data" / "signGlossary.json")

    state = SessionState()
    recognizer = None
    vosk_model = None

    async def send_status(text: str):
        await ws.send(json.dumps({"type": "status", "status": text}))

    async for raw in ws:
        try:
            msg = json.loads(raw)
        except Exception:
            continue

        mtype = msg.get("type")

        if mtype == "session.start":
            state.t0 = time.monotonic()
            state.last_emit_ms = 0
            try:
                state.simplification_level = int(msg.get("simplification_level", 1))
            except Exception:
                state.simplification_level = 1
            state.simplification_level = max(0, min(2, state.simplification_level))

            try:
                state.fingerspell_unknown = bool(msg.get("fingerspell_unknown", True))
            except Exception:
                state.fingerspell_unknown = True

            repo_root = Path(__file__).resolve().parents[1]
            model_dir = Path(os.environ.get("SIGNSTREAM_VOSK_MODEL", "engine/models/vosk"))
            if not model_dir.is_absolute():
                model_dir = repo_root / model_dir

            if model_dir.exists():
                try:
                    vosk_model = load_vosk(model_dir)
                    from vosk import KaldiRecognizer  # type: ignore

                    recognizer = KaldiRecognizer(vosk_model, 16000)
                    recognizer.SetWords(True)
                    await send_status("STT ready (Vosk)")
                except Exception as e:
                    recognizer = None
                    await send_status(f"STT init failed: {e}")
            else:
                recognizer = None
                await send_status(
                    "STT model not found. Download a Vosk model and set SIGNSTREAM_VOSK_MODEL."
                )
            continue

        if mtype != "audio.frame":
            continue

        b64 = msg.get("pcm16_b64")
        if not b64:
            continue

        try:
            pcm_bytes = base64.b64decode(b64)
        except Exception:
            continue

        if recognizer is None:
            # No STT: do nothing besides keeping the connection alive.
            continue

        try:
            is_final = bool(recognizer.AcceptWaveform(pcm_bytes))
            if is_final:
                out = json.loads(recognizer.Result())
                text = (out.get("text") or "").strip()
            else:
                out = json.loads(recognizer.PartialResult())
                text = (out.get("partial") or "").strip()
        except Exception:
            continue

        if not text:
            continue

        # Throttle UI updates a bit (keeps overlay stable).
        t_ms = now_ms(state)
        if t_ms - state.last_emit_ms < 800 and not is_final:
            continue
        state.last_emit_ms = t_ms

        words = simplify_and_tokenize(text, state.simplification_level)

        meta: dict[str, Any] = {}
        wh_word: str | None = None
        if state.simplification_level > 0:
            words, meta, wh_word = preprocess_words_for_gloss(words)

        tokens, map_meta = map_to_tokens(words, glossary, fingerspell_unknown=state.fingerspell_unknown)
        tokens = reorder_time_tokens(tokens)
        if wh_word:
            tokens.append(word_to_token(wh_word, glossary))

        meta = {**meta, **map_meta}

        base_conf = 0.75 if is_final else 0.55
        unknown_ratio = (meta.get("unknown_words", 0) or 0) / max(1, int(meta.get("total_words", 1) or 1))
        conf = max(0.0, min(1.0, base_conf * (1.0 - min(0.8, unknown_ratio * 0.8))))

        payload = {
            "type": "sign.tokens",
            "start_ms": max(0, t_ms - 500),
            "end_ms": t_ms + 500,
            "tokens": tokens,
            "conf": conf,
            "meta": meta,
        }
        await ws.send(json.dumps(payload))

        # Also emit transcript as a status line for debugging.
        await ws.send(json.dumps({"type": "transcript.segment", "text": text, "final": is_final}))


async def main():
    async with websockets.serve(handler, "127.0.0.1", 4000, max_size=8 * 1024 * 1024):
        print("SignStream engine listening on ws://127.0.0.1:4000")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
