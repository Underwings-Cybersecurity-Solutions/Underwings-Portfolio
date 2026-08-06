#!/usr/bin/env bash
# stalwart-unban-internal.sh — clear docker-internal IPs from Stalwart's auto-ban list.
#
# Why: Stalwart attributes ALL reverse-proxied HTTP traffic to nginx's single
# container IP (it does not honour X-Forwarded-For in this version — only the
# TCP PROXY protocol, which we don't run). Internet bots probing the public
# mail.underwings.org admin URL generate 404s that trip Stalwart's `scan`
# auto-ban, which then bans nginx itself and 502s the whole admin UI for
# everyone. Stalwart's allowed-ips list does not prevent this (upstream bug
# stalwartlabs/stalwart#1922).
#
# This guard removes any blocked-ip entry that is a private/loopback address
# (i.e. an internal container, never a real attacker) and reloads config only
# if something was actually cleared. Run every couple of minutes via a timer.
set -euo pipefail

ENV_FILE="/home/deployer/underwings/.env"
CONTAINER="underwings-mail"
ADMIN_USER="admin"

# Pull the fallback-admin password without leaking the rest of the env.
MAIL_ADMIN_PASS="$(grep -E '^MAIL_ADMIN_PASS=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
if [[ -z "${MAIL_ADMIN_PASS:-}" ]]; then
  echo "ERROR: MAIL_ADMIN_PASS not found in $ENV_FILE" >&2
  exit 1
fi

cli() {
  docker exec "$CONTAINER" stalwart-cli \
    -u http://localhost:8080 \
    -c "${ADMIN_USER}:${MAIL_ADMIN_PASS}" \
    "$@"
}

# Internal/private/loopback ranges that must never stay banned:
#   10.0.0.0/8, 172.16.0.0/12 (docker bridges), 192.168.0.0/16, 127.0.0.0/8, ::1
is_internal() {
  case "$1" in
    10.*|192.168.*|127.*|::1) return 0 ;;
    172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) return 0 ;;
    *) return 1 ;;
  esac
}

mapfile -t blocked < <(
  cli server list-config 2>/dev/null \
    | grep -oE 'server\.blocked-ip\.[0-9a-fA-F:.]+' \
    | sed 's/^server\.blocked-ip\.//' \
    | sort -u
)

cleared=0
for ip in "${blocked[@]}"; do
  [[ -z "$ip" ]] && continue
  if is_internal "$ip"; then
    if cli server delete-config "server.blocked-ip.${ip}" >/dev/null 2>&1; then
      echo "unbanned internal IP: ${ip}"
      cleared=$((cleared + 1))
    else
      echo "WARN: failed to delete server.blocked-ip.${ip}" >&2
    fi
  fi
done

if [[ "$cleared" -gt 0 ]]; then
  cli server reload-config >/dev/null 2>&1 && echo "reloaded config (${cleared} internal IP(s) cleared)"
else
  echo "no internal IPs banned — nothing to do"
fi
