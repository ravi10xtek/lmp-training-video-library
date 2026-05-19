#!/usr/bin/env sh

set -eu

PORT="${1:-8081}"
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$ROOT_DIR/old-html-version"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required but was not found."
  exit 1
fi

if [ ! -f "$APP_DIR/index.html" ]; then
  echo "Could not find app entrypoint at: $APP_DIR/index.html"
  exit 1
fi

echo "Starting LMP Training Library from: $APP_DIR"
echo "URL: http://localhost:$PORT/"
echo "Press Ctrl+C to stop."

cd "$APP_DIR"
python3 -m http.server "$PORT"
