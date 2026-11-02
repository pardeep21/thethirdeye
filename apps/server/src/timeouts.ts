// Hard timeouts for model calls (overnight T1). Every Spark call races a
// timer: proactive triage drops silently on timeout, command turns speak a
// deterministic "not sure" line. Late losers are discarded, never spoken.
// There is intentionally NO fallback to another provider: mock speaks fixed
// denominations, which would be a confident wrong answer.
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
  return timeoutMsFromEnv("AGENT_TIMEOUT_MS", 7000);
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
