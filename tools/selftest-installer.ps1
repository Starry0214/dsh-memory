# dsh-memory installer v4 self-test (repeatable, isolated)
#
#   pwsh -NoProfile -File tools/selftest-installer.ps1
#   pwsh -NoProfile -File tools/selftest-installer.ps1 -KeepTemp          # 保留临时 DSH_HOME 便于排查
#   pwsh -NoProfile -File tools/selftest-installer.ps1 -HostExe powershell # 用 Windows PowerShell 5.1 跑安装器
#
# 覆盖：
#   A 新用户安装（文件 sha / .config.json / AGENTS v4 / patch / junction）
#   B 二次安装幂等（文件不变、注册行不重复、新增备份目录）
#   C -CheckOnly 11 段齐全
#   D 老用户：4 个 md/8 句 → pending 标记 → -Migrate 登记 → --yes -AssumeHostStopped 迁移 → 4 主题/8 句
#      → 二次迁移幂等 → md 零改动
#   E -Uninstall 注销（patch 行移除、插件目录移走、记忆数据保留）
#
# 全部操作只发生在 $env:TEMP 下的临时 DSH_HOME 里，绝不读写真实 ~/.dsh。
[CmdletBinding()]
param(
  [string]$Installer = '',
  [string]$Payload = '',
  [string]$HostExe = 'pwsh',
  [switch]$KeepTemp
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $Installer) { $Installer = Join-Path $root 'install.ps1' }
$manifestPath = Join-Path $root 'install-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "missing install-manifest.json: $manifestPath" }
$manifest = (Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json)
if (-not $Payload) { $Payload = Join-Path (Join-Path $root 'payload') ([string]$manifest.zip.name) }
if (-not (Test-Path -LiteralPath $Payload -PathType Leaf)) { throw "missing payload: $Payload" }
$hostCmd = (Get-Command $HostExe -ErrorAction SilentlyContinue)
if (-not $hostCmd) { throw "host executable not found: $HostExe" }
$exe = $hostCmd.Source

$script:pass = 0
$script:fail = 0
function Assert-That($Condition, [string]$Name, [string]$Detail) {
  if ($Condition) {
    $script:pass++
    Write-Host ('  PASS  ' + $Name)
  } else {
    $script:fail++
    Write-Host ('  FAIL  ' + $Name + $(if ($Detail) { '   [' + $Detail + ']' } else { '' })) -ForegroundColor Red
  }
}

function New-TempHome([string]$Tag) {
  $h = Join-Path $env:TEMP ('dsh-selftest-' + $Tag + '-' + (Get-Random -Maximum 99999))
  New-Item -ItemType Directory -Force -Path (Join-Path $h 'profiles\web'), (Join-Path $h 'profiles\node_modules') | Out-Null
  return $h
}

function Invoke-Installer([string]$DshHomeDir, [string[]]$ExtraArgs) {
  $env:DSH_HOME = $DshHomeDir
  $all = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Installer) + $ExtraArgs
  $out = (& $exe @all 2>&1 | Out-String)
  return @{ Output = $out; Code = $LASTEXITCODE }
}

function Get-Sha([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Write-Text-Utf8([string]$Path, [string]$Text) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $enc)
}

