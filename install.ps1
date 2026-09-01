# dsh-memory installer for Windows (Windows PowerShell 5.1 and PowerShell 7+)
#
# One-line install:
#   irm https://raw.githubusercontent.com/Starry0214/dsh-memory/main/install.ps1 | iex
#
# Options (env vars, or the params below):
#   DSH_HOME          - DSH home dir (default: %USERPROFILE%/.dsh)
#   DSH_PROFILE       - profile name (default: web)
#   DSH_MEMORY_RAW    - raw file base URL (default: GitHub raw)
#   DSH_MEMORY_LOCAL  - path to a local index.js to install instead of downloading
#
# -CheckOnly: report installed/published version, patch-layer shape and memory-library
#            status without downloading or writing anything.
#
# First run: DSH checks the memory library; if empty, walks the user through the
# initialization inside the first session (also /memory-init, /memory-update).
#
# v2 (2026-08-28): cordis.patch.yml registration rewritten - the merge logic lives in
# the PATCH-MERGE region below and is covered by test/patch-merge.tests.ps1.
#
[CmdletBinding()]
param(
  [string]$ProfileName = ""
  ,[switch]$SkipPrompt
  # -CheckOnly: 只体检不改动（已装版本 / 远端版本 / 补丁层 / 记忆库状态）
  ,[switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

$RAW_BASE = if ($env:DSH_MEMORY_RAW) { $env:DSH_MEMORY_RAW.TrimEnd('/') } else { 'https://raw.githubusercontent.com/Starry0214/dsh-memory/main' }
$DSH_HOME = if ($env:DSH_HOME) { $env:DSH_HOME } elseif ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.dsh' } else { Join-Path $HOME '.dsh' }
$PROFILE_NAME = if ($ProfileName) { $ProfileName } elseif ($env:DSH_PROFILE) { $env:DSH_PROFILE } else { 'web' }

Write-Host 'dsh-memory installer'
Write-Host ('  DSH_HOME : ' + $DSH_HOME)
Write-Host ('  profile  : ' + $PROFILE_NAME)
Write-Host ""
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
# 1. Validate DSH home
if (-not (Test-Path (Join-Path $DSH_HOME 'profiles'))) {
  Write-Host ('ERROR: no profiles directory found under ' + $DSH_HOME) -ForegroundColor Red
  Write-Host "Make sure DSH is installed and DSH_HOME points to the right place." -ForegroundColor Yellow
  exit 1
}

# 2. Validate profile
# Nested 2-arg form: Windows PowerShell 5.1 has no 3-argument Join-Path.
$profileDir = Join-Path (Join-Path $DSH_HOME 'profiles') $PROFILE_NAME
if (-not (Test-Path $profileDir)) {
  $available = @(Get-ChildItem (Join-Path $DSH_HOME 'profiles') -Directory | Select-Object -ExpandProperty Name) -join ', '
  Write-Host ("ERROR: profile '$PROFILE_NAME' not found. Available: $available") -ForegroundColor Red
  Write-Host "Set DSH_PROFILE (or pass -ProfileName) to one of them and retry." -ForegroundColor Yellow
  exit 1
}
# --- version helper functions (defined before the -CheckOnly gate uses them) ---
function Download-File($url, $dest) {
  try {
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 60
    return $true
  }
  catch {
    return $false
  }
}

# Read the PLUGIN_VERSION constant out of an installed index.js ("" when absent).
function Get-InstalledVersion($file) {
  if (-not (Test-Path -LiteralPath $file)) { return "" }
  $raw = Get-Content -LiteralPath $file -Raw -Encoding UTF8
  if ($raw -match 'const PLUGIN_VERSION\s*=\s*"([^"]+)"') { return $matches[1] }
  return ""
}

# Fetch <base>/version.txt; "" on failure (offline, mirror without the file).
function Get-RemoteVersion($base) {
  $tmp = Join-Path $env:TEMP ("dsh-memory-version-" + (Get-Random -Maximum 99999) + ".txt")
  try {
    if (Download-File ($base + '/version.txt') $tmp) {
      $v = (Get-Content -LiteralPath $tmp -Raw -Encoding UTF8).Trim()
      if ($v -match '([0-9]+\.[0-9]+(?:\.[0-9]+)?)') { return $matches[1] }
    }
    return ""
  }
  finally {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
  }
}

# 3.0 -CheckOnly: 只体检不改动（已装版本 / 远端版本 / 补丁层 / 记忆库状态）
# [2026-09-01 修复] CheckOnly 必须在「下载/建目录」之前执行——旧版先下载覆盖 index.js 再体检，
#   会把本地已修复/裁剪的 index.js 覆盖成远端版（实测 2026-09-01 覆盖掉 settle 修复）。
if ($CheckOnly) {
  $ckPluginDir = Join-Path (Join-Path $profileDir 'plugins') 'memory'
  $ckTarget = Join-Path $ckPluginDir 'index.js'
  $cur = Get-InstalledVersion $ckTarget
  $remote = Get-RemoteVersion $RAW_BASE
  Write-Host '--- check only (nothing was downloaded or written) ---' -ForegroundColor Cyan
  Write-Host ("  plugin file : " + $(if (Test-Path -LiteralPath $ckTarget) { $ckTarget } else { "not installed yet" }))
  Write-Host ("  installed   : " + $(if ($cur) { "v" + $cur } else { "-" }))
  Write-Host ("  published   : " + $(if ($remote) { "v" + $remote } else { "unknown (offline or mirror lacks version.txt)" }))
  if ($cur -and $remote) {
    if ($cur -eq $remote) { Write-Host "  => the installed plugin is up to date." -ForegroundColor Green }
    else { Write-Host ("  => upgrade available: re-run this installer (v" + $cur + " -> v" + $remote + "), then restart DSH.") -ForegroundColor Yellow }
  }
  $ckPatch = Join-Path $profileDir 'cordis.patch.yml'
  if (Test-Path -LiteralPath $ckPatch) {
    $ckRaw = Get-Content -LiteralPath $ckPatch -Raw -Encoding UTF8
    $ckReg = ($ckRaw -match "(?m)^[ \t]*-[ \t]*id:[ \t]*dsh-memory[ \t]*(#|$)")
    $ckLines = @($ckRaw -split '\r?\n')
    $ckStray = @($ckLines | Where-Object { $_ -match '^\[[ \t]*\]$' }).Count
    $ckTop = @($ckLines | Where-Object { $_ -match '^-(\s|$)' }).Count
    Write-Host ("  patch layer : " + $ckPatch)
    Write-Host ("    registered : " + $(if ($ckReg) { "yes" } else { "no" }))
    if ($ckStray -gt 0 -and $ckTop -gt 0) {
      Write-Host ("    shape      : BROKEN - " + $ckStray + " stray [] line(s) beside " + $ckTop + " top-level entries; re-run the installer or fix-cordis-patch.ps1") -ForegroundColor Red
    }
    elseif ($ckStray -gt 0) { Write-Host "    shape      : empty patch layer (just []), nothing registered yet" }
    else { Write-Host ("    shape      : ok (" + $ckTop + " top-level entries)") }
  }
  else { Write-Host "  patch layer : not created yet" }
  $memRoot = Join-Path $DSH_HOME 'memory'
  $g = Join-Path $memRoot 'global.md'
  $i2 = Join-Path $memRoot 'index.md'
  $bg = 0; $bi = 0
  if (Test-Path -LiteralPath $g) { $bg = (Get-Item -LiteralPath $g).Length }
  if (Test-Path -LiteralPath $i2) { $bi = (Get-Item -LiteralPath $i2).Length }
  $agentsFile = Join-Path $DSH_HOME 'AGENTS.md'
  $st = 'ready'
  if (($bg + $bi) -lt 120) { $st = "uninitialized (the first DSH session will walk you through it, about 1 minute)" }
  elseif (-not (Test-Path -LiteralPath $agentsFile)) { $st = "partial (missing AGENTS.md read/write protocol)" }
  Write-Host ("  memory lib  : " + $memRoot + " -> " + $st)
  exit 0
}

# 3. Create plugin dir and download index.js
$pluginDir = Join-Path (Join-Path $profileDir 'plugins') 'memory'
New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
$target = Join-Path $pluginDir 'index.js'

# 3.3 Fetch the plugin file (local copy when DSH_MEMORY_LOCAL is set; network otherwise)
if ($env:DSH_MEMORY_LOCAL) {
  if (-not (Test-Path -LiteralPath $env:DSH_MEMORY_LOCAL -PathType Leaf)) {
    Write-Host ("ERROR: DSH_MEMORY_LOCAL is set but is not a readable file: " + $env:DSH_MEMORY_LOCAL) -ForegroundColor Red
    exit 1
  }
  Write-Host ("Copying index.js from " + $env:DSH_MEMORY_LOCAL + " ...")
  Copy-Item -LiteralPath $env:DSH_MEMORY_LOCAL -Destination $target -Force
}
else {
  Write-Host "Downloading index.js ..."
  if (-not (Download-File ($RAW_BASE + "/index.js") $target)) {
    Write-Host "GitHub raw failed, trying jsDelivr CDN ..." -ForegroundColor Yellow
    if (-not (Download-File "https://cdn.jsdelivr.net/gh/Starry0214/dsh-memory@main/index.js" $target)) {
      Write-Host "ERROR: failed to download index.js. Check your network / proxy, or pre-copy the file and set DSH_MEMORY_LOCAL to it." -ForegroundColor Red
      exit 1
    }
  }
}
Write-Host ("  OK: " + $target) -ForegroundColor Green
# 3.5 Seed the memory library (first-run prep; never overwrites user files):
#     skeleton dirs + the read/write protocol AGENTS.md + empty global/index placeholders.
$memRoot = Join-Path $DSH_HOME 'memory'
foreach ($sub in @('', 'sessions', 'projects', 'tools', 'knowledge')) {
  $dir = Join-Path $memRoot $sub
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
}
$AGENTS_TEMPLATE = @'
# 全局自动记忆协议（AGENTS.md — 每次会话自动注入）

> 本文件由 DSH 机制在每次会话开始时自动注入到模型上下文，是「全局自动记忆」的协议引擎。
> 记忆库位于 `~/.dsh/memory/`，所有会话、所有项目共享。
> **自动注入已由 dsh-memory 插件接管**（会话开始时插件注入 global.md+index.md+最近摘要），本协议负责读写纪律。
> 安装 dsh-memory 时若本文件不存在，安装脚本会从仓库 AGENTS.template.md 复制一份；已存在则不覆盖（本文件归你所有）。

## 记忆库结构

```
~/.dsh/memory/
├── global.md        # 全局记忆：用户画像、通用偏好、跨项目经验（稳定层）
├── index.md         # 记忆索引：主题 → 知识文件路径（稳定层）
├── projects/        # 项目层：每个项目一个文件（半稳定层）
│   └── <项目名>.md
├── sessions/        # 会话摘要层：每轮会话一个文件（动态层）
│   └── YYYY-MM-DD.md
├── tools/           # 自研工具/脚本登记（半稳定层）
│   └── <工具名>.md
└── knowledge/       # 主题知识文件（MEMORY-*.md 等，按需检索，不常驻上下文）
    └── MEMORY-<主题>.md
```

## 缓存纪律（前缀缓存：命中与未命中差价约 10 倍）

**前缀结构**：`[系统提示+工具定义] → [注入的稳定记忆] → [注入的最近摘要] → [用户消息...]`
- **系统提示**：插件不碰；动态工具 schema 固定。
- **稳定层（global.md / index.md）**：注入时自动剥离时间戳行；**文件内容只在实质变化时更新**（新增/修改/删除知识点），禁止为了记录而更新时间戳——任何字节变化都会使该文件及其后的前缀缓存全部失效。
- **半稳定层（projects/ tools/ knowledge/）**：按需更新，不在会话开始注入，不影响前缀。
- **动态层（sessions/）**：每会话更新，放稳定层之后注入，失效范围最小。
- **AGENTS.md 本文件**：是前缀的一部分，**定稿后不再修改**（除非记忆机制本身要调整，改一次=全部缓存失效一次）。

## 协议规则（每个会话必须执行）

### 1. 会话开始（读）
- 插件已自动注入 global.md + index.md + 最近摘要；在此基础上：
- 若当前工作目录属于某个已登记项目，用 read/memory_search 读对应的 `projects/<项目名>.md`。
- 需要细节（某主题的踩坑、接口字段）时用 memory_search 按索引路径读取，不全文常驻。
- **先查记忆再动手**：a) 已知领域关键词命中 → 首条命令前先 memory_search；b) 同一错误第 2 次出现 → 立即查；c) 连败 3 次找不到根因 → 强制查 + 查 skill 目录。

