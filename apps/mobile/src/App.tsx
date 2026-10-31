// TheThirdEye chest-camera app: hidden back camera with a 32x32 change gate,
// 768px JPEG q70 uploads over WS, Android TTS out, volume-key push-to-talk,
// plus settings and face-enrollment screens for a sighted helper.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, StyleSheet, Text, View } from "react-native";
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  type PhotoFile,
} from "react-native-vision-camera";
import { useKeepAwake } from "expo-keep-awake";
import Constants from "expo-constants";
import type { SpeakLang } from "../../server/src/protocol";
import { createGate, shouldSendGate } from "./gate";
import { useGateFrameProcessor } from "./camera";
import { EyeWs } from "./ws";
import { SpeakQueue } from "./speech";
import { captureSmall } from "./capture";
import { usePushToTalk } from "./ptt";
import { SettingsScreen } from "./SettingsScreen";
import { EnrollScreen } from "./EnrollScreen";
import { DEFAULT_SERVER_URL } from "./config";

/** Min ms between gate evaluations: the frame path runs faster than 2 fps. */
const GATE_TICK_MS = 500;

type Screen = "home" | "settings" | "enroll";

export default function App() {
  useKeepAwake();
  const device = useCameraDevice("back");
  const { hasPermission, requestPermission } = useCameraPermission();
  const cameraRef = useRef<Camera>(null);
  const gateRef = useRef(createGate());
  const lastTickRef = useRef(0);
  const uploadingRef = useRef(false);
  const saidNoNetworkRef = useRef(false);
  const wsRef = useRef<EyeWs | null>(null);
  const langRef = useRef<SpeakLang>("pa");
  const [connected, setConnected] = useState(false);
  const [framesSent, setFramesSent] = useState(0);
  const [screen, setScreen] = useState<Screen>("home");
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [lang, setLang] = useState<SpeakLang>("pa");
  const [muted, setMuted] = useState(false);
  const queue = useMemo(() => new SpeakQueue(), []);

  useEffect(() => {
    if (!hasPermission) void requestPermission();
  }, [hasPermission, requestPermission]);

  useEffect(() => {
    langRef.current = lang;
  }, [lang]);

  useEffect(() => {
    const ws = new EyeWs(serverUrl, {
      onSpeak: (msg) => queue.enqueue(msg),
      onStatus: (ok) => {
        setConnected(ok);
        if (ok) {
          saidNoNetworkRef.current = false;
          ws.sendSettings(langRef.current);
        } else if (!saidNoNetworkRef.current) {
          saidNoNetworkRef.current = true;
          queue.enqueue({ type: "speak", text: "network nahi", lang: "pa", priority: "P1" });
        }
      },
    });
    wsRef.current = ws;
    ws.connect();
    return () => {
      ws.close();
      wsRef.current = null;
      void queue.shutdown();
    };
  }, [queue, serverUrl]);

  const { pttState } = usePushToTalk(useCallback(() => wsRef.current, []));

  const takePhoto = useCallback(async (): Promise<PhotoFile | null> => {
    try {
      return (await cameraRef.current?.takePhoto({ flash: "off", enableShutterSound: false })) ?? null;
    } catch {
      return null;
    }
  }, []);

  const uploadFrame = useCallback(async () => {
    const ws = wsRef.current;
    if (!ws || uploadingRef.current) return;
    uploadingRef.current = true;
    try {
      const small = await captureSmall(takePhoto);
      if (small) {
        ws.sendFrame(small.base64, small.width, small.height);
        setFramesSent((n) => n + 1);
      }
    } finally {
      uploadingRef.current = false;
    }
  }, [takePhoto]);

  const onGray = useCallback(
    (gray: Uint8Array) => {
      const now = Date.now();
      if (now - lastTickRef.current < GATE_TICK_MS) return;
      lastTickRef.current = now;
      const { send } = shouldSendGate(gateRef.current, gray, now);
      if (send) void uploadFrame();
    },
    [uploadFrame]
  );

  const frameProcessor = useGateFrameProcessor(onGray);
  const appName = Constants.expoConfig?.name ?? "TheThirdEye";

  const changeLang = useCallback((next: SpeakLang) => {
    setLang(next);
    wsRef.current?.sendSettings(next);
  }, []);

  const changeMuted = useCallback((next: boolean) => {
    setMuted(next);
    wsRef.current?.sendCommand(next ? "mute" : "unmute");
  }, []);

  const cameraVisible = device != null && hasPermission;
  return (
    <View style={styles.root}>
      {device != null && hasPermission ? (
        <Camera
          ref={cameraRef}
          style={screen === "enroll" ? styles.enrollCamera : styles.hiddenCamera}
          device={device}
          photo={true}
          pixelFormat="yuv"
          frameProcessor={frameProcessor}
          isActive={true}
        />
      ) : null}
      {screen === "settings" ? (
        <SettingsScreen
          initialUrl={serverUrl}
          lang={lang}
          muted={muted}
          onSaveUrl={(url) => {
            if (url) setServerUrl(url);
          }}
          onLang={changeLang}
          onMuted={changeMuted}
          onBack={() => setScreen("home")}
        />
      ) : screen === "enroll" ? (
        <EnrollScreen takePhoto={takePhoto} serverUrl={serverUrl} onBack={() => setScreen("home")} />
      ) : (
        <View style={styles.home}>
          <Text style={styles.title}>{appName}</Text>
          <Text>camera: {cameraVisible ? "on (hidden, ~2 fps)" : "waiting for permission"}</Text>
          <Text>server: {connected ? `connected (${serverUrl})` : "disconnected"}</Text>
          <Text>frames sent: {framesSent}</Text>
          <Text>push-to-talk: {pttState} (volume key toggles)</Text>
          <Text>language: {lang} {muted ? "(muted)" : ""}</Text>
          <View style={styles.buttons}>
            <Button title="Settings" onPress={() => setScreen("settings")} />
            <Button title="Enroll faces (helper)" onPress={() => setScreen("enroll")} />
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  home: { flex: 1, alignItems: "center", justifyContent: "center" },
  hiddenCamera: { position: "absolute", width: 1, height: 1, opacity: 0 },
  enrollCamera: { width: "100%", height: 240 },
  title: { fontSize: 20, fontWeight: "bold", marginBottom: 8 },
  buttons: { marginTop: 16, gap: 8 },
});
