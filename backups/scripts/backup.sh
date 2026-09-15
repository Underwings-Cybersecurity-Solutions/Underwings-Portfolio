#!/bin/bash
# ===========================================
# UNDERWINGS — Daily Backup Script
# Backs up all databases + app FILE/OBJECT storage, ENCRYPTED at rest (AES256).
# Keeps last 7 days. Runs 03:00 via cron.
#
# RESTORE: decrypt any artifact with:
#   gpg --batch --pinentry-mode loopback --passphrase-file <(grep '^BACKUP_GPG_PASSPHRASE=' \
#       /home/deployer/underwings/.env | cut -d= -f2-) -d FILE.gpg | gunzip > FILE
#   (for .tar.gz.gpg: ... | gunzip | tar xf -)
# ===========================================

set -euo pipefail

BACKUP_DIR="/home/deployer/underwings/backups"
DATE=$(date +%Y-%m-%d_%H%M)
KEEP_DAYS=7

# The Stalwart artifact is a FULL tar of the mail store, not an increment. On
# 2026-08-07 it was 3.4 GB and growing 200-400 MB/day, so seven dailies came to
# 22.7 GB — effectively the entire 22 GB backup directory — and the rolling
# window netted +1 GB/day against free space. It gets its own short retention
# plus a Sunday keeper, counted rather than aged (see rotate()).
STALWART_KEEP_DAILY=2
STALWART_KEEP_WEEKLY=4

# Hard ceiling on the whole Stalwart set. Counts alone do NOT bound disk once each
# copy is growing: the store was flat at ~5 MB/day until 2026-08-05, then jumped
# to ~326 MB/day, at which rate six retained copies reach 75 GB within a month.
# This is the invariant that actually protects the disk; the counts above just
# shape which copies survive.
STALWART_MAX_TOTAL_GB=${STALWART_MAX_TOTAL_GB:-16}

# Below this much free space the Stalwart tar is skipped. The small dumps (~64 MB
# for every other artifact combined) always run: refusing those exactly when the
# disk is in trouble is how you end up with no database backup at all.
MIN_FREE_PCT=12

mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

# --- encryption (fail fast if no passphrase — backups must not be plaintext) ---
GPG_PASS=$(grep -E '^BACKUP_GPG_PASSPHRASE=' /home/deployer/underwings/.env | cut -d= -f2- || true)
if [ -z "$GPG_PASS" ]; then echo "FATAL: BACKUP_GPG_PASSPHRASE not set — refusing to write unencrypted backups"; exit 1; fi
PASS_FILE=$(mktemp); chmod 600 "$PASS_FILE"; printf '%s' "$GPG_PASS" > "$PASS_FILE"
enc() { gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-file "$PASS_FILE" --symmetric --cipher-algo AES256; }

# Keep only the $2 newest Stalwart artifacts in directory $1.
# find (not ls) so an empty directory exits 0 instead of tripping pipefail;
# filenames embed ISO dates, so a lexical sort is chronological.
prune_stalwart() {
  local dir="$1" keep="$2" label="$3" f
  [ -d "$dir" ] || return 0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    echo "    - drop ${label} $(basename "$f")"
    rm -f "$f"
  done < <(find "$dir" -maxdepth 1 -name 'stalwart_*.tar.gz.gpg' | sort -r | tail -n +$((keep + 1)))
}

rotate() {
  echo "  → Rotating (general ${KEEP_DAYS}d; stalwart ${STALWART_KEEP_DAILY} daily + ${STALWART_KEEP_WEEKLY} weekly)..."
  # Everything except Stalwart keeps the original 7-day window — all of those
  # together are ~64 MB, so age-based rotation costs nothing.
  find "$BACKUP_DIR/daily" \( -name "*.gz" -o -name "*.gpg" \) \
       ! -name 'stalwart_*' -mtime +${KEEP_DAYS} -delete 2>/dev/null || true
  # Stalwart rotates by COUNT, not age: one tar outweighs everything else on the
  # box combined, so "how many copies" is the only number that bounds the disk.
  prune_stalwart "$BACKUP_DIR/daily"  "$STALWART_KEEP_DAILY"  "daily"
  prune_stalwart "$BACKUP_DIR/weekly" "$STALWART_KEEP_WEEKLY" "weekly"
  enforce_stalwart_cap
}

