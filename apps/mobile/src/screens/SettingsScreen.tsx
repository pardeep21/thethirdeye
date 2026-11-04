// Settings screen, restyled to the design language: server URL,
// answer language + script, voice mode, mute, camera preview, TTS rate,
// HFOV override. Reads everything from the app store (no props).
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as Haptics from "expo-haptics";
import type { SpeakLang, SpokenScript } from "../../../server/src/protocol";
import { colors, fonts, radius, space } from "../theme";
import { STRINGS } from "../strings";
import { useAppState } from "../store";
import type { VoiceMode } from "../ptt";
import { Icon } from "../components/icons";
import { Toggle } from "../components/Tile";

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionHeading}>{title.toUpperCase()}</Text>
      {children}
    </View>
  );
}

function OptionRow<T extends string | number>({
  label,
  selected,
  onPress,
  hint,
}: {
  label: string;
  selected: boolean;
  hint: string;
  onPress(): void;
}): React.JSX.Element {
  return (
    <Pressable
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
        onPress();
      }}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ selected }}
      style={({ pressed }) => [styles.option, selected ? styles.optionSelected : null, pressed ? styles.pressed : null]}
    >
      <Text style={[styles.optionText, selected ? styles.optionTextSelected : null]}>{label}</Text>
    </Pressable>
  );
}

const TTS_RATES = [0.75, 1, 1.25];
const HFOVS: Array<{ label: string; value: number | null }> = [
  { label: "Auto", value: null },
  { label: "66°", value: 66 },
  { label: "100°", value: 100 },
];
const SCRIPTS: Array<{ id: SpokenScript; label: string }> = [
  { id: "gurmukhi", label: "Gurmukhi" },
  { id: "devanagari", label: "Devanagari" },
  { id: "latin", label: "Latin" },
];

