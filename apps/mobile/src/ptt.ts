// Volume-key push-to-talk: every volume press toggles recording; on stop the
// m4a file is read as base64 and sent over WS. The native volume UI is hidden
// while mounted so presses don't change the volume.
import { useCallback, useEffect, useRef, useState } from "react";
import { AudioModule, RecordingPresets, useAudioRecorder } from "expo-audio";
import * as FileSystem from "expo-file-system";
import { addVolumeListener, showNativeVolumeUI } from "react-native-volume-manager";
import type { EyeWs } from "./ws";

export type PttState = "idle" | "recording" | "sending";

export function usePushToTalk(getWs: () => EyeWs | null): { pttState: PttState } {
  const [state, setState] = useState<PttState>("idle");
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recordingRef = useRef(false);
  const busyRef = useRef(false);
  const getWsRef = useRef(getWs);
  getWsRef.current = getWs;

  const stopAndSend = useCallback(async () => {
    if (!recordingRef.current) {
      setState("idle");
      return;
    }
    recordingRef.current = false;
    setState("sending");
    try {
      await recorder.stop();
      const uri = recorder.uri;
      const ws = getWsRef.current();
      if (uri && ws) {
        const base64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        ws.sendAudio(base64, "m4a", RecordingPresets.HIGH_QUALITY.sampleRate);
      }
    } catch {
      // Drop failed utterances; the user can press again.
    } finally {
      setState("idle");
    }
  }, [recorder]);

  const startRecording = useCallback(async () => {
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) return;
      await AudioModule.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      recordingRef.current = true;
      setState("recording");
    } catch {
      recordingRef.current = false;
      setState("idle");
    }
  }, [recorder]);

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
      if (recordingRef.current) {
        recordingRef.current = false;
        void recorder.stop().catch(() => undefined);
      }
    };
  }, [toggle, recorder]);

  return { pttState: state };
}