### 2. 会话进行中（写）
- 出现以下内容时**立即**写入记忆：
  - **精确字面量**（文号、合同号、路径、API 字段、命令、配置值）——**逐字保存，绝不改写或概括**。
  - 关键决策（做了什么决定、为什么）。
  - 踩坑经验（遇到了什么问题、怎么解决的）。
  - 用户偏好/口径（用户明确表达的工作习惯）。
- 写入目标分层：
  - 跨项目通用 → global.md（实质更新才改）
  - 项目相关 → projects/<项目名>.md
  - 工具相关 → tools/<工具名>.md
  - 主题知识 → knowledge/MEMORY-<主题>.md（并在 index.md 登记一行）
  - 本会话流转 → sessions/今日.md
- 更新记忆用 edit 工具精确修改对应文件，保留文件头部和结构；**不更新时间戳行**。
- 写入被沙箱拒时，带 sandbox_permissions + justification 重试一次（记忆库是正常写入目标，用户会看到审批）。

### 3. 会话结束（归档）
- 在 `sessions/` 新建/更新当日摘要，四段式：
  - 本次会话目标 → 完成情况
  - 关键决策（可提升到项目层）
  - 踩坑经验（可提升到 global 层）
  - 遗留事项 + 下一步行动（最重要的衔接点）
