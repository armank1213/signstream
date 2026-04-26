import asyncio
import base64
import contextlib
import json
import time
from dataclasses import dataclass

import websockets


@dataclass
class SessionState:
    epoch_ms: int | None = None
    t0: float | None = None


MOCK_SEQUENCES = [
    ["TODAY", "LEARN", "GRAVITY"],
    ["YOU", "GO", "STORE", "NOW"],
    ["HELLO", "MY", "NAME"],
    ["WHAT", "HAPPEN"],
    ["THANK", "YOU"],
]


async def token_pump(ws, state: SessionState):
    i = 0
    while True:
        await asyncio.sleep(1.0)
        if state.t0 is None:
            continue

        now_ms = int((time.monotonic() - state.t0) * 1000)
        tokens = MOCK_SEQUENCES[i % len(MOCK_SEQUENCES)]
        i += 1
        msg = {
            "type": "sign.tokens",
            "start_ms": max(0, now_ms - 500),
            "end_ms": now_ms + 500,
            "tokens": tokens,
            "conf": 0.9,
        }
        await ws.send(json.dumps(msg))


async def handler(ws):
    state = SessionState()
    pump_task = asyncio.create_task(token_pump(ws, state))

    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except Exception:
                continue

            mtype = msg.get("type")

            if mtype == "session.start":
                state.epoch_ms = msg.get("epoch_ms")
                state.t0 = time.monotonic()
                await ws.send(json.dumps({"type": "status", "status": "session started"}))
                continue

            if mtype == "audio.frame":
                # MVP: we accept frames but do not transcribe yet.
                # Decode to prove protocol correctness (and catch bad payloads).
                b64 = msg.get("pcm16_b64")
                if b64:
                    try:
                        base64.b64decode(b64)
                    except Exception:
                        pass
                continue

    finally:
        pump_task.cancel()
        with contextlib.suppress(Exception):
            await pump_task


async def main():
    async with websockets.serve(handler, "127.0.0.1", 8765, max_size=8 * 1024 * 1024):
        print("SignStream mock engine listening on ws://127.0.0.1:8765")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())
