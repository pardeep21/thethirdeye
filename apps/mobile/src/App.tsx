// TheThirdEye chest-camera app: hidden back camera with a 32x32 change gate,
// 768px JPEG q70 uploads over WS, Android TTS out, volume-key/Talk push-to-
// talk over on-device speech recognition, and the home/people/settings
// screens for the helper. Look-around switches to the ultra-wide lens with
// a 2 s heartbeat; the server side of the mode switch lands in prompt 03.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Platform, StyleSheet, Text, View, StatusBar as SystemStatusBar, type StyleProp, type ViewStyle } from "react-native";
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  type PhotoFile,
} from "react-native-vision-camera";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { useFonts } from "expo-font";
import Constants from "expo-constants";
import type {
  LensId,
  SpeakLang,
  SpokenScript,
  StateMessage,
  UtteranceLang,
} from "../../server/src/protocol";
import { createGate, shouldSendGate } from "./gate";
import { resolveHfov, useGateFrameProcessor } from "./camera";
import { LENS_SETTLE_MS, resolveCaptureLens } from "./cameraLens";
import { EyeWs } from "./ws";
import { SpeakQueue } from "./speech";
import { captureSmall } from "./capture";
import { httpJson, wsToHttp } from "./http";
import { usePushToTalk, type VoiceMode } from "./ptt";
import { HomeScreen } from "./screens/HomeScreen";
import { PeopleScreen } from "./screens/PeopleScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { DisclaimerScreen } from "./screens/DisclaimerScreen";
import { EnrollScreen } from "./EnrollScreen";
import { AppStateContext, type Screen } from "./store";
import { DEFAULT_APP_TOKEN, DEFAULT_SERVER_URL } from "./config";
import { acceptDisclaimer, isDisclaimerAccepted } from "./disclaimer";
import { ExpoRecognizer } from "./voice/recognizer";
import { pickRecognitionLocale } from "./voice/locale";
import { playEarcon } from "./voice/earcons";
import { addCaption, useCaptions, usePartial } from "./voice/captions";
import { GREETING, NO_NETWORK, STRINGS } from "./strings";
import { colors } from "./theme";

/** Min ms between gate evaluations: the frame path runs faster than 2 fps. */
const GATE_TICK_MS = 500;
/** Gate heartbeat while look-around is on (DEV-PLAN: faster heartbeat). */
const LOOK_HEARTBEAT_MS = 2000;
/** Cash-tile tap reuses the howmuch fast path through a text utterance. */
const CASH_READ_TEXT = "eh kinne da";

