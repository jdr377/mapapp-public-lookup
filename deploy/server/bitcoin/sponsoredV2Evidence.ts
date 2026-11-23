import { isCanonicalPostCollection } from "../../shared/postCollection";
import { createHash } from "node:crypto";
import { AIP, B, B_PREFIX, BitCom, MAP, MAP_PREFIX } from "@1sat/templates";
import { Beef, Utils } from "@bsv/sdk";
import { geohashBounds, POST_GEOHASH_PATTERN as GEOHASH } from "../../shared/geohash";
import { MAPAPP_CATEGORY_TOKENS } from "../../shared/categories";
import { assertEvidenceLimit } from "./evidenceLimits";

const AIP_PREFIX = "15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva";
const TXID = /^[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;

export type SponsoredV2Root = {
  format: "mapapp_sponsored_v2";
  txid: string;
  vout: 0;
  outpoint: string;
  text: string;
  content: Uint8Array;
  contentType: "text/plain";
  contentLength: number;
  contentHash: string;
  category: string;
  collectionId?: string;
  geohash: string;
  latitude: number;
  longitude: number;
  destinationAddress: null;
  intentNonce: null;
  mediaSha256?: string;
};

export type SponsoredV2Reply = {
  kind: "reply";
  targetTxid: string;
  text: string;
  offchainMediaSha256?: string;
  sponsored: true;
};

export type SponsoredV2SignerEvidence = {
  readonly signerAddress: string;
  readonly algorithm: "BITCOIN_ECDSA";
  readonly signatureHex: string;
  readonly signedSemantics: Readonly<{ kind: "mapapp_sponsored_v2"; map: Readonly<Record<string, string>> }>;
  readonly provenance: Readonly<{
    protocol: typeof AIP_PREFIX;
    subjectTxid: string;
    vout: 0;
    signatureScope: "all_preceding_bitcom_fields";
    verifier: "@1sat/templates/AIP.verify";
  }>;
};

export type SponsoredV2EvidenceResult =
  | { ok: true; txid: string; signerAddress: string; root: SponsoredV2Root; signerEvidence: SponsoredV2SignerEvidence }
  | { ok: true; txid: string; signerAddress: string; reply: SponsoredV2Reply; signerEvidence: SponsoredV2SignerEvidence }
  | { ok: false; code: string };

export function validateSponsoredV2Evidence(input: {
  atomicBeef: Uint8Array;
  declaredSubjectTxid: string;
}): SponsoredV2EvidenceResult {
  try {
    assertEvidenceLimit("requestBytes", input.atomicBeef.byteLength);
    if (!TXID.test(input.declaredSubjectTxid)) return fail("subject_txid_mismatch");
    const beef = Beef.fromBinary(input.atomicBeef);
    if (!beef.atomicTxid) return fail("non_atomic_beef");
    if (beef.atomicTxid !== input.declaredSubjectTxid) return fail("subject_txid_mismatch");
    const tx = beef.findTxid(beef.atomicTxid)?.tx;
    if (!tx || tx.id("hex") !== beef.atomicTxid) return fail("subject_transaction_missing");
    assertEvidenceLimit("subjectInputs", tx.inputs.length);
    assertEvidenceLimit("subjectOutputs", tx.outputs.length);
    if (!beef.verifyValid(true).valid) return fail("malformed_beef");
    const output = tx.outputs[0];
    if (!output || output.satoshis !== 0) return fail("sponsored_protocol_shape_mismatch");
    const bitcom = BitCom.decode(output.lockingScript);
    if (!bitcom || !hasStandalonePrefix(bitcom) || bitcom.protocols.length !== 3 ||
      bitcom.protocols[0]?.protocol !== B_PREFIX || bitcom.protocols[1]?.protocol !== MAP_PREFIX ||
      bitcom.protocols[2]?.protocol !== AIP_PREFIX) return fail("sponsored_protocol_shape_mismatch");
    const text = B.decode(output.lockingScript);
    if (!text || text.mediaType !== "text/plain" || text.encoding !== "utf-8" || text.filename !== undefined) {
      return fail("sponsored_text_invalid");
    }
    const content = Uint8Array.from(text.data);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(content);
    if (!body || canonicalProtocol(B.text(body, "text/plain")) !== Utils.toHex(bitcom.protocols[0]!.script)) {
      return fail("sponsored_text_invalid");
    }
    const map = MAP.decode(output.lockingScript);
    if (!map || map.cmd !== "SET" || map.data.app !== "mapapp" || map.data.type !== "post" ||
      canonicalProtocol(MAP.set(map.data)) !== Utils.toHex(bitcom.protocols[1]!.script)) {
      return fail("sponsored_map_invalid");
    }
    const mediaSha256 = map.data.mediaSha256;
    if (mediaSha256 !== undefined && !HASH.test(mediaSha256)) return fail("sponsored_media_hash_invalid");
    const aips = AIP.decode(bitcom);
    if (aips.length !== 1 || aips[0]!.data.algorithm !== "BITCOIN_ECDSA" ||
      aips[0]!.data.fieldIndexes !== undefined || !aips[0]!.verify() ||
      canonicalProtocol(aips[0]!.lock()) !== Utils.toHex(bitcom.protocols[2]!.script)) {
      return fail("sponsored_signature_invalid");
    }
    const signerAddress = aips[0]!.data.address;
    const signerEvidence: SponsoredV2SignerEvidence = Object.freeze({
      signerAddress,
      algorithm: "BITCOIN_ECDSA",
      signatureHex: Utils.toHex(aips[0]!.data.signature),
      signedSemantics: Object.freeze({ kind: "mapapp_sponsored_v2", map: Object.freeze({ ...map.data }) }),
      provenance: Object.freeze({
        protocol: AIP_PREFIX,
        subjectTxid: beef.atomicTxid,
        vout: 0,
        signatureScope: "all_preceding_bitcom_fields",
        verifier: "@1sat/templates/AIP.verify",
      }),
    });
    if (map.data.context === "geohash") {
      const collectionId = map.data.collectionId;
      if (collectionId !== undefined && !isCanonicalPostCollection(collectionId)) return fail("sponsored_map_invalid");
      if (!exactMap(map.data, ["app", "type", "context", "contextValue", "category",
        ...(collectionId === undefined ? [] : ["collectionId"]), ...(mediaSha256 ? ["mediaSha256"] : [])])) return fail("sponsored_map_invalid");
      const geohash = map.data.contextValue!;
      const category = map.data.category!;
      const bounds = GEOHASH.test(geohash) ? geohashBounds(geohash) : null;
      if (!bounds) return fail("invalid_geospatial_fields");
      if (!MAPAPP_CATEGORY_TOKENS.includes(category as (typeof MAPAPP_CATEGORY_TOKENS)[number])) {
        return fail("sponsored_map_invalid");
      }
      return {
        ok: true,
        txid: beef.atomicTxid,
        signerAddress,
        root: {
          format: "mapapp_sponsored_v2",
          txid: beef.atomicTxid,
          vout: 0,
          outpoint: `${beef.atomicTxid}.0`,
          text: body,
          content,
          contentType: "text/plain",
          contentLength: content.byteLength,
          contentHash: sha256(content),
          category,
          ...(collectionId === undefined ? {} : { collectionId }),
          geohash,
          latitude: (bounds.south + bounds.north) / 2,
          longitude: (bounds.west + bounds.east) / 2,
          destinationAddress: null,
          intentNonce: null,
          ...(mediaSha256 ? { mediaSha256 } : {}),
        },
        signerEvidence,
      };
    }
    if (map.data.context === "tx") {
      if (!exactMap(map.data, mediaSha256
        ? ["app", "type", "context", "contextValue", "mediaSha256"]
        : ["app", "type", "context", "contextValue"])) return fail("sponsored_map_invalid");
      if (!TXID.test(map.data.contextValue ?? "")) return fail("sponsored_map_invalid");
      return {
        ok: true,
        txid: beef.atomicTxid,
        signerAddress,
        reply: {
          kind: "reply",
          targetTxid: map.data.contextValue!,
          text: body,
          sponsored: true,
          ...(mediaSha256 ? { offchainMediaSha256: mediaSha256 } : {}),
        },
        signerEvidence,
      };
    }
    return fail("sponsored_map_invalid");
  } catch {
    return fail("malformed_beef");
  }
}

function exactMap(data: Record<string, string>, keys: string[]): boolean {
  const actual = Object.keys(data);
  return actual.length === keys.length && keys.every((key, index) => actual[index] === key);
}

function hasStandalonePrefix(bitcom: NonNullable<ReturnType<typeof BitCom.decode>>): boolean {
  return bitcom.scriptPrefix.length === 1 && bitcom.scriptPrefix[0] === 0;
}

function canonicalProtocol(script: import("@bsv/sdk").Script): string {
  const decoded = BitCom.decode(script);
  return decoded?.protocols.length === 1 ? Utils.toHex(decoded.protocols[0]!.script) : "";
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(code: string): Extract<SponsoredV2EvidenceResult, { ok: false }> {
  return { ok: false, code };
}
