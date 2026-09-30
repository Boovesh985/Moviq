#!/bin/sh
# Starts Postgres, the ML service and the API. The API is the container's main process; if the ML
# service is still loading (or down), the site keeps working with simpler rankings.
set -e

# Sessions only need to survive as long as the container, so a fresh secret per start is fine.
# Set JWT_SECRET as a Space secret to keep people signed in across restarts.
if [ -z "$JWT_SECRET" ]; then
  JWT_SECRET=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
  export JWT_SECRET
fi

pg_ctl -D "$PGDATA" -o "-k /tmp -c listen_addresses=127.0.0.1" -l /tmp/postgres.log -w start

(cd ml && python3 -m uvicorn main:app --host 127.0.0.1 --port 8000) &

cd server
exec node src/index.js
