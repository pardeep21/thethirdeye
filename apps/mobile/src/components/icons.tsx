// Single icon family, traced from the inline SVGs in docs/design/*.html
// (24x24 viewBox, round caps/joins). No emoji icons anywhere.
import Svg, { Circle, Path, Rect } from "react-native-svg";
import { colors } from "../theme";

export type IconName =
  | "mic"
  | "eye"
  | "people"
  | "person"
  | "chat"
  | "gear"
  | "back"
  | "trash"
  | "check";

export interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

function Glyph({ name }: { name: IconName }): React.JSX.Element {
  switch (name) {
    case "mic":
      return (
        <>
          <Rect x="9" y="3" width="6" height="11" rx="3" />
          <Path d="M5 11a7 7 0 0 0 14 0" />
          <Path d="M12 18v3" />
        </>
      );
    case "eye":
      return (
        <>
          <Path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
          <Circle cx="12" cy="12" r="3" />
        </>
      );
    case "people":
      return (
        <>
          <Circle cx="9" cy="8" r="3.5" />
          <Path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
          <Circle cx="17" cy="9" r="2.5" />
          <Path d="M16 14.5a5 5 0 0 1 5.5 5" />
        </>
      );
    case "person":
      return (
        <>
          <Circle cx="12" cy="8" r="4" />
          <Path d="M4 21a8 8 0 0 1 16 0" />
        </>
      );
    case "chat":
      return <Path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />;
    case "gear":
      return (
        <>
          <Circle cx="12" cy="12" r="3" />
          <Path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68 1.65 1.65 0 0 0 10 3.17V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </>
      );
    case "back":
      return <Path d="M15 5l-7 7 7 7" />;
    case "trash":
      return <Path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />;
    case "check":
      return <Path d="M5 12.5l4.5 4.5L19 7.5" />;
  }
}

export function Icon({ name, size = 24, color = colors.text, strokeWidth = 2 }: IconProps): React.JSX.Element {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={true}
    >
      <Glyph name={name} />
    </Svg>
  );
}
