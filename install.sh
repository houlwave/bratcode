#!/usr/bin/env bash
# bratcode installer (macOS / Linux):
#   curl -fsSL https://raw.githubusercontent.com/houlwave/bratcode/main/install.sh | bash
set -euo pipefail

REPO="${BRATCODE_REPO:-https://github.com/houlwave/bratcode.git}"
TARBALL="${BRATCODE_TARBALL:-https://codeload.github.com/houlwave/bratcode/tar.gz/refs/heads/main}"
DIR="${BRATCODE_HOME:-$HOME/.bratcode}"
DATA_DIR="${BRATCODE_DATA:-$HOME/.bratcode-data}"
BIN="${BRATCODE_BIN:-$HOME/.local/bin}"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  G=$'\033[38;2;138;206;0m'; B=$'\033[1m'; D=$'\033[2m'; R=$'\033[0m'; RED=$'\033[38;2;255;79;163m'
else
  G=""; B=""; D=""; R=""; RED=""
fi
say()  { printf '  %s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$G$B" "$R" "$*"; }
die()  { printf '  %s✗%s %s\n' "$RED$B" "$R" "$*" >&2; exit 1; }

if [ "${1:-}" = "--uninstall" ]; then
  rm -rf "$DIR" "$BIN/bratcode"
  ok "bratcode removed (sessions in $DATA_DIR preserved)."
  exit 0
fi

printf '\n  %s%sbratcode%s %sinstaller%s\n\n' "$G" "$B" "$R" "$D" "$R"

# enrich PATH for macOS Homebrew (Apple Silicon & Intel)
export PATH="/opt/homebrew/bin:/usr/local/bin:$BIN:$PATH"

command -v node >/dev/null 2>&1 || die "node is missing. install node 18+ first: brew install node  (or https://nodejs.org)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "node $NODE_MAJOR is too old, need 18+."
ok "node $(node -v)"

if command -v git >/dev/null 2>&1 && { [ -d "$DIR/.git" ] || [ ! -e "$DIR" ]; }; then
  if [ -d "$DIR/.git" ]; then
    git -C "$DIR" fetch --depth 1 origin main -q && git -C "$DIR" reset --hard FETCH_HEAD -q
    ok "updated source"
  else
    git clone --depth 1 -q "$REPO" "$DIR" || die "could not clone $REPO"
    ok "downloaded source"
  fi
else
  command -v curl >/dev/null 2>&1 || die "need git or curl."
  rm -rf "$DIR"; mkdir -p "$DIR"
  curl -fsSL "$TARBALL" | tar -xz --strip-components=1 -C "$DIR" || die "download failed"
  ok "downloaded source"
fi

mkdir -p "$DATA_DIR" "$DATA_DIR/bin" "$BIN"
chmod 700 "$DATA_DIR" 2>/dev/null || true

# install npm dependencies quietly
say "${D}installing agent runtime...${R}"
(cd "$DIR" && npm install --omit=dev --no-audit --no-fund --loglevel=error) || die "npm install failed"
ok "agent runtime ready"

# ensure browser for invisible session / look (uses system Chrome/Brave/Chromium if installed, else downloads lightweight shell)
HAS_CHROME="$(node -e '
const fs = require("fs");
const paths = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"
];
console.log(paths.find(p => fs.existsSync(p)) ? "1" : "0");
')"
if [ "$HAS_CHROME" = "0" ]; then
  say "${D}downloading headless chromium...${R}"
  PLAYWRIGHT_BROWSERS_PATH="$DATA_DIR/browsers" npx --prefix "$DIR" playwright-core install chromium-headless-shell >/dev/null 2>&1 || true
fi
ok "headless browser ready"

# install cloudflared binary silently into ~/.bratcode-data/bin if missing
if ! command -v cloudflared >/dev/null 2>&1 && [ ! -x "$DATA_DIR/bin/cloudflared" ]; then
  OS_NAME="$(uname -s)"
  ARCH_NAME="$(uname -m)"
  if [ "$OS_NAME" = "Darwin" ]; then
    if [ "$ARCH_NAME" = "arm64" ]; then
      CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz"
    else
      CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz"
    fi
    if curl -fsSL "$CF_URL" | tar -xz -C "$DATA_DIR/bin" 2>/dev/null; then
      chmod +x "$DATA_DIR/bin/cloudflared"
    fi
  elif [ "$OS_NAME" = "Linux" ]; then
    if [ "$ARCH_NAME" = "aarch64" ] || [ "$ARCH_NAME" = "arm64" ]; then
      CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64"
    else
      CF_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
    fi
    if curl -fsSL "$CF_URL" -o "$DATA_DIR/bin/cloudflared" 2>/dev/null; then
      chmod +x "$DATA_DIR/bin/cloudflared"
    fi
  fi
fi
if command -v cloudflared >/dev/null 2>&1 || [ -x "$DATA_DIR/bin/cloudflared" ]; then
  ok "invisible tunnel ready"
fi

ln -sf "$DIR/bin/bratcode.js" "$BIN/bratcode"
chmod +x "$DIR/bin/bratcode.js"
ok "linked $BIN/bratcode"

ORIG_HAS=0
for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
  if [ -f "$rc" ] && grep -qsF "$BIN" "$rc"; then ORIG_HAS=1; fi
done
if [ "$ORIG_HAS" = 0 ]; then
  LINE="export PATH=\"$BIN:\$PATH\""
  TOUCHED=0
  for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
    if [ -f "$rc" ] || { [ "$rc" = "$HOME/.zshrc" ] && [ "${SHELL##*/}" = "zsh" ]; }; then
      grep -qsF "$BIN" "$rc" 2>/dev/null || printf '\n# bratcode\n%s\n' "$LINE" >> "$rc"
      TOUCHED=1
    fi
  done
  [ "$TOUCHED" = 1 ] && ok "added $BIN to PATH"
fi

printf '\n  %s%sdone.%s now run:\n\n      %s%sbratcode%s\n\n' "$G" "$B" "$R" "$G" "$B" "$R"
