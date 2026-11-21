// Hard timeouts for model calls (overnight T1, R4 fallback). Every model
// call races a timer: proactive triage drops silently on timeout, command
// turns speak a deterministic "not sure" line. Late losers are discarded,
// never spoken.
// Fallback policy (R4): the MOCK provider never chains (it speaks fixed
// denominations, a confident wrong answer). REAL providers may chain once:
// primary gets a per-attempt budget (AGENT_PRIMARY_TIMEOUT_MS and friends),
// the backup gets the remaining time up to the stage total (AGENT_TIMEOUT_MS
// etc.), so every turn stays bounded. Only retryable failures move down the
// chain: timeouts, network errors, 5xx, 429, and parse/validation errors.
export type TimeoutStage = "triage" | "scene" | "agent" | "answer" | "find";

export class ModelTimeoutError extends Error {
  readonly stage: TimeoutStage;
  readonly timeoutMs: number;

  constructor(stage: TimeoutStage, timeoutMs: number) {
    super(`model timeout stage=${stage} after ${timeoutMs}ms`);
    this.name = "ModelTimeoutError";
    this.stage = stage;
    this.timeoutMs = timeoutMs;
  }
}

function timeoutMsFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${name}=${raw} must be a non-negative integer (ms)`);
  }
  return n;
}

/** Cash + scene triage budget (proactive and howmuch paths). */
export function triageTimeoutFromEnv(): number {
  return timeoutMsFromEnv("TRIAGE_TIMEOUT_MS", 5000);
}

/** Agent-turn budget (agent respond + describe/read on the command path). */
export function agentTimeoutFromEnv(): number {
  return timeoutMsFromEnv("AGENT_TIMEOUT_MS", 9000);
}

/** Primary attempt budget inside an agent fallback chain (backup gets the rest). */
export function agentPrimaryTimeoutFromEnv(): number {
  return timeoutMsFromEnv("AGENT_PRIMARY_TIMEOUT_MS", 5000);
}

/** Primary attempt budget inside a triage fallback chain (backup gets the rest). */
export function triagePrimaryTimeoutFromEnv(): number {
  return timeoutMsFromEnv("TRIAGE_PRIMARY_TIMEOUT_MS", 5000);
}

/** Primary attempt budget inside a finder fallback chain (backup gets the rest). */
export function findPrimaryTimeoutFromEnv(): number {
  return timeoutMsFromEnv("FIND_PRIMARY_TIMEOUT_MS", 5000);
}

/** Finder budget (agent locate + command find). */
export function findTimeoutFromEnv(): number {
  return timeoutMsFromEnv("FIND_TIMEOUT_MS", 7000);
}

/**
 * Race p against a timer. The loser is discarded: a late resolve is never
 * consumed and a late reject is swallowed (no unhandled rejection, no
 * double speak). The timer is always cleared so tests never hang.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, stage: TimeoutStage): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ModelTimeoutError(stage, ms)), ms);
  });
  void p.then(
    () => clearTimeout(timer),
    () => clearTimeout(timer)
  );
  return Promise.race([p, timeout]);
}
