# dsh-memory installer v4 for Windows (Windows PowerShell 5.1 and PowerShell 7+)
#
# One-line install / upgrade (idempotent - re-run the same command to upgrade):
#   irm https://raw.githubusercontent.com/Starry0214/dsh-memory/main/install.ps1 | iex
#
# Modes:
#   (default)        install or upgrade the plugin; seed the memory library; merge the
#                    cordis.patch.yml registration; decide `memoryTopicDbEnabled`
#   -CheckOnly       read-only health report: plugin/payload/memtopic/DB/legacy md/
#                    .config.json/AGENTS.md/host compatibility/patch registration and
#                    the migration state (delegated to memtopic/src/migrate.mjs --detect --json)
#   -Migrate         old md memory library -> topic database (delegates to
#                    <plugin>/memtopic/src/migrate.mjs; the installer never reimplements it)
#                    without --yes: print the migration report + the exact next command
#                    with  --yes: run --apply --yes (requires DSH to be stopped; use
#                                 -AssumeHostStopped for a stale lock file)
#   -Uninstall       unregister the plugin (timestamped backup + conservative patch surgery);
#                    the memory library under ~/.dsh/memory is NEVER touched
#
# Target profiles (desktop-first fix 2026-10-30; a fresh user used to get "web" and the
# desktop app then loaded nothing, silently):
#   1) -ProfileName <name>  -> exactly that profile
#   2) otherwise auto-discover every profile whose cordis.patch.yml already has
#      `- id: dsh-memory` (App + CLI can coexist; all get the same version)
#   3) fresh user -> "desktop" if present, else "web"
#   $env:DSH_PROFILE is only logged, never overrides discovery.
#
# Options:
#   -ProfileName <name>   explicit target profile (see above)
#   -LocalPayload <zip>   offline install from a local payload zip; install-manifest.json
#                         must sit in the same directory or its parent
#   -Apply / -Rollback    with -Migrate: apply / rollback
#   -Merge                with -Migrate: pass --merge (the DB already has data)
#   -AssumeHostStopped    with -Migrate: pass --assume-host-stopped (stale lock file)
#   -RawBase <url>        override the download base (mirror / local http server)
#   -SkipPrompt           legacy no-op (this installer never prompts)
#
# Environment variables: DSH_HOME, DSH_PROFILE (log hint only), DSH_MEMORY_RAW,
#                        DSH_MEMORY_LOCAL (payload zip), DSH_MEMORY_MANIFEST (explicit manifest
#                        path for offline installs), DSH_MEMORY_NODE (node executable override)
#
# v4 (2026-10-30): payload zip (index.js + client/** + memtopic/src/*.mjs) with per-file
#   sha256 verification, backup, multi-profile discovery, topic-db flag, migration hand-off
#   (pending marker when DSH is running) and the AGENTS.md v4 template.
#   The cordis.patch.yml merge logic (PATCH-MERGE region below) is semantically unchanged
#   from v2/v3 and is still covered by test/patch-merge.tests.ps1.
#
[CmdletBinding()]
param(
  [string]$ProfileName = ""
  ,[switch]$SkipPrompt
  # -CheckOnly: 只体检不改动（插件/发布版本、payload 逐文件 sha、memtopic、DB、遗留 md、
  #             .config.json 开关、AGENTS.md 版本、宿主兼容、patch 层注册、迁移状态）
  ,[switch]$CheckOnly
  # -Migrate: 老用户旧 md 记忆库 -> 主题库（转交 memtopic/src/migrate.mjs）
  ,[switch]$Migrate
  # -Uninstall: 注销插件（不动记忆库数据）
  ,[switch]$Uninstall
  # -LocalPayload <zip>: 离线安装（zip 同目录或上一级要有 install-manifest.json）
  ,[string]$LocalPayload = ""
  # -Migrate 的附加动作
  ,[switch]$Apply
  ,[switch]$Rollback
  ,[switch]$Merge
  ,[switch]$AssumeHostStopped
  # -RawBase <url>: 覆盖下载源（内网镜像/本地 http 服务）
  ,[string]$RawBase = ""
  # 兼容 "install.ps1 -Migrate --yes" 这种 Unix 风格写法：未知参数落在这里
  ,[Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# >>> PATCH-MERGE BEGIN (self-contained region; the repo test suite extracts
#     it between these markers and runs it against fixture files)
# ---------------------------------------------------------------------------

# The comment header DSH writes into a fresh profile's patch layer, reused
# when this installer has to create the file from scratch.
function Get-PatchHeader {
  return @(
    '# Your patch layer for this dsh profile, applied after every bundle layer:',
    '# a top-level YAML array of loader patch entries (id-targeted config',
    '# overrides, disables, and insert lists; `!!js` expressions allowed.'
  )
}

# True when a line is blank or a whole-line YAML comment.
function Test-YamlNoise([string]$Line) {
  return (($Line -match '^\s*$') -or ($Line -match '^\s*#'))
}

# Merge one plugin registration block into a cordis.patch.yml document.
#
# Rules, in order:
#   1. every column-0 `[]` line is dropped - it is either the default empty
#      document (replaced by the entries below) or the invalid remnant an older
#      installer left next to real entries;
#   2. nothing is inserted when the id is already registered;
#   3. the block is appended only when every remaining code line is a top-level
#      `- ` entry or indented continuation text - i.e. the document really is a
#      block sequence (or carries no content at all);
#   4. anything else (a mapping, a non-empty flow list, tab indentation, a
#      second document) is left byte-for-byte untouched and reported as 'manual'.
#
# Returns a hashtable: Action (created|registered|repaired|skip|manual),
# Detail, Changed, Text (final content, set only when Changed), Newline.
function Merge-PatchFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string[]]$Block,
    [string]$IdName = 'dsh-memory'
  )

  $r = @{ Action = 'unknown'; Detail = ''; Changed = $false; Text = ''; Newline = "`r`n" }

  if (-not (Test-Path -LiteralPath $Path)) {
    $lines = @(Get-PatchHeader) + @('') + $Block
    $r.Action = 'created'
    $r.Detail = 'the profile had no cordis.patch.yml yet'
    $r.Changed = $true
    $r.Text = ($lines -join "`r`n") + "`r`n"
    return $r
  }

  $raw = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
  if ($null -eq $raw) { $raw = '' }
  $nl = "`n"
  if ($raw -match "`r`n") { $nl = "`r`n" }
  $r.Newline = $nl

  # Split, then drop the single empty element a trailing newline produces.
  $all = @($raw -split "`r?`n")
  if ($all.Count -gt 0 -and $all[$all.Count - 1] -eq '') {
    $all = @($all[0..($all.Count - 2)])
  }

  # 1. Drop every column-0 empty flow sequence (`[]`, `[ ]`).
  $keep = @()
  $dropped = 0
  foreach ($line in $all) {
    if ($line -match '^\[[ \t]*\]$') { $dropped++; continue }
    $keep += $line
  }

  # 2. Already registered? Match the real list entry only - 'dsh-memory-client'
  #    must not count as 'dsh-memory'.
  $keepText = $keep -join "`n"
  $idPattern = '(?m)^[ \t]*-[ \t]*id:[ \t]*' + $IdName + '[ \t]*($|#)'
  if ($keepText -match $idPattern) {
    if ($dropped -gt 0) {
      $r.Action = 'repaired'
      $r.Detail = "$dropped stray '[]' line(s) removed; $IdName was already registered"
      $r.Changed = $true
      $r.Text = ($keep -join $nl) + $nl
    }
    else {
      $r.Action = 'skip'
      $r.Detail = "$IdName is already registered"
    }
    return $r
  }

  # 3. Shape check on what is left.
  $restCode = @()
  foreach ($line in $keep) {
    if (-not (Test-YamlNoise $line)) { $restCode += $line }
  }
  $foreign = @($restCode | Where-Object { -not (($_ -match '^-(\s|$)') -or ($_ -match '^[ \t]+\S')) })
  if ($foreign.Count -gt 0) {
    $r.Action = 'manual'
    if ($dropped -gt 0) {
      $r.Detail = "unrecognised top-level YAML alongside $dropped stray '[]' line(s) - the file was NOT modified"
    }
    else {
      $r.Detail = 'the document is not a top-level block sequence (non-empty flow list, mapping, tabs or a second document?) - the file was NOT modified'
    }
    return $r
  }

  # 4. Append after trimming trailing BLANK lines only (never a user comment),
  #    with one blank separator. A wholly blank file gets the standard header.
  $end = $keep.Count
  while ($end -gt 0 -and $keep[$end - 1] -match '^\s*$') { $end-- }
  $body = @()
  if ($end -gt 0) { $body = @($keep[0..($end - 1)]) + @('') + $Block }
  else { $body = @(Get-PatchHeader) + @('') + $Block }

  # 5. Final validation of the produced shape (defence against a logic slip).
  $outCode = @()
  foreach ($line in $body) {
    if (-not (Test-YamlNoise $line)) { $outCode += $line }
  }
  $bad = @($outCode | Where-Object { -not (($_ -match '^-(\s|$)') -or ($_ -match '^[ \t]+\S')) })
  if ($outCode.Count -eq 0 -or $bad.Count -gt 0) {
    $r.Action = 'manual'
    $r.Detail = 'the merged result failed the shape check - the file was NOT modified'
    return $r
  }

  $how = 'appended to the existing entry list'
  if ($restCode.Count -eq 0 -and $dropped -gt 0) { $how = "replaced the empty '[]' document" }
  elseif ($restCode.Count -eq 0 -and $keep.Count -eq 0) { $how = 'wrote a standard header plus the entry (the file was blank)' }
  elseif ($restCode.Count -eq 0) { $how = 'filled a comments-only document' }
  elseif ($dropped -gt 0) { $how = "removed $dropped stray '[]' line(s), then appended" }

  $r.Action = 'registered'
  $r.Detail = $how
  $r.Changed = $true
  $r.Text = ($body -join $nl) + $nl
  return $r
}

# Write a merged patch layer, keeping a timestamped backup of the original.
function Write-PatchFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Text
  )
  $backup = ''
  if (Test-Path -LiteralPath $Path) {
    $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
    $backup = "$Path.bak-$stamp"
    Copy-Item -LiteralPath $Path -Destination $backup -Force
  }
  Set-Content -LiteralPath $Path -Value $Text -Encoding UTF8 -NoNewline
  return $backup
}

# <<< PATCH-MERGE END
# ---------------------------------------------------------------------------

# ===========================================================================
# Context / constants
# ===========================================================================
$RAW_BASE = 'https://raw.githubusercontent.com/Starry0214/dsh-memory/main'
if ($env:DSH_MEMORY_RAW) { $RAW_BASE = $env:DSH_MEMORY_RAW.TrimEnd('/') }
if ($RawBase) { $RAW_BASE = $RawBase.TrimEnd('/') }
$CDN_BASE = 'https://cdn.jsdelivr.net/gh/Starry0214/dsh-memory@main'
if ($env:DSH_MEMORY_CDN) { $CDN_BASE = $env:DSH_MEMORY_CDN.TrimEnd('/') }

$DSH_HOME = if ($env:DSH_HOME) { $env:DSH_HOME.TrimEnd('\', '/') }
            elseif ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.dsh' }
            else { Join-Path $HOME '.dsh' }
$PROFILE_NAME = if ($ProfileName) { $ProfileName } else { '' }
if ($env:DSH_MEMORY_LOCAL -and -not $LocalPayload) { $LocalPayload = $env:DSH_MEMORY_LOCAL }

# AGENTS.md 旧模板白名单（归一化：去 BOM / CRLF->LF / 行尾空白 / 尾部空行，
# SHA256 见 docs/AGENTS.template.v3.md 与 v3 安装器内嵌文本 —— 三者同源，已实测同 sha）。
$AGENTS_LEGACY_SHA = @(
  'c7de0f75062511ac13321de6a321dab7f6aef89969d24eb31f55a1781c8a529e',  # v3 模板（repo / install.ps1 / install.sh 内嵌均相同）
  '3ffc27938d118a5db6cbe3b48242ee30a17ee73694ea2349a2e5f246062c4365',  # v3 pre-fixedrm 变体
  '45463dd54b87c890bd7fd8e11a96a80ebeab96ffb597c77a93d8247d1d662e58'   # v4 原模板（4.0.1 时代，无 memory_note）→ 4.5 升级时自动替换为含会话笔记的新模板
)
$AGENTS_V4_MARKER = 'dsh-memory-agents-template: v4'

# ===========================================================================
# Output helpers
# ===========================================================================
function Write-Head([string]$Text) { Write-Host ''; Write-Host $Text -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host ('  OK   ' + $Text) -ForegroundColor Green }
function Write-Warn2([string]$Text) { Write-Host ('  WARN ' + $Text) -ForegroundColor Yellow }
function Write-Bad([string]$Text) { Write-Host ('  ERR  ' + $Text) -ForegroundColor Red }
function Write-Item([string]$Text) { Write-Host ('  ' + $Text) -ForegroundColor DarkGray }
function Write-Fact([string]$Key, [string]$Value) { Write-Host (('  {0,-14}: {1}' -f $Key, $Value)) }
function Write-Rule { Write-Host ('  ' + ('-' * 68)) -ForegroundColor DarkGray }

# ===========================================================================
# File / hash helpers
# ===========================================================================
function Read-TextFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $enc = New-Object System.Text.UTF8Encoding($false)
    return $enc.GetString($bytes)
  } catch { return $null }
}

function Read-TextFileAuto([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
  try {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
      return [System.Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2)
    }
    if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF) {
      return [System.Text.Encoding]::BigEndianUnicode.GetString($bytes, 2, $bytes.Length - 2)
    }
    $enc = New-Object System.Text.UTF8Encoding($false)
    return $enc.GetString($bytes)
  } catch { return '' }
}