# Drop the OLDEST weekly copies until the whole Stalwart set fits under the cap.
# Dailies are never sacrificed — a recent restore point matters more than an old
# one. du counts a hardlinked file once, so a promoted Sunday copy is not
# double-charged while it still exists in both directories.
enforce_stalwart_cap() {
  local max_kb=$(( STALWART_MAX_TOTAL_GB * 1024 * 1024 )) total f
  local -a set
  while :; do
    # find (not a glob) for the same reason prune_stalwart uses it: once weekly/
    # empties, an unmatched glob reaches du as a literal path, du exits 1, and
    # pipefail turns that into a set -e abort BEFORE any dump is written. That
    # is what silently stopped every run from 2026-08-28 to 2026-09-02.
    mapfile -t -d '' set < <(find "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly" \
                                  -maxdepth 1 -name 'stalwart_*.tar.gz.gpg' -print0 2>/dev/null)
    [ "${#set[@]}" -gt 0 ] || return 0
    total=$(du -sk --total "${set[@]}" | tail -1 | cut -f1)
    [ -n "${total:-}" ] || return 0
    [ "$total" -le "$max_kb" ] && return 0
    f=$(find "$BACKUP_DIR/weekly" -maxdepth 1 -name 'stalwart_*.tar.gz.gpg' | sort | head -1)
    if [ -z "$f" ]; then
      echo "    ! Stalwart set is ${total}K, over the ${STALWART_MAX_TOTAL_GB}GB cap, but only dailies remain — keeping them."
      return 0
    fi
    echo "    - over ${STALWART_MAX_TOTAL_GB}GB cap (${total}K): dropping weekly $(basename "$f")"
    rm -f "$f"
  done
}

# Retention runs even if a step fails (set -e abort). Root cause of the 2026-06
# disk-full incident: a missing container aborted before cleanup, so no rotation.
cleanup() {
  rm -f "$PASS_FILE"
  rotate
}
trap cleanup EXIT

# Rotate BEFORE writing as well, not only after. Freeing the older copies first
# is what makes tonight's 3.4 GB tar fit; rotating only at the end means peak
# usage is forever (full retained set + one new artifact).
rotate

# Manual reclaim lever: apply retention without writing a new 3.4 GB tar. Useful
# when the disk is already tight and a full run is exactly what you can't afford.
if [ "${1:-}" = "--rotate-only" ]; then
  echo "[$(date)] rotate-only: retention applied, no new artifacts written."
  df -h / | tail -1
  exit 0
fi

FREE_PCT=$(df -P / | awk 'NR==2 {gsub(/%/,"",$5); print 100-$5}')
SKIP_BULK=0
if [ "$FREE_PCT" -lt "$MIN_FREE_PCT" ]; then
  SKIP_BULK=1
  echo "  !! Only ${FREE_PCT}% free on / — SKIPPING the Stalwart tar this run."
  echo "  !! All other artifacts still run. Investigate disk usage."
fi

echo "[$(date)] Starting backup (encrypted)..."

# ---------- DATABASES ----------
echo "  → Supabase DB..."
docker exec underwings-db pg_dump -U postgres -d underwings --no-owner --no-privileges 2>/dev/null \
  | gzip | enc > "$BACKUP_DIR/daily/supabase_${DATE}.sql.gz.gpg" || echo "    ! Supabase DB failed, skipping"

echo "  → Plane DB..."
PLANE_PG_PASS=$(docker exec plane-api-1 printenv POSTGRES_PASSWORD 2>/dev/null || echo "")
if [ -n "$PLANE_PG_PASS" ]; then
  docker exec -e PGPASSWORD="$PLANE_PG_PASS" plane-plane-db-1 pg_dump -U plane -d plane --no-owner --no-privileges 2>/dev/null \
    | gzip | enc > "$BACKUP_DIR/daily/plane_${DATE}.sql.gz.gpg" || echo "    ! Plane DB failed, skipping"
fi

echo "  → CosmicStar DB..."
docker exec cosmicstar-db pg_dump -U postgres -d cosmicstar --no-owner --no-privileges 2>/dev/null \
  | gzip | enc > "$BACKUP_DIR/daily/cosmicstar_${DATE}.sql.gz.gpg" || echo "    ! CosmicStar DB failed, skipping"

echo "  → Frappe CRM DB + site_config..."
if docker inspect underwings-frappe-db >/dev/null 2>&1; then
  FR_DB=$(docker exec underwings-frappe cat sites/crm.underwings.org/site_config.json 2>/dev/null | grep -oE '"db_name": *"[^"]+"' | cut -d'"' -f4)
  FR_ROOT_PW=$(grep -E '^DB_ROOT_PASSWORD=' /home/deployer/underwings/frappe/.env | cut -d= -f2-)
  if [ -n "$FR_DB" ] && [ -n "$FR_ROOT_PW" ]; then
    docker exec underwings-frappe-db mariadb-dump -u root -p"$FR_ROOT_PW" "$FR_DB" --single-transaction --no-tablespaces 2>/dev/null \
      | gzip | enc > "$BACKUP_DIR/daily/frappe_${DATE}.sql.gz.gpg" || echo "    ! Frappe DB failed, skipping"
    docker exec underwings-frappe tar czf - -C sites/crm.underwings.org site_config.json 2>/dev/null \
      | enc > "$BACKUP_DIR/daily/frappe_siteconfig_${DATE}.tar.gz.gpg" || true
  else echo "    ! Frappe db_name/root pw not resolved, skipping"; fi
