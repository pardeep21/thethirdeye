// Chest-camera frame processor (vision-camera v4): the worklet runs at ~2 fps,
// resizes each frame to 32x32 RGB, converts to grayscale, and hands 1 KB to
// the JS-side gate. Callers also throttle (see App onGray); capture for
// upload goes through takePhoto, not the frame path.
import { useRef } from "react";
import { runAtTargetFps, useFrameProcessor, type Frame } from "react-native-vision-camera";
import { useRunOnJS } from "react-native-worklets-core";
import { useResizePlugin } from "vision-camera-resize-plugin";
import { GATE_SIZE } from "./gate";

export function useGateFrameProcessor(onGray: (gray: Uint8Array) => void) {
  const cbRef = useRef(onGray);
  cbRef.current = onGray;
  const plugin = useResizePlugin();
  // worklets-core runOnJS cannot marshal TypedArrays: cross the bridge with a
  // plain number[] and convert back here.
  const runOnJSGray = useRunOnJS((arr: number[]) => {
    cbRef.current(Uint8Array.from(arr));
  }, []);
  return useFrameProcessor(
    (frame: Frame) => {
      "worklet";
      runAtTargetFps(2, () => {
        "worklet";
        const rgb = plugin.resize(frame, {
          scale: { width: GATE_SIZE, height: GATE_SIZE },
          pixelFormat: "rgb",
          dataType: "uint8",
        });
        const gray: number[] = new Array(GATE_SIZE * GATE_SIZE);
        for (let i = 0; i < gray.length; i++) {
          const r = rgb[i * 3] ?? 0;
          const g = rgb[i * 3 + 1] ?? 0;
          const b = rgb[i * 3 + 2] ?? 0;
          gray[i] = Math.round((r + g + b) / 3);
        }
        runOnJSGray(gray);
      });
    },
    [plugin, runOnJSGray]
  );
}
