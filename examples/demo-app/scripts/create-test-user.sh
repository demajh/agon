#!/usr/bin/env sh
# Creates a verified Ledgerly test user and prints its credentials as JSON, e.g.
#   {"email":"agon-1a2b3c4d@example.com","password":"Agon-...-1","loginUrl":"/login"}
# Suitable as an Agon `session.setup` hook: the JSON becomes the simulated user's credentials.
#
# Usage: scripts/create-test-user.sh [BASE_URL]
#   BASE_URL defaults to $DEMO_APP_URL, then http://localhost:3001.
#   TEST_USER_JSON may carry options, e.g. '{"onboarded":true}' or '{"verified":false}'.
set -eu
base="${1:-${DEMO_APP_URL:-http://localhost:3001}}"
body="${TEST_USER_JSON:-}"
[ -n "$body" ] || body='{}'
curl -fsS -X POST "${base%/}/__test-user" -H 'content-type: application/json' -d "$body"
echo
