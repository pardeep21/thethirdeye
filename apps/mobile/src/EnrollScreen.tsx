// Face enrollment for a sighted helper: name, consent checkbox, 5 photos,
// enrolled-people list with remove. Photos go to POST /people (REST).
import { useCallback, useEffect, useState } from "react";
import { Button, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { captureSmall, type PhotoOutput } from "./capture";
import { httpJson, wsToHttp } from "./http";

export interface EnrollProps {
  photoOutput: PhotoOutput;
  serverUrl: string;
  onBack(): void;
}

interface Person {
  id: number;
  name: string;
  faces: number;
}

const PHOTO_PROMPTS = [
  "Photo 1 of 5: face the camera",
  "Photo 2 of 5: turn slightly left",
  "Photo 3 of 5: turn slightly right",
  "Photo 4 of 5: with glasses / cap if worn",
  "Photo 5 of 5: one step back",
];

function asPeople(v: unknown): Person[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((p) => {
    if (typeof p !== "object" || p === null) return [];
    const r = p as Record<string, unknown>;
    if (typeof r.id !== "number" || typeof r.name !== "string" || typeof r.faces !== "number") return [];
    return [{ id: r.id, name: r.name, faces: r.faces }];
  });
}

export function EnrollScreen(props: EnrollProps) {
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [people, setPeople] = useState<Person[]>([]);

  const base = (() => {
    try {
      return wsToHttp(props.serverUrl);
    } catch {
      return "";
    }
  })();

  const refresh = useCallback(async () => {
    if (!base) return;
    try {
      const res = await httpJson(`${base}/people`);
      if (res.status === 200) setPeople(asPeople(res.json));
    } catch {
      // List is best-effort; enrollment still works.
    }
  }, [base]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const capture = useCallback(async () => {
    if (busy || photos.length >= 5) return;
    setBusy(true);
    try {
      const small = await captureSmall(props.photoOutput);
      if (small) setPhotos((p) => [...p, small.base64]);
      else setStatus("Photo failed, try again");
    } finally {
      setBusy(false);
    }
  }, [busy, photos.length, props.photoOutput]);

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
      } else {
        const err = (res.json as { error?: unknown }).error;
        setStatus(typeof err === "string" ? err : `Server said ${res.status}`);
      }
    } catch {
      setStatus("Network error - is the server up?");
    } finally {
      setBusy(false);
    }
  }, [base, busy, name, consent, photos, refresh]);

  const removePerson = useCallback(
    async (id: number) => {
      if (!base || busy) return;
      setBusy(true);
      try {
        await httpJson(`${base}/people/${id}`, { method: "DELETE" });
        await refresh();
      } finally {
        setBusy(false);
      }
    },
    [base, busy, refresh]
  );

  const canSubmit = name.trim().length > 0 && consent && photos.length === 5 && !busy;

  return (
    <View style={styles.root}>
      <Text style={styles.title}>Enroll a face (helper)</Text>
      <TextInput
        style={styles.input}
        placeholder="Name, exactly as he says it"
        value={name}
        onChangeText={setName}
      />
      <Pressable style={styles.consent} onPress={() => setConsent((c) => !c)}>
        <Text>{consent ? "[x]" : "[ ]"} This person agrees to be recognised</Text>
      </Pressable>
      <Text style={styles.section}>{photos.length < 5 ? PHOTO_PROMPTS[photos.length] : "5 photos ready"}</Text>
      <View style={styles.row}>
        <Button title={busy ? "..." : "Capture photo"} onPress={() => void capture()} disabled={busy || photos.length >= 5} />
        <Button title="Retake last" onPress={() => setPhotos((p) => p.slice(0, -1))} disabled={busy || photos.length === 0} />
      </View>
      <View style={styles.submit}>
        <Button title="Enroll" onPress={() => void submit()} disabled={!canSubmit} />
      </View>
      {status ? <Text style={styles.status}>{status}</Text> : null}
      <Text style={styles.section}>Enrolled ({people.length})</Text>
      {people.map((p) => (
        <View key={p.id} style={styles.person}>
          <Text>
            {p.name} ({p.faces})
          </Text>
          <Button title="Remove" onPress={() => void removePerson(p.id)} />
        </View>
      ))}
      <View style={styles.back}>
        <Button title="Back" onPress={props.onBack} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "stretch", justifyContent: "center", padding: 24 },
  title: { fontSize: 20, fontWeight: "bold", marginBottom: 12, textAlign: "center" },
  input: { borderWidth: 1, borderColor: "#888", padding: 8, marginBottom: 8 },
  consent: { paddingVertical: 8 },
  section: { marginTop: 12, marginBottom: 8, fontWeight: "bold" },
  row: { flexDirection: "row", justifyContent: "space-between" },
  submit: { marginTop: 12 },
  status: { marginTop: 8 },
  person: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginVertical: 2 },
  back: { marginTop: 20 },
});