function Write-TextNoBom([string]$Path, [string]$Text) {
  $dir = Split-Path -Parent $Path
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

function Get-Sha256File([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-Sha256Text([string]$Text) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  $bytes = $enc.GetBytes([string]$Text)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $hash = $sha.ComputeHash($bytes) } finally { $sha.Dispose() }
  return ([System.BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
}

# 归一化 AGENTS.md 文本，用于与旧模板白名单比对
function Get-NormalizedAgentsText([string]$Text) {
  if ($null -eq $Text) { return '' }
  $t = [string]$Text
  if ($t.Length -gt 0 -and $t[0] -eq [char]0xFEFF) { $t = $t.Substring(1) }
  $t = $t.Replace("`r`n", "`n").Replace("`r", "`n")
  $lines = @($t -split "`n")
  for ($i = 0; $i -lt $lines.Count; $i++) { $lines[$i] = ($lines[$i] -replace '[ \t]+$', '') }
  $t = $lines -join "`n"
  $t = $t -replace "`n+$", "`n"
  return $t
}

function Get-TempDir([string]$Prefix) {
  $base = [System.IO.Path]::GetTempPath()
  $p = Join-Path $base ($Prefix + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $p | Out-Null
  return $p
}

function Get-PropValue($Obj, [string]$Name) {
  if ($null -eq $Obj) { return $null }
  $p = $Obj.PSObject.Properties[$Name]
  if ($p) { return $p.Value }
  return $null
}

function ConvertTo-Boolish($Value) {
  if ($null -eq $Value) { return $false }
  if ($Value -is [bool]) { return $Value }
  return ([string]$Value -match '^(true|1|yes)$')
}

# ===========================================================================
# Context resolution (DSH home / profile discovery / plugin dirs)
#
# 目标 profile 解析顺序（Lead 裁决 2026-10-30，桌面版用户是主流）：
#   1) -ProfileName 显式指定  -> 只用它（不存在则报错并列出可用 profile）
#   2) 否则自动发现"已注册过的 profile"：profiles/*/cordis.patch.yml 里含
#      `- id: dsh-memory` 行的 profile 全部作为升级目标（App + CLI 可能同时存在）
#   3) 否则视为全新用户：desktop 存在用 desktop，否则 web，再否则第一个可用 profile
#   $env:DSH_PROFILE 只作为日志提示，不覆盖 2/3 的发现结果。
#
# 返回 @{ Ok; Error; Mode(explicit|discovered|default); Targets=@(name...);
#          Available=@(name...); Primary; MemRoot; EnvHint }
# 每个 target 用 Get-TargetContext 展开成 dirs。
# ===========================================================================
function Get-Context {
  $r = @{
    Ok = $false; Error = ''; Mode = ''; Targets = @(); Available = @()
    Primary = ''; MemRoot = (Join-Path $DSH_HOME 'memory'); EnvHint = ''
  }
  $profilesDir = Join-Path $DSH_HOME 'profiles'
  if (-not (Test-Path -LiteralPath $profilesDir -PathType Container)) {
    $r.Error = "DSH_HOME 下没有 profiles 目录：$DSH_HOME  (确认 DSH 已安装、DSH_HOME 指向正确)"
    return $r
  }
  $available = @(Get-ChildItem -LiteralPath $profilesDir -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne 'node_modules' } |
    Select-Object -ExpandProperty Name | Sort-Object)
  $r.Available = $available
  if ($available.Count -eq 0) {
    $r.Error = "DSH_HOME 下没有任何 profile 目录：$profilesDir"
    return $r
  }

  if ($ProfileName) {
    if ($available -notcontains $ProfileName) {
      $r.Error = "profile '$ProfileName' 不存在。可用：" + ($available -join ', ') + " （用 -ProfileName 指定其中之一）"
      return $r
    }
    $r.Targets = @($ProfileName)
    $r.Mode = 'explicit'
  }
  else {
    $found = @()
    foreach ($n in $available) {
      $yml = Join-Path (Join-Path $profilesDir $n) 'cordis.patch.yml'
      if (Test-Path -LiteralPath $yml -PathType Leaf) {
        $txt = Read-TextFile $yml
        if ($txt) {
          $probe = $txt -replace "`r", ''
          if ($probe -match '(?m)^[ \t]*-[ \t]*id:[ \t]*dsh-memory[ \t]*($|#)') { $found += $n }
        }
      }
    }
    if ($found.Count -gt 0) {
      $r.Targets = @($found)
      $r.Mode = 'discovered'
    }
    else {
      $pick = if ($available -contains 'desktop') { 'desktop' } elseif ($available -contains 'web') { 'web' } else { $available[0] }
      $r.Targets = @($pick)
      $r.Mode = 'default'
    }
    if ($env:DSH_PROFILE) {
      if ($available -contains $env:DSH_PROFILE) {
        $r.EnvHint = '检测到宿主 profile=' + $env:DSH_PROFILE + '，已按自动发现处理（不覆盖发现结果）'
      } else {
        $r.EnvHint = '检测到 DSH_PROFILE=' + $env:DSH_PROFILE + '（该 profile 不存在），已按自动发现处理'
      }
    }
  }
  # [BUG-5] 主 profile：优先"自己目录里真有插件"的那个（真机：desktop 只通过绝对路径消费 web 的目录，
  #   若按旧规则取 desktop 会得到空目录 ⇒ 假 ERR + 迁移命令指向不存在的路径）
  $owners = @()
  foreach ($n in $r.Targets) {
    $tc = Get-TargetContext $n
    if (-not $tc.IsConsumer -and (Test-Path -LiteralPath (Join-Path $tc.PluginDir 'index.js') -PathType Leaf)) { $owners += $n }
  }
  if ($owners.Count -gt 0) {
    $r.Primary = if ($owners -contains 'desktop') { 'desktop' } else { $owners[0] }
  } else {
    $r.Primary = if ($r.Targets -contains 'desktop') { 'desktop' } else { $r.Targets[0] }
  }
  $r.Ok = $true
  return $r
}

function Get-TargetContext([string]$Name) {
  $profileDir = Join-Path (Join-Path $DSH_HOME 'profiles') $Name
  $pluginsRoot = Join-Path $profileDir 'plugins'
  $patchFile = Join-Path $profileDir 'cordis.patch.yml'
  # [BUG-5] 注册表若用**绝对 file:// 路径**指向别的 profile（真机实例：desktop 的 cordis.patch.yml
  #   指向 profiles/web/plugins/memory/index.js），则插件真实目录 = 那个目录，不是 <profile>/plugins/memory。
  #   否则 -CheckOnly 会对 desktop 报"关键文件缺失"假错，迁移命令也会指向不存在的路径。
  $registered = Resolve-RegisteredPluginDir $patchFile
  $pluginDir = if ($registered) { $registered } else { Join-Path $pluginsRoot 'memory' }
  return @{
    Name = $Name
    ProfileDir = $profileDir
    PluginsRoot = $pluginsRoot
    PluginDir = $pluginDir
    PatchFile = $patchFile
    RegisteredDir = $registered
    IsConsumer = [bool]$registered
  }
}

# [BUG-5] 解析 cordis.patch.yml 里 dsh-memory 的 name 字段：绝对 file:// 路径 ⇒ 返回其目录；否则 $null（走默认目录）
function Resolve-RegisteredPluginDir([string]$PatchPath) {
  if (-not (Test-Path -LiteralPath $PatchPath -PathType Leaf)) { return $null }
  $txt = Read-TextFile $PatchPath
  if (-not $txt) { return $null }
  $lines = ($txt -replace "`r", '') -split "`n"
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -notmatch '^[ \t]*-[ \t]*id:[ \t]*dsh-memory[ \t]*($|#)') { continue }
    for ($k = $i + 1; $k -lt [Math]::Min($i + 8, $lines.Count); $k++) {
      $m = [regex]::Match($lines[$k], '^[ \t]*name:[ \t]*["'']?([^"''#]+?)["'']?[ \t]*($|#)')
      if (-not $m.Success) { continue }
      $val = $m.Groups[1].Value.Trim()
      if ($val -notmatch '^file:/+') { return $null }          # 包名/相对路径 ⇒ 默认目录
      $p = ($val -replace '^file:/+', '') -replace '/', '\'
      if ($p -notmatch '^[A-Za-z]:') { return $null }
      # .../plugins/memory/index.js → .../plugins/memory
      $dir = Split-Path -Parent $p
      if ($dir -match '\\index\.js$') { $dir = Split-Path -Parent $dir }
      if ($dir -match '\\lib\\index\.js$') { $dir = Split-Path -Parent (Split-Path -Parent $dir) }
      return $dir
    }
    return $null
  }
  return $null
}

function Format-ProfileMode([string]$Mode) {
  switch ($Mode) {
    'explicit' { return '显式指定（-ProfileName）' }
    'discovered' { return '自动发现（cordis.patch.yml 已有 dsh-memory 注册）' }
    default { return '默认（全新用户：desktop 优先，否则 web）' }
  }
}

# ---------------------------------------------------------------------------
# node resolver (the plugin itself does NOT need node; only -Migrate/-CheckOnly do)
#
# Order: 1) DSH_MEMORY_NODE  2) node on PATH  3) the DSH desktop app run as node
#        (ELECTRON_RUN_AS_NODE=1 <app>.exe script.mjs ...)  4) give up
# The desktop app path is probed via DSH_DESKTOP_NODE_EXECUTABLE -> uninstall
# registry entries whose DisplayName contains "DeepSeek Harness" -> default
# %LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe -> the running
# desktop process' own executable path.
# Returns $null or @{ Exe = <path>; Kind = 'node'|'electron' }.
# ---------------------------------------------------------------------------
function Get-NodeRunnerFromExe([string]$ExePath) {
  if (-not $ExePath) { return $null }
  if (-not (Test-Path -LiteralPath $ExePath -PathType Leaf)) { return $null }
  $leaf = [System.IO.Path]::GetFileName($ExePath)
  $kind = 'electron'
  if ($leaf -match '^node(\.exe)?$') { $kind = 'node' }
  return @{ Exe = $ExePath; Kind = $kind }
}

function Get-DesktopNodeCandidates {
  $cands = @()
  if ($env:DSH_DESKTOP_NODE_EXECUTABLE) { $cands += $env:DSH_DESKTOP_NODE_EXECUTABLE }
  # uninstall registry entries
  foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
    try {
      Get-ItemProperty -Path $root -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -and ([string]$_.DisplayName) -match 'DeepSeek\s*Harness' } |
        ForEach-Object {
          $loc = [string]$_.InstallLocation
          if ($loc) { $cands += (Join-Path $loc 'DeepSeek Harness.exe') }
          $icon = [string]$_.DisplayIcon
          if ($icon -and $icon -match '^"?([^"]+?\.exe)"?') { $cands += $matches[1] }
        }
    } catch { }
  }
  # running desktop process
  try {
    $p = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1
    if ($p -and $p.Path) { $cands += $p.Path }
  } catch { }
  # defaults
  if ($env:LOCALAPPDATA) { $cands += (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe') }
  if ($env:ProgramFiles) { $cands += (Join-Path $env:ProgramFiles 'DeepSeek Harness\DeepSeek Harness.exe') }
  return $cands
}

function Resolve-NodeRunner {
  if ($script:NodeRunnerResolved) { return $script:NodeRunnerCache }
  $script:NodeRunnerResolved = $true
  $script:NodeRunnerCache = $null
  # 1) explicit override
  if ($env:DSH_MEMORY_NODE) {
    $r = Get-NodeRunnerFromExe $env:DSH_MEMORY_NODE
    if ($r) { $script:NodeRunnerCache = $r; return $r }
    Write-Warn2 ("DSH_MEMORY_NODE 指向的文件不存在：" + $env:DSH_MEMORY_NODE)
  }
  # 2) node on PATH
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) {
    $r = Get-NodeRunnerFromExe $cmd.Source
    if ($r) { $script:NodeRunnerCache = $r; return $r }
  }
  # 3) the DSH desktop app used as node
  foreach ($c in @(Get-DesktopNodeCandidates)) {
    $r = Get-NodeRunnerFromExe $c
    if ($r) { $script:NodeRunnerCache = $r; return $r }
  }
  return $null
}

