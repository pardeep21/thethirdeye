$ErrorActionPreference = "Stop"
# Start the faces sidecar: creates apps/faces/.venv on first run, installs
# requirements, serves 127.0.0.1:FACES_PORT (default 8765).
Set-Location $PSScriptRoot
$py = ".\.venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
  if (Get-Command uv -ErrorAction SilentlyContinue) { uv venv --python 3.12 .venv }
  else { py -3.12 -m venv .venv }
}
if (Get-Command uv -ErrorAction SilentlyContinue) { uv pip install --python $py -r requirements.txt }
else { & $py -m pip install -r requirements.txt }
$port = if ($env:FACES_PORT) { $env:FACES_PORT } else { "8765" }
$env:PYTHONIOENCODING = "utf-8"
& $py -m uvicorn app:app --host 127.0.0.1 --port $port
