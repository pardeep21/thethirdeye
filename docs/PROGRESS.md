# TheThirdEye build progress (overnight agent log)

## M0 - Monorepo skeleton (done)

- Moved `thethirdeye-spike` CLI into `apps/eval` unchanged (renamed package to
  `@thethirdeye/eval`); `data/` and its README moved with it.
- New `apps/server` (Node 20+, `ws`, plain `node:http`): `GET /health`,
  `GET /frame/latest`, WS `frame` -> MockVision triage -> `speak`.
  Mock returns a fixed 500 note so the full path speaks without any key.
- New `apps/mobile` (Expo SDK 58, vision-camera v5 outputs API): hidden back
  camera, frame output -> 32x32 grayscale gate (send if changed or 5 s
  heartbeat), 768px JPEG q70 upload over WS, `expo-speech` queue with P1
  interrupt, one-time "network nahi" on disconnect.
- Naming: `config/app-name.ts` (display name, scope, app id) + test enforcing
  `apps/mobile/app.json` and workspace names match.
- How to run: `npm install`, `npm run typecheck`, `npm test`;
  server: `cd apps/server && cp .env.example .env && npm run build && npm start`
  (`PROVIDER=mock`). Mobile is typecheck-only (no device here).
- Tests: 13 pass (config 2, mobile gate 6, server 5 incl. WS integration).
- Stubs: server speaks on every confident frame (no stability/dedupe -
  replaced by M2 decision engine); audio/command messages ignored until M4/M2.
- Notes: vision-camera v5 has no `useFrameProcessor`; gate uses
  `useFrameOutput` + resize-plugin `useResizePlugin().resize` + worklets
  `runOnJS`. `react-native-nitro-modules` added direct (v5 runtime base).
  Cosmetic `MODULE_TYPELESS_PACKAGE_JSON` warning on the mobile gate test is
  expected (package must stay CJS-typed for Metro/babel configs).
- Next steps for you: join the phone to the laptop hotspot and set
  `DEFAULT_SERVER_URL` if it differs; `npx expo run:android` needs your
  Android SDK + S23.

## M1 - Adapters + provider eval (done)

- `apps/server/src/adapters/`: exact MVP.md section 2 interfaces
  (`VisionTriage`, `VisionAnswer`, `ObjectFinder`, `SpeechToText`,
  `FaceMatcher`), scriptable mocks for all five, `OpenAICompat` triage +
  answer (baseURL/model/key from env; covers Meta Model API, OpenRouter,
  plain OpenAI, local Ollama), strict `parseTriageResult`, triage system
  prompt forcing TriageResult JSON, provider factory
  (`mock|meta|openrouter|openai|local`). Compile-only: no test calls network.
- `apps/eval` notes test now runs any provider (`--provider`, default
  `PROVIDER` env else `mock`) over `data/notes/<label>_*.jpg` (leading
  digits: `10_1.jpg` and `500_new_front_03.jpg` both work) -> `results.md`.
  Scenes/audio keep the direct Meta client (key needed only for those).
- How to run: `cd apps/eval && npm run spike -- notes --provider mock`
  (free); `--provider meta` needs `META_API_KEY`.
- Tests: 19 pass (config 2, mobile gate 6, server 11 incl. 6 adapter tests).
- Stubs: finder/STT/faces are mock-only (real SAM/STT in M4 wiring, faces
  in M5); cost estimates for non-meta providers are omitted (rates unknown).
- Notes: npm here predates the `workspace:` protocol, so eval depends on
  `@thethirdeye/server` via semver `^0.1.0` (still linked locally); eval
  prebuild/pretypecheck build the server first for its `.d.ts`.
- Next steps for you: collect the clear/hard note sets (MVP.md section 6),
  then `notes --provider meta --limit 5` for eval run #1.

## M2 - Decision engine (done)

- `apps/server/src/decision.ts`: events per MVP.md section 4 (`NOTE_SEEN`
  incl. combined multi-note, `NOTE_UNSURE`, `KNOWN_ARRIVED`,
  `PERSON_ARRIVED`, `COMMAND_ANSWER`), stability rules (2 consecutive or
  conf >= 0.85; 2-of-3 faces; count-up-2-frames), dedupe windows (note
  re-arm after >3 s absence, unsure 8 s, known 10 min/person, unknown
  2 min + 30 s cap), P1/P2/P3 queue (P1 never stale, P2 drops >5 s, P3
  max 1 drops >3 s or when P1 pending), mute mode, `cancel()`.
  Renderer is injected (`minimalRenderer` English until M3).
