// Earcons: 4 tiny bundled blips played through one shared expo-audio
// player, each paired with a haptic. Fire-and-forget: playback failures
// (missing asset, audio focus) never throw into callers.
import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import * as Haptics from "expo-haptics";
import type { EarconName } from "../../../server/src/protocol";

export type { EarconName };

const SOURCES: Record<EarconName, number> = {
  ack: require("../../assets/earcons/ack.wav"),
  thinking: require("../../assets/earcons/thinking.wav"),
  error: require("../../assets/earcons/error.wav"),
  saved: require("../../assets/earcons/saved.wav"),
};

let player: AudioPlayer | null = null;

function getPlayer(): AudioPlayer {
  if (!player) player = createAudioPlayer(SOURCES.ack);
  return player;
}

export function playEarcon(name: EarconName): void {
  try {
    const p = getPlayer();
    p.replace(SOURCES[name]);
    p.play();
  } catch {
    // Earcons are decoration; never break the voice flow.
  }
  void (async () => {
    try {
      if (name === "error") {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } else if (name === "saved") {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } else {
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    } catch {
      // Haptics unavailable; the blip is enough.
    }
  })();
}
