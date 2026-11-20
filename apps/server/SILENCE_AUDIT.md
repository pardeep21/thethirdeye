# Server silence audit (R1, fixed)

Goal: every user turn ends with something the user hears. Fixed by the
TurnGuard (`src/turnGuard.ts`): `begin()` when a turn starts,
`markSpoken()` on any non-empty `speak` or intentional `ack` earcon,
`finish()` in a `finally` for both entry points. A turn that produced
nothing audible and was not superseded by a newer turn (barge-in) speaks
one generic fallback (`renderAgentUnsure`, never a stale model answer or
cash value) as P1, logs `silent_turn_rescued reason=...`, and bumps
`silentTurnsRescued` in `/stats`.

Two user-turn entry points (`src/index.ts`):

1. `handleUtterance` (phone-side STT → `utterance` message).
2. `handleCommand` (server-side STT → `audio` message), drained by the
   audio branch after it returns.

Outcome legend: **SPEAK** = at least one `speak` message leaves the turn;
**EARCON** = earcon only, no `speak`; **NOTHING** = neither (`state` and
`capture_now` messages don't count — the user hears neither).

Note: `engine.answer` (P1) bypasses mute, so "muted" never turns a SPEAK
row silent. Empty or whitespace-only `say` and empty rendered strings
count as nothing to say and are rescued.

## handleUtterance paths

| ID | Path / condition | Outcome | Notes |
|----|------------------|---------|-------|
| U1 | `mute` fast path | EARCON | `setMuted` + `pushState` + `ack`. |
| U2 | `unmute` fast path | EARCON | Same shape as U1. |
| U3 | `cancel` with look-around OFF | EARCON | `engine.cancel()` + `ack`. |
| U4 | `cancel` with look-around ON | SPEAK + EARCON | `renderOkay` ("Theek hai") + `ack`. |
| U5 | bare yes/no with pending consent/duplicate/forget | SPEAK | `confirm_consent` deterministic line. |
| U6 | `howmuch` | SPEAK | `cashRead` line (note / unsure / timeout). |
| U7 | `more` → label-read continuation | SPEAK | Next chunk. |
| U8 | `more` → scene page | SPEAK | Next page, or "Kujh khaas nahi" when empty. |
| U9 | `more` with no continuation and no scene | agent path | Falls through to U11+. |
| U10 | yes/no text with no matching pending action | agent path | Falls through to the agent. |
| U11 | agent throws, e.g. bad JSON → `failAgentTurn` | SPEAK + EARCON | `earcon:error` + `renderAgentUnsure`. |
| U12 | agent times out (same `failAgentTurn`) | SPEAK + EARCON | `earcon:error` + `renderModelTimeout`. |
| U13 | agent `{say: null, actions: []}` | SPEAK | TurnGuard fallback `renderAgentUnsure` (`reason=null-say`). |
| U14 | agent `{say: "", …}` or `{say: "   ", …}` | SPEAK | Empty render counts as nothing; same fallback. |
| U15 | agent `say: null` + `find`, finder returns no box | SPEAK | Miss still speaks "Nahi labhi". No-frame `find` speaks unsure. |
| U16 | agent `remember_person` that fails with no face | SPEAK | "Saamne koi chehra nahi"; gone/which/quality variants too. |
| U17 | agent `say: null` + only `look_around` / `mute` actions | SPEAK | State flip still applies; TurnGuard fallback speaks. |
| U18 | agent `say: null` + `cash_check` | SPEAK | `cashRead` line answered directly. |
| U19 | `capture_now` never answered AND no fresh `lastFrame` | SPEAK | Agent runs with `image: undefined`; silent outputs rescued as U13/U14. |
| U20 | agent non-empty `say`, no people line | SPEAK | P1 `speak`. |
| U21 | agent non-empty `say` + people line | SPEAK | People line only (anti-double-speak). |
| U22 | barge-in: older turn superseded by a newer one | NOTHING (old) / SPEAK (new) | Old turn speaks neither its answer nor a fallback; only the latest turn speaks. |

## handleCommand (audio) paths

`handleCommand` queues into the engine; the audio branch drains after it,
so every queued `answer` becomes a `speak`. Thrown errors are caught
inside `handleCommand` and rescued in its `finally`, then drained.

| ID | Path / condition | Outcome | Notes |
|----|------------------|---------|-------|
| C1 | `mute` | EARCON | `pushState` + `ack`. |
| C2 | `unmute` | EARCON | Same. |
| C3 | `cancel` with look-around OFF | EARCON | `engine.cancel()` + `ack`. |
| C4 | `cancel` with look-around ON | SPEAK + EARCON | `renderOkay` + `ack`. |
| C5 | `more` | SPEAK | `readContinuation ?? answerMoreText()`. |
| C6 | `unknown` intent | SPEAK | `renderDidntUnderstand` ("samajh nahi aaya, dobara bolo"). |
| C7 | `describe` with no frame yet | SPEAK | `renderNoCamera` ("camera ton tasveer nahi aayi, dobara puchho"). |
| C8 | `describe`, model timeout → `tryCommandModel` null | SPEAK | Timeout line queued inside `tryCommandModel`, then drained. |
| C9 | `describe`, model throws non-timeout error | SPEAK | Caught; TurnGuard fallback `renderAgentUnsure` (`reason=error`). |
| C10 | `describe` with frame, model ok | SPEAK | Model text verbatim; blank text is rescued (no empty `speak`). |
| C11 | `read` with no frame yet | SPEAK | `renderNoCamera`. |
| C12 | `read`, model timeout → null | SPEAK | Timeout line speaks (same mechanism as C8). |
| C13 | `read`, model throws non-timeout error | SPEAK | Same rescue as C9. |
| C14 | `read` ok but blank text | SPEAK | Unsure line. |
| C15 | `read` ok | SPEAK | First chunk (+ "hor?" tail), `lastRead` stored. |
| C16 | `find` with no frame | SPEAK | `boxes = []` → miss line "Nahi labhi". |
| C17 | `find`, model timeout → null | SPEAK | Timeout line (same mechanism as C8). |
| C18 | `find`, model throws non-timeout error | SPEAK | Same rescue as C9. |
| C19 | `find` ok | SPEAK | `renderFind` line (located or miss). |
| C20 | `who` | SPEAK | Summary, or "Koi nahi" when empty. |
| C21 | `howmuch` | SPEAK | `cashRead` (no frame → unsure; timeout → timeout line). |
| C22 | blank STT transcript | NOTHING | No turn starts; not a user turn, listed for completeness. |
| C23 | STT itself throws | NOTHING | Logged; no turn started so no guard rescue. No test pins this (mock STT never throws). |

## Phone UI command messages (for completeness)

| ID | Path / condition | Outcome | Notes |
|----|------------------|---------|-------|
| M1 | `command` mute/unmute | EARCON | State push + `ack`. |
| M2 | `command` cancel | EARCON | `engine.cancel()` + `ack` (no "Theek hai": a UI button needs only an ack). |

## Fixed silent paths

All formerly-silent user turns now speak or ack; `src/silence.test.ts`
pins each green with no `todo` markers, plus barge-in and `/stats`
coverage:

Speak-expected (assert ≥1 `speak`):

- `agent {say: null, actions: []} must speak` → U13
- `agent {say: ""} must speak` → U14
- `agent {say: "   "} must speak` → U14
- `agent {say: null} + look_around-only must speak` → U17
- `agent {say: null} + mute-only must speak` → U17
- `audio describe with no frame must speak` → C7
- `audio read with no frame must speak` → C11
- `audio unknown intent must speak` → C6
- `audio describe whose model throws must speak` → C9 (C13/C18 same catch)

Ack-expected (assert an `ack` earcon for mute / unmute / cancel):

- `utterance mute must emit ack` → U1
- `utterance unmute must emit ack` → U2
- `utterance cancel (look-around off) must emit ack` → U3
- `utterance cancel (look-around on) must emit ack` → U4
- `audio mute must emit ack` → C1
- `audio unmute must emit ack` → C2
- `audio cancel (look-around off) must emit ack` → C3
- `audio cancel (look-around on) must emit ack` → C4

Already-speaking paths pinned green:

- `agent find miss speaks Nahi labhi` → U15
- `agent remember_person with no face speaks` → U16
- `agent throw speaks the unsure fallback` → U11
- `agent timeout speaks the timeout line` → U12
- `capture miss with no lastFrame still speaks` → U19 (default mock agent)
- `audio describe timeout speaks the timeout line` → C8 (covers C12/C17)

New coverage:

- `barge-in: late A stays silent, only B speaks` → U22
- `/stats shows silentTurnsRescued` → rescue counter visible
- `src/turnGuard.test.ts`: spoken (no fallback), silent (fallback once),
  thrown error (fallback once via finally), superseded (no fallback)
