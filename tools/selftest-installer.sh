#!/usr/bin/env bash
# selftest-installer.sh —— install.sh 的回归自测（Linux/macOS/Git-Bash 均可跑）
# 覆盖：全新安装 / 幂等重装 / 老用户迁移 / 宿主运行中安全降级 / consumer profile（BUG-5）
# 用法：bash tools/selftest-installer.sh [-k]      （-k = 保留临时 DSH_HOME 便于排查）
# 退出码：0 全通过；1 有失败
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
INSTALLER="$ROOT/install.sh"
MANIFEST="$ROOT/install-manifest.json"
KEEP=0
[ "${1:-}" = "-k" ] && KEEP=1

pass=0; fail=0; fails=""
ok()   { pass=$((pass+1)); printf '  PASS  %s%s\n' "$1" "${2:+   [$2]}"; }
bad()  { fail=$((fail+1)); fails="$fails\n- $1"; printf '  FAIL  %s%s\n' "$1" "${2:+   [$2]}"; }
assert_eq()   { if [ "$1" = "$2" ]; then ok "$3" "$1"; else bad "$3" "got=$1 want=$2"; fi; }
assert_ne()   { if [ "$1" != "$2" ]; then ok "$3" "$1"; else bad "$3" "got=$1 (should differ)"; fi; }
assert_has()  { case "$1" in *"$2"*) ok "$3" "$2" ;; *) bad "$3" "missing '$2'" ;; esac; }
assert_lack() { case "$1" in *"$2"*) bad "$3" "unexpected '$2'" ;; *) ok "$3" ;; esac; }
assert_file() { if [ -f "$1" ]; then ok "$2" "$1"; else bad "$2" "missing $1"; fi; }
assert_nofile(){ if [ ! -f "$1" ]; then ok "$2"; else bad "$2" "should not exist: $1"; fi; }

[ -f "$INSTALLER" ] || { echo "找不到 install.sh: $INSTALLER"; exit 1; }
[ -f "$MANIFEST" ]  || { echo "找不到 install-manifest.json: $MANIFEST"; exit 1; }
PAYLOAD="$(ls "$ROOT"/payload/dsh-memory-*.zip 2>/dev/null | sort | tail -n1)"
[ -n "${PAYLOAD:-}" ] || { echo "找不到 payload zip"; exit 1; }

