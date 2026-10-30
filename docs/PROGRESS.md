# EyeSmart build progress (overnight agent log)

## M0 - Monorepo skeleton (done)

- Moved `eyesmart-spike` CLI into `apps/eval` unchanged (renamed package to
  `@eyesmart/eval`); `data/` and its README moved with it.
- New `apps/server` (Node 20+, `ws`, plain `node:http`): `GET /health`,
  `GET /frame/latest`, WS `frame` -> MockVision triage -> `speak`.
  Mock returns a fixed 500 note so the full path speaks without any key.
- New `apps/mobile` (Expo SDK 58, vision-camera v5 outputs API): hidden back
  camera, frame output -> 32x32 grayscale gate (send if changed or 5 s
  heartbeat), 768px JPEG q70 upload over WS, `expo-speech` queue with P1
  interrupt, one-time "network nahi" on disconnect.
- Naming: `config/app-name.ts` (display name, scope, app id) + test enforcing
  `apps/mobile/app.json` and workspace names match.
- How to run: `npm install`, `npm run typecheck`, `npm test`;
  server: `cd apps/server && cp .env.example .env && npm run build && npm start`
  (`PROVIDER=mock`). Mobile is typecheck-only (no device here).
- Tests: 13 pass (config 2, mobile gate 6, server 5 incl. WS integration).
- Stubs: server speaks on every confident frame (no stability/dedupe -
  replaced by M2 decision engine); audio/command messages ignored until M4/M2.
- Notes: vision-camera v5 has no `useFrameProcessor`; gate uses
  `useFrameOutput` + resize-plugin `useResizePlugin().resize` + worklets
  `runOnJS`. `react-native-nitro-modules` added direct (v5 runtime base).
  Cosmetic `MODULE_TYPELESS_PACKAGE_JSON` warning on the mobile gate test is
  expected (package must stay CJS-typed for Metro/babel configs).
- Next steps for you: join the phone to the laptop hotspot and set
  `DEFAULT_SERVER_URL` if it differs; `npx expo run:android` needs your
  Android SDK + S23.

## Blocked

(nothing)
