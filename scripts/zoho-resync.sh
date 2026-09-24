#!/usr/bin/env bash
# Nightly: re-push website rows that never reached Zoho CRM (zoho_lead_id NULL).
# Calls the frontend's /api/admin/zoho-resync from INSIDE the container so the
# route is only ever reached through the token check. Alerts only after three
# consecutive failing nights, with the same ALERT_* mailer healthcheck.sh uses.
set -u
cd "$(dirname "$0")/.."
ENV_FILE=.env
env_val() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"'; }
STATE=backups/.zoho-resync-fails
TOKEN=$(env_val ZOHO_RESYNC_TOKEN)
if [ -z "$TOKEN" ]; then
  OUT="ZOHO_RESYNC_TOKEN missing in $ENV_FILE"; RC=2
else
  # Token travels in an env var (not argv) so it is not visible in `ps` on the host.
  OUT=$(docker exec -e RT="$TOKEN" underwings-frontend sh -c 'wget -qO- --header="X-Resync-Token: $RT" --post-data="" http://127.0.0.1:4321/api/admin/zoho-resync' 2>&1)
  RC=$?
fi
echo "$(date -u +%FT%TZ) rc=$RC $OUT"

# The route always answers 200 with {"ok":bool,"failed":N,...}; anything else is a transport failure.
if [ "$RC" -ne 0 ] || [[ "$OUT" != *'"ok":true'* ]]; then
  n=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STATE"
  if [ "$n" -ge 3 ]; then
    to=$(env_val ALERT_EMAIL); from=$(env_val ALERT_FROM_EMAIL); host=$(env_val ALERT_SMTP_HOST); port=$(env_val ALERT_SMTP_PORT); user=$(env_val ALERT_SMTP_USER); pass=$(env_val ALERT_SMTP_PASS)
    tls="--tls"; [ "$port" = "465" ] && tls="--tls-on-connect"
    swaks --to "$to" --from "$from" --server "$host" --port "$port" "$tls" --auth PLAIN --auth-user "$user" --auth-password "$pass" \
      --header "Subject: [underwings] Zoho lead resync failing ${n} nights" --body "$OUT" --timeout 15 >/dev/null 2>&1 \
      || echo "$(date -u +%FT%TZ) ALERT MAIL FAILED"
  fi
  exit 1
fi
rm -f "$STATE"