- Server rewired: frame -> triage + faces in parallel -> engine ->
  all due speaks; mute/unmute/cancel commands wired; perception errors
  stay silent.
- How to run: `npm test -w @thethirdeye/server`.
- Tests: 43 pass total (config 2, mobile gate 6, server 35 incl. 24 new
  engine tests from fake-TriageResult sequences with explicit timestamps).
- Stubs/limits: mute/unmute speak no confirmation (spec is silent on it);
  dedupe windows start at event-fire time, so a P2/P3 dropped as stale
  still consumes its silence window (known wart); P1 queue capped at 10
  (oldest dropped) as overflow defense; face threshold 0.75 is a guess
  until M5 measures it.
- Next steps for you: none for M2; phrases land in M3.

## M3 - Phrase builder (done)

- `apps/server/src/phrases.ts`: `renderProactive` (plugged into the engine;
  server now speaks "ਪੰਜ ਸੌ ਦਾ ਨੋਟ"), `summarizePeople` for "kaun hai?"
  (used by M4), `renderFind` for SAM results. Cash in Gurmukhi, people
  lines in Roman code-mix, exactly as MVP.md section 1 specifies, plus en
  (manifest-style) and hi (Devanagari) variants. Default lang pa until the
  M6 settings screen.
- How to run: `npm test -w @thethirdeye/server`.
- Tests: 55 pass total (config 2, mobile gate 6, server 47 incl. 12 new
  phrase tests asserting every MVP.md line verbatim).
- Notes/limits: position words for left/right+far ("left side door") and
  find-centre ("saamne") are my interpretations - MVP.md only pins
  "counter te"/"door kol"/"left side" and "right side, neeche"; unknown
  gender defaults to banda/man/aadmi; known-arrival uses masculine
  "ਆ ਗਿਆ" (no gender field in enrollment); script choice (Gurmukhi vs
  Roman for people lines) follows the spec but awaits your TTS voice test.
- Next steps for you: the 30 Oct night TTS voice test (pa-IN vs hi-IN)
  decides whether these templates need rescripting.

## M4 - Intent router + command wiring (done)

- `apps/server/src/intent.ts`: keyword router for describe/read/find/who/
  howmuch/mute/unmute over pa/hi/en text (Roman, Gurmukhi, Devanagari).
  Token-exact matching; mute/unmute only on <=3-word utterances so "eh bol
  ki hai" stays a describe; empty-noun find falls back to describe; unknown
  stays silent (logged).
- Server audio path: STT -> route -> describe/read via Spark answer, find
  via finder + `renderFind`, who via `summarizePeople` over last
  perception, howmuch via fresh triage read, mute/unmute to the engine.
  Commands `cancel()` P2/P3 first; answers speak as P1 behind queued cash.
- `MOCK_STT_TEXT` env overrides the mock transcript (used by tests).
- How to run: `npm test -w @thethirdeye/server`.
- Tests: 66 pass total (config 2, mobile gate 6, server 58 incl. 8 new
  router tests + 3 new audio-integration tests).
- Notes/limits: "kimat/daam" (price) and "keda" (which) left unknown on
  purpose (ambiguous); who-maps faces to people positions positionally
  (approximation); TTS lang tag is "pa" until M6 settings; command-P1 vs
  in-flight cash-P1 race: FIFO covers queued cash, and the STT+model
  pipeline outlasts any <=1.5 s cash utterance in practice, so the phone
  never needs to preempt cash for a command.
- Next steps for you: try real phrasings in the field test; the keyword
  lists are the tuning surface.

## M5 - Face enrollment + SQLite store, embedder STUBBED (done with a Blocked item)

- `apps/server/src/faces/`: real `PeopleStore` (better-sqlite3, embeddings
  only, `THETHIRDEYE_DB`), real `StoredFaceMatcher` (cosine, threshold 0.75)
  behind the `FaceMatcher` interface, stub `FaceEmbedder` (finds nothing,
  fail-closed). REST: `POST /people` (requires `consent: true`, 1-10 base64
  photos, per-photo no-face 400s), `GET /people`, `DELETE /people/:id`
  (embeddings deleted immediately). Photos are never written to disk.
