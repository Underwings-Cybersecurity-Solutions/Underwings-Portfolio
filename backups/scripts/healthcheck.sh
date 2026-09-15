#!/bin/bash
# ===========================================
# UNDERWINGS — Health Check Monitor
# Checks all services every 5 minutes
# Sends alert email on failure
# ===========================================

set -uo pipefail

STATE_FILE="/tmp/uw-health-state"

# Credentials live in underwings/.env (gitignored) rather than in this file, so
# the script itself can be tracked in git. They are the ALERT_* set, not SMTP_*:
# (2026-09-15: ALERT_SMTP_* point at the Brevo relay, not localhost:465. Stalwart
# still treats underwings.org as a local domain, so alerts submitted to it were
# filed into its own dead mailboxes after the Zoho MX cutover — never sent.)
# this script runs on the HOST via cron, where the container-network hostname
# used by SMTP_HOST would not resolve.
ENV_FILE="/home/deployer/underwings/.env"
env_val() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"'; }

ALERT_EMAIL=$(env_val ALERT_EMAIL)
FROM_EMAIL=$(env_val ALERT_FROM_EMAIL)
SMTP_HOST=$(env_val ALERT_SMTP_HOST)
SMTP_PORT=$(env_val ALERT_SMTP_PORT)
SMTP_USER=$(env_val ALERT_SMTP_USER)
SMTP_PASS=$(env_val ALERT_SMTP_PASS)

