"""Local face detection + ArcFace embedding sidecar for TheThirdEye.

FastAPI service (127.0.0.1 only): the Node server POSTs JPEGs, gets back
face boxes + L2-normalised embeddings. Models load once at startup.

Privacy: images are decoded in memory and never written to disk. Logs
carry counts + timings only, never image bytes or embeddings.
"""

import base64
import logging
import math
import os
import time

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from contextlib import asynccontextmanager  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

MODEL_NAME = "ArcFace"
DETECTOR = os.environ.get("FACE_DETECTOR", "yunet")
MIN_SIZE_PX = 40
MAX_FACES_CAP = 25
MAX_FACES_DEFAULT = 10

KNOWN_DETECTORS = {
    "opencv",
    "ssd",
    "dlib",
    "mtcnn",
    "fastmtcnn",
    "retinaface",
    "mediapipe",
    "yolov8",
    "yunet",
    "centerface",
}

if DETECTOR not in KNOWN_DETECTORS:
    raise RuntimeError(f"FACE_DETECTOR={DETECTOR} unknown (expected one of {sorted(KNOWN_DETECTORS)})")

logging.basicConfig(level=logging.INFO, format="%(asctime)s faces %(levelname)s %(message)s")
log = logging.getLogger("faces")

state = {"warm": False}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    t0 = time.monotonic()
    log.info("loading %s + %s (first run downloads weights)...", MODEL_NAME, DETECTOR)
    try:
        detect_faces(np.zeros((128, 128, 3), dtype=np.uint8), 1)
    except Exception as e:
        log.warning("warm-up inference failed (models may still load lazily): %s", e)
    state["warm"] = True
    log.info("warm in %.1fs", time.monotonic() - t0)
    yield


app = FastAPI(title="thethirdeye-faces", lifespan=lifespan)


class DetectRequest(BaseModel):
    imageBase64: str
    maxFaces: int = Field(default=MAX_FACES_DEFAULT, ge=1, le=MAX_FACES_CAP)


def decode_jpeg(image_b64: str) -> np.ndarray:
    try:
        raw = base64.b64decode(image_b64, validate=True)
    except Exception:
        raise HTTPException(status_code=400, detail="imageBase64 is not valid base64")
    if len(raw) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="image too large (max 20 MB)")
    buf = np.frombuffer(raw, dtype=np.uint8)
    bgr = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if bgr is None:
        raise HTTPException(status_code=400, detail="imageBase64 is not a decodable image")
    return bgr


def blur_of(crop: np.ndarray) -> float:
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def yaw_from_landmarks(area: dict) -> float | None:
    """Rough yaw from eye/nose landmarks when the detector provides them."""
    try:
        left = area.get("left_eye")
        right = area.get("right_eye")
        nose = area.get("nose")
        if not (left and right and nose):
            return None
        mid_x = (float(left[0]) + float(right[0])) / 2.0
        eye_dist = abs(float(right[0]) - float(left[0]))
        if eye_dist <= 0:
            return None
        return round(math.degrees(math.atan2(float(nose[0]) - mid_x, eye_dist)), 1)
    except (TypeError, ValueError, IndexError):
        return None


def l2_normalize(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vec))
    if norm == 0:
        return vec
    return [v / norm for v in vec]


def clamp_box(x: int, y: int, w: int, h: int, img_w: int, img_h: int) -> tuple[int, int, int, int]:
    x = max(0, min(x, img_w - 1))
    y = max(0, min(y, img_h - 1))
    w = max(0, min(w, img_w - x))
    h = max(0, min(h, img_h - y))
    return x, y, w, h


def detect_faces(bgr: np.ndarray, max_faces: int) -> list[dict]:
    """Pure core (also imported by calibrate.py): BGR array in, face dicts out."""
    # Imported lazily so --help-style imports stay light; the lifespan
    # warm-up pays the TF cost once at startup.
    from deepface import DeepFace

    try:
        found = DeepFace.represent(
            img_path=bgr,
            model_name=MODEL_NAME,
            detector_backend=DETECTOR,
            # Strict: with enforce_detection=False DeepFace invents a
            # full-image "face" on empty frames (garbage embedding).
            enforce_detection=True,
            align=True,
        )
    except ValueError:
        return []  # no face in frame: the common case, stay quiet
    except Exception as e:
        log.warning("deepface represent failed: %s", e)
        return []
    if not found:
        return []
    img_h, img_w = bgr.shape[:2]
    out: list[dict] = []
    for entry in found:
        area = entry.get("facial_area", {}) or {}
        try:
            x, y, w, h = (int(area.get(k, 0)) for k in ("x", "y", "w", "h"))
        except (TypeError, ValueError):
            continue
        x, y, w, h = clamp_box(x, y, w, h, img_w, img_h)
        size_px = max(w, h)
        if size_px < MIN_SIZE_PX:
            continue
        emb = entry.get("embedding")
        if not emb:
            continue
        crop = bgr[y : y + h, x : x + w]
        out.append(
            {
                "box": [x, y, w, h],
                "boxNorm": [round(x / img_w, 4), round(y / img_h, 4), round(w / img_w, 4), round(h / img_h, 4)],
                "score": float(entry.get("face_confidence", entry.get("confidence", 0.0)) or 0.0),
                "embedding": l2_normalize([float(v) for v in emb]),
                "quality": {
                    "blur": round(blur_of(crop), 1),
                    "yawDeg": yaw_from_landmarks(area),
                    "sizePx": size_px,
                },
            }
        )
    out.sort(key=lambda f: f["quality"]["sizePx"], reverse=True)
    return out[:max_faces]


@app.get("/health")
async def health() -> dict:
    return {"ok": True, "model": MODEL_NAME, "detector": DETECTOR, "warm": state["warm"]}


@app.post("/detect")
async def detect(req: DetectRequest) -> dict:
    t0 = time.monotonic()
    bgr = decode_jpeg(req.imageBase64)
    faces = detect_faces(bgr, req.maxFaces)
    ms = int((time.monotonic() - t0) * 1000)
    log.info("detect faces=%d ms=%d", len(faces), ms)
    return {"faces": faces, "ms": ms}