- 摘要控制在 200-400 字，条目化。

### 4. 定期整理（对标 dream / 自校准）
- 每完成一个里程碑（或用户要求时）：
  - 把 sessions/ 中重复出现、跨会话成立的知识**提升**到 projects/ 或 global.md。
  - 清理过时条目（标注已失效或删除）。
  - 项目结项时把项目文件移到 archive/（如需要）。
- dsh-memory 提供 `/dream`（手动整合）、`/memory-init`（记忆库体检+初始化）、`/memory-update`（查新版），以及设置 → 通用设置 → 记忆 的开关项。

'@

$agentsTarget = Join-Path $DSH_HOME 'AGENTS.md'
if (-not (Test-Path -LiteralPath $agentsTarget)) {
  Set-Content -LiteralPath $agentsTarget -Value $AGENTS_TEMPLATE -Encoding UTF8 -NoNewline
  Write-Host ("Wrote the memory protocol to " + $agentsTarget + " (from the embedded template).") -ForegroundColor Green
}
else {
  Write-Host ("Kept your existing " + $agentsTarget + " (the installer never overwrites it).") -ForegroundColor DarkGray
}
foreach ($f in @('global.md', 'index.md')) {
  $fp = Join-Path $memRoot $f
  if (-not (Test-Path -LiteralPath $fp)) {
    $head = "# 全局记忆"
    if ($f -eq "index.md") { $head = "# 记忆索引" }
    Set-Content -LiteralPath $fp -Value $head -Encoding UTF8 -NoNewline
    Write-Host ("Created empty " + $fp + " (your first session will fill it in).") -ForegroundColor DarkGray
  }
}