else echo "    ! Frappe container not present, skipping"; fi

# ---------- MAIL / WEBMAIL ----------
echo "  → Stalwart mail data..."
if [ "$SKIP_BULK" -eq 1 ]; then
  echo "    ! Skipped this run (low disk)."
else
  # LOG and LOG.old.* are RocksDB's *debug* logs, not mail — 181 MB of them going
  # back to March, re-tarred nightly, and never read back on restore.
  # Worth keeping in perspective: that is only ~7 MB once gzipped (debug text
  # compresses ~25x), so this is housekeeping, not the fix. What actually bounds
  # the disk is the retention and the size cap above. Its real value is that the
  # LOG set grows without limit and would otherwise be carried forever.
  tar czf - -C /home/deployer/underwings/stalwart \
      --exclude='data/LOG' --exclude='data/LOG.old.*' \
      data/ config/ 2>/dev/null \
    | enc > "$BACKUP_DIR/daily/stalwart_${DATE}.tar.gz.gpg" || true
  # Sunday's copy joins the weekly set by HARD LINK: same filesystem, so it costs
  # no extra space while both names exist, and the weekly survives when the daily
  # is pruned out from under it.
  if [ "$(date +%u)" -eq 7 ] && [ -s "$BACKUP_DIR/daily/stalwart_${DATE}.tar.gz.gpg" ]; then
    ln -f "$BACKUP_DIR/daily/stalwart_${DATE}.tar.gz.gpg" \
          "$BACKUP_DIR/weekly/stalwart_${DATE}.tar.gz.gpg" && echo "    → promoted to weekly"
  fi
fi

echo "  → Roundcube DB..."
if [ -d "/home/deployer/underwings/roundcube/db" ]; then
  tar czf - -C /home/deployer/underwings/roundcube db/ 2>/dev/null \
    | enc > "$BACKUP_DIR/daily/roundcube_${DATE}.tar.gz.gpg" || true
fi

# ---------- FILE / OBJECT STORAGE (was the backup gap) ----------
echo "  → Frappe uploaded files (attachments)..."
docker run --rm -v frappe_sites:/s:ro alpine tar czf - -C /s \
  crm.underwings.org/public/files crm.underwings.org/private/files 2>/dev/null \
  | enc > "$BACKUP_DIR/daily/frappe_files_${DATE}.tar.gz.gpg" || echo "    ! Frappe files failed, skipping"

echo "  → Plane uploads (MinIO)..."
docker run --rm -v plane_uploads:/u:ro alpine tar czf - -C /u . 2>/dev/null \
  | enc > "$BACKUP_DIR/daily/plane_uploads_${DATE}.tar.gz.gpg" || echo "    ! Plane uploads failed, skipping"

echo "  → Underwings Supabase storage objects..."
tar czf - -C /home/deployer/underwings/supabase/volumes storage 2>/dev/null \
  | enc > "$BACKUP_DIR/daily/underwings_storage_${DATE}.tar.gz.gpg" || echo "    ! Underwings storage failed, skipping"

echo "  → CosmicStar Supabase storage objects..."
docker run --rm -v mycosmicstar_storage-data:/st:ro alpine tar czf - -C /st . 2>/dev/null \
  | enc > "$BACKUP_DIR/daily/cosmicstar_storage_${DATE}.tar.gz.gpg" || echo "    ! CosmicStar storage failed, skipping"

# Krayin/Keila/Seafile/PitStack/AFFiNE/Akaunting — all removed; steps deleted.


# AKL system / AKL real — removed 2026-09-15 (final archive: backups/manual/akl-final-2026-09-15.tar.gz.gpg).

# Remove empty artifacts (failed steps) then rotate (also via EXIT trap)
find "$BACKUP_DIR/daily" -name "*_${DATE}*" -empty -delete 2>/dev/null || true
cleanup

TOTAL=$(du -sh "$BACKUP_DIR/daily/" 2>/dev/null | cut -f1)
COUNT=$(ls "$BACKUP_DIR/daily/"*_${DATE}* 2>/dev/null | wc -l)
echo "[$(date)] Backup complete (encrypted): ${COUNT} files, dir size: ${TOTAL}"
