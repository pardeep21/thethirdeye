// Minimal HTTP helper for the enrollment screen (REST, not WS).
// globalThis-cast like ws.ts so it typechecks with or without DOM lib.
interface FetchResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

type FetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<FetchResponse>;

function getFetch(): FetchFn {
  const g = globalThis as unknown as { fetch?: FetchFn };
  if (!g.fetch) throw new Error("fetch is not available");
  return g.fetch.bind(globalThis);
}

export async function httpJson(
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; json: unknown }> {
  const res = await getFetch()(url, init);
  return { status: res.status, json: await res.json() };
}

export function wsToHttp(wsUrl: string): string {
  if (wsUrl.startsWith("ws://")) return `http://${wsUrl.slice("ws://".length)}`;
  if (wsUrl.startsWith("wss://")) return `https://${wsUrl.slice("wss://".length)}`;
  throw new Error(`not a ws(s) URL: ${wsUrl}`);
}
