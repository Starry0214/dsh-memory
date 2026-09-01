#!/usr/bin/env bash
# dsh-memory installer for macOS / Linux (and Git Bash on Windows)
#
# One-line install:
#   curl -fsSL https://raw.githubusercontent.com/Starry0214/dsh-memory/main/install.sh | bash
#
# Options (env vars):
#   DSH_HOME          - DSH home dir (default: $HOME/.dsh)
#   DSH_PROFILE       - profile name (default: web)
#   DSH_MEMORY_RAW    - raw file base URL (default: GitHub raw)
#   DSH_MEMORY_LOCAL  - path to a local index.js to install instead of downloading
#
# First run: the plugin checks the memory library; if empty, it walks the user through
# initialization inside the first DSH session. /memory-init, /memory-update available.
#
# v2 (2026-08-28): cordis.patch.yml registration rewritten (see install.ps1 for details)
#                 + memory-library seeding + version echo.
set -e

RAW_BASE="${DSH_MEMORY_RAW:-https://raw.githubusercontent.com/Starry0214/dsh-memory/main}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_NAME="${DSH_PROFILE:-web}"

echo "dsh-memory installer"
echo "  DSH_HOME : $DSH_HOME"
echo "  profile  : $PROFILE_NAME"
echo ""

# 1. Validate DSH home
if [ ! -d "$DSH_HOME/profiles" ]; then
  echo "ERROR: no profiles directory found under $DSH_HOME" >&2
  echo "Make sure DSH is installed and DSH_HOME points to the right place." >&2
  exit 1
fi

# 2. Validate profile
profile_dir="$DSH_HOME/profiles/$PROFILE_NAME"
if [ ! -d "$profile_dir" ]; then
  echo "ERROR: profile '$PROFILE_NAME' not found. Available: $(ls "$DSH_HOME/profiles" 2>/dev/null | tr '\n' ',')" >&2
  echo "Set DSH_PROFILE to one of them and retry." >&2
  exit 1
fi

# 3. Create plugin dir and fetch index.js
plugin_dir="$profile_dir/plugins/memory"
mkdir -p "$plugin_dir"
target="$plugin_dir/index.js"

if [ -n "${DSH_MEMORY_LOCAL:-}" ]; then
  if [ ! -f "$DSH_MEMORY_LOCAL" ]; then
    echo "ERROR: DSH_MEMORY_LOCAL is set but is not a readable file: $DSH_MEMORY_LOCAL" >&2
    exit 1
  fi
  echo "Copying index.js from $DSH_MEMORY_LOCAL ..."
  cp -f "$DSH_MEMORY_LOCAL" "$target"
else
  echo "Downloading index.js ..."
  if ! curl -fsSL --connect-timeout 30 "$RAW_BASE/index.js" -o "$target" 2>/dev/null; then
    echo "GitHub raw failed, trying jsDelivr CDN ..."
    if ! curl -fsSL --connect-timeout 30 "https://cdn.jsdelivr.net/gh/Starry0214/dsh-memory@main/index.js" -o "$target" 2>/dev/null; then
      echo "ERROR: failed to download index.js. Check your network / proxy, or pre-copy the file and set DSH_MEMORY_LOCAL to it." >&2
      exit 1
    fi
  fi
fi
echo "  OK: $target"

# 3.5 Seed the memory library (never overwrites user files):
#     skeleton dirs + the read/write protocol AGENTS.md + empty global/index placeholders.
mem_root="$DSH_HOME/memory"
for sub in "" sessions projects tools knowledge; do
  mkdir -p "$mem_root/$sub"
done
agents_target="$DSH_HOME/AGENTS.md"
if [ ! -f "$agents_target" ]; then
  cat > "$agents_target" <<'AGENTS_TEMPLATE'
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

AGENTS_TEMPLATE
  echo "Wrote the memory protocol to $agents_target (from the embedded template)."
else
  echo "Kept your existing $agents_target (the installer never overwrites it)."
fi
for f in global.md index.md; do
  fp="$mem_root/$f"
  if [ ! -f "$fp" ]; then
    if [ "$f" = "global.md" ]; then echo "# 全局记忆" > "$fp"; else echo "# 记忆索引" > "$fp"; fi
    echo "Created empty $fp (your first session will fill it in)."
  fi
done

# 4. Register the plugin in cordis.patch.yml (shape-aware, idempotent)
patch_file="$profile_dir/cordis.patch.yml"

# 4.0 [2026-09-01 标准对齐] 包名加载前置：建 profiles/node_modules/dsh-memory 符号链接 → <profile>/plugins/memory。
#     包名 registration（name: dsh-memory）要求该名可被 ESM 解析；符号链接指向带依赖链的真实源码目录。
#     profile 结构形如 ~/.dsh/profiles/{web,headless,...}，node_modules 在 profiles 根级。
nm_target="$DSH_HOME/profiles/node_modules"
have_nm="no"
if [ -d "$nm_target" ]; then
  have_nm="yes"
  nm_link="$nm_target/dsh-memory"
  if [ "$(readlink "$nm_link" 2>/dev/null)" = "$plugin_dir" ]; then
    echo "  dsh-memory symlink already points at $plugin_dir (skipped)."
  else
    rm -rf "$nm_link"
    ln -s "$plugin_dir" "$nm_link"
    echo "  created dsh-memory symlink -> $plugin_dir"
  fi
fi