export default function App() {
  const mainDevice = useCameraDevice("back");
  const { hasPermission, requestPermission } = useCameraPermission();
  const cameraRef = useRef<Camera>(null);
  const gateRef = useRef(createGate());
  const lastTickRef = useRef(0);
  const uploadingRef = useRef(false);
  const saidNoNetworkRef = useRef(false);
  const greetedRef = useRef(false);
  const utteranceTsRef = useRef<number | null>(null);
  const wsRef = useRef<EyeWs | null>(null);
  const langRef = useRef<SpeakLang>("pa");
  const scriptRef = useRef<SpokenScript>("gurmukhi");
  const [connected, setConnected] = useState(false);
  const [screen, setScreen] = useState<Screen>("home");
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [appToken, setAppToken] = useState(DEFAULT_APP_TOKEN);
  const [authFailed, setAuthFailed] = useState(false);
  // First-launch honesty gate: null while the flag file is being read.
  const [disclaimer, setDisclaimer] = useState<boolean | null>(null);
  const disclaimerSpokenRef = useRef(false);
  // Foreground tracking: the camera stops when the app backgrounds.
  const [appActive, setAppActive] = useState(true);
  const [lang, setLang] = useState<SpeakLang>("pa");
  const [script, setScript] = useState<SpokenScript>("gurmukhi");
  const [muted, setMuted] = useState(false);
  const [voiceMode, setVoiceMode] = useState<VoiceMode>("android_stt");
  const [recogLocale, setRecogLocale] = useState<UtteranceLang>("pa-IN");
  const [serverState, setServerState] = useState<StateMessage | null>(null);
  const [lookAround, setLookAround] = useState(false);
  // One-shot capture lens for capture_now (reads ask for main): the zoom
  // prop follows this while set, then returns to the toggle. Ref mirror
  // for the upload path; overlapping captures agree on the active lens.
  const [lensOverride, setLensOverride] = useState<LensId | null>(null);
  const lensOverrideRef = useRef<LensId | null>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [ttsRate, setTtsRate] = useState(1);
  const [hfovOverride, setHfovOverride] = useState<number | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [lastCash, setLastCash] = useState<{ text: string; at: number } | null>(null);
  const [lastAnswerMs, setLastAnswerMs] = useState<number | null>(null);
  const [peopleCount, setPeopleCount] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const queue = useMemo(() => new SpeakQueue(), []);
  const recognizer = useMemo(() => new ExpoRecognizer(), []);
  const captions = useCaptions();
  const partial = usePartial();

  const [fontsLoaded] = useFonts({
    "Atkinson-Regular": require("../assets/fonts/Atkinson-Regular.ttf"),
    "Atkinson-SemiBold": require("../assets/fonts/Atkinson-SemiBold.ttf"),
    "Atkinson-Bold": require("../assets/fonts/Atkinson-Bold.ttf"),
    "Atkinson-ExtraBold": require("../assets/fonts/Atkinson-ExtraBold.ttf"),
    "Gurmukhi-Medium": require("../assets/fonts/Gurmukhi-Medium.ttf"),
    "Gurmukhi-Bold": require("../assets/fonts/Gurmukhi-Bold.ttf"),
  });
  // Gate first render on the design fonts: measuring text with the system
  // font and swapping families later leaves wrongly-sized views (clipped
  // text) on Android. The splash theme shows until the first frame.
  void fontsLoaded;

  // Lens follows the toggle. v4 exposes one logical back camera on this
  // phone (S23: id 0 covers wide + UW + tele); the ultra-wide end is
  // selected with minZoom (0.6x), wide with neutralZoom (1x).
  const lens: LensId = lookAround ? "ultrawide" : "main";
  const device = mainDevice;
  const lookRef = useRef(lookAround);
  lookRef.current = lookAround;
  const captureForAgentRef = useRef<(reqId: string, lens?: LensId) => Promise<void>>(async () => {});
  const hfovRef = useRef(hfovOverride);
  hfovRef.current = hfovOverride;
  const recogRef = useRef(recogLocale);
  recogRef.current = recogLocale;

  useEffect(() => {
    if (!hasPermission) void requestPermission();
  }, [hasPermission, requestPermission]);

  useEffect(() => {
    langRef.current = lang;
  }, [lang]);
  useEffect(() => {
    scriptRef.current = script;
  }, [script]);

  useEffect(() => {
    queue.setRate(ttsRate);
  }, [queue, ttsRate]);

  useEffect(() => {
    const unsub = queue.onSpeakingChange(setSpeaking);
    return unsub;
  }, [queue]);

  // Ticking clock so caption relative times stay fresh.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  // Recognition locale: Settings language mapped to BCP-47, falling back
  // through pa/hi/en when the device lacks support. Logged on startup.
  useEffect(() => {
    let cancelled = false;
    void recognizer.supportedLocales().then((supported) => {
      if (cancelled) return;
      console.log(`speech recognition locales: ${supported.join(", ") || "(none reported)"}`);
      setRecogLocale(pickRecognitionLocale(lang, supported));
    });
    return () => {
      cancelled = true;
    };
  }, [recognizer, lang]);

  const refreshPeople = useCallback(async () => {
    try {
      const res = await httpJson(`${wsToHttp(serverUrl)}/people`);
      if (res.status === 200 && Array.isArray(res.json)) setPeopleCount(res.json.length);
    } catch {
      // Count is best-effort; the People screen shows the real list.
    }
  }, [serverUrl]);

  useEffect(() => {
    const ws = new EyeWs(
      serverUrl,
      {
        onSpeak: (msg) => {
          queue.enqueue(msg);
          addCaption(msg.text, msg.kind ?? null);
          if (msg.kind === "cash") setLastCash({ text: msg.text, at: Date.now() });
          if (msg.kind === "answer" && utteranceTsRef.current !== null) {
            setLastAnswerMs(Date.now() - utteranceTsRef.current);
            utteranceTsRef.current = null;
          }
        },
        onEarcon: (msg) => playEarcon(msg.name),
        onCaptureNow: (msg) => {
          void captureForAgentRef.current(msg.reqId, msg.lens);
        },
        // The server is the source of truth for look-around: the tile sends
        // mode up, and agent/bas-driven changes come back down through state.
        onState: (msg) => {
          setServerState(msg);
          setLookAround(msg.lookAround);
        },
        onUtteranceSent: (ts) => {
          utteranceTsRef.current = ts;
        },
        onAuthFailure: () => {
          if (wsRef.current !== ws) return;
          setAuthFailed(true);
        },
        onStatus: (ok) => {
          // Ignore events from a previous URL's socket: its async close
          // would otherwise speak "network nahi" right after a reconnect.
          if (wsRef.current !== ws) return;
          setConnected(ok);
          if (ok) {
            setAuthFailed(false);
            saidNoNetworkRef.current = false;
            ws.sendSettings(langRef.current, scriptRef.current);
            if (lookRef.current) ws.sendMode(true);
            void refreshPeople();
            if (!greetedRef.current) {
              greetedRef.current = true;
              const greeting = GREETING[scriptRef.current];
              queue.enqueue({ type: "speak", text: greeting, lang: langRef.current, priority: "P1", kind: "system" });
              addCaption(greeting, "system");
            } else {
              playEarcon("ack");
            }
          } else if (!saidNoNetworkRef.current) {
            saidNoNetworkRef.current = true;
            queue.enqueue({ type: "speak", text: NO_NETWORK[langRef.current], lang: langRef.current, priority: "P1" });
          }
        },
      },
      {
        appVersion: Constants.expoConfig?.version ?? "dev",
        device: Constants.deviceName ?? "android",
        ...(appToken ? { token: appToken } : {}),
      }
    );
    wsRef.current = ws;
    ws.connect();
    return () => {
      ws.close();
      wsRef.current = null;
      void queue.shutdown();
    };
  }, [queue, serverUrl, appToken, refreshPeople]);

  const queueRef = useRef(queue);
  queueRef.current = queue;
  const { pttState, talk } = usePushToTalk({
    getWs: useCallback(() => wsRef.current, []),
    getQueue: useCallback(() => queueRef.current, []),
    recognizer,
    recogLang: recogLocale,
    voiceMode,
  });

  const takePhoto = useCallback(async (): Promise<PhotoFile | null> => {
    try {
      return (await cameraRef.current?.takePhoto({ flash: "off", enableShutterSound: false })) ?? null;
    } catch {
      return null;
    }
  }, []);

  const uploadFrame = useCallback(
    async (reqId?: string) => {
      const ws = wsRef.current;
      // capture_now requests bypass the gate's in-flight guard: the agent
      // asked for a fresh frame and waits on this reqId.
      if (!ws || (reqId === undefined && uploadingRef.current)) return;
      uploadingRef.current = true;
      try {
        const small = await captureSmall(takePhoto);
        if (small) {
          const activeLens: LensId =
            lensOverrideRef.current ?? (lookRef.current ? "ultrawide" : "main");
          ws.sendFrame(small.base64, {
            width: small.width,
            height: small.height,
            lens: activeLens,
            hfovDeg: hfovRef.current ?? resolveHfov(activeLens),
            ...(reqId !== undefined ? { reqId } : {}),
          });
        }
      } finally {
        uploadingRef.current = false;
      }
    },
    [takePhoto]
  );
  const uploadFrameRef = useRef(uploadFrame);
  uploadFrameRef.current = uploadFrame;

  // Agent capture with a one-shot lens: switch zoom, settle, capture,
  // restore. If the 800 ms server window is missed the server falls back
  // to its last frame; overlapping captures share the active override.
  const captureForAgent = useCallback(async (reqId: string, requested?: LensId) => {
    const current: LensId =
      lensOverrideRef.current ?? (lookRef.current ? "ultrawide" : "main");
    const { lens, switched } = resolveCaptureLens(requested, current);
    if (!switched) {
      await uploadFrameRef.current(reqId);
      return;
    }
    lensOverrideRef.current = lens;
    setLensOverride(lens);
    try {
      await new Promise((r) => setTimeout(r, LENS_SETTLE_MS));
      await uploadFrameRef.current(reqId);
    } finally {
      lensOverrideRef.current = null;
      setLensOverride(null);
    }
  }, []);
  captureForAgentRef.current = captureForAgent;

  const onGray = useCallback(
    (gray: Uint8Array) => {
      const nowMs = Date.now();
      if (nowMs - lastTickRef.current < GATE_TICK_MS) return;
      lastTickRef.current = nowMs;
      const heartbeat = lookRef.current ? LOOK_HEARTBEAT_MS : undefined;
      const { send } = shouldSendGate(gateRef.current, gray, nowMs, heartbeat);
      if (send) void uploadFrame();
    },
    [uploadFrame]
  );

  const frameProcessor = useGateFrameProcessor(onGray);

  const changeLang = useCallback((next: SpeakLang) => {
    setLang(next);
    wsRef.current?.sendSettings(next, scriptRef.current);
  }, []);

  const changeScript = useCallback((next: SpokenScript) => {
    setScript(next);
    wsRef.current?.sendSettings(langRef.current, next);
  }, []);

  const changeMuted = useCallback((next: boolean) => {
    setMuted(next);
    wsRef.current?.sendCommand(next ? "mute" : "unmute");
  }, []);

  const toggleLookAround = useCallback(() => {
    setLookAround((was) => {
      wsRef.current?.sendMode(!was);
      return !was;
    });
  }, []);

  const cashRead = useCallback(() => {
    wsRef.current?.sendUtterance(CASH_READ_TEXT, recogRef.current);
  }, []);

  const saveUrl = useCallback((url: string) => {
    if (url) setServerUrl(url);
  }, []);

  const saveToken = useCallback((token: string) => {
    setAuthFailed(false);
    setAppToken(token);
  }, []);

  const cameraVisible = device != null && hasPermission;
  const showPreview = cameraVisible && showCamera && screen === "home";
  const renderCamera = (style: StyleProp<ViewStyle>): React.JSX.Element | null => {
    if (device == null) return null;
    return (
      <Camera
        ref={cameraRef}
        device={device}
        photo={true}
        pixelFormat="yuv"
        frameProcessor={frameProcessor}
        isActive={appActive}
        zoom={(lensOverride ?? lens) === "ultrawide" ? device.minZoom : device.neutralZoom}
        style={style}
      />
    );
  };

  // Battery: the camera (2 fps gate) runs only in the foreground, and
  // keep-awake is held only while the camera runs. Backgrounding stops
  // frames; the socket stays up and the heartbeat resumes on return.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      setAppActive(state === "active");
    });
    return () => sub.remove();
  }, []);

  const cameraRuns = appActive && cameraVisible;
  useEffect(() => {
    if (cameraRuns) {
      void activateKeepAwakeAsync().catch(() => undefined);
    } else {
      void deactivateKeepAwake().catch(() => undefined);
    }
  }, [cameraRuns]);

  // First-launch honesty gate.
  useEffect(() => {
    void isDisclaimerAccepted().then(setDisclaimer);
  }, []);
  useEffect(() => {
    if (disclaimer === false && !disclaimerSpokenRef.current) {
      disclaimerSpokenRef.current = true;
      queue.enqueue({
        type: "speak",
        id: "disclaimer",
        text: STRINGS[langRef.current].disclaimerSpoken,
        lang: langRef.current,
        priority: "P1",
        kind: "system",
      });
    }
  }, [disclaimer, queue]);

  if (!fontsLoaded) return null;

  if (disclaimer === null) {
    return (
      <View style={styles.splash}>
        <SystemStatusBar barStyle="light-content" />
        <Text style={styles.splashText}>TheThirdEye</Text>
      </View>
    );
  }

  if (disclaimer === false) {
    return (
      <View style={styles.root}>
        <SystemStatusBar barStyle="light-content" />
        <DisclaimerScreen
          title={STRINGS[lang].disclaimerTitle}
          doneLabel={STRINGS[lang].iUnderstand}
          backLabel={STRINGS[lang].backHome}
          mode="first"
          onDone={() => {
            void acceptDisclaimer().then(() => setDisclaimer(true));
          }}
        />
      </View>
    );
  }

  return (
    <AppStateContext.Provider
      value={{
        screen,
        setScreen,
        connected,
        serverUrl,
        saveUrl,
        appToken,
        saveToken,
        authFailed,
        serverState,
        pttState,
        talk,
        partial,
        speaking,
        captions,
        lastCash,
        lastAnswerMs,
        peopleCount,
        refreshPeople: () => void refreshPeople(),
        now,
        lang,
        changeLang,
        script,
        changeScript,
        muted,
        changeMuted,
        voiceMode,
        changeVoiceMode: setVoiceMode,
        recogLocale,
        showCamera,
        changeShowCamera: setShowCamera,
        ttsRate,
        changeTtsRate: setTtsRate,
        hfovOverride,
        changeHfov: setHfovOverride,
        lookAround,
        toggleLookAround,
        cashRead,
      }}
    >
      <View style={styles.root}>
        <SystemStatusBar barStyle="light-content" />
        {cameraVisible && screen === "peopleEnroll" ? renderCamera(styles.enrollCamera) : null}
        {cameraVisible && screen !== "peopleEnroll" && !showPreview ? renderCamera(styles.hiddenCamera) : null}
        {screen === "about" ? (
          <DisclaimerScreen
            title={STRINGS[lang].about}
            doneLabel={STRINGS[lang].iUnderstand}
            backLabel={STRINGS[lang].backHome}
            mode="about"
            onDone={() => setScreen("settings")}
          />
        ) : screen === "settings" ? (
          <SettingsScreen />
        ) : screen === "people" ? (
          <PeopleScreen />
        ) : screen === "peopleEnroll" ? (
          <EnrollScreen takePhoto={takePhoto} serverUrl={serverUrl} onBack={() => setScreen("people")} />
        ) : (
          <HomeScreen
            preview={
              showPreview ? <View style={styles.previewWrap}>{renderCamera(styles.preview)}</View> : undefined
            }
          />
        )}
      </View>
    </AppStateContext.Provider>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    // Edge-to-edge (Android 15+): start below the status bar so the header
    // never slides under the clock/antennas. Covers every screen at once.
    paddingTop: Platform.OS === "android" ? (SystemStatusBar.currentHeight ?? 0) : 0,
  },
  splash: { flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" },
  splashText: { fontSize: 30, color: colors.text },
  hiddenCamera: { position: "absolute", width: 1, height: 1, opacity: 0 },
  enrollCamera: { width: "100%", height: 240, flex: 0 },
  previewWrap: {
    width: 84,
    height: 52,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: colors.chip,
    borderWidth: 1,
    borderColor: colors.line,
  },
  preview: { width: "100%", height: "100%" },
});
