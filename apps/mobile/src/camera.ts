// Chest-camera frame output (vision-camera v5): streams YUV frames, takes the
// Y plane (already grayscale), downsamples it to 32x32, and hands 1 KB to the
// JS-side gate. Callers throttle to ~2 fps (see App onGray); capture for
// upload goes through usePhotoOutput, not the frame path.
import { useMemo, useRef } from "react";
import { useFrameOutput, type Frame } from "react-native-vision-camera";
import { runOnJS } from "react-native-worklets";
import { downsampleGrayPlane } from "./gate";

export function useGateOutput(onGray: (gray: Uint8Array) => void) {
  const cbRef = useRef(onGray);
  cbRef.current = onGray;
  const runOnJSGray = useMemo(
    () =>
      runOnJS((gray: Uint8Array) => {
        cbRef.current(gray);
      }),
    []
  );
  return useFrameOutput({
    pixelFormat: "yuv",
    onFrame: (frame: Frame) => {
      "worklet";
      if (!frame.isValid || !frame.isPlanar) {
        frame.dispose();
        return;
      }
      const planes = frame.getPlanes();
      if (planes.length === 0) {
        frame.dispose();
        return;
      }
      const y = planes[0];
      if (!y.isValid) {
        frame.dispose();
        return;
      }
      const src = new Uint8Array(y.getPixelBuffer());
      const gray = downsampleGrayPlane(src, y.width, y.height, y.bytesPerRow);
      runOnJSGray(gray);
      frame.dispose();
    },
  });
}
