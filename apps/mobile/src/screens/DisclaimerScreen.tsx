// Honesty statement screen (prompt 08): full MANIFEST section 6 text in
// English + Punjabi (Roman). First launch shows it with an "I understand"
// button; Settings -> About re-shows it with a back button. All colours
// come from theme tokens (the hex-ban test enforces this).
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { colors, fonts, radius, space } from "../theme";
import { DISCLAIMER_EN, DISCLAIMER_PA } from "../disclaimer";

export interface DisclaimerScreenProps {
  title: string;
  /** "I understand" on first launch; Back when re-shown from About. */
  doneLabel: string;
  backLabel: string;
  mode: "first" | "about";
  onDone(): void;
}

export function DisclaimerScreen(props: DisclaimerScreenProps): React.JSX.Element {
  const onPress = (): void => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    props.onDone();
  };
  return (
    <View style={styles.root}>
      <Text style={styles.title}>{props.title}</Text>
      <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
        <Text style={styles.statement} accessibilityRole="text">
          {DISCLAIMER_EN}
        </Text>
        <Text style={styles.statement} accessibilityRole="text">
          {DISCLAIMER_PA}
        </Text>
      </ScrollView>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={props.mode === "first" ? props.doneLabel : props.backLabel}
        accessibilityHint={
          props.mode === "first" ? "Accept and open the app" : "Back to settings"
        }
        style={styles.button}
      >
        <Text style={styles.buttonText}>
          {props.mode === "first" ? props.doneLabel : props.backLabel}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, padding: space.lg, gap: space.md },
  title: { fontSize: 28, fontFamily: fonts.extraBold, color: colors.text },
  body: { flex: 1 },
  bodyContent: { gap: space.lg, paddingBottom: space.md },
  statement: { fontSize: 20, lineHeight: 30, fontFamily: fonts.regular, color: colors.text },
  button: {
    minHeight: 120,
    borderRadius: radius.lg,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.lg,
  },
  buttonText: {
    fontSize: 28,
    fontFamily: fonts.extraBold,
    color: colors.onAccent,
    textAlign: "center",
  },
});