# 默认注册块用包名（官方显示名标准）：包名 → 插件清单显示 "memory"（moduleShortName 剥 dsh- 前缀）；
# 路径 → 显示 file:// 长路径。node_modules 缺失时降级路径块保证可用性。
if [ "$have_nm" = "yes" ]; then
  block_file=$(mktemp)
  cat > "$block_file" <<'BLOCK'
# --- dsh-memory: global auto-memory plugin (installed by the dsh-memory installer) ---
- insert:
    - id: dsh-memory
      name: dsh-memory
      config:
        staleSessionDays: 5
        staleAction: remind
BLOCK
else
  echo "WARNING: $nm_target not found - package-name registration will fail to resolve dsh-memory; registering the path form instead."
  block_file=$(mktemp)
  cat > "$block_file" <<'BLOCK'
# --- dsh-memory: global auto-memory plugin (installed by the dsh-memory installer) ---
- insert:
    - id: dsh-memory
      name: ./plugins/memory/index.js
      config:
        staleSessionDays: 5
        staleAction: remind
BLOCK
fi

# Rewrite $1 into $2, dropping column-0 "[]" lines; append the block when $3 is "append".
apply_merge() {
  grep -vE '^\[[[:space:]]*\]$' "$1" > "$2" || true
  if [ "$3" = "append" ]; then
    printf '\n' >> "$2"
    cat "$block_file" >> "$2"
  fi
}

if [ ! -f "$patch_file" ]; then
  {
    printf '%s\n' \
      '# Your patch layer for this dsh profile, applied after every bundle layer:' \
      '# a top-level YAML array of loader patch entries (id-targeted config' \
      '# overrides, disables, and insert lists; `!!js` expressions allowed.' ''
    cat "$block_file"
  } > "$patch_file"
  echo "Created $patch_file and registered dsh-memory."
else
  code_lines=$(grep -cvE '^([[:space:]]*$|[[:space:]]*#)' "$patch_file" || true)
  empty_lines=$(grep -cE '^\[[[:space:]]*\]$' "$patch_file" || true)
  entry_lines=$(grep -cE '^-([[:space:]]|$)' "$patch_file" || true)
  foreign_lines=$(grep -vE '^([[:space:]]*$|[[:space:]]*#|^-([[:space:]]|$)|[[:space:]]+)' "$patch_file" | grep -cvE '^\[[[:space:]]*\]$' || true)
  registered=$(grep -cE '^[[:space:]]*-[[:space:]]*id:[[:space:]]*dsh-memory[[:space:]]*(#.*)?$' "$patch_file" || true)
  tmp_file=$(mktemp)

  if [ "$foreign_lines" -gt 0 ]; then
    cat "$block_file" > "$patch_file.dsh-memory-block.txt"
    rm -f "$block_file" "$tmp_file"
    echo "WARNING: dsh-memory was NOT registered - $patch_file is not a top-level block sequence" >&2
    echo "  (mapping, non-empty flow list, tab indentation or a second document?)." >&2
    echo "  The file was NOT modified. Merge the entries saved in" >&2
    echo "  $patch_file.dsh-memory-block.txt into it by hand as further '- insert:' items at column 0." >&2
    exit 1
  elif [ "$registered" -gt 0 ]; then
    if [ "$empty_lines" -gt 0 ] && [ "$entry_lines" -gt 0 ]; then
      cp "$patch_file" "$patch_file.bak"
      apply_merge "$patch_file" "$tmp_file" keep
      cat "$tmp_file" > "$patch_file"
      echo "Repaired $patch_file (dropped the stray '[]' line(s) an older installer left beside real entries)."
      echo "  backup: $patch_file.bak"
    else
      echo "dsh-memory already registered in $patch_file (skipped)."
    fi
  else
    cp "$patch_file" "$patch_file.bak"
    apply_merge "$patch_file" "$tmp_file" append
    cat "$tmp_file" > "$patch_file"
    if [ "$code_lines" -le "$empty_lines" ]; then
      echo "Registered dsh-memory in $patch_file (replaced the empty '[]' document, or filled a comments-only one)."
    else
      echo "Appended the dsh-memory registration to $patch_file."
    fi
    echo "  backup: $patch_file.bak"
  fi
  rm -f "$tmp_file" "$block_file"
fi

# 5. Verify + report
if [ ! -f "$target" ]; then
  echo "ERROR: index.js missing after install." >&2
  exit 1
fi
bytes=$(wc -c < "$target" | tr -d ' ')
installed_v=$(grep -oE 'const PLUGIN_VERSION = "[^"]+"' "$target" | head -n1 | sed -E 's/.*"([^"]+)"/\1/')
remote_v=$(curl -fsSL --connect-timeout 10 "$RAW_BASE/version.txt" 2>/dev/null | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n1 || true)
echo ""
if [ -n "$installed_v" ]; then
  echo "dsh-memory installed successfully (v$installed_v, index.js $bytes bytes)."
else
  echo "dsh-memory installed successfully (index.js $bytes bytes)."
fi
if [ -n "$remote_v" ]; then
  if [ "$remote_v" = "$installed_v" ]; then echo "  published : v$remote_v (up to date)"; else echo "  published : v$remote_v (newer version published; re-run this installer to upgrade)"; fi
else
  echo "  published : unknown (offline?)"
fi
echo ""
echo "Next step: restart DSH. First-run experience:"
echo "  - the plugin checks the memory library; if empty, guides you through initialization"
echo "    inside the first session (about 1 minute; also /memory-init)"
echo "  - /memory-update checks the version; Settings -> General -> Memory shows both"