# Run a node-style process; sets/restores ELECTRON_RUN_AS_NODE for the desktop app.
# Returns @{ Output = <merged stdout+stderr string>; ExitCode = <int> }.
function Invoke-NodeProcess($Runner, [string[]]$NodeArgs, [switch]$Stream) {
  $prev = [Environment]::GetEnvironmentVariable('ELECTRON_RUN_AS_NODE', 'Process')
  $changed = $false
  try {
    if ($Runner.Kind -eq 'electron') {
      if ($prev -ne '1') { [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', '1', 'Process'); $changed = $true }
    }
    $buf = ''
    if ($Stream) {
      & $Runner.Exe @NodeArgs 2>&1 | ForEach-Object {
        $line = $_
        if ($line -is [System.Management.Automation.ErrorRecord]) { $line = $line.Exception.Message }
        Write-Host ('  ' + [string]$line)
      }
      return @{ Output = $buf; ExitCode = $LASTEXITCODE }
    }
    $buf = (& $Runner.Exe @NodeArgs 2>&1 | Out-String)
    return @{ Output = $buf; ExitCode = $LASTEXITCODE }
  } finally {
    if ($changed) {
      if ($null -eq $prev) { [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $null, 'Process') }
      else { [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE', $prev, 'Process') }
    }
  }
}

# Electron-as-node may print extra noise; tolerate it by slicing the JSON object.
function Get-JsonFromOutput([string]$Text) {
  if (-not $Text) { return $null }
  $start = $Text.IndexOf('{')
  $end = $Text.LastIndexOf('}')
  if ($start -lt 0 -or $end -le $start) { return $null }
  $snippet = $Text.Substring($start, $end - $start + 1)
  try { return ($snippet | ConvertFrom-Json) } catch { return $null }
}

function Get-NodeMissingHint {
  return @(
    '未找到 node：-Migrate / -CheckOnly 需要 node 或已安装的 DSH 桌面版。',
    '出路：① 安装 Node.js（≥22.5，需要 node:sqlite）或把 node 加入 PATH；',
    '      ② 设置环境变量 DSH_MEMORY_NODE 指向 node 可执行文件；',
    '      ③ 装的是 DSH 桌面版的话，安装器会自动探测并在 ELECTRON_RUN_AS_NODE=1 下使用它；',
    '      ④ 暂时不迁移也可以：插件本体不需要 node，md 模式照常工作（写完仍落 md）。'
  )
}

# ===========================================================================
# Version / semver helpers (host compatibility, non-blocking)
# ===========================================================================
function ConvertTo-SemverParts([string]$V) {
  if (-not $V) { return $null }
  $s = ([string]$V).Trim()
  if ($s.StartsWith('v') -or $s.StartsWith('V')) { $s = $s.Substring(1) }
  $m = [regex]::Match($s, '^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.\-]+))?(?:\+.*)?$')
  if (-not $m.Success) { return $null }
  $pre = @()
  if ($m.Groups[4].Success) { $pre = @($m.Groups[4].Value.Split('.')) }
  return @{ Major = [int]$m.Groups[1].Value; Minor = [int]$m.Groups[2].Value; Patch = [int]$m.Groups[3].Value; Pre = $pre }
}

function Compare-SemverParts($A, $B) {
  if ($A.Major -ne $B.Major) { if ($A.Major -lt $B.Major) { return -1 } else { return 1 } }
  if ($A.Minor -ne $B.Minor) { if ($A.Minor -lt $B.Minor) { return -1 } else { return 1 } }
  if ($A.Patch -ne $B.Patch) { if ($A.Patch -lt $B.Patch) { return -1 } else { return 1 } }
  $ap = @($A.Pre); $bp = @($B.Pre)
  if ($ap.Count -eq 0 -and $bp.Count -eq 0) { return 0 }
  if ($ap.Count -eq 0) { return 1 }
  if ($bp.Count -eq 0) { return -1 }
  $n = [Math]::Min($ap.Count, $bp.Count)
  for ($i = 0; $i -lt $n; $i++) {
    $x = [string]$ap[$i]; $y = [string]$bp[$i]
    $xn = ($x -match '^\d+$'); $yn = ($y -match '^\d+$')
    if ($xn -and $yn) {
      $xi = [int64]$x; $yi = [int64]$y
      if ($xi -ne $yi) { if ($xi -lt $yi) { return -1 } else { return 1 } }
    }
    elseif ($xn) { return -1 }
    elseif ($yn) { return 1 }
    else {
      $c = [string]::CompareOrdinal($x, $y)
      if ($c -ne 0) { if ($c -lt 0) { return -1 } else { return 1 } }
    }
  }
  if ($ap.Count -lt $bp.Count) { return -1 }
  if ($ap.Count -gt $bp.Count) { return 1 }
  return 0
}

# True / False / $null (unknown / unsupported range syntax)
function Test-SemverRange([string]$Version, [string]$Range) {
  if (-not $Range) { return $true }
  $v = ConvertTo-SemverParts $Version
  if (-not $v) { return $null }
  foreach ($part in ($Range -split '\|\|')) {
    $tokens = @(($part.Trim() -split '\s+') | Where-Object { $_ })
    if ($tokens.Count -eq 0) { continue }
    $ok = $true
    foreach ($tok in $tokens) {
      if ($tok -eq '*' -or $tok -eq 'x' -or $tok -eq 'X') { continue }
      $m = [regex]::Match($tok, '^(\^|~|>=|<=|>|<|=)?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.\-]+)?)$')
      if (-not $m.Success) { return $null }
      $op = $m.Groups[1].Value
      $rv = ConvertTo-SemverParts $m.Groups[2].Value
      if (-not $rv) { return $null }
      $cmp = Compare-SemverParts $v $rv
      switch ($op) {
        '>=' { if ($cmp -lt 0) { $ok = $false } }
        '>' { if ($cmp -le 0) { $ok = $false } }
        '<=' { if ($cmp -gt 0) { $ok = $false } }
        '<' { if ($cmp -ge 0) { $ok = $false } }
        '=' { if ($cmp -ne 0) { $ok = $false } }
        '^' {
          if ($cmp -lt 0) { $ok = $false; break }
          $upper = @{ Major = 0; Minor = 0; Patch = 0; Pre = @() }
          if ($rv.Major -gt 0) { $upper.Major = $rv.Major + 1 }
          elseif ($rv.Minor -gt 0) { $upper.Major = 0; $upper.Minor = $rv.Minor + 1 }
          else { $upper.Major = 0; $upper.Minor = 0; $upper.Patch = $rv.Patch + 1 }
          if ((Compare-SemverParts $v $upper) -ge 0) { $ok = $false }
        }
        '~' {
          if ($cmp -lt 0) { $ok = $false; break }
          $upper = @{ Major = $rv.Major; Minor = $rv.Minor + 1; Patch = 0; Pre = @() }
          if ((Compare-SemverParts $v $upper) -ge 0) { $ok = $false }
        }
        default { if ($cmp -ne 0) { $ok = $false } }
      }
    }
    if ($ok) { return $true }
  }
  return $false
}

function Get-HostVersionInfo([string]$ProfileDir) {
  $r = @{ Version = ''; Source = '' }
  $cmd = Get-Command dsh -ErrorAction SilentlyContinue
  if ($cmd) {
    try {
      $o = (& $cmd.Source --version 2>$null | Out-String)
      $m = [regex]::Match($o, '(\d+\.\d+\.\d+(?:-[0-9A-Za-z.\-]+)?)')
      if ($m.Success) { $r.Version = $m.Groups[1].Value; $r.Source = 'dsh --version' }
    } catch { }
  }
  if (-not $r.Version) {
    $pkg = Join-Path $ProfileDir 'package.json'
    if (Test-Path -LiteralPath $pkg -PathType Leaf) {
      try {
        $txt = Read-TextFile $pkg
        $j = $txt | ConvertFrom-Json
        $deps = Get-PropValue $j 'dependencies'
        if ($deps) {
          foreach ($name in @('@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-agent')) {
            $val = Get-PropValue $deps $name
            $m = [regex]::Match([string]$val, '(\d+\.\d+\.\d+(?:-[0-9A-Za-z.\-]+)?)')
            if ($m.Success) { $r.Version = $m.Groups[1].Value; $r.Source = "profile package.json ($name)"; break }
          }
          if (-not $r.Version) {
            foreach ($p in $deps.PSObject.Properties) {
              if ($p.Name -like '@deepseek-ai/*') {
                $m = [regex]::Match([string]$p.Value, '(\d+\.\d+\.\d+(?:-[0-9A-Za-z.\-]+)?)')
                if ($m.Success) { $r.Version = $m.Groups[1].Value; $r.Source = "profile package.json ($($p.Name))"; break }
              }
            }
          }
        }
      } catch { }
    }
  }
  return $r
}

# ===========================================================================
# Download helpers (primary source + jsDelivr mirror; every file gets a fallback)
# ===========================================================================
function Get-SourceUrls([string]$RelPath) {
  $rel = $RelPath.TrimStart('/')
  $list = @($RAW_BASE + '/' + $rel)
  if ($CDN_BASE) { $list += ($CDN_BASE + '/' + $rel) }
  return $list
}

function Invoke-HttpDownload([string]$Url, [string]$Dest) {
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing -TimeoutSec 120 | Out-Null
    return $true
  } catch { return $false }
}

function Get-RemoteFile([string]$RelPath, [string]$Dest, [string]$Label) {
  $urls = @(Get-SourceUrls $RelPath)
  $i = 0
  foreach ($u in $urls) {
    $i++
    Write-Item ("下载 $Label (" + $i + '/' + $urls.Count + ') ...')
    if (Invoke-HttpDownload $u $Dest) { return $u }
    if ($i -lt $urls.Count) { Write-Warn2 ("下载失败，改用备用源（jsDelivr）...") }
  }
  return $null
}

function Get-RemoteText([string]$RelPath) {
  $tmpDir = Get-TempDir 'dsh-memory-fetch-'
  $dest = Join-Path $tmpDir 'body.txt'
  try {
    if (-not (Get-RemoteFile $RelPath $dest 'manifest')) { return $null }
    return Read-TextFile $dest
  } finally {
    Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# ===========================================================================
# Manifest handling
# ===========================================================================
function Resolve-PayloadSource {
  # returns @{ Ok; IsLocal; ManifestPath; ManifestText; ZipPath (local only); Error }
  $r = @{ Ok = $false; IsLocal = $false; ManifestPath = ''; ManifestText = ''; ZipPath = ''; Error = '' }
  $local = $LocalPayload
  if ($local) {
    $lp = $local
    try { $lp = [System.IO.Path]::GetFullPath($local) } catch { }
    $candidates = @()
    if (Test-Path -LiteralPath $lp -PathType Container) {
      $candidates += (Join-Path $lp 'install-manifest.json')
      $candidates += (Join-Path (Join-Path $lp 'payload') 'install-manifest.json')
      $r.IsLocal = $true
    }
    elseif (Test-Path -LiteralPath $lp -PathType Leaf) {
      $dir = Split-Path -Parent $lp
      $candidates += (Join-Path $dir 'install-manifest.json')
      $parent = Split-Path -Parent $dir
      if ($parent) { $candidates += (Join-Path $parent 'install-manifest.json') }
      $r.IsLocal = $true
      $r.ZipPath = $lp
    }
    else {
      $r.Error = "-LocalPayload 指向的路径不存在：$local"
      return $r
    }
    if ($env:DSH_MEMORY_MANIFEST) { $candidates = @($env:DSH_MEMORY_MANIFEST) + $candidates }
    foreach ($c in $candidates) {
      if ($c -and (Test-Path -LiteralPath $c -PathType Leaf)) {
        $r.ManifestPath = $c
        $r.ManifestText = Read-TextFile $c
        $r.Ok = $true
        return $r
      }
    }
    $r.Error = "找不到 install-manifest.json（应在 zip 同目录、其上一级或 -LocalPayload 目录内）：`n          已查找：$($candidates -join ' ; ')`n          可用 DSH_MEMORY_MANIFEST 显式指定。"
    return $r
  }
  $text = Get-RemoteText 'install-manifest.json'
  if (-not $text) {
    $r.Error = "无法下载 install-manifest.json（网络/镜像不可达）。离线安装请用 -LocalPayload <zip>。"
    return $r
  }
  $r.IsLocal = $false
  $r.ManifestText = $text
  $r.Ok = $true
  return $r
}

function ConvertTo-Manifest($Text, [string]$SourceDesc) {
  try { $m = $Text | ConvertFrom-Json } catch { throw "manifest 不是合法 JSON（$SourceDesc）：$($_.Exception.Message)" }
  foreach ($f in @('version', 'files', 'zip')) {
    if ($null -eq $m.PSObject.Properties[$f]) { throw "manifest 缺字段 '$f'（$SourceDesc）" }
  }
  foreach ($f in @('name', 'bytes', 'sha256')) {
    if ($null -eq $m.zip.PSObject.Properties[$f]) { throw "manifest.zip 缺字段 '$f'（$SourceDesc）" }
  }
  if ($null -eq $m.files -or @($m.files).Count -eq 0) { throw "manifest.files 为空（$SourceDesc）" }
  foreach ($f in @($m.files)) {
    foreach ($k in @('path', 'bytes', 'sha256')) {
      if ($null -eq $f.PSObject.Properties[$k]) { throw "manifest.files 条目缺 '$k'（$SourceDesc）" }
    }
  }
  return $m
}

# ===========================================================================
# Payload extraction / verification / backup / install
# ===========================================================================
function Expand-PayloadZip([string]$ZipPath, [string]$StageDir) {
  try {
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $StageDir -Force -ErrorAction Stop
    return $true
  } catch {
    Write-Warn2 ("Expand-Archive 失败（" + $_.Exception.Message + '），改用 .NET ZipFile 解压 ...')
    try {
      Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
      [System.IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $StageDir)
      return $true
    } catch {
      Write-Bad ("解压 payload 失败：" + $_.Exception.Message)
      return $false
    }
  }
}

function Test-PayloadFiles([string]$StageDir, $Manifest) {
  $missing = @()
  $mismatch = @()
  foreach ($f in @($Manifest.files)) {
    $rel = [string]$f.path
    $abs = Join-Path $StageDir ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $abs -PathType Leaf)) { $missing += $rel; continue }
    $len = (Get-Item -LiteralPath $abs).Length
    if ($len -ne [int64]$f.bytes) { $mismatch += ("$rel (bytes " + $len + ' != ' + $f.bytes + ')'); continue }
    $sha = Get-Sha256File $abs
    if ($sha -ne ([string]$f.sha256).ToLowerInvariant()) { $mismatch += "$rel (sha256)"; continue }
  }
  return @{ Missing = $missing; Mismatch = $mismatch }
}

function Backup-PluginDir([string]$PluginDir) {
  $r = @{ Created = ''; Items = @() }
  $existing = @()
  foreach ($name in @('index.js', 'package.json', 'memtopic', 'client', 'AGENTS.template.md')) {
    if (Test-Path -LiteralPath (Join-Path $PluginDir $name)) { $existing += $name }
  }
  if ($existing.Count -eq 0) { return $r }
  $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
  $bak = Join-Path $PluginDir ('_backup-' + $stamp)
  New-Item -ItemType Directory -Force -Path $bak | Out-Null
  foreach ($name in $existing) {
    Copy-Item -LiteralPath (Join-Path $PluginDir $name) -Destination (Join-Path $bak $name) -Recurse -Force
  }
  $r.Created = $bak
  $r.Items = $existing
  return $r
}

function Copy-PayloadToPlugin([string]$StageDir, [string]$PluginDir, $Manifest) {
  $count = 0
  $pluginsRoot = Split-Path -Parent $PluginDir
  $clientRoot = Join-Path $pluginsRoot 'dsh-memory-client'
  foreach ($f in @($Manifest.files)) {
    $rel = ([string]$f.path) -replace '/', '\'
    $src = Join-Path $StageDir $rel
    # [BUG-6] payload 的 client/** 是「设置界面半区」，宿主按 ./plugins/dsh-memory-client/lib/index.js 加载，
    #   所以必须落到 <plugins>/dsh-memory-client/ 并单独注册；写进 <pluginDir>/client/ 的话没人引用（死文件），
    #   新用户会看不到「通用设置 → 记忆」半区。
    if ($rel -like 'client\*') {
      $dst = Join-Path $clientRoot ($rel.Substring('client\'.Length))
    } else {
      $dst = Join-Path $PluginDir $rel
    }
    $dstDir = Split-Path -Parent $dst
    if ($dstDir -and -not (Test-Path -LiteralPath $dstDir)) { New-Item -ItemType Directory -Force -Path $dstDir | Out-Null }
    Copy-Item -LiteralPath $src -Destination $dst -Force
    $count++
  }
  return $count
}

# ===========================================================================
# Memory library: skeleton / .config.json / AGENTS.md
# ===========================================================================
function Initialize-MemoryRoot([string]$MemRoot) {
  $created = @()
  foreach ($sub in @('', 'sessions', 'projects', 'tools', 'knowledge')) {
    $dir = if ($sub) { Join-Path $MemRoot $sub } else { $MemRoot }
    if (-not (Test-Path -LiteralPath $dir)) {
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
      $created += $dir
    }
  }
  $pairs = @(
    @{ Name = 'global.md'; Head = '# 全局记忆' },
    @{ Name = 'index.md'; Head = '# 记忆索引' }
  )
  foreach ($p in $pairs) {
    $fp = Join-Path $MemRoot $p.Name
    if (-not (Test-Path -LiteralPath $fp)) {
      Write-TextNoBom $fp ($p.Head + "`n")
      $created += $fp
    }
  }
  return $created
}

function Get-ConfigInfo([string]$MemRoot) {
  $path = Join-Path $MemRoot '.config.json'
  $r = @{ Path = $path; Exists = $false; Valid = $false; HasKey = $false; Value = $null; Raw = '' }
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $r }
  $r.Exists = $true
  $txt = Read-TextFile $path
  if ($null -eq $txt) { return $r }
  $r.Raw = $txt
  try {
    $j = $txt | ConvertFrom-Json
    $r.Valid = $true
    $p = $j.PSObject.Properties['memoryTopicDbEnabled']
    if ($p) { $r.HasKey = $true; $r.Value = $p.Value }
  } catch { }
  return $r
}

function Set-ConfigFlagTrue([string]$MemRoot) {
  $path = Join-Path $MemRoot '.config.json'
  $obj = $null
  if (Test-Path -LiteralPath $path -PathType Leaf) {
    $txt = Read-TextFile $path
    try { $obj = $txt | ConvertFrom-Json }
    catch { return @{ Ok = $false; Changed = $false; Value = $null; Reason = '.config.json 不是合法 JSON，未修改（请先修好或备份后删除再重装）' } }
    if ($null -ne $obj -and $null -eq $obj.PSObject) {
      return @{ Ok = $false; Changed = $false; Value = $null; Reason = '.config.json 顶层不是对象，未修改' }
    }
  }
  if ($null -eq $obj) { $obj = New-Object psobject }
  $p = $obj.PSObject.Properties['memoryTopicDbEnabled']
  if ($p) {
    return @{ Ok = $true; Changed = $false; Value = $p.Value; Reason = '已有 memoryTopicDbEnabled，保留用户设置' }
  }
  $obj | Add-Member -NotePropertyName 'memoryTopicDbEnabled' -NotePropertyValue $true -Force
  $json = $obj | ConvertTo-Json -Depth 10
  Write-TextNoBom $path ($json + "`n")
  return @{ Ok = $true; Changed = $true; Value = $true; Reason = '新增 memoryTopicDbEnabled=true' }
}

function Get-AgentsState([string]$DshHome) {
  $path = Join-Path $DshHome 'AGENTS.md'
  $r = @{ State = 'missing'; Path = $path; Sha = ''; Bytes = 0; Backup = ''; TemplatePath = '' }
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $r }
  $raw = Read-TextFile $path
  if ($null -eq $raw) { $r.State = 'unreadable'; return $r }
  $r.Bytes = (Get-Item -LiteralPath $path).Length
  $noBom = $raw
  if ($noBom.Length -gt 0 -and $noBom[0] -eq [char]0xFEFF) { $noBom = $noBom.Substring(1) }
  if ($noBom -match [regex]::Escape($AGENTS_V4_MARKER)) {
    # [4.5] v4 协议分两代：4.0.1 时代的 v4 模板（sha 在白名单）可安全升级到 4.5；
    #   用户改过的（sha 不匹配）保留不动 —— 与 install.sh 同口径。
    $normV4 = Get-NormalizedAgentsText $noBom
    $shaV4 = Get-Sha256Text $normV4
    $r.Sha = $shaV4
    if ($AGENTS_LEGACY_SHA -contains $shaV4) { $r.State = 'legacy-v4'; return $r }
    $r.State = 'v4'; return $r
  }
  $norm = Get-NormalizedAgentsText $noBom
  $sha = Get-Sha256Text $norm
  $r.Sha = $sha
  if ($AGENTS_LEGACY_SHA -contains $sha) { $r.State = 'legacy-v3'; return $r }
  $r.State = 'user-modified'
  return $r
}

function Update-AgentsFile([string]$DshHome, [string]$TemplatePath) {
  $r = @{ Action = 'unknown'; Detail = ''; Backup = ''; Path = (Join-Path $DshHome 'AGENTS.md') }
  if (-not (Test-Path -LiteralPath $TemplatePath -PathType Leaf)) {
    $r.Action = 'template-missing'; $r.Detail = "payload 内缺少 AGENTS.template.md：$TemplatePath"; return $r
  }
  $tpl = Read-TextFile $TemplatePath
  if ($null -eq $tpl) { $r.Action = 'template-unreadable'; return $r }
  $state = Get-AgentsState $DshHome
  if ($state.State -eq 'missing') {
    Write-TextNoBom $r.Path $tpl
    $r.Action = 'created'
    return $r
  }
  if ($state.State -eq 'v4') {
    # [CRA M4 修复 2026-11-05] v4 marker ≠ 4.5 模板：用户可能小改过 4.0.1 的 v4 文件（sha 不匹配白名单），
    #   此时既不该谎报「已是 v4 协议（跳过）」，也不该覆盖。与 payload 模板逐字比对后给准确提示。
    $tplSha = Get-Sha256Text (Get-NormalizedAgentsText $tpl)
    if ($state.Sha -eq $tplSha) { $r.Action = 'current'; return $r }
    $r.Action = 'v4-older'
    $r.Detail = 'AGENTS.md 是 v4 协议但内容非 4.5 模板（被改过）→ 保留不动；如需 memory_note 会话笔记协议，请按 payload 内 AGENTS.template.md 手工合并'
    return $r
  }
  if ($state.State -eq 'legacy-v3' -or $state.State -eq 'legacy-v4') {
    # [4.5] legacy-v3（旧 md 协议）与 legacy-v4（4.0.1 时代 v4 模板，无 memory_note）都走升级：
    #   先备份原文件，再用 payload 内的新模板覆盖；用户改过的文件在 Get-AgentsState 里已判为 v4/user-modified，不会进这里。
    $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
    $bak = $r.Path + '.bak-' + $stamp
    Copy-Item -LiteralPath $r.Path -Destination $bak -Force
    Write-TextNoBom $r.Path $tpl
    $r.Action = 'upgraded'
    $r.Backup = $bak
    return $r
  }
  $r.Action = 'user-modified'
  return $r
}

# ===========================================================================
# Topic DB / legacy md inspection
# ===========================================================================
function Get-TopicDbStatus([string]$MemRoot) {
  $db = Join-Path (Join-Path $MemRoot '.memtopic') 'mem.db'
  $r = @{ Path = $db; Exists = $false; Bytes = 0; Topics = $null; Sentences = $null; SchemaVersion = $null; Degraded = $false; Error = ''; Available = $false }
  if (-not (Test-Path -LiteralPath $db -PathType Leaf)) { return $r }
  $r.Exists = $true
  $r.Bytes = (Get-Item -LiteralPath $db).Length
  $runner = Resolve-NodeRunner
  if (-not $runner) { $r.Error = '未找到 node / DSH 桌面版，无法读取库内计数（只按文件存在/大小判断）'; return $r }
  $js = @'
const fs = require("node:fs");
const p = process.argv[1];
const out = { exists: false, size: 0, topics: null, sentences: null, schemaVersion: null, readOnly: null, error: null };
try {
  if (fs.existsSync(p)) {
    out.exists = true;
    out.size = fs.statSync(p).size;
    let db = null;
    try { const m = require("node:sqlite"); db = new m.DatabaseSync(p, { readOnly: true }); out.readOnly = true; }
    catch (e1) {
      try { const m = require("node:sqlite"); db = new m.DatabaseSync(p); out.readOnly = false; }
      catch (e2) { out.error = String((e2 && e2.message) || e2); }
    }
    if (db) {
      const one = function (sql) { try { return db.prepare(sql).get(); } catch (e) { return null; } };
      const t = one("SELECT count(*) AS c FROM topics");
      out.topics = t ? Number(t.c) : null;
      const s = one("SELECT count(*) AS c FROM sentences");
      out.sentences = s ? Number(s.c) : null;
      const m = one("SELECT value FROM meta WHERE key = 'schema_version'");
      out.schemaVersion = m ? m.value : null;
      try { db.close(); } catch (e) {}
    }
  }
} catch (e) { out.error = String((e && e.message) || e); }
console.log(JSON.stringify(out));
'@
  try {
    $run = Invoke-NodeProcess $runner @('-e', $js, $db)
    $j = Get-JsonFromOutput $run.Output
    if (-not $j) {
      $r.Error = 'node 输出无法解析：' + (($run.Output -replace "`r?`n", ' ').Trim())
      return $r
    }
    $r.Available = $true
    $r.Topics = $j.topics
    $r.Sentences = $j.sentences
    $r.SchemaVersion = $j.schemaVersion
    if ($j.error) { $r.Error = [string]$j.error }
    if ($null -eq $j.topics) { $r.Error = '库内计数不可用（可能不是主题库或表缺失）' }
  } catch {
    $r.Error = 'node 读取库状态失败：' + $_.Exception.Message
  }
  return $r
}

function Get-LegacyMdStats([string]$MemRoot) {
  $layers = @('knowledge', 'sessions', 'projects', 'tools')
  $r = @{ Files = 0; Sentences = 0; ByLayer = @{}; HumanLayer = @(); TotalMd = 0; Error = '' }
  foreach ($l in $layers) { $r.ByLayer[$l] = @{ Files = 0; Sentences = 0 } }
  if (-not (Test-Path -LiteralPath $MemRoot -PathType Container)) { return $r }
  try { $all = @(Get-ChildItem -LiteralPath $MemRoot -Recurse -File -Filter '*.md' -ErrorAction SilentlyContinue) }
  catch { $r.Error = $_.Exception.Message; return $r }
  foreach ($f in $all) {
    $r.TotalMd++
    $full = $f.FullName
    $rel = $full.Substring($MemRoot.Length).TrimStart('\', '/')
    $segs = @($rel -split '[\\/]')
    if ($segs.Count -lt 2) {
      # 根级 md：global.md / index.md 是人工稳定层，不计入"遗留可导入"
      if ($segs.Count -eq 1 -and @('global.md', 'index.md') -contains $segs[0]) { $r.HumanLayer += $segs[0] }
      continue
    }
    $skip = $false
    for ($i = 0; $i -lt ($segs.Count - 1); $i++) {
      $s = $segs[$i]
      if ($s.StartsWith('.') -or @('_export', 'node_modules', 'memory_backup', '_backup', 'tmp') -contains $s) { $skip = $true; break }
    }
    if ($skip) { continue }
    if ($f.Name -match '\.(bak|tmp|orig|rej)([-.]|$)' -or $f.Name -match '\.pre-' -or $f.Name.EndsWith('~')) { continue }
    $layer = $segs[0]
    if ($layers -notcontains $layer) { continue }
    $text = Read-TextFile $full
    if ($null -eq $text) { continue }
    $cnt = 0
    foreach ($line in ($text -split "`r?`n")) {
      $t = $line.Trim()
      if ($t.Length -eq 0) { continue }
      if ($t.StartsWith('#')) { continue }
      if ($t.StartsWith('<!--')) { continue }
      if ($t -match '^[-*_]{3,}$') { continue }
      $cnt++
    }
    if ($cnt -eq 0) { continue }
    $r.Files++
    $r.Sentences += $cnt
    $r.ByLayer[$layer].Files++
    $r.ByLayer[$layer].Sentences += $cnt
  }
  return $r
}

# ===========================================================================
# Migration engine hand-off (memtopic/src/migrate.mjs)
# ===========================================================================
function Get-MigrateScriptPath([string]$PluginDir) {
  $p = Join-Path (Join-Path $PluginDir 'memtopic\src') 'migrate.mjs'
  if (Test-Path -LiteralPath $p -PathType Leaf) { return $p }
  return ''
}

function Get-MigrateCommonArgs([string]$CtxMemRoot, [string]$DshHome) {
  $db = Join-Path (Join-Path $CtxMemRoot '.memtopic') 'mem.db'
  return @('--md-root', $CtxMemRoot, '--db', $db, '--dsh-home', $DshHome)
}

function Invoke-MigrateDetect([string]$MigrateJs, [string]$MemRoot, [string]$DshHome) {
  # runs `migrate.mjs --detect --json ...`; returns @{ Ok; ExitCode; Json; Raw; Error }
  $r = @{ Ok = $false; ExitCode = -1; Json = $null; Raw = ''; Error = '' }
  $runner = Resolve-NodeRunner
  if (-not $runner) { $r.Error = '未找到 node / DSH 桌面版'; return $r }
  if (-not $MigrateJs) { $r.Error = 'memtopic/src/migrate.mjs 未就绪'; return $r }
  $cliArgs = @($MigrateJs, '--detect', '--json') + @(Get-MigrateCommonArgs $MemRoot $DshHome)
  try {
    $run = Invoke-NodeProcess $runner $cliArgs
    $r.Raw = $run.Output
    $r.ExitCode = $run.ExitCode
    $r.Json = Get-JsonFromOutput $run.Output
    $r.Ok = ($null -ne $r.Json)
    if (-not $r.Ok) { $r.Error = 'migrate.mjs --detect 输出无法解析（退出码 ' + $r.ExitCode + '）' }
  } catch {
    $r.Error = '调用 migrate.mjs --detect 失败：' + $_.Exception.Message
  }
  return $r
}

# 把 detect 的 JSON 渲染成人话（-CheckOnly / -Migrate / 安装结束提示共用）
function Format-MigrateDetect($Detect, [switch]$InstallContext) {
  if ($null -eq $Detect) { return }
  $db = Get-PropValue $Detect 'db'
  $legacy = Get-PropValue $Detect 'legacy'
  $hostInfo = Get-PropValue $Detect 'host'
  $blockers = @(Get-PropValue $Detect 'blockers')
  $needs = ConvertTo-Boolish (Get-PropValue $Detect 'needsMigration')
  $migrated = ConvertTo-Boolish (Get-PropValue $Detect 'alreadyMigrated')
  $empty = ConvertTo-Boolish (Get-PropValue $Detect 'empty')
  $hostRunning = $false
  if ($hostInfo) { $hostRunning = ConvertTo-Boolish (Get-PropValue $hostInfo 'running') }

  if ($legacy) {
    $by = Get-PropValue $legacy 'byLayer'
    $bs = ''
    foreach ($k in @('knowledge', 'sessions', 'projects', 'tools')) {
      $v = Get-PropValue $by $k
      if ($v) {
        $lf = Get-PropValue $v 'files'
        $ls = Get-PropValue $v 'sentences'
        if ($null -eq $lf) { $lf = $v }   # 兼容旧格式（数字）
        if ([int]$lf -gt 0) { $bs += (' ' + $k + '=' + [string]$lf + 'f/' + [string]$ls + 's') }
      }
    }
    Write-Fact '旧 md 文件' ([string](Get-PropValue $legacy 'importableFiles') + ' 个 / ' + [string](Get-PropValue $legacy 'importableSentences') + ' 句（可导入）')
    if ($bs) { Write-Fact '分层' ($bs.Trim()) }
    $human = @(Get-PropValue $legacy 'humanLayer')
    if ($human.Count -gt 0) {
      $names = @()
      foreach ($h in $human) {
        $hn = Get-PropValue $h 'name'
        if ($hn) { $names += [string]$hn } elseif ($h -isnot [psobject] -or $null -eq $h.PSObject.Properties['name']) { $names += [string]$h }
      }
      if ($names.Count -gt 0) { Write-Fact '人工稳定层' (($names -join '、') + '（迁移后仍是可编辑层）') }
    }
  }
  if ($db) {
    $dbExists = ConvertTo-Boolish (Get-PropValue $db 'exists')
    $line = if ($dbExists) { '存在' } else { '不存在' }
    if ($dbExists) {
      $line += ('：' + [string](Get-PropValue $db 'topics') + ' 主题 / ' + [string](Get-PropValue $db 'sentences') + ' 句')
      if (ConvertTo-Boolish (Get-PropValue $db 'degraded')) { $line += '（降级后端）' }
    }
    Write-Fact '主题库' $line
  }
  if ($hostInfo) {
    $st = [string](Get-PropValue $hostInfo 'status')
    $label = switch ($st) { 'running' { '运行中（迁移会被拒绝）' } 'assumed-stopped' { '假定已停止（--assume-host-stopped）' } 'unknown' { '无法完全确定（按未运行处理）' } default { '未运行' } }
    Write-Fact '宿主 DSH' $label
    $ev = @(Get-PropValue $hostInfo 'evidence')
    foreach ($e in $ev) {
      $kind = [string](Get-PropValue $e 'kind')
      $detail = [string](Get-PropValue $e 'detail')
      $path = [string](Get-PropValue $e 'path')
      if ($path) { Write-Item ("依据 [$kind] " + $path) }
      elseif ($detail) { Write-Item ("依据 [$kind] " + $detail) }
    }
  }
  $verdict = if ($needs) { '需要迁移（旧 md 有数据、主题库无数据）' } elseif ($migrated) { '已迁移（主题库已有数据）' } elseif ($empty) { '全新用户（无旧 md、无库）' } else { '无需迁移' }
  Write-Fact '判定' $verdict
  # 安装流程里"迁移被拒"不能表现为致命错误：它只会被登记成 pending，安装照常做完。
  foreach ($b in $blockers) {
    $code = [string](Get-PropValue $b 'code'); $bt = [string](Get-PropValue $b 'text')
    if ($InstallContext) { Write-Warn2 ("迁移暂缓 $code：" + $bt + "（安装继续；下一步登记为重启后自动迁移）") }
    else { Write-Bad ("阻断项 $code：" + $bt) }
  }
  foreach ($b in @(Get-PropValue $Detect 'advisories')) {
    $code = [string](Get-PropValue $b 'code'); $bt = [string](Get-PropValue $b 'text')
    if (ConvertTo-Boolish (Get-PropValue $b 'blocking')) {
      if ($InstallContext) { Write-Warn2 ("迁移暂缓 $code：" + $bt + "（安装继续；下一步登记为重启后自动迁移）") }
      else { Write-Bad ("阻断项 $code：" + $bt) }
    }
    elseif ($bt) { Write-Item ("提示 $code：" + $bt) }
  }
  if ($InstallContext) {
    if ($needs) { Write-Item '→ 安装完成后会写入 pending 标记：下次启动 DSH 时自动迁移（先快照，失败自动回退 md）。' }
  } else {
    $next = [string](Get-PropValue $Detect 'nextCommand')
    if ($next) { Write-Fact '建议下一步' $next }
  }
}

# detect JSON 是否表明库 schema 高于本版（阻断迁移）
function Test-DetectSchemaTooNew($Json) {
  if (-not $Json) { return $false }
  if (ConvertTo-Boolish (Get-PropValue $Json 'schemaTooNew')) { return $true }
  foreach ($coll in @('blockers', 'advisories')) {
    foreach ($b in @(Get-PropValue $Json $coll)) {
      if ([string](Get-PropValue $b 'code') -eq 'SCHEMA_TOO_NEW') { return $true }
    }
  }
  return $false
}

# 没有 migrate.mjs 时的静态兜底判断
function Get-StaticMigrationVerdict([string]$MemRoot) {
  $db = Get-TopicDbStatus $MemRoot
  $md = Get-LegacyMdStats $MemRoot
  $dbHasData = $false
  if ($db.Exists) {
    if ($db.Available -and $null -ne $db.Topics) { $dbHasData = ([int]$db.Topics -gt 0) }
    elseif (-not $db.Available) { $dbHasData = ($db.Bytes -ge 8192) }  # node 缺失时的保守启发
  }
  $r = @{
    NeedsMigration = ($md.Sentences -gt 0 -and -not $dbHasData)
    AlreadyMigrated = $dbHasData
    Empty = ($md.Sentences -eq 0 -and -not $dbHasData)
    Db = $db
    Md = $md
    SchemaTooNew = $false
    HostRunning = $null
  }
  return $r
}

# After a successful migration: flip the topic-db flag on
function Write-ConfigFlagForMigration([string]$MemRoot) {
  $cfg = Get-ConfigInfo $MemRoot
  if ($cfg.Exists -and -not $cfg.Valid) {
    Write-Warn2 '.config.json 不是合法 JSON，跳过开关写入；请手工在设置里打开主题库'
    return
  }
  $res = Set-ConfigFlagTrue $MemRoot
  if ($res.Ok) { Write-Ok ('主题库开关：' + $res.Reason) } else { Write-Warn2 ('主题库开关未写入：' + $res.Reason) }
}

# ===========================================================================
# Patch layer / junction
# ===========================================================================
# junction: profiles/node_modules/dsh-memory -> <profile>/plugins/memory
# 包名形式注册（name: dsh-memory）依赖它；junction 丢了 = patch 有行但加载不到（静默不加载）。
# ===========================================================================
function Get-JunctionInfo([string]$DshHome, [string]$ExpectedTarget) {
  $r = @{ Path = ''; Exists = $false; IsLink = $false; Target = ''; Matches = $false; LinkType = '' }
  $nmTarget = Join-Path (Join-Path $DshHome 'profiles') 'node_modules'
  $r.Path = Join-Path $nmTarget 'dsh-memory'
  if (-not (Test-Path -LiteralPath $nmTarget -PathType Container)) { return $r }
  if (-not (Test-Path -LiteralPath $r.Path)) { return $r }
  $r.Exists = $true
  try {
    $info = Get-Item -LiteralPath $r.Path -Force
    $r.LinkType = [string]$info.LinkType
    $r.IsLink = ($info.LinkType -eq 'Junction' -or $info.LinkType -eq 'SymbolicLink')
    $targets = @($info.Target)
    $r.Target = (($targets | ForEach-Object { [string]$_ }) -join '; ')
    if ($ExpectedTarget) {
      foreach ($t in $targets) {
        if (-not $t) { continue }
        $tt = ([string]$t).TrimEnd('\', '/')
        $exp = $ExpectedTarget.TrimEnd('\', '/')
        if ($tt -ieq $exp) { $r.Matches = $true; continue }
        try {
          if ([System.IO.Path]::GetFullPath($tt).TrimEnd('\', '/') -ieq [System.IO.Path]::GetFullPath($exp).TrimEnd('\', '/')) { $r.Matches = $true }
        } catch { }
      }
    }
  } catch { }
  return $r
}

function Ensure-Junction([string]$DshHome, [string]$TargetPluginDir) {
  $r = @{ State = 'missing-dir'; Detail = '' }
  $nmTarget = Join-Path (Join-Path $DshHome 'profiles') 'node_modules'
  if (-not (Test-Path -LiteralPath $nmTarget -PathType Container)) {
    $r.Detail = "缺少 $nmTarget —— 包名注册无法解析 dsh-memory，改用路径形式注册"
    return $r
  }
  $nmLink = Join-Path $nmTarget 'dsh-memory'
  $info = Get-JunctionInfo $DshHome $TargetPluginDir
  if ($info.Exists) {
    if ($info.IsLink -and $info.Matches) { $r.State = 'ok'; $r.Detail = '已指向插件目录'; return $r }
    if ($info.IsLink) {
      try {
        Remove-Item -LiteralPath $nmLink -Recurse -Force
        New-Item -ItemType Junction -Path $nmLink -Target $TargetPluginDir | Out-Null
        $r.State = 'ok'; $r.Detail = '已改指向当前插件目录'
      } catch {
        $r.State = 'conflict'; $r.Detail = 'junction 重建失败：' + $_.Exception.Message
      }
      return $r
    }
    $r.State = 'conflict'; $r.Detail = 'profiles/node_modules/dsh-memory 已存在但不是 junction，保留不动'
    return $r
  }
  try {
    New-Item -ItemType Junction -Path $nmLink -Target $TargetPluginDir | Out-Null
    $r.State = 'ok'; $r.Detail = '已创建 junction'
  } catch {
    $r.State = 'conflict'; $r.Detail = 'junction 创建失败：' + $_.Exception.Message
  }
  return $r
}

# 注册行检查：与安装器"写什么就认什么"（单一真源），三种 name 形态都认
function Get-MemoryRegistrationInfo([string]$PatchPath) {
  $r = @{ Exists = $false; Found = $false; Kind = 'none'; NameValue = ''; TopEntries = 0; Stray = 0 }
  if (-not (Test-Path -LiteralPath $PatchPath -PathType Leaf)) { return $r }
  $r.Exists = $true
  $raw = Read-TextFile $PatchPath
  if ($null -eq $raw) { return $r }
  if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
  $lines = @($raw -split "`r?`n")
  $r.TopEntries = @($lines | Where-Object { $_ -match '^-(\s|$)' }).Count
  $r.Stray = @($lines | Where-Object { $_ -match '^\[[ \t]*\]$' }).Count
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^[ \t]*-[ \t]*id:[ \t]*dsh-memory[ \t]*($|#)') {
      $r.Found = $true
      for ($j = $i + 1; $j -lt [Math]::Min($i + 11, $lines.Count); $j++) {
        if ($lines[$j] -match '^-(\s|$)') { break }
        $m = [regex]::Match($lines[$j], '^[ \t]*name:[ \t]*(.+?)[ \t]*$')
        if ($m.Success) { $r.NameValue = $m.Groups[1].Value.Trim("'", '"'); break }
      }
      if (-not $r.NameValue) {
        # 兼容"carrier 行"写法：同 id 的下一个顶层条目可能带 name
        for ($j = $i + 1; $j -lt $lines.Count; $j++) {
          if ($lines[$j] -match '^[ \t]*-[ \t]*id:[ \t]*dsh-memory[ \t]*($|#)') {
            for ($k = $j + 1; $k -lt [Math]::Min($j + 6, $lines.Count); $k++) {
              if ($lines[$k] -match '^-(\s|$)') { break }
              $m2 = [regex]::Match($lines[$k], '^[ \t]*name:[ \t]*(.+?)[ \t]*$')
              if ($m2.Success) { $r.NameValue = $m2.Groups[1].Value.Trim("'", '"'); break }
            }
            break
          }
        }
      }
      break
    }
  }
  if ($r.Found) {
    $nv = $r.NameValue
    if ($nv -eq 'dsh-memory') { $r.Kind = 'package' }
    elseif ($nv -match '(^|[\\/])plugins[\\/]memory[\\/]index\.js$') { $r.Kind = 'relative-path' }
    elseif ($nv -match '^file:///.*index\.js$') { $r.Kind = 'absolute-file-url' }
    elseif ($nv) { $r.Kind = 'other' }
    else { $r.Kind = 'id-only' }
  }
  return $r
}

function Get-RegistrationKindLabel([string]$Kind) {
  switch ($Kind) {
    'package' { return '包名形式（name: dsh-memory，依赖 junction）' }
    'relative-path' { return '相对路径形式（./plugins/memory/index.js）' }
    'absolute-file-url' { return '绝对 file:// URL 形式' }
    'id-only' { return '只有 id 行（未读到 name）' }
    default { return '其它/未知形式' }
  }
}

function Register-Plugin {
  param(
    [Parameter(Mandatory = $true)][string]$DshHome,
    [Parameter(Mandatory = $true)][string]$PluginDir,
    [Parameter(Mandatory = $true)][string]$PatchFile,
    [string]$JunctionTarget = '',
    [switch]$ForcePathForm
  )
  $r = @{ Ok = $false; Action = ''; Detail = ''; Form = ''; Backup = '' }
  $packageBlock = @(
    '# --- dsh-memory: global auto-memory plugin (installed by the dsh-memory installer) ---',
    '- insert:',
    '    - id: dsh-memory',
    '      name: dsh-memory',
    '      config:',
    '        staleSessionDays: 5',
    '        staleAction: remind'
  )
  $pathBlock = @(
    '# --- dsh-memory: global auto-memory plugin (installed by the dsh-memory installer) ---',
    '- insert:',
    '    - id: dsh-memory',
    '      name: ./plugins/memory/index.js',
    '      config:',
    '        staleSessionDays: 5',
    '        staleAction: remind'
  )
  $memoryBlock = $pathBlock
  $r.Form = 'relative-path'
  if (-not $ForcePathForm) {
    $jt = if ($JunctionTarget) { $JunctionTarget } else { $PluginDir }
    $j = Ensure-Junction $DshHome $jt
    Write-Item ('junction: ' + $j.Detail)
    if ($j.State -eq 'ok') { $memoryBlock = $packageBlock; $r.Form = 'package' }
  }
  $merge = Merge-PatchFile -Path $PatchFile -Block $memoryBlock -IdName 'dsh-memory'
  $r.Action = $merge.Action
  $r.Detail = $merge.Detail

  switch ($merge.Action) {
    'created' {
      $null = Write-PatchFile -Path $PatchFile -Text $merge.Text
      $r.Ok = $true
    }
    'registered' {
      $r.Backup = Write-PatchFile -Path $PatchFile -Text $merge.Text
      $r.Ok = $true
    }
    'repaired' {
      $r.Backup = Write-PatchFile -Path $PatchFile -Text $merge.Text
      $r.Ok = $true
    }
    'skip' { $r.Ok = $true }
    default {
      $snippet = $PatchFile + '.dsh-memory-block.txt'
      Write-TextNoBom $snippet (($memoryBlock -join "`r`n") + "`r`n")
      $r.Ok = $false
    }
  }
  # [BUG-6] 设置界面半区（client）单独注册：payload 的 client/** 装在 <plugins>/dsh-memory-client/，
  #   不注册 ⇒ 新用户看不到「通用设置 → 记忆」半区（真机：全新安装只有 memory/ 一个目录）。
  #   必须在 memory 行写盘之后做（Merge-PatchFile 基于当前文件内容，提前做会覆盖掉 memory 行）。
  $clientDir = Join-Path (Split-Path -Parent $PluginDir) 'dsh-memory-client'
  if (Test-Path -LiteralPath (Join-Path $clientDir 'lib\index.js') -PathType Leaf) {
    $clientBlock = @(
      '# --- dsh-memory-client: settings UI half-zone (installed by the dsh-memory installer) ---',
      '- insert:',
      '    - id: dsh-memory-client',
      '      name: ./plugins/dsh-memory-client/lib/index.js'
    )
    $cMerge = Merge-PatchFile -Path $PatchFile -Block $clientBlock -IdName 'dsh-memory-client'
    if (@('created', 'registered', 'repaired') -contains $cMerge.Action) {
      Write-PatchFile -Path $PatchFile -Text $cMerge.Text | Out-Null
    }
    $r.ClientAction = $cMerge.Action
    $r.ClientDetail = $cMerge.Detail
  }
  return $r
}
# ===========================================================================
# Host compatibility warning (non-blocking)
# ===========================================================================
function Show-HostCompat([string]$ProfileDir, [string]$EnginesRange) {
  $hv = Get-HostVersionInfo $ProfileDir
  $range = $EnginesRange
  if (-not $hv.Version) {
    if ($range) { Write-Warn2 "宿主版本未知（dsh --version 与 profile package.json 都读不到）；无法校验 engines.dsh=$range（不阻断）" }
    else { Write-Item '宿主版本：未知（不阻断）' }
    return
  }
  if (-not $range) {
    Write-Fact '宿主版本' ($hv.Version + '（' + $hv.Source + '）')
    return
  }
  $ok = Test-SemverRange $hv.Version $range
  if ($null -eq $ok) {
    Write-Warn2 ("宿主版本 " + $hv.Version + '（' + $hv.Source + '）；要求的 engines.dsh=' + $range + ' 无法解析，跳过兼容校验（不阻断）')
    return
  }
  if ($ok) {
    Write-Fact '宿主版本' ($hv.Version + '（' + $hv.Source + '）；要求 ' + $range + ' → 满足')
  } else {
    Write-Warn2 ("宿主版本 " + $hv.Version + '（' + $hv.Source + '）不满足 engines.dsh=' + $range + '：插件可能不兼容，建议升级 DSH（不阻断安装）')
  }
}

# ===========================================================================
# MODE: install / upgrade
# ===========================================================================
function Invoke-InstallMode {
  $ctx = Get-Context
  if (-not $ctx.Ok) { Write-Bad $ctx.Error; return 1 }

  Write-Host 'dsh-memory installer v4'
  Write-Fact 'DSH_HOME' $DSH_HOME
  Write-Fact 'profile 来源' (Format-ProfileMode $ctx.Mode)
  Write-Fact '目标 profile' (($ctx.Targets) -join ', ')
  if ($ctx.EnvHint) { Write-Item $ctx.EnvHint }
  Write-Fact '记忆库' $ctx.MemRoot
  if ($LocalPayload) { Write-Fact 'payload' ('本地 ' + $LocalPayload) } else { Write-Fact '下载源' $RAW_BASE }

  # ---- 1. manifest ----
  Write-Head '[1/8] 解析 install-manifest.json'
  $src = Resolve-PayloadSource
  if (-not $src.Ok) { Write-Bad $src.Error; return 1 }
  $manifest = $null
  try { $manifest = ConvertTo-Manifest $src.ManifestText ($(if ($src.IsLocal) { $src.ManifestPath } else { '远程 install-manifest.json' })) }
  catch { Write-Bad ([string]$_.Exception.Message); return 1 }
  Write-Ok ('发布版本 v' + $manifest.version + '，共 ' + @($manifest.files).Count + ' 个文件（zip ' + $manifest.zip.bytes + ' bytes）')

  # ---- 2. zip ----
  Write-Head '[2/8] 获取 payload zip 并校验 sha256'
  $tmpDir = Get-TempDir 'dsh-memory-install-'
  $zipPath = ''
  $stage = Join-Path $tmpDir 'stage'
  try {
    if ($src.IsLocal) {
      if ($src.ZipPath) { $zipPath = $src.ZipPath }
      else {
        $cand = Join-Path (Join-Path (Split-Path -Parent $src.ManifestPath) 'payload') ([string]$manifest.zip.name)
        if (Test-Path -LiteralPath $cand -PathType Leaf) { $zipPath = $cand }
      }
      if (-not $zipPath -or -not (Test-Path -LiteralPath $zipPath -PathType Leaf)) {
        Write-Bad ("本地 payload zip 不存在：" + [string]$manifest.zip.name + "（应在 manifest 同目录的 payload/ 下，或用 -LocalPayload 指向它）")
        return 1
      }
      Write-Item ('使用本地 zip：' + $zipPath)
    } else {
      $zipPath = Join-Path $tmpDir ([string]$manifest.zip.name)
      $usedUrl = Get-RemoteFile ('payload/' + [string]$manifest.zip.name) $zipPath 'payload zip'
      if (-not $usedUrl) {
        Write-Bad "payload zip 下载失败（GitHub raw 与 jsDelivr 都不可达）。检查网络/代理，或用 -LocalPayload 离线安装。"
        return 1
      }
    }
    $zipLen = (Get-Item -LiteralPath $zipPath).Length
    $zipSha = Get-Sha256File $zipPath
    $expectSha = ([string]$manifest.zip.sha256).ToLowerInvariant()
    if ($zipSha -ne $expectSha) {
      Write-Bad "payload zip sha256 校验失败 —— 已中止，未改动任何文件。"
      Write-Bad ("  期望 " + $expectSha)
      Write-Bad ("  实际 " + $zipSha + '（' + $zipLen + ' bytes）')
      Write-Warn2 '常见原因：镜像/CDN 还是旧版、代理改写内容、下载中断。请重试或换 -RawBase。'
      return 1
    }
    Write-Ok ('zip sha256 校验通过（' + $zipLen + ' bytes, ' + $zipSha.Substring(0, 16) + '…）')

    # ---- 3. extract to staging + verify every file ----
    Write-Head '[3/8] 解压到临时目录并逐文件校验 sha256'
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    if (-not (Expand-PayloadZip $zipPath $stage)) { return 1 }
    $verify = Test-PayloadFiles $stage $manifest
    if ($verify.Missing.Count -gt 0 -or $verify.Mismatch.Count -gt 0) {
      Write-Bad 'payload 内容校验失败 —— 已中止，未改动任何文件。'
      foreach ($x in @($verify.Missing)) { Write-Bad ('  缺少：' + $x) }
      foreach ($x in @($verify.Mismatch)) { Write-Bad ('  不一致：' + $x) }
      return 1
    }
    Write-Ok (@($manifest.files).Count.ToString() + ' 个文件 sha256 全部匹配')

    $tplPath = Join-Path $stage 'AGENTS.template.md'
    $stagedPkg = Join-Path $stage 'package.json'

    # ---- 3.5 pre-detect migration state (before touching the installed plugin) ----
    Write-Head '[4/8] 检测记忆库状态（主题库 / 旧 md）'
    $stagedMigrate = Join-Path (Join-Path $stage 'memtopic\src') 'migrate.mjs'
    $preDetect = $null
    if ((Test-Path -LiteralPath $stagedMigrate -PathType Leaf) -and (Resolve-NodeRunner)) {
      $preDetect = Invoke-MigrateDetect $stagedMigrate $ctx.MemRoot $DSH_HOME
    }
    $staticVerdict = $null
    if (-not $preDetect -or -not $preDetect.Ok) {
      $staticVerdict = Get-StaticMigrationVerdict $ctx.MemRoot
      if ($preDetect -and $preDetect.Error) { Write-Item ('migrate --detect 不可用（' + $preDetect.Error + '），改用静态判断') }
      elseif (-not (Resolve-NodeRunner)) { Write-Item '未找到 node / DSH 桌面版：改用静态判断（库内计数不可用）' }
    }
    if ($preDetect -and $preDetect.Ok) { Format-MigrateDetect $preDetect.Json -InstallContext }
    else {
      Write-Fact '旧 md 文件' ([string]$staticVerdict.Md.Files + ' 个 / ' + [string]$staticVerdict.Md.Sentences + ' 句（近似）')
      Write-Fact '主题库' ($(if ($staticVerdict.Db.Exists) { '存在（' + $staticVerdict.Db.Bytes + ' bytes，计数不可用）' } else { '不存在' }))
      if ($staticVerdict.NeedsMigration) { Write-Fact '判定' '需要迁移（旧 md 有数据、主题库无数据）' }
      elseif ($staticVerdict.AlreadyMigrated) { Write-Fact '判定' '已迁移（主题库已有数据）' }
      else { Write-Fact '判定' '全新用户（无旧 md、无库）' }
    }

    # SCHEMA_TOO_NEW: abort BEFORE touching the installed plugin / memory config
    if ($preDetect -and $preDetect.Ok -and (Test-DetectSchemaTooNew $preDetect.Json)) {
      Write-Bad '记忆库 schema_version 高于本插件：已中止，未改动任何文件。'
      Write-Bad '  请先升级 dsh-memory 插件/安装器，不要手工修改库的 schema_version。'
      return 2
    }

    # ---- 4. backup + copy (per target profile) ----
    Write-Head '[5/8] 备份现有插件目录并写入新文件'
    $ctxs = @()
    foreach ($name in $ctx.Targets) { $ctxs += (Get-TargetContext $name) }
    $primaryCtx = $ctxs[0]
    foreach ($c in $ctxs) { if ($c.Name -eq $ctx.Primary) { $primaryCtx = $c; break } }
    $installRows = @()
    foreach ($c in $ctxs) {
      if ($ctxs.Count -gt 1) { Write-Head ('profile: ' + $c.Name) }
      Write-Item ('插件目录：' + $c.PluginDir)
      $backup = Backup-PluginDir $c.PluginDir
      if ($backup.Created) {
        Write-Ok ('已备份到 ' + $backup.Created + '（' + ($backup.Items -join ', ') + '）')
      } else {
        Write-Item '没有旧版本文件需要备份（该 profile 全新安装）'
      }
      $copied = Copy-PayloadToPlugin $stage $c.PluginDir $manifest
      Write-Ok ("写入 $copied 个文件")
      $memtopicDir = Join-Path $c.PluginDir 'memtopic\src'
      if (Test-Path -LiteralPath $memtopicDir) {
        $expected = @{}
        foreach ($f in @($manifest.files)) { if (([string]$f.path).StartsWith('memtopic/src/')) { $expected[(Split-Path -Leaf ([string]$f.path))] = $true } }
        $stale = @(Get-ChildItem -LiteralPath $memtopicDir -Filter '*.mjs' -File -ErrorAction SilentlyContinue | Where-Object { -not $expected.ContainsKey($_.Name) })
        if ($stale.Count -gt 0) { Write-Warn2 ('memtopic/src 下有旧文件不在本版 payload 中（保留未删）：' + (($stale | ForEach-Object { $_.Name }) -join ', ')) }
        Write-Fact 'memtopic' (@(Get-ChildItem -LiteralPath $memtopicDir -Filter '*.mjs' -File).Count.ToString() + ' 个 .mjs 模块就位')
      } else {
        Write-Bad 'memtopic/src 缺失：主题库架构不可用（payload 不完整？）'
        return 1
      }
      $installRows += @{ Name = $c.Name; Backup = $backup.Created; Patch = $c.PatchFile; PluginDir = $c.PluginDir }
    }

    # ---- 5. memory skeleton + flag decision (shared <DSH_HOME>/memory) ----
    Write-Head '[6/8] 初始化记忆库骨架并按迁移状态决定主题库开关'
    $created = Initialize-MemoryRoot $ctx.MemRoot
    if ($created.Count -gt 0) { Write-Item ('新建：' + ($created -join ' ; ')) }
    $flagDecision = Resolve-FlagDecision $preDetect $staticVerdict $ctx.MemRoot
    $cfgInfo = Get-ConfigInfo $ctx.MemRoot
    switch ($flagDecision.Action) {
      'set-true' {
        if ($cfgInfo.Exists -and -not $cfgInfo.Valid) {
          Write-Warn2 '.config.json 不是合法 JSON，跳过开关写入（请手工修好或备份删除后重装）'
        } else {
          $res = Set-ConfigFlagTrue $ctx.MemRoot
          if ($res.Ok -and $res.Changed) { Write-Ok '.config.json：新增 memoryTopicDbEnabled=true（主题库默认开启）' }
          elseif ($res.Ok) { Write-Ok ('.config.json：' + $res.Reason + '（值=' + [string]$res.Value + '）') }
          else { Write-Warn2 ('.config.json：' + $res.Reason) }
        }
      }
      'keep-user-false' {
        Write-Warn2 '主题库开关被显式设为 false —— 尊重你的设置，保持 md 模式；随时可在 设置 → 通用设置 → 记忆 里打开。'
      }
      'needs-migrate' {
        Write-Warn2 '未开启主题库开关：先保持 md 模式最稳（写完能落 md），迁移完成后再打开。'
      }
      'needs-migrate-host-running' {
        Write-Warn2 '未开启主题库开关：检测到 DSH 正在运行且旧记忆未迁移 —— 保持 md 模式（行为零变化）。'
      }
      default { Write-Item '主题库开关：无需改动' }
    }
    if ($flagDecision.Action -eq 'needs-migrate-host-running') {
      Write-Head '登记迁移待办（重启 DSH 后自动执行）'
      $null = Register-PendingMigration $ctx.MemRoot $primaryCtx.PluginDir '安装器安装：检测到 DSH 正在运行且旧记忆未迁移，登记为下次启动自动迁移'
    }

    # ---- 6. AGENTS.md ----
    Write-Head '[7/8] 处理 AGENTS.md（记忆协议模板）'
    $agentsRes = Update-AgentsFile $DSH_HOME $tplPath
    switch ($agentsRes.Action) {
      'created' { Write-Ok ('已写入 v4 记忆协议：' + $agentsRes.Path) }
      'current' { Write-Ok 'AGENTS.md 已是 v4 协议（跳过）' }
      'upgraded' {
        Write-Ok ('AGENTS.md 从旧模板升级为 v4（备份：' + $agentsRes.Backup + '）')
      }
      'user-modified' {
        Write-Warn2 'AGENTS.md 存在且被改过 —— 安装器不覆盖它（你的文件归你所有）。'
        Write-Item ('如需 v4 协议，参考：' + (Join-Path $primaryCtx.PluginDir 'AGENTS.template.md') + '（先自行合并/备份）')
      }
      default { Write-Warn2 ('AGENTS.md 未处理：' + $agentsRes.Detail) }
    }

    # ---- 7. patch registration (per target) ----
    Write-Head '[8/8] 注册 cordis.patch.yml'
    $multi = ($ctxs.Count -gt 1)
    if ($multi) {
      Write-Item ('多 profile 模式（' + $ctxs.Count + ' 个目标）：新注册用相对路径形式；已有注册行不动；junction 指向主 profile 的插件目录')
      $jj = Ensure-Junction $DSH_HOME $primaryCtx.PluginDir
      Write-Item ('junction（主 profile）：' + $jj.Detail)
    }
    $regRows = @()
    foreach ($c in $ctxs) {
      $res = Register-Plugin -DshHome $DSH_HOME -PluginDir $c.PluginDir -PatchFile $c.PatchFile -JunctionTarget $primaryCtx.PluginDir -ForcePathForm:$multi
      switch ($res.Action) {
        'created' { Write-Ok ('[' + $c.Name + '] 已创建 ' + $c.PatchFile + ' 并注册 dsh-memory') }
        'registered' {
          Write-Ok ('[' + $c.Name + '] 已注册（' + $res.Detail + '）')
          if ($res.Backup) { Write-Item ('  备份：' + $res.Backup) }
        }
        'repaired' {
          Write-Ok ('[' + $c.Name + '] 已修复（' + $res.Detail + '）')
          if ($res.Backup) { Write-Item ('  备份：' + $res.Backup) }
        }
        'skip' { Write-Ok ('[' + $c.Name + '] 已注册（跳过，无重复行）') }
        default {
          Write-Bad ('[' + $c.Name + '] 未注册：' + $res.Detail)
          Write-Warn2 ('  插件文件已安装；请手工把 ' + $c.PatchFile + '.dsh-memory-block.txt 合并进 patch 层')
        }
      }
      $regRows += @{ Name = $c.Name; Ok = $res.Ok; Action = $res.Action; Form = $res.Form; Patch = $c.PatchFile }
    }
    if (@($regRows | Where-Object { -not $_.Ok }).Count -gt 0) { return 1 }

    # ---- final report ----
    $pkgVersion = ''
    $engines = ''
    if (Test-Path -LiteralPath $stagedPkg -PathType Leaf) {
      try {
        $pj = (Read-TextFile $stagedPkg) | ConvertFrom-Json
        $pkgVersion = [string](Get-PropValue $pj 'version')
        $eng = Get-PropValue $pj 'engines'
        if ($eng) { $engines = [string](Get-PropValue $eng 'dsh') }
      } catch { }
    }
    $installedV = Get-InstalledVersion (Join-Path $primaryCtx.PluginDir 'index.js')

    Write-Head '安装完成'
    Write-Fact '发布版本' ('v' + $manifest.version)
    if ($pkgVersion -and $pkgVersion -ne [string]$manifest.version) { Write-Warn2 ("package.json v$pkgVersion 与 manifest v$($manifest.version) 不一致") }
    Write-Fact '目标 profile' (($ctxs | ForEach-Object { $_.Name }) -join ', ')
    Write-Fact 'profile 来源' (Format-ProfileMode $ctx.Mode)
    if ($ctx.EnvHint) { Write-Item $ctx.EnvHint }
    Write-Fact '记忆库' $ctx.MemRoot
    Show-HostCompat $primaryCtx.ProfileDir $engines
    Write-Host ''
    Write-Host ('  {0,-12} {1,-10} {2,-24} {3,-8} {4}' -f 'profile', '版本', 'patch 注册', 'flag', '备份') -ForegroundColor Cyan
    foreach ($c in $ctxs) {
      $ver = Get-InstalledVersion (Join-Path $c.PluginDir 'index.js')
      $ri = Get-MemoryRegistrationInfo $c.PatchFile
      $regTxt = if ($ri.Found) { 'ok/' + $ri.Kind } else { 'MISSING' }
      $flagTxt = '共享'
      if ($cfgInfo.HasKey) { $flagTxt = if (ConvertTo-Boolish $cfgInfo.Value) { 'on' } else { 'off' } } elseif ($cfgInfo.Exists) { $flagTxt = '未设置' }
      $bk = ''
      foreach ($row in $installRows) { if ($row.Name -eq $c.Name) { $bk = if ($row.Backup) { 'new _backup' } else { 'fresh' } } }
      Write-Host (('  {0,-12} {1,-10} {2,-24} {3,-8} {4}' -f $c.Name, ('v' + $ver), $regTxt, $flagTxt, $bk)) -ForegroundColor Gray
    }

    # migration guidance (per state)
    Show-MigrationGuidance $preDetect $staticVerdict $flagDecision @{ PluginDir = $primaryCtx.PluginDir }

    Write-Head '下一步'
    Write-Item '重启 DSH 才加载新插件（宿主插件需重启，热更新不覆盖已加载代码）。'
    if ($multi) { Write-Item ('多个 profile 已同时更新；桌面版用户重启 App 即生效（读到 ' + $primaryCtx.Name + ' 那一份）。') }
    Write-Item '首次会话会自动注入记忆；空记忆库时按提示做一次初始化（约 1 分钟，也可 /memory-init）。'
    Write-Item '检查安装状态（只读）：重跑本安装器加 -CheckOnly'
    Write-Item ('卸载（保留记忆数据）：-Uninstall   ·   老记忆迁移：-Migrate --yes')
    return 0
  }
  finally {
    Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Get-InstalledVersion([string]$File) {
  if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return '' }
  $raw = Read-TextFile $File
  if ($null -eq $raw) { return '' }
  $m = [regex]::Match($raw, 'const PLUGIN_VERSION\s*=\s*"([^"]+)"')
  if ($m.Success) { return $m.Groups[1].Value }
  return ''
}

# 开关决策表（与 Lead 的裁决一致）
function Resolve-FlagDecision($Detect, $Static, [string]$MemRoot) {
  $r = @{ Action = 'none'; Reason = ''; NeedsMigration = $false; AlreadyMigrated = $false; Empty = $false; HostRunning = $null; SchemaTooNew = $false; NextCommand = '' }
  if ($Detect -and $Detect.Ok) {
    $j = $Detect.Json
    $r.NeedsMigration = ConvertTo-Boolish (Get-PropValue $j 'needsMigration')
    $r.AlreadyMigrated = ConvertTo-Boolish (Get-PropValue $j 'alreadyMigrated')
    $r.Empty = ConvertTo-Boolish (Get-PropValue $j 'empty')
    $hostInfo = Get-PropValue $j 'host'
    if ($hostInfo) { $r.HostRunning = ConvertTo-Boolish (Get-PropValue $hostInfo 'running') }
    $r.NextCommand = [string](Get-PropValue $j 'nextCommand')
    $r.SchemaTooNew = (Test-DetectSchemaTooNew $j)
  }
  elseif ($Static) {
    $r.NeedsMigration = $Static.NeedsMigration
    $r.AlreadyMigrated = $Static.AlreadyMigrated
    $r.Empty = $Static.Empty
    $r.HostRunning = $null
  }
  if ($r.SchemaTooNew) { $r.Action = 'abort'; return $r }
  if ($r.NeedsMigration) {
    if ($r.HostRunning -eq $true) { $r.Action = 'needs-migrate-host-running' }
    else { $r.Action = 'needs-migrate' }
    return $r
  }
  if ($r.AlreadyMigrated) {
    $cfg = Get-ConfigInfo $MemRoot
    if ($cfg.HasKey -and -not (ConvertTo-Boolish $cfg.Value)) { $r.Action = 'keep-user-false' }
    else { $r.Action = 'set-true' }
    return $r
  }
  if ($r.Empty) { $r.Action = 'set-true'; return $r }
  $r.Action = 'set-true'   # 无法判定（既无 md 也读不到库）时按新用户处理：开
  return $r
}

function Get-ReinstallCommand {
  # 给用户一条可复制的命令
  $migrate = '-Migrate --yes'
  if ($PSCommandPath -and (Test-Path -LiteralPath $PSCommandPath -PathType Leaf)) {
    return ('powershell -NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" ' + $migrate)
  }
  return ('& ([scriptblock]::Create((irm ' + $RAW_BASE + '/install.ps1))) ' + $migrate)
}

function Get-ManualMigrateCommand([string]$PluginDir) {
  $runner = Resolve-NodeRunner
  $js = Join-Path (Join-Path $PluginDir 'memtopic\src') 'migrate.mjs'
  $memRoot = Join-Path $DSH_HOME 'memory'
  $db = Join-Path $memRoot '.memtopic\mem.db'
  $tail = '--detect --md-root "' + $memRoot + '" --db "' + $db + '" --dsh-home "' + $DSH_HOME + '"'
  if ($runner -and $runner.Kind -eq 'electron') {
    return ('$env:ELECTRON_RUN_AS_NODE=1; & "' + $runner.Exe + '" "' + $js + '" ' + $tail + '; Remove-Item Env:ELECTRON_RUN_AS_NODE')
  }
  $nodeExe = if ($runner) { $runner.Exe } else { 'node' }
  return ('& "' + $nodeExe + '" "' + $js + '" ' + $tail)
}

function Show-MigrationGuidance($Detect, $Static, $FlagDecision, $Ctx) {
  $state = $FlagDecision.Action
  if ($state -eq 'needs-migrate' -or $state -eq 'needs-migrate-host-running') {
    Write-Head '⚠ 检测到旧版 md 记忆库 —— 建议尽快迁移（旧文件只读导入，不删除、可回滚）'
    if ($Detect -and $Detect.Ok) { Format-MigrateDetect $Detect.Json -InstallContext }
    elseif ($Static) {
      Write-Fact '旧 md 文件' ([string]$Static.Md.Files + ' 个 / ' + [string]$Static.Md.Sentences + ' 句（近似）')
      Write-Fact '主题库' ($(if ($Static.Db.Exists) { '存在' } else { '不存在' }))
    }
    if ($state -eq 'needs-migrate-host-running') {
      Write-Head '已登记：下次启动 DSH 时自动迁移'
      Write-Item '插件在 boot 时会读取 pending 标记并自动执行迁移（先快照；失败自动回退 md 模式，不影响使用）。'
      Write-Item '已登记期间：旧 md 仍可被 memory_search 检索（md 兜底），记忆不会丢。'
      Write-Item '也可以不等自动迁移：完全退出 DSH 后执行下面的命令之一。'
    }
    Write-Head '迁移命令（三选一）'
    Write-Item '① 重跑安装器（推荐；DSH 运行中会自动登记，退出后直接迁移）：'
    Write-Host ('     ' + (Get-ReinstallCommand)) -ForegroundColor White
    Write-Item '② 会话内：输入 /memory-migrate （只读报告；加 --apply 执行）'
    Write-Item '③ 手工 node 命令（先 --detect，再 --apply --yes）：'
    Write-Host ('     ' + (Get-ManualMigrateCommand $Ctx.PluginDir)) -ForegroundColor White
    Write-Item '说明：迁移前旧 md 仍可被 memory_search 检索（插件有 md 兜底），记忆不会"消失"；'
    Write-Item '      迁移完成后必须重启 DSH 才切到主题库真源。'
    return
  }
  if ($state -eq 'keep-user-false') {
    Write-Item '主题库开关：你显式关闭了主题库（memoryTopicDbEnabled=false），安装器尊重该设置。'
    return
  }
  if ($state -eq 'set-true') {
    Write-Ok '主题库已启用（新用户/已迁移用户的默认）。'
    return
  }
  if ($state -eq 'abort') {
    Write-Bad '记忆库版本高于本插件，已中止。'
    return
  }
  Write-Item '记忆库状态：无需迁移。'
}

# ===========================================================================
# MODE: -CheckOnly
# ===========================================================================
function Invoke-CheckMode {
  $ctx = Get-Context
  if (-not $ctx.Ok) { Write-Bad $ctx.Error; return 1 }
  $ctxs = @()
  foreach ($name in $ctx.Targets) { $ctxs += (Get-TargetContext $name) }
  $primaryCtx = $ctxs[0]
  foreach ($c in $ctxs) { if ($c.Name -eq $ctx.Primary) { $primaryCtx = $c; break } }
  $pluginDir = $primaryCtx.PluginDir

  Write-Host 'dsh-memory installer v4 - check only (nothing is downloaded except the small manifest; nothing is written)'
  Write-Fact 'DSH_HOME' $DSH_HOME
  Write-Fact 'profile 来源' (Format-ProfileMode $ctx.Mode)
  Write-Fact '目标 profile' (($ctxs | ForEach-Object { $_.Name }) -join ', ')
  if ($ctx.EnvHint) { Write-Item $ctx.EnvHint }
  Write-Fact '记忆库' $ctx.MemRoot
  if ($ctx.Targets -contains 'desktop') { Write-Item '桌面版用户：请重点看 desktop 这一段的结论。' }
  Write-Rule

  # ---- manifest (shared, small download) ----
  $manifest = $null
  $manifestError = ''
  $src = Resolve-PayloadSource
  if ($src.Ok) {
    try { $manifest = ConvertTo-Manifest $src.ManifestText ($(if ($src.IsLocal) { $src.ManifestPath } else { '远程 install-manifest.json' })) }
    catch { $manifestError = [string]$_.Exception.Message }
  } else { $manifestError = $src.Error }

  # ---- 1. versions (per profile) ----
  Write-Head '[1/11] 版本'
  if ($manifest) { Write-Fact '发布版本' ('v' + $manifest.version + '（' + $(if ($src.IsLocal) { $src.ManifestPath } else { '远程 manifest' }) + '）') }
  else { Write-Warn2 ('无法获取发布 manifest：' + $manifestError) }
  $installedV = ''
  foreach ($c in $ctxs) {
    $idx = Join-Path $c.PluginDir 'index.js'
    $v = Get-InstalledVersion $idx
    $exists = Test-Path -LiteralPath $idx -PathType Leaf
    if ($c -eq $primaryCtx) { $installedV = $v }
    if (-not $exists) { Write-Warn2 ('[' + $c.Name + '] 未安装（运行安装器即可）') }
    else {
      $extra = '，index.js ' + (Get-Item -LiteralPath $idx).Length + ' bytes'
      if ($manifest -and $v -and ([string]$v -ne [string]$manifest.version)) { Write-Warn2 ('[' + $c.Name + '] v' + $v + $extra + ' ↔ 发布 v' + $manifest.version + '（可升级：重跑安装器）') }
      elseif ($manifest -and $v) { Write-Ok ('[' + $c.Name + '] v' + $v + $extra + '（= 发布版本）') }
      else { Write-Fact ('[' + $c.Name + ']') ('v' + $v + $extra) }
    }
  }

  # ---- 2. payload completeness (per profile) ----
  Write-Head '[2/11] payload 完整性（逐文件 sha256）'
  $badProfiles = @()
  foreach ($c in $ctxs) {
    $missing = @(); $mismatch = @(); $okCount = 0; $total = 0
    if ($manifest) {
      foreach ($f in @($manifest.files)) {
        $total++
        $rel = ([string]$f.path) -replace '/', '\'
        # [BUG-6] client/** 实际落在 <plugins>/dsh-memory-client/（宿主按该路径加载），不在 <pluginDir>/client/
        if ($rel -like 'client\*') {
          $abs = Join-Path (Join-Path (Split-Path -Parent $c.PluginDir) 'dsh-memory-client') ($rel.Substring('client\'.Length))
        } else {
          $abs = Join-Path $c.PluginDir $rel
        }
        if (-not (Test-Path -LiteralPath $abs -PathType Leaf)) { $missing += [string]$f.path; continue }
        if ((Get-Sha256File $abs) -ne ([string]$f.sha256).ToLowerInvariant()) { $mismatch += [string]$f.path; continue }
        $okCount++
      }
      if ($missing.Count -eq 0 -and $mismatch.Count -eq 0) {
        Write-Ok ('[' + $c.Name + '] ' + $okCount + '/' + $total + ' 个文件 sha256 全部匹配')
      } else {
        Write-Bad ('[' + $c.Name + '] ' + $okCount + '/' + $total + ' 匹配；缺失 ' + $missing.Count + '（' + (($missing | Select-Object -First 6) -join ', ') + '），不一致 ' + $mismatch.Count + '（' + (($mismatch | Select-Object -First 6) -join ', ') + '）')
        Write-Item ('  修复：重跑安装器（会先备份到 _backup-<时间戳>/）')
        $badProfiles += $c.Name
      }
    } else {
      $must = @('index.js', 'package.json', 'AGENTS.template.md', 'memtopic/src/upgrade.mjs')
      $lost = @($must | Where-Object { -not (Test-Path -LiteralPath (Join-Path $c.PluginDir ($_ -replace '/', '\'))) })
      if ($lost.Count -gt 0) { Write-Bad ('[' + $c.Name + '] 关键文件缺失：' + ($lost -join ', ')); $badProfiles += $c.Name }
      else { Write-Ok ('[' + $c.Name + '] 关键文件齐全（无 manifest，未做 sha 校验）') }
    }
  }
  if (-not $manifest) { Write-Warn2 '无 manifest：只做目录/关键文件检查，未做逐文件 sha 校验' }

  # ---- 3. memtopic modules (per profile) ----
  Write-Head '[3/11] memtopic 运行时模块'
  $needed = @('memory-store.mjs', 'governance.mjs', 'lifecycle.mjs', 'backend-sqlite.mjs', 'backend-ledger.mjs', 'import.mjs', 'upgrade.mjs', 'detect.mjs', 'curation.mjs', 'curation-apply.mjs', 'tree-apply.mjs', 'migrate.mjs')
  $lostModules = @()
  foreach ($c in $ctxs) {
    $dir = Join-Path $c.PluginDir 'memtopic\src'
    $found = @()
    if (Test-Path -LiteralPath $dir -PathType Container) { $found = @(Get-ChildItem -LiteralPath $dir -Filter '*.mjs' -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name) }
    $lost = @($needed | Where-Object { $found -notcontains $_ })
    if ($lost.Count -gt 0) {
      Write-Bad ('[' + $c.Name + '] ' + $found.Count + ' 个 .mjs，缺：' + ($lost -join ', ') + ' → 主题库架构不可用，重跑安装器')
      $lostModules += $c.Name
    } else {
      Write-Ok ('[' + $c.Name + '] ' + $found.Count + ' 个 .mjs，关键模块齐全')
    }
  }

  # ---- 4. DB status (shared) ----
  Write-Head '[4/11] 主题库状态'
  $db = Get-TopicDbStatus $ctx.MemRoot
  if (-not $db.Exists) { Write-Item ('不存在：' + $db.Path) }
  else {
    $line = ('存在：' + $db.Bytes + ' bytes')
    if ($null -ne $db.Topics) { $line += ('，主题 ' + $db.Topics + ' / 句子 ' + $db.Sentences) }
    if ($db.SchemaVersion) { $line += ('，schema_version=' + [string]$db.SchemaVersion) }
    Write-Fact '库' $line
    if ($db.Error) { Write-Item ('注：' + $db.Error) }
  }

  # ---- 5. legacy md (shared) ----
  Write-Head '[5/11] 遗留 md（迁移前数据源）'
  $md = Get-LegacyMdStats $ctx.MemRoot
  Write-Fact '可导入' ($md.Files.ToString() + ' 个文件 / ' + $md.Sentences + ' 句（非空行近似）')
  $layerBits = @()
  foreach ($k in @('knowledge', 'sessions', 'projects', 'tools')) { $v = $md.ByLayer[$k]; if ($v.Files -gt 0) { $layerBits += ($k + '=' + $v.Files + 'f/' + $v.Sentences + 's') } }
  if ($layerBits.Count -gt 0) { Write-Fact '分层' ($layerBits -join '  ') }
  if ($md.HumanLayer.Count -gt 0) { Write-Fact '人工稳定层' ($md.HumanLayer -join '、') }

  # ---- 6. migration state (prefer migrate.mjs --detect --json from the primary install) ----
  Write-Head '[6/11] 迁移状态（migrate.mjs --detect --json）'
  $migrateJs = Get-MigrateScriptPath $pluginDir
  $detect = $null
  if ($migrateJs) {
    $detect = Invoke-MigrateDetect $migrateJs $ctx.MemRoot $DSH_HOME
    if ($detect.Ok) { Format-MigrateDetect $detect.Json }
    else {
      Write-Warn2 ('已调用 migrate.mjs 但结果不可用：' + $detect.Error)
      if ($detect.Raw) { Write-Item ('原始输出：' + $detect.Raw.Trim()) }
    }
  } else {
    Write-Warn2 '主 profile 插件目录里没有 memtopic/src/migrate.mjs（旧版插件或 payload 不完整）→ 用静态判断'
  }
  if (-not ($detect -and $detect.Ok)) {
    $sv = Get-StaticMigrationVerdict $ctx.MemRoot
    if ($sv.NeedsMigration) { Write-Warn2 '静态判断：需要迁移（旧 md 有数据、主题库无数据）' }
    elseif ($sv.AlreadyMigrated) { Write-Ok '静态判断：已迁移（主题库已有数据）' }
    else { Write-Ok '静态判断：全新用户（无旧 md、无库）' }
    Write-Item ('迁移命令：' + (Get-ManualMigrateCommand $pluginDir))
  }

  # ---- 7. pending migrate marker (shared) ----
  Write-Head '[7/11] pending 迁移标记'
  Show-PendingMarker $ctx.MemRoot

  # ---- 8. .config.json (shared) ----
  Write-Head '[8/11] .config.json（插件开关）'
  $cfg = Get-ConfigInfo $ctx.MemRoot
  if (-not $cfg.Exists) { Write-Item ('不存在：' + $cfg.Path + ' → 新装将写入 memoryTopicDbEnabled=true') }
  elseif (-not $cfg.Valid) { Write-Bad ('.config.json 不是合法 JSON：' + $cfg.Path) }
  elseif ($cfg.HasKey) { Write-Fact 'memoryTopicDbEnabled' ([string]$cfg.Value + $(if (ConvertTo-Boolish $cfg.Value) { '（主题库模式）' } else { '（md 模式）' })) }
  else { Write-Warn2 '.config.json 没有 memoryTopicDbEnabled 键（安装器会补 true）' }

  # ---- 9. AGENTS.md (shared) ----
  Write-Head '[9/11] AGENTS.md（记忆协议）'
  $agents = Get-AgentsState $DSH_HOME
  switch ($agents.State) {
    'missing' { Write-Warn2 ('不存在：' + $agents.Path + '（安装器会写 v4 模板）') }
    'v4' { Write-Ok 'v4 协议（主题库模式）' }
    'legacy-v3' { Write-Warn2 ('旧 v3 模板（sha ' + $agents.Sha.Substring(0, 12) + '…）→ 重跑安装器会备份后升级 v4') }
    'user-modified' { Write-Warn2 ('用户已修改（sha ' + $agents.Sha.Substring(0, 12) + '…，' + $agents.Bytes + ' bytes）→ 安装器不会覆盖') }
    default { Write-Warn2 ('无法读取：' + $agents.Path) }
  }

  # ---- 10. host compatibility (shared) ----
  Write-Head '[10/11] 宿主版本兼容（不阻断）'
  $engines = ''
  $pkgPath = Join-Path $pluginDir 'package.json'
  if (Test-Path -LiteralPath $pkgPath -PathType Leaf) {
    try { $pj = (Read-TextFile $pkgPath) | ConvertFrom-Json; $eng = Get-PropValue $pj 'engines'; if ($eng) { $engines = [string](Get-PropValue $eng 'dsh') } } catch { }
  }
  Show-HostCompat $primaryCtx.ProfileDir $engines

  # ---- 11. patch registration + junction (per profile; junction is shared) ----
  Write-Head '[11/11] patch 层注册 / junction'
  $junction = Get-JunctionInfo $DSH_HOME $pluginDir
  if (-not $junction.Exists) {
    Write-Warn2 ('junction 不存在：' + $junction.Path + '（包名形式注册会加载不到插件；重跑安装器重建）')
  }
  elseif (-not $junction.IsLink) {
    Write-Warn2 ('junction 位置被同名普通目录/文件占用（不是链接）：' + $junction.Path + ' → 包名解析可能失败')
  }
  elseif ($junction.Matches) {
    Write-Ok ('junction 指向插件目录：' + $junction.Target)
  }
  else {
    Write-Warn2 ('junction 指向不匹配：' + $junction.Target + ' ≠ ' + $pluginDir + '（重跑安装器重建）')
  }
  $needsJunction = $false
  foreach ($c in $ctxs) {
    $reg = Get-MemoryRegistrationInfo $c.PatchFile
    if (-not $reg.Exists) {
      Write-Warn2 ('[' + $c.Name + '] patch 文件不存在（安装器会创建并注册）：' + $c.PatchFile)
      continue
    }
    if (-not $reg.Found) {
      Write-Bad ('[' + $c.Name + '] 未注册 dsh-memory（重跑安装器）：' + $c.PatchFile)
      continue
    }
    Write-Ok ('[' + $c.Name + '] 已注册 · ' + (Get-RegistrationKindLabel $reg.Kind))
    if ($reg.NameValue) { Write-Item ('  name: ' + $reg.NameValue + '   ·   patch 顶层条目 ' + $reg.TopEntries) }
    if ($reg.Kind -eq 'package') { $needsJunction = $true }
    if ($reg.Stray -gt 0 -and $reg.TopEntries -gt 0) {
      Write-Bad ('  [' + $c.Name + '] 形状异常：' + $reg.Stray + ' 个游离 [] 行与 ' + $reg.TopEntries + ' 个顶层条目并存（重跑安装器或 fix-cordis-patch.ps1）')
    }
  }
  if ($needsJunction -and (-not $junction.Exists -or -not $junction.IsLink)) {
    Write-Bad '有 profile 用包名形式注册（name: dsh-memory）但 junction 缺失/无效 → 插件会静默不加载；重跑安装器即可修复。'
  }
  if ($needsJunction -and $junction.Exists -and $junction.IsLink -and -not $junction.Matches) {
    Write-Warn2 '包名形式注册依赖 junction 指向当前插件目录；当前指向 ' + $junction.Target + '，重跑安装器可重建。'
  }

  # ---- summary ----
  Write-Head '体检结论'
  $issues = @()
  foreach ($c in $ctxs) {
    $v = Get-InstalledVersion (Join-Path $c.PluginDir 'index.js')
    if (-not $v) { $issues += ('[' + $c.Name + '] 插件未安装 → 直接运行安装器') }
    elseif ($manifest -and $v -ne [string]$manifest.version) { $issues += ('[' + $c.Name + '] 可升级 v' + $v + ' -> v' + $manifest.version + '（重跑安装器）') }
    if ($badProfiles -contains $c.Name) { $issues += ('[' + $c.Name + '] payload 文件缺失/不一致 → 重跑安装器') }
    if ($lostModules -contains $c.Name) { $issues += ('[' + $c.Name + '] memtopic 模块缺失 → 重跑安装器') }
    $reg = Get-MemoryRegistrationInfo $c.PatchFile
    if (-not $reg.Found) { $issues += ('[' + $c.Name + '] patch 层未注册 → 重跑安装器') }
    if ($reg.Found -and $reg.Kind -eq 'package' -and (-not $junction.Exists -or -not $junction.IsLink -or -not $junction.Matches)) { $issues += ('[' + $c.Name + '] junction 缺失/不匹配 → 重跑安装器') }
  }
  if ($agents.State -eq 'legacy-v3') { $issues += 'AGENTS.md 仍是 v3 → 重跑安装器自动升级 v4' }
  # [CRA M2 修复 2026-11-05] -CheckOnly 必须能看见 legacy-v4：否则 4.0.1 未改用户会被报成「无法读取」，
  #   而这正是文档推荐给老用户的验证入口。
  if ($agents.State -eq 'legacy-v4') { $issues += 'AGENTS.md 是 4.0.1 时代 v4 模板（无会话笔记 memory_note）→ 重跑安装器自动升级 v4.5（会先备份）' }
  if ($detect -and $detect.Ok) {
    $needs = ConvertTo-Boolish (Get-PropValue $detect.Json 'needsMigration')
    if ($needs) { $issues += '旧 md 记忆需要迁移 → -Migrate（DSH 运行中会登记为"重启后自动迁移"）' }
  } elseif ($md.Sentences -gt 0 -and -not ($db.Exists -and [int]$db.Topics -gt 0)) {
    $issues += '旧 md 记忆可能未迁移 → -Migrate（或先重跑安装器补齐 migrate.mjs）'
  }
  $pm = Get-PendingMarker $ctx.MemRoot
  if ($pm.Exists -and $pm.Valid) {
    Write-Warn2 ('已登记迁移，等待重启 DSH 消费（at=' + [string](Get-PropValue $pm.Json 'at') + ', requestedBy=' + [string](Get-PropValue $pm.Json 'requestedBy') + '）')
  }
  if ($issues.Count -eq 0) { Write-Ok '一切就绪，无需操作。' }
  else { foreach ($i in $issues) { Write-Warn2 $i } }
  return 0
}

# ===========================================================================
# MODE: -Migrate
# ===========================================================================
# ===========================================================================
# pending migrate marker  <mdRoot>/.memtopic/migrate-pending.json
# 契约（与插件 boot 消费端逐字段一致）：
#   { schemaVersion:1, at:<ISO UTC>, requestedBy:"installer"|"command",
#     mdRoot:<abs>, dbFile:<abs>, pluginVersion:<str>, note?:<str> }
# 原子写入（临时文件 + 改名）；失败不致命：降级为打印手工命令，退出码仍 0。
# ===========================================================================
function Get-PendingMarkerPath([string]$MemRoot) {
  return (Join-Path (Join-Path $MemRoot '.memtopic') 'migrate-pending.json')
}

function Get-PendingMarker([string]$MemRoot) {
  $p = Get-PendingMarkerPath $MemRoot
  $r = @{ Path = $p; Exists = $false; Valid = $false; Json = $null; Error = '' }
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { return $r }
  $r.Exists = $true
  $txt = Read-TextFile $p
  if ($null -eq $txt) { $r.Error = '文件不可读'; return $r }
  try { $r.Json = $txt | ConvertFrom-Json; $r.Valid = $true } catch { $r.Error = 'JSON 解析失败：' + $_.Exception.Message }
  return $r
}

function Write-PendingMarker([string]$MemRoot, [string]$PluginVersion, [string]$Note) {
  $r = @{ Ok = $false; Path = (Get-PendingMarkerPath $MemRoot); Error = '' }
  $tmp = ''
  $dir = Split-Path -Parent $r.Path
  try {
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $obj = [ordered]@{
      schemaVersion = 1
      at            = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      requestedBy   = 'installer'
      mdRoot        = $MemRoot
      dbFile        = (Join-Path $dir 'mem.db')
      pluginVersion = $PluginVersion
    }
    if ($Note) { $obj['note'] = $Note }
    $json = ($obj | ConvertTo-Json -Depth 5)
    $tmp = $r.Path + '.tmp-' + [Guid]::NewGuid().ToString('N')
    Write-TextNoBom $tmp ($json + "`n")
    if (Test-Path -LiteralPath $r.Path) { Remove-Item -LiteralPath $r.Path -Force }
    Move-Item -LiteralPath $tmp -Destination $r.Path -Force
    $r.Ok = $true
  } catch {
    $r.Error = $_.Exception.Message
    if ($tmp -and (Test-Path -LiteralPath $tmp)) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
  }
  return $r
}

function Show-PendingMarker([string]$MemRoot) {
  $pm = Get-PendingMarker $MemRoot
  if (-not $pm.Exists) { Write-Item 'pending 迁移标记：无'; return }
  if (-not $pm.Valid) { Write-Warn2 ('pending 迁移标记存在但无法解析：' + $pm.Path + '（' + $pm.Error + '）'); return }
  $j = $pm.Json
  Write-Fact 'pending 迁移标记' ('存在：' + $pm.Path)
  Write-Item ('已登记迁移，等待重启 DSH 消费（at=' + [string](Get-PropValue $j 'at') + ', requestedBy=' + [string](Get-PropValue $j 'requestedBy') + ', pluginVersion=' + [string](Get-PropValue $j 'pluginVersion') + '）')
}

# 迁移已完成/已就绪时清除 pending 标记（插件 boot 消费成功后也是同样动作）
function Remove-PendingMarker([string]$MemRoot) {
  $p = Get-PendingMarkerPath $MemRoot
  if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { return $false }
  try { Remove-Item -LiteralPath $p -Force; return $true } catch { Write-Warn2 ('pending 标记删除失败：' + $_.Exception.Message); return $false }
}

function Get-InstalledPluginVersion([string]$PluginDir) {
  $v = Get-InstalledVersion (Join-Path $PluginDir 'index.js')
  if ($v) { return $v }
  $pkg = Join-Path $PluginDir 'package.json'
  if (Test-Path -LiteralPath $pkg -PathType Leaf) {
    try { $pj = (Read-TextFile $pkg) | ConvertFrom-Json; return [string](Get-PropValue $pj 'version') } catch { }
  }
  return ''
}

# 登记 pending 迁移；写入失败时降级打印手工命令（不修改 flag，退出码 0）
function Register-PendingMigration([string]$CtxMemRoot, [string]$PluginDir, [string]$Reason) {
  $pv = Get-InstalledPluginVersion $PluginDir
  $wr = Write-PendingMarker $CtxMemRoot $pv $Reason
  if ($wr.Ok) {
    Write-Ok ('已登记迁移：' + $wr.Path)
    Write-Item '重启 DSH 后插件会在启动时自动执行迁移（先快照；失败自动回退 md 模式，不影响使用）。'
    Write-Item '登记期间旧 md 仍可被 memory_search 检索（插件有 md 兜底），记忆不会丢。'
    Write-Item ('不想等自动迁移：完全退出 DSH 后执行  ' + (Get-ReinstallCommand))
    return $true
  }
  Write-Warn2 ('pending 标记写入失败：' + $wr.Error + '（不算失败，降级为手工迁移）')
  Write-Item '手工迁移命令：'
  Write-Host ('     ' + (Get-ReinstallCommand)) -ForegroundColor White
  return $false
}

# 确保主题库开关：未设置 -> 补 true；显式 false -> 尊重用户
function Ensure-TopicDbFlag([string]$MemRoot, [switch]$Quiet) {
  $cfg = Get-ConfigInfo $MemRoot
  if ($cfg.Exists -and -not $cfg.Valid) {
    Write-Warn2 '.config.json 不是合法 JSON，跳过开关写入（请手工在设置里打开主题库）'
    return
  }
  if ($cfg.HasKey) {
    if (ConvertTo-Boolish $cfg.Value) { if (-not $Quiet) { Write-Ok '主题库开关：已开启（memoryTopicDbEnabled=true）' } }
    else { Write-Warn2 '主题库开关被显式设为 false —— 尊重你的设置；可随时在 设置 → 通用设置 → 记忆 里打开。' }
    return
  }
  $res = Set-ConfigFlagTrue $MemRoot
  if ($res.Ok) { Write-Ok '主题库开关：已写入 memoryTopicDbEnabled=true' } else { Write-Warn2 ('主题库开关未写入：' + $res.Reason) }
}

function Invoke-MigrateMode {
  $ctx = Get-Context
  if (-not $ctx.Ok) { Write-Bad $ctx.Error; return 1 }
  $ctxs = @()
  foreach ($name in $ctx.Targets) { $ctxs += (Get-TargetContext $name) }
  $primaryCtx = $ctxs[0]
  foreach ($c in $ctxs) { if ($c.Name -eq $ctx.Primary) { $primaryCtx = $c; break } }
  $pluginDir = $primaryCtx.PluginDir
  Write-Host 'dsh-memory installer v4 - migrate (old md memory -> topic database)'
  Write-Fact 'DSH_HOME' $DSH_HOME
  Write-Fact '目标 profile' (($ctxs | ForEach-Object { $_.Name }) -join ', ')
  Write-Fact '记忆库' $ctx.MemRoot
  Write-Fact '迁移器' (Join-Path $pluginDir 'memtopic\src\migrate.mjs')

  $migrateJs = Get-MigrateScriptPath $pluginDir
  if (-not $migrateJs) {
    Write-Rule
    Write-Bad '迁移器未就绪：<插件目录>/memtopic/src/migrate.mjs 不存在。'
    Write-Item '原因：插件是旧版（v3.x 只有 index.js），本版 payload 才带 memtopic 运行时。'
    Write-Head '下一步'
    Write-Item '① 先重跑安装器（不带参数）把插件升级到 v4（会带上 migrate.mjs）'
    Write-Item '② 再执行：重跑安装器加 -Migrate --yes'
    Write-Item '③ 或会话内输入 /memory-migrate 查看迁移报告'
    return 3
  }
  if (-not (Resolve-NodeRunner)) {
    foreach ($h in @(Get-NodeMissingHint)) { Write-Bad $h }
    return 3
  }

  # 解析动作：--yes / --apply -> apply；--rollback -> rollback；否则 detect
  $doApply = $false; $doRollback = $false; $assume = [bool]$AssumeHostStopped; $mergeFlag = [bool]$Merge
  if ($Apply) { $doApply = $true }
  if ($Rollback) { $doRollback = $true }
  foreach ($a in @($Rest)) {
    $s = ([string]$a).ToLowerInvariant()
    if ($s -eq '--yes' -or $s -eq '-y' -or $s -eq '--apply') { $doApply = $true }
    if ($s -eq '--rollback') { $doRollback = $true }
    if ($s -eq '--merge') { $mergeFlag = $true }
    if ($s -eq '--assume-host-stopped') { $assume = $true }
    if ($s -eq '--detect') { $doApply = $false; $doRollback = $false }
  }

  $common = @(Get-MigrateCommonArgs $ctx.MemRoot $DSH_HOME)
  $baseArgs = @($migrateJs) + $common

  # ---- detect first (read-only; the installer renders the human summary) ----
  Write-Head '检测（只读）'
  $detect = Invoke-MigrateDetect $migrateJs $ctx.MemRoot $DSH_HOME
  if (-not $detect.Ok) {
    Write-Warn2 ('migrate --detect 不可用：' + $detect.Error)
    if ($detect.Raw) { Write-Item ('原始输出：' + $detect.Raw.Trim()) }
  }
  if ($detect.Ok -and (Test-DetectSchemaTooNew $detect.Json)) {
    Write-Bad '记忆库 schema_version 高于本插件：拒绝迁移（未改动任何文件）。请先升级插件/安装器；不要手工改 schema_version。'
    return 2
  }

  # ---- rollback ----
  if ($doRollback) {
    Write-Head '回滚（转交 migrate.mjs --rollback）'
    $code = Invoke-MigrateCli $baseArgs @('--rollback', '--json')
    if ($code -eq 0) { Write-Ok '回滚完成（详见 migrate.mjs 输出）' } else { Write-Bad ("回滚失败，退出码 $code") }
    Write-Item ('回滚后如需回到 md 模式：把 ' + (Join-Path $ctx.MemRoot '.config.json') + ' 的 memoryTopicDbEnabled 改为 false，并重启 DSH。')
    return $code
  }

  # ---- 决策表（与 Lead 裁决一致）----
  $needs = $false; $migrated = $false; $empty = $false; $hostRunning = $null
  if ($detect.Ok) {
    $j = $detect.Json
    $needs = ConvertTo-Boolish (Get-PropValue $j 'needsMigration')
    $migrated = ConvertTo-Boolish (Get-PropValue $j 'alreadyMigrated')
    $empty = ConvertTo-Boolish (Get-PropValue $j 'empty')
    $hi = Get-PropValue $j 'host'
    if ($hi) { $hostRunning = ConvertTo-Boolish (Get-PropValue $hi 'running') }
  } else {
    $sv = Get-StaticMigrationVerdict $ctx.MemRoot
    $needs = $sv.NeedsMigration; $migrated = $sv.AlreadyMigrated; $empty = $sv.Empty
    Write-Warn2 'migrate --detect 不可用，改用静态判断（结果可能不完整）。'
  }
  # 宿主运行中且待迁移时，"HOST_RUNNING" 不是致命错误，而是"登记待办"——按安装语义渲染
  $renderAsInstall = ($detect.Ok -and $needs -and (-not $assume) -and ($hostRunning -ne $false))
  if ($detect.Ok) { Format-MigrateDetect $detect.Json -InstallContext:$renderAsInstall }

  # 1) 需要迁移
  if ($needs) {
    if ((-not $assume) -and ($hostRunning -ne $false)) {
      Write-Head '宿主 DSH 正在运行（或无法确认已停止）—— 迁移改为"登记待办"，重启后自动执行'
      $null = Register-PendingMigration $ctx.MemRoot $pluginDir '安装器 -Migrate：检测到 DSH 正在运行，登记为下次启动自动迁移'
      return 0
    }
    if (-not $doApply) {
      Write-Head '只读检测完成（未做任何改动）'
      Write-Item '要执行迁移：重跑本命令并加 --yes（等价 -Apply）'
      Write-Host ('     ' + (Get-ReinstallCommand)) -ForegroundColor White
      Write-Item '要回滚：加 -Rollback'
      return 0
    }
    Write-Head '执行迁移（migrate.mjs --apply --yes）'
    $applyArgs = @('--apply', '--yes')
    if ($mergeFlag) { $applyArgs += '--merge' }
    if ($assume) { $applyArgs += '--assume-host-stopped' }
    $code = Invoke-MigrateCli $baseArgs $applyArgs
    if ($code -eq 0) {
      Write-Ok '迁移完成：旧 md 已导入主题库（原文未删除、未改写，可回滚）。'
      if (Remove-PendingMarker $ctx.MemRoot) { Write-Item '已清除 pending 迁移标记（本次已在终端直接迁移）' }
      Ensure-TopicDbFlag $ctx.MemRoot
      Write-Head '下一步'
      Write-Item '① 重启 DSH：重启后主题库成为真源（md 变导出视图 / 人工稳定层）。'
      Write-Item '② 检查：重跑安装器加 -CheckOnly，应看到"已迁移"。'
      Write-Item '③ 回滚（万一）：重跑安装器加 -Migrate -Rollback'
      return 0
    }
    if ($code -eq 2) { Show-MigrateRefusal $detect; return 2 }
    if ($code -eq 1) { Write-Bad '迁移参数/确认问题（exit 1）：见上方 migrate.mjs 输出与"下一步"。'; return 1 }
    if ($code -eq 3) { Write-Bad '迁移阶段失败（exit 3）：旧 md 未被修改；修好后可重跑 --apply 续跑（见上方报告）。'; return 3 }
    if ($code -eq 4) { Write-Bad '回滚失败（exit 4）：见上方报告。'; return 4 }
    Write-Bad ("迁移失败，退出码 $code"); return $code
  }

  # 2) 已迁移
  if ($migrated) {
    Write-Head '已就绪'
    Write-Item '主题库已有数据，无需重复迁移（如要把新写的 md 合并进来：-Migrate --yes -Merge）。'
    if (Remove-PendingMarker $ctx.MemRoot) { Write-Item '已清除过期的 pending 迁移标记（库已就绪，无需再迁）' }
    Ensure-TopicDbFlag $ctx.MemRoot
    return 0
  }

  # 3) 全新用户
  if ($empty) {
    Write-Head '新装完成'
    Write-Ok '没有旧 md 记忆库、主题库为空：无需迁移。'
    Ensure-TopicDbFlag $ctx.MemRoot
    Write-Item '重启 DSH 后主题库生效（首次会话可做一次记忆初始化，约 1 分钟）。'
    return 0
  }

  # 4) 其它
  Write-Ok '无需迁移（没有可导入的 md，也没有已有主题库数据）。'
  return 0
}

# exit 2 时原样转述 migrate.mjs 的判定依据，并给两条出路（安装器不删锁）
function Show-MigrateRefusal($Detect) {
  Write-Head '迁移被拒绝（exit 2）—— 转述 migrate.mjs 的判定依据'
  if (-not ($Detect -and $Detect.Ok)) { return }
  $hostInfo = Get-PropValue $Detect.Json 'host'
  $lockPaths = @()
  if ($hostInfo) {
    Write-Fact '宿主状态' ([string](Get-PropValue $hostInfo 'status'))
    foreach ($e in @(Get-PropValue $hostInfo 'evidence')) {
      $kind = [string](Get-PropValue $e 'kind')
      $path = [string](Get-PropValue $e 'path')
      $detail = [string](Get-PropValue $e 'detail')
      if ($path) { Write-Item ("依据 [$kind] " + $path) } elseif ($detail) { Write-Item ("依据 [$kind] " + $detail) }
      if ($kind -eq 'lock-file' -and $path) { $lockPaths += $path }
    }
  }
  foreach ($b in @(Get-PropValue $Detect.Json 'blockers')) {
    if ([string](Get-PropValue $b 'code') -eq 'DB_NOT_EMPTY') {
      Write-Item '库已有数据：确认要合并旧 md 后，追加 -Merge 重试（安装器：-Migrate --yes -Merge）'
    }
  }
  Write-Head '两条出路（二选一）'
  Write-Item '① 确认 DSH 已完全退出（含托盘/后台进程）后，加 --assume-host-stopped 重试：'
  $cmd = Get-ReinstallCommand
  if ($cmd -match '-Migrate --yes') { $cmd = $cmd.Replace('-Migrate --yes', '-Migrate --yes -AssumeHostStopped') }
  Write-Host ('     ' + $cmd) -ForegroundColor White
  if ($lockPaths.Count -gt 0) {
    Write-Item '② 或检查/删除残留锁文件（删前确认 DSH 确实没在跑；安装器不会自己删）：'
    foreach ($lp in $lockPaths) { Write-Host ('     ' + $lp) -ForegroundColor White }
  } else {
    Write-Item '② 或检查 DSH_HOME 下的锁/pid 文件；没有残留锁时则确认进程真的退出后重试。'
  }
}

# 运行 migrate.mjs 并原样转述输出（含 stderr 的"下一步："）；返回退出码
function Invoke-MigrateCli([string[]]$BaseArgs, [string[]]$ExtraArgs) {
  $runner = Resolve-NodeRunner
  if (-not $runner) {
    foreach ($h in @(Get-NodeMissingHint)) { Write-Bad $h }
    return 3
  }
  $all = @()
  $all += $BaseArgs
  $all += $ExtraArgs
  try {
    $run = Invoke-NodeProcess $runner $all -Stream
    return [int]$run.ExitCode
  } catch {
    Write-Bad ('调用 migrate.mjs 失败：' + $_.Exception.Message)
    return 3
  }
}

# ===========================================================================
# MODE: -Uninstall
# ===========================================================================
function Remove-MemoryPatchBlock([string]$PatchPath) {
  $r = @{ Action = 'skip'; Detail = ''; Backup = '' }
  if (-not (Test-Path -LiteralPath $PatchPath -PathType Leaf)) { $r.Action = 'absent'; return $r }
  $raw = Read-TextFile $PatchPath
  if ($null -eq $raw) { $r.Action = 'unreadable'; return $r }
  if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
  $nl = "`n"
  if ($raw -match "`r`n") { $nl = "`r`n" }
  $lines = @($raw -split "`r?`n")
  if ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines = @($lines[0..($lines.Count - 2)]) }

  $idIdx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^[ \t]*-[ \t]*id:[ \t]*dsh-memory[ \t]*($|#)') { $idIdx = $i; break }
  }
  if ($idIdx -lt 0) { $r.Action = 'absent'; return $r }

  # block start: walk back to the column-0 entry that introduces this id
  $start = $idIdx
  for ($i = $idIdx - 1; $i -ge 0; $i--) {
    $start = $i
    if ($lines[$i] -match '^-(\s|$)') { break }
  }
  # include an immediately preceding comment line that mentions dsh-memory
  while ($start -gt 0 -and $lines[$start - 1] -match '^#.*dsh-memory') { $start-- }
  # block end: first column-0 entry after the id line
  $end = $lines.Count - 1
  for ($i = $idIdx + 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^-(\s|$)') { $end = $i - 1; break }
  }
  while ($end -gt $idIdx -and $lines[$end] -match '^\s*$') { $end-- }

  $new = @()
  if ($start -gt 0) { $new += $lines[0..($start - 1)] }
  if (($end + 1) -lt $lines.Count) { $new += $lines[($end + 1)..($lines.Count - 1)] }

  # shape validation of the remainder
  $code = @()
  foreach ($line in $new) { if (-not ($line -match '^\s*$' -or $line -match '^\s*#')) { $code += $line } }
  $bad = @($code | Where-Object { -not (($_ -match '^-(\s|$)') -or ($_ -match '^[ \t]+\S')) -and ($_ -notmatch '^\[[ \t]*\]$') })
  if ($bad.Count -gt 0) {
    $r.Action = 'manual'
    $r.Detail = '删除后不再是干净的顶层块序列，未修改（请手工删除 dsh-memory 条目）'
    return $r
  }
  if ($code.Count -eq 0) {
    $new = @(Get-PatchHeader) + @('') + @('[]')
  }
  $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
  $bak = $PatchPath + '.bak-' + $stamp
  Copy-Item -LiteralPath $PatchPath -Destination $bak -Force
  Write-TextNoBom $PatchPath (($new -join $nl) + $nl)
  $r.Action = 'removed'
  $r.Backup = $bak
  return $r
}

function Invoke-UninstallMode {
  $ctx = Get-Context
  if (-not $ctx.Ok) { Write-Bad $ctx.Error; return 1 }
  $ctxs = @()
  foreach ($name in $ctx.Targets) { $ctxs += (Get-TargetContext $name) }
  $primaryCtx = $ctxs[0]
  foreach ($c in $ctxs) { if ($c.Name -eq $ctx.Primary) { $primaryCtx = $c; break } }
  Write-Host 'dsh-memory installer v4 - uninstall'
  Write-Fact 'DSH_HOME' $DSH_HOME
  Write-Fact 'profile 来源' (Format-ProfileMode $ctx.Mode)
  Write-Fact '目标 profile' (($ctxs | ForEach-Object { $_.Name }) -join ', ')
  Write-Rule
  Write-Warn2 '本操作只注销插件，不会删除 ~/.dsh/memory 下的记忆数据。'
  $pm = Get-PendingMarker $ctx.MemRoot
  if ($pm.Exists) { Write-Item ('保留 pending 迁移标记（不删）：' + $pm.Path + '（重启后仍会按登记处理）') }

  # 1. unregister patch layer (per target profile)
  $fail = $false
  foreach ($c in $ctxs) {
    $rem = Remove-MemoryPatchBlock $c.PatchFile
    switch ($rem.Action) {
      'absent' { Write-Item ('[' + $c.Name + '] patch 层没有 dsh-memory 注册行（跳过）') }
      'removed' { Write-Ok ('[' + $c.Name + '] 已从 patch 层移除 dsh-memory 注册（备份：' + $rem.Backup + '）') }
      'manual' { Write-Warn2 ('[' + $c.Name + '] 未能自动移除：' + $rem.Detail); $fail = $true }
      default { Write-Warn2 ('[' + $c.Name + '] patch 层未处理（' + $rem.Action + '）') }
    }
  }
  Write-Item '注意：dsh-memory-client（设置界面）的注册行未动；如需一并移除请手工编辑 patch 层。'

  # 2. remove junction (if it is a link)
  $nmTarget = Join-Path (Join-Path $DSH_HOME 'profiles') 'node_modules'
  $nmLink = Join-Path $nmTarget 'dsh-memory'
  if (Test-Path -LiteralPath $nmLink) {
    $info = Get-Item -LiteralPath $nmLink -Force
    $isLink = ($info.LinkType -eq 'Junction' -or $info.LinkType -eq 'SymbolicLink')
    if ($isLink) {
      try { Remove-Item -LiteralPath $nmLink -Recurse -Force; Write-Ok '已删除 profiles/node_modules/dsh-memory junction' }
      catch { Write-Warn2 ('junction 删除失败：' + $_.Exception.Message) }
    } else { Write-Warn2 'profiles/node_modules/dsh-memory 不是链接，保留不动' }
  }

  # 3. move each plugin dir aside (never delete user copies)
  $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
  foreach ($c in $ctxs) {
    if (Test-Path -LiteralPath $c.PluginDir -PathType Container) {
      $dest = Join-Path $c.PluginsRoot ('_uninstalled-memory-' + $stamp)
      try {
        Move-Item -LiteralPath $c.PluginDir -Destination $dest -Force
        Write-Ok ('[' + $c.Name + '] 插件目录已移到：' + $dest + '（确认无用后可手工删除）')
      } catch {
        Write-Bad ('[' + $c.Name + '] 移动插件目录失败：' + $_.Exception.Message + '（如果 DSH 正在运行，请先退出再卸载）')
        $fail = $true
      }
    } else { Write-Item ('[' + $c.Name + '] 插件目录不存在（已卸载或从未安装）') }
  }

  Write-Head '下一步'
  Write-Item '重启 DSH 后插件不再加载。'
  Write-Item '记忆数据仍在 ~/.dsh/memory/（含主题库 mem.db 与 md 导出/人工稳定层）；如需彻底清理请自行备份后删除。'
  if ($fail) { return 1 }
  return 0
}

# ===========================================================================
# Dispatch
# ===========================================================================
$exitCode = 0
try {
  if ($Uninstall) { $exitCode = Invoke-UninstallMode }
  elseif ($Migrate) { $exitCode = Invoke-MigrateMode }
  elseif ($CheckOnly) { $exitCode = Invoke-CheckMode }
  else { $exitCode = Invoke-InstallMode }
} catch {
  Write-Bad ('安装器异常终止：' + $_.Exception.Message)
  Write-Item ('位置：' + $_.InvocationInfo.PositionMessage)
  $exitCode = 1
}
if ($null -eq $exitCode) { $exitCode = 0 }
exit $exitCode
