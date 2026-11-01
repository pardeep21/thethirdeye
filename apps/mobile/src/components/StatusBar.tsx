// Home header: app title, connection dot + status line, optional camera
// preview slot, and the settings gear. Matches Main.html exactly.
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { colors, fonts, radius, space } from "../theme";
import { Icon } from "./icons";

export interface StatusBarProps {
  connected: boolean;
  /** Second status line, e.g. "Connected · last answer 1.8 s". */
  statusText: string;
  /** Small camera preview when the "show camera" setting is on. */
  preview?: ReactNode;
  settingsLabel: string;
  onSettings(): void;
}

export function StatusBar(props: StatusBarProps): React.JSX.Element {
  const onSettings = (): void => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    props.onSettings();
  };
  return (
    <View style={styles.row}>
      <View style={styles.left}>
        <Text style={styles.title}>TheThirdEye</Text>
        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: props.connected ? colors.success : colors.danger }]} />
          <Text style={styles.statusText}>{props.statusText}</Text>
        </View>
      </View>
      <View style={styles.right}>
        {props.preview}
        <Pressable
          onPress={onSettings}
          accessibilityRole="button"
          accessibilityLabel={props.settingsLabel}
          accessibilityHint="Opens server, language and camera settings"
          style={styles.gear}
        >
          <Icon name="gear" size={26} color={colors.text} strokeWidth={2} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.md },
  left: { flexDirection: "column", gap: space.xs, flexShrink: 1 },
  title: { fontSize: 17, fontFamily: fonts.extraBold, letterSpacing: 0.02 * 17, color: colors.text },
  statusRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  dot: { width: 10, height: 10, borderRadius: 5 },
  statusText: { fontSize: 14, fontFamily: fonts.regular, color: colors.muted },
  right: { flexDirection: "row", gap: space.sm, alignItems: "center" },
  gear: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
  },
});
