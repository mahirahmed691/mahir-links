#!/usr/bin/env bash
# Verifies the live site is up and (optionally) serving an expected commit.
# Usage: scripts/smoke.sh <base-url> [expected-sha]
# Env:   SMOKE_ATTEMPTS (default 10), SMOKE_WAIT seconds (default 15), VERCEL_BYPASS (optional)
set -euo pipefail

base="${1%/}"
expected="${2:-}"
attempts="${SMOKE_ATTEMPTS:-10}"
wait="${SMOKE_WAIT:-15}"
tmp="$(mktemp)"
# Protected Vercel previews need the automation bypass secret to be reachable.
auth=()
if [[ -n "${VERCEL_BYPASS:-}" ]]; then auth=(-H "x-vercel-protection-bypass: $VERCEL_BYPASS"); fi
status="000"; live=""

for i in $(seq 1 "$attempts"); do
  status=$(curl -s "${auth[@]}" -o "$tmp" -w '%{http_code}' "$base/?cb=$RANDOM$RANDOM" || echo 000)
  live=$(curl -fsS "${auth[@]}" "$base/version.json?cb=$RANDOM$RANDOM" 2>/dev/null | sed -n 's/.*"sha": *"\([0-9a-zA-Z]*\)".*/\1/p' | head -n1 || true)
  # 401 = password prompt, 503 = env vars not set yet. Either means the function ran.
  admin_status=$(curl -s "${auth[@]}" -o /dev/null -w '%{http_code}' "$base/admin?cb=$RANDOM$RANDOM" || echo 000)

  if [[ "$status" == "200" ]] && grep -q 'class="links"' "$tmp" && [[ -z "$expected" || "$live" == "$expected" ]] && [[ "$admin_status" == "401" || "$admin_status" == "503" ]]; then
    echo "OK: $base returned 200 and is serving ${live:-unknown sha}; /admin returned $admin_status"
    exit 0
  fi

  echo "Attempt $i/$attempts: status=$status admin=$admin_status live_sha=${live:-none} expected_sha=${expected:-any}"
  if [[ "$i" -lt "$attempts" ]]; then sleep "$wait"; fi
done

echo "FAIL: $base is not healthy (status=$status, live_sha=${live:-none}, expected_sha=${expected:-any})"
exit 1
