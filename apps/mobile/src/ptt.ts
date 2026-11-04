// Push-to-talk: volume-key or Talk button. Default path is on-device
// speech recognition (android_stt): first press listens, second press (or
// the recognizer's own end-of-speech) stops, and the final transcript goes
// up as an utterance. The legacy expo-audio record-and-send path stays
// behind voiceMode "server_audio". The native volume UI stays hidden while
// mounted so presses never change the volume.
import { useCallback, useEffect, useRef, useState } from "react";
import { AudioModule, RecordingPresets, useAudioRecorder } from "expo-audio";
import * as FileSystem from "expo-file-system";
import { addVolumeListener, showNativeVolumeUI } from "react-native-volume-manager";
import type { UtteranceLang } from "../../server/src/protocol";
import type { EyeWs } from "./ws";
import type { SpeakQueue } from "./speech";
import { playEarcon } from "./voice/earcons";
import { addCaption, setPartial } from "./voice/captions";
import type { DeviceRecognizer } from "./voice/recognizer";
import {
  createPttState,
  pttTransition,
  type PttEffect,
  type PttEvent,
  type PttState as MachineState,
} from "./voice/pttMachine";

export type VoiceMode = "android_stt" | "server_audio";
export type PttState = "idle" | "listening" | "sending" | "recording";

export interface PushToTalkOpts {
  getWs: () => EyeWs | null;
  getQueue: () => SpeakQueue | null;
  recognizer: DeviceRecognizer;
  /** Active recognition locale (from Settings lang + device support). */
  recogLang: UtteranceLang;
  voiceMode: VoiceMode;
}

export function usePushToTalk(opts: PushToTalkOpts): { pttState: PttState; talk: () => void } {
  const [machine, setMachine] = useState<MachineState>(createPttState);
  const [recording, setRecording] = useState(false);
  const machineRef = useRef(machine);
  machineRef.current = machine;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recordingRef = useRef(false);
  const busyRef = useRef(false);

  const runEffect = useCallback(
    (fx: PttEffect) => {
      const { getWs, getQueue, recognizer, recogLang } = optsRef.current;
      const ws = getWs();
      switch (fx.type) {
        case "listeningStarted":
          getQueue()?.bargeIn();
          ws?.sendListening("start");
          playEarcon("ack");
          setPartial("");
          return;
        case "startListening":
          recognizer.start({ lang: recogLang, partial: true });
          return;
        case "stopListening":
          recognizer.stop();
          return;
        case "sendUtterance":
          ws?.sendUtterance(fx.text, optsRef.current.recogLang, fx.confidence);
          setPartial(fx.text);
          // Heard-transcript caption: shows what the recognizer actually
          // sent, so mistranscriptions are visible instead of mysterious.
          addCaption(`You: ${fx.text}`, "heard");
          dispatch({ type: "sent" });
          return;
        case "thinkingEarcon":
          playEarcon("thinking");
          return;
        case "errorEarcon":
          playEarcon("error");
          setPartial(null);
          return;
        case "listeningStopped":
          ws?.sendListening("stop");
          return;
      }
    },
    // dispatch is stable (defined below via ref); effects read opts via ref.
    []
  );

  const dispatch = useCallback(
    (event: PttEvent) => {
      const { state, effects } = pttTransition(machineRef.current, event, Date.now());
      console.log(
        `[voice] event=${event.type} ${machineRef.current.phase}->${state.phase} fx=${effects.map((f) => f.type).join(",")}`
      );
      machineRef.current = state;
      setMachine(state);
      for (const fx of effects) runEffect(fx);
    },
    [runEffect]
  );

  // Recognizer callbacks drive the machine. Subscribed once; the machine
  // ignores stale events in idle, so late callbacks are harmless.
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;
  const recognizer = opts.recognizer;
  useEffect(() => {
    const unsubs = [
      recognizer.onResult((r) => {
        if (r.final) dispatchRef.current({ type: "final", text: r.text, confidence: r.confidence });
        else {
          setPartial(r.text);
          dispatchRef.current({ type: "partial", text: r.text });
        }
      }),
      recognizer.onError((code) => dispatchRef.current({ type: "error", code })),
      recognizer.onEnd(() => dispatchRef.current({ type: "end" })),
      recognizer.onNoMatch(() => dispatchRef.current({ type: "nomatch" })),
    ];
    return () => {
      for (const u of unsubs) u();
      recognizer.abort();
      dispatchRef.current({ type: "reset" });
    };
  }, [recognizer]);

  // Legacy server_audio path: record m4a, send bytes for server STT.
  const stopAndSendAudio = useCallback(async () => {
    if (!recordingRef.current) {
      setRecording(false);
      return;
    }
    recordingRef.current = false;
    setRecording(false);
    try {
      await recorder.stop();
      const uri = recorder.uri;
      const ws = optsRef.current.getWs();
      if (uri && ws) {
        const base64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        ws.sendAudio(base64, "m4a", RecordingPresets.HIGH_QUALITY.sampleRate);
      }
    } catch {
      // Drop failed utterances; the user can press again.
    }
  }, [recorder]);

  const startAudioRecording = useCallback(async () => {
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) return;
      optsRef.current.getQueue()?.bargeIn();
      optsRef.current.getWs()?.sendListening("start");
      playEarcon("ack");
      await AudioModule.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      recordingRef.current = true;
      setRecording(true);
    } catch {
      recordingRef.current = false;
      setRecording(false);
    }
  }, [recorder]);

  const toggleAudio = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      if (recordingRef.current) {
        await stopAndSendAudio();
        optsRef.current.getWs()?.sendListening("stop");
      } else {
        await startAudioRecording();
      }
    } finally {
      busyRef.current = false;
    }
  }, [startAudioRecording, stopAndSendAudio]);

  // Switching voice modes aborts anything in flight.
  const voiceMode = opts.voiceMode;
  useEffect(() => {
    recognizer.abort();
    dispatchRef.current({ type: "reset" });
    setPartial(null);
    if (recordingRef.current) {
      recordingRef.current = false;
      setRecording(false);
      void recorder.stop().catch(() => undefined);
    }
  }, [voiceMode, recognizer, recorder]);

  const press = useCallback(() => {
    console.log(`[voice] press mode=${optsRef.current.voiceMode} recog=${optsRef.current.recogLang}`);
    if (optsRef.current.voiceMode === "server_audio") void toggleAudio();
    else dispatch({ type: "press" });
  }, [dispatch, toggleAudio]);

  const pressRef = useRef(press);
  pressRef.current = press;
  useEffect(() => {
    showNativeVolumeUI({ enabled: false });
    const sub = addVolumeListener(() => {
      pressRef.current();
    });
    return () => {
      sub.remove();
      showNativeVolumeUI({ enabled: true });
      if (recordingRef.current) {
        recordingRef.current = false;
        void recorder.stop().catch(() => undefined);
      }
    };
  }, [recorder]);

  const pttState: PttState =
    voiceMode === "server_audio" ? (recording ? "recording" : "idle") : machine.phase;
  return { pttState, talk: press };
}
