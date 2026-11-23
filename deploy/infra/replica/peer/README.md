## Live peer operation

The restore image can also run Town's `tm_mapapp` submit and lookup path.
Set the following in the restore command's environment to enable live mode:

| Setting | Value |
| --- | --- |
| `MAPAPP_PEER_ORIGIN` | The operator's HTTPS overlay origin when participating in SHIP fanout |
| `MAPAPP_PEER_STACK_ORIGIN` | An operator-selected 1sat-stack origin with Chaintracks and Arcade relay configured |
| `MAPAPP_PEER_STACK_BUILD` | The verified build identifier of that Stack |
| `MAPAPP_PEER_ALLOW_PRIVATE_STACK_HTTP` | `true` only for an intentionally selected private container or loopback HTTP origin |

With those settings the peer accepts BRC-22 `POST /submit` and uses the
stock Engine SPV, public MapApp admission rules and Stack Arcade relay.
Unconfirmed outputs can be queried through BRC-24 `POST /lookup` once
Arcade reports that the transaction has been observed on the network.
The peer refreshes proofs from its Stack and also upgrades evidence when
the confirmed source supplies a proof. The recovery snapshot still comes
from the verified confirmed corpus, and the parity receipt counts any
extra live membership separately.

Attach the operator's HTTPS proxy to port 8791 on the peer's Docker network.
It serves GET/HEAD `/snapshot` and forwards the supported BRC-22, BRC-24 and
GASP requests to the stock Engine. The optional `compose.loopback.yaml`
publishes that same port on host loopback for a host proxy. The raw Engine
binds to loopback inside the peer container. Both databases stay on the
private Docker network.

To enable outgoing SHIP fanout, supply `MAPAPP_PEER_WALLET_STORAGE_URL` for
the peer's own qualified HTTPS WalletStorageProvider, set
`MAPAPP_PEER_ADVERTISE_FUNDED=true` after verifying the retained operator
identity, and set
`MAPAPP_PEER_COMMAND='bun --no-env-file peer.ts --confirm-mainnet'`.
Existing or explicitly published advertisements for the peer's reachable
origin are needed for other operators to discover it for inbound delivery.
The restore command does not create advertisements during startup.
The bootstrap enables the `public-peer` Compose profile and provisions its
private discovery MongoDB when wallet storage is configured.

Without live settings the standalone restore serves its confirmed data and
returns HTTP 503 on `/submit`.
