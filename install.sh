#!/usr/bin/env bash
# dsh-memory installer for macOS / Linux
# One-line install:
#   curl -fsSL https://raw.githubusercontent.com/Starry0214/dsh-memory/main/install.sh | bash
# Options (env vars):
#   DSH_HOME       - DSH home dir (default: ~/.dsh)
#   DSH_PROFILE    - profile name (default: web)
#   DSH_MEMORY_RAW - raw file base URL (default: GitHub raw)
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
  echo "ERROR: profile '$PROFILE_NAME' not found. Available: $(ls "$DSH_HOME/profiles" 2>/dev/null | tr '\n' ', ')" >&2
  echo "Set DSH_PROFILE to one of them and retry." >&2
  exit 1
fi

# 3. Create plugin dir and download index.js
plugin_dir="$profile_dir/plugins/memory"
mkdir -p "$plugin_dir"
target="$plugin_dir/index.js"

echo "Downloading index.js ..."
if ! curl -fsSL --connect-timeout 30 "$RAW_BASE/index.js" -o "$target" 2>/dev/null; then
  echo "GitHub raw failed, trying jsDelivr CDN ..."
  if ! curl -fsSL --connect-timeout 30 "https://cdn.jsdelivr.net/gh/Starry0214/dsh-memory@main/index.js" -o "$target" 2>/dev/null; then
    echo "ERROR: failed to download index.js. Check your network / proxy." >&2
    exit 1
  fi
fi
echo "  OK: $target"

# 4. Register plugin in cordis.patch.yml (idempotent)
patch_file="$profile_dir/cordis.patch.yml"

if [ ! -f "$patch_file" ]; then
  cat > "$patch_file" <<'EOF'
# --- dsh-memory: global auto-memory plugin (installed by dsh-memory installer) ---
- insert:
    - id: dsh-memory
      name: ./plugins/memory/index.js
      config: {}
EOF
  echo "Created $patch_file with dsh-memory registration."
elif grep -q 'id:[[:space:]]*dsh-memory' "$patch_file"; then
  echo "dsh-memory already registered in $patch_file (skipped)."
else
  cp "$patch_file" "$patch_file.bak"
  cat >> "$patch_file" <<'EOF'

# --- dsh-memory: global auto-memory plugin (installed by dsh-memory installer) ---
- insert:
    - id: dsh-memory
      name: ./plugins/memory/index.js
      config: {}
EOF
  echo "Appended dsh-memory registration to $patch_file (backup at $patch_file.bak)."
fi

# 5. Verify
if [ ! -f "$target" ]; then
  echo "ERROR: index.js missing after install." >&2
  exit 1
fi
bytes=$(wc -c < "$target" | tr -d ' ')
echo ""
echo "dsh-memory installed successfully (index.js: $bytes bytes)."
echo ""
echo "Next step: restart DSH. On startup you should see:"
echo "  [dsh-memory] memory_search tool registered (ctx.tools)"
echo "  [dsh-memory] injected stable layer (N sections)"
