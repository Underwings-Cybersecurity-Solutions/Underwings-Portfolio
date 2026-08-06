#!/usr/bin/env bash
# outbound-status-digest.sh — post the live outbound status to #sales-pipeline.
# Run daily from a systemd timer (end of day) so the team sees the day's outbound
# activity without opening Metabase. Real-time; reads live Krayin tables.
set -euo pipefail
docker exec underwings-pandoc-render sh -c \
  'curl -s -m 20 -X POST "http://localhost:3000/outbound/status?slack=1" -H "X-Shared-Token: $SHARED_TOKEN"' \
  >/dev/null
echo "outbound status digest posted"
