#!/usr/bin/env bash
# Warm the server-rendered pages right after a deploy so the first real visitor
# never pays the cold-start cost (audit PERF-2: 20 s first render seen on the
# ADHICS page). Hits the 20 most-visited routes twice, via Cloudflare.
set -u
BASE=${1:-https://underwings.org}
ROUTES=(/ /services /services/offensive-security /services/grc /services/cloud-security /services/network-infrastructure /services/training-awareness /services/offensive-security/web-application-penetration-testing /services/offensive-security/network-penetration-testing /services/grc/iso-27001-implementation /services/grc/adhics-compliance /services/grc/uae-pdpl-advisory /services/cloud-security/microsoft-365-security-review /software /about /blog /book /privacy-policy /ar /updates)
for pass in 1 2; do for r in "${ROUTES[@]}"; do printf "%s %s\n" "$(curl -s -o /dev/null -w '%{http_code} %{time_total}' -A 'underwings-warmup' "$BASE$r")" "$r"; done; done | awk '{print}' | tail -n ${#ROUTES[@]}
