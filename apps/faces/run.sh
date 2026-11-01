#!/usr/bin/env bash
# Start the faces sidecar (see run.ps1 for the Windows twin).
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  if command -v uv >/dev/null; then uv venv --python 3.12 .venv;
  else python3.12 -m venv .venv; fi
fi
if command -v uv >/dev/null; then uv pip install --python .venv/bin/python -r requirements.txt;
else .venv/bin/python -m pip install -r requirements.txt; fi
export PYTHONIOENCODING=utf-8
exec .venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port "${FACES_PORT:-8765}"
