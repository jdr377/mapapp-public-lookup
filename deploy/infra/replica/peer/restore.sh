#!/bin/sh
set -eu

tooling=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$tooling/../../.." && pwd)
project=mapapp-recovery
source=
topic=
network=
fallback=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project|--peer-url|--network|--topic)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { printf 'Value required for %s\n' "$1" >&2; exit 2; }
      case "$1" in
        --project) project=$2 ;;
        --peer-url) source=$2 ;;
        --network) network=$2 ;;
        --topic) topic=$2 ;;
      esac
      shift 2 ;;
    *) printf '%s\n' 'Usage: restore.sh [--topic tm_mapapp | --peer-url URL] [--project NAME] [--network DOCKER_NETWORK]' >&2; exit 2 ;;
  esac
done
case "$project" in
  ""|[-_]*|*[!a-z0-9_-]*) printf '%s\n' 'Invalid Compose project name.' >&2; exit 2 ;;
esac
if [ -z "$topic" ] && [ -z "$source" ]; then
  topic=tm_mapapp
  fallback=https://dev.town.space
fi
if [ -n "$topic" ]; then
  if [ "$topic" != tm_mapapp ] || [ -n "$source" ]; then
    printf '%s\n' 'Use --topic tm_mapapp without --peer-url for discovery.' >&2
    exit 2
  fi
else
  source=${source%/}
  case "$source" in
    http://?*|https://?*) ;;
    *) printf '%s\n' 'Peer URL must start with http:// or https://.' >&2; exit 2 ;;
  esac
fi
check_snapshot() {
  if ! curl --fail --silent --show-error --head --max-time 30 --output /dev/null "$1/snapshot"; then
    printf 'Recovery snapshot unavailable at %s/snapshot\n' "$1" >&2
    return 1
  fi
}
if [ -z "$topic" ] && [ -z "$network" ]; then
  check_snapshot "$source"
fi
if [ -z "$network" ]; then
  network="$project-egress"
  docker network inspect "$network" >/dev/null 2>&1 || docker network create "$network" >/dev/null
fi
work="$root/.local/recovery/$project"
umask 077
mkdir -p "$work"
printf 'Restore workspace: %s\n' "$work"
# Keep the image context separate from credentials and older restore workspaces.
image="$work/image"
mkdir -p "$image"
cp "$root/package.json" "$root/bun.lock" "$image/"
cp -R "$root/server" "$root/shared" "$image/"
cp "$tooling/Dockerfile" "$tooling/.dockerignore" "$image/"
cp "$tooling/peer.ts.in" "$image/peer.ts"
cp "$tooling/compose.yaml" "$tooling/peer-mongo-init.js" "$tooling/peer-schema.sql" "$work/"
tr -d '\r' < "$tooling/peer-init.sh" > "$work/peer-init.sh"
if [ -n "$topic" ]; then
  export MAPAPP_PEER_IMAGE="$project-recovery:local"
  printf 'Discovering a recovery peer for %s\n' "$topic"
  docker build --tag "$MAPAPP_PEER_IMAGE" "$image"
  if source=$(docker run --rm -i --network "$network" --entrypoint bun "$MAPAPP_PEER_IMAGE" \
    --no-env-file run - --select < "$tooling/discover-peer.ts" 2> "$work/discovery.json"); then
    printf 'Discovered recovery peer: %s\n' "$source"
  elif [ -n "$fallback" ]; then
    printf 'Discovery found no usable recovery peer. Trying %s.\n' "$fallback" >&2
    source=$fallback
    check_snapshot "$source"
  else
    cat "$work/discovery.json" >&2
    exit 1
  fi
fi
sh "$tooling/bootstrap-peer.sh" "$project" "$source" "$network" "$work"
export MAPAPP_RECORD_SOURCE="$source" MAPAPP_LINK_NETWORK="$network"
docker compose --project-directory "$work" -p "$project" -f "$work/compose.yaml" \
  exec -T peer bun run - < "$tooling/restore-receipt.ts.in" > "$work/receipt.next"
mv "$work/receipt.next" "$work/receipt.json"
cat "$work/receipt.json"
