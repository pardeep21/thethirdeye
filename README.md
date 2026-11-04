# TheThirdEye

Hands-free proactive assistant for a blind shopkeeper: a chest-camera phone
that reads cash, describes the counter, finds things, and recognises
consented people — speaking short, calm Punjabi. Silence is a feature:
a stationary scene means silence, and the app says "pakka nahi" when unsure.

> **Honesty statement (shown in-app on first launch).**
> TheThirdEye is an assistive aid, not a medical or safety device. It reads
> currency denominations and describes surroundings using AI, and it can be
> wrong. It does not detect counterfeit or damaged notes. Important amounts
> should be confirmed by another person. Face recognition works only for
> people who have agreed to be enrolled. TheThirdEye supports the user's own
> judgment and mobility aids; it does not replace them.

## Screens

| Home (idle) | Listening | Look-around |
|---|---|---|
| ![Home idle](apps/mobile/assets/screens/home-idle.png) | ![Listening](apps/mobile/assets/screens/home-listening.png) | ![Look-around](apps/mobile/assets/screens/home-lookaround.png) |

| People | Settings |
|---|---|
| ![People](apps/mobile/assets/screens/people.png) | ![Settings](apps/mobile/assets/screens/settings.png) |

## How it works

```mermaid
flowchart LR
  subgraph PHONE["Phone (Expo app)"]
    CAM[Camera ~2 fps<br/>UW in look-around] --> GATE{Changed?<br/>or heartbeat}
    GATE -- yes --> ENC[768px JPEG]
    BTN[Volume key / Talk tile] --> MIC[On-device STT<br/>or server audio]
    TTS[Android TTS pa/hi/en] --> BUDS[Earbuds]
  end
  ENC -- WS frame --> IN
  MIC -- WS utterance --> INTENT
  subgraph SERVER["Node server (laptop now, cloud for judges)"]
    IN[Frame in] --> TRI[Muse Spark triage<br/>JSON: notes, people]
    IN --> SCN[Muse Spark scene<br/>look-around only]
    IN --> FACE[Face tracker<br/>sidecar ArcFace / stub]
    INTENT[Intent fast path<br/>mute · cancel · howmuch · more] --> DEC
    INTENT -- agent path --> AGT[Muse Spark agent<br/>memory + scene + actions]
    AGT -- capture_now --> IN
    AGT --> FIND[Spark locate<br/>find X]
    TRI --> DEC[Decision engine<br/>stability · dedupe · priority]
    SCN --> NAR[Scene narrator<br/>summary, then only new]
    NAR --> DEC
    FACE --> DEC
    FIND --> DEC
    DEC <--> MEM[(Session + enrolled faces)]
    DEC --> PH[Phrase builder<br/>templates + clock render]
  end
  PH -- WS speak text, lang, priority --> TTS
```

One WebSocket carries frames, audio and commands up; `speak` messages come
down with text, language, priority (P1 answers beat P3 scene chatter) and a
kind for the caption icons. Later, glasses replace only the capture and
audio parts (camera, gate, mic, TTS/earpiece); the server side stays as is.

## Models (exact)

| Job | Model | Notes |
|---|---|---|
| Cash/people/scene triage, conversation, find | `muse-spark-1.3` (Meta Model API) | Reasoning model: `reasoning_effort: "minimal"`, JSON mode with prompt-only fallback |
| Face detection + embedding | YuNet + ArcFace via `deepface==0.0.103` | Local Python sidecar (`apps/faces`), ArcFace 512-d, threshold 0.45 + 0.08 margin |
| Speech recognition | Android STT | `expo-speech-recognition`, `pa-IN` with `hi-IN`/`en-IN` fallback (the S23 test phone has no `pa-IN`); server-audio mode is a fallback, not Meta STT |
| Speech output | Android TTS (`expo-speech`) | `pa-IN` / `hi-IN` / `en-IN`; Meta has no TTS model, so this is the honest choice |

"Find X" is Spark's locate call, not SAM 3.1 (stretch goal, skipped).

## Quickstart

Prereqs: Node 20+, Python 3.12 + `uv`, Android Studio (SDK + a JDK).

```bash
git clone <repo> && cd thethirdeye
npm install

# 1. Server (mock vision, no key needed)
cd apps/server && cp .env.example .env
npm start            # ws://<laptop>:8080, PROVIDER=mock

# 2. Face sidecar (real recognition; optional — server falls back to stub)
cd ../faces
./run.sh             # Windows: ./run.ps1  ->  http://127.0.0.1:8765

# 3. Phone (Expo dev build, Samsung S23 Ultra over wifi ADB)
cd ../mobile
npx expo run:android # or: cd android && ./gradlew assembleDebug
```

Point the app at the laptop: the default URL is the Windows hotspot
gateway (`ws://192.168.137.1:8080`); change it in Settings without
rebuilding. The first launch shows the honesty statement (English +
Punjabi) and speaks a summary before the camera starts.

