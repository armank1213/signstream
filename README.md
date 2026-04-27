# SignStream (MVP)

Chrome extension + local engine that turns YouTube tab audio into **captions + ASL-ish sign tokens** (rule-based gloss + glossary mapping + optional fingerspelling fallback).

## Run the local engine (real STT)

This MVP uses **Vosk** (offline, CPU-friendly) to transcribe the tab audio.

1) Install deps:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r engine/requirements.txt
```

2) Download a Vosk English model and point `SIGNSTREAM_VOSK_MODEL` at it.

Example layout:
- `engine/models/vosk/` (unzipped model folder)

3) Start the engine:

```bash
SIGNSTREAM_VOSK_MODEL=engine/models/vosk python engine/server.py
```

If you don’t have a model yet, the extension will connect but you’ll see a status message saying the model is missing.

## Run the mock engine (placeholder tokens)

```bash
python engine/mock_engine.py
```

## Load the extension

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder
4. Open a YouTube video (`https://www.youtube.com/watch?...`)
5. Click the SignStream extension icon → **Start**

You should see an overlay (default: right side) that updates with live transcript + sign tokens.

Tip: In the popup, set **Sign rendering → Gesture clips** to render hand-gesture clips per token.

### Gesture assets (MVP)

The extension looks for gesture clips at:

- `extension/assets/signs/<token>.webm`

Example: token `HELP` → `extension/assets/signs/help.webm`

If a clip is missing, it falls back to text chips.

### 3D Avatar (VRM) (experimental)

If you choose **Sign rendering → 3D avatar (VRM)**, the extension will load:

- `extension/assets/avatar/model.vrm`

This repo does not ship a VRM model by default (licensing varies). Add your own VRM file at that path.

Current MVP behavior: the avatar performs simple procedural gestures for a few tokens (HELLO/YES/NO/THANK/etc). For real ASL signing you’ll eventually need a curated animation library per token.

Note: I can’t generate or bundle copyrighted sign-language datasets for you. Use self-made or properly-licensed assets.
