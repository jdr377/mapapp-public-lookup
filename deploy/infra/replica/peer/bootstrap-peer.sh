#!/bin/sh
set -eu
cd "${4:-$(dirname "$0")}"
name=${1:?Compose project name required}
source=${2:?Recovery peer HTTP source required}
network=${3:?Docker link network required}
umask 077
chmod 0755 peer-init.sh
chmod 0644 peer-schema.sql
if [ ! -f .env ]; then
  for key in PG_OWNER PG_USER_PASSWORD MYSQL_OWNER MYSQL_PASSWORD SERVER_KEY ADMIN_TOKEN; do
    printf 'PEER_FIXTURE_%s=%s\n' "$key" "$(openssl rand -hex 32)" >> .env
  done
fi
if [ -n "${MAPAPP_PEER_WALLET_STORAGE_URL:-}" ]; then
  for key in MAPAPP_PEER_MONGO_ROOT_PASSWORD MAPAPP_PEER_MONGO_PASSWORD; do
    if ! grep -q "^${key}=" .env; then
      printf '%s=%s\n' "$key" "$(openssl rand -hex 32)" >> .env
    fi
  done
  export COMPOSE_PROFILES="public-peer${COMPOSE_PROFILES:+,$COMPOSE_PROFILES}"
fi
export MAPAPP_RECORD_SOURCE="$source" MAPAPP_LINK_NETWORK="$network"
docker compose -p "$name" up -d --build --wait
docker compose -p "$name" logs --no-color peer | grep MAPAPP_PEER_PARITY | tail -1
