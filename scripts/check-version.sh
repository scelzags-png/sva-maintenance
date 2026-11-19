#!/usr/bin/env bash
# Confirms the Apps Script half matches this page. Fails (exit 1) on any mismatch.
# Used before every publish and once a day.
set -euo pipefail
EXEC_URL=$(grep -oE "https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec" config.js | head -1)
PAGE_LEVEL=$(grep -oE "PAGE_LEVEL: *[0-9]+" config.js | grep -oE "[0-9]+$")
echo "Page level: $PAGE_LEVEL"
echo "Apps Script: $EXEC_URL"
BODY=$(curl -sSL --max-time 60 --retry 3 --retry-delay 10 "$EXEC_URL?check=version")
echo "Answer: $BODY"
echo "$BODY" | jq -e . >/dev/null || { echo "::error::The Apps Script did not answer with JSON (is the web app deployed with access Anyone?)"; exit 1; }
OK=$(echo "$BODY" | jq -r '.ok')
API=$(echo "$BODY" | jq -r '.api')
MIN=$(echo "$BODY" | jq -r '.minPage')
FILES=$(echo "$BODY" | jq -r '.filesMatch')
FAIL=0
[ "$FILES" = "true" ] || { echo "::error::Not all Apps Script files are the same version: $(echo "$BODY" | jq -c '.files')"; FAIL=1; }
[ "$OK" = "true" ] || { echo "::error::Apps Script reports a problem: $(echo "$BODY" | jq -c '.schema')"; FAIL=1; }
[ "$API" -ge "$PAGE_LEVEL" ] || { echo "::error::Apps Script api $API is older than this page needs ($PAGE_LEVEL). Paste the new Apps Script code first."; FAIL=1; }
[ "$MIN" -le "$PAGE_LEVEL" ] || { echo "::error::Apps Script needs page level $MIN or newer; this page is $PAGE_LEVEL."; FAIL=1; }
[ "$FAIL" = "0" ] && echo "Both halves match."
exit $FAIL
