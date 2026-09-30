# Moviq demo: Postgres, the Python ML service and the Node API (serving the built React app) in one
# container, for Hugging Face Spaces (Docker SDK). The database is baked in at build time and resets
# whenever the Space restarts, which suits a public demo.

# ── Build the React client and the API's production dependencies
FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY client/package.json client/package-lock.json client/
RUN cd client && npm ci
COPY client client
RUN cd client && npm run build
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev

# ── Runtime
FROM postgres:16-bookworm
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*
COPY --from=web /usr/local/bin/node /usr/local/bin/node

# Spaces run the container as uid 1000.
RUN useradd -m -u 1000 user
ENV HOME=/home/user \
    VENV=/home/user/venv \
    PGDATA=/home/user/pgdata \
    PATH=/home/user/venv/bin:/usr/lib/postgresql/16/bin:$PATH
USER user
WORKDIR /home/user/app

COPY --chown=user ml/requirements.txt ml/requirements.txt
RUN python3 -m venv $VENV && pip install --no-cache-dir -r ml/requirements.txt

COPY --chown=user ml ml
COPY --chown=user server/package.json server/package.json
COPY --chown=user server/src server/src
COPY --from=web --chown=user /app/server/node_modules server/node_modules
COPY --from=web --chown=user /app/client/dist client/dist

# Load the demo database into the image.
COPY --chown=user moviq.sql.gz /tmp/moviq.sql.gz
RUN initdb -U moviq --auth=trust -D "$PGDATA" >/dev/null \
 && pg_ctl -D "$PGDATA" -o "-k /tmp -c listen_addresses=127.0.0.1" -w start >/dev/null \
 && createdb -h /tmp -U moviq moviq \
 && gunzip -c /tmp/moviq.sql.gz | psql -q -v ON_ERROR_STOP=1 -h /tmp -U moviq moviq >/dev/null \
 && pg_ctl -D "$PGDATA" -m fast -w stop >/dev/null \
 && rm /tmp/moviq.sql.gz

COPY --chown=user start.sh start.sh
ENV DATABASE_URL=postgres://moviq@127.0.0.1:5432/moviq \
    ML_URL=http://127.0.0.1:8000 \
    PORT=7860 \
    NODE_ENV=production \
    TMDB_REGION=IN
EXPOSE 7860
CMD ["sh", "start.sh"]
