# SignStream

SignStream is an accessibility-first product for **deaf and hard-of-hearing people** who watch online video and still face a gap between raw captions and natural sign communication.

At a high level, SignStream turns a video's audio stream into:

- **live captions** for immediate text comprehension
- **sign-oriented visual output** so meaning is not delivered through text alone

## Pitch: the bigger goal

The long-term goal is to make everyday web video more inclusive by giving deaf users a real-time interpretation layer directly in the player experience, instead of forcing them to switch tools, download transcripts, or rely on delayed/limited accessibility support.

SignStream is designed to sit where users already are (YouTube today, more domains over time), then add a responsive overlay that can evolve from "captions + tokenized sign cues" into richer, more natural sign expression.

## Why this matters

- Captions are necessary but often not enough for many deaf viewers.
- Accessibility quality is inconsistent across platforms and creators.
- A browser-native layer can close this gap without requiring video publishers to change their workflow.
- A local-first pipeline can reduce dependency on paid cloud APIs and preserve user control.

## Product vision (MVP to future)

### What the MVP proves

- Real-time capture from the active tab.
- Real-time transcript generation using local STT.
- Real-time sign-oriented rendering in-page.
- User-controlled display modes (captions-only, sign-only, combined).

### Where this can go

- Better linguistic transformations toward stronger sign-language fidelity.
- Larger, higher-quality gesture/sign asset coverage.
- Lower-latency, higher-accuracy speech recognition options.
- Support for more sites and playback contexts.

## Technical approach

The architecture intentionally separates concerns:

- a **browser extension** for capture, controls, and in-page rendering
- a **local websocket engine** for speech-to-text and text-to-sign-token mapping

This split lets the project evolve quickly:

- improve translation logic without rewriting extension UX
- improve UX/overlay behavior without touching core language logic
- iterate on UI quickly with `mock_engine.py` before STT tuning

## Current scope and limitations

- This is an **MVP/prototype**, not a production-grade ASL translator.
- Current sign output is heuristic/token-based ("ASL-ish"), not full grammatical ASL interpretation.
- Gesture quality depends on available assets; unknown words can fall back to fingerspelling/text chips.
- Default integration is currently optimized for YouTube, with optional domain permissions for others.

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
