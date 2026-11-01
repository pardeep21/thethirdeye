// Enrollment face policy: one clear, frontal face per photo. Strangers
// are never persisted; enrollment stores embeddings only, and only with
// the consent the REST layer already requires.
export const ENROLL_MIN_SIZE_PX = 60;
export const ENROLL_MIN_BLUR = 100;
export const ENROLL_MAX_YAW_DEG = 30;

import type { DetectedFace } from "./embed.js";

/**
 * The single usable face, or the user-facing reason it is rejected.
 * Quality problems name the photo so the helper knows which to retake.
 */
export function checkEnrollFace(faces: DetectedFace[], photoNo: number): { face: DetectedFace } | { error: string } {
  if (faces.length === 0) return { error: `no face found in photo ${photoNo}; please retake it` };
  if (faces.length > 1) {
    return { error: `more than one face in photo ${photoNo}; one person at a time, please` };
  }
  const face = faces[0];
  if (face.quality.sizePx < ENROLL_MIN_SIZE_PX) {
    return { error: `face in photo ${photoNo} is too small; hold the camera closer` };
  }
  if (face.quality.blur < ENROLL_MIN_BLUR) {
    return { error: `photo ${photoNo} is blurry; please retake it` };
  }
  if (face.quality.yawDeg !== null && Math.abs(face.quality.yawDeg) > ENROLL_MAX_YAW_DEG) {
    return { error: `face in photo ${photoNo} is turned away; look at the camera` };
  }
  return { face };
}
