// Build-time defaults (08). The laptop runs the server; the phone joins
// the laptop hotspot (Windows hotspot gateway is usually 192.168.137.1).
// Judges' builds bake their own URL + token; Settings can override both
// for the session.
export const DEFAULT_SERVER_URL =
  process.env.EXPO_PUBLIC_SERVER_URL ?? "ws://192.168.137.1:8080";
export const DEFAULT_APP_TOKEN = process.env.EXPO_PUBLIC_APP_TOKEN ?? "";
