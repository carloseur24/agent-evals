#!/bin/sh
# Wire this repository into the OpenCode config paths used by existing commands.
#
# Creates:
#   ~/.config/opencode/agent-evals       -> <repo>
#   ~/.config/opencode/evals             -> <repo>/runner
#   ~/.config/opencode/agents/eval-judge.md -> <repo>/agents/eval-judge.md
#
# Also runs guardrails/scripts/install.sh, which wires the runtime guardrails
# and syncs the managed harness-invariants block in AGENTS.md.
#
# Local state (reports, drafts, guard log, backups) is created under
# $AGENT_EVALS_STATE, default ~/.local/state/agent-evals.
#
# Existing links to the same target are left alone. A real file, real
# directory, or different symlink is never replaced without --force.
#
# Usage:
#   bash scripts/install.sh [--force]

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
STATE_ROOT="${AGENT_EVALS_STATE:-$HOME/.local/state/agent-evals}"
FORCE=0

usage() {
    cat <<'EOF'
Wire this repository into the OpenCode config paths used by existing commands.

Creates:
  ~/.config/opencode/agent-evals          -> <repo>
  ~/.config/opencode/evals                -> <repo>/runner
  ~/.config/opencode/agents/eval-judge.md -> <repo>/agents/eval-judge.md

Also runs guardrails/scripts/install.sh for the runtime guardrails:
  ~/.config/opencode/plugins/harness-guard.js -> <repo>/guardrails/plugins/harness-guard.js
  ~/.config/opencode/agents/plan-orchestrator.md -> <repo>/guardrails/agents/plan-orchestrator.md
  ~/.config/opencode/agent-guardrails -> <repo>/guardrails
and syncs the harness-invariants block in ~/.config/opencode/AGENTS.md.

Existing links to the same target are left alone. A real file, real directory,
or different symlink is never replaced without --force.

Usage:
  bash scripts/install.sh [--force]
EOF
}

for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "agent-evals: unknown argument: $arg" >&2
            exit 2
            ;;
    esac
done

mkdir -p "$STATE_ROOT/reports" "$STATE_ROOT/drafts" "$STATE_ROOT/backups"
echo "state     $STATE_ROOT"

link_path() {
    target=$1
    link_path=$2

    mkdir -p "$(dirname -- "$link_path")"

    if [ -L "$link_path" ]; then
        current=$(readlink -- "$link_path")
        if [ "$current" = "$target" ]; then
            echo "already linked $link_path -> $target"
            return 0
        fi
        if [ "$FORCE" -ne 1 ]; then
            echo "agent-evals: refusing to replace symlink $link_path -> $current (use --force)" >&2
            return 1
        fi
        rm -- "$link_path"
    elif [ -e "$link_path" ]; then
        if [ "$FORCE" -ne 1 ]; then
            echo "agent-evals: refusing to replace existing path $link_path (use --force)" >&2
            return 1
        fi
        rm -rf -- "$link_path"
    fi

    ln -s -- "$target" "$link_path"
    echo "linked $link_path -> $target"
}

link_path "$ROOT" "$CONFIG_HOME/agent-evals"
link_path "$ROOT/runner" "$CONFIG_HOME/evals"
link_path "$ROOT/agents/eval-judge.md" "$CONFIG_HOME/agents/eval-judge.md"

if [ "$FORCE" -eq 1 ]; then
    sh "$ROOT/guardrails/scripts/install.sh" --force
else
    sh "$ROOT/guardrails/scripts/install.sh"
fi
