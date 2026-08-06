#!/usr/bin/env bash
# cf-publish-outreach-dns.sh — publish DNS for the Phase H cold-outreach
# sending subdomain outreach.underwings.org to Cloudflare.
#
# Idempotent: creates each record, or updates it if a record of the same
# type+name already exists. All records are DNS-only (grey-cloud) — mail
# MUST NOT be proxied.
#
# Requires a scoped token (Zone:DNS:Edit on underwings.org) in CF_API_TOKEN.
# The token is NEVER written to disk — pass it transiently:
#
#   CF_API_TOKEN=xxxx bash scripts/cf-publish-outreach-dns.sh
#
set -euo pipefail

: "${CF_API_TOKEN:?set CF_API_TOKEN (scoped Zone:DNS:Edit token)}"
ZONE_ID="81826ee1f0b642162d025e37f906c95a"   # underwings.org
API="https://api.cloudflare.com/client/v4"
AUTH=(-H "Authorization: Bearer ${CF_API_TOKEN}" -H "Content-Type: application/json")

# DKIM public keys (from Stalwart /api/dns/records, generated 2026-05-28)
RSA_DKIM='v=DKIM1; k=rsa; h=sha256; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzQigoGaLzr53ROGyOYlNWZUupVLlVQas4210mqo7nwoeOZXq4YxTyTkLWtm9qxHLenrP661KvHQ4kjrEXIYqzOOJNQNwDu0oZ0IspHj7pEW0dbKTdnnSLQ4YEutiGGkORL+VjmqioLLmtLTanOWxhla/Tq64yzKuWGQm2WwD1ced0qjpjvWgUDDfE4OZxtSLuooweGp9GnPIxKMHC+0tOF9boIZylr86hgxa+lDxjJh7mj6ngwjCXct5zs954oi+i8mG+2Vt0hU3L4IEtenZX5ST/gqepdx9Ns86fy67+UCVpL/vrWwAapv+LQdBZrGTJ2aGhlMnGjmHAJ1Rn/NxMQIDAQAB'
ED_DKIM='v=DKIM1; k=ed25519; h=sha256; p=3vfkXtpLwxCy3Wt9kuLZlmoFFn9lPRel8xvKchFdcTs='

# upsert <type> <fqdn> <content-json-fragment> [extra-json]
upsert() {
  local rtype="$1" name="$2" body="$3"
  local existing id
  existing=$(curl -s "${AUTH[@]}" "${API}/zones/${ZONE_ID}/dns_records?type=${rtype}&name=${name}")
  id=$(echo "$existing" | python3 -c 'import sys,json;r=json.load(sys.stdin).get("result",[]);print(r[0]["id"] if r else "")')
  if [[ -n "$id" ]]; then
    echo "  update ${rtype} ${name}"
    curl -s "${AUTH[@]}" -X PUT "${API}/zones/${ZONE_ID}/dns_records/${id}" -d "$body" \
      | python3 -c 'import sys,json;d=json.load(sys.stdin);print("    ok" if d.get("success") else "    FAIL "+json.dumps(d.get("errors")))'
  else
    echo "  create ${rtype} ${name}"
    curl -s "${AUTH[@]}" -X POST "${API}/zones/${ZONE_ID}/dns_records" -d "$body" \
      | python3 -c 'import sys,json;d=json.load(sys.stdin);print("    ok" if d.get("success") else "    FAIL "+json.dumps(d.get("errors")))'
  fi
}

echo "Publishing outreach.underwings.org DNS (grey-cloud)…"

upsert A   outreach.underwings.org \
  '{"type":"A","name":"outreach.underwings.org","content":"143.244.135.89","ttl":3600,"proxied":false}'

upsert MX  outreach.underwings.org \
  '{"type":"MX","name":"outreach.underwings.org","content":"mail.underwings.org","priority":10,"ttl":3600}'

upsert TXT outreach.underwings.org \
  '{"type":"TXT","name":"outreach.underwings.org","content":"v=spf1 mx include:spf.brevo.com ~all","ttl":3600}'

upsert TXT uw2026._domainkey.outreach.underwings.org \
  "$(python3 -c 'import json,sys;print(json.dumps({"type":"TXT","name":"uw2026._domainkey.outreach.underwings.org","content":sys.argv[1],"ttl":3600}))' "$RSA_DKIM")"

upsert TXT uw2026e._domainkey.outreach.underwings.org \
  "$(python3 -c 'import json,sys;print(json.dumps({"type":"TXT","name":"uw2026e._domainkey.outreach.underwings.org","content":sys.argv[1],"ttl":3600}))' "$ED_DKIM")"

upsert TXT _dmarc.outreach.underwings.org \
  '{"type":"TXT","name":"_dmarc.outreach.underwings.org","content":"v=DMARC1; p=quarantine; rua=mailto:postmaster@outreach.underwings.org; ruf=mailto:postmaster@outreach.underwings.org; fo=1","ttl":3600}'

upsert TXT _smtp._tls.outreach.underwings.org \
  '{"type":"TXT","name":"_smtp._tls.outreach.underwings.org","content":"v=TLSRPTv1; rua=mailto:postmaster@outreach.underwings.org","ttl":3600}'

echo "Done. Verify with: dig +short TXT outreach.underwings.org @1.1.1.1"
