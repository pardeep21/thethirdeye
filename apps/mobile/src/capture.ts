// Shared photo capture: full-res photo -> 768px JPEG q70 base64.
// Used by the frame uploader and the enrollment screen.
import type { PhotoFile } from "react-native-vision-camera";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";

export type TakePhotoFn = () => Promise<PhotoFile | null>;

export interface SmallPhoto {
  base64: string;
  width: number;
  height: number;
}

export async function captureSmall(takePhoto: TakePhotoFn): Promise<SmallPhoto | null> {
  try {
    const file = await takePhoto();
    if (!file) return null;
    const small = await manipulateAsync(
      `file://${file.path}`,
      [{ resize: { width: 768 } }],
      { compress: 0.7, format: SaveFormat.JPEG, base64: true }
    );
    if (!small.base64) return null;
    return { base64: small.base64, width: small.width, height: small.height };
  } catch {
    return null;
  }
}
