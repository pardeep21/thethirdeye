"""Threshold calibration: genuine vs impostor ArcFace similarities.

Usage:
    .venv/Scripts/python calibrate.py [data-dir]

Reads <data-dir>/<name>/*.jpg (default <repo>/data/faces), embeds the
largest face per photo, and prints the genuine/impostor distributions,
the threshold for 0 false accepts, and the false-reject rate there.

Collect with varied light/angles per person (5+ photos each, 2+ people);
include one unenrolled-looking person only in the manual walk-in test.
"""

import glob
import math
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from app import detect_faces  # noqa: E402


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def pct(vals: list[float], q: float) -> float:
    if not vals:
        return float("nan")
    s = sorted(vals)
    return s[min(len(s) - 1, int(q * len(s)))]


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    default_root = os.path.normpath(os.path.join(here, "..", "..", "data", "faces"))
    root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else default_root)
    if not os.path.isdir(root):
        print(f"no photo set at {root}")
        print("collect data/faces/<name>/*.jpg first: 5+ varied photos per person, 2+ people,")
        print("then re-run. Server default stays 0.45 + 0.08 margin until then.")
        return 1
    people: dict[str, list[np.ndarray]] = {}
    skipped = 0
    for path in sorted(glob.glob(os.path.join(root, "*", "*.jpg"))):
        name = os.path.basename(os.path.dirname(path))
        bgr = cv2.imread(path)
        if bgr is None:
            print(f"skip unreadable {path}")
            skipped += 1
            continue
        faces = detect_faces(bgr, 1)
        if not faces:
            print(f"skip no-face {path}")
            skipped += 1
            continue
        people.setdefault(name, []).append(np.array(faces[0]["embedding"], dtype=np.float64))
    names = [n for n, v in people.items() if v]
    if len(names) < 2 or any(len(people[n]) < 2 for n in names):
        print("need 2+ people with 2+ usable photos each; got: " + str({n: len(v) for n, v in people.items()}))
        return 1
    genuine, impostor = [], []
    for a in names:
        embs = people[a]
        for i in range(len(embs)):
            for j in range(i + 1, len(embs)):
                genuine.append(cosine(embs[i], embs[j]))
    for x in range(len(names)):
        for y in range(x + 1, len(names)):
            for ea in people[names[x]]:
                for eb in people[names[y]]:
                    impostor.append(cosine(ea, eb))
    t0fa = math.ceil((max(impostor) + 0.001) * 1000) / 1000
    frr = sum(1 for g in genuine if g < t0fa) / len(genuine)
    print(f"photos: {sum(len(v) for v in people.values())} usable, {skipped} skipped")
    print(f"genuine pairs: {len(genuine)} min={min(genuine):.3f} p50={pct(genuine, 0.5):.3f} max={max(genuine):.3f}")
    print(f"impostor pairs: {len(impostor)} min={min(impostor):.3f} p50={pct(impostor, 0.5):.3f} max={max(impostor):.3f}")
    print(f"threshold for 0 false accepts: {t0fa:.3f} (false-reject rate {frr:.1%})")
    print(f"paste: FACE_MATCH_THRESHOLD = {t0fa:.3f}  (+ keep a margin over the runner-up, see matcher.ts)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
