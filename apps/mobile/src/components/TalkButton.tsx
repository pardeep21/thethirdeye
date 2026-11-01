// TalkButton: the hero tile. idle (228px) / listening (360px, pulsing
// rings + live partial) / thinking (spinner) / speaking (bars, 200px),
// plus the compact horizontal variant while look-around is on.
import { useEffect, useRef } from "react";
import { AccessibilityInfo, ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { colors, fonts, radius } from "../theme";
import { Icon } from "./icons";
import type { Strings } from "../strings";

export type TalkVisual = "idle" | "listening" | "thinking" | "speaking";

export interface TalkButtonProps {
  visual: TalkVisual;
  /** Live partial transcript while listening ("" while waiting for words). */
  partial: string | null;
  compact: boolean;
  s: Strings;
  accessibilityLabel: string;
  accessibilityHint: string;
  onPress(): void;
}

const BARS = [28, 52, 72, 44, 60, 32, 20];

function usePulse(active: boolean): { scale: Animated.Value; opacity: Animated.Value } {
  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!active) {
      scale.setValue(1);
      opacity.setValue(1);
      return;
    }
    let stopped = false;
    let loop: Animated.CompositeAnimation | null = null;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduced) => {
      if (stopped || reduced === true) return;
      loop = Animated.loop(
        Animated.parallel([
          Animated.sequence([
            Animated.timing(scale, { toValue: 1.06, duration: 700, useNativeDriver: true }),
            Animated.timing(scale, { toValue: 1, duration: 700, useNativeDriver: true }),
          ]),
          Animated.sequence([
            Animated.timing(opacity, { toValue: 0.55, duration: 700, useNativeDriver: true }),
            Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
          ]),
        ])
      );
      loop.start();
    });
    return () => {
      stopped = true;
      loop?.stop();
    };
  }, [active, scale, opacity]);
  return { scale, opacity };
}

function MicDisc({ size, icon }: { size: number; icon: number }): React.JSX.Element {
  return (
    <View style={[styles.disc, { width: size, height: size, borderRadius: size / 2 }]}>
      <Icon name="mic" size={icon} color={colors.accent} strokeWidth={2} />
    </View>
  );
}

export function TalkButton(props: TalkButtonProps): React.JSX.Element {
  const { scale, opacity } = usePulse(props.visual === "listening");
  const onPress = (): void => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
    props.onPress();
  };
  const busy = props.visual === "listening" || props.visual === "thinking";

  let body: React.JSX.Element;
  if (props.visual === "listening") {
    body = (
      <>
        <Animated.View style={[styles.rings, { transform: [{ scale }], opacity }]}>
          <View style={styles.ringOuter} />
          <View style={styles.ringInner} />
          <MicDisc size={96} icon={46} />
        </Animated.View>
        <Text style={styles.listenTitle}>{props.s.listeningTitle}</Text>
        <Text style={styles.partial} numberOfLines={2}>
          {props.partial ? `“${props.partial}”` : "…"}
        </Text>
        <Text style={styles.hint}>{props.s.pressAgainToSend}</Text>
      </>
    );
  } else if (props.visual === "thinking") {
    body = (
      <>
        <ActivityIndicator size={72} color={colors.onAccent} />
        <Text style={styles.heroTitle}>{props.s.thinkingTitle}</Text>
      </>
    );
  } else if (props.visual === "speaking") {
    body = (
      <>
        <View style={styles.bars} aria-hidden={true}>
          {BARS.map((h, i) => (
            <View key={i} style={[styles.bar, { height: h }]} />
          ))}
        </View>
        <Text style={styles.speakTitle}>{props.s.speakingTitle}</Text>
        <Text style={styles.hint}>{props.s.tapToInterrupt}</Text>
      </>
    );
  } else if (props.compact) {
    body = (
      <>
        <MicDisc size={84} icon={40} />
        <View style={styles.compactTexts}>
          <Text style={styles.compactTitle}>{props.s.talkTitle}</Text>
          <Text style={styles.compactSub}>{props.s.talkHintVolume}</Text>
        </View>
      </>
    );
  } else {
    body = (
      <>
        <MicDisc size={96} icon={46} />
        <Text style={styles.heroTitle}>{props.s.talkTitle}</Text>
        <Text style={styles.heroSub}>{props.s.talkHintVolume}</Text>
      </>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ busy }}
      style={[
        styles.tile,
        props.visual === "listening"
          ? styles.tileListening
          : props.visual === "speaking"
            ? styles.tileSpeaking
            : props.compact && props.visual === "idle"
              ? styles.tileCompact
              : null,
      ]}
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    height: 228,
    borderRadius: radius.hero,
    backgroundColor: colors.accent,
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    flex: 0,
  },
  tileListening: { height: 360, gap: 16, padding: 20 },
  tileSpeaking: { height: 200, gap: 14 },
  tileCompact: { height: 150, flexDirection: "row", gap: 18, paddingHorizontal: 20, justifyContent: "flex-start" },
  disc: { backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" },
  heroTitle: { fontSize: 34, fontFamily: fonts.extraBold, color: colors.onAccent },
  heroSub: { fontSize: 16, fontFamily: fonts.semiBold, color: colors.onAccent },
  compactTexts: { flexDirection: "column", gap: 4 },
  compactTitle: { fontSize: 32, fontFamily: fonts.extraBold, color: colors.onAccent },
  compactSub: { fontSize: 15, fontFamily: fonts.semiBold, color: colors.onAccent },
  rings: { width: 168, height: 168, alignItems: "center", justifyContent: "center" },
  ringOuter: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    borderRadius: 84,
    borderWidth: 3,
    borderColor: colors.ringOuter,
  },
  ringInner: {
    position: "absolute",
    left: 18,
    right: 18,
    top: 18,
    bottom: 18,
    borderRadius: 66,
    borderWidth: 3,
    borderColor: colors.ringInner,
  },
  listenTitle: { fontSize: 32, fontFamily: fonts.extraBold, color: colors.onAccent },
  partial: {
    fontSize: 21,
    fontFamily: fonts.semiBold,
    lineHeight: 27,
    textAlign: "center",
    backgroundColor: colors.bubbleShade,
    borderRadius: radius.md,
    paddingVertical: 10,
    paddingHorizontal: 14,
    width: "100%",
    color: colors.onAccent,
  },
  hint: { fontSize: 15, fontFamily: fonts.semiBold, color: colors.onAccent },
  bars: { flexDirection: "row", alignItems: "center", gap: 7, height: 72 },
  bar: { width: 10, borderRadius: 6, backgroundColor: colors.onAccent },
  speakTitle: { fontSize: 30, fontFamily: fonts.extraBold, color: colors.onAccent },
});
