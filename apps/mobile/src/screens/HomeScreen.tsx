// Home screen: status header, mode chips, hero Talk tile, look-around /
// cash / people tiles, and the Last-heard captions panel. Layout follows
// docs/design/Main.html; the listening variant follows Listening.html and
// the look-around-ON variant follows LookAround.html (minus the clock map,
// which needs prompt 03's live tracks).
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { colors, fonts, radius, space } from "../theme";
import { STRINGS } from "../strings";
import { formatLatency, parseCashLine, voiceChip } from "../format";
import { useAppState } from "../store";
import { StatusBar } from "../components/StatusBar";
import { CaptionList } from "../components/CaptionList";
import { TalkButton, type TalkVisual } from "../components/TalkButton";
import { Tile, Toggle } from "../components/Tile";

function Chip({ text, border }: { text: string; border: "accent" | "line" | "second" | "danger" }): React.JSX.Element {
  return (
    <View
      style={[
        styles.chip,
        border === "accent"
          ? styles.chipAccent
          : border === "second"
            ? styles.chipSecond
            : border === "danger"
              ? styles.chipDanger
              : null,
      ]}
    >
      <Text style={styles.chipText}>{text}</Text>
    </View>
  );
}

export function HomeScreen({ preview }: { preview?: ReactNode }): React.JSX.Element {
  const app = useAppState();
  const s = STRINGS[app.lang];

  const listening = app.pttState === "listening" || app.pttState === "recording";
  const thinking = app.pttState === "sending" || app.serverState?.agentBusy === true;
  const visual: TalkVisual = listening ? "listening" : thinking ? "thinking" : app.speaking ? "speaking" : "idle";

  const statusText = !app.connected
    ? s.reconnecting
    : listening
      ? `${s.connected} · ${s.listeningWord}`
      : app.speaking
        ? `${s.connected} · ${s.speakingWord}`
        : app.lookAround
          ? `${s.connected} · ${s.ultraWide}`
          : app.lastAnswerMs !== null
            ? `${s.connected} · ${s.lastAnswer} ${formatLatency(app.lastAnswerMs)}`
            : s.connected;

  const cashRupees = app.lastCash ? parseCashLine(app.lastCash.text) : null;
  const showChips = visual === "idle" || visual === "listening" || visual === "thinking";
  const showTiles = visual === "idle" || visual === "thinking";

  return (
    <View style={styles.root}>
      <StatusBar
        connected={app.connected}
        statusText={statusText}
        preview={preview}
        settingsLabel={s.settings}
        onSettings={() => app.setScreen("settings")}
      />
      {showChips ? (
        <View style={styles.chips}>
          <Chip text={s.cashOn} border="accent" />
          {app.lookAround ? <Chip text={`${s.lookAround} ON`} border="second" /> : null}
          {app.muted ? <Chip text="Muted" border="danger" /> : null}
          <Chip text={voiceChip(app.lang)} border="line" />
        </View>
      ) : null}
      <TalkButton
        visual={visual}
        partial={app.partial}
        compact={app.lookAround}
        s={s}
        accessibilityLabel={
          visual === "listening" ? "Listening. Press again to send." : visual === "speaking" ? "Speaking. Tap to interrupt and talk." : "Talk"
        }
        accessibilityHint="Starts voice input, same as the volume key"
        onPress={app.talk}
      />
      {showTiles ? (
        <>
          <Tile
            title={s.lookAround}
            subtitle={app.lookAround ? s.lookOnHint : s.lookOffHint}
            icon="eye"
            iconColor={colors.second}
            tone={app.lookAround ? "second" : "dark"}
            selected={app.lookAround}
            right={<Toggle on={app.lookAround} tone={app.lookAround ? "second" : "dark"} />}
            accessibilityLabel={app.lookAround ? "Look around, on. Tap to stop." : "Look around, off"}
            accessibilityHint="Toggles the ultra-wide live mode that speaks only about new things"
            onPress={app.toggleLookAround}
          />
          <View style={styles.grid}>
            <View style={styles.gridCell}>
              <Tile
                title={s.cash}
                subtitle={cashRupees !== null ? `${s.cashLast}: ₹${cashRupees}` : s.cashNone}
                icon="rupee"
                compact={true}
                accessibilityLabel="Cash, read the note now"
                accessibilityHint="Forces a fresh cash read"
                onPress={app.cashRead}
              />
            </View>
            <View style={styles.gridCell}>
              <Tile
                title={s.people}
                subtitle={app.peopleCount !== null ? `${app.peopleCount} ${s.peopleSaved}` : s.cashNone}
                icon="people"
                compact={true}
                accessibilityLabel={s.people}
                accessibilityHint="Opens the enrolled-people list"
                onPress={() => app.setScreen("people")}
              />
            </View>
          </View>
        </>
      ) : null}
      <CaptionList heading={s.lastHeard} emptyText={s.nothingSaid} captions={app.captions} now={app.now} script={app.script} />
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
  chips: { flexDirection: "row", gap: space.sm, flexWrap: "wrap" },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    backgroundColor: colors.chip,
    borderWidth: 1,
    borderColor: colors.line,
  },
  chipAccent: { borderColor: colors.accent },
  chipSecond: { borderColor: colors.second },
  chipDanger: { borderColor: colors.danger },
  chipText: { fontSize: 14, fontFamily: fonts.semiBold, color: colors.text },
  grid: { flexDirection: "row", gap: space.md },
  gridCell: { flex: 1, minWidth: 0 },
});
