# EyeSmart (working name)

A hands-free, proactive "second pair of eyes" for a blind shopkeeper.
See [docs/MANIFEST.md](docs/MANIFEST.md) (vision, principles, honesty statement)
and [docs/MVP.md](docs/MVP.md) (build spec). Progress log: [docs/PROGRESS.md](docs/PROGRESS.md).

> EyeSmart is an assistive aid, not a medical or safety device. It reads
> currency denominations and describes surroundings using AI, and it can be
> wrong. It does not detect counterfeit or damaged notes. Important amounts
> should be confirmed by another person.

Monorepo (`apps/mobile`, `apps/server`, `apps/eval`). The product name is a
placeholder: display name, package scope and app id live in
[config/app-name.ts](config/app-name.ts) (mirrored in `apps/mobile/app.json`,
checked by test). Rename = find-and-replace + `npm test`.

## Run locally

Prereqs: Node 20+, npm. No API keys needed: everything runs with `PROVIDER=mock`.

```sh
npm install
npm run typecheck
npm test
```

Server (mock vision, no key):

```sh
cd apps/server
cp .env.example .env   # PROVIDER=mock, PORT=8080
npm run build && npm start
```

Health check: `GET http://127.0.0.1:8080/health` -> `{"ok":true,"provider":"mock"}`.

Eval CLI (needs a key + photos; see [apps/eval/README.md](apps/eval/README.md)):

```sh
cd apps/eval && npm run spike -- notes --limit 2
```

Mobile (Expo dev build, Android; typecheck only in CI):

```sh
cd apps/mobile
npx expo run:android   # needs Android SDK + a device; not run here
```

Point the app at the laptop: default `ws://192.168.137.1:8080` (Windows
hotspot gateway); change in Settings (M6) or `apps/mobile/src/config.ts`.

## Layout

- `apps/mobile` - chest-camera app: hidden back camera ~2 fps, 32x32
  change gate, 768px JPEG uploads over WS, Android TTS speech-out.
- `apps/server` - Node + `ws`: latest-frame store, model adapters
  (mock-first), decision engine, phrase builder, REST enrollment.
- `apps/eval` - `eyesmart-spike` benchmark CLI: any provider over
  `data/notes/<label>_*.jpg` -> `results.md`.
- `config/app-name.ts` - product naming source of truth + consistency test.
- `docs/` - MANIFEST, MVP spec, PROGRESS log.
