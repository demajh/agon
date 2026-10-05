#!/usr/bin/env sh
# Clears every user, project, session and the event log of a running demo app.
#
# Usage: scripts/reset.sh [BASE_URL]
#   BASE_URL defaults to $DEMO_APP_URL, then http://localhost:3001.
set -eu
base="${1:-${DEMO_APP_URL:-http://localhost:3001}}"
curl -fsS -X POST "${base%/}/__reset"
echo
