// CaptionList: the "Last heard" panel. Last 3 spoken lines, newest on
// top, 20sp text with a kind icon disc (rupee/person/eye/chat).
import { StyleSheet, Text, View } from "react-native";
import type { SpeakKind } from "../../../server/src/protocol";
import { colors, fonts, radius } from "../theme";
import { timeAgo } from "../format";
import { Icon, type IconName } from "./icons";
import type { Caption } from "../voice/captions";

export const CAPTIONS_SHOWN = 3;

export interface CaptionListProps {
  heading: string;
  emptyText: string;
  /** Oldest-first store order; rendered newest on top. */
  captions: Caption[];
  now: number;
  script: "gurmukhi" | "devanagari" | "latin";
}

const KIND_LABEL: Record<SpeakKind, string> = {
  cash: "Cash",
  answer: "Answer",
  people: "People",
  scene: "Look around",
  system: "System",
};

function kindVisual(kind: SpeakKind | null): { icon: IconName | "rupee"; fg: string; bg: string } {
  switch (kind) {
    case "cash":
      return { icon: "rupee", fg: colors.accent, bg: colors.cashBg };
    case "people":
      return { icon: "person", fg: colors.text, bg: colors.chip };
    case "scene":
      return { icon: "eye", fg: colors.second, bg: colors.secondBg };
    default:
      return { icon: "chat", fg: colors.text, bg: colors.chip };
  }
}

export function CaptionList(props: CaptionListProps): React.JSX.Element {
  const shown = props.captions.slice(-CAPTIONS_SHOWN).reverse();
  return (
    <View style={styles.panel} accessibilityRole="summary" accessibilityLabel={props.heading}>
      <Text style={styles.heading}>{props.heading.toUpperCase()}</Text>
      {shown.length === 0 ? (
        <Text style={styles.empty}>{props.emptyText}</Text>
      ) : (
        shown.map((c) => {
          const v = kindVisual(c.kind);
          return (
            <View key={c.id} style={styles.row}>
              <View style={[styles.disc, { backgroundColor: v.bg }]}>
                {v.icon === "rupee" ? (
                  <Text style={[styles.rupee, { color: v.fg }]}>₹</Text>
                ) : (
                  <Icon name={v.icon} size={18} color={v.fg} strokeWidth={2.2} />
                )}
              </View>
              <View style={styles.texts}>
                <Text
                  style={[styles.text, { fontFamily: props.script === "gurmukhi" ? fonts.gurmukhiBold : fonts.bold }]}
                >
                  {c.text}
                </Text>
                <Text style={styles.sub}>
                  {timeAgo(c.at, props.now)} · {c.kind ? KIND_LABEL[c.kind] : KIND_LABEL.system}
                </Text>
              </View>
            </View>
          );
        })
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    flexGrow: 1,
    minHeight: 0,
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    paddingVertical: 14,
    paddingHorizontal: 16,
    flexDirection: "column",
    gap: 12,
  },
  heading: {
    fontSize: 13,
    fontFamily: fonts.semiBold,
    letterSpacing: 0.08 * 13,
    textTransform: "uppercase",
    color: colors.muted,
  },
  empty: { fontSize: 20, fontFamily: fonts.regular, color: colors.muted },
  row: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  disc: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center", flex: 0 },
  rupee: { fontWeight: "800", fontSize: 17 },
  texts: { flexDirection: "column", gap: 2, flexShrink: 1 },
  text: { fontSize: 20, color: colors.text },
  sub: { fontSize: 13, fontFamily: fonts.regular, color: colors.muted },
});
