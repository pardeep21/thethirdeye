// EyeSmart chest-camera app, M0 skeleton: hidden back camera, 32x32 change
// gate throttled to ~2 fps, 768px JPEG q70 uploads over WS, Android TTS out.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  usePhotoOutput,
} from "react-native-vision-camera";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import { useKeepAwake } from "expo-keep-awake";
import Constants from "expo-constants";
import { createGate, shouldSendGate } from "./gate";
import { useGateOutput } from "./camera";
import { EyeWs } from "./ws";
import { SpeakQueue } from "./speech";
import { DEFAULT_SERVER_URL } from "./config";

/** Min ms between gate evaluations: the frame path runs faster than 2 fps. */
const GATE_TICK_MS = 500;

export default function App() {
  useKeepAwake();
  const device = useCameraDevice("back");
  const { hasPermission, requestPermission } = useCameraPermission();
  const photoOutput = usePhotoOutput();
  const gateRef = useRef(createGate());
  const lastTickRef = useRef(0);
  const uploadingRef = useRef(false);
  const saidNoNetworkRef = useRef(false);
  const wsRef = useRef<EyeWs | null>(null);
  const queue = useMemo(() => new SpeakQueue(), []);
  const [connected, setConnected] = useState(false);
  const [framesSent, setFramesSent] = useState(0);

  useEffect(() => {
    if (!hasPermission) void requestPermission();
  }, [hasPermission, requestPermission]);

  useEffect(() => {
    const ws = new EyeWs(DEFAULT_SERVER_URL, {
      onSpeak: (msg) => queue.enqueue(msg),
      onStatus: (ok) => {
        setConnected(ok);
        if (!ok && !saidNoNetworkRef.current) {
          saidNoNetworkRef.current = true;
          queue.enqueue({ type: "speak", text: "network nahi", lang: "pa", priority: "P1" });
        }
        if (ok) saidNoNetworkRef.current = false;
      },
    });
    wsRef.current = ws;
    ws.connect();
    return () => {
      ws.close();
      wsRef.current = null;
      void queue.shutdown();
    };
  }, [queue]);

  const uploadFrame = useCallback(async () => {
    const ws = wsRef.current;
    if (!ws || uploadingRef.current) return;
    uploadingRef.current = true;
    try {
      const file = await photoOutput.capturePhotoToFile(
        { flashMode: "off", enableShutterSound: false },
        {}
      );
      const small = await manipulateAsync(
        `file://${file.filePath}`,
        [{ resize: { width: 768 } }],
        { compress: 0.7, format: SaveFormat.JPEG, base64: true }
      );
      if (small.base64) {
        ws.sendFrame(small.base64, small.width, small.height);
        setFramesSent((n) => n + 1);
      }
    } catch {
      // Drop failed captures; the gate will send again.
    } finally {
      uploadingRef.current = false;
    }
  }, [photoOutput]);

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

  const frameOutput = useGateOutput(onGray);
  const outputs = useMemo(() => [photoOutput, frameOutput], [photoOutput, frameOutput]);
  const appName = Constants.expoConfig?.name ?? "EyeSmart";

  return (
    <View style={styles.root}>
      {device && hasPermission ? (
        <Camera style={styles.hiddenCamera} device={device} outputs={outputs} isActive={true} />
      ) : null}
      <Text style={styles.title}>{appName}</Text>
      <Text>camera: {device && hasPermission ? "on (hidden, ~2 fps)" : "waiting for permission"}</Text>
      <Text>server: {connected ? "connected" : "disconnected"}</Text>
      <Text>frames sent: {framesSent}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center" },
  hiddenCamera: { position: "absolute", width: 1, height: 1, opacity: 0 },
  title: { fontSize: 20, fontWeight: "bold", marginBottom: 8 },
});
