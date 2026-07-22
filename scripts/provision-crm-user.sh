#!/usr/bin/env bash
# ============================================================
# provision-crm-user.sh
# Idempotently creates / updates a standalone-CRM user for
# crm.underwings.org (identity table public.crm_users, roles
# admin|member — separate from the CMS admin_users).
#
# Credentials are passed TRANSIENTLY via environment variables so
# they are never written to .env, the repo, or any log:
#   CRM_EMAIL     (required)  e.g. manoj@underwings.org
#   CRM_PASSWORD  (required)  temporary password; user changes it after MFA
#   CRM_ROLE      (optional)  admin | member   (default: member)
#
# SERVICE_ROLE_KEY + POSTGRES_* are read from the project .env.
# The service-role insert bypasses RLS, so it can seed the FIRST
# crm_admin on an empty table (the app cannot self-insert row #1).
#
# Usage:
#   CRM_EMAIL=manoj@underwings.org  CRM_ROLE=admin  CRM_PASSWORD='...' bash scripts/provision-crm-user.sh
#   CRM_EMAIL=guna@underwings.org   CRM_ROLE=member CRM_PASSWORD='...' bash scripts/provision-crm-user.sh
# ============================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
[ -f "$ENV_FILE" ] || { echo "ERR: $ENV_FILE not found" >&2; exit 1; }

# Per-user credentials come from the environment (transient), NOT from .env.
CRM_EMAIL="${CRM_EMAIL:-}"
CRM_PASSWORD="${CRM_PASSWORD:-}"
CRM_ROLE="${CRM_ROLE:-member}"

# Shared secrets come from .env (already present).
SERVICE_ROLE_KEY="$(grep -E '^SERVICE_ROLE_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
POSTGRES_USER="$(grep -E '^POSTGRES_USER=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
POSTGRES_PASSWORD="$(grep -E '^POSTGRES_PASSWORD=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
POSTGRES_DB="$(grep -E '^POSTGRES_DB=' "$ENV_FILE" | head -1 | cut -d= -f2-)"

[ -n "$CRM_EMAIL" ]           || { echo "ERR: set CRM_EMAIL in the environment"    >&2; exit 1; }
[ -n "$CRM_PASSWORD" ]        || { echo "ERR: set CRM_PASSWORD in the environment" >&2; exit 1; }
[ -n "${SERVICE_ROLE_KEY:-}" ] || { echo "ERR: SERVICE_ROLE_KEY missing in .env"   >&2; exit 1; }
case "$CRM_ROLE" in admin|member) ;; *) echo "ERR: CRM_ROLE must be 'admin' or 'member'" >&2; exit 1;; esac

AUTH_URL="http://localhost:8000/auth/v1"   # kong gateway, exposed locally

echo "→ Provisioning CRM user: $CRM_EMAIL (role=$CRM_ROLE)"

# 1. Create the auth user; if it already exists, update the password.
CREATE_RESP="$(curl -s -o /tmp/_crm_create.json -w '%{http_code}' \
  -X POST "$AUTH_URL/admin/users" \
  -H "apikey: $SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @<(jq -nc --arg e "$CRM_EMAIL" --arg p "$CRM_PASSWORD" \
    '{email:$e, password:$p, email_confirm:true}'))"

if [ "$CREATE_RESP" = "200" ] || [ "$CREATE_RESP" = "201" ]; then
  USER_ID="$(jq -r '.id // .user.id' /tmp/_crm_create.json)"
  echo "  created. user_id=$USER_ID"
elif [ "$CREATE_RESP" = "422" ] || [ "$CREATE_RESP" = "409" ]; then
  echo "  user exists; updating password..."
  LIST_RESP="$(curl -s "$AUTH_URL/admin/users?email=$CRM_EMAIL" \
    -H "apikey: $SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $SERVICE_ROLE_KEY")"
  USER_ID="$(echo "$LIST_RESP" | jq -r '.users[0].id // .[0].id // empty')"
  [ -n "$USER_ID" ] || { echo "ERR: user lookup failed: $LIST_RESP" >&2; exit 1; }
  PATCH_RESP="$(curl -s -o /tmp/_crm_patch.json -w '%{http_code}' \
    -X PUT "$AUTH_URL/admin/users/$USER_ID" \
    -H "apikey: $SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
    -H 'Content-Type: application/json' \
    --data-binary @<(jq -nc --arg p "$CRM_PASSWORD" '{password:$p, email_confirm:true}'))"
  [ "$PATCH_RESP" = "200" ] || { echo "ERR: password update failed (HTTP $PATCH_RESP): $(cat /tmp/_crm_patch.json)" >&2; exit 1; }
  echo "  updated. user_id=$USER_ID"
else
  echo "ERR: create returned HTTP $CREATE_RESP: $(cat /tmp/_crm_create.json)" >&2
  exit 1
fi

# 2. Grant CRM role in public.crm_users (service-role → bypasses RLS, seeds first admin).
echo "→ Granting CRM role '$CRM_ROLE' in public.crm_users"
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" underwings-db \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "INSERT INTO public.crm_users (id, role) VALUES ('$USER_ID', '$CRM_ROLE') ON CONFLICT (id) DO UPDATE SET role='$CRM_ROLE';" \
  | sed -E 's/^[A-Z]+ [0-9]+$/  inserted\/upserted/'

# Cleanup temp files (don't leak password-bearing JSON).
rm -f /tmp/_crm_create.json /tmp/_crm_patch.json

echo "✓ Done. CRM user ready: $CRM_EMAIL (role=$CRM_ROLE)"
echo "  Login at: https://crm.underwings.org  — first login prompts mandatory TOTP MFA setup."
