#!/bin/bash
# Regression test for the disk-projection alert flap (2026-08-31).
#
# The trend block computed "days until full" ONLY on the run that re-baselines,
# i.e. once every 6 hours. Every other run in that window produced no disk
# warning at all, so the failure signature went warning → empty → warning and
# the script mailed an ALERT and a RECOVERED every single cycle: 2 emails per
# 6 hours, forever, while the disk sat at a perfectly steady 83%.
#
# A projection is a slow-moving fact. It must PERSIST between re-baselines so
# the signature stays stable and the alert fires once, not four times a day.
set -uo pipefail

SCRIPT="$(dirname "$0")/healthcheck.sh"
TREND=$(mktemp); trap 'rm -f "$TREND"' EXIT
rm -f "$TREND"   # start with no baseline, as on a fresh box

FN=$(sed -n '/^disk_trend_days()/,/^}/p' "$SCRIPT")
if [ -z "$FN" ]; then
  echo "FAIL: disk_trend_days() not found in $SCRIPT"
  exit 1
fi
eval "$FN"

T0=1000000000
SIX_H=21600
fails=0
check() { # label expected actual
  if [ "$2" = "$3" ]; then echo "PASS: $1 -> '$3'"; else echo "FAIL: $1 -> expected '$2', got '$3'"; fails=$((fails+1)); fi
}

# 1. First ever run: no baseline, so nothing can be projected yet.
check "first run, no baseline" "" "$(disk_trend_days $T0 1000000 "$TREND")"

# 2. Six hours later, 100 MB gone: 900000 KB left, losing 100000 KB per 6 h
#    -> 900000*21600/100000/86400 = 2 days.
check "re-baseline, disk shrinking" "2" "$(disk_trend_days $((T0+SIX_H)) 900000 "$TREND")"

# 3. THE REGRESSION. Five minutes on, no re-baseline is due. The old code
#    returned nothing here, which is what made the state flap.
check "+5m, between re-baselines" "2" "$(disk_trend_days $((T0+SIX_H+300)) 899000 "$TREND")"
check "+10m, between re-baselines" "2" "$(disk_trend_days $((T0+SIX_H+600)) 898000 "$TREND")"
check "+5h, still between" "2" "$(disk_trend_days $((T0+SIX_H+18000)) 890000 "$TREND")"

# 4. Next re-baseline with the disk no longer shrinking: the projection is
#    stale and must be dropped, not carried forward for ever.
check "re-baseline, disk freed" "" "$(disk_trend_days $((T0+2*SIX_H)) 950000 "$TREND")"
check "+5m after clearing" "" "$(disk_trend_days $((T0+2*SIX_H+300)) 950000 "$TREND")"

# 5. A two-field trend file written by the OLD version must not break the read.
printf '%s %s\n' "$T0" "1000000" > "$TREND"
check "legacy 2-field trend file" "2" "$(disk_trend_days $((T0+SIX_H)) 900000 "$TREND")"

[ "$fails" -eq 0 ] || { echo "$fails assertion(s) failed"; exit 1; }
echo "ALL PASS"
