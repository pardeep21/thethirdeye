// App state in one context: connection, mode, captions, agent state,
// last cash read, settings, and the actions screens call. useAppState()
// is the only way screens read or change shared state.
import { createContext, useContext } from "react";
import type { SpeakLang, SpokenScript, StateMessage, UtteranceLang } from "../../server/src/protocol";
import type { Caption } from "./voice/captions";
import type { PttState, VoiceMode } from "./ptt";

export type Screen = "home" | "people" | "peopleEnroll" | "settings" | "about";

export interface AppState {
  screen: Screen;
  setScreen(screen: Screen): void;
  // Connection + server mode.
  connected: boolean;
  serverUrl: string;
  saveUrl(url: string): void;
  /** Shared WS token (empty = none); rejected servers set authFailed. */
  appToken: string;
  saveToken(token: string): void;
  authFailed: boolean;
  serverState: StateMessage | null;
  // Voice + speech.
  pttState: PttState;
  talk(): void;
  partial: string | null;
  speaking: boolean;
  // Content.
  captions: Caption[];
  lastCash: { text: string; at: number } | null;
  lastAnswerMs: number | null;
  peopleCount: number | null;
  refreshPeople(): void;
  /** Ticking clock (10 s) so relative times stay fresh. */
  now: number;
  // Settings.
  lang: SpeakLang;
  changeLang(lang: SpeakLang): void;
  script: SpokenScript;
  changeScript(script: SpokenScript): void;
  muted: boolean;
  changeMuted(muted: boolean): void;
  voiceMode: VoiceMode;
  changeVoiceMode(mode: VoiceMode): void;
  recogLocale: UtteranceLang;
  showCamera: boolean;
  changeShowCamera(show: boolean): void;
  ttsRate: number;
  changeTtsRate(rate: number): void;
  hfovOverride: number | null;
  changeHfov(hfov: number | null): void;
  // Home actions.
  lookAround: boolean;
  toggleLookAround(): void;
  cashRead(): void;
}

export const AppStateContext = createContext<AppState | null>(null);

export function useAppState(): AppState {
  const state = useContext(AppStateContext);
  if (!state) throw new Error("useAppState must be used inside AppStateContext");
  return state;
}