function Read-Json([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

function Get-JsonProp($Obj, [string]$Name) {
  if ($null -eq $Obj) { return $null }
  $p = $Obj.PSObject.Properties[$Name]
  if ($p) { return $p.Value }
  return $null
}

# [BUG-6] payload 的 client/** 落在 <plugins>/dsh-memory-client/，其余落在 <pluginDir>/
function Get-PayloadAbs([string]$PluginDir, [string]$Rel) {
  $rel = $Rel -replace '/', '\'
  if ($rel -like 'client\*') {
    return (Join-Path (Join-Path (Split-Path -Parent $PluginDir) 'dsh-memory-client') ($rel.Substring('client\'.Length)))
  }
  return (Join-Path $PluginDir $rel)
}

function Get-PatchIdRows([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 0 }
  $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
  if ($null -eq $text) { return 0 }
  $text = $text -replace "`r", ''
  return @([regex]::Matches($text, '(?m)^[ \t]*-[ \t]*id:[ \t]*dsh-memory[ \t]*($|#)')).Count
}

function Get-PatchIdRows2([string]$Path, [string]$IdName) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 0 }
  $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
  if ($null -eq $text) { return 0 }
  $text = $text -replace "`r", ''
  return @([regex]::Matches($text, '(?m)^[ \t]*-[ \t]*id:[ \t]*' + [regex]::Escape($IdName) + '[ \t]*($|#)')).Count
}

function Get-TopicCounts([string]$DbPath) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { return $null }
  $js = 'const r=require("node:sqlite");const d=new r.DatabaseSync(process.argv[1],{readOnly:true});const one=s=>{try{return d.prepare(s).get()}catch(e){return null}};const t=one("select count(*) c from topics");const s=one("select count(*) c from sentences");console.log(JSON.stringify({topics:t?Number(t.c):0,sentences:s?Number(s.c):0}));d.close()'
  try {
    $out = (& $node -e $js $DbPath 2>$null | Out-String)
    if ($out -match '\{') { return ($out.Substring($out.IndexOf('{')) | ConvertFrom-Json) }
  } catch { }
  return $null
}

$homes = @()
Write-Host 'dsh-memory installer self-test'
Write-Host ('  installer : ' + $Installer)
Write-Host ('  payload   : ' + $Payload + ' (' + (Get-Item -LiteralPath $Payload).Length + ' bytes)')
Write-Host ('  host      : ' + $exe)
Write-Host ('  DSH_HOME  : temp dirs only')
Write-Host ''

# ===========================================================================
# A. 新用户安装
# ===========================================================================
Write-Host '[A] fresh install (empty DSH_HOME)'
$homeA = New-TempHome 'a'
$homes += $homeA
$pluginDir = Join-Path $homeA 'profiles\web\plugins\memory'
$memRoot = Join-Path $homeA 'memory'
$r = Invoke-Installer $homeA @('-LocalPayload', $Payload, '-ProfileName', 'web')
Assert-That ($r.Code -eq 0) 'A0 install exit code 0' ("exit=" + $r.Code)
$filesOk = 0; $fileTotal = 0; $badFiles = @()
foreach ($f in @($manifest.files)) {
  $fileTotal++
  $abs = Get-PayloadAbs $pluginDir ([string]$f.path)
  if ((Get-Sha $abs) -eq ([string]$f.sha256).ToLowerInvariant()) { $filesOk++ } else { $badFiles += [string]$f.path }
}
Assert-That ($filesOk -eq $fileTotal) 'A1 all payload files match manifest sha256' ($filesOk.ToString() + '/' + $fileTotal + ' bad=' + ($badFiles -join ','))
$cfgA = Read-Json (Join-Path $memRoot '.config.json')
Assert-That ((Get-JsonProp $cfgA 'memoryTopicDbEnabled') -eq $true) 'A2 .config.json memoryTopicDbEnabled=true'
$agentsA = if (Test-Path -LiteralPath (Join-Path $homeA 'AGENTS.md')) { Get-Content -LiteralPath (Join-Path $homeA 'AGENTS.md') -Raw -Encoding UTF8 } else { '' }
Assert-That ($agentsA -match 'dsh-memory-agents-template: v4') 'A3 AGENTS.md is the v4 template'
$patchA = Join-Path $homeA 'profiles\web\cordis.patch.yml'
Assert-That ((Get-PatchIdRows $patchA) -eq 1) 'A4 cordis.patch.yml has exactly one dsh-memory row' ('rows=' + (Get-PatchIdRows $patchA))
$junction = Join-Path $homeA 'profiles\node_modules\dsh-memory'
$jOk = $false
if (Test-Path -LiteralPath $junction) {
  $ji = Get-Item -LiteralPath $junction -Force
  if ($ji.LinkType -ne '') { $jOk = ([string]$ji.Target).TrimEnd('\', '/') -ieq $pluginDir.TrimEnd('\', '/') }
}
Assert-That $jOk 'A5 profiles/node_modules/dsh-memory junction points at the plugin dir'
$modsA = @(Get-ChildItem -LiteralPath (Join-Path $pluginDir 'memtopic\src') -Filter '*.mjs' -File -ErrorAction SilentlyContinue)
Assert-That ($modsA.Count -ge 12) 'A6 memtopic/src has >=12 runtime modules' ('count=' + $modsA.Count)
Assert-That (Test-Path -LiteralPath (Join-Path $pluginDir 'memtopic\src\migrate.mjs')) 'A7 migrate.mjs installed'
Assert-That (-not (Test-Path -LiteralPath (Join-Path $memRoot '.memtopic\migrate-pending.json'))) 'A8 fresh user: no pending marker'
# [BUG-6] 设置界面半区必须装到 dsh-memory-client 并注册（否则新用户看不到「通用设置 → 记忆」）
$clientDir = Join-Path $homeA 'profiles\web\plugins\dsh-memory-client'
Assert-That (Test-Path -LiteralPath (Join-Path $clientDir 'lib\index.js') -PathType Leaf) 'A11 client 设置界面已装到 dsh-memory-client/lib/index.js'
Assert-That (Test-Path -LiteralPath (Join-Path $clientDir 'package.json') -PathType Leaf) 'A12 client package.json 已装'
Assert-That (-not (Test-Path -LiteralPath (Join-Path $pluginDir 'client'))) 'A13 不再往 memory/client 写死文件'
Assert-That ((Get-PatchIdRows2 $patchA 'dsh-memory-client') -eq 1) 'A14 client 已注册（1 行）' ('rows=' + (Get-PatchIdRows2 $patchA 'dsh-memory-client'))

# ===========================================================================
# B. 二次安装幂等
# ===========================================================================
Write-Host '[B] re-install idempotency'
$hashBefore = @{}
foreach ($f in @($manifest.files)) { $rel = [string]$f.path; $hashBefore[$rel] = (Get-Sha (Get-PayloadAbs $pluginDir $rel)) }
$backupDirsBefore = @(Get-ChildItem -LiteralPath $pluginDir -Directory -Filter '_backup-*' -ErrorAction SilentlyContinue).Count
$r2 = Invoke-Installer $homeA @('-LocalPayload', $Payload, '-ProfileName', 'web')
Assert-That ($r2.Code -eq 0) 'B0 re-install exit code 0' ("exit=" + $r2.Code)
$same = 0
foreach ($f in @($manifest.files)) { $rel = [string]$f.path; if ((Get-Sha (Get-PayloadAbs $pluginDir $rel)) -eq $hashBefore[$rel]) { $same++ } }
Assert-That ($same -eq $fileTotal) 'B1 installed files unchanged after re-install' ($same.ToString() + '/' + $fileTotal)
Assert-That ((Get-PatchIdRows $patchA) -eq 1) 'B2 no duplicate registration row' ('rows=' + (Get-PatchIdRows $patchA))
$backupDirsAfter = @(Get-ChildItem -LiteralPath $pluginDir -Directory -Filter '_backup-*' -ErrorAction SilentlyContinue).Count
Assert-That ($backupDirsAfter -eq ($backupDirsBefore + 1)) 'B3 a new _backup-<ts> dir was created' ('before=' + $backupDirsBefore + ' after=' + $backupDirsAfter)
Assert-That ($r2.Output -match '已注册（跳过|已注册') 'B4 re-install reports "already registered"' $null

# ===========================================================================
# C. -CheckOnly 11 段
# ===========================================================================
Write-Host '[C] -CheckOnly report'
$rc = Invoke-Installer $homeA @('-CheckOnly', '-ProfileName', 'web', '-LocalPayload', $Payload)
Assert-That ($rc.Code -eq 0) 'C0 -CheckOnly exit code 0' ("exit=" + $rc.Code)
$missingSections = @()
for ($i = 1; $i -le 11; $i++) { if ($rc.Output -notmatch ('\[' + $i + '/11\]')) { $missingSections += $i } }
Assert-That ($missingSections.Count -eq 0) 'C1 all 11 report sections present' ('missing=' + ($missingSections -join ','))
Assert-That ($rc.Output -match 'sha256 全部匹配') 'C2 payload completeness verified against manifest'
Assert-That ($rc.Output -match 'v4 协议') 'C3 AGENTS.md v4 detected'
Assert-That ($rc.Output -match '已注册 · ') 'C4 patch registration detected (with form label)'
Assert-That ($rc.Output -match '包名形式') 'C5 registration form recognised as package name (BUG-1)'
Assert-That ($rc.Output -match 'junction 指向插件目录') 'C6 junction health check passed (BUG-2)'
Assert-That ($rc.Output -match 'pending 迁移标记：无') 'C7 pending marker item = none'
Assert-That ($rc.Output -match '全新用户|已迁移|无需迁移') 'C8 migration verdict rendered'

# ===========================================================================
# D. 老用户：4 文件 / 8 句 -> pending -> migrate
# ===========================================================================
Write-Host '[D] legacy user: 4 md files / 8 sentences -> pending marker -> migrate'
$homeB = New-TempHome 'b'
$homes += $homeB
$memB = Join-Path $homeB 'memory'
foreach ($d in @('sessions', 'knowledge', 'projects', 'tools')) { New-Item -ItemType Directory -Force -Path (Join-Path $memB $d) | Out-Null }
$fixtures = @{
  'sessions\2026-10-29.md'      = "# 会话 A`n- 会话要点一`n- 会话要点二"
  'knowledge\MEMORY-测试主题.md' = "# 测试主题`n- 知识要点一`n- 知识要点二"
  'projects\测试项目.md'          = "# 测试项目`n- 项目要点一`n- 项目要点二"
  'tools\测试工具.md'             = "# 测试工具`n- 工具要点一`n- 工具要点二"
}
$mdShaBefore = @{}
foreach ($k in $fixtures.Keys) {
  $p = Join-Path $memB $k
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($p, $fixtures[$k] + "`n", $enc)
  $mdShaBefore[$k] = Get-Sha $p
}
$rd = Invoke-Installer $homeB @('-LocalPayload', $Payload, '-ProfileName', 'web')
Assert-That ($rd.Code -eq 0) 'D0 install over legacy md exit code 0' ("exit=" + $rd.Code)
$pluginB = Join-Path $homeB 'profiles\web\plugins\memory'
Assert-That (Test-Path -LiteralPath (Join-Path $pluginB 'index.js')) 'D0a install still wrote plugin files (migration pending must not abort install)'
Assert-That (Test-Path -LiteralPath (Join-Path $homeB 'AGENTS.md')) 'D0b install still wrote AGENTS.md'
Assert-That (Test-Path -LiteralPath (Join-Path $homeB 'profiles\web\cordis.patch.yml')) 'D0c install still registered the patch layer'
Assert-That ($rd.Output -match '\[8/8\]') 'D0d install completed all 8 steps'
Assert-That ($rd.Output -notmatch '异常终止|Cannot bind argument') 'D0e installer did not crash on legacy+host-running path (BUG-3)'
Assert-That ($rd.Output -match '已登记|迁移暂缓') 'D0f install output explains the pending registration instead of a fatal error'
$pendingPath = Join-Path $memB '.memtopic\migrate-pending.json'
Assert-That (Test-Path -LiteralPath $pendingPath -PathType Leaf) 'D1 pending marker written while DSH is running'
$pending = Read-Json $pendingPath
Assert-That ((Get-JsonProp $pending 'schemaVersion') -eq 1) 'D2 pending.schemaVersion=1'
Assert-That ((Get-JsonProp $pending 'requestedBy') -eq 'installer') 'D3 pending.requestedBy=installer'
Assert-That (([string](Get-JsonProp $pending 'mdRoot')).TrimEnd('\', '/') -ieq $memB.TrimEnd('\', '/')) 'D4 pending.mdRoot is the absolute temp memory root' ([string](Get-JsonProp $pending 'mdRoot'))
Assert-That (([string](Get-JsonProp $pending 'dbFile')).EndsWith('mem.db')) 'D5 pending.dbFile points at mem.db' ([string](Get-JsonProp $pending 'dbFile'))
Assert-That ([string](Get-JsonProp $pending 'pluginVersion') -ne '') 'D6 pending.pluginVersion present' ([string](Get-JsonProp $pending 'pluginVersion'))
$cfgB = Read-Json (Join-Path $memB '.config.json')
Assert-That ($null -eq (Get-JsonProp $cfgB 'memoryTopicDbEnabled')) 'D7 flag NOT turned on while legacy md un-migrated + host running'
$rcB = Invoke-Installer $homeB @('-CheckOnly', '-ProfileName', 'web')
Assert-That ($rcB.Output -match 'pending 迁移标记：存在|等待重启 DSH 消费') 'D8 -CheckOnly reports the registered migration'
Assert-That ($rcB.Output -match '需要迁移') 'D9 -CheckOnly says migration is needed'
$rm = Invoke-Installer $homeB @('-Migrate', '-ProfileName', 'web')
Assert-That ($rm.Code -eq 0) 'D10 -Migrate (detect/register only) exit code 0' ("exit=" + $rm.Code)
Assert-That (Test-Path -LiteralPath $pendingPath -PathType Leaf) 'D11 -Migrate keeps the pending marker (does not apply while host runs)'
$ra = Invoke-Installer $homeB @('-Migrate', '--yes', '-AssumeHostStopped', '-ProfileName', 'web')
Assert-That ($ra.Code -eq 0) 'D12 -Migrate --yes -AssumeHostStopped exit code 0' ("exit=" + $ra.Code)
$dbB = Join-Path $memB '.memtopic\mem.db'
$counts = Get-TopicCounts $dbB
Assert-That ($null -ne $counts) 'D13 topic database readable'
if ($counts) {
  Assert-That (([int]$counts.topics) -eq 4) 'D14 migrated topics = 4' ('topics=' + $counts.topics)
  Assert-That (([int]$counts.sentences) -eq 8) 'D15 migrated sentences = 8' ('sentences=' + $counts.sentences)
}
$cfgB2 = Read-Json (Join-Path $memB '.config.json')
Assert-That ((Get-JsonProp $cfgB2 'memoryTopicDbEnabled') -eq $true) 'D16 flag turned on after successful migration'
Assert-That (-not (Test-Path -LiteralPath $pendingPath)) 'D17 pending marker cleared after successful migration'
$ra2 = Invoke-Installer $homeB @('-Migrate', '--yes', '-AssumeHostStopped', '-ProfileName', 'web')
$counts2 = Get-TopicCounts $dbB
Assert-That ($ra2.Code -eq 0) 'D18 second migrate exit code 0 (idempotent)' ("exit=" + $ra2.Code)
if ($counts2) {
  Assert-That (([int]$counts2.topics) -eq 4 -and ([int]$counts2.sentences) -eq 8) 'D19 second migrate changes nothing' ('topics=' + $counts2.topics + ' sentences=' + $counts2.sentences)
}
$mdOk = 0
foreach ($k in $fixtures.Keys) { if ((Get-Sha (Join-Path $memB $k)) -eq $mdShaBefore[$k]) { $mdOk++ } }
Assert-That ($mdOk -eq $fixtures.Count) 'D20 legacy md files are byte-identical after migration' ($mdOk.ToString() + '/' + $fixtures.Count)
$rcB2 = Invoke-Installer $homeB @('-CheckOnly', '-ProfileName', 'web')
Assert-That ($rcB2.Output -match '已迁移|已就绪') 'D21 -CheckOnly after migration says migrated/ready'

# ===========================================================================
# F. 全新用户默认 profile：desktop 优先（P0）
# ===========================================================================
Write-Host '[F] default profile discovery: desktop preferred for fresh users (P0)'
$homeF = New-TempHome 'f'
$homes += $homeF
New-Item -ItemType Directory -Force -Path (Join-Path $homeF 'profiles\desktop') | Out-Null
$rf = Invoke-Installer $homeF @('-LocalPayload', $Payload)
Assert-That ($rf.Code -eq 0) 'F0 fresh install exit code 0' ("exit=" + $rf.Code)
Assert-That (Test-Path -LiteralPath (Join-Path $homeF 'profiles\desktop\plugins\memory\index.js')) 'F1 installed into profiles/desktop by default'
Assert-That (-not (Test-Path -LiteralPath (Join-Path $homeF 'profiles\web\plugins\memory\index.js'))) 'F2 profiles/web untouched (would be the old wrong default)'
Assert-That ($rf.Output -match 'desktop') 'F3 install report names desktop'
Assert-That ((Get-PatchIdRows (Join-Path $homeF 'profiles\desktop\cordis.patch.yml')) -eq 1) 'F4 desktop patch registered'

# ===========================================================================
# G. 已注册多 profile 自动发现：desktop + web 全部升级（P0）
# ===========================================================================
Write-Host '[G] discovered multi-profile: desktop + web both registered -> both upgraded'
$homeG = New-TempHome 'g'
$homes += $homeG
New-Item -ItemType Directory -Force -Path (Join-Path $homeG 'profiles\desktop') | Out-Null
$preBlock = @(
  '# --- dsh-memory: global auto-memory plugin (installed by the dsh-memory installer) ---',
  '- insert:',
  '    - id: dsh-memory',
  '      name: dsh-memory',
  '      config:',
  '        staleSessionDays: 5',
  '        staleAction: remind'
)
foreach ($n in @('desktop', 'web')) {
  $pf = Join-Path $homeG "profiles\$n\cordis.patch.yml"
  Write-Text-Utf8 $pf (($preBlock -join "`r`n") + "`r`n")
}
$rg = Invoke-Installer $homeG @('-LocalPayload', $Payload)
Assert-That ($rg.Code -eq 0) 'G0 multi-profile install exit code 0' ("exit=" + $rg.Code)
foreach ($n in @('desktop', 'web')) {
  Assert-That (Test-Path -LiteralPath (Join-Path $homeG "profiles\$n\plugins\memory\index.js")) ('G1 ' + $n + ' received the plugin files')
  Assert-That ((Get-PatchIdRows (Join-Path $homeG "profiles\$n\cordis.patch.yml")) -eq 1) ('G2 ' + $n + ' has exactly one registration row')
}
Assert-That ($rg.Output -match '多 profile') 'G3 output reports multi-profile mode'
Assert-That ($rg.Output -match 'desktop' -and $rg.Output -match 'web') 'G4 output lists both target profiles'
$jInfo = Get-Item -LiteralPath (Join-Path $homeG 'profiles\node_modules\dsh-memory') -Force -ErrorAction SilentlyContinue
$jTargetOk = $false
if ($jInfo -and $jInfo.LinkType -ne '') {
  $jTargetOk = ([string]$jInfo.Target).TrimEnd('\', '/') -ieq (Join-Path $homeG 'profiles\desktop\plugins\memory').TrimEnd('\', '/')
}
Assert-That $jTargetOk 'G5 junction points at the primary (desktop) plugin dir'

# ===========================================================================
# E. -Uninstall（保留记忆数据，保留 pending 标记的能力由 D1 覆盖写入端）
# ===========================================================================
Write-Host '[E] -Uninstall'
$ru = Invoke-Installer $homeA @('-Uninstall', '-ProfileName', 'web')
Assert-That ($ru.Code -eq 0) 'E0 -Uninstall exit code 0' ("exit=" + $ru.Code)
Assert-That ((Get-PatchIdRows $patchA) -eq 0) 'E1 patch registration removed (0 rows)'
Assert-That (-not (Test-Path -LiteralPath $pluginDir)) 'E2 plugin dir moved away'
Assert-That (Test-Path -LiteralPath (Join-Path $memRoot '.config.json')) 'E3 memory .config.json preserved'
Assert-That (Test-Path -LiteralPath (Join-Path $homeA 'AGENTS.md')) 'E4 AGENTS.md preserved'
Assert-That (@(Get-ChildItem -LiteralPath (Join-Path $homeA 'profiles\web\plugins') -Directory -Filter '_uninstalled-memory-*').Count -ge 1) 'E5 plugin dir kept as _uninstalled-memory-<ts>'

# ===========================================================================
# H. BUG-5 回归：profile 通过**绝对 file:// 路径**消费别的 profile 的插件目录
#    真机实例：desktop 的 cordis.patch.yml 写 file:///C:/Users/<u>/.dsh/profiles/web/plugins/memory/index.js
#    ⇒ 必须解析到真实目录（web），不能对 desktop 报"关键文件缺失"假错，也不能把迁移命令指向 desktop
# ===========================================================================
Write-Host '[H] consumer profile (absolute file:// registration)'
$homeH = New-TempHome 'h'
$homes += $homeH
New-Item -ItemType Directory -Force -Path (Join-Path $homeH 'profiles\desktop') | Out-Null
$rh = Invoke-Installer $homeH @('-LocalPayload', $Payload, '-ProfileName', 'web')
Assert-That ($rh.Code -eq 0) 'H0 install into web profile exit 0' ("exit=" + $rh.Code)
$webPlugin = Join-Path $homeH 'profiles\web\plugins\memory'
Assert-That (Test-Path -LiteralPath (Join-Path $webPlugin 'index.js')) 'H1 web profile hosts index.js'
# desktop 只写注册（绝对路径指向 web 的 index.js），自己不放文件
$absUrl = 'file:///' + ((Join-Path $webPlugin 'index.js') -replace '\\', '/')
$patchH = Join-Path $homeH 'profiles\desktop\cordis.patch.yml'
Write-Text-Utf8 $patchH (@('# desktop 消费 web 的插件目录', '- insert:', '    - id: dsh-memory', ('      name: ' + $absUrl)) -join "`r`n")
Assert-That (-not (Test-Path -LiteralPath (Join-Path $homeH 'profiles\desktop\plugins\memory'))) 'H2 desktop has no own plugin dir (consumer only)'
$rh2 = Invoke-Installer $homeH @('-CheckOnly', '-ProfileName', 'desktop')
Assert-That ($rh2.Code -eq 0) 'H3 -CheckOnly on consumer profile exit 0' ("exit=" + $rh2.Code)
Assert-That ($rh2.Output -notmatch '\[desktop\][^\r\n]*关键文件缺失') 'H4 no false "关键文件缺失" for consumer profile' $null
Assert-That ($rh2.Output -match '\[desktop\][^\r\n]*index\.js\s+\d+\s+bytes') 'H5 consumer profile resolves to real files (version + bytes)' $null
$rh3 = Invoke-Installer $homeH @('-CheckOnly')
Assert-That ($rh3.Code -eq 0) 'H6 -CheckOnly (auto discovery) exit 0' ("exit=" + $rh3.Code)
# 核心回归：任何输出都不得引用"consumer profile 自己的空目录"（真机 desktop 目录根本不存在）
Assert-That ($rh3.Output -notmatch 'profiles\\desktop\\plugins\\memory') 'H7 no output references the consumer profile''s own (nonexistent) plugin dir' $null
# 若给出了迁移命令（含 --md-root），路径必须落在真实目录（web）上
$migLine = (@($rh3.Output -split "`r?`n") | Where-Object { $_ -match '--md-root' } | Select-Object -First 1)
$h8ok = if ($migLine) { $migLine -match 'profiles\\web\\plugins\\memory' } else { $true }
Assert-That $h8ok 'H8 migration command (when printed) points at the real web plugin dir' $migLine
$rh4 = Invoke-Installer $homeH @('-LocalPayload', $Payload)
Assert-That ($rh4.Code -eq 0) 'H9 full install with consumer profile exit 0' ("exit=" + $rh4.Code)
Assert-That (-not (Test-Path -LiteralPath (Join-Path $homeH 'profiles\desktop\plugins\memory\index.js'))) 'H10 installer did not create a duplicate copy under desktop' $null

# ===========================================================================
Write-Host ''
Write-Host ('self-test summary: ' + $script:pass + ' passed, ' + $script:fail + ' failed')
if (-not $KeepTemp) {
  foreach ($h in $homes) { Remove-Item -LiteralPath $h -Recurse -Force -ErrorAction SilentlyContinue }
  Write-Host 'temp DSH_HOME dirs removed (use -KeepTemp to keep them)'
} else {
  foreach ($h in $homes) { Write-Host ('kept: ' + $h) }
}
if ($script:fail -gt 0) { exit 1 }
exit 0
