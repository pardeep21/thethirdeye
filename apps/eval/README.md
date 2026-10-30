# eyesmart-spike

A small benchmark CLI (not an app) that measures whether Meta Model API models
are accurate and fast enough for a blind shopkeeper's assistant.

It runs three tests and writes `results.md`:

1. **notes** - identify Indian rupee denominations (10/20/50/100/200/500) from
   photos, at 512px and 1024px longest side. Strict JSON-only prompt, answers
   scored against filenames (`<value>_<n>.jpg`).
2. **scenes** - describe shop-counter photos in under 12 words, focused on
   people (count, rough position, approximate age/gender, action). Never
   identifies anyone by name.
3. **audio** - transcribe voice clips with Muse Voice Transcribe and print
   each transcript.

Every call records model, image size, end-to-end latency (ms), token usage
(when returned), and estimated cost.

## Setup

```sh
npm install
cp .env.example .env
# edit .env: paste your key from https://dev.meta.ai/ (dashboard > API keys)
```

## Meta Model API contract (checked 2026-10-29)

From https://dev.meta.ai/products/meta-model-api and
https://dev.meta.ai/docs/overview, plus the meta-model-cookbook:

| Use      | Endpoint                          | Model ID                  |
|----------|-----------------------------------|---------------------------|
| Vision   | `POST {base}/chat/completions`    | `muse-spark-1.3`          |
| Speech   | `POST {base}/asr/transcribe`      | `muse-voice-transcribe-1.0` |

- Base URL: `https://api.meta.ai/v1` (override: `META_BASE_URL`).
- Auth: `Authorization: Bearer <key>`. The key env var is `META_API_KEY`;
  `MODEL_API_KEY` (Meta's own name) works as a fallback.
- Model overrides: `META_VISION_MODEL`, `META_ASR_MODEL`.
- Vision calls are OpenAI-compatible Chat Completions (base64 `image_url`,
  `response_format: json_object` for the notes test). Usage comes from the
  response `usage` object.
- The ASR file endpoint takes multipart `request` (JSON: `model`,
  `audioEncoding: "WAV"`, `mode: "PUSH_TO_TALK"`) + `audio` bytes. It
  requires mono 16-bit WAV, max 10 minutes / 32 MB.

Pricing (estimates only; the API does not return cost):

| Model                        | Input / 1M | Output / 1M | Cached / 1M | Audio     |
|------------------------------|------------|-------------|-------------|-----------|
| muse-spark-1.3 (standard)    | $1.25      | $4.25       | $0.15       | -         |
| muse-voice-transcribe-1.0    | -          | -           | -           | $0.18/hr  |

## Data layout

```
data/
  notes/<value>_<n>.jpg   value in {10,20,50,100,200,500}
  scenes/*.jpg            shop-counter photos
  audio/*.{wav,mp3,...}   voice clips (WAV strongly preferred)
```

Convert clips to the required WAV format with:

```sh
ffmpeg -i input -ac 1 -ar 16000 -c:a pcm_s16le out.wav
```

## Usage

```sh
npm run spike -- all                      # build + run everything -> ./results.md
node dist/cli.js notes --limit 2          # cheap smoke run: 2 note images x 2 sizes
node dist/cli.js scenes --data ./data --out ./results.md
node dist/cli.js audio
node dist/cli.js --help
```

Flags: `--data DIR` (default `./data`), `--out FILE` (default `./results.md`),
`--sizes 512,1024` (notes resize, longest side, downscale only),
`--limit N` (max files per test, 0 = all).

Calls are sequential (one at a time, in filename order). Only HTTP 429 is
retried (up to 5 times, honors `Retry-After`, else 1s..16s backoff). Latency
is the successful round-trip per call; backoff time is excluded and retry
counts are visible in the console log.

## Output

`results.md` contains: run config, total estimated spend, accuracy table per
denomination x size, confusion list of wrong answers, p50/p95 latency per
test and image size (successful calls only), scene descriptions, transcripts,
and an error list. Transcripts are also printed to stdout during the run.

## Project structure

```
src/cli.ts     arg parsing, orchestration, exit codes
src/client.ts  .env, auth, Chat Completions, retry, cost estimates
src/notes.ts   test 1 (denominations)
src/scenes.ts  test 2 (descriptions)
src/audio.ts   test 3 (transcription)
src/report.ts  results.md generation
src/types.ts   shared record types
```

One runtime dependency (`sharp`, for the 512px/1024px downscale); no
frameworks. Costs real money per call - start with `--limit` to smoke-test.
