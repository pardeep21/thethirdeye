// Face enrollment for a sighted helper: name, consent checkbox, 5 photos,
// enrolled-people list with remove. Photos go to POST /people (REST).
// Reached from PeopleScreen ("Add with helper"); same flow as M6, restyled.
import { useCallback, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as Haptics from "expo-haptics";
import { colors, fonts, radius, space } from "./theme";
import { STRINGS } from "./strings";
import { useAppState } from "./store";
import { captureSmall, type TakePhotoFn } from "./capture";
import { httpJson, wsToHttp } from "./http";
import { usePeople } from "./people";
import { Icon } from "./components/icons";

export interface EnrollProps {
  takePhoto: TakePhotoFn;
  serverUrl: string;
  onBack(): void;
}

const PHOTO_PROMPTS = [
  "Photo 1 of 5: face the camera",
  "Photo 2 of 5: turn slightly left",
  "Photo 3 of 5: turn slightly right",
  "Photo 4 of 5: with glasses / cap if worn",
  "Photo 5 of 5: one step back",
];

export function EnrollScreen(props: EnrollProps) {
  const app = useAppState();
  const s = STRINGS[app.lang];
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const { people, refresh, removePerson } = usePeople(props.serverUrl);

  const base = (() => {
    try {
      return wsToHttp(props.serverUrl);
    } catch {
      return "";
    }
  })();

  const capture = useCallback(async () => {
    if (busy || photos.length >= 5) return;
    setBusy(true);
    try {
      const small = await captureSmall(props.takePhoto);
      if (small) setPhotos((p) => [...p, small.base64]);
      else setStatus("Photo failed, try again");
    } finally {
      setBusy(false);
    }
  }, [busy, photos.length, props.takePhoto]);

  const submit = useCallback(async () => {
    if (!base || busy) return;
    setBusy(true);
    setStatus("");
    try {
      const res = await httpJson(`${base}/people`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), consent, photos }),
      });
      if (res.status === 201) {
        setStatus(`Enrolled ${name.trim()} (${photos.length} photos)`);
        setName("");
        setConsent(false);
        setPhotos([]);
        await refresh();
        app.refreshPeople();
      } else {
        const err = (res.json as { error?: unknown }).error;
        setStatus(typeof err === "string" ? err : `Server said ${res.status}`);
      }
    } catch {
      setStatus("Network error - is the server up?");
    } finally {
      setBusy(false);
    }
  }, [base, busy, name, consent, photos, refresh, app]);

  const canSubmit = name.trim().length > 0 && consent && photos.length === 5 && !busy;
  const tap = (): void => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable
          onPress={() => {
            tap();
            props.onBack();
          }}
          accessibilityRole="button"
          accessibilityLabel={s.backHome}
          style={styles.backButton}
        >
          <Icon name="back" size={26} color={colors.text} strokeWidth={2.2} />
        </Pressable>
        <Text style={styles.title}>{s.addHelper}</Text>
      </View>
      <ScrollView contentContainerStyle={styles.body}>
        <TextInput
          style={styles.input}
          placeholder="Name, exactly as he says it"
          placeholderTextColor={colors.muted}
          value={name}
          onChangeText={setName}
          accessibilityLabel="Person name"
        />
        <Pressable
          onPress={() => {
            tap();
            setConsent((c) => !c);
          }}
          accessibilityRole="checkbox"
          accessibilityLabel="This person agrees to be recognised"
          accessibilityState={{ checked: consent }}
          style={styles.consent}
        >
          <View style={[styles.checkbox, consent ? styles.checkboxOn : null]}>
            {consent ? <Icon name="check" size={18} color={colors.bg} strokeWidth={3} /> : null}
          </View>
          <Text style={styles.consentText}>This person agrees to be recognised</Text>
        </Pressable>
        <Text style={styles.prompt}>{photos.length < 5 ? PHOTO_PROMPTS[photos.length] : "5 photos ready"}</Text>
        <Text style={styles.counter}>
          {photos.length} / 5{busy ? " …" : ""}
        </Text>
        <View style={styles.row}>
          <Pressable
            onPress={() => {
              tap();
              void capture();
            }}
            disabled={busy || photos.length >= 5}
            accessibilityRole="button"
            accessibilityLabel="Capture photo"
            style={[styles.button, styles.buttonPrimary]}
          >
            <Text style={styles.buttonPrimaryText}>Capture photo</Text>
          </Pressable>
          <Pressable
            onPress={() => {
              tap();
              setPhotos((p) => p.slice(0, -1));
            }}
            disabled={busy || photos.length === 0}
            accessibilityRole="button"
            accessibilityLabel="Retake last photo"
            style={styles.button}
          >
            <Text style={styles.buttonText}>Retake last</Text>
          </Pressable>
        </View>
        <Pressable
          onPress={() => {
            tap();
            void submit();
          }}
          disabled={!canSubmit}
          accessibilityRole="button"
          accessibilityLabel="Enroll this person"
          accessibilityState={{ disabled: !canSubmit }}
          style={[styles.button, styles.submit, canSubmit ? styles.buttonPrimary : null]}
        >
          <Text style={canSubmit ? styles.buttonPrimaryText : styles.buttonText}>Enroll</Text>
        </Pressable>
        {status ? <Text style={styles.status}>{status}</Text> : null}
        <Text style={styles.sectionHeading}>
          {s.savedHeading} · {people.length}
        </Text>
        {people.map((p) => (
          <View key={p.id} style={styles.person}>
            <Text style={styles.personName}>
              {p.name} ({p.faces})
            </Text>
            <Pressable
              onPress={() => {
                tap();
                void removePerson(p.id).finally(() => app.refreshPeople());
              }}
              accessibilityRole="button"
              accessibilityLabel={`${s.removePerson} ${p.name}`}
              style={styles.remove}
            >
              <Icon name="trash" size={22} color={colors.danger} strokeWidth={2.2} />
            </Pressable>
          </View>
        ))}
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
  title: { fontSize: 24, fontFamily: fonts.extraBold, color: colors.text, flexShrink: 1 },
  body: { flexDirection: "column", gap: space.md, paddingBottom: space.xl },
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
  consent: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.sm },
  checkbox: {
    width: 32,
    height: 32,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.lineStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  consentText: { fontSize: 17, fontFamily: fonts.semiBold, color: colors.text, flexShrink: 1 },
  prompt: { fontSize: 18, fontFamily: fonts.bold, color: colors.text },
  counter: { fontSize: 15, fontFamily: fonts.regular, color: colors.muted },
  row: { flexDirection: "row", gap: space.md },
  button: {
    flex: 1,
    minHeight: 60,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.sm,
  },
  buttonPrimary: { backgroundColor: colors.accent, borderWidth: 0 },
  buttonPrimaryText: { fontSize: 18, fontFamily: fonts.bold, color: colors.onAccent },
  buttonText: { fontSize: 18, fontFamily: fonts.bold, color: colors.text },
  submit: { marginTop: space.xs },
  status: { fontSize: 16, fontFamily: fonts.regular, color: colors.accent },
  sectionHeading: {
    fontSize: 13,
    fontFamily: fonts.semiBold,
    letterSpacing: 0.08 * 13,
    textTransform: "uppercase",
    color: colors.muted,
  },
  person: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  personName: { fontSize: 19, fontFamily: fonts.bold, color: colors.text },
  remove: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.chip,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
  },
});
