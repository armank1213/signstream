# SignStream (MVP)

SignStream is a **Chrome extension + local websocket “engine”** that turns a tab’s audio into:

- **captions** (live transcript)
- **sign rendering** (currently a lightweight “ASL-ish” MVP: rule-based gloss + glossary mapping + optional fingerspelling-style fallback)

## Repo layout

- **`extension/`**: Chrome MV3 extension
  - `background.js`: starts/stops capture and coordinates offscreen + content script
  - `offscreen/offscreen.js`: captures tab audio (WebAudio) and streams PCM frames to the engine over websockets
  - `contentScript.js`: renders the on-page overlay (captions + sign UI)
- **`engine/`**: local websocket server that accepts audio frames and emits transcript/sign messages
  - `server.py`: “real” engine using **Vosk** (offline STT)
  - `mock_engine.py`: mock engine for UI/dev without STT
- **`data/signGlossary.json`**: word→token mapping used by the engine

## How it works (high level)

1. Extension captures **tab audio** via an offscreen document.
2. Offscreen streams audio frames to the local engine (`ws://127.0.0.1:4000` by default).
3. Engine returns transcript + sign token info.
4. Content script displays an overlay on the page.

## Behavior notes

- **Video pause → interpreter pause**: when the page’s `<video>` pauses, SignStream pauses the **gesture interpreter loop** (the timed playback that advances through queued words) so sign rendering doesn’t keep advancing while the video is frozen. When the video resumes, the interpreter resumes too.

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

You should see an overlay (default: right side) that updates with the live transcript and sign UI.

## Gesture assets (MVP)

If you use gesture rendering, the extension looks for assets under `extension/assets/signs/test/`.

If an asset is missing, it falls back to text chips.

Note: bundle only self-made or properly-licensed sign-language assets.
