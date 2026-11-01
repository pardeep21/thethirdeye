// Captions: the last 5 server speak lines plus the live partial transcript,
// exposed via hooks for the home screen (prompt 04 builds the tiled UI).
import { useSyncExternalStore } from "react";
import type { SpeakKind } from "../../../server/src/protocol";

export interface Caption {
  id: number;
  text: string;
  kind: SpeakKind | null;
  at: number;
}

/** Max captions retained. */
export const MAX_CAPTIONS = 5;

let nextId = 1;
let captions: Caption[] = [];
let partial: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const cb of listeners) cb();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Record a server speak line. Returns the stored caption. */
export function addCaption(text: string, kind: SpeakKind | null): Caption {
  const caption = { id: nextId++, text, kind, at: Date.now() };
  captions = [...captions, caption].slice(-MAX_CAPTIONS);
  emit();
  return caption;
}

/** Live partial transcript while listening; null when not listening. */
export function setPartial(text: string | null): void {
  if (partial === text) return;
  partial = text;
  emit();
}

/** Snapshot for tests and non-React callers. */
export function getCaptions(): Caption[] {
  return [...captions];
}

/**
 * Stable snapshot for useSyncExternalStore: the same array reference until
 * addCaption replaces it. (Returning a copy here re-renders forever.)
 */
function getCaptionSnapshot(): Caption[] {
  return captions;
}

export function getPartial(): string | null {
  return partial;
}

/** Last 5 speak lines, oldest first. */
export function useCaptions(): Caption[] {
  return useSyncExternalStore(subscribe, getCaptionSnapshot, getCaptionSnapshot);
}

/** Live partial transcript, or null when not listening. */
export function usePartial(): string | null {
  return useSyncExternalStore(subscribe, getPartial, getPartial);
}
