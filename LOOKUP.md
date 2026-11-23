# MapApp public lookup contract

The recovery checkpoint covers 175 confirmed mainnet outpoints in `tm_mapapp` through block 976547. The block hash is `00000000000000000afaa872f5a388580912349ffd49c5525369b338699bb66d`. Canonical outpoint IDs are lowercase 64-digit transaction IDs followed by a dot and the decimal output index.

## Discover records

Send JSON `{"version":1,"since":0,"limit":100}` to `POST https://dev.town.space/requestSyncResponse` with `Content-Type: application/json` and `X-BSV-Topic: tm_mapapp`. Read `UTXOList` entries as `txid`, `outputIndex`, and `score`. On a full page, use the largest score as the next `since` and deduplicate by canonical outpoint. Stop at a short page. If a full page cannot advance the score, report enumeration as incomplete. This feed lists the peer's advertisements and may include entries outside the proven checkpoint.

## Look up an advertised output

Send `{"service":"ls_mapapp","query":{"txid":"<lowercase 64-digit txid>"}}` as JSON to `POST https://dev.town.space/lookup`. For an HTTP 200 `output-list` response, find the advertised output index and verify that its BEEF binds the subject transaction ID and contains that output. Track block inclusion separately when the BEEF lacks a proof. A valid query with an empty output list means the peer returned no matching outputs. HTTP 400 means the query is invalid. A transport failure or server error leaves the lookup unresolved.

## Verify the fixed checkpoint

Download [mapapp-agent-exit-v1.tar.gz](https://github.com/jdr377/mapapp-public-lookup/releases/download/public-recovery-v1/mapapp-agent-exit-v1.tar.gz). Its SHA-256 is `633a460f496c74ad3f36d2ebae5c3d89339d4b38e1f6fbbbcb5632f81bc92fba`. On a clean Docker host, verify the checksum, extract into an empty directory, check `sha256sum -c SHA256SUMS`, and follow the included `RECORDS-README.md` to build the reader and run the unattended acceptance test. No seed transaction IDs are needed. Expect 175 records across the paginated fixture, exact and empty lookup behavior, and export verification against the captured headers. Report live endpoint observations separately from the fixed checkpoint receipt.

[Metanet overlay build guide](https://metanet.fyi/overlays/build) · [Interoperability integration guide](https://metanet.fyi/interoperability/integrate)
