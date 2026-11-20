#!/bin/sh
# Install the runtime guardrails into the OpenCode config paths.
#
# Creates:
#   ~/.config/opencode/plugins/harness-guard.js
#     -> <repo>/guardrails/plugins/harness-guard.js
#   ~/.config/opencode/agents/plan-orchestrator.md
#     -> <repo>/guardrails/agents/plan-orchestrator.md
#   ~/.config/opencode/agent-guardrails
#     -> <repo>/guardrails
#
# Then syncs the marked harness-invariants block in
# ~/.config/opencode/AGENTS.md from guardrails/instructions/.
#
# Local state (reports, drafts, guard log, backups) is created under
# $AGENT_EVALS_STATE, default ~/.local/state/agent-evals.
#
# Existing links to the same target are left alone. A real file, real directory,
# or different symlink is never replaced without --force.
#
# Usage:
#   bash guardrails/scripts/install.sh [--force]

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
GUARDRAILS=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
STATE_ROOT="${AGENT_EVALS_STATE:-$HOME/.local/state/agent-evals}"
FORCE=0

usage() {
    cat <<'EOF'
Install the runtime guardrails into the OpenCode config paths.

Creates:
  ~/.config/opencode/plugins/harness-guard.js -> <repo>/guardrails/plugins/harness-guard.js
  ~/.config/opencode/agents/plan-orchestrator.md -> <repo>/guardrails/agents/plan-orchestrator.md
  ~/.config/opencode/agent-guardrails -> <repo>/guardrails

Then syncs the marked harness-invariants block in
~/.config/opencode/AGENTS.md from guardrails/instructions/.

Existing links to the same target are left alone. A real file, real directory,
or different symlink is never replaced without --force.

Usage:
  bash guardrails/scripts/install.sh [--force]
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
            echo "guardrails: unknown argument: $arg" >&2
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
            echo "guardrails: refusing to replace symlink $link_path -> $current (use --force)" >&2
            return 1
        fi
        rm -- "$link_path"
    elif [ -e "$link_path" ]; then
        if [ "$FORCE" -ne 1 ]; then
            echo "guardrails: refusing to replace existing path $link_path (use --force)" >&2
            return 1
        fi
        rm -rf -- "$link_path"
    fi

    ln -s -- "$target" "$link_path"
    echo "linked $link_path -> $target"
}

link_path "$GUARDRAILS/plugins/harness-guard.js" "$CONFIG_HOME/plugins/harness-guard.js"
link_path "$GUARDRAILS/agents/plan-orchestrator.md" "$CONFIG_HOME/agents/plan-orchestrator.md"
link_path "$GUARDRAILS" "$CONFIG_HOME/agent-guardrails"

node "$GUARDRAILS/scripts/install-block.mjs"
