# Bakes the VPS release APK with its server URL + token.
#
# Why this script exists: EXPO_PUBLIC_* vars are inlined into the JS bundle
# at bundle time, but Gradle does not track env vars as task inputs. Running
# raw `./gradlew assembleRelease` after only changing env vars reuses the
# previous bundle (task UP-TO-DATE) and ships stale values with a fresh APK
# timestamp. This script forces a clean rebundle and then verifies the APK's
# bundled JS actually contains the intended URL + token before you install it.
#
# Usage (from anywhere in the repo checkout):
#   .\apps\mobile\scripts\bake-release.ps1 -ServerUrl "wss://eye.example.com" -AppToken "<APP_TOKEN>"
# Or with env vars already set (same values the docs used to set by hand):
#   $env:EXPO_PUBLIC_SERVER_URL = "wss://eye.example.com"
#   $env:EXPO_PUBLIC_APP_TOKEN = "<APP_TOKEN>"
#   .\apps\mobile\scripts\bake-release.ps1
#
# To re-check an existing APK without rebuilding:
#   .\apps\mobile\scripts\bake-release.ps1 -VerifyOnly -ServerUrl ... -AppToken ...
#
# The token is never printed; verification reports found/not-found only.
param(
  [string]$ServerUrl = $env:EXPO_PUBLIC_SERVER_URL,
  [string]$AppToken = $env:EXPO_PUBLIC_APP_TOKEN,
  [switch]$VerifyOnly,
  [string]$ApkPath = ""
)

$ErrorActionPreference = "Stop"

function Fail([string]$msg) {
  Write-Host "BAKE FAILED: $msg" -ForegroundColor Red
  exit 1
}

# Fail fast on missing or placeholder values, before any slow build step.
if ([string]::IsNullOrWhiteSpace($ServerUrl)) {
  Fail "ServerUrl is empty. Pass -ServerUrl or set `$env:EXPO_PUBLIC_SERVER_URL first."
}
if ([string]::IsNullOrWhiteSpace($AppToken)) {
  Fail "AppToken is empty. Pass -AppToken or set `$env:EXPO_PUBLIC_APP_TOKEN first."
}
if ($ServerUrl.Contains("<") -or $ServerUrl.Contains(">") -or $AppToken.Contains("<") -or $AppToken.Contains(">")) {
  Fail "URL or token still contains a <placeholder>. Fill in the real VPS values."
}
if (-not $ServerUrl.StartsWith("wss://")) {
  Write-Host "WARNING: ServerUrl does not start with wss:// - plain ws:// sends the token unencrypted." -ForegroundColor Yellow
}

$mobileDir = Split-Path $PSScriptRoot -Parent
$repoRoot = Split-Path $mobileDir -Parent
$defaultApk = Join-Path $mobileDir "android\app\build\outputs\apk\release\app-release.apk"
if ([string]::IsNullOrWhiteSpace($ApkPath)) { $ApkPath = $defaultApk }

Add-Type -AssemblyName System.IO.Compression.FileSystem

# Reads assets/index.android.bundle (Hermes bytecode; ASCII strings are stored
# contiguously) straight out of the APK zip and checks the bake. Prints
# booleans only - never the token.
function Test-ApkBake([string]$apk, [string]$url, [string]$token) {
  if (-not (Test-Path $apk)) { Fail "APK not found at $apk" }
  $info = Get-Item $apk
  Write-Host ("APK: {0} ({1} bytes, built {2})" -f $apk, $info.Length, $info.LastWriteTime)
  $zip = [IO.Compression.ZipFile]::OpenRead($apk)
  try {
    $entry = $zip.GetEntry("assets/index.android.bundle")
    if ($null -eq $entry) { Fail "APK has no assets/index.android.bundle entry." }
    $stream = $entry.Open()
    try {
      $mem = New-Object IO.MemoryStream
      $stream.CopyTo($mem)
      $text = [Text.Encoding]::GetEncoding("iso-8859-1").GetString($mem.ToArray())
    } finally { $stream.Dispose() }
  } finally { $zip.Dispose() }
  $urlOk = $text.Contains($url)
  $tokenOk = $text.Contains($token)
  Write-Host ("bundle contains server URL: " + $urlOk)
  Write-Host ("bundle contains app token:  " + $tokenOk)
  if (-not $urlOk) { Fail "APK bundle lacks $url - it was built with different env (stale bundle?). Rebuild via this script." }
  if (-not $tokenOk) { Fail "APK bundle lacks the given token - it was built with different env (stale bundle?). Rebuild via this script." }
  Write-Host "APK bake verified." -ForegroundColor Green
}

if ($VerifyOnly) {
  Test-ApkBake $ApkPath $ServerUrl $AppToken
  exit 0
}

# Never build under a subst drive: substed paths mix roots (T:\ vs D:\...),
# which breaks :react-native-vision-camera:generateCodegenSchemaFromJavaScript
# ("this and base files have different roots"). Build on the real path;
# Windows long-path support (LongPathsEnabled) covers the old 260-char
# ninja limit instead.
$substList = @((subst 2>$null))
foreach ($line in $substList) {
  if ($line -match '^([A-Z]:\\)\s*=>') {
    $sub = $Matches[1]
    if ($repoRoot.StartsWith($sub, [StringComparison]::OrdinalIgnoreCase)) {
      Fail ("Repo is under subst drive $sub - remove it (subst $sub /d) and rerun on the real path.")
    }
  }
}

# Bake: stop the daemon (it holds old env), clean (env-only changes never
# invalidate the bundle task), rebuild.
$env:EXPO_PUBLIC_SERVER_URL = $ServerUrl
$env:EXPO_PUBLIC_APP_TOKEN = $AppToken
Write-Host ("Baking with server URL: " + $ServerUrl)
Write-Host ("Baking with app token: <set, {0} chars, not shown>" -f $AppToken.Length)

$androidDir = Join-Path $mobileDir "android"
if (-not (Test-Path (Join-Path $androidDir "gradlew.bat"))) { Fail "gradlew.bat not found at $androidDir" }
Push-Location $androidDir
try {
  Write-Host "Stopping Gradle daemon (drops cached env)..."
  & .\gradlew.bat --stop
  Write-Host "Clean + assembleRelease (forced rebundle)..."
  & .\gradlew.bat clean assembleRelease
  if ($LASTEXITCODE -ne 0) { Fail "gradlew clean assembleRelease exited with code $LASTEXITCODE." }
} finally { Pop-Location }

Test-ApkBake $ApkPath $ServerUrl $AppToken
Write-Host ("Install: " + $ApkPath)