# Say so loudly rather than failing silently: a health check that cannot send
# mail still writes its findings to the log, but nobody is being told.
if [ -z "$ALERT_EMAIL" ] || [ -z "$SMTP_PASS" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S UTC')] WARNING: ALERT_* not readable from ${ENV_FILE} — checks will run but NO ALERTS WILL BE SENT"
fi

FAILURES=""

# Sends one alert; returns non-zero if delivery failed.
#
# Delivery failure has to be LOUD. The previous version invoked swaks with
# `--silent 2>/dev/null` and never inspected the exit status, so when the SMTP
# credentials went stale every alert failed invisibly while the log cheerfully
# recorded "ALERT SENT". swaks exits 28 on an auth rejection, so the status is
# perfectly usable — it was simply thrown away.
send_mail() {
  local subject="$1" body="$2" out rc
  if [ -z "$ALERT_EMAIL" ] || [ -z "$SMTP_PASS" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S UTC')] MAIL NOT SENT: alert credentials missing from ${ENV_FILE}"
    return 1
  fi
  # 465 = implicit TLS (Stalwart's submissions port); anything else, e.g. the
  # Brevo relay on 2525, is plain SMTP upgraded with STARTTLS. Never send the
  # credentials in the clear: swaks --tls fails if STARTTLS is unavailable.
  local tls_flag="--tls"
  [ "$SMTP_PORT" = "465" ] && tls_flag="--tls-on-connect"
  out=$(swaks --to "$ALERT_EMAIL" \
    --from "$FROM_EMAIL" \
    --server "$SMTP_HOST" \
    --port "$SMTP_PORT" \
    "$tls_flag" \
    --auth PLAIN \
    --auth-user "$SMTP_USER" \
    --auth-password "$SMTP_PASS" \
    --header "Subject: $subject" \
    --body "$body" \
    --timeout 15 2>&1)
  rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S UTC')] MAIL DELIVERY FAILED (swaks rc=${rc}): $(printf '%s' "$out" | grep -oE '\b[45][0-9]{2} [^\"]*' | head -1)"
    return 1
  fi
  return 0
}

# ── Substring test for a response body ──────
# Bash-native on purpose. The obvious `printf '%s' "$body" | grep -qF -- "$m"`
# is broken under this script's `set -o pipefail`: grep -q exits the instant it
# matches, so on a body larger than the 64 KB pipe buffer printf is still
# writing when the read end closes, dies of SIGPIPE (141), and pipefail promotes
# that 141 to the PIPELINE's status. The marker was found and the check still
# reports it missing. That cost 349 false Academy alarms in August 2026 (~700
# emails) against a page nginx logged as a full, correct 200.
# `[[ == ]]` forks nothing and reads nothing, so there is no race to lose. The
# right-hand side is quoted, which makes the marker a LITERAL — do not unquote
# it, or a marker containing * or ? silently becomes a glob.
body_contains() {
  [[ "$1" == *"$2"* ]]
}

# ── Disk trend: days until full, or "" ──────
# Re-baselines only every 6h, because over a 5-minute window normal churn
# projects to nonsense like "full in 2 days".
#
# The projection is PERSISTED alongside the baseline, and that is the whole
# point. The previous version computed it only on the run that re-baselined, so
# 71 runs out of every 72 reported no disk warning at all: the failure signature
# went warning -> empty -> warning and the script mailed an ALERT plus a
# RECOVERED every six hours while the disk sat at a flat 83%. A projection is a
# slow-moving fact, so it has to survive between re-baselines or it flaps by
# construction.
#
# A re-baseline that finds the disk no longer shrinking clears the stored
# projection rather than carrying a stale one forward.
disk_trend_days() {
  local now="$1" avail="$2" file="$3"
  local old_epoch old_avail last_days elapsed lost
  last_days=""
  if [ -r "$file" ]; then
    # A 2-field file written by an older version simply leaves last_days empty.
    read -r old_epoch old_avail last_days < "$file" 2>/dev/null || true
    elapsed=$(( now - ${old_epoch:-0} ))
    if [ "$elapsed" -ge 21600 ] && [ "${old_avail:-0}" -gt 0 ]; then
      lost=$(( old_avail - avail ))
      if [ "$lost" -gt 0 ]; then
        last_days=$(( avail * elapsed / lost / 86400 ))
      else
        last_days=""
      fi
      printf '%s %s %s\n' "$now" "$avail" "$last_days" > "$file"
    fi
  else
    printf '%s %s %s\n' "$now" "$avail" "" > "$file"
  fi
  printf '%s' "${last_days:-}"
}

# ── Check HTTP endpoint ─────────────────────
check_url() {
  local name="$1" url="$2" expected="${3:-200}"
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null)
  if [ "$code" != "$expected" ]; then
    FAILURES="${FAILURES}FAIL: ${name} — got HTTP ${code}, expected ${expected} (${url})\n"
  fi
}

# ── Check HTTP endpoint AND its body ────────
# A status code alone is not evidence for SPA hosts: the CRM's nginx falls back
# to /index.html via try_files, so EVERY path returns 200 — including the dead
# Frappe endpoint this script used to probe. Assert on a content marker instead.
check_url_body() {
  local name="$1" url="$2" marker="$3"
  shift 3
  local body
  body=$(curl -s --max-time 10 "$@" "$url" 2>/dev/null)
  if [ $? -ne 0 ]; then
    FAILURES="${FAILURES}FAIL: ${name} — request failed (${url})\n"
  elif ! body_contains "$body" "$marker"; then
    FAILURES="${FAILURES}FAIL: ${name} — response did not contain '${marker}' (${url})\n"
  fi
}

# ── Check Docker container ──────────────────
check_container() {
  local name="$1"
  local status
  status=$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)
  if [ "$status" != "true" ]; then
    FAILURES="${FAILURES}FAIL: Container ${name} is not running\n"
  fi
}

# ── Public endpoints ────────────────────────
check_url "Website"       "https://underwings.org"               "200"
check_url "Admin"         "https://underwings.org/admin/"        "200"
check_url "Plane PM"      "https://plan.underwings.org"          "200"
check_url "Uptime Kuma"   "https://status.underwings.org"        "302"

# Assert on a content marker, not a bare 200 — a misconfigured vhost or a
# fallback page would still answer 200. "Ask about training" is the CTA, so if
# it is missing the page is not doing its one job.
# "View course" renders once per course row, so it is present only when the
# catalog actually fetched courses from the database. It replaced the holding
# page's "Ask about training", which now appears ONLY in the empty state — a
# marker that would have gone green precisely when the catalog was broken.
# Do not swap this for brand or nav text: a page whose data fetch failed still
# renders the header, the footer and the wordmark.
check_url_body "Academy"  "https://academy.mycosmicstar.com/"    "View course"

# ── CRM (crm.underwings.org) ────────────────
# 1. the SPA container is actually serving (not just any 200 from try_files)
check_url_body "CRM app"   "https://crm.underwings.org/healthz" "underwings-crm ok"
# 2. the SPA shell still ships its entry script
check_url_body "CRM shell" "https://crm.underwings.org/"        "crm-pipeline-strip"
# 3. the whole data plane — nginx -> kong -> postgrest -> postgres — answers,
#    AND RLS still denies anon. An empty array is the correct, secure answer;
#    rows here would mean the CRM's customer data had become world-readable.
ANON_KEY_VAL=$(grep -E '^ANON_KEY=' /home/deployer/underwings/.env 2>/dev/null | cut -d= -f2-)
if [ -n "${ANON_KEY_VAL}" ]; then
  CRM_ANON=$(curl -s --max-time 10 -H "apikey: ${ANON_KEY_VAL}" \
    "https://crm.underwings.org/rest/v1/crm_deals?select=id&limit=1" 2>/dev/null)
  if [ "${CRM_ANON}" != "[]" ]; then
    FAILURES="${FAILURES}FAIL: CRM data plane — expected '[]' from anon read, got: ${CRM_ANON}\n"
  fi
else
  FAILURES="${FAILURES}WARN: CRM data plane — ANON_KEY not readable from .env, check skipped\n"
fi

# ── Core containers ─────────────────────────
for c in underwings-nginx underwings-frontend underwings-admin \
         underwings-db underwings-kong underwings-auth underwings-rest \
         underwings-crm \
         underwings-mail underwings-webmail; do
  check_container "$c"
done

# ── Disk space: level AND trend ─────────────
# A bare threshold is a lagging signal — it fires at 85% and tells you nothing
# about how fast you are moving. Projecting days-to-full from a >=6h baseline is
# what actually distinguishes "stable at 86%" from "full by month end".
DISK_PCT=$(df / --output=pcent | tail -1 | tr -d ' %')
DISK_AVAIL_KB=$(df -P / | awk 'NR==2 {print $4}')
TREND_FILE="/tmp/uw-disk-trend"
NOW_EPOCH=$(date +%s)

DAYS_LEFT=$(disk_trend_days "$NOW_EPOCH" "$DISK_AVAIL_KB" "$TREND_FILE")
if [ -n "$DAYS_LEFT" ] && [ "$DAYS_LEFT" -lt 21 ]; then
  FAILURES="${FAILURES}WARN: Disk projected full in ~${DAYS_LEFT} days (now ${DISK_PCT}%)\n"
fi

if [ "$DISK_PCT" -gt 85 ]; then
  FAILURES="${FAILURES}WARN: Disk usage at ${DISK_PCT}%\n"
fi

# ── Memory (alert if available <500MB) ──────
AVAIL_MB=$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo)
if [ "$AVAIL_MB" -lt 500 ]; then
  FAILURES="${FAILURES}WARN: Available memory only ${AVAIL_MB}MB\n"
