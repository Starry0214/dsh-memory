#!/usr/bin/env bash
# dsh-memory installer v4 for macOS / Linux (and Git Bash on Windows)
#
# One-line install / upgrade (idempotent - re-run to upgrade):
#   curl -fsSL https://raw.githubusercontent.com/Starry0214/dsh-memory/main/install.sh | bash
#
# Modes:
#   (default)          install / upgrade; seed the memory library; register cordis.patch.yml;
#                      decide `memoryTopicDbEnabled`
#   --check            read-only health report (versions / payload sha / memtopic / DB / legacy md /
#                      .config.json / AGENTS.md / patch registration / pending marker)
#   --migrate [--yes]  old md memory -> topic database (delegates to memtopic/src/migrate.mjs).
#                      While DSH is running it registers a pending marker (auto-migrate on next boot)
#                      instead of applying; with --yes and DSH stopped it applies immediately.
#                      Degraded mode: if migrate.mjs or node is unavailable it only prints the
#                      manual commands (see docs/迁移指南.md).
#
# Target profiles (same rules as install.ps1, desktop-first fix 2026-10-30):
#   1) --profile <name>  explicitly
#   2) all profiles whose cordis.patch.yml already has `- id: dsh-memory`
#   3) fresh user: desktop if present, else web
#   $DSH_PROFILE is only logged, never overrides discovery.
#
# Options / env:
#   --profile <name>        target profile (explicit)
#   --local-payload <zip>   offline install (install-manifest.json in the same dir or its parent)
#   --raw-base <url>        mirror / local http server
#   DSH_HOME, DSH_PROFILE, DSH_MEMORY_RAW, DSH_MEMORY_LOCAL (zip), DSH_MEMORY_MANIFEST,
#   DSH_MEMORY_NODE (node executable override), DSH_DESKTOP_NODE_EXECUTABLE
#
# Not provided by this script: --uninstall (use install.ps1 -Uninstall on Windows, or remove the
# registration by hand). Requires: curl, sha256sum (or shasum), unzip (or python3) and node or
# python3 to parse the manifest and run the migration engine.
set -u

RAW_BASE="${DSH_MEMORY_RAW:-https://raw.githubusercontent.com/Starry0214/dsh-memory/main}"
CDN_BASE="${DSH_MEMORY_CDN:-https://cdn.jsdelivr.net/gh/Starry0214/dsh-memory@main}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DSH_HOME="${DSH_HOME%/}"
MODE="install"
PROFILE_ARG=""
LOCAL_PAYLOAD="${DSH_MEMORY_LOCAL:-}"
DO_YES="no"
ASSUME_STOPPED="no"
MERGE_FLAG="no"

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE_ARG="${2:-}"; shift 2 ;;
    --profile=*) PROFILE_ARG="${1#*=}"; shift ;;
    --local-payload) LOCAL_PAYLOAD="${2:-}"; shift 2 ;;
    --local-payload=*) LOCAL_PAYLOAD="${1#*=}"; shift ;;
    --raw-base) RAW_BASE="${2:-}"; shift 2 ;;
    --raw-base=*) RAW_BASE="${1#*=}"; shift ;;
    --check) MODE="check"; shift ;;
    --migrate) MODE="migrate"; shift ;;
    --yes|-y) DO_YES="yes"; shift ;;
    --assume-host-stopped) ASSUME_STOPPED="yes"; shift ;;
    --merge) MERGE_FLAG="yes"; shift ;;
    -h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1（--help 查看用法）" >&2; exit 1 ;;
  esac
done
RAW_BASE="${RAW_BASE%/}"
CDN_BASE="${CDN_BASE%/}"

say()  { printf '%s\n' "$*"; }
ok()   { printf '  OK   %s\n' "$*"; }
warn() { printf '  WARN %s\n' "$*"; }
bad()  { printf '  ERR  %s\n' "$*" >&2; }
item() { printf '  %s\n' "$*"; }
sect() { printf '\n%s\n' "$*"; }
die()  { bad "$*"; exit 1; }

TMPDIR_BASE="${TMPDIR:-/tmp}"
WORK="$(mktemp -d "$TMPDIR_BASE/dsh-memory-install.XXXXXX")" || die "无法创建临时目录"
cleanup() { rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# primitives
# ---------------------------------------------------------------------------
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else return 1; fi
}

http_get() { # url dest
  command -v curl >/dev/null 2>&1 || return 1
  curl -fsSL --connect-timeout 30 --max-time 300 "$1" -o "$2" 2>/dev/null
}

fetch_remote() { # relpath dest label
  rel="$1"; dest="$2"; label="$3"
  item "下载 $label ..."
  if http_get "$RAW_BASE/$rel" "$dest"; then return 0; fi
  warn "主源失败，改用备用源（jsDelivr）..."
  if http_get "$CDN_BASE/$rel" "$dest"; then return 0; fi
  return 1
}

json_tool() {
  if command -v node >/dev/null 2>&1; then printf 'node'; return; fi
  if command -v python3 >/dev/null 2>&1; then printf 'python3'; return; fi
  printf ''
}
JSON_TOOL="$(json_tool)"

manifest_field() { # file, dotted key
  file="$1"; key="$2"
  if [ "$JSON_TOOL" = "node" ]; then
    node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));let v=j;for(const p of process.argv[2].split("."))v=v==null?null:v[p];console.log(v==null?"":String(v))' "$file" "$key" 2>/dev/null
  elif [ "$JSON_TOOL" = "python3" ]; then
    python3 - "$file" "$key" <<'PY'
import json,sys
j=json.load(open(sys.argv[1],encoding="utf-8"))
v=j
for p in sys.argv[2].split("."):
    v = v.get(p) if isinstance(v,dict) else None
print("" if v is None else str(v))
PY
  else return 1; fi
}

manifest_files() { # file -> "sha256<TAB>bytes<TAB>path"
  file="$1"
  if [ "$JSON_TOOL" = "node" ]; then
    node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));for(const f of j.files)console.log(f.sha256+"\t"+f.bytes+"\t"+f.path)' "$file" 2>/dev/null
  elif [ "$JSON_TOOL" = "python3" ]; then
    python3 - "$file" <<'PY'
