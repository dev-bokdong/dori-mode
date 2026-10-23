#!/usr/bin/env bash
# Installs the dori-mode skill and the `dori` CLI, then runs `dori setup`.
# Usage: bash -c "$(curl -fsSL https://raw.githubusercontent.com/dev-bokdong/dori-mode/main/install.sh)"
# Needs: git, bun 1.3+. Optional env: DORI_SRC (clone dir), SKILLS_DIR (where your agent loads skills).
set -euo pipefail

repo="https://github.com/dev-bokdong/dori-mode.git"
src="${DORI_SRC:-$HOME/.dori/src}"
skills="${SKILLS_DIR:-$HOME/.agents/skills}"

command -v bun >/dev/null || { echo "bun is required: https://bun.sh" >&2; exit 1; }
command -v git >/dev/null || { echo "git is required" >&2; exit 1; }

if [ -d "$src/.git" ]; then git -C "$src" pull --ff-only --quiet; else git clone --quiet --depth 1 "$repo" "$src"; fi

mkdir -p "$skills"
if [ -e "$skills/dori-mode" ] && [ ! -L "$skills/dori-mode" ]; then
  echo "$skills/dori-mode exists and is not a link; leaving it alone" >&2
else
  ln -sfn "$src/skills/dori-mode" "$skills/dori-mode"
fi

(cd "$src/skills/dori-mode/scripts" && bun install --silent && bun link --silent)

mkdir -p "$HOME/.dori"
dori="$(command -v dori || echo "$HOME/.bun/bin/dori")"

echo "Installed. Skill: $skills/dori-mode  CLI: $dori"
if [ -t 0 ]; then
  "$dori" setup
else
  echo "Next: run \`dori setup\` in a terminal (bot token, channels, herdr panes, autostart), then tell your agent: Dori mode"
fi