fi

# ── Evaluate results ────────────────────────
# State keys on a SIGNATURE of the failure SET, not a flat ok/fail.
#
# Why: the old flat flag meant any chronic warning pinned the state at "fail", so
# every genuinely NEW failure logged "STILL FAILING" and sent no email. Disk sat
# above 85% on 17 separate days from 2026-05-21 and the tally was 3,934 alerts
# suppressed against 2 delivered — a site could have gone down silently.
#
# Hashing the set keeps a persistent warning quiet while still alerting the
# moment the set CHANGES. Percentages, megabytes and day counts are normalised
# out so 86%→87% is not mistaken for a new event.
PREV_STATE=$(cat "$STATE_FILE" 2>/dev/null || echo "ok")
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S UTC')

if [ -n "$FAILURES" ]; then
  # sort makes the signature order-independent, so the same set of problems
  # reported in a different order is not mistaken for a new incident.
  CURR_STATE=$(printf '%b' "$FAILURES" \
    | sed -E 's/[0-9]+%/N%/g; s/[0-9]+MB/NMB/g; s/~[0-9]+ days/~N days/g' \
    | sort | md5sum | cut -d' ' -f1)

  # Alert whenever the failure SET changes — not merely on the first failure.
  if [ "$PREV_STATE" != "$CURR_STATE" ]; then
    SUBJECT="⚠ Underwings Alert — Service Issue Detected"
    BODY="Health check failed at ${TIMESTAMP}\n\n$(echo -e "$FAILURES")\n\nCheck: ssh deployer@143.244.135.89\nDashboard: https://underwings.org/admin/"

    if send_mail "$SUBJECT" "$(echo -e "$BODY")"; then
      # Commit the new signature ONLY once someone has actually been told.
      echo "$CURR_STATE" > "$STATE_FILE"
      echo "[$TIMESTAMP] ALERT SENT: $(echo -e "$FAILURES" | tr '\n' ' ')"
    else
      # Deliberately leave the old state in place. Committing it here would mark
      # this incident as already-reported, and the next run would see an
      # unchanged signature and stay quiet — losing the alert permanently.
      echo "[$TIMESTAMP] ALERT UNDELIVERED, will retry next run: $(echo -e "$FAILURES" | tr '\n' ' ')"
    fi
  else
    echo "[$TIMESTAMP] STILL FAILING: $(echo -e "$FAILURES" | tr '\n' ' ')"
  fi
else
  # Recovery: all-clear if the previous state was anything other than healthy.
  # Compares against "ok" rather than the literal "fail" the old flat flag used,
  # since the state file now holds a signature hash.
  if [ "$PREV_STATE" != "ok" ]; then
    SUBJECT="✓ Underwings Recovered — All Services Healthy"
    BODY="All services recovered at ${TIMESTAMP}\n\nAll endpoints responding normally."

    if send_mail "$SUBJECT" "$(echo -e "$BODY")"; then
      echo "[$TIMESTAMP] RECOVERED — all services healthy"
    else
      echo "[$TIMESTAMP] RECOVERED — all services healthy (recovery notice undelivered)"
    fi
  fi
  echo "ok" > "$STATE_FILE"
fi
