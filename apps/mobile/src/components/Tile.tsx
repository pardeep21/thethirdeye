// Tile: the design's row/grid buttons (look-around, cash, people).
// One pressable with haptics, full a11y props, and an optional toggle.
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { colors, fonts, radius, space } from "../theme";
import { Icon, type IconName } from "./icons";

export interface TileProps {
  title: string;
  subtitle: string;
  /** Named glyph, or "rupee" for the ₹ disc. */
  icon: IconName | "rupee";
  iconColor?: string;
  /** Dark tile (default) or the look-around-ON cyan card. */
  tone?: "dark" | "second";
  /** Grid tiles use the smaller title + 48px disc. */
  compact?: boolean;
  /** Right-side adornment (the toggle); purely visual. */
  right?: ReactNode;
  selected?: boolean;
  accessibilityLabel: string;
  accessibilityHint?: string;
  onPress(): void;
}

/** 56x32 sliding toggle, visual only (the tile owns the press + state). */
export function Toggle({ on, tone = "dark" }: { on: boolean; tone?: "dark" | "second" }): React.JSX.Element {
  return (
    <View
      aria-hidden={true}
      style={[
        styles.toggleTrack,
        tone === "second" ? styles.toggleTrackSecond : on ? styles.toggleTrackOn : null,
        on ? styles.toggleTrackEnd : null,
      ]}
    >
      <View style={[styles.toggleKnob, tone === "second" ? styles.toggleKnobSecond : on ? styles.toggleKnobOn : null]} />
    </View>
  );
}

export function Tile(props: TileProps): React.JSX.Element {
  const tone = props.tone ?? "dark";
  const on = tone === "second";
  const onPress = (): void => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    props.onPress();
  };
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ selected: props.selected ?? on }}
      style={[styles.tile, on ? styles.tileSecond : null, props.compact === true ? styles.tileCompact : null]}
    >
      <View
        style={[
          styles.disc,
          props.compact === true || on ? styles.discCompact : null,
          on ? styles.discSecond : null,
        ]}
      >
        {props.icon === "rupee" ? (
          <Text style={[styles.rupee, { color: props.iconColor ?? colors.accent }]}>₹</Text>
        ) : (
          <Icon
            name={props.icon}
            size={props.compact === true || on ? 26 : 30}
            color={props.iconColor ?? (on ? colors.second : colors.text)}
            strokeWidth={2}
          />
        )}
      </View>
      <View style={styles.texts}>
        <Text style={[styles.title, props.compact === true ? styles.titleCompact : null, on ? styles.textOnSecond : null]}>
          {props.title}
        </Text>
        <Text
          style={[styles.subtitle, props.compact === true ? styles.subtitleCompact : null, on ? styles.subOnSecond : null]}
        >
          {props.subtitle}
        </Text>
      </View>
      {props.right}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    minHeight: 92,
    borderRadius: radius.xl,
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.line,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  tileSecond: {
    backgroundColor: colors.second,
    borderWidth: 0,
    borderRadius: radius.card,
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  tileCompact: { paddingHorizontal: 14, gap: 12 },
  disc: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.chip,
    alignItems: "center",
    justifyContent: "center",
    flex: 0,
  },
  discCompact: { width: 48, height: 48, borderRadius: 24 },
  discSecond: { backgroundColor: colors.onSecond },
  rupee: { fontSize: 26, fontWeight: "800" },
  texts: { flexDirection: "column", gap: 2, flexGrow: 1, flexShrink: 1 },
  title: { fontSize: 24, fontFamily: fonts.extraBold, color: colors.text },
  titleCompact: { fontSize: 22 },
  subtitle: { fontSize: 15, fontFamily: fonts.regular, color: colors.muted },
  subtitleCompact: { fontSize: 14 },
  textOnSecond: { color: colors.onSecond },
  subOnSecond: { color: colors.onSecond, fontFamily: fonts.semiBold },
  toggleTrack: {
    width: 56,
    height: 32,
    borderRadius: 999,
    backgroundColor: colors.line,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 4,
    flex: 0,
  },
  toggleTrackOn: { backgroundColor: colors.success },
  toggleTrackSecond: { backgroundColor: colors.onSecond },
  toggleTrackEnd: { justifyContent: "flex-end" },
  toggleKnob: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.knob },
  toggleKnobOn: { backgroundColor: colors.bg },
  toggleKnobSecond: { backgroundColor: colors.second },
});
