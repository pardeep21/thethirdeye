"""20-frame benchmark against a running sidecar (default 127.0.0.1:8765).

Builds a synthetic 768px JPEG (gradient + noise, no face: this measures
the pipeline floor, not with-face cost) and POSTs it 20x, printing
p50/p95 of server ms and client RTT. Start the service first (run.ps1).
"""

import base64
import json
import os
import statistics
import time
import urllib.request

import cv2
import numpy as np

PORT = os.environ.get("FACES_PORT", "8765")
URL = f"http://127.0.0.1:{PORT}/detect"
N = 20


def sample_jpeg() -> str:
    img = np.zeros((768, 768, 3), dtype=np.uint8)
    for c in range(3):
        img[:, :, c] = np.tile(np.linspace(0, 255, 768, dtype=np.uint8), (768, 1))
    noise = np.random.default_rng(7).integers(0, 30, (768, 768, 3), dtype=np.uint8)
    img = cv2.add(img, noise)
    cv2.circle(img, (384, 384), 120, (200, 200, 200), -1)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    assert ok
    return base64.b64encode(buf.tobytes()).decode("ascii")


def post(payload: bytes) -> tuple[int, float]:
    req = urllib.request.Request(URL, data=payload, headers={"content-type": "application/json"})
    t0 = time.monotonic()
    with urllib.request.urlopen(req, timeout=30) as res:
        body = json.loads(res.read().decode("utf8"))
    return int(body.get("ms", -1)), (time.monotonic() - t0) * 1000


def main() -> None:
    payload = json.dumps({"imageBase64": sample_jpeg()}).encode("utf8")
    print(f"POSTing {N} synthetic 768px frames to {URL} ...")
    server_ms, rtt_ms = [], []
    for _ in range(N):
        s, r = post(payload)
        server_ms.append(s)
        rtt_ms.append(r)
    print(f"server ms: p50={statistics.median(server_ms):.0f} p95={sorted(server_ms)[int(0.95 * N) - 1]:.0f}")
    print(f"client rtt ms: p50={statistics.median(rtt_ms):.0f} p95={sorted(rtt_ms)[int(0.95 * N) - 1]:.0f}")
    print("(no-face frames: pipeline floor; with-face cost needs real photos)")


if __name__ == "__main__":
    main()
