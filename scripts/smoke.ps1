# Cold-start check for the demo laptop (Windows).
# Usage: from repo root  .\scripts\smoke.ps1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "== RoverTwin smoke ==" -ForegroundColor Cyan
if (-not (Test-Path .venv)) {
  Write-Host "Creating .venv…"
  python -m venv .venv
}
$py = Join-Path $Root ".venv\Scripts\python.exe"
& $py -m pip install -q -r requirements.txt
Write-Host "pytest…"
& $py -m pytest -q
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$port = 8765
$proc = Start-Process -FilePath $py -ArgumentList "-m","uvicorn","backend.app:app","--port",$port `
  -PassThru -WindowStyle Hidden -RedirectStandardOutput "$env:TEMP\rt_smoke_out.txt" -RedirectStandardError "$env:TEMP\rt_smoke_err.txt"
try {
  $ok = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    try {
      $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/api/state" -TimeoutSec 2
      if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch {}
  }
  if (-not $ok) {
    Write-Host "uvicorn failed to answer on :$port" -ForegroundColor Red
    Get-Content "$env:TEMP\rt_smoke_err.txt" -ErrorAction SilentlyContinue
    exit 1
  }
  Write-Host "OK  pytest + http://127.0.0.1:$port/api/state" -ForegroundColor Green
} finally {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
