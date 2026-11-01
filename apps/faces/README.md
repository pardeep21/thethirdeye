# Faces sidecar (Track C)

Local face detection + ArcFace embeddings for TheThirdEye. The Node
server POSTs JPEGs here; nothing ever leaves the laptop.

## Run (Windows)

```powershell
cd apps/faces
.\run.ps1
```

First run creates `.venv` (Python 3.12), installs `requirements.txt`,
and downloads model weights (~150 MB to `~/.deepface`) during warm-up.
Later starts are warm in seconds. Serves `127.0.0.1:8765` only.

`run.sh` is the Unix twin. `FACE_DETECTOR` overrides the detector
(`yunet` default; `retinaface` for accuracy comparisons); `FACES_PORT`
overrides the port.

## API

- `GET /health` → `{ok, model, detector, warm}`
- `POST /detect` `{imageBase64, maxFaces?}` → `{faces: [{box,
  boxNorm, score, embedding, quality: {blur, yawDeg, sizePx}}], ms}`

Faces under 40 px are skipped. Images are never written to disk; logs
carry counts + timings only.

## Calibration

```powershell
.venv\Scripts\python.exe calibrate.py
```

Reads `data/faces/<name>/*.jpg` (5+ varied photos per person, 2+
people), prints genuine/impostor distributions, the 0-false-accept
threshold and the FRR there. Paste the result into
`FACE_MATCH_THRESHOLD` (server `decision.ts`).

`benchmark.py` POSTs 20 synthetic 768px frames and prints p50/p95.
