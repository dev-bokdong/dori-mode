#!/usr/bin/env bash
# Runs before `dori supervise` (systemd ExecStartPre). Rendered by `dori setup`.
# Waits for the herdr server, then makes sure the lead pane and the lanes
# workspace named in $DORI_CONFIG exist. If a reboot renumbered or dropped
# them, it creates them and rewrites the config. Idempotent.
set -euo pipefail

cfg="${DORI_CONFIG:-{{CONFIG}}}"

for _ in $(seq 1 60); do
  herdr workspace list >/dev/null 2>&1 && break
  sleep 2
done
herdr workspace list >/dev/null 2>&1 || { echo "BOOT_PREP herdr server not reachable" >&2; exit 1; }

set_cfg() {
  local filter="$1"; shift
  local tmp
  tmp="$(mktemp "${cfg}.XXXXXX")"
  jq "$@" "$filter" "$cfg" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$cfg"
}

workspace_by_label() {
  herdr workspace list | jq -r --arg l "$1" '.result.workspaces[] | select(.label == $l) | .workspace_id' | head -1
}

ensure_workspace() {
  local id
  id="$(workspace_by_label "$1")"
  if [ -z "$id" ]; then
    herdr workspace create --label "$1" --no-focus >/dev/null
    id="$(workspace_by_label "$1")"
  fi
  [ -n "$id" ] || { echo "BOOT_PREP cannot create workspace $1" >&2; exit 1; }
  printf '%s\n' "$id"
}

lead_cwd="$(jq -r '.defaultCwd // empty' "$cfg")"
case "$lead_cwd" in
  ""|"~") lead_cwd="$HOME" ;;
  "~/"*) lead_cwd="$HOME/${lead_cwd#"~/"}" ;;
esac

lead="$(jq -r '.leadPane // empty' "$cfg")"
if [ -n "$lead" ] && herdr pane get "$lead" >/dev/null 2>&1; then
  echo "BOOT_PREP lead pane $lead present"
else
  ws="$(ensure_workspace Dori)"
  pane="$(herdr tab create --workspace "$ws" --cwd "$lead_cwd" --label dori-lead --no-focus | jq -r '.result.root_pane.pane_id')"
  [ -n "$pane" ] && [ "$pane" != null ] || { echo "BOOT_PREP cannot create lead tab" >&2; exit 1; }
  set_cfg '.leadPane = $p' --arg p "$pane"
  echo "BOOT_PREP lead pane ${lead:-<none>} missing; created $pane"
fi

lanes="$(jq -r '.laneWorkspace // empty' "$cfg")"
if [ -n "$lanes" ] && herdr workspace get "$lanes" >/dev/null 2>&1; then
  echo "BOOT_PREP lanes workspace $lanes present"
else
  ws="$(ensure_workspace lanes)"
  set_cfg '.laneWorkspace = $w | .workspaces = [$w]' --arg w "$ws"
  echo "BOOT_PREP lanes workspace ${lanes:-<none>} missing; using $ws"
fi
