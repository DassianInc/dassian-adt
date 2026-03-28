#!/bin/bash
# dassian-adt setup — run this once to add SAP systems to Claude Code
# Usage: ./setup.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="node ${SCRIPT_DIR}/dist/index.js"

echo "dassian-adt setup"
echo "================="
echo ""

# Check prerequisites
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is required. Install from https://nodejs.org/"
    exit 1
fi

if ! command -v claude &> /dev/null; then
    echo "Error: Claude Code CLI is required."
    exit 1
fi

# Check if built
if [ ! -f "${SCRIPT_DIR}/dist/index.js" ]; then
    echo "Building dassian-adt..."
    cd "$SCRIPT_DIR" && npm install && npm run build
fi

echo "Enter your SAP credentials (stored locally in Claude Code config):"
echo ""

read -p "SAP Username: " SAP_USER
read -s -p "SAP Password: " SAP_PASSWORD
echo ""
echo ""

# Add each system
echo "Adding SAP systems to Claude Code..."

claude mcp add \
    -e SAP_URL=https://d23app.dassian.org:44300 \
    -e SAP_USER="$SAP_USER" \
    -e SAP_PASSWORD="$SAP_PASSWORD" \
    -e SAP_CLIENT=100 \
    -e SAP_LANGUAGE=EN \
    -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
    abap-d23 -- $SERVER

claude mcp add \
    -e SAP_URL=https://d25app.dassian.org:44300 \
    -e SAP_USER="$SAP_USER" \
    -e SAP_PASSWORD="$SAP_PASSWORD" \
    -e SAP_CLIENT=100 \
    -e SAP_LANGUAGE=EN \
    -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
    abap-d25 -- $SERVER

claude mcp add \
    -e SAP_URL=https://m25app.dassian.org:44300 \
    -e SAP_USER="$SAP_USER" \
    -e SAP_PASSWORD="$SAP_PASSWORD" \
    -e SAP_CLIENT=100 \
    -e SAP_LANGUAGE=EN \
    -e NODE_TLS_REJECT_UNAUTHORIZED=0 \
    abap-m25 -- $SERVER

echo ""
echo "Done. You now have abap-d23, abap-d25, and abap-m25 in Claude Code."
echo "Restart Claude Code to pick up the new servers."
