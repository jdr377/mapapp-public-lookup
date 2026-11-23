#!/bin/sh
set -eu
psql --set ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  --set peer_password="$PEER_FIXTURE_PG_USER_PASSWORD" <<'SQL'
CREATE ROLE peer_operator LOGIN PASSWORD :'peer_password';
GRANT USAGE ON SCHEMA public_publications TO peer_operator;
GRANT SELECT, INSERT ON public_publications.roots TO peer_operator;
GRANT SELECT ON public_publications.capacity TO peer_operator;
GRANT UPDATE (retained_rows,retained_bytes) ON public_publications.capacity TO peer_operator;
SQL
