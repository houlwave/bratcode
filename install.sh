#!/usr/bin/env bash
# bratcode installer:  curl -fsSL https://raw.githubusercontent.com/houlwave/bratcode/main/install.sh | bash
set -euo pipefail

REPO="${BRATCODE_REPO:-https://github.com/houlwave/bratcode.git}"
TARBALL="${BRATCODE_TARBALL:-https://codeload.github.com/houlwave/bratcode/tar.gz/refs/heads/main}"
DIR="${BRATCODE_HOME:-$HOME/.bratcode}"
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
  ok "bratcode removed. it was fun."
  exit 0
fi

printf '\n  %s%sbratcode%s %sinstaller%s\n\n' "$G" "$B" "$R" "$D" "$R"

command -v node >/dev/null 2>&1 || die "node is missing. install node 18+ first: https://nodejs.org (or: brew install node)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "node $NODE_MAJOR is too old, need 18+."
ok "node $(node -v)"

if command -v git >/dev/null 2>&1 && { [ -d "$DIR/.git" ] || [ ! -e "$DIR" ]; }; then
  if [ -d "$DIR/.git" ]; then
    git -C "$DIR" fetch --depth 1 origin main -q && git -C "$DIR" reset --hard FETCH_HEAD -q
    ok "updated"
  else
    git clone --depth 1 -q "$REPO" "$DIR" || die "could not clone $REPO"
    ok "downloaded"
  fi
else
  command -v curl >/dev/null 2>&1 || die "need git or curl."
  rm -rf "$DIR"; mkdir -p "$DIR"
  curl -fsSL "$TARBALL" | tar -xz --strip-components=1 -C "$DIR" || die "download failed"
  ok "downloaded"
fi

mkdir -p "$BIN"
ln -sf "$DIR/bin/bratcode.js" "$BIN/bratcode"
chmod +x "$DIR/bin/bratcode.js"
ok "linked $BIN/bratcode"

# make sure ~/.local/bin is on PATH
case ":$PATH:" in
  *":$BIN:"*) ONPATH=1 ;;
  *) ONPATH=0 ;;
esac
if [ "$ONPATH" = 0 ]; then
  LINE="export PATH=\"$BIN:\$PATH\""
  for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
    [ -f "$rc" ] || { [ "$rc" = "$HOME/.zshrc" ] && [ "${SHELL##*/}" = "zsh" ]; } || continue
    grep -qsF "$BIN" "$rc" || printf '\n# bratcode\n%s\n' "$LINE" >> "$rc"
  done
  ok "added $BIN to PATH"
fi

printf '\n  %s%sdone.%s now run:\n\n      %s%sbratcode%s\n\n' "$G" "$B" "$R" "$G" "$B" "$R"
if [ "$ONPATH" = 0 ]; then
  say "${D}(open a new terminal tab first, so the PATH update kicks in)${R}"
  printf '\n'
fi
