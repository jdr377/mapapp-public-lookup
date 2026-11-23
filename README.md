# MapApp public recovery

Restore the confirmed public MapApp topic from a discoverable peer. The
receiver reconstructs record lookup from public transactions and their
evidence. It reports unavailable originals and proof gaps in its receipt.

## Restore

On Linux with Git, Docker Compose, curl and OpenSSL:

```sh
git clone --branch public-recovery-v1 https://github.com/jdr377/mapapp-public-lookup.git
cd mapapp-public-lookup
sh deploy/infra/replica/peer/restore.sh
```

Read the [restore script](deploy/infra/replica/peer/restore.sh),
[Compose definition](deploy/infra/replica/peer/compose.yaml) and
[Dockerfile](deploy/infra/replica/peer/Dockerfile) before running the command.
The image contains the public MapApp validators, an evidence receipt store,
and the stock overlay peer. It discovers peers through SHIP/SLAP, with Town as fallback. Use
`--peer-url URL` to select a specific peer or `--project NAME` for a
separate set of Docker volumes. The receipt is under
`deploy/.local/recovery/<project>/receipt.json`.

The snapshot's headers let an offline tool check consistency with the
supplied inclusion proofs. Use a trusted header set to independently
establish inclusion on the chain you follow. A snapshot can report which
original media files are currently available. That availability can change
under the source's retention policy.

## Release downloads

The [public recovery release](https://github.com/jdr377/mapapp-public-lookup/releases/tag/public-recovery-v1)
contains a fixed proof-bearing checkpoint at block 976547, plus the
versioned record-format and export fixtures. The checkpoint is useful for
offline verification and comparison. The live restore fetches the current
snapshot from its selected peer.

See [live peer operation](deploy/infra/replica/peer/README.md) for operators
who want to accept live submissions or enable public SHIP fanout.

[Lookup contract](LOOKUP.md) · [Public record format](FORMAT.md)
