// Chest-camera frame output (vision-camera v5): the worklet resizes each
// frame to 32x32 RGB, converts to grayscale, and hands 1 KB to the JS-side
// gate. Callers throttle to ~2 fps (see App onGray); capture for upload goes
// through usePhotoOutput, not the frame path.
import { useMemo, useRef } from "react";
import { useFrameOutput, type Frame } from "react-native-vision-camera";
import { runOnJS } from "react-native-worklets";
import { useResizePlugin } from "vision-camera-resize-plugin";
import { GATE_SIZE } from "./gate";

export function useGateOutput(onGray: (gray: Uint8Array) => void) {
  const cbRef = useRef(onGray);
  cbRef.current = onGray;
  const plugin = useResizePlugin();
  const runOnJSGray = useMemo(
    () =>
      runOnJS((gray: Uint8Array) => {
        cbRef.current(gray);
      }),
    []
  );
  return useFrameOutput({
    pixelFormat: "rgb",
    onFrame: (frame: Frame) => {
      "worklet";
      const rgb = plugin.resize(frame, {
        scale: { width: GATE_SIZE, height: GATE_SIZE },
        pixelFormat: "rgb",
        dataType: "uint8",
      });
      const gray = new Uint8Array(GATE_SIZE * GATE_SIZE);
      for (let i = 0; i < gray.length; i++) {
        const r = rgb[i * 3] ?? 0;
        const g = rgb[i * 3 + 1] ?? 0;
        const b = rgb[i * 3 + 2] ?? 0;
        gray[i] = Math.round((r + g + b) / 3);
      }
      runOnJSGray(gray);
      frame.dispose();
    },
  });
}
