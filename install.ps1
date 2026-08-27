# dsh-memory installer for Windows (PowerShell)
# One-line install:
#   irm https://raw.githubusercontent.com/Starry0214/dsh-memory/main/install.ps1 | iex
# Options (pass as env vars before piping, or edit below):
#   DSH_HOME      - DSH home dir (default: ~/.dsh or $env:DSH_HOME)
#   DSH_PROFILE   - profile name (default: web)
#   DSH_MEMORY_RAW - raw file base URL (default: GitHub raw)
[CmdletBinding()]
param(
  [string]$ProfileName = "",
  [switch]$SkipPrompt
)

$ErrorActionPreference = "Stop"
$RAW_BASE = if ($env:DSH_MEMORY_RAW) { $env:DSH_MEMORY_RAW.TrimEnd('/') } else { 'https://raw.githubusercontent.com/Starry0214/dsh-memory/main' }
$DSH_HOME = if ($env:DSH_HOME) { $env:DSH_HOME } elseif ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.dsh' } else { Join-Path $HOME '.dsh' }
$PROFILE_NAME = if ($ProfileName) { $ProfileName } elseif ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'web' }

Write-Host 'dsh-memory installer'
Write-Host ('  DSH_HOME : ' + $DSH_HOME)
Write-Host ('  profile  : ' + $PROFILE_NAME)
Write-Host ''

# 1. Validate DSH home
if (-not (Test-Path (Join-Path $DSH_HOME 'profiles'))) {
  Write-Host 'ERROR: no profiles directory found under ' + $DSH_HOME -ForegroundColor Red
  Write-Host 'Make sure DSH is installed and DSH_HOME points to the right place.' -ForegroundColor Yellow
  exit 1
}

# 2. Validate profile
$profileDir = Join-Path $DSH_HOME 'profiles' $PROFILE_NAME
if (-not (Test-Path $profileDir)) {
  $available = (Get-ChildItem (Join-Path $DSH_HOME 'profiles') -Directory | Select-Object -ExpandProperty Name) -join ', '
  Write-Host ('ERROR: profile ''' + $PROFILE_NAME + ''' not found. Available: ' + $available) -ForegroundColor Red
  Write-Host 'Set DSH_PROFILE (or pass -Profile) to one of them and retry.' -ForegroundColor Yellow
  exit 1
}

# 3. Create plugin dir and download index.js
$pluginDir = Join-Path $profileDir 'plugins' 'memory'
New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
$target = Join-Path $pluginDir 'index.js'

function Download-File($url, $dest) {
  try {
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 60
    return $true
  } catch {
    return $false
  }
}

Write-Host 'Downloading index.js ...'
if (-not (Download-File ($RAW_BASE + '/index.js') $target)) {
  Write-Host 'GitHub raw failed, trying jsDelivr CDN ...' -ForegroundColor Yellow
  if (-not (Download-File 'https://cdn.jsdelivr.net/gh/Starry0214/dsh-memory@main/index.js' $target)) {
    Write-Host 'ERROR: failed to download index.js. Check your network / proxy.' -ForegroundColor Red
    exit 1
  }
}
Write-Host ('  OK: ' + $target) -ForegroundColor Green

# 4. Register plugin in cordis.patch.yml (idempotent)
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
$INSERT_BLOCK = @"
# --- dsh-memory: global auto-memory plugin (installed by dsh-memory installer) ---
- insert:
    - id: dsh-memory
      name: ./plugins/memory/index.js
      config: {}
"@

if (-not (Test-Path $patchFile)) {
  Set-Content -Path $patchFile -Value $INSERT_BLOCK -Encoding UTF8
  Write-Host ('Created ' + $patchFile + ' with dsh-memory registration.') -ForegroundColor Green
} else {
  $existing = Get-Content $patchFile -Raw
  if ($existing -match 'id:\s*dsh-memory') {
    Write-Host ('dsh-memory already registered in ' + $patchFile + ' (skipped).') -ForegroundColor Green
  } else {
    $content = $existing.TrimEnd() + "`r`n`r`n" + $INSERT_BLOCK + "`r`n"
    Set-Content -Path $patchFile -Value $content -Encoding UTF8
    Write-Host ('Appended dsh-memory registration to ' + $patchFile + '.') -ForegroundColor Green
  }
}

# 5. Verify
if (-not (Test-Path $target)) {
  Write-Host 'ERROR: index.js missing after install.' -ForegroundColor Red
  exit 1
}
$bytes = (Get-Item $target).Length
Write-Host ''
Write-Host ('dsh-memory installed successfully (index.js: ' + $bytes + ' bytes).') -ForegroundColor Green
Write-Host ''
Write-Host 'Next step: restart DSH. On startup you should see:' -ForegroundColor Cyan
Write-Host '  [dsh-memory] memory_search tool registered (ctx.tools)'
Write-Host '  [dsh-memory] injected stable layer (N sections)'
# NOTE: no interactive Read-Host here. Streaming a script with param()+Read-Host
# through 'irm ... | iex' breaks in Windows PowerShell 5.1 ("cannot find a positional
# parameter that accepts argument 'web'"). Keep this installer non-interactive so the
# one-liner pipe works everywhere. -SkipPrompt is accepted for backward compat (no-op).