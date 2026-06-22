#!/usr/bin/env bash
set -euo pipefail

RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-rg-dsn-ai}"
APP_NAME="${AZURE_APP_NAME:-dassian-adt-mcp}"
ZIP_PATH="${ZIP_PATH:-/tmp/dassian-adt.zip}"
RUN_TESTS=1
DEPLOY=1
ASSUME_YES=0

usage() {
  cat <<'USAGE'
Usage: scripts/deploy-azure.sh [options]

Build, package, and optionally deploy the Dassian ADT MCP Azure App Service.

Options:
  --zip-only, --no-deploy     Build and package, but do not deploy
  --skip-tests                Skip npm unit tests
  --resource-group NAME       Azure resource group (default: rg-dsn-ai)
  --app-name NAME             Azure App Service name (default: dassian-adt-mcp)
  --zip-path PATH             Output zip path (default: /tmp/dassian-adt.zip)
  -y, --yes                   Do not prompt before Azure deploy
  -h, --help                  Show this help

Environment defaults:
  AZURE_RESOURCE_GROUP, AZURE_APP_NAME, ZIP_PATH
USAGE
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --zip-only|--no-deploy)
      DEPLOY=0
      shift
      ;;
    --skip-tests)
      RUN_TESTS=0
      shift
      ;;
    --resource-group)
      RESOURCE_GROUP="${2:?Missing value for --resource-group}"
      shift 2
      ;;
    --app-name)
      APP_NAME="${2:?Missing value for --app-name}"
      shift 2
      ;;
    --zip-path)
      ZIP_PATH="${2:?Missing value for --zip-path}"
      shift 2
      ;;
    -y|--yes)
      ASSUME_YES=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

require_cmd npm
require_cmd zip
if [[ "$DEPLOY" -eq 1 ]]; then
  require_cmd az
fi

if [[ "$RUN_TESTS" -eq 1 ]]; then
  npm test -- --runInBand
fi

npm run build

rm -f "$ZIP_PATH"
zip -rq "$ZIP_PATH" dist package.json package-lock.json node_modules manifest.json -x "node_modules/.cache/*"

echo "Packaged $ZIP_PATH"

if [[ "$DEPLOY" -eq 0 ]]; then
  echo "Zip-only mode: deploy skipped."
  exit 0
fi

az account show >/dev/null

if [[ "$ASSUME_YES" -ne 1 ]]; then
  printf 'Deploy %s to Azure App Service %s/%s? [y/N] ' "$ZIP_PATH" "$RESOURCE_GROUP" "$APP_NAME"
  read -r answer
  case "$answer" in
    y|Y|yes|YES)
      ;;
    *)
      echo "Deploy cancelled."
      exit 0
      ;;
  esac
fi

az webapp deploy \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --src-path "$ZIP_PATH" \
  --type zip

echo "Deployed https://${APP_NAME}.azurewebsites.net"
