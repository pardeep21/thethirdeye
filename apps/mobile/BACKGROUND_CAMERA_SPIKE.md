# Spike: background / screen-off capture on Android 14+ (R6, Part B)

Status: SPIKE ONLY — findings and recommendation. No foreground-service
code is merged; Part A (stall monitor, "camera band hai", server
short-circuit) is the shipped behaviour.

## Question

Can the phone keep capturing frames while the app is backgrounded or the
screen is off, via a foreground service (FGS) with
`foregroundServiceType="camera"`, and can react-native-vision-camera 4
keep its session alive under it?

## What Android 14+ requires

- Manifest: `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_CAMERA`, and
  `android:foregroundServiceType="camera"` on the service; `startForeground()`
  with `FOREGROUND_SERVICE_TYPE_CAMERA`. Runtime prerequisite: the `CAMERA`
  permission ([service types](https://developer.android.com/develop/background-work/services/fgs/service-types),
  [Android 14 changes](https://developer.android.com/about/versions/14/changes/fgs-types-required)).
- The `CAMERA` permission is subject to while-in-use restrictions: **a
  `camera` FGS cannot be *started* while the app is in the background**
  (narrow exceptions). The service must be started while the app is
  foregrounded then carried into the background — screen-off-first, or
  "start capturing while backgrounded", is not possible.
- Screen-off capture additionally needs the CPU awake: a partial wake lock
  for frame processing + uploads, with continuous camera + radio power draw.
- The OS camera-privacy indicator stays on the whole time (correct for an
  assistive product, but it is a permanent green dot + a persistent FGS
  notification he cannot swipe away).
- OEM task managers (Xiaomi/Oppo/Vivo/Samsung) kill FGS processes
  aggressively; reliable background capture needs a battery-optimisation
  exemption flow plus per-OEM testing.

## Can vision-camera 4 keep its session alive under an FGS?

No — not as a supported path. Findings:

- The v4 `Camera` view owns a `CameraSession` (Idle → Ready → Active)
  bound to the view/activity lifecycle; the library's own guidance is to
  pause via `isActive={false}` on background, and community experience is
  that the session is lost when the app fully backgrounds.
- Keeping capture alive across background requires binding the camera
  lifecycle to the *service* lifecycle instead — i.e. a native module
  (CameraX `ImageAnalysis` + `ImageCapture`, or Camera2) running inside
  the FGS, independent of the React view tree.
- Our two capture paths would both need native re-implementation: the
  32×32 gate feed (currently a JS worklet frame processor at ~2 fps) and
  the 768px JPEG `takePhoto` uploads — plus a bridge (events or a local
  socket) to get pixels to the existing JS gate/upload/socket code, or a
  fully native upload path duplicating the WS protocol.

## Options

1. **Native CameraX module in a camera-type FGS (the only real option).**
   Kotlin module: FGS + CameraX bound to the service lifecycle,
   ImageAnalysis for the gate feed, ImageCapture for uploads, partial wake
   lock, Expo config plugin for manifest entries, battery-exemption
   onboarding. Effort: ~3–5 days for a prototype, ~1–2 weeks hardening
   (OEM killers, thermal throttling, Doze, reconnect, privacy indicator
   UX). Risks: OEM kills, battery/heat during all-day wear, Play policy
   scrutiny for background camera if ever published, and a second capture
   stack to maintain alongside vision-camera.
2. **Keep vision-camera, lean on keep-awake (current/Part A behaviour).**
   The screen never locks under a running camera, and backgrounding is
   announced ("camera band hai") with the server short-circuiting vision
   turns. Cost: already shipped. Limitation: no capture while backgrounded
   or screen-off — but the failure is now loud instead of silent.
3. **Defer to the glasses path.** On Meta glasses the phone is a relay:
   the glasses stream via the Wearables Device Access Toolkit whether or
   not the phone app is foregrounded, so phone background capture buys
   nothing there.

## Recommendation

**Don't build it for the phone.** Option 1 is the only working route and
it is a second camera stack (native FGS + CameraX + wake lock + OEM
whack-a-mole) for a case Part A already handles honestly: the session
model is "camera runs while the app is up", keep-awake holds the screen,
and any stall/background/error is spoken immediately. Revisit only if
field use shows he is *accidentally* backgrounding mid-task often — and
even then, prefer cheaper mitigations first (kiosk/lock-task mode during
a session, or a louder background earcon). For glasses users this whole
question is moot (option 3).
