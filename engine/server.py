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


def load_glossary(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"version": 1, "phrases": {}, "words": {}}


def simplify_and_tokenize(text: str) -> list[str]:
    words = [w.strip(" .,!?\"'()[]{}:;-").lower() for w in text.split()]
    words = [w for w in words if w and w not in FILLER_WORDS]
    return words


def map_to_tokens(words: list[str], glossary: dict[str, Any]) -> list[str]:
    # MVP mapping:
    # - phrase handling can be added later; for now do word-level mapping.
    mapping = glossary.get("words", {}) if isinstance(glossary, dict) else {}
    tokens: list[str] = []
    for w in words:
        t = mapping.get(w)
        tokens.append(t if t else w.upper())
    return tokens


@dataclass
class SessionState:
    t0: float | None = None
    last_emit_ms: int = 0


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

        words = simplify_and_tokenize(text)
        tokens = map_to_tokens(words, glossary)

        payload = {
            "type": "sign.tokens",
            "start_ms": max(0, t_ms - 500),
            "end_ms": t_ms + 500,
            "tokens": tokens,
            "conf": 0.6 if is_final else 0.4,
        }
        await ws.send(json.dumps(payload))

        # Also emit transcript as a status line for debugging.
        await ws.send(json.dumps({"type": "transcript.segment", "text": text, "final": is_final}))


async def main():
    async with websockets.serve(handler, "127.0.0.1", 8765, max_size=8 * 1024 * 1024):
        print("SignStream engine listening on ws://127.0.0.1:8765")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