# 4. Register the plugin in cordis.patch.yml (shape-aware, idempotent)
$patchFile = Join-Path $profileDir 'cordis.patch.yml'
# [2026-09-01 标准对齐] name 用包名 dsh-memory（非路径）——官方显示名标准：
#   包名 → 插件清单显示 "memory"（moduleShortName 剥 dsh- 前缀）；路径 → 显示 file:// 长路径。
#   依赖解析：ESM 按入口真实路径向上找 node_modules，勿把源码镜像到 ~/.dsh/plugins/<pkg>（会 ERR_MODULE_NOT_FOUND），
#   junction profiles/node_modules/dsh-memory 应直指 profiles/<profile>/plugins/memory。
#   config 给默认值（与插件默认一致）；skip 判定只看 id 行，与旧版路径 name 的注册兼容。

# 4.0 包名加载前置：建 profiles/node_modules/dsh-memory junction → <profile>/plugins/memory。
#     包名 registration（name: dsh-memory）要求该名可被 ESM 解析；junction 指向带依赖链的真实源码目录。
#     默认块用包名（官方显示名标准）；junction 建不了时降级为路径块（保证可用性优先）。
$MEMORY_BLOCK = @(
  '# --- dsh-memory: global auto-memory plugin (installed by the dsh-memory installer) ---',
  '- insert:',
  '    - id: dsh-memory',
  '      name: dsh-memory',
  '      config:',
  '        staleSessionDays: 5',
  '        staleAction: remind'
)
$nmTarget = Join-Path (Join-Path $DSH_HOME 'profiles') 'node_modules'
if (Test-Path -LiteralPath $nmTarget) {
  $nmLink = Join-Path $nmTarget 'dsh-memory'
  if (Test-Path -LiteralPath $nmLink) {
    $linkInfo = Get-Item -LiteralPath $nmLink -Force
    if ($linkInfo.LinkType -eq 'Junction' -and $linkInfo.Target -eq $pluginDir) {
      Write-Host "  dsh-memory junction already points at $pluginDir (skipped)." -ForegroundColor DarkGray
    }
    else {
      Remove-Item -LiteralPath $nmLink -Recurse -Force
      New-Item -ItemType Junction -Path $nmLink -Target $pluginDir | Out-Null
      Write-Host ("  re-pointed dsh-memory junction -> " + $pluginDir) -ForegroundColor Green
    }
  }
  else {
    New-Item -ItemType Junction -Path $nmLink -Target $pluginDir | Out-Null
    Write-Host ("  created dsh-memory junction -> " + $pluginDir) -ForegroundColor Green
  }
}
else {
  Write-Host ("WARNING: " + $nmTarget + " not found - package-name registration will fail to resolve dsh-memory; install will register the path form instead.") -ForegroundColor Red
  $MEMORY_BLOCK = @(
    '# --- dsh-memory: global auto-memory plugin (installed by the dsh-memory installer) ---',
    '- insert:',
    '    - id: dsh-memory',
    '      name: ./plugins/memory/index.js',
    '      config:',
    '        staleSessionDays: 5',
    '        staleAction: remind'
  )
}

