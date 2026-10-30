# thethirdeye-spike (`apps/eval`)

Benchmark CLI for a blind shopkeeper's assistant. The **notes** test runs any
server `VisionTriage` provider over `data/notes/<label>_*.jpg` and writes
`results.md` (accuracy per denomination, confusion list, p50/p95 latency).
Scenes/audio still use the direct Meta client from the original spike.

## Setup

```sh
npm install   # from the repo root (workspaces)
```

No key needed for `--provider mock`. Real providers need keys (see
`../server/.env.example`): `META_API_KEY`, `OPENROUTER_API_KEY`, or
`OPENAI_API_KEY`. Scenes/audio need `META_API_KEY` in `.env` here.

## Data layout

```
data/
  notes/<label>_*.jpg   label starts with the denomination: 10_1.jpg,
                        500_new_front_03.jpg (10/20/50/100/200/500)
  scenes/*.jpg          shop-counter photos (direct Meta client)
  audio/*.{wav,mp3,...} voice clips (direct Meta client, WAV preferred)
```

## Usage (run from `apps/eval`)

```sh
npm run spike -- notes --provider mock --limit 2   # free smoke run
npm run spike -- notes --provider meta             # real Meta Model API calls
node dist/cli.js notes --provider openrouter --sizes 768
node dist/cli.js scenes --data ./data --out ./results.md
node dist/cli.js audio
```

Flags: `--provider mock|meta|openrouter|openai|local` (default: `PROVIDER`
env, else `mock`), `--data DIR`, `--out FILE`, `--sizes 512,1024` (notes
resize, longest side, downscale only), `--limit N` (max files per test).

Calls are sequential. `results.md` holds run config, spend estimate (Meta
rates only), accuracy, confusion list, latency, descriptions, transcripts.

## Meta Model API contract (checked 2026-10-29)

Vision `POST {base}/chat/completions` (`muse-spark-1.3`),
speech `POST {base}/asr/transcribe` (`muse-voice-transcribe-1.0`),
`Authorization: Bearer`. Pricing: Spark standard $1.25/$4.25/$0.15 per 1M
tokens, transcribe $0.18/hr (estimates; the API does not return cost).

## Diagnosis

Every OpenAI-compat triage call logs raw request/response to
`debug/<file>_<size>.json` (override with `EVAL_DEBUG_DIR`; never contains
the key): full content, `finish_reason`, raw `usage` (incl. reasoning
tokens), and request params. Triage knobs: `TRIAGE_MAX_TOKENS` (default
400), `META_REASONING_EFFORT` (`minimal`|`low`|`medium`|`high`|`xhigh`|
`max`, default `minimal`, `off` omits it).
