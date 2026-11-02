# TheThirdEye faces sidecar (Python 3.12 slim). YuNet detection + ArcFace
# embeddings over HTTP. Runs on the compose internal network only: the
# server reaches it at http://faces:8765, nothing is published publicly.
#
# Build with apps/faces as the context (it has its own .dockerignore):
#   docker build -f apps/faces/Dockerfile -t thethirdeye-faces apps/faces
# NOTE: this image is several GB (TF + OpenCV + weights) and takes a
# while to build. Small VPSes should use docker-compose.stub.yml instead.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
  PYTHONUNBUFFERED=1 \
  PYTHONIOENCODING=utf-8 \
  TF_CPP_MIN_LOG_LEVEL=2 \
  PIP_NO_CACHE_DIR=1

# libgl1 + libglib: opencv-contrib wheels need them on slim.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/faces
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py ./

# Pre-download ArcFace + YuNet weights so first boot is fast (they land in
# /root/.deepface, baked into this layer; the service runs as root too).
RUN python -c "import numpy as np; from deepface import DeepFace; \
  DeepFace.represent(img_path=np.zeros((256, 256, 3), dtype=np.uint8), \
  model_name='ArcFace', detector_backend='yunet', \
  enforce_detection=False, align=True); \
  print('weights pre-downloaded')"

EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8765/health').status == 200 else 1)"
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8765"]
