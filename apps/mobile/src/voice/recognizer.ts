// Speech-recognition wrapper over expo-speech-recognition (Android
// SpeechRecognizer). The hook talks only to this interface, so the native
// module (or a scriptable mock) can be swapped without touching callers.
import {
  ExpoSpeechRecognitionModule,
  type ExpoSpeechRecognitionErrorEvent,
  type ExpoSpeechRecognitionResultEvent,
} from "expo-speech-recognition";

export interface RecognizerResult {
  text: string;
  final: boolean;
  confidence?: number;
}

export type Unsubscribe = () => void;

export interface Recognizer {
  supportedLocales(): Promise<string[]>;
  start(opts: { lang: string; partial: boolean }): void;
  stop(): void;
  onResult(cb: (r: RecognizerResult) => void): Unsubscribe;
  onError(cb: (code: string) => void): Unsubscribe;
}

/** Recognizer plus the lifecycle events the PTT machine needs. */
export interface DeviceRecognizer extends Recognizer {
  /** The recognizer stopped on its own (end-of-speech). */
  onEnd(cb: () => void): Unsubscribe;
  /** A final result arrived with no significant recognition. */
  onNoMatch(cb: () => void): Unsubscribe;
  /** Cancel immediately without a final result (unmount path). */
  abort(): void;
}

type Cb<T> = (v: T) => void;

function sub<T>(set: Set<Cb<T>>, cb: Cb<T>): Unsubscribe {
  set.add(cb);
  return () => {
    set.delete(cb);
  };
}

/** Live recognizer backed by the expo-speech-recognition native module. */
export class ExpoRecognizer implements DeviceRecognizer {
  private results = new Set<Cb<RecognizerResult>>();
  private errors = new Set<Cb<string>>();
  private ends = new Set<Cb<void>>();
  private nomatches = new Set<Cb<void>>();
  private wired = false;
  private active = false;

  private wire(): void {
    if (this.wired) return;
    this.wired = true;
    ExpoSpeechRecognitionModule.addListener("result", (ev: ExpoSpeechRecognitionResultEvent) => {
      const first = ev.results[0];
      const text = first?.transcript ?? "";
      const confidence = first && first.confidence >= 0 ? first.confidence : undefined;
      for (const cb of this.results) cb({ text, final: ev.isFinal, confidence });
    });
    ExpoSpeechRecognitionModule.addListener("error", (ev: ExpoSpeechRecognitionErrorEvent) => {
      this.active = false;
      for (const cb of this.errors) cb(ev.error);
    });
    ExpoSpeechRecognitionModule.addListener("end", () => {
      this.active = false;
      for (const cb of this.ends) cb();
    });
    ExpoSpeechRecognitionModule.addListener("nomatch", () => {
      this.active = false;
      for (const cb of this.nomatches) cb();
    });
  }

  async supportedLocales(): Promise<string[]> {
    try {
      const { locales } = await ExpoSpeechRecognitionModule.getSupportedLocales({});
      return locales;
    } catch {
      return [];
    }
  }

  start(opts: { lang: string; partial: boolean }): void {
    this.wire();
    if (this.active) return;
    this.active = true;
    // RECORD_AUDIO is requested on first use; a denial surfaces as an
    // error event so the PTT machine takes its normal error path.
    void ExpoSpeechRecognitionModule.requestPermissionsAsync().then(
      (perm) => {
        if (!perm.granted) {
          this.active = false;
          for (const cb of this.errors) cb("not-allowed");
          return;
        }
        try {
          ExpoSpeechRecognitionModule.start({
            lang: opts.lang,
            interimResults: opts.partial,
            maxAlternatives: 1,
            // Prefer on-device recognition when the model is present, but
            // allow the network path (this is a preference, not a demand).
            androidIntentOptions: { EXTRA_PREFER_OFFLINE: true },
          });
        } catch {
          this.active = false;
          for (const cb of this.errors) cb("client");
        }
      },
      () => {
        this.active = false;
        for (const cb of this.errors) cb("not-allowed");
      }
    );
  }

  stop(): void {
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch {
      // Already idle; the end/error events (if any) settle the machine.
    }
  }

  abort(): void {
    this.active = false;
    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {
      // Ignore: nothing was listening.
    }
  }

  onResult(cb: (r: RecognizerResult) => void): Unsubscribe {
    this.wire();
    return sub(this.results, cb);
  }

  onError(cb: (code: string) => void): Unsubscribe {
    this.wire();
    return sub(this.errors, cb);
  }

  onEnd(cb: () => void): Unsubscribe {
    this.wire();
    return sub(this.ends, cb);
  }

  onNoMatch(cb: () => void): Unsubscribe {
    this.wire();
    return sub(this.nomatches, cb);
  }
}

/** Scriptable mock recognizer: no native module, no permissions. */
export class MockRecognizer implements DeviceRecognizer {
  private results = new Set<Cb<RecognizerResult>>();
  private errors = new Set<Cb<string>>();
  private ends = new Set<Cb<void>>();
  private nomatches = new Set<Cb<void>>();
  started: Array<{ lang: string; partial: boolean }> = [];
  stops = 0;
  aborts = 0;

  constructor(private readonly locales: string[] = ["pa-IN", "hi-IN", "en-IN"]) {}

  async supportedLocales(): Promise<string[]> {
    return [...this.locales];
  }

  start(opts: { lang: string; partial: boolean }): void {
    this.started.push(opts);
  }

  stop(): void {
    this.stops += 1;
  }

  abort(): void {
    this.aborts += 1;
  }

  onResult(cb: (r: RecognizerResult) => void): Unsubscribe {
    return sub(this.results, cb);
  }

  onError(cb: (code: string) => void): Unsubscribe {
    return sub(this.errors, cb);
  }

  onEnd(cb: () => void): Unsubscribe {
    return sub(this.ends, cb);
  }

  onNoMatch(cb: () => void): Unsubscribe {
    return sub(this.nomatches, cb);
  }

  emitResult(r: RecognizerResult): void {
    for (const cb of this.results) cb(r);
  }

  emitError(code: string): void {
    for (const cb of this.errors) cb(code);
  }

  emitEnd(): void {
    for (const cb of this.ends) cb();
  }

  emitNoMatch(): void {
    for (const cb of this.nomatches) cb();
  }
}