$merge = Merge-PatchFile -Path $patchFile -Block $MEMORY_BLOCK -IdName 'dsh-memory'

switch ($merge.Action) {
  'created' {
    $null = Write-PatchFile -Path $patchFile -Text $merge.Text
    Write-Host ("Created " + $patchFile + " and registered dsh-memory.") -ForegroundColor Green
  }
  'registered' {
    $bak = Write-PatchFile -Path $patchFile -Text $merge.Text
    Write-Host ("Registered dsh-memory in " + $patchFile + " (" + $merge.Detail + ").") -ForegroundColor Green
    if ($bak) { Write-Host ("  backup: " + $bak) -ForegroundColor DarkGray }
  }
  'repaired' {
    $bak = Write-PatchFile -Path $patchFile -Text $merge.Text
    Write-Host ("Repaired " + $patchFile + " (" + $merge.Detail + ").") -ForegroundColor Green
    if ($bak) { Write-Host ("  backup: " + $bak) -ForegroundColor DarkGray }
  }
  'skip' {
    Write-Host ("dsh-memory already registered in " + $patchFile + " (skipped).") -ForegroundColor Green
  }
  default {
    $snippet = $patchFile + ".dsh-memory-block.txt"
    Set-Content -LiteralPath $snippet -Value (($MEMORY_BLOCK -join "`r`n") + "`r`n") -Encoding UTF8 -NoNewline
    Write-Host ("WARNING: dsh-memory was NOT registered - " + $merge.Detail) -ForegroundColor Red
    Write-Host "  The plugin file is installed; merge the registration yourself:" -ForegroundColor Yellow
    Write-Host ("  1. open  " + $patchFile) -ForegroundColor Yellow
    Write-Host "  2. make sure the file is ONE top-level YAML array, then paste the entries" -ForegroundColor Yellow
    Write-Host ("     from  " + $snippet) -ForegroundColor Yellow
    Write-Host "     as further - insert: items at column 0." -ForegroundColor Yellow
    Write-Host "  3. start DSH: once it boots, delete the .txt file." -ForegroundColor Yellow
    exit 1
  }
}

