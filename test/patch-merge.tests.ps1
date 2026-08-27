# Structural tests for the cordis.patch.yml merge logic shipped in install.ps1.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test/patch-merge.tests.ps1
#   pwsh        -NoProfile -File test/patch-merge.tests.ps1
#
# The merge region is lifted out of install.ps1 by its markers, so this always
# exercises the shipping code. Assertions are structural: the expected verdict,
# the number of id: rows, text that must survive, no stray bracket line left,
# a second run that changes nothing (idempotence), and foreign shapes untouched.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $root 'install.ps1'
$lf = [string][char]10
$work = Join-Path $env:TEMP ('dsh-memory-merge-test-' + (Get-Random -Maximum 99999))
New-Item -ItemType Directory -Force -Path $work | Out-Null

# --- lift the merge functions out of the installer --------------------------
$src = Get-Content -LiteralPath $installer -Raw -Encoding UTF8
$i0 = $src.IndexOf('# >>> PATCH-MERGE BEGIN')
$i1 = $src.IndexOf('# <<< PATCH-MERGE END')
if (($i0 -lt 0) -or ($i1 -le $i0)) { throw 'merge markers not found in install.ps1' }
$fnFile = Join-Path $work 'merge-fn.ps1'
Set-Content -LiteralPath $fnFile -Value $src.Substring($i0, $i1 - $i0) -Encoding UTF8
. $fnFile

# --- fixtures ---------------------------------------------------------------
$block = @(
  '# --- dsh-memory: global auto-memory plugin (installed by the dsh-memory installer) ---',
  '- insert:',
  '    - id: dsh-memory',
  '      name: ./plugins/memory/index.js',
  '      config: {}'
)
$H = '# Your patch layer for this dsh profile, applied after every bundle layer:' + $lf
$mem = '# --- dsh-memory: global auto-memory plugin (installed by the dsh-memory installer) ---' + $lf + '- insert:' + $lf + '    - id: dsh-memory' + $lf + '      name: ./plugins/memory/index.js' + $lf + '      config: {}' + $lf
$wf = '- insert:' + $lf + '    - id: wait-float' + $lf + '      name: ./plugins/wait-float/index.js' + $lf + '      config: {}' + $lf
$cmt = '# a note from me' + $lf + '# another note' + $lf
$client = '- insert:' + $lf + '    - id: dsh-memory-client' + $lf + '      name: client' + $lf
$han = [string][char]25105 + [string][char]30340 + [string][char]34917
$broken = $H + '[]' + $lf + $lf + $mem

$cases = @(
  @{ Name = 'fresh default template (comments plus empty list)'; In = $H + '[]' + $lf; Action = 'registered'; N = 1; Keep = '# Your patch layer' },
  @{ Name = 'broken by the pre-v2 installer';                     In = $broken;        Action = 'repaired';   N = 1; Keep = '# --- dsh-memory' },
  @{ Name = 'existing block entries';                             In = $H + $wf + $lf; Action = 'registered'; N = 2; Keep = '# Your patch layer' },
  @{ Name = 'comments only';                                      In = $cmt;           Action = 'registered'; N = 1; Keep = '# a note from me' },
  @{ Name = 'empty file';                                         In = '';             Action = 'registered'; N = 1; Keep = '# Your patch layer' },
  @{ Name = 'no file at all';                                     In = $null;          Action = 'created';    N = 1; Keep = '# Your patch layer' },
  @{ Name = 'client row registered, plugin row not';              In = $H + $client;   Action = 'registered'; N = 2; Keep = 'dsh-memory-client' },
  @{ Name = 'already registered and clean';                       In = $H + $mem;      Action = 'skip';       N = 1; Keep = '# --- dsh-memory' },
  @{ Name = 'CRLF file with non-ascii comments';                  In = ('# ' + $han + $lf + '[]' + $lf); Action = 'registered'; N = 1; Keep = ('# ' + $han) },
  @{ Name = 'top-level mapping must be left alone';               In = 'id: foo' + $lf + 'config: {}' + $lf; Action = 'manual'; N = 0; Keep = 'id: foo' },
  @{ Name = 'stray bracket line next to real entries';            In = $cmt + '[]' + $lf + $wf; Action = 'registered'; N = 2; Keep = '# a note from me' }
)

function Count-IdRows([string]$Text) {
  return @($Text -split '(?m)^[ \t]*-[ \t]*id:[ \t]').Count - 1
}

$fail = 0
foreach ($c in $cases) {
  $file = Join-Path $work 'cordis.patch.yml'
  if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
  if ($null -ne $c.In) { Set-Content -LiteralPath $file -Value $c.In -Encoding UTF8 -NoNewline }
  $before = ''
  if (Test-Path -LiteralPath $file) { $before = Get-Content -LiteralPath $file -Raw -Encoding UTF8 }
  $m = Merge-PatchFile -Path $file -Block $block -IdName 'dsh-memory'
  if ($m.Changed) { $null = Write-PatchFile -Path $file -Text $m.Text }
  $text = ''
  if (Test-Path -LiteralPath $file) { $text = Get-Content -LiteralPath $file -Raw -Encoding UTF8 }
  $text = $text -replace '^\uFEFF', ''
  $before = $before -replace '^\uFEFF', ''
  $notes = @()
  if ($m.Action -ne $c.Action) { $notes += ('action=' + $m.Action + ' expected=' + $c.Action) }
  $rows = Count-IdRows $text
  if ($rows -ne $c.N) { $notes += ('id-rows=' + $rows + ' expected=' + $c.N) }
  if ($c.Keep -and ($text -notlike ('*' + $c.Keep + '*'))) { $notes += ('lost text: ' + $c.Keep) }
  $stray = @($text -split $lf | Where-Object { $_ -match '^\[[ \t]*\]$' })
  if ($c.N -gt 0 -and $stray.Count -gt 0) { $notes += ('stray bracket line survived: ' + $stray.Count) }
  # Re-running must be a no-op once the entry is in place. (A refused 'manual'
  # file keeps refusing, and a file the installer created is only re-checked
  # through the registered cases above.)
  if ($c.Action -in @('registered', 'repaired', 'skip')) {
    $again = Merge-PatchFile -Path $file -Block $block -IdName 'dsh-memory'
    if ($again.Changed) { $notes += 'second run changed the file again (not idempotent)' }
    if ($again.Action -ne 'skip') { $notes += ('second run action=' + $again.Action + ' expected=skip') }
  }
  if (($c.Action -eq 'manual') -or ($c.Action -eq 'skip')) {
    if ($text -ne $before) { $notes += 'file was modified but must stay untouched' }
  }
  $ok = ($notes.Count -eq 0)
  if (-not $ok) { $fail++ }
  $tag = 'PASS'; if (-not $ok) { $tag = 'FAIL' }
  $color = 'DarkGray'; if (-not $ok) { $color = 'Red' }
  Write-Host ('  ' + $tag + '  ' + $c.Name + '   ' + ($notes -join '; ')) -ForegroundColor $color
}

Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
Write-Host ''
if ($fail -gt 0) {
  Write-Host ('{0} of {1} cases FAILED (PowerShell {2})' -f $fail, $cases.Count, $PSVersionTable.PSVersion) -ForegroundColor Red
  exit 1
}
Write-Host ('all {0} merge cases passed (PowerShell {1})' -f $cases.Count, $PSVersionTable.PSVersion) -ForegroundColor Green
exit 0
