#!/usr/bin/env bash
# Launch the local build as a stdio MCP server.
# cd first so dotenv's config() finds this worktree's .env — keeps SAP creds
# out of ~/.claude.json and out of git.
cd "$(dirname "$0")" || exit 1
exec node dist/index.js "$@"
