#!/usr/bin/env bash
# backup-databases.sh
#
# Nightly encrypted backup of every database in the underwings stack.
# Writes to /home/deployer/backups/YYYY-MM-DD/.
#
# Run via systemd timer (see deploy/backup-databases.service + .timer) or:
#   crontab:  30 2 * * *  /home/deployer/underwings/scripts/backup-databases.sh
#
# Each database is:
#   1. pg_dump or mysqldump'd from inside its container (no network exposure needed)
#   2. piped through gzip
#   3. piped through gpg --symmetric --cipher-algo AES256
#   4. written to disk as <db>.sql.gz.gpg
#
# Retention: 14 days. Older folders deleted at end of script.
#
# Decrypt:
#   gpg --decrypt --batch --passphrase "<passphrase>" file.sql.gz.gpg | gunzip > file.sql
#
# Threat model:
#   - At rest: AES256 + passphrase. Passphrase lives in .env (gitignored).
#   - In transit (S3 offsite): NOT YET — see Phase G runbook follow-up.
#
# Exits 0 if all databases backed up successfully. Non-zero if any failed.

set -euo pipefail

# ─── Configuration ─────────────────────────────────────────────────────
REPO_DIR="/home/deployer/underwings"
BACKUP_ROOT="/home/deployer/backups"
RETENTION_DAYS=14
TODAY="$(date +%Y-%m-%d)"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="${BACKUP_ROOT}/${TODAY}"
LOG="${OUT_DIR}/backup.log"
MANIFEST="${OUT_DIR}/manifest.txt"

# Read specific .env keys (cannot `source` — some values contain spaces
# without quotes, which docker-compose tolerates but bash does not).
get_env() {
  local key="$1"
  # `|| true` because grep returns 1 when no match, which pipefail kills.
  # Missing keys are valid (returns empty string).
  { grep -E "^${key}=" "${REPO_DIR}/.env" || true; } | head -1 | cut -d= -f2-
}

BACKUP_GPG_PASSPHRASE="$(get_env BACKUP_GPG_PASSPHRASE)"
POSTGRES_USER="$(get_env POSTGRES_USER)"
POSTGRES_PASSWORD="$(get_env POSTGRES_PASSWORD)"
SLACK_OPS_WEBHOOK="$(get_env SLACK_OPS_WEBHOOK)"

if [[ -z "${BACKUP_GPG_PASSPHRASE:-}" ]]; then
  echo "FATAL: BACKUP_GPG_PASSPHRASE not in ${REPO_DIR}/.env" >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"

log()   { echo "$(date -u +%FT%TZ) $*" | tee -a "${LOG}"; }
fail()  { log "FAIL: $*"; FAILURES=$((FAILURES + 1)); }
ok()    { log "OK:   $*"; }

FAILURES=0

# ─── Helpers ───────────────────────────────────────────────────────────

backup_postgres() {
  local container="$1" db="$2" user="$3" pw="$4"
  local target="${OUT_DIR}/${STAMP}-${container}-${db}.sql.gz.gpg"
  log "Backup pg: ${container} db=${db}"
  if docker exec -e PGPASSWORD="${pw}" "${container}" pg_dump -U "${user}" -d "${db}" --no-owner --no-acl 2>>"${LOG}" \
      | gzip -9 \
      | gpg --batch --yes --passphrase "${BACKUP_GPG_PASSPHRASE}" --cipher-algo AES256 --symmetric --output "${target}" 2>>"${LOG}"; then
    ok "${target} ($(du -h "${target}" | cut -f1))"
    sha256sum "${target}" >> "${MANIFEST}"
  else
    fail "${container}/${db}"
  fi
}

backup_mariadb() {
  local container="$1" db="$2" user="$3" pw="$4"
  local target="${OUT_DIR}/${STAMP}-${container}-${db}.sql.gz.gpg"
  log "Backup mariadb: ${container} db=${db}"
  if docker exec -e MYSQL_PWD="${pw}" "${container}" mariadb-dump --single-transaction --quick --routines --triggers -u "${user}" "${db}" 2>>"${LOG}" \
      | gzip -9 \
      | gpg --batch --yes --passphrase "${BACKUP_GPG_PASSPHRASE}" --cipher-algo AES256 --symmetric --output "${target}" 2>>"${LOG}"; then
    ok "${target} ($(du -h "${target}" | cut -f1))"
    sha256sum "${target}" >> "${MANIFEST}"
  else
    fail "${container}/${db}"
  fi
}

# ─── Run backups ───────────────────────────────────────────────────────

log "===== Nightly backup run ${STAMP} ====="

# Supabase Postgres (multiple DBs in one cluster — back up the whole cluster).
# The `underwings` DB holds the CRM (crm_deals/contacts/companies/activities/
# prospects) alongside the CMS and form_submissions.
backup_postgres underwings-db          postgres   "${POSTGRES_USER:-postgres}"   "${POSTGRES_PASSWORD}"
backup_postgres underwings-db          underwings "${POSTGRES_USER:-postgres}"   "${POSTGRES_PASSWORD}"

# NOTE: Cal.com, Documenso, Metabase/warehouse, n8n and Krayin were removed in
# 2026-06/07. Their entries were left here and failed every single night, so the
# run always ended "Failures: 6" and always fired the Slack alert — which meant
# a real backup failure would have looked exactly like the normal state. Removed
# deliberately; re-add a line only when the service actually exists again.

# ─── Retention ─────────────────────────────────────────────────────────
log "Pruning backups older than ${RETENTION_DAYS} days…"
find "${BACKUP_ROOT}" -maxdepth 1 -type d -name '20*-*-*' -mtime "+${RETENTION_DAYS}" -print -exec rm -rf {} \; 2>>"${LOG}" || true

# ─── Summary ───────────────────────────────────────────────────────────
TOTAL_SIZE="$(du -sh "${OUT_DIR}" | cut -f1)"
log "Run complete. Total size: ${TOTAL_SIZE}. Failures: ${FAILURES}."

if [[ "${FAILURES}" -gt 0 ]]; then
  if [[ -n "${SLACK_OPS_WEBHOOK:-}" ]]; then
    curl -sS -X POST -H 'Content-Type: application/json' \
      -d "{\"text\":\"⚠️ Nightly DB backup: ${FAILURES} failure(s) — see ${LOG}\"}" \
      "${SLACK_OPS_WEBHOOK}" >/dev/null || true
  fi
  exit 1
fi

exit 0