# 5. Verify + report
if (-not (Test-Path $target)) {
  Write-Host "ERROR: index.js missing after install." -ForegroundColor Red
  exit 1
}
$bytes = (Get-Item $target).Length
$installedV = Get-InstalledVersion $target
$remoteV = Get-RemoteVersion $RAW_BASE
Write-Host ""
if ($installedV) {
  Write-Host ("dsh-memory installed successfully (v" + $installedV + ", index.js " + $bytes + " bytes).") -ForegroundColor Green
}
else {
  Write-Host ("dsh-memory installed successfully (index.js " + $bytes + " bytes).") -ForegroundColor Green
}
Write-Host ("  installed : v" + $installedV)
if ($remoteV) {
  if ($remoteV -eq $installedV) { Write-Host ("  published : v" + $remoteV + " (up to date)") }
  else { Write-Host ("  published : v" + $remoteV + " (a newer version is published; re-run the installer to upgrade)") -ForegroundColor Yellow }
}
else { Write-Host "  published : unknown (offline?)" }
Write-Host ""
Write-Host ("Current " + $patchFile + ":") -ForegroundColor Cyan
if (Test-Path -LiteralPath $patchFile) {
  Get-Content -LiteralPath $patchFile -Encoding UTF8 | ForEach-Object { Write-Host ("  " + $_) -ForegroundColor DarkGray }
}
Write-Host ""
Write-Host "Next step: restart DSH. First-run experience:" -ForegroundColor Cyan
Write-Host "  - the plugin checks the memory library; if empty, guides you through initialization"
Write-Host "    inside the first session (about 1 minute; also /memory-init)"
Write-Host "  - /memory-update checks the version; Settings -> General -> Memory shows both"
Write-Host "  - if DSH ever fails to boot with a cordis.patch.yml parse error, run:"
Write-Host "      irm https://raw.githubusercontent.com/Starry0214/dsh-memory/main/fix-cordis-patch.ps1 | iex"
# NOTE: no interactive Read-Host here. Streaming a script with param()+Read-Host
# through "irm ... | iex" breaks in Windows PowerShell 5.1 (positional parameter
# binding). Keep this installer non-interactive. -SkipPrompt is a no-op kept for
# backward compatibility.
