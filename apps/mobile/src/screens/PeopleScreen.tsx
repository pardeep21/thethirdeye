// People screen: add-by-voice guidance, the enrolled list with remove,
// and the fallback helper form. Follows docs/design/People.html; the
// live consent conversation itself lands with prompt 06.
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import { colors, fonts, radius, space } from "../theme";
import { STRINGS } from "../strings";
import { useAppState } from "../store";
import { usePeople } from "../people";
import { Icon } from "../components/icons";

export function PeopleScreen(): React.JSX.Element {
  const app = useAppState();
  const s = STRINGS[app.lang];
  const { people, removePerson } = usePeople(app.serverUrl);
  const [removing, setRemoving] = useState<number | null>(null);

  const back = (): void => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
    app.setScreen("home");
  };
  const remove = (id: number): void => {
    if (removing !== null) return;
    setRemoving(id);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => undefined);
    void removePerson(id).finally(() => {
      setRemoving(null);
      app.refreshPeople();
    });
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable
          onPress={back}
          accessibilityRole="button"
          accessibilityLabel={s.backHome}
          style={styles.backButton}
        >
          <Icon name="back" size={26} color={colors.text} strokeWidth={2.2} />
        </Pressable>
        <View style={styles.headerTexts}>
          <Text style={styles.title}>{s.people}</Text>
          <Text style={styles.subtitle}>{s.consentSubtitle}</Text>
        </View>
      </View>

      <View style={styles.voiceCard}>
        <View style={styles.voiceRow}>
          <View style={styles.voiceDisc}>
            <Icon name="mic" size={24} color={colors.accent} strokeWidth={2} />
          </View>
          <Text style={styles.voiceTitle}>{s.addByVoice}</Text>
        </View>
        <Text style={styles.voiceHint}>{s.addByVoiceHint}</Text>
        <Text style={styles.voiceExample}>{s.voiceExample}</Text>
        <Text style={styles.voiceNote}>{s.consentNote}</Text>
      </View>

      <Text style={styles.sectionHeading}>
        {s.savedHeading} · {people.length}
      </Text>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {people.map((p, i) => (
          <View key={p.id} style={styles.row}>
            <View style={styles.avatar} aria-hidden={true}>
              <Text style={[styles.initial, { color: i % 2 === 0 ? colors.accent : colors.second }]}>
                {(p.name.trim()[0] ?? "?").toUpperCase()}
              </Text>
            </View>
            <View style={styles.rowTexts}>
              <Text style={styles.name}>{p.name}</Text>
              <Text style={styles.rowSub}>
                {p.faces} {s.faceSamples}
              </Text>
            </View>
            <Pressable
              onPress={() => remove(p.id)}
              disabled={removing !== null}
              accessibilityRole="button"
              accessibilityLabel={`${s.removePerson} ${p.name}`}
              style={styles.remove}
            >
              <Icon name="trash" size={22} color={colors.danger} strokeWidth={2.2} />
            </Pressable>
          </View>
        ))}
      </ScrollView>

      <View style={styles.spacer} />
      <Pressable
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
          app.setScreen("peopleEnroll");
        }}
        accessibilityRole="button"
        accessibilityLabel={s.addHelper}
        style={styles.helperButton}
      >
        <Text style={styles.helperText}>{s.addHelper}</Text>
      </Pressable>
      <Text style={styles.privacy}>{s.peoplePrivacy}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xl,
    flexDirection: "column",
    gap: space.lg,
  },
  header: { flexDirection: "row", alignItems: "center", gap: space.md },
  backButton: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
    flex: 0,
  },
  headerTexts: { flexDirection: "column", gap: 2 },
  title: { fontSize: 30, fontFamily: fonts.extraBold, lineHeight: 33, color: colors.text },
  subtitle: { fontSize: 14, fontFamily: fonts.regular, color: colors.muted },
  voiceCard: {
    backgroundColor: colors.accent,
    borderRadius: radius.card,
    padding: 18,
    flexDirection: "column",
    gap: 10,
  },
  voiceRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  voiceDisc: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.onAccent,
    alignItems: "center",
    justifyContent: "center",
    flex: 0,
  },
  voiceTitle: { fontSize: 22, fontFamily: fonts.extraBold, color: colors.onAccent },
  voiceHint: { fontSize: 17, fontFamily: fonts.semiBold, lineHeight: 23, color: colors.onAccent },
  voiceExample: {
    fontSize: 20,
    fontFamily: fonts.extraBold,
    backgroundColor: colors.bubbleShade,
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    color: colors.onAccent,
  },
  voiceNote: { fontSize: 15, fontFamily: fonts.semiBold, color: colors.onAccent },
  sectionHeading: {
    fontSize: 13,
    fontFamily: fonts.semiBold,
    letterSpacing: 0.08 * 13,
    textTransform: "uppercase",
    color: colors.muted,
  },
  list: { flexGrow: 0 },
  listContent: { flexDirection: "column", gap: 10 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: 14,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.chip,
    alignItems: "center",
    justifyContent: "center",
    flex: 0,
  },
  initial: { fontSize: 22, fontFamily: fonts.extraBold },
  rowTexts: { flexDirection: "column", gap: 2, flexGrow: 1, flexShrink: 1 },
  name: { fontSize: 22, fontFamily: fonts.extraBold, color: colors.text },
  rowSub: { fontSize: 14, fontFamily: fonts.regular, color: colors.muted },
  remove: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.chip,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
    flex: 0,
  },
  spacer: { flexGrow: 1 },
  helperButton: {
    height: 64,
    borderRadius: radius.lg,
    backgroundColor: "transparent",
    borderWidth: 2,
    borderColor: colors.lineStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  helperText: { fontSize: 18, fontFamily: fonts.bold, color: colors.text },
  privacy: { fontSize: 14, fontFamily: fonts.regular, color: colors.muted, textAlign: "center", lineHeight: 20 },
});
