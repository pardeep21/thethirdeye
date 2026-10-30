# thethirdeye-spike results

Run at (UTC): 2026-10-30T10:18:15.754Z
Notes triage: `openai-compat:muse-spark-1.3-contributor` (provider meta)
Direct Meta client: not used (no scenes/audio files)
Notes sizes: 512px longest side, 1024px longest side (downscale only; actual dims per call)

## Total spend (estimated)

**$0.000212** across 2 calls (2 ok, 0 failed).
- Vision: $0.000212 over 2 calls, 1853 tokens total (where usage was returned).
- Audio: $0.000000 over 0 clips.

Costs are estimates from public Meta Model API pricing, not billed amounts:
muse-spark standard $1.25/1M input, $4.25/1M output, $0.15/1M cached input;
muse-voice-transcribe-1.0 $0.18/hour of audio. Pricing checked 2026-10-29;
see https://dev.meta.ai/products/meta-model-api and https://dev.meta.ai/docs/overview.

## Notes accuracy per denomination

| Denomination | Size | n | Correct | Accuracy |
|---|---|---|---|---|
| 10 | 512px | 0 | 0 | n/a |
| 10 | 1024px | 0 | 0 | n/a |
| 20 | 512px | 0 | 0 | n/a |
| 20 | 1024px | 0 | 0 | n/a |
| 50 | 512px | 0 | 0 | n/a |
| 50 | 1024px | 0 | 0 | n/a |
| 100 | 512px | 0 | 0 | n/a |
| 100 | 1024px | 0 | 0 | n/a |
| 200 | 512px | 0 | 0 | n/a |
| 200 | 1024px | 0 | 0 | n/a |
| 500 | 512px | 1 | 1 | 100.0% |
| 500 | 1024px | 1 | 1 | 100.0% |
| **overall** | **512px** | **1** | **1** | **100.0%** |
| **overall** | **1024px** | **1** | **1** | **100.0%** |

## Confusion list (wrong notes answers)

None - every scored answer was correct.

## Latency p50/p95 per test and image size

_Successful calls only; end-to-end HTTP round-trip per call, sequential, retries excluded from the timed span._

### All groups

| Test | Image size | n (ok/total) | p50 | p95 |
|---|---|---|---|---|
| notes | 512px | 1/1 | 3786ms | 3786ms |
| notes | 1024px | 1/1 | 4573ms | 4573ms |

## Scene descriptions

(scenes test not run)

## Transcripts

(audio test not run)
