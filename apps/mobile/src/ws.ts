// WebSocket client. Uses a minimal structural WebSocket type so it
// typechecks with or without DOM lib (React Native provides WebSocket).
import { isSpeakMessage, type SpeakLang, type SpeakMessage } from "../../server/src/protocol";

type Timer = ReturnType<typeof setTimeout>;

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
  onStatus(connected: boolean): void;
}

export class EyeWs {
  private ws: NativeWebSocket | null = null;
  private retry: Timer | null = null;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly events: WsEvents
  ) {}

  connect(): void {
    this.closed = false;
    this.open();
  }

  private open(): void {
    if (this.closed) return;
    const Ctor = getWsCtor();
    const ws = new Ctor(this.url);
    this.ws = ws;
    ws.onopen = () => this.events.onStatus(true);
    ws.onmessage = (ev) => {
      try {
        const msg: unknown = JSON.parse(String(ev.data));
        if (isSpeakMessage(msg)) this.events.onSpeak(msg);
      } catch {
        // Ignore malformed down-messages.
      }
    };
    const down = () => {
      this.events.onStatus(false);
      this.scheduleReconnect();
    };
    ws.onclose = down;
    ws.onerror = () => {
      // onerror is followed by onclose; reconnect there.
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retry !== null) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.open();
    }, 1000);
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

  sendFrame(jpegBase64: string, width: number, height: number): void {
    this.sendJson({ type: "frame", jpegBase64, width, height, ts: Date.now() });
  }

  sendAudio(audioBase64: string, encoding: "pcm16" | "m4a", sampleRate: number): void {
    this.sendJson({ type: "audio", audioBase64, encoding, sampleRate, ts: Date.now() });
  }

  sendCommand(name: "mute" | "unmute" | "cancel"): void {
    this.sendJson({ type: "command", name });
  }

  sendSettings(lang: SpeakLang): void {
    this.sendJson({ type: "settings", lang });
  }

  close(): void {
    this.closed = true;
    if (this.retry !== null) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    try {
      this.ws?.close();
    } catch {
      // Ignore close errors.
    }
    this.ws = null;
  }
}
