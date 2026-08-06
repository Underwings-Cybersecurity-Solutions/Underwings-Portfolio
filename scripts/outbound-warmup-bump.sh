#!/usr/bin/env bash
# outbound-warmup-bump.sh <target_cap>
#
# Phase H warmup ramp step. Runs from a one-shot systemd timer on the warmup
# dates. Does the objective health checks a script CAN do (delivery bounces in
# the mail log, send volume), then:
#   - clean  -> raise OUTBOUND_DAILY_CAP to <target_cap>, recreate pandoc-render
#   - bounces-> HOLD at current cap, alert
# Always posts the outcome + a "eyeball inbox placement" reminder to #sales-pipeline.
#
# Health-gated by design: a script can't see Gmail spam placement, so the human
# still confirms deliverability. Manual override is always one line (printed below).
#
#   bash scripts/outbound-warmup-bump.sh 12
set -euo pipefail

TARGET="${1:?usage: outbound-warmup-bump.sh <target_cap>}"
DIR="/home/deployer/underwings"
ENV="${DIR}/.env"
cd "$DIR"

CUR=$(grep -E '^OUTBOUND_DAILY_CAP=' "$ENV" | cut -d= -f2 || echo "?")
SLACK=$(grep -E '^SLACK_SALES_WEBHOOK=' "$ENV" | cut -d= -f2- || true)

# objective health: hard delivery failures for the outreach sender in last 7 days
BOUNCES=$(docker logs underwings-mail --since 168h 2>&1 \
  | grep -i 'sales@outreach.underwings.org' \
  | grep -iE 'delivery.failed|dsn-fail|permanent|5[0-9][0-9] ' | wc -l | tr -d ' ')

post() {  # $1 = text
  [ -n "${SLACK:-}" ] || return 0
  curl -s -m 15 -X POST -H 'Content-Type: application/json' \
    --data "$(python3 -c 'import json,sys;print(json.dumps({"text":sys.argv[1]}))' "$1")" \
    "$SLACK" >/dev/null || true
}

OVERRIDE="Manual override: edit OUTBOUND_DAILY_CAP in .env then \`docker compose up -d --force-recreate pandoc-render\`"

if [ "$BOUNCES" -eq 0 ]; then
  # raise the cap (preserve .env ownership — systemd runs us as root)
  OWNER=$(stat -c '%U:%G' "$ENV")
  sed -i "s/^OUTBOUND_DAILY_CAP=.*/OUTBOUND_DAILY_CAP=${TARGET}/" "$ENV"
  chown "$OWNER" "$ENV"
  docker compose up -d --force-recreate pandoc-render >/dev/null 2>&1
  post ":chart_with_upwards_trend: *Outbound warmup ramp* — cap raised ${CUR} → *${TARGET}*/day (0 delivery bounces in last 7d). :eyes: Please confirm recent sends still land in *Gmail inbox* (signed-by underwings.org), not spam. ${OVERRIDE}"
  echo "bumped ${CUR} -> ${TARGET}"
else
  post ":warning: *Outbound warmup HELD* at ${CUR}/day — detected ${BOUNCES} delivery failure log line(s) for sales@outreach in the last 7 days. Investigate deliverability before raising to ${TARGET}. ${OVERRIDE}"
  echo "HELD at ${CUR} (bounces=${BOUNCES})"
fi
