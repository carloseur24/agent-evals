#!/bin/sh
# Run the Agent Evals suite from this repository, from any directory.
#
# Usage:
#   bash scripts/run.sh --all
#   bash scripts/run.sh --case e2-fast-change
#   bash scripts/run.sh --help
#
# AGENT_EVALS_HOME overrides the runner directory (default: <repo>/runner).

set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
EVALS_HOME="${AGENT_EVALS_HOME:-$ROOT/runner}"

case "$EVALS_HOME" in
    "~/"*) EVALS_HOME="$HOME/${EVALS_HOME#\~/}" ;;
esac

if [ ! -f "$EVALS_HOME/run.mjs" ]; then
    echo "agent-evals: run.mjs not found at $EVALS_HOME/run.mjs" >&2
    echo "agent-evals: expected the runner at $ROOT/runner; set AGENT_EVALS_HOME to override" >&2
    exit 2
fi

if ! command -v node >/dev/null 2>&1; then
    echo "agent-evals: node is required" >&2
    exit 2
fi

exec node "$EVALS_HOME/run.mjs" "$@"
