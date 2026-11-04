# thethirdeye-spike results

Run at (UTC): 2026-11-04T05:57:46.168Z
Notes triage: `openai-compat:muse-spark-1.3-contributor` (provider meta)
Direct Meta client: not used (no scenes/audio files)
Notes sizes: 512px longest side, 1024px longest side (downscale only; actual dims per call)

## Total spend (estimated)

**$0.007072** across 60 calls (60 ok, 0 failed).
- Vision: $0.007072 over 60 calls, 59600 tokens total (where usage was returned).
- Audio: $0.000000 over 0 clips.

Costs are estimates from public Meta Model API pricing, not billed amounts:
muse-spark standard $1.25/1M input, $4.25/1M output, $0.15/1M cached input;
muse-voice-transcribe-1.0 $0.18/hour of audio. Pricing checked 2026-10-29;
see https://dev.meta.ai/products/meta-model-api and https://dev.meta.ai/docs/overview.

## Notes accuracy per denomination

| Denomination | Size | n | Correct | Accuracy | Unsure |
|---|---|---|---|---|---|
| 10 | 512px | 5 | 5 | 100.0% | 0 (0.0%) |
| 10 | 1024px | 5 | 5 | 100.0% | 0 (0.0%) |
| 20 | 512px | 5 | 5 | 100.0% | 0 (0.0%) |
| 20 | 1024px | 5 | 5 | 100.0% | 0 (0.0%) |
| 50 | 512px | 5 | 5 | 100.0% | 0 (0.0%) |
| 50 | 1024px | 5 | 5 | 100.0% | 0 (0.0%) |
| 100 | 512px | 5 | 5 | 100.0% | 0 (0.0%) |
| 100 | 1024px | 5 | 5 | 100.0% | 0 (0.0%) |
| 200 | 512px | 5 | 5 | 100.0% | 0 (0.0%) |
| 200 | 1024px | 5 | 5 | 100.0% | 0 (0.0%) |
| 500 | 512px | 5 | 5 | 100.0% | 0 (0.0%) |
| 500 | 1024px | 5 | 4 | 80.0% | 1 (20.0%) |
| **overall** | **512px** | **30** | **30** | **100.0%** | **0 (0.0%)** |
| **overall** | **1024px** | **30** | **29** | **96.7%** | **1 (3.3%)** |

## Confusion list (wrong notes answers)

- `500_01.jpg` @ 1024px (1024x768): expected **500**, got **null** (confidence 0.5, note_visible false, 6224ms)

## Latency p50/p95 per test and image size

_Successful calls only; end-to-end HTTP round-trip per call, sequential, retries excluded from the timed span._

### All groups

| Test | Image size | n (ok/total) | p50 | p95 |
|---|---|---|---|---|
| notes | 512px | 30/30 | 2957ms | 4490ms |
| notes | 1024px | 30/30 | 2722ms | 5910ms |

## Scene descriptions

(scenes test not run)

## Transcripts

(audio test not run)
