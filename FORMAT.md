# MapApp public record format v4.0.0

This reference describes how to read the confirmed MapApp checkpoint at BSV mainnet height 976547. MapApp publication policy v4 identifies this profile. Public evidence and sample bytes are in the [Complete Artifact archive](https://github.com/jdr377/mapapp-public-lookup/releases/tag/complete-artifact-v1).

## Archive and identifiers

Verify the published archive checksum and SHA256SUMS before reading. In fixture.json, parse the UTF-8 JSON string at payload as JSON. Its rows contain txid, outputIndex, block, position, lookupBeef (base64 BEEF), proof (hex BUMP) and headerHash. Parse BEEF using a Bitcoin SDK and explicitly select the subject by txid. Recompute the txid from the exact transaction and use zero-based vout. Canonical reader IDs are lowercase 64-hex txid, a dot and decimal vout. A signed collection ID uses an underscore before vout. Convert only the delimiter when resolving it. Supplementary linked outputs use the same row shape in artifact-dependency-rows.json. Chain order is block height, transaction position, then vout.

## Scripts and fields

The canonical semantic script is zero satoshis and starts OP_FALSE OP_RETURN. Protocols are separated by a single push of the ASCII pipe byte. Interpret script pushes as bytes. Protocol prefixes and textual fields are UTF-8.

- B prefix is 19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut. It is followed by content bytes, MIME and encoding. Text uses text/plain and utf-8 with no filename. Preserve text bytes and whitespace.
- MAP prefix is 1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5. The next push is SET, followed by ordered UTF-8 key/value pairs. Canonical fields have no duplicate keys.
- AIP prefix is 15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva. The final AIP covers preceding BitCom content in that output. Its canonical profile uses BITCOIN_ECDSA, a signer address and a compact signature, without partial field indexes. AIP does not cover sibling outputs directly. The subject txid binds all sibling outputs.

Canonical root and reply statements use B, MAP, AIP in that order. Social actions use MAP, AIP. The common first MAP keys are app and type, with app=mapapp.

| Type | Subsequent MAP keys in order |
|---|---|
| post root | context=geohash, contextValue=lowercase geohash, category=UTF-8 token, then optional collectionId, then optional mediaSha256 |
| post reply | context=tx, contextValue=immediate parent txid, then optional mediaSha256 |
| hide | tx=root txid, then optional previousHide=prior Hide txid |
| freshen | tx=target txid, then optional afterHide=Hide txid |
| like or unlike | tx=target txid |
| follow or unfollow | bapId=public BAP identifier |
| upgrade | tx=target txid, then optional mediaSha256 |

Root and reply semantic output is vout 0. For a paid media post or on-chain media reply, vout 1 is a standalone B envelope with exact media bytes, MIME image/webp or video/webm and encoding binary. A genesis Lock follows the text or the media, as applicable. Freshen pairs with the immediately following Lock. A signed mediaSha256 resolves to a file named by the lowercase hex SHA-256 plus .media in the archive. Hash the raw file bytes.

A collection reference resolves to the specified output in the dependency transaction. The sample root uses an ordinal inscription envelope, marked by OP_FALSE OP_IF and the ord tag, with content type tag 1 and an empty push before the body. Decode the inscription at the referenced vout. Collection index eligibility and membership are separate from reading this reference.

## Historical data and version selection

There is no mandatory version field within these MAP layouts. Preserve ordered original fields and choose the reader profile by shape and the declared archive policy. Pre-v4 roots may lack collectionId. Absence means no signed collection reference. Older checkpoints can contain legacy layouts, so a decoder must preserve them and expose unknown or historical shapes explicitly. Current canonical admission belongs to the topic policy. Bare OP_RETURN does not meet the current canonical script prefix. Use the archive proof and subject bytes to establish what was actually present.

## Reader samples

All IDs below use canonical reader notation. Emit decoded type, text where present, ordered MAP fields, resolved reference IDs and media byte counts and SHA-256 where present.

| Case | Outpoint |
|---|---|
| Paid media root | 5bd358a17212d3b4176e56ac8531df75ac95c85c67fc4c2687cc3feeb54a91cd.0 |
| Reply | 64b51271d7256d39f57a3bb7c2f9512f9dcab356a03f9704aca2bdf11d3584b9.0 |
| Hide | 25e8215c046aa4cfa08b54db96af0fbd104720f8fde5403b40cedef615997928.0 |
| Freshen | 1f8ff5ff9cdf7e69b140f731051f4d26127eeddb4a675677a2e93d437220aac3.0 |
| Collection-linked root | 95bc5178ed55db21ee6d44ec280fe8396875713aa2cd1942ce2c88c5ebacad9d.0 |
| Referenced collection root | aaf510dc7cc4b5df05506631d077656499fb83f8567854a86af0a368975cb6a8.0 |