import json,sys
j=json.load(open(sys.argv[1],encoding="utf-8"))
for f in j["files"]:
    print('%s\t%s\t%s' % (f["sha256"], f["bytes"], f["path"]))
PY
  else return 1; fi
}

# ---------------------------------------------------------------------------
# profile discovery
# ---------------------------------------------------------------------------
profiles_dir="$DSH_HOME/profiles"
[ -d "$profiles_dir" ] || die "DSH_HOME 下没有 profiles 目录：$DSH_HOME（确认 DSH 已安装、DSH_HOME 正确）"

list_profiles() {
  for d in "$profiles_dir"/*; do
    [ -d "$d" ] || continue
    n="$(basename "$d")"
    [ "$n" = "node_modules" ] && continue
    printf '%s\n' "$n"
  done
}

has_memory_registration() { # patch file
  [ -f "$1" ] || return 1
  tr -d '\r' < "$1" | grep -Eq '^[[:space:]]*-[[:space:]]*id:[[:space:]]*dsh-memory([[:space:]]|$|#)'
}

TARGETS=""
MODE_SRC=""
if [ -n "$PROFILE_ARG" ]; then
  [ -d "$profiles_dir/$PROFILE_ARG" ] || die "profile '$PROFILE_ARG' 不存在。可用：$(list_profiles | tr '\n' ' ')"
  TARGETS="$PROFILE_ARG"; MODE_SRC="显式指定（--profile）"
else
  found=""
  for n in $(list_profiles); do
    has_memory_registration "$profiles_dir/$n/cordis.patch.yml" && found="$found $n"
  done
  found="$(printf '%s' "$found" | sed 's/^ *//;s/ *$//')"
  if [ -n "$found" ]; then
    TARGETS="$found"; MODE_SRC="自动发现（cordis.patch.yml 已有 dsh-memory 注册）"
  else
    if [ -d "$profiles_dir/desktop" ]; then TARGETS="desktop"
    elif [ -d "$profiles_dir/web" ]; then TARGETS="web"
    else TARGETS="$(list_profiles | head -n1)"; fi
    MODE_SRC="默认（全新用户：desktop 优先，否则 web）"
  fi
fi
[ -n "$TARGETS" ] || die "没有可用的 profile"
patch_of()      { printf '%s/cordis.patch.yml' "$profiles_dir/$1"; }
# [BUG-5] 注册表若用**绝对 file:// 路径**指向别的 profile（真机：desktop 的 cordis.patch.yml 指向
#   profiles/web/plugins/memory/index.js），则插件真实目录 = 那个目录，不是 <profile>/plugins/memory。
#   否则 -CheckOnly/迁移指引会指向不存在的路径，还会对 desktop 报"关键文件缺失"假错。
registered_dir_of() {
  local p line v
  p="$(patch_of "$1")"; [ -f "$p" ] || return 0
  line="$(awk '
    /^[ \t]*-[ \t]*id:[ \t]*dsh-memory[ \t]*($|#)/ { f=1; c=0; next }
    f && c < 8 {
      c++
      if ($0 ~ /^[ \t]*name:[ \t]*"?file:\/\//) { print; exit }
      if ($0 ~ /^[ \t]*name:[ \t]*/) exit
    }
  ' "$p")"
  [ -n "$line" ] || return 0
  v="${line#*name:}"
  v="$(printf '%s' "$v" | sed -E 's/^[ \t]*"?//; s/[ \t]*$//; s/"$//')"
  v="$(printf '%s' "$v" | sed -E 's#^file:/+##')"
  case "$v" in
    [A-Za-z]:/*) printf '%s\n' "${v%/*}" ;;
    *) return 0 ;;
  esac
}
plugin_dir_of() {
  local reg; reg="$(registered_dir_of "$1")"
  if [ -n "$reg" ]; then printf '%s\n' "$reg"; else printf '%s/plugins/memory' "$profiles_dir/$1"; fi
}
# [BUG-5] 主 profile：优先"自己目录里真有插件"的（consumer profile 的目录可能根本不存在）
pick_owner() {
  local n d
  for n in $TARGETS; do
    [ "$n" = "desktop" ] || continue
    d="$profiles_dir/$n/plugins/memory"; [ -f "$d/index.js" ] && { printf '%s\n' "$n"; return; }
  done
  for n in $TARGETS; do
    d="$profiles_dir/$n/plugins/memory"; [ -f "$d/index.js" ] && { printf '%s\n' "$n"; return; }
  done
}
PRIMARY="$(pick_owner)"
[ -n "$PRIMARY" ] || PRIMARY="$(printf '%s' "$TARGETS" | tr ' ' '\n' | grep -x 'desktop' 2>/dev/null | head -n1)"
[ -n "$PRIMARY" ] || PRIMARY="$(printf '%s' "$TARGETS" | awk '{print $1}')"
mem_root="$DSH_HOME/memory"

say "dsh-memory installer v4"
say "  DSH_HOME : $DSH_HOME"
say "  profile 来源 : $MODE_SRC"
say "  目标 profile : $TARGETS"
if [ -n "${DSH_PROFILE:-}" ]; then
  if [ -d "$profiles_dir/$DSH_PROFILE" ]; then
    item "检测到宿主 profile=$DSH_PROFILE，已按自动发现处理（不覆盖发现结果）"
  else
    item "检测到 DSH_PROFILE=$DSH_PROFILE（该 profile 不存在），已按自动发现处理"
  fi
fi
[ "$JSON_TOOL" = "" ] && die "需要 node 或 python3 来解析 install-manifest.json（Windows 请用 install.ps1）"
sha256_of "$0" >/dev/null 2>&1 || die "需要 sha256sum 或 shasum（macOS 自带）"

# ---------------------------------------------------------------------------
# node resolver (install itself never needs node; only detect/migrate do)
# ---------------------------------------------------------------------------
node_runner() {
  if [ -n "${DSH_MEMORY_NODE:-}" ] && [ -x "${DSH_MEMORY_NODE}" ]; then printf '%s\n' "$DSH_MEMORY_NODE"; return 0; fi
  if command -v node >/dev/null 2>&1; then command -v node; return 0; fi
  if [ -n "${DSH_DESKTOP_NODE_EXECUTABLE:-}" ] && [ -x "${DSH_DESKTOP_NODE_EXECUTABLE}" ]; then printf '%s\n' "$DSH_DESKTOP_NODE_EXECUTABLE"; return 0; fi
  for c in "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" "/opt/DeepSeek Harness/deepseek-harness" "/usr/lib/deepseek-harness/deepseek-harness"; do
    [ -x "$c" ] && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}
NODE_EXE="$(node_runner || true)"
run_node() {
  if [ "$(basename "$NODE_EXE" 2>/dev/null)" = "node" ]; then "$NODE_EXE" "$@"
  else ELECTRON_RUN_AS_NODE=1 "$NODE_EXE" "$@"; fi
}
detect_flags() { # migrate script json out -> "1/0" x4: needs,migrated,empty,hostRunning
  [ -n "$NODE_EXE" ] || return 1
  out="$("$NODE_EXE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=s.indexOf("{");const b=s.lastIndexOf("}");try{const j=JSON.parse(s.slice(a,b+1));console.log([j.needsMigration?"1":"0",j.alreadyMigrated?"1":"0",j.empty?"1":"0",(j.host&&j.host.running)?"1":"0"].join(""))}catch(e){console.log("")}})' 2>/dev/null)"
  [ -n "$out" ] && printf '%s\n' "$out"
}
pending_path() { printf '%s/.memtopic/migrate-pending.json' "$mem_root"; }
write_pending() { # pluginVersion note
  pv="$1"; note="$2"; p="$(pending_path)"; d="$(dirname "$p")"
  mkdir -p "$d" || { warn "无法创建 $d"; return 1; }
  at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  tmp="$p.tmp.$$"
  if [ "$JSON_TOOL" = "node" ]; then
    "$NODE_EXE" -e 'const fs=require("fs");const o={schemaVersion:1,at:process.argv[1],requestedBy:"installer",mdRoot:process.argv[2],dbFile:process.argv[3],pluginVersion:process.argv[4],note:process.argv[5]};fs.writeFileSync(process.argv[6],JSON.stringify(o,null,2)+"\n")' \
      "$at" "$mem_root" "$mem_root/.memtopic/mem.db" "$pv" "$note" "$tmp"
  else
    python3 - "$at" "$mem_root" "$mem_root/.memtopic/mem.db" "$pv" "$note" "$tmp" <<'PY'
import json,sys
at,md,db,pv,note,out=sys.argv[1:7]
o={"schemaVersion":1,"at":at,"requestedBy":"installer","mdRoot":md,"dbFile":db,"pluginVersion":pv,"note":note}
open(out,"w",encoding="utf-8").write(json.dumps(o,ensure_ascii=False,indent=2)+"\n")
PY
  fi
  mv -f "$tmp" "$p" && return 0 || { rm -f "$tmp"; return 1; }
}
check_pending() {
  p="$(pending_path)"
  [ -f "$p" ] && { warn "pending 迁移标记：存在（重启 DSH 后自动迁移）"; item "  $(tr -d '\n' < "$p")"; } || say "  pending 迁移标记：无"
}

# ---------------------------------------------------------------------------
# mode: --check
# ---------------------------------------------------------------------------
if [ "$MODE" = "check" ]; then
  say "dsh-memory installer v4 - check only (read-only; only the small manifest is downloaded)"
  manifest="$WORK/install-manifest.json"
  manifest_ok="no"
  if [ -n "$LOCAL_PAYLOAD" ]; then
    lp="$LOCAL_PAYLOAD"
    for cand in "$(dirname "$lp")/install-manifest.json" "$(dirname "$(dirname "$lp")")/install-manifest.json" "${DSH_MEMORY_MANIFEST:-}"; do
      if [ -n "$cand" ] && [ -f "$cand" ]; then cp -f "$cand" "$manifest"; manifest_ok="yes"; break; fi
    done
  else
    fetch_remote "install-manifest.json" "$manifest" "manifest" && manifest_ok="yes"
  fi
  sect "[1/6] 版本"
  if [ "$manifest_ok" = "yes" ]; then say "  发布版本：v$(manifest_field "$manifest" version)"; else warn "无法获取发布 manifest（离线/镜像不可达）"; fi
  for n in $TARGETS; do
    idx="$(plugin_dir_of "$n")/index.js"
    if [ -f "$idx" ]; then
      v="$(grep -oE 'const PLUGIN_VERSION = "[^"]+"' "$idx" | head -n1 | sed -E 's/.*"([^"]+)"/\1/')"
      ok "[$n] v${v:-unknown}，index.js $(wc -c < "$idx" | tr -d ' ') bytes"
    else warn "[$n] 未安装（运行本脚本即可）"; fi
  done
  sect "[2/6] payload 完整性"
  if [ "$manifest_ok" = "yes" ]; then
    for n in $TARGETS; do
      pdir="$(plugin_dir_of "$n")"; miss=0; badsha=0; total=0
      while IFS="$(printf '\t')" read -r sh bytes rel; do
        total=$((total+1))
    case "$rel" in client/*) f="$(dirname "$pdir")/dsh-memory-client/${rel#client/}" ;; *) f="$pdir/$rel" ;; esac
        if [ ! -f "$f" ]; then miss=$((miss+1)); continue; fi
        got="$(sha256_of "$f")" || got=""
        [ "$got" = "$sh" ] || badsha=$((badsha+1))
      done < <(manifest_files "$manifest")
      if [ "$miss" -eq 0 ] && [ "$badsha" -eq 0 ]; then ok "[$n] $total/$total 个文件 sha256 全部匹配"
      else warn "[$n] 缺失 $miss / 不一致 $badsha / 共 $total（重跑安装器）"; fi
    done
  else warn "无 manifest，跳过逐文件 sha 校验"; fi
  sect "[3/6] memtopic + 主题库"
  for n in $TARGETS; do
    d="$(plugin_dir_of "$n")/memtopic/src"; cnt=0
    [ -d "$d" ] && cnt="$(ls "$d"/*.mjs 2>/dev/null | wc -l | tr -d ' ')"
    if [ "$cnt" -ge 12 ]; then ok "[$n] $cnt 个 .mjs"; else warn "[$n] 仅 $cnt 个 .mjs（重跑安装器）"; fi
  done
  db="$mem_root/.memtopic/mem.db"
  if [ -f "$db" ]; then say "  主题库：存在（$(wc -c < "$db" | tr -d ' ') bytes）"; else say "  主题库：不存在"; fi
  sect "[4/6] 遗留 md"
  legacy_cnt=0
  for sub in sessions knowledge projects tools; do
    [ -d "$mem_root/$sub" ] || continue
    c="$(find "$mem_root/$sub" -type f -name '*.md' ! -name '*.bak*' 2>/dev/null | wc -l | tr -d ' ')"
    legacy_cnt=$((legacy_cnt + c)); [ "$c" -gt 0 ] && say "  $sub：$c 个 md"
  done
  [ "$legacy_cnt" -eq 0 ] && say "  无遗留 md"
  # [CRA M3 修复 2026-11-05] --check 段在下方（L610 附近）之前执行：归一化函数与旧 v4 sha 必须**先**定义，
  #   否则 v4 分代判断会因「命令不存在 / 变量为空」静默失效 → 把待升级用户反向错报成 OK v4 协议。
  LEGACY_SHA_3="45463dd54b87c890bd7fd8e11a96a80ebeab96ffb597c77a93d8247d1d662e58"
  LEGACY_SHA_4="2de634f589f042f970826883368af374ff25f8159c94150996ff37222186b066"
  sha_of_normalized() { # strip BOM/CR, trailing spaces, trailing blank lines -> sha256
    f="$1"; tmp0="$WORK/norm0.txt"; tmp="$WORK/norm.txt"
    bom="$(head -c 3 "$f" | od -An -tx1 | tr -d ' \n')"
    if [ "$bom" = "efbbbf" ]; then tail -c +4 "$f" > "$tmp0"; else cp "$f" "$tmp0"; fi
    sed -e 's/\r$//' -e 's/[[:space:]]*$//' "$tmp0" | awk '{lines[NR]=$0} END{last=NR; while(last>0 && lines[last]=="")last--; for(i=1;i<=last;i++)print lines[i]}' > "$tmp"
    sha256_of "$tmp"
  }
  sect "[5/6] 开关 / AGENTS / pending"
  cfg="$mem_root/.config.json"
  if [ -f "$cfg" ]; then say "  .config.json：$(tr -d '\n' < "$cfg")"; else say "  .config.json：不存在（新装会写 memoryTopicDbEnabled=true）"; fi
  ag="$DSH_HOME/AGENTS.md"
  if [ -f "$ag" ]; then
    if grep -q 'dsh-memory-agents-template: v4' "$ag"; then
      # [CRA M3 修复 2026-11-05] v4 分两代：--check 必须能分辨「4.0.1 旧模板（待升级）」与「已是最新」，
      #   否则会把待升级的用户报成 OK v4 协议（反向错报）。
      h="$(sha_of_normalized "$ag")" || h=""
      if [ "$h" = "$LEGACY_SHA_3" ] || [ "$h" = "$LEGACY_SHA_4" ]; then
        warn "AGENTS.md：v4 旧模板（4.0.1 / 4.5.0 时代）→ 重跑安装器自动升级 v4.5.1（会先备份）"
      else
        ok "AGENTS.md：v4 协议"
      fi
    else warn "AGENTS.md：不是 v4（重跑安装器会按白名单升级；改过的文件不会覆盖）"; fi
  else warn "AGENTS.md：不存在（安装器会写 v4 模板）"; fi
  check_pending
  sect "[6/6] patch 注册"
  for n in $TARGETS; do
    p="$(patch_of "$n")"
    if has_memory_registration "$p"; then
      nm="$(tr -d '\r' < "$p" | grep -A2 'id:[[:space:]]*dsh-memory' | grep -E 'name:' | head -n1 | sed 's/^ *//')"
      ok "[$n] 已注册（$nm）"
    else warn "[$n] 未注册（重跑安装器）"; fi
  done
  sect "下一步"
  item "安装/升级：bash $0"
  item "迁移旧记忆：bash $0 --migrate --yes（DSH 运行中会先登记 pending）"
  exit 0
fi

# ---------------------------------------------------------------------------
# mode: --migrate
# ---------------------------------------------------------------------------
if [ "$MODE" = "migrate" ]; then
  migrate_script=""
  for n in $TARGETS; do
    c="$(plugin_dir_of "$n")/memtopic/src/migrate.mjs"
    [ -f "$c" ] && { migrate_script="$c"; break; }
  done
  if [ -z "$migrate_script" ]; then
    bad "迁移器未就绪：<插件目录>/memtopic/src/migrate.mjs 不存在（先重跑安装器升级到 v4）"
    exit 3
  fi
  if [ -z "$NODE_EXE" ]; then
    bad "未找到 node：--migrate 需要 node 或已安装的 DSH 桌面版"
    item "出路：① 安装 Node.js（≥22.5）② 设置 DSH_MEMORY_NODE ③ 暂时不迁移，md 模式照常工作"
    exit 3
  fi
  common=(--md-root "$mem_root" --db "$mem_root/.memtopic/mem.db" --dsh-home "$DSH_HOME")
  sect "检测（只读）"
  run_node "$migrate_script" --detect "${common[@]}" || true
  flags="$(run_node "$migrate_script" --detect --json "${common[@]}" 2>/dev/null | detect_flags || true)"
  nb=""; mg=""; em=""; hr=""
  if [ "${#flags}" -eq 4 ]; then
    nb="${flags%???}"; mg="${flags#?}"; mg="${mg%??}"; em="${flags#??}"; em="${em%?}"; hr="${flags#???}"
  fi
  if [ "$nb" = "1" ]; then
    if [ "$hr" = "1" ] && [ "$ASSUME_STOPPED" != "yes" ]; then
      sect "DSH 正在运行 —— 登记为下次启动自动迁移"
      pv="$(grep -oE 'const PLUGIN_VERSION = "[^"]+"' "$(plugin_dir_of "$PRIMARY")/index.js" 2>/dev/null | head -n1 | sed -E 's/.*"([^"]+)"/\1/')"
      if write_pending "${pv:-unknown}" "安装器 sh --migrate：检测到 DSH 正在运行，登记为下次启动自动迁移"; then
        ok "已登记迁移：$(pending_path)"
        item "重启 DSH 后插件会在启动时自动执行迁移（先快照；失败自动回退 md 模式）。"
      else
        warn "pending 标记写入失败；请完全退出 DSH 后手工执行："
        item "  \"$NODE_EXE\" \"$migrate_script\" --apply --yes --md-root \"$mem_root\" --db \"$mem_root/.memtopic/mem.db\" --dsh-home \"$DSH_HOME\""
      fi
      exit 0
    fi
    if [ "$DO_YES" != "yes" ]; then
      sect "只读检测完成（未做任何改动）"
      item "执行迁移：重跑本脚本加 --migrate --yes"
      exit 0
    fi
    sect "执行迁移（migrate.mjs --apply --yes）"
    args=(--apply --yes --md-root "$mem_root" --db "$mem_root/.memtopic/mem.db" --dsh-home "$DSH_HOME")
    [ "$MERGE_FLAG" = "yes" ] && args+=(--merge)
    [ "$ASSUME_STOPPED" = "yes" ] && args+=(--assume-host-stopped)
    run_node "$migrate_script" "${args[@]}"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      rm -f "$(pending_path)"
      cfg="$mem_root/.config.json"
      if [ ! -f "$cfg" ]; then printf '{\n  "memoryTopicDbEnabled": true\n}\n' > "$cfg" && ok "已写入 .config.json（memoryTopicDbEnabled=true）"
      elif grep -Eq '"memoryTopicDbEnabled"[[:space:]]*:[[:space:]]*false' "$cfg"; then warn "主题库开关是显式 false —— 尊重设置"
      elif ! grep -q 'memoryTopicDbEnabled' "$cfg"; then warn "请手工在 $cfg 里加 \"memoryTopicDbEnabled\": true"; fi
      ok "迁移完成；重启 DSH 后生效"
    else
      bad "迁移失败，退出码 $rc（旧 md 未被修改，可重跑 --apply 续跑）"
    fi
    exit "$rc"
  elif [ "$mg" = "1" ]; then
    ok "已迁移（主题库已有数据，无需操作）"
    [ -f "$(pending_path)" ] && rm -f "$(pending_path)" && item "已清除过期 pending 标记"
  elif [ "$em" = "1" ]; then
    ok "全新用户（无旧 md、无库），无需迁移"
  else
    ok "无需迁移"
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# mode: install / upgrade
# ---------------------------------------------------------------------------
sect "[1/8] 解析 install-manifest.json"
manifest="$WORK/install-manifest.json"
if [ -n "$LOCAL_PAYLOAD" ]; then
  lp="$LOCAL_PAYLOAD"
  [ -e "$lp" ] || die "--local-payload 指向的路径不存在：$lp"
  got=""
  for cand in "$(dirname "$lp")/install-manifest.json" "$(dirname "$(dirname "$lp")")/install-manifest.json" "${DSH_MEMORY_MANIFEST:-}"; do
    if [ -n "$cand" ] && [ -f "$cand" ]; then cp -f "$cand" "$manifest"; got="$cand"; break; fi
  done
  [ -n "$got" ] || die "找不到 install-manifest.json（zip 同目录或上一级；可用 DSH_MEMORY_MANIFEST 指定）"
  item "使用本地 manifest：$got"
else
  fetch_remote "install-manifest.json" "$manifest" "manifest" || die "无法下载 install-manifest.json（网络/镜像不可达）；离线请用 --local-payload"
fi
version="$(manifest_field "$manifest" version)"
zip_name="$(manifest_field "$manifest" zip.name)"
zip_sha="$(manifest_field "$manifest" zip.sha256)"
[ -n "$version" ] && [ -n "$zip_name" ] || die "manifest 缺字段（version/zip.name）"
ok "发布版本 v$version，zip $zip_name"

sect "[2/8] 获取 payload zip 并校验 sha256"
zip_path="$WORK/$zip_name"
if [ -n "$LOCAL_PAYLOAD" ]; then
  lp="$LOCAL_PAYLOAD"
  if [ -d "$lp" ]; then
    cp -f "$lp/payload/$zip_name" "$zip_path" 2>/dev/null || cp -f "$lp/$zip_name" "$zip_path" 2>/dev/null || true
  elif [ -f "$lp" ]; then
    cp -f "$lp" "$zip_path"
  fi
  [ -f "$zip_path" ] || die "本地 payload zip 不存在：$zip_name"
else
  fetch_remote "payload/$zip_name" "$zip_path" "payload zip" || die "payload zip 下载失败（主源与 jsDelivr 都不可达）；离线请用 --local-payload"
fi
got_sha="$(sha256_of "$zip_path")" || die "无法计算 zip sha256"
if [ "$got_sha" != "$zip_sha" ]; then
  bad "payload zip sha256 校验失败 —— 已中止，未改动任何文件。"
  bad "  期望 $zip_sha"
  bad "  实际 $got_sha"
  exit 1
fi
ok "zip sha256 校验通过（$(wc -c < "$zip_path" | tr -d ' ') bytes）"

sect "[3/8] 解压并逐文件校验 sha256"
stage="$WORK/stage"; mkdir -p "$stage"
if command -v unzip >/dev/null 2>&1; then
  unzip -q -o "$zip_path" -d "$stage" || die "解压失败（unzip）"
elif command -v python3 >/dev/null 2>&1; then
  python3 -m zipfile -e "$zip_path" "$stage" || die "解压失败（python3 zipfile）"
else die "需要 unzip 或 python3 来解压 payload"; fi
fails=0
while IFS="$(printf '\t')" read -r sh bytes rel; do
  f="$stage/$rel"
  if [ ! -f "$f" ]; then bad "缺少：$rel"; fails=$((fails+1)); continue; fi
  actual="$(sha256_of "$f")" || actual=""
  if [ "$actual" != "$sh" ]; then bad "sha256 不一致：$rel"; fails=$((fails+1)); fi
done < <(manifest_files "$manifest")
[ "$fails" -eq 0 ] || die "payload 内容校验失败 —— 已中止，未改动任何文件"
ok "payload 全部文件 sha256 匹配"

# ---- pre-detect (best effort, never blocks install) ----
sect "[4/8] 检测记忆库状态"
needs=""; migrated=""; empty=""; host_running=""
staged_migrate="$stage/memtopic/src/migrate.mjs"
if [ -f "$staged_migrate" ] && [ -n "$NODE_EXE" ]; then
  run_node "$staged_migrate" --detect --json --md-root "$mem_root" --db "$mem_root/.memtopic/mem.db" --dsh-home "$DSH_HOME" 2>/dev/null | "$NODE_EXE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=s.indexOf("{");const b=s.lastIndexOf("}");try{const j=JSON.parse(s.slice(a,b+1));const l=j.legacy||{};console.log("  旧 md 文件 : "+(l.importableFiles||0)+" 个 / "+(l.importableSentences||0)+" 句（可导入）");if(j.db)console.log("  主题库    : "+(j.db.exists?("存在："+(j.db.topics||0)+" 主题 / "+(j.db.sentences||0)+" 句"):"不存在"));if(j.host)console.log("  宿主 DSH  : "+(j.host.running?"运行中":"未运行"));console.log("  判定      : "+(j.needsMigration?"需要迁移":j.alreadyMigrated?"已迁移":j.empty?"全新用户":"无需迁移"))}catch(e){}})'
  flags="$(run_node "$staged_migrate" --detect --json --md-root "$mem_root" --db "$mem_root/.memtopic/mem.db" --dsh-home "$DSH_HOME" 2>/dev/null | detect_flags || true)"
  if [ "${#flags}" -eq 4 ]; then
    needs="${flags%???}"; migrated="${flags#?}"; migrated="${migrated%??}"; empty="${flags#??}"; empty="${empty%?}"; host_running="${flags#???}"
  fi
fi
if [ -z "$needs" ]; then
  warn "migrate --detect 不可用，改用静态判断"
  legacy_cnt=0
  for sub in sessions knowledge projects tools; do
    [ -d "$mem_root/$sub" ] || continue
    c="$(find "$mem_root/$sub" -type f -name '*.md' ! -name '*.bak*' 2>/dev/null | wc -l | tr -d ' ')"
    legacy_cnt=$((legacy_cnt + c))
  done
  if [ -f "$mem_root/.memtopic/mem.db" ] && [ "$(wc -c < "$mem_root/.memtopic/mem.db" | tr -d ' ')" -gt 8192 ]; then migrated="1"
  elif [ "$legacy_cnt" -gt 0 ]; then needs="1"
  else empty="1"; fi
fi

# ---- backup + copy per profile ----
sect "[5/8] 备份现有插件目录并写入新文件"
multi="no"; [ "$(printf '%s\n' $TARGETS | wc -l | tr -d ' ')" -gt 1 ] && multi="yes"
for n in $TARGETS; do
  [ "$multi" = "yes" ] && sect "profile: $n"
  pdir="$(plugin_dir_of "$n")"
  mkdir -p "$pdir"
  stamp="$(date +%Y%m%d_%H%M%S)"
  existing=""
  for f in index.js package.json memtopic client AGENTS.template.md; do
    [ -e "$pdir/$f" ] && existing="$existing $f"
  done
  if [ -n "$existing" ]; then
    bak="$pdir/_backup-$stamp"; mkdir -p "$bak"
    for f in $existing; do cp -R "$pdir/$f" "$bak/" 2>/dev/null || true; done
    ok "已备份到 $bak（$(printf '%s' "$existing" | sed 's/^ *//')）"
  else
    item "没有旧版本文件需要备份（该 profile 全新安装）"
  fi
  # [BUG-6] payload 的 client/** 是「设置界面半区」，宿主按 ./plugins/dsh-memory-client/lib/index.js 加载
  #   ⇒ 必须落到 <plugins>/dsh-memory-client/（写进 <pluginDir>/client/ 没人引用，新用户看不到设置界面）
  while IFS="$(printf '\t')" read -r sh bytes rel; do
    case "$rel" in
      client/*) dst="$(dirname "$pdir")/dsh-memory-client/${rel#client/}" ;;
      *)        dst="$pdir/$rel" ;;
    esac
    mkdir -p "$(dirname "$dst")"; cp -f "$stage/$rel" "$dst"
  done < <(manifest_files "$manifest")
  cnt="$(ls "$pdir/memtopic/src"/*.mjs 2>/dev/null | wc -l | tr -d ' ')"
  if [ "$cnt" -ge 12 ]; then ok "写入完成；memtopic $cnt 个 .mjs 模块就位"; else bad "memtopic 模块不足（$cnt）"; fi
done

# ---- memory skeleton + config ----
sect "[6/8] 初始化记忆库骨架并按迁移状态决定主题库开关"
mkdir -p "$mem_root" "$mem_root/sessions" "$mem_root/projects" "$mem_root/tools" "$mem_root/knowledge"
for f in global.md index.md; do
  if [ ! -f "$mem_root/$f" ]; then printf '# %s\n' "$f" > "$mem_root/$f"; item "新建 $mem_root/$f"; fi
done
cfg="$mem_root/.config.json"
write_flag() {
  if [ ! -f "$cfg" ]; then
    printf '{\n  "memoryTopicDbEnabled": true\n}\n' > "$cfg"; ok ".config.json：新增 memoryTopicDbEnabled=true（主题库默认开启）"
  elif grep -Eq '"memoryTopicDbEnabled"[[:space:]]*:[[:space:]]*false' "$cfg"; then
    warn "主题库开关被你显式设为 false —— 尊重你的设置（可在设置里打开）"
  elif grep -q 'memoryTopicDbEnabled' "$cfg"; then
    ok ".config.json：保持已有 memoryTopicDbEnabled"
  elif [ "$JSON_TOOL" = "node" ]; then
    "$NODE_EXE" -e 'const fs=require("fs");const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,"utf8"));j.memoryTopicDbEnabled=true;fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n")' "$cfg" \
      && ok ".config.json：新增 memoryTopicDbEnabled=true" || warn ".config.json 解析失败，未修改"
  else
    warn "请在 $cfg 手工加 \"memoryTopicDbEnabled\": true"
  fi
}
if [ "$needs" = "1" ]; then
  if [ "$host_running" = "1" ]; then
    warn "DSH 正在运行且旧记忆未迁移 —— 先保持 md 模式（行为零变化），迁移完成后再开"
  else
    warn "旧记忆未迁移 —— 先保持 md 模式（写完能落 md），迁移完成后再开"
  fi
else
  write_flag
fi
if [ "$needs" = "1" ] && [ "$host_running" = "1" ]; then
  sect "登记迁移待办（重启 DSH 后自动执行）"
  pv="$(grep -oE 'const PLUGIN_VERSION = "[^"]+"' "$(plugin_dir_of "$PRIMARY")/index.js" 2>/dev/null | head -n1 | sed -E 's/.*"([^"]+)"/\1/')"
  if write_pending "${pv:-unknown}" "安装器安装：检测到 DSH 正在运行且旧记忆未迁移，登记为下次启动自动迁移"; then
    ok "已登记迁移：$(pending_path)"
    item "重启 DSH 后自动迁移（先快照；失败自动回退 md 模式，不影响使用）。"
  else
    warn "pending 标记写入失败（不算致命）；请完全退出 DSH 后手工执行迁移命令。"
  fi
fi

# ---- AGENTS.md ----
sect "[7/8] 处理 AGENTS.md（记忆协议模板）"
ag="$DSH_HOME/AGENTS.md"
tpl="$stage/AGENTS.template.md"
LEGACY_SHA_1="c7de0f75062511ac13321de6a321dab7f6aef89969d24eb31f55a1781c8a529e"
LEGACY_SHA_2="3ffc27938d118a5db6cbe3b48242ee30a17ee73694ea2349a2e5f246062c4365"
# v4 原模板（4.0.1 时代，无 memory_note）→ 4.5 升级时自动替换为含会话笔记的新模板
LEGACY_SHA_3="45463dd54b87c890bd7fd8e11a96a80ebeab96ffb597c77a93d8247d1d662e58"
# v4.5.0 模板（含 memory_note，但 memory_write 仍对主代理开放）→ 4.5.1 升级为「主代理只写 memory_note」
LEGACY_SHA_4="2de634f589f042f970826883368af374ff25f8159c94150996ff37222186b066"
sha_of_normalized() { # strip BOM/CR, trailing spaces, trailing blank lines -> sha256
  f="$1"; tmp0="$WORK/norm0.txt"; tmp="$WORK/norm.txt"
  bom="$(head -c 3 "$f" | od -An -tx1 | tr -d ' \n')"
  if [ "$bom" = "efbbbf" ]; then tail -c +4 "$f" > "$tmp0"; else cp "$f" "$tmp0"; fi
  sed -e 's/\r$//' -e 's/[[:space:]]*$//' "$tmp0" | awk '{lines[NR]=$0} END{last=NR; while(last>0 && lines[last]=="")last--; for(i=1;i<=last;i++)print lines[i]}' > "$tmp"
  sha256_of "$tmp"
}
if [ ! -f "$ag" ]; then
  cp -f "$tpl" "$ag" && ok "已写入 v4 记忆协议：$ag"
elif grep -q 'dsh-memory-agents-template: v4' "$ag"; then
  # [4.5] v4 协议分两代：4.0.1 时代的 v4 模板（无 memory_note）可安全升级到 4.5；
  #   用户改过的（sha 不在白名单）保留不动。**只按 sha 白名单判断**，避免误覆盖用户编辑。
  # [CRA M4 修复 2026-11-05] 第三种情况必须说清楚：是 v4 但既非旧模板也非最新（被改过）——
  #   原先把这种情况也打印「已是 v4 协议（跳过）」，属于谎报（实际拿不到 memory_note 协议）。
  h="$(sha_of_normalized "$ag")" || h=""
  tpl_h="$(sha_of_normalized "$tpl")" || tpl_h=""
  if [ -n "$tpl_h" ] && [ "$h" = "$tpl_h" ]; then
    ok "AGENTS.md 已是最新 v4.5.1 协议（主代理只写 memory_note）"
  elif [ "$h" = "$LEGACY_SHA_3" ] || [ "$h" = "$LEGACY_SHA_4" ]; then
    cp -f "$ag" "$ag.bak-$(date +%Y%m%d_%H%M%S)"
    cp -f "$tpl" "$ag" && ok "AGENTS.md 已升级为 v4.5.1（写入通道收紧为 memory_note，已备份）"
  else
    warn "AGENTS.md 是 v4 协议但非 4.5.1 模板（被改过）→ 保留不动；如需「主代理只写 memory_note」协议，请按 payload 内 AGENTS.template.md 手工合并"
  fi
else
  h="$(sha_of_normalized "$ag")" || h=""
  if [ "$h" = "$LEGACY_SHA_1" ] || [ "$h" = "$LEGACY_SHA_2" ]; then
    cp -f "$ag" "$ag.bak-$(date +%Y%m%d_%H%M%S)"
    cp -f "$tpl" "$ag" && ok "AGENTS.md 已从旧模板升级为 v4（已备份）"
  else
    warn "AGENTS.md 存在且被改过 —— 安装器不覆盖它（参考 $tpl 自行合并）"
  fi
fi

# ---- patch registration + junction ----
sect "[8/8] 注册 cordis.patch.yml"
block_pkg='# --- dsh-memory: global auto-memory plugin (installed by the dsh-memory installer) ---
- insert:
    - id: dsh-memory
      name: dsh-memory
      config:
        staleSessionDays: 5
        staleAction: remind'
block_path='# --- dsh-memory: global auto-memory plugin (installed by the dsh-memory installer) ---
- insert:
    - id: dsh-memory
      name: ./plugins/memory/index.js
      config:
        staleSessionDays: 5
        staleAction: remind'

ensure_junction() { # target plugin dir -> "ok" / "conflict" / "nodir"
  nm="$profiles_dir/node_modules"
  [ -d "$nm" ] || { printf 'nodir'; return; }
  link="$nm/dsh-memory"
  want="$(cd "$1" 2>/dev/null && pwd -P)"
  if [ -L "$link" ]; then
    have="$(cd "$link" 2>/dev/null && pwd -P)"
    if [ "$have" = "$want" ]; then printf 'ok'; return; fi
    rm -f "$link"; if ln -s "$1" "$link" 2>/dev/null; then printf 'ok'; else printf 'conflict'; fi
  elif [ -e "$link" ]; then
    printf 'conflict'
  else
    if ln -s "$1" "$link" 2>/dev/null; then printf 'ok'; else printf 'conflict'; fi
  fi
}

if [ "$multi" = "yes" ]; then
  jr="$(ensure_junction "$(plugin_dir_of "$PRIMARY")")"
  item "多 profile 模式：新注册用相对路径形式；junction（$jr）指向主 profile $PRIMARY"
fi

for n in $TARGETS; do
  p="$(patch_of "$n")"
  form="relative-path"
  block="$block_path"
  if [ "$multi" = "no" ]; then
    jr="$(ensure_junction "$(plugin_dir_of "$n")")"
    if [ "$jr" = "ok" ]; then form="package"; block="$block_pkg"; fi
    item "[$n] junction: $jr"
  fi
  if [ ! -f "$p" ]; then
    {
      printf '%s\n' '# Your patch layer for this dsh profile, applied after every bundle layer:' '# a top-level YAML array of loader patch entries (id-targeted config' '# overrides, disables, and insert lists; `!!js` expressions allowed.' ''
      printf '%s\n' "$block"
    } > "$p"
    ok "[$n] 已创建 $p 并注册 dsh-memory（$form）"
    continue
  fi
  if has_memory_registration "$p"; then
    ok "[$n] 已注册（跳过，无重复行）"
    continue
  fi
  tmp="$WORK/patch.tmp"
  grep -vE '^\[[[:space:]]*\]$' "$p" > "$tmp" || true
  if grep -vE '^([[:space:]]*$|[[:space:]]*#|^-([[:space:]]|$)|[[:space:]]+)' "$tmp" | grep -q .; then
    printf '%s\n' "$block" > "$p.dsh-memory-block.txt"
    warn "[$n] 未注册：$p 不是纯顶层块序列（文件未修改）；请手工把 $p.dsh-memory-block.txt 合并进去"
    continue
  fi
  cp -f "$p" "$p.bak-$(date +%Y%m%d_%H%M%S)"
  printf '\n' >> "$tmp"
  printf '%s\n' "$block" >> "$tmp"
  cat "$tmp" > "$p"
  ok "[$n] 已在 $p 注册 dsh-memory（$form）"
done

# [BUG-6] 设置界面半区单独注册（client 已装到 <plugins>/dsh-memory-client/）
client_block='# --- dsh-memory-client: settings UI half-zone (installed by the dsh-memory installer) ---
- insert:
  - id: dsh-memory-client
    name: ./plugins/dsh-memory-client/lib/index.js'
for n in $TARGETS; do
  pdir="$(plugin_dir_of "$n")"
  [ -f "$(dirname "$pdir")/dsh-memory-client/lib/index.js" ] || continue
  p="$(patch_of "$n")"
  if grep -qE '^[[:space:]]*-[[:space:]]*id:[[:space:]]*dsh-memory-client[[:space:]]*($|#)' "$p" 2>/dev/null; then
    ok "[$n] 已注册 dsh-memory-client（跳过）"
    continue
  fi
  cp -f "$p" "$p.bak-$(date +%Y%m%d_%H%M%S)" 2>/dev/null || true
  { printf '\n'; printf '%s\n' "$client_block"; } >> "$p"
  ok "[$n] 已注册 dsh-memory-client（设置界面半区）"
done

# ---- final report ----
sect "安装完成"
say "  发布版本：v$version"
say "  目标 profile：$TARGETS（$MODE_SRC）"
engines=""
if [ -f "$stage/package.json" ] && [ "$JSON_TOOL" = "node" ]; then
  engines="$("$NODE_EXE" -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((j.engines&&j.engines.dsh)||"")}catch(e){}' "$stage/package.json" 2>/dev/null || true)"
fi
host_v="$(dsh --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?' | head -n1 || true)"
[ -n "$host_v" ] && say "  宿主版本：$host_v${engines:+（engines.dsh $engines）}"
for n in $TARGETS; do
  v="$(grep -oE 'const PLUGIN_VERSION = "[^"]+"' "$(plugin_dir_of "$n")/index.js" 2>/dev/null | head -n1 | sed -E 's/.*"([^"]+)"/\1/')"
  has_reg="no"; has_memory_registration "$(patch_of "$n")" && has_reg="yes"
  say "  [$n] v${v:-?}  注册=$has_reg"
done
sect "下一步"
item "重启 DSH 才加载新插件。"
if [ "$needs" = "1" ]; then
  item "旧 md 记忆待迁移：DSH 运行中会先登记；完全退出 DSH 后执行："
  item "  bash $0 --migrate --yes --profile $PRIMARY"
fi
item "体检（只读）：bash $0 --check"
item "卸载：Windows 用 install.ps1 -Uninstall（本脚本暂不提供卸载）"
exit 0
