#!/usr/bin/env bash
# One-shot setup for the abap2UI5 MCP server and its sibling checkouts:
#
#   <root>/
#     mcp-server/        this repo (any directory name works)
#     abap2UI5/          the framework
#     samples-controls/  the corpus (capability map, deploy sandbox)
#     linter/            the view validation gates
#
# Existing checkouts are reused, also under their pre-rename directory
# names (ai-demokit, abap2UI5-linter, ai-view-check), and npm ci is
# skipped where node_modules is already present - safe to re-run.
#
# Usage:
#   ./setup.sh              clone missing siblings, npm ci, chromium
#   ./setup.sh --with-deps  also install the browser's system libraries
#                           (fresh Linux container, e.g. a devcontainer)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
REPO_DIR=""

ensure_repo() { # <canonical dir> <clone url> [legacy dir names...]
  local dir="$1" url="$2" d
  shift 2
  REPO_DIR=""
  for d in "$dir" "$@"; do
    if [ -d "$ROOT/$d" ]; then
      REPO_DIR="$ROOT/$d"
      echo "-- $REPO_DIR (already present)"
      return
    fi
  done
  echo "-- cloning $url"
  git clone --depth 1 "$url" "$ROOT/$dir"
  REPO_DIR="$ROOT/$dir"
}

install_deps() { # <dir>
  if [ -d "$1/node_modules" ]; then
    echo "-- $1: node_modules present, skipping npm ci"
  else
    echo "-- $1: npm ci"
    (cd "$1" && npm ci --no-audit --no-fund)
  fi
}

echo "abap2UI5 MCP server setup (root: $ROOT)"

ensure_repo abap2UI5 https://github.com/abap2UI5/abap2UI5
A2UI5_DIR="$REPO_DIR"
ensure_repo samples-controls https://github.com/abap2UI5/samples-controls ai-demokit
DEMOKIT_DIR="$REPO_DIR"
ensure_repo linter https://github.com/abap2UI5/linter abap2UI5-linter ai-view-check
LINTER_DIR="$REPO_DIR"

install_deps "$A2UI5_DIR"
install_deps "$DEMOKIT_DIR"
install_deps "$LINTER_DIR"
install_deps "$HERE"

if [ "${PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:-}" = "1" ]; then
  echo "-- PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1: skipping browser install"
elif [ "${1:-}" = "--with-deps" ]; then
  (cd "$HERE" && npx playwright install --with-deps chromium)
else
  (cd "$HERE" && npx playwright install chromium)
fi

cat <<EOF

Done. Register the server in your MCP client, e.g. Claude Code:

  claude mcp add abap2ui5 -- node $HERE/server.mjs

Or start your client from $HERE - the committed .mcp.json
registers the server automatically.
EOF
