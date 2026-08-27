# Repair a cordis.patch.yml that an older dsh-memory installer left unparsable.
#
# Symptom when DSH starts:
#   Error: dsh: failed to parse overlay <profile>\cordis.patch.yml: YAMLException:
#   end of the stream or a document separator is expected (N:1)
# Cause: the installer appended "- insert:" entries after the default "[]"
#   document DSH writes into a fresh profile. One YAML document cannot mix an
#   empty flow sequence with block sequence entries, so the boot fails.
#
# One-line use (downloads nothing but this script):
#   irm https://raw.githubusercontent.com/Starry0214/dsh-memory/main/fix-cordis-patch.ps1 | iex
# With parameters (after saving the file):
#   powershell -NoProfile -ExecutionPolicy Bypass -File fix-cordis-patch.ps1 -Profile web -DryRun
#   -Profile *   repair every profile of this DSH home      -DryRun  report only
#   -DshHome <path> another DSH home (default %USERPROFILE%\.dsh, or DSH_HOME)
#
# The script only ever: (a) drops column-0 "[]" lines from a file that already
# has real top-level entries (that IS the broken shape), (b) adds an empty "[]"
# back to a comments-only file (an empty document is not an array either), and
# (c) refuses to guess at any other shape. Every write keeps a timestamped backup.
[CmdletBinding()]
param(
  # DshHome, not Home: $Home is a read-only automatic variable in PowerShell.
  [string]$DshHome = "",
  [string]$Profile = "web",
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$dshHome = if ($DshHome) { $DshHome } elseif ($env:DSH_HOME) { $env:DSH_HOME } elseif ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.dsh' } else { Join-Path $HOME '.dsh' }

if (-not (Test-Path -LiteralPath (Join-Path $dshHome 'profiles'))) {
  Write-Host ('ERROR: no profiles directory under ' + $dshHome) -ForegroundColor Red
  Write-Host 'Pass -DshHome <path> or set DSH_HOME to your DSH home directory.' -ForegroundColor Yellow
  exit 1
}

$profiles = @()
if ($Profile -eq '*') {
  $profiles = @(Get-ChildItem -LiteralPath (Join-Path $dshHome 'profiles') -Directory | Select-Object -ExpandProperty Name)
}
else {
  $profiles = @($Profile)
}

# CR/LF without backtick escapes, so the script stays paste-safe.
$cr = [string][char]13
$lf = [string][char]10
$exitCode = 0

foreach ($name in $profiles) {
  # Nested 2-arg Join-Path: Windows PowerShell 5.1 has no 3-argument Join-Path.
  $patchFile = Join-Path (Join-Path (Join-Path $dshHome 'profiles') $name) 'cordis.patch.yml'
  Write-Host ('--- profile [' + $name + '] ' + $patchFile) -ForegroundColor Cyan

  if (-not (Test-Path -LiteralPath $patchFile)) {
    Write-Host '  no patch layer at all - nothing to do.' -ForegroundColor DarkGray
    continue
  }

  $raw = Get-Content -LiteralPath $patchFile -Raw -Encoding UTF8
  if ($null -eq $raw) { $raw = '' }
  $nl = $lf
  if ($raw.Contains($cr + $lf)) { $nl = $cr + $lf }
  $all = @(($raw -replace ($cr + $lf), $lf) -split $lf)
  if ($all.Count -gt 0 -and $all[$all.Count - 1] -eq '') { $all = @($all[0..($all.Count - 2)]) }

  $code = @($all | Where-Object { -not (($_ -match '^\s*$') -or ($_ -match '^\s*#')) })
  $empties = @($code | Where-Object { $_ -match '^\[[ \t]*\]$' })
  $entries = @($code | Where-Object { $_ -match '^-(\s|$)' })
  $foreign = @($code | Where-Object { -not (($_ -match '^-(\s|$)') -or ($_ -match '^\[[ \t]*\]$') -or ($_ -match '^[ \t]+\S')) })

  if ($foreign.Count -gt 0) {
    Write-Host ('  UNRECOGNISED shape - ' + $foreign.Count + ' line(s) are neither a top-level entry nor indented text:') -ForegroundColor Red
    foreach ($l in @($foreign | Select-Object -First 5)) { Write-Host ('    ' + $l) -ForegroundColor Red }
    Write-Host '  Nothing was changed. This file must be ONE top-level YAML array; edit it by hand.' -ForegroundColor Yellow
    $exitCode = 1
    continue
  }

  if (($empties.Count -gt 0) -and ($entries.Count -gt 0)) {
    $keep = @($all | Where-Object { $_ -notmatch '^\[[ \t]*\]$' })
    Write-Host ('  BROKEN: ' + $empties.Count + " stray '[]' line(s) next to " + $entries.Count + ' top-level entries.') -ForegroundColor Yellow
    if ($DryRun) {
      Write-Host '  (dry run - not written)' -ForegroundColor DarkGray
    }
    else {
      $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
      $backup = $patchFile + '.bak-' + $stamp
      Copy-Item -LiteralPath $patchFile -Destination $backup -Force
      Set-Content -LiteralPath $patchFile -Value (($keep -join $nl) + $nl) -Encoding UTF8 -NoNewline
      Write-Host ('  REPAIRED. Backup: ' + $backup) -ForegroundColor Green
    }
  }
  elseif ($code.Count -eq 0) {
    Write-Host '  BROKEN: comments-only file - an empty document is not a top-level array.' -ForegroundColor Yellow
    if ($DryRun) {
      Write-Host '  (dry run - not written)' -ForegroundColor DarkGray
    }
    else {
      $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
      $backup = $patchFile + '.bak-' + $stamp
      Copy-Item -LiteralPath $patchFile -Destination $backup -Force
      $fixed = @($all) + @('[]')
      Set-Content -LiteralPath $patchFile -Value (($fixed -join $nl) + $nl) -Encoding UTF8 -NoNewline
      Write-Host ('  REPAIRED (added an empty [] list). Backup: ' + $backup) -ForegroundColor Green
    }
  }
  elseif ($empties.Count -gt 0) {
    Write-Host "  clean: an empty [] patch layer, no plugin registered." -ForegroundColor DarkGray
  }
  else {
    Write-Host ('  clean: ' + $entries.Count + ' top-level entries, no stray [].') -ForegroundColor DarkGray
  }
}

Write-Host ''
if ($DryRun) { Write-Host 'Dry run only - no file was written.' -ForegroundColor DarkGray }
else { Write-Host 'Start DSH again to check: npx @deepseek-ai/dsh web' -ForegroundColor Cyan }
exit $exitCode
