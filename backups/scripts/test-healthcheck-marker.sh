#!/bin/bash
# Regression test for the Academy alert flood (2026-08-31).
#
# healthcheck.sh matched response markers with
#   printf '%s' "$body" | grep -qF -- "$marker"
# under `set -o pipefail`. grep -q exits the moment it matches, so on a body
# bigger than the 64 KB pipe buffer printf is still writing when the read end
# closes: printf dies of SIGPIPE (141) and pipefail promotes that to the
# PIPELINE's status, so a page that plainly CONTAINED the marker was reported as
# missing it. 349 false Academy alarms in August 2026, ~700 emails, against a
# page nginx logged every time as a complete 200.
#
# The oversized body below is what makes this deterministic rather than a 4%
# coin flip: the marker sits near the start, so grep is certain to match and
# exit while ~1 MB is still unwritten. Against the old matcher this test fails
# 50/50; against a matcher that does not pipe, it cannot fail at all.
set -uo pipefail

SCRIPT="$(dirname "$0")/healthcheck.sh"
ITER=50
fail=0

# Drive the real function out of the real script, so this tests shipped code.
FN=$(sed -n '/^body_contains()/,/^}/p' "$SCRIPT")
if [ -z "$FN" ]; then
  echo "FAIL: body_contains() not found in $SCRIPT"
  exit 1
fi
eval "$FN"

MARKER="View course"
BODY="$(printf 'x%.0s' $(seq 1 1000))
${MARKER}
$(head -c 1000000 /dev/zero | tr '\0' 'y')"

echo "body=${#BODY} bytes (>64 KB pipe buffer), marker near start, ${ITER} iterations"

for _ in $(seq 1 "$ITER"); do
  body_contains "$BODY" "$MARKER" || fail=$((fail+1))
done
if [ "$fail" -ne 0 ]; then
  echo "FAIL: $fail/$ITER false negatives — a present marker was reported missing"
  exit 1
fi
echo "PASS: $ITER/$ITER matched a present marker"

# Still has to report a genuinely absent marker as absent.
if body_contains "$BODY" "definitely-not-present"; then
  echo "FAIL: reported a match for an absent marker"
  exit 1
fi
echo "PASS: absent marker reported missing"

# Markers are literals, not globs.
if body_contains "plain text here" "*"; then
  echo "FAIL: marker '*' was treated as a glob, not a literal"
  exit 1
fi
echo "PASS: marker treated as a literal string"

# Real-page shape (56 KB, 165 lines) — the production case, run hot.
REAL="$(head -c 13000 /dev/zero | tr '\0' 'a' | fold -w 80)
${MARKER}
$(head -c 43000 /dev/zero | tr '\0' 'b' | fold -w 80)"
fail=0
for _ in $(seq 1 500); do
  body_contains "$REAL" "$MARKER" || fail=$((fail+1))
done
if [ "$fail" -ne 0 ]; then
  echo "FAIL: $fail/500 false negatives on a live-sized body"
  exit 1
fi
echo "PASS: 500/500 on a live-sized (56 KB, wrapped) body"