- Factory faces are store-backed in every provider (mock included), so
  enrollment works without keys once a real embedder exists.
- How to run: `npm test -w @thethirdeye/server`; server owns `./thethirdeye.db`
  unless tests inject `:memory:`.
- Tests: 74 pass total (config 2, mobile gate 6, server 66 incl. 5 new
  store/matcher tests + 3 new REST tests with a fixed-vector embedder).
- Next steps for you: the embedder seam is `FaceEmbedder` in
  `apps/server/src/faces/embed.ts` - plug the Snapbook pipeline there
  (MVP.md Q4); threshold 0.75 is a guess until measured.

## M6 - Mobile settings, PTT, enrollment (done, typecheck-only)

- Settings screen: server URL (reconnects), answer language pa/hi/en
  (new `{type:"settings"}` WS message; server applies it to proactive and
  command answers), mute toggle (mute/unmute commands). No nav library -
  three screens switch on local state.
- Volume-key push-to-talk (`ptt.ts`): every volume press toggles
  expo-av recording (native volume UI hidden); on stop the m4a is read as
  base64 and sent as an audio message. Protocol audio shape is now
  `{audioBase64, encoding: "pcm16"|"m4a", sampleRate}` - Android cannot
  record PCM, so real STT will need an m4a->wav step (mock ignores bytes).
- Enrollment screen (helper): name, consent checkbox (required), 5 guided
  photo captures with retake, submit to `POST /people`, enrolled list with
  remove. Camera preview shows on this screen only. Shared `captureSmall`
  (768px q70) and `http.ts` helpers; frame uploader refactored onto them.
- How to run: `npm run typecheck -w @thethirdeye/mobile`; device run needs
  your Android SDK (`npx expo run:android`).
- Tests: 76 pass total (config 2, mobile gate 6, server 68 incl. 2 new
  settings tests). Mobile UI/PTT/enrollment are typecheck-only (no device).
- Notes/limits: enrollment submits fine but the stub embedder answers 400
  "no face found" until M5's Blocked item is resolved; PTT toggle (not
  hold) semantics - first press records, second sends; answer language is
  server-global (single-client assumption).
- Next steps for you: on-device pass - hotspot URL, camera permission,
  volume PTT, enrollment with real faces once an embedder exists, and the
  TTS voice test from M3.

## Fix - meta triage robustness + real spend (done, uncommitted)

- Root cause of "triage output is not JSON": muse-spark-1.3 is a reasoning
  model (dev.meta.ai/docs/reasoning) and the old 80-token budget starved
  visible output. Fix: `TRIAGE_MAX_TOKENS` default 400,
  `reasoning_effort: "minimal"` (lowest level Spark supports; "none"
  400s), robust extraction (direct -> ``` fences -> balanced-brace scan ->
  validate), and prompt-only fallback if an endpoint rejects `json_object`.
- Every OpenAI-compat call now logs raw request/response to
  `apps/eval/debug/<file>_<size>.json` (key never included).
- Spend: usage/cost recorded on failed parses too; per-model price table
  (`muse-spark-1.3` 1.25/4.25, `-contributor` 0.10/0.20).
- Verified live: `500_03.jpg` 2/2 correct, $0.000212 spend, debug shows
  `finish_reason: stop` with 124/151 reasoning tokens even at minimal.
- Tests: 88 pass (config 2, eval 3 new, mobile gate 6, server 77 incl. 9
  new parser/fallback/debug/config tests). No commit (not requested).

## Blocked

- **M5 real face embeddings: @vladmandic/human 3.3.6 does not run here**
  (3 strikes, stubbed per the milestone's escape hatch; packages removed):
  1. `@tensorflow/tfjs-node` installed without its native binding (npm
     blocked its download script); fixed via approve + rebuild, but fresh
     clones would need the same manual step.
  2. Rebuild split files across `lib/napi-v8` (binding) and `lib/napi-v10`
     (tensorflow.dll); needed a manual DLL copy to load.
  3. `human.detect()` throws an internal
     `(0, util_1.isNullOrUndefined) is not a function` on both Tensor and
     Buffer inputs even though models load fine - not workaround-able.
  Consequence: `POST /people` returns 400 "no face found" until a real
  `FaceEmbedder` is plugged in; matching stays silent (strangers described
  generically, which is the safe direction).
