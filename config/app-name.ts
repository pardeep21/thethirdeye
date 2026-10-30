// Single source of truth for the product placeholder name.
//
// "thethirdeye" is NOT the final product name. The display name, npm package
// scope and native app id are defined here and mirrored in exactly one other
// place: apps/mobile/app.json (Expo requires static JSON there).
//
// Rename procedure: find-and-replace these three values across the repo,
// then run `npm test` - config/app-name.test.mjs fails if app.json drifts.

export const APP_DISPLAY_NAME = "TheThirdEye";
export const APP_PKG_SCOPE = "@thethirdeye";
export const APP_ID = "com.thethirdeye.app";