export function SettingsScreen(): React.JSX.Element {
  const app = useAppState();
  const s = STRINGS[app.lang];
  const [url, setUrl] = useState(app.serverUrl);
  const [token, setToken] = useState(app.appToken);
  // True after a save press until the fields are edited again; drives the
  // confirmation line, which then tracks the live connection state.
  const [saved, setSaved] = useState(false);

  const langs: Array<{ id: SpeakLang; label: string }> = [
    { id: "pa", label: s.langPa },
    { id: "hi", label: s.langHi },
    { id: "en", label: s.langEn },
  ];
  const modes: Array<{ id: VoiceMode; label: string }> = [
    { id: "android_stt", label: s.onDeviceStt },
    { id: "server_audio", label: s.serverAudio },
  ];

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable
          onPress={() => app.setScreen("home")}
          accessibilityRole="button"
          accessibilityLabel={s.backHome}
          style={({ pressed }) => [styles.backButton, pressed ? styles.pressed : null]}
        >
          <Icon name="back" size={26} color={colors.text} strokeWidth={2.2} />
        </Pressable>
        <Text style={styles.title}>{s.settings}</Text>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        <Section title={s.serverUrl}>
          <TextInput
            style={styles.input}
            value={url}
            onChangeText={(t) => {
              setUrl(t);
              setSaved(false);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={s.serverUrl}
          />
          <TextInput
            style={styles.input}
            value={token}
            onChangeText={(t) => {
              setToken(t);
              setSaved(false);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            accessibilityLabel={s.appToken}
            accessibilityHint="Shared server token; empty when the server sets none"
            placeholder={s.appToken}
            placeholderTextColor={colors.muted}
          />
          <Pressable
            onPress={() => {
              if (!url.trim()) return;
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
              app.saveUrl(url.trim());
              app.saveToken(token);
              setSaved(true);
            }}
            accessibilityRole="button"
            accessibilityLabel={s.saveReconnect}
            style={({ pressed }) => [styles.saveButton, pressed ? styles.pressed : null]}
          >
            <Text style={styles.saveText}>{s.saveReconnect}</Text>
          </Pressable>
          {saved ? (
            <Text
              style={[
                styles.saveStatus,
                app.authFailed ? styles.saveStatusError : app.connected ? styles.saveStatusOk : null,
              ]}
            >
              {app.authFailed ? s.saveAuthFailed : app.connected ? s.saveConnected : s.saveConnecting}
            </Text>
          ) : null}
        </Section>
        <Section title={s.answerLang}>
          <View style={styles.row}>
            {langs.map((l) => (
              <View key={l.id} style={styles.cell}>
                <OptionRow label={l.label} selected={app.lang === l.id} hint={s.answerLang} onPress={() => app.changeLang(l.id)} />
              </View>
            ))}
          </View>
        </Section>
        <Section title={s.scriptName}>
          <View style={styles.row}>
            {SCRIPTS.map((sc) => (
              <View key={sc.id} style={styles.cell}>
                <OptionRow
                  label={sc.label}
                  selected={app.script === sc.id}
                  hint={s.scriptName}
                  onPress={() => app.changeScript(sc.id)}
                />
              </View>
            ))}
          </View>
        </Section>
        <Section title={s.voiceInput}>
          <View style={styles.row}>
            {modes.map((m) => (
              <View key={m.id} style={styles.cell}>
                <OptionRow
                  label={m.label}
                  selected={app.voiceMode === m.id}
                  hint={s.voiceInput}
                  onPress={() => app.changeVoiceMode(m.id)}
                />
              </View>
            ))}
          </View>
          <Text style={styles.note}>
            {s.recogLocaleIs}: {app.recogLocale}
          </Text>
        </Section>
        <Section title={s.recognitionTitle}>
          <View style={styles.row}>
            <View style={styles.cell}>
              <OptionRow
                label={s.hfovAuto}
                selected={app.recogOverride === null}
                hint={s.recognitionTitle}
                onPress={() => app.changeRecogOverride(null)}
              />
            </View>
            {(["hi-IN", "en-IN"] as const).map((loc) => (
              <View key={loc} style={styles.cell}>
                <OptionRow
                  label={loc}
                  selected={app.recogOverride === loc}
                  hint={s.recognitionTitle}
                  onPress={() => app.changeRecogOverride(loc)}
                />
              </View>
            ))}
          </View>
        </Section>
        <Section title={s.showCamera}>
          <Pressable
            onPress={() => app.changeShowCamera(!app.showCamera)}
            accessibilityRole="switch"
            accessibilityLabel={s.showCamera}
            accessibilityState={{ checked: app.showCamera }}
            style={({ pressed }) => [styles.switchRow, pressed ? styles.pressed : null]}
          >
            <Text style={styles.optionText}>{app.showCamera ? "ON" : "OFF"}</Text>
            <Toggle on={app.showCamera} />
          </Pressable>
        </Section>
        <Section title={s.ttsRate}>
          <View style={styles.row}>
            {TTS_RATES.map((r) => (
              <View key={r} style={styles.cell}>
                <OptionRow
                  label={`${r}×`}
                  selected={app.ttsRate === r}
                  hint={s.ttsRate}
                  onPress={() => app.changeTtsRate(r)}
                />
              </View>
            ))}
          </View>
        </Section>
        <Section title={s.hfovTitle}>
          <View style={styles.row}>
            {HFOVS.map((h) => (
              <View key={h.label} style={styles.cell}>
                <OptionRow
                  label={h.label === "Auto" ? s.hfovAuto : h.label}
                  selected={app.hfovOverride === h.value}
                  hint={s.hfovTitle}
                  onPress={() => app.changeHfov(h.value)}
                />
              </View>
            ))}
          </View>
        </Section>
        <Section title={app.muted ? s.unmuteAction : s.muteAction}>
          <Pressable
            onPress={() => app.changeMuted(!app.muted)}
            accessibilityRole="switch"
            accessibilityLabel={app.muted ? s.unmuteAction : s.muteAction}
            accessibilityState={{ checked: app.muted }}
            style={({ pressed }) => [styles.switchRow, pressed ? styles.pressed : null]}
          >
            <Text style={styles.optionText}>{app.muted ? "ON" : "OFF"}</Text>
            <Toggle on={app.muted} />
          </Pressable>
        </Section>
        <Section title={s.about}>
          <Pressable
            onPress={() => app.setScreen("about")}
            accessibilityRole="button"
            accessibilityLabel={s.about}
            accessibilityHint={s.aboutHint}
            style={({ pressed }) => [styles.saveButton, pressed ? styles.pressed : null]}
          >
            <Text style={styles.saveText}>{s.aboutHint}</Text>
          </Pressable>
        </Section>
      </ScrollView>
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
    gap: space.md,
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
  title: { fontSize: 30, fontFamily: fonts.extraBold, color: colors.text },
  body: { flexDirection: "column", gap: space.lg, paddingBottom: space.xl },
  section: { flexDirection: "column", gap: space.sm },
  sectionHeading: {
    fontSize: 13,
    fontFamily: fonts.semiBold,
    letterSpacing: 0.08 * 13,
    textTransform: "uppercase",
    color: colors.muted,
  },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontSize: 18,
    fontFamily: fonts.regular,
    color: colors.text,
  },
  saveButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
  },
  saveText: { fontSize: 18, fontFamily: fonts.bold, color: colors.onAccent },
  pressed: { opacity: 0.55 },
  saveStatus: { fontSize: 14, fontFamily: fonts.semiBold, color: colors.muted },
  saveStatusOk: { color: colors.success },
  saveStatusError: { color: colors.danger },
  row: { flexDirection: "row", gap: space.sm },
  cell: { flex: 1, minWidth: 0 },
  option: {
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.line,
    borderRadius: radius.md,
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.sm,
  },
  optionSelected: { borderColor: colors.accent },
  optionText: { fontSize: 17, fontFamily: fonts.semiBold, color: colors.text, textAlign: "center" },
  optionTextSelected: { color: colors.accent },
  note: { fontSize: 14, fontFamily: fonts.regular, color: colors.muted },
  switchRow: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.lg,
  },
});
