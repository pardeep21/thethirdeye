// Volume-key push-to-talk: every volume press toggles recording; on stop the
// m4a file is read as base64 and sent over WS. The native volume UI is hidden
// while mounted so presses don't change the volume.
import { useCallback, useEffect, useRef, useState } from "react";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system";
import { addVolumeListener, showNativeVolumeUI } from "react-native-volume-manager";
import type { EyeWs } from "./ws";

export type PttState = "idle" | "recording" | "sending";

interface OngoingRecording {
  stopAndUnloadAsync(): Promise<unknown>;
  getURI(): string | null;
}

export function usePushToTalk(getWs: () => EyeWs | null): { pttState: PttState } {
  const [state, setState] = useState<PttState>("idle");
  const recordingRef = useRef<OngoingRecording | null>(null);
  const busyRef = useRef(false);
  const getWsRef = useRef(getWs);
  getWsRef.current = getWs;

  const stopAndSend = useCallback(async () => {
    const rec = recordingRef.current;
    recordingRef.current = null;
    if (!rec) {
      setState("idle");
      return;
    }
    setState("sending");
    try {
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI();
      const ws = getWsRef.current();
      if (uri && ws) {
        const base64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const presetRate = Audio.RecordingOptionsPresets.HIGH_QUALITY.android?.sampleRate;
        ws.sendAudio(base64, "m4a", presetRate ?? 44100);
      }
    } catch {
      // Drop failed utterances; the user can press again.
    } finally {
      setState("idle");
    }
  }, []);

  const startRecording = useCallback(async () => {
    try {
      const permission = await Audio.requestPermissionsAsync();
      if (!permission.granted) return;
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await rec.startAsync();
      recordingRef.current = rec;
      setState("recording");
    } catch {
      recordingRef.current = null;
      setState("idle");
    }
  }, []);

  const toggle = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      if (recordingRef.current) await stopAndSend();
      else await startRecording();
    } finally {
      busyRef.current = false;
    }
  }, [startRecording, stopAndSend]);

  useEffect(() => {
    showNativeVolumeUI({ enabled: false });
    const sub = addVolumeListener(() => {
      void toggle();
    });
    return () => {
      sub.remove();
      showNativeVolumeUI({ enabled: true });
      const rec = recordingRef.current;
      recordingRef.current = null;
      if (rec) void rec.stopAndUnloadAsync().catch(() => undefined);
    };
  }, [toggle]);

  return { pttState: state };
}
