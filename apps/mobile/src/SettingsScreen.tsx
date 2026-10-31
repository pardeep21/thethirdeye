// Settings screen: server URL, answer language, mute, voice input mode.
// Plain React state, no navigation library (the app has three screens).
import { useState } from "react";
import { Button, StyleSheet, Text, TextInput, View } from "react-native";
import type { SpeakLang, UtteranceLang } from "../../server/src/protocol";
import type { VoiceMode } from "./ptt";

export interface SettingsProps {
  initialUrl: string;
  lang: SpeakLang;
  muted: boolean;
  voiceMode: VoiceMode;
  recogLocale: UtteranceLang;
  onSaveUrl(url: string): void;
  onLang(lang: SpeakLang): void;
  onMuted(muted: boolean): void;
  onVoiceMode(mode: VoiceMode): void;
  onBack(): void;
}

const LANGS: Array<{ id: SpeakLang; label: string }> = [
  { id: "pa", label: "Punjabi" },
  { id: "hi", label: "Hindi" },
  { id: "en", label: "English" },
];

export function SettingsScreen(props: SettingsProps) {
  const [url, setUrl] = useState(props.initialUrl);
  return (
    <View style={styles.root}>
      <Text style={styles.title}>Settings</Text>
      <Text>Server WebSocket URL</Text>
      <TextInput
        style={styles.input}
        value={url}
        onChangeText={setUrl}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Button title="Save and reconnect" onPress={() => props.onSaveUrl(url.trim())} />
      <Text style={styles.section}>Answer language</Text>
      <View style={styles.row}>
        {LANGS.map((l) => (
          <View key={l.id} style={styles.langButton}>
            <Button
              title={props.lang === l.id ? `[${l.label}]` : l.label}
              onPress={() => props.onLang(l.id)}
            />
          </View>
        ))}
      </View>
      <Text style={styles.section}>Voice input</Text>
      <View style={styles.row}>
        <View style={styles.langButton}>
          <Button
            title={props.voiceMode === "android_stt" ? "[On-device STT]" : "On-device STT"}
            onPress={() => props.onVoiceMode("android_stt")}
          />
        </View>
        <View style={styles.langButton}>
          <Button
            title={props.voiceMode === "server_audio" ? "[Server audio]" : "Server audio"}
            onPress={() => props.onVoiceMode("server_audio")}
          />
        </View>
      </View>
      <Text style={styles.note}>Recognition locale: {props.recogLocale}</Text>
      <Text style={styles.section}>Mute</Text>
      <Button
        title={props.muted ? "Unmute (bol)" : "Mute (chup)"}
        onPress={() => props.onMuted(!props.muted)}
      />
      <View style={styles.back}>
        <Button title="Back" onPress={props.onBack} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "stretch", justifyContent: "center", padding: 24 },
  title: { fontSize: 20, fontWeight: "bold", marginBottom: 12, textAlign: "center" },
  section: { marginTop: 16, marginBottom: 8, fontWeight: "bold" },
  note: { marginTop: 8 },
  input: { borderWidth: 1, borderColor: "#888", padding: 8, marginBottom: 8 },
  row: { flexDirection: "row", justifyContent: "space-between" },
  langButton: { flex: 1, marginHorizontal: 2 },
  back: { marginTop: 24 },
});
