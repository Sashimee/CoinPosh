#!/bin/sh
set -eu

: "${AUTH_SECRET:?AUTH_SECRET is not set; add it to the Dokploy stack env.}"
: "${TURNSTILE_SECRET_KEY:?TURNSTILE_SECRET_KEY is not set; add it to the Dokploy stack env.}"

# wrangler's local runtime reads secrets from .dev.vars; passing them as --var would put them in ps.
umask 077
printf 'AUTH_SECRET=%s\nTURNSTILE_SECRET_KEY=%s\n' "$AUTH_SECRET" "$TURNSTILE_SECRET_KEY" > .dev.vars
unset AUTH_SECRET TURNSTILE_SECRET_KEY

pnpm exec wrangler d1 migrations apply coinposh --local --persist-to /data
exec pnpm exec wrangler dev --local --ip 0.0.0.0 --port 8787 --persist-to /data \
  --show-interactive-dev-session=false --live-reload=false