Tests: `npm test` at root (node:test suites, never touch the network),
`npm run typecheck`. Live vision eval (needs `META_API_KEY`):
`cd apps/eval && npm run spike -- notes --provider meta`.

## Provider setup

Copy `apps/server/.env.example` to `apps/server/.env`:

| Variable | Meaning |
|---|---|
| `PROVIDER` | `mock` (default) \| `meta` \| `openrouter` \| `openai` \| `local` |
| `META_API_KEY` / `META_BASE_URL` / `META_MODEL` | Meta Model API (`muse-spark-1.3`) |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | OpenRouter-served Muse |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | Plain OpenAI or local Ollama (`PROVIDER=local` defaults to `muse-glimmer`) |
| `AGENT_MODEL` / `AGENT_MAX_TOKENS` / `AGENT_IMAGE_PX` / `AGENT_TOOL_MODE` / `AGENT_REASONING_EFFORT` / `AGENT_DEBUG_DIR` | Conversational agent tuning |
| `TRIAGE_MAX_TOKENS` / `SCENE_MAX_TOKENS` / `META_REASONING_EFFORT` / `FIND_MAX_TOKENS` / `CAPTURE_TIMEOUT_MS` / `TRIAGE_IMAGE_PX` | Perception tuning |
| `APP_TOKEN` | Shared WS token (phone sends it in `hello`; unset = open server for local dev only) |
| `FACES` / `FACES_EVERY_N` | `sidecar` (auto if `:8765` answers) or `stub`; detection cadence |
| `UW_CASH_CROP` | Centre-60% crop for the cash prompt on ultra-wide frames (`0` disables) |
| `DEBUG_LOG_IMAGES` | Keep image prefixes in eval debug files (`false` default: sizes only) |
| `PORT` / `THETHIRDEYE_DB` | HTTP/WS port (default 8080), SQLite path for face embeddings |

`PROVIDER=mock` runs the whole loop with scripted vision: every demo in
this README works with no key.

## Judges' deploy

- **Server:** `render.yaml` at the repo root is a Render Blueprint: it
  builds `apps/server/Dockerfile` (Node 20 slim, `FACES=stub`), health-checks
  `/health`, and generates `APP_TOKEN`. Set `PROVIDER=meta` + `META_API_KEY`
  in the dashboard for live vision. `/data` is ephemeral on the free tier —
  enrolled faces reset on redeploy unless a disk is attached there.
- **APK:** bake the judges' endpoint + token at build time, then build the
  signed release (see `apps/mobile/android/app/build.gradle` for the signing
  props in `~/.gradle/gradle.properties`; the keystore itself is never
  committed):
  ```bash
  cd apps/mobile
  EXPO_PUBLIC_SERVER_URL=wss://<service>.onrender.com \
  EXPO_PUBLIC_APP_TOKEN=<render-app-token> \
    npx expo run:android --variant release
  ```
  Native libs ship 16 KB-page aligned (Expo SDK 58 / AGP 8.x), as Android 15+
  requires.

## Privacy

- Frames are processed and discarded: not stored by TheThirdEye — no frame
  or face crop is ever written to disk — but every gated frame is sent to
  Meta's standard (non-training) tier for vision. Debug logs carry sizes,
  never image bytes (`DEBUG_LOG_IMAGES` exists for local diagnosis and
  defaults off).
- The SQLite store keeps face *embeddings* (number vectors), never photos.
- Strangers are never named or persisted. Enrolling a face requires a
  recorded "haan" — voice consent is stored with the enrollment, and
  anyone can be forgotten by voice ("Ravi nu bhul ja").
- On a network, `APP_TOKEN` closes unauthenticated sockets (4401); the API
  key lives on the server, never on the phone.

## Limitations (honest)

- Cash eval (live, contributor tier): 59/60 correct (98.3%) on 30 clear
  photos (5 per denomination), zero wrong values — the one miss said
  "unsure". Triage p50 2.9 s / p95 4.9 s, so the 3.5 s p50 answer budget
  is still tight end to end. Hard-set (folded/angled/dim) photos pending.
- Spark reasoning latency is seconds per call (2.7–8.6 s on the first live
  probes); the 3.5 s p50 answer budget needs live `/stats` confirmation
  (proactive triage p50/p95 is now in `/stats` as `triageMs`).
- Cloud face recognition is off (`FACES=stub` in Docker/Render): "who's
  here" by name needs the laptop sidecar beside the server.
- Punjabi-first with Hindi/English fallback, but the S23 test phone has no
  `pa-IN` recognition (falls back to `hi-IN`/`en-IN`); the TTS voice choice
  is still awaiting the user's ear test; enrolment quality gates assume a
  cooperative, front-facing subject.