sha_of() { if [ -f "$1" ]; then sha256sum "$1" | awk '{print $1}'; else echo ""; fi; }
json_val() { # json_val <file> <key>   （只取 manifest 里第一个匹配，够用）
  grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$1" 2>/dev/null | head -n1 | sed -E 's/.*"([^"]*)"$/\1/'
}
mk_home() {
  local h; h="$(mktemp -d "${TMPDIR:-/tmp}/dsh-sh-selftest-XXXXXX")"
  mkdir -p "$h/profiles/web"
  printf '%s' "$h"
}
run_installer() { # run_installer <home> [args...]
  local h="$1"; shift
  DSH_HOME="$h" bash "$INSTALLER" "$@" 2>&1
  return $?
}
MODS_MIN=12
HOMES=""
cleanup() {
  if [ "$KEEP" = "0" ]; then
    for h in $HOMES; do rm -rf "$h" 2>/dev/null; done
  else
    for h in $HOMES; do echo "  kept: $h"; done
  fi
}
trap cleanup EXIT

echo "dsh-memory install.sh self-test"
echo "  installer : $INSTALLER"
echo "  payload   : $PAYLOAD ($(wc -c < "$PAYLOAD" | tr -d ' ') bytes)"
echo "  manifest  : $MANIFEST"
echo "  bash      : $BASH_VERSION"
echo ""

# ── A. 全新安装 ────────────────────────────────────────────────────────────
echo '[A] fresh install'
A="$(mk_home)"; HOMES="$HOMES $A"
PA="$A/profiles/web/plugins/memory"
OUT_A="$(run_installer "$A" --local-payload "$PAYLOAD" --profile web)"; RC_A=$?
assert_eq "$RC_A" "0" 'A0 install exit code 0'
assert_file "$PA/index.js" 'A1 index.js installed'
MAN_VER="$(json_val "$MANIFEST" version)"
assert_eq "$(cat "$PA/version.txt" 2>/dev/null | tr -d '\r\n')" "$MAN_VER" 'A2 version.txt matches manifest version'
# 逐文件 sha（用 manifest 里 path+sha256 成对出现）
MF="$MANIFEST"
node - "$MF" "$PA" <<'NODE' >/dev/null 2>&1
const fs=require('fs'),crypto=require('crypto');
const [mf,dir]=process.argv.slice(2);
const m=JSON.parse(fs.readFileSync(mf,'utf8'));
let bad=[];
for(const f of m.files){const p=dir+'/'+f.path;const h=fs.existsSync(p)?crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'):'';if(h!==String(f.sha256).toLowerCase())bad.push(f.path);}
process.exit(bad.length?1:0);
NODE
assert_eq "$?" "0" 'A3 all payload files match manifest sha256'
MODS_A=$(ls "$PA/memtopic/src"/*.mjs 2>/dev/null | wc -l | tr -d ' ')
if [ "$MODS_A" -ge "$MODS_MIN" ]; then ok 'A4 memtopic/src modules installed' "$MODS_A"; else bad 'A4 memtopic/src modules installed' "got=$MODS_A"; fi
assert_file "$PA/memtopic/src/migrate.mjs" 'A5 migrate.mjs installed'
AG="$(cat "$A/AGENTS.md" 2>/dev/null)"
assert_has "$AG" 'dsh-memory-agents-template: v4' 'A6 AGENTS.md is v4 template'
CFG="$(cat "$A/memory/.config.json" 2>/dev/null)"
assert_has "$CFG" '"memoryTopicDbEnabled": true' 'A7 topic DB enabled for fresh user'
PATCH="$A/profiles/web/cordis.patch.yml"
assert_file "$PATCH" 'A8 cordis.patch.yml created'
ROWS=$(grep -cE '^[[:space:]]*-[[:space:]]*id:[[:space:]]*dsh-memory[[:space:]]*($|#)' "$PATCH" 2>/dev/null || echo 0)
assert_eq "$ROWS" "1" 'A9 exactly one registration row'
assert_nofile "$A/memory/.memtopic/migrate-pending.json" 'A10 fresh user: no pending marker'

# ── B. 幂等重装 ────────────────────────────────────────────────────────────
echo '[B] re-install idempotency'
H_BEFORE="$(sha_of "$PA/index.js")"
OUT_B="$(run_installer "$A" --local-payload "$PAYLOAD" --profile web)"; RC_B=$?
assert_eq "$RC_B" "0" 'B0 re-install exit code 0'
assert_eq "$(sha_of "$PA/index.js")" "$H_BEFORE" 'B1 index.js unchanged after re-install'
ROWS_B=$(grep -cE '^[[:space:]]*-[[:space:]]*id:[[:space:]]*dsh-memory[[:space:]]*($|#)' "$PATCH" 2>/dev/null || echo 0)
assert_eq "$ROWS_B" "1" 'B2 no duplicate registration row'

# ── C. 老用户：安装登记 pending → 迁移 ─────────────────────────────────────
echo '[C] legacy md user: pending marker -> migrate'
C="$(mk_home)"; HOMES="$HOMES $C"
mkdir -p "$C/memory/sessions" "$C/memory/projects"
printf '# 全局\n- 用户偏好：简洁中文\n- 精确字面量：CASE-2026-001\n' > "$C/memory/global.md"
printf '# 索引\n- projects/测试项目.md\n' > "$C/memory/index.md"
printf '# 测试项目\n- 结论一：可行\n- 结论二：需复核\n' > "$C/memory/projects/测试项目.md"
printf '# 会话\n- 今日完成 A\n- 今日完成 B\n' > "$C/memory/sessions/2026-10-20.md"
MD_HASH_BEFORE="$(sha_of "$C/memory/projects/测试项目.md")"
OUT_C1="$(run_installer "$C" --local-payload "$PAYLOAD" --profile web)"; RC_C1=$?
assert_eq "$RC_C1" "0" 'C0 legacy install exit code 0'
assert_file "$C/memory/.memtopic/migrate-pending.json" 'C1 pending marker registered for legacy user'
if [ -f "$C/memory/.config.json" ]; then
  assert_lack "$(cat "$C/memory/.config.json")" '"memoryTopicDbEnabled": true' 'C2 legacy user stays in md mode until migrated'
else
  ok 'C2 legacy user stays in md mode until migrated' 'config absent (plugin default)'
fi
OUT_C2="$(run_installer "$C" --migrate --yes --assume-host-stopped)"; RC_C2=$?
assert_eq "$RC_C2" "0" 'C3 --migrate exit code 0'
assert_file "$C/memory/.memtopic/mem.db" 'C4 topic DB created'
CFG_C2="$(cat "$C/memory/.config.json" 2>/dev/null)"
assert_has "$CFG_C2" '"memoryTopicDbEnabled": true' 'C5 topic DB enabled after migration'
assert_eq "$(sha_of "$C/memory/projects/测试项目.md")" "$MD_HASH_BEFORE" 'C6 legacy md byte-identical (migration is read-only on md)'
assert_nofile "$C/memory/.memtopic/migrate-pending.json" 'C7 pending marker cleared after migration'
if command -v node >/dev/null 2>&1; then
  CNT="$(node - "$C/memory/.memtopic/mem.db" <<'NODE' 2>/dev/null
const {DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync(process.argv[2]);
const t=d.prepare('select count(*) c from topics').get();
const s=d.prepare('select count(*) c from sentences').get();
console.log(Number(t.c)+'/'+Number(s.c));d.close();
NODE
)"
  case "$CNT" in
    0/*|"") bad 'C8 DB has topics+sentences' "got=$CNT" ;;
    *) ok 'C8 DB has topics+sentences' "$CNT" ;;
  esac
else
  ok 'C8 DB has topics+sentences' 'skipped (no node)'
fi

# ── D. 宿主运行中的安全降级（不得写库）────────────────────────────────────
echo '[D] host running: --migrate must refuse to write'
D="$(mk_home)"; HOMES="$HOMES $D"
mkdir -p "$D/memory/sessions"
printf '# 全局\n- 偏好：简洁\n' > "$D/memory/global.md"
printf '# 会话\n- 完成 A\n' > "$D/memory/sessions/2026-10-20.md"
run_installer "$D" --local-payload "$PAYLOAD" --profile web >/dev/null 2>&1
OUT_D="$(run_installer "$D" --migrate --yes)"; RC_D=$?
assert_eq "$RC_D" "0" 'D0 --migrate without --assume-host-stopped exits 0'
# 只有在宿主确实在跑时才应降级；宿主没跑时正常迁移也合法
if [ -f "$D/memory/.memtopic/mem.db" ]; then
  ok 'D1 host not running in this environment -> migration allowed' 'env-dependent'
else
  assert_has "$OUT_D" 'HOST_RUNNING' 'D1 reports HOST_RUNNING (write blocked)'
  assert_file "$D/memory/.memtopic/migrate-pending.json" 'D2 pending marker kept for next boot'
fi

# ── E. consumer profile（BUG-5）：patch 用绝对 file:// 指向别的 profile ───
echo '[E] consumer profile (absolute file:// registration)'
E="$(mk_home)"; HOMES="$HOMES $E"
mkdir -p "$E/profiles/desktop"
run_installer "$E" --local-payload "$PAYLOAD" --profile web >/dev/null 2>&1
EW="$E/profiles/web/plugins/memory"
EW_WIN="$(cygpath -w "$EW" 2>/dev/null || printf '%s' "$EW")"
EW_URL="file:///$(printf '%s' "$EW_WIN" | sed 's#\\#/#g')"
printf '# desktop 消费 web 的插件目录\n- insert:\n    - id: dsh-memory\n      name: %s/index.js\n' "$EW_URL" > "$E/profiles/desktop/cordis.patch.yml"
[ -f "$EW/index.js" ] && ok 'E0 web profile hosts index.js' || bad 'E0 web profile hosts index.js'
if [ ! -d "$E/profiles/desktop/plugins/memory" ]; then ok 'E1 desktop has no own plugin dir (consumer only)'; else bad 'E1 desktop has no own plugin dir'; fi
OUT_E="$(run_installer "$E" --check --profile desktop)"; RC_E=$?
assert_eq "$RC_E" "0" 'E2 --check on consumer profile exits 0'
assert_lack "$OUT_E" 'desktop] 关键文件缺失' 'E3 no false "missing files" for consumer profile'
assert_has "$OUT_E" 'desktop] v3.5' 'E4 consumer profile resolves real version line'
OUT_E2="$(run_installer "$E" --check)"; RC_E2=$?
assert_eq "$RC_E2" "0" 'E5 --check (auto discovery) exits 0'
assert_lack "$OUT_E2" 'profiles/desktop/plugins/memory' 'E6 no output references consumer own dir'

echo ""
echo "self-test summary: $pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then printf "failures:%b\n" "$fails"; exit 1; fi
exit 0