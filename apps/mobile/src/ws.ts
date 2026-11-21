// WebSocket client. Uses a minimal structural WebSocket type so it
// typechecks with or without DOM lib (React Native provides WebSocket).
// Heartbeat + reconnect live in ConnectionHealth: ping every 5 s, kill a
// socket silent for 12 s (half-open shop Wi-Fi), reconnect with exponential
// backoff + jitter, and speak drop/back announcements exactly once.
import {
  isCaptureNowMessage,
  isEarconMessage,
  isPongMessage,
  isSpeakMessage,
  isStateMessage,
  type CaptureNowMessage,
  type EarconMessage,
  type LensId,
  type SpeakLang,
  type SpeakMessage,
  type SpokenScript,
  type StateMessage,
  type UtteranceLang,
} from "../../server/src/protocol";
import { ConnectionHealth, type AnnounceKind, type HealthClock } from "./connectionHealth";

interface NativeWebSocket {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

interface NativeWebSocketCtor {
  new (url: string): NativeWebSocket;
  readonly OPEN: number;
}

function getWsCtor(): NativeWebSocketCtor {
  const g = globalThis as unknown as { WebSocket?: NativeWebSocketCtor };
  if (!g.WebSocket) throw new Error("WebSocket is not available");
  return g.WebSocket;
}

export interface WsEvents {
  onSpeak(msg: SpeakMessage): void;
  onEarcon(msg: EarconMessage): void;
  onCaptureNow(msg: CaptureNowMessage): void;
  /** Fired when the server rejects the app token (no retry: fix Settings). */
  onAuthFailure?(): void;
  onState(msg: StateMessage): void;
  onStatus(connected: boolean): void;
  /** Fired synchronously when an utterance goes up (latency tracking). */
  onUtteranceSent?: (ts: number) => void;
  /** Speak-once announcements: "lost" after 3 s down, "back" on recovery. */
  onAnnounce?(kind: AnnounceKind): void;
  /** RTT sample from each pong (Settings diagnostics). */
  onRtt?(rttMs: number): void;
}

export interface WsIdent {
  appVersion: string;
  device: string;
  /** Shared server token (APP_TOKEN); omit when the server sets none. */
  token?: string;
}

export interface WsDeps {
  clock?: HealthClock;
  random?: () => number;
}

/** WS close code the server uses for rejected auth (mirrors the server). */
export const WS_CLOSE_AUTH = 4401;

export interface FrameMeta {
  width: number;
  height: number;
  lens: LensId;
  hfovDeg: number;
  reqId?: string;
}

export class EyeWs {
  private ws: NativeWebSocket | null = null;
  private closed = false;
  private readonly health: ConnectionHealth;

  constructor(
    private readonly url: string,
    private readonly events: WsEvents,
    private readonly ident: WsIdent = { appVersion: "dev", device: "unknown" },
    deps: WsDeps = {}
  ) {
    this.health = new ConnectionHealth(
      {
        sendPing: (t) => this.sendJson({ type: "ping", t }),
        killSocket: () => this.killDeadSocket(),
        reconnect: () => this.open(),
        announce: (kind) => this.events.onAnnounce?.(kind),
        onStatus: (connected) => this.events.onStatus(connected),
        onRtt: (rttMs) => this.events.onRtt?.(rttMs),
      },
      deps
    );
  }

  /** True while the socket is up (hello sent, no close seen). */
  isConnected(): boolean {
    return this.health.connected;
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  private open(): void {
    if (this.closed) return;
    const Ctor = getWsCtor();
    const ws = new Ctor(this.url);
    this.ws = ws;
    ws.onopen = () => {
      // A stale socket (killed or superseded) must not resurrect us.
      if (this.ws !== ws) return;
      this.sendJson({
        type: "hello",
        appVersion: this.ident.appVersion,
        device: this.ident.device,
        ...(this.ident.token ? { token: this.ident.token } : {}),
      });
      this.health.onOpened();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      try {
        const msg: unknown = JSON.parse(String(ev.data));
        if (isPongMessage(msg)) this.health.onPong(msg.t);
        else if (isSpeakMessage(msg)) {
          this.health.onDownMessage();
          this.events.onSpeak(msg);
        } else if (isEarconMessage(msg)) {
          this.health.onDownMessage();
          this.events.onEarcon(msg);
        } else if (isCaptureNowMessage(msg)) {
          this.health.onDownMessage();
          this.events.onCaptureNow(msg);
        } else if (isStateMessage(msg)) {
          this.health.onDownMessage();
          this.events.onState(msg);
        }
      } catch {
        // Ignore malformed down-messages.
      }
    };
    const down = (ev: unknown) => {
      if (this.ws !== ws) return;
      this.ws = null;
      // Auth rejections need a Settings fix, not a retry loop.
      const code = (ev as { code?: unknown } | null)?.code;
      if (code === WS_CLOSE_AUTH) {
        this.health.onAuthFailed();
        this.events.onAuthFailure?.();
        return;
      }
      this.health.onClosed();
    };
    ws.onclose = down;
    ws.onerror = () => {
      // onerror is followed by onclose; reconnect there.
    };
  }

  /**
   * Detach + close a half-open socket, then run the normal down path. The
   * handlers are nulled first so the ghost socket can never double-count
   * the close when its own onclose eventually fires.
   */
  private killDeadSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        // Ignore close errors on a dead socket.
      }
    }
    this.health.onClosed();
  }

  private sendJson(obj: unknown): void {
    const ws = this.ws;
    if (!ws) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      // Drop on send failure; the gate will resend.
    }
  }

  sendFrame(jpegBase64: string, meta: FrameMeta): void {
    this.sendJson({
      type: "frame",
      jpegBase64,
      width: meta.width,
      height: meta.height,
      lens: meta.lens,
      hfovDeg: meta.hfovDeg,
      ...(meta.reqId !== undefined ? { reqId: meta.reqId } : {}),
      ts: Date.now(),
    });
  }

  sendCaptureFailed(reqId: string, reason: string): void {
    this.sendJson({ type: "capture_failed", reqId, reason });
  }

  sendAudio(audioBase64: string, encoding: "pcm16" | "m4a", sampleRate: number): void {
    this.sendJson({ type: "audio", audioBase64, encoding, sampleRate, ts: Date.now() });
  }

  sendUtterance(text: string, lang: UtteranceLang, confidence?: number): void {
    const ts = Date.now();
    this.events.onUtteranceSent?.(ts);
    this.sendJson({
      type: "utterance",
      text,
      lang,
      ...(confidence !== undefined ? { confidence } : {}),
      ts,
    });
  }

  sendMode(lookAround: boolean): void {
    this.sendJson({ type: "mode", lookAround });
  }

  sendListening(state: "start" | "stop"): void {
    this.sendJson({ type: "listening", state });
  }

  sendCommand(name: "mute" | "unmute" | "cancel"): void {
    this.sendJson({ type: "command", name });
  }

  sendSettings(lang: SpeakLang, script?: SpokenScript): void {
    this.sendJson({ type: "settings", lang, ...(script !== undefined ? { script } : {}) });
  }

  close(): void {
    this.closed = true;
    this.health.shutdown();
    try {
      this.ws?.close();
    } catch {
      // Ignore close errors.
    }
    this.ws = null;
  }
}
