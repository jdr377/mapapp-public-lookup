import { isCanonicalPostCollection } from "../../shared/postCollection";
import { createHash } from "node:crypto";
import { AIP, B, B_PREFIX, BitCom, Lock, MAP, MAP_PREFIX } from "@1sat/templates";
import { Beef, Script, Transaction, Utils } from "@bsv/sdk";
import { geohashBounds, POST_GEOHASH_PATTERN as GEOHASH } from "../../shared/geohash";
import { MAPAPP_CATEGORY_TOKENS } from "../../shared/categories";
import { EvidenceLimitError, assertEvidenceLimit } from "./evidenceLimits";
import { MEDIA_RELAY_SAFE_MAX_BYTES } from "../../shared/mediaLimits";

const AIP_PROTOCOL = "15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva";
const MAP_KEYS = ["app", "type", "context", "contextValue", "category"] as const;
const SUPPORTED_MEDIA = new Set(["image/webp", "video/webm"]);

export type PostV2RejectionCode =
  | `evidence_budget_${string}`
  | "malformed_beef"
  | "non_atomic_beef"
  | "subject_txid_mismatch"
  | "ambiguous_beef_ancestry"
  | "subject_transaction_missing"
  | "subject_txid_invalid"
  | "post_candidate_missing"
  | "v2_protocol_shape_mismatch"
  | "v2_map_fields_invalid"
  | "v2_text_invalid"
  | "v2_media_invalid"
  | "v2_lock_invalid"
  | "invalid_geospatial_fields"
  | "actor_proof_missing"
  | "actor_proof_multiple"
  | "actor_algorithm_unsupported"
  | "actor_partial_signature_unsupported"
  | "actor_signature_invalid"
  | "browser_diagnostic_mismatch";

export type DerivedPostV2 = {
  format: "mapapp_post_v2";
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
  media?: {
    vout: 1;
    kind: "image" | "video";
    outpoint: string;
    content: Uint8Array;
    contentType: "image/webp" | "video/webm";
    byteSize: number;
    sha256: string;
  };
  freshness: {
    vout: 1 | 2;
    satoshis: number;
    scriptHash: string;
    unlockHeight: number;
    lockerAddress: string;
  };
};

export type DerivedPostV2SignerEvidence = {
  readonly signerAddress: string;
  readonly algorithm: "BITCOIN_ECDSA";
  readonly signatureHex: string;
  readonly signedSemantics: Readonly<{
    kind: "mapapp_post_v2";
    map: Readonly<Record<string, string>>;
  }>;
  readonly provenance: Readonly<{
    protocol: typeof AIP_PROTOCOL;
    subjectTxid: string;
    vout: 0;
    signatureScope: "all_preceding_bitcom_fields";
    verifier: "@1sat/templates/AIP.verify";
  }>;
};

export type PostV2EvidenceInput = {
  atomicBeef: Uint8Array;
  declaredSubjectTxid: string;
  /** Server-owned freshness policy. Browser claims never supply this value. */
  readonly freshnessLockSats?: number;
  browserDiagnostics?: {
    text?: string;
    latitude?: number;
    longitude?: number;
    claimedSignerAddress?: string;
    claimedBapId?: string;
    geohash?: string;
    category?: string;
  };
};

export type PostV2EvidenceResult =
  | { ok: true; post: DerivedPostV2; signerEvidence: DerivedPostV2SignerEvidence; diagnostics?: Readonly<{ claimedBapId: string }> }
  | { ok: false; code: PostV2RejectionCode };

class Rejection extends Error {
  constructor(readonly code: PostV2RejectionCode) {
    super(code);
  }
}

export function isMapAppPostV2Candidate(input: PostV2EvidenceInput): boolean {
  try {
    assertEvidenceLimit("requestBytes", input.atomicBeef.byteLength);
    const beef = Beef.fromBinary(input.atomicBeef);
    const subject = beef.atomicTxid ? beef.findTxid(beef.atomicTxid)?.tx : undefined;
    const root = subject?.outputs[0]?.lockingScript;
    const decoded = root ? MAP.decode(root) : null;
    return decoded?.data.app === "mapapp" && decoded.data.type === "post";
  } catch {
    return false;
  }
}

export function validatePostV2Evidence(input: PostV2EvidenceInput): PostV2EvidenceResult {
  try {
    return validate(input);
  } catch (error) {
    if (error instanceof Rejection || error instanceof EvidenceLimitError) {
      return { ok: false, code: error.code as PostV2RejectionCode };
    }
    return { ok: false, code: "malformed_beef" };
  }
}

function validate(input: PostV2EvidenceInput): Extract<PostV2EvidenceResult, { ok: true }> {
  assertEvidenceLimit("requestBytes", input.atomicBeef.byteLength);
  if (!/^[0-9a-f]{64}$/.test(input.declaredSubjectTxid)) reject("subject_txid_mismatch");
  const beef = Beef.fromBinary(input.atomicBeef);
  if (!beef.atomicTxid) reject("non_atomic_beef");
  if (beef.atomicTxid !== input.declaredSubjectTxid) reject("subject_txid_mismatch");
  assertEvidenceLimit("beefTransactions", beef.txs.length);
  assertEvidenceLimit("ancestryDepth", subjectAncestryDepth(beef, beef.atomicTxid));
  const subject = beef.findTxid(beef.atomicTxid)?.tx;
  if (!subject) reject("subject_transaction_missing");
  if (subject.id("hex") !== beef.atomicTxid) reject("subject_txid_invalid");
  assertEvidenceLimit("subjectInputs", subject.inputs.length);
  assertEvidenceLimit("subjectOutputs", subject.outputs.length);
  const scripts = subjectScripts(subject);
  assertEvidenceLimit("aggregateSubjectScriptBytes", scripts.reduce((sum, script) => sum + script.toBinary().length, 0));
  assertEvidenceLimit("scriptPushes", scripts.reduce((sum, script) => sum + script.chunks.filter(chunk => chunk.data !== undefined).length, 0));
  if (!beef.verifyValid(true).valid) reject("ambiguous_beef_ancestry");

  const root = subject.outputs[0];
  if (!root) reject("post_candidate_missing");
  if (root.satoshis !== 0) reject("v2_protocol_shape_mismatch");
  const bitcom = BitCom.decode(root.lockingScript);
  if (!bitcom) reject("post_candidate_missing");
  assertEvidenceLimit("bitcomProtocols", bitcom.protocols.length);
  if (!hasStandalonePrefix(bitcom) ||
    bitcom.protocols.length !== 3 ||
    bitcom.protocols[0]?.protocol !== B_PREFIX ||
    bitcom.protocols[1]?.protocol !== MAP_PREFIX ||
    bitcom.protocols[2]?.protocol !== AIP_PROTOCOL) {
    reject("v2_protocol_shape_mismatch");
  }

  const textData = B.decode(root.lockingScript);
  if (!textData || textData.mediaType !== "text/plain" || textData.encoding !== "utf-8" || textData.filename !== undefined) {
    reject("v2_text_invalid");
  }
  const textBytes = Uint8Array.from(textData.data);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(textBytes);
  } catch {
    reject("v2_text_invalid");
  }
  if (!text || canonicalProtocol(B.text(text, "text/plain")) !== Utils.toHex(bitcom.protocols[0]!.script)) {
    reject("v2_text_invalid");
  }

  const decodedMap = MAP.decode(root.lockingScript);
  const mapKeys = decodedMap?.data.collectionId === undefined ? MAP_KEYS : [...MAP_KEYS, "collectionId"];
  if (!decodedMap || decodedMap.cmd !== "SET" ||
    Object.keys(decodedMap.data).length !== mapKeys.length ||
    !mapKeys.every((key, index) => Object.keys(decodedMap.data)[index] === key) ||
    decodedMap.data.app !== "mapapp" || decodedMap.data.type !== "post" ||
    decodedMap.data.context !== "geohash" ||
    canonicalProtocol(MAP.set(decodedMap.data)) !== Utils.toHex(bitcom.protocols[1]!.script)) {
    reject("v2_map_fields_invalid");
  }
  const collectionId = decodedMap.data.collectionId;
  if (collectionId !== undefined && !isCanonicalPostCollection(collectionId)) reject("v2_map_fields_invalid");
  const geohash = decodedMap.data.contextValue!;
  const category = decodedMap.data.category!;
  const bounds = GEOHASH.test(geohash) ? geohashBounds(geohash) : null;
  if (!bounds) reject("invalid_geospatial_fields");
  if (!MAPAPP_CATEGORY_TOKENS.includes(category as (typeof MAPAPP_CATEGORY_TOKENS)[number])) {
    reject("v2_map_fields_invalid");
  }
  const latitude = (bounds.south + bounds.north) / 2;
  const longitude = (bounds.west + bounds.east) / 2;

  const aipProtocols = bitcom.protocols.filter(protocol => protocol.protocol === AIP_PROTOCOL);
  if (aipProtocols.length === 0) reject("actor_proof_missing");
  if (aipProtocols.length > 1) reject("actor_proof_multiple");
  const aips = AIP.decode(bitcom);
  if (aips.length === 0) reject("actor_proof_missing");
  if (aips.length > 1) reject("actor_proof_multiple");
  assertEvidenceLimit("aipVerificationAttempts", 1);
  const aip = aips[0]!;
  if (aip.data.algorithm !== "BITCOIN_ECDSA") reject("actor_algorithm_unsupported");
  if (aip.data.fieldIndexes !== undefined) reject("actor_partial_signature_unsupported");
  if (!aip.verify()) reject("actor_signature_invalid");
  if (canonicalProtocol(aip.lock()) !== Utils.toHex(bitcom.protocols[2]!.script)) {
    reject("v2_protocol_shape_mismatch");
  }

  const second = subject.outputs[1];
  if (!second) reject("v2_lock_invalid");
  let media: DerivedPostV2["media"];
  let lockVout: 1 | 2 = 1;
  if (!canonicalLock(second.lockingScript)) {
    if (Lock.decode(second.lockingScript)) reject("v2_lock_invalid");
    const decodedMedia = B.decode(second.lockingScript);
    const mediaBitcom = BitCom.decode(second.lockingScript);
    if (!decodedMedia || !mediaBitcom ||
      !hasStandalonePrefix(mediaBitcom) ||
      mediaBitcom.protocols.length !== 1 ||
      mediaBitcom.protocols[0]?.protocol !== B_PREFIX ||
      second.satoshis !== 0 || decodedMedia.encoding !== "binary" ||
      decodedMedia.filename !== undefined ||
      !SUPPORTED_MEDIA.has(decodedMedia.mediaType) ||
      canonicalProtocol(B.binary(decodedMedia.data, decodedMedia.mediaType)) !==
        Utils.toHex(mediaBitcom.protocols[0].script)) {
      reject("v2_media_invalid");
    }
    const bytes = Uint8Array.from(decodedMedia.data);
    if (bytes.byteLength > MEDIA_RELAY_SAFE_MAX_BYTES) reject("v2_media_invalid");
    media = {
      vout: 1,
      kind: decodedMedia.mediaType === "video/webm" ? "video" : "image",
      outpoint: `${beef.atomicTxid}.1`,
      content: bytes,
      contentType: decodedMedia.mediaType as "image/webp" | "video/webm",
      byteSize: bytes.byteLength,
      sha256: sha256(bytes),
    };
    lockVout = 2;
  }
  const lockOutput = subject.outputs[lockVout];
  const decodedLock = lockOutput && canonicalLock(lockOutput.lockingScript);
  const lockSatoshis = lockOutput?.satoshis;
  if (!lockOutput || !decodedLock ||
    !Number.isSafeInteger(input.freshnessLockSats) || input.freshnessLockSats! <= 0 ||
    lockSatoshis === undefined || lockSatoshis !== input.freshnessLockSats) {
    reject("v2_lock_invalid");
  }

  const post: DerivedPostV2 = {
    format: "mapapp_post_v2",
    txid: beef.atomicTxid,
    vout: 0,
    outpoint: `${beef.atomicTxid}.0`,
    text,
    content: textBytes,
    contentType: "text/plain",
    contentLength: textBytes.byteLength,
    contentHash: sha256(textBytes),
    category,
    geohash,
    latitude,
    longitude,
    ...(collectionId === undefined ? {} : { collectionId }),
    destinationAddress: null,
    intentNonce: null,
    ...(media ? { media } : {}),
    freshness: {
      vout: lockVout,
      satoshis: lockSatoshis,
      scriptHash: sha256(lockOutput.lockingScript.toBinary()),
      unlockHeight: decodedLock.until,
      lockerAddress: decodedLock.address,
    },
  };
  const signerEvidence: DerivedPostV2SignerEvidence = Object.freeze({
    signerAddress: aip.data.address,
    algorithm: "BITCOIN_ECDSA",
    signatureHex: Utils.toHex(aip.data.signature),
    signedSemantics: Object.freeze({ kind: "mapapp_post_v2", map: Object.freeze({ ...decodedMap.data }) }),
    provenance: Object.freeze({
      protocol: AIP_PROTOCOL,
      subjectTxid: beef.atomicTxid,
      vout: 0,
      signatureScope: "all_preceding_bitcom_fields",
      verifier: "@1sat/templates/AIP.verify",
    }),
  });
  if (!diagnosticsMatch(input.browserDiagnostics, post, signerEvidence)) reject("browser_diagnostic_mismatch");
  const diagnostics = input.browserDiagnostics?.claimedBapId === undefined
    ? undefined
    : Object.freeze({ claimedBapId: input.browserDiagnostics.claimedBapId });
  return { ok: true, post, signerEvidence, ...(diagnostics ? { diagnostics } : {}) };
}

function canonicalLock(script: Script): { address: string; until: number } | null {
  const decoded = Lock.decode(script);
  if (!decoded || Lock.lock(decoded.address, decoded.until).toHex() !== script.toHex()) return null;
  return decoded;
}

function hasStandalonePrefix(bitcom: NonNullable<ReturnType<typeof BitCom.decode>>): boolean {
  return bitcom.scriptPrefix.length === 1 && bitcom.scriptPrefix[0] === 0;
}

function canonicalProtocol(script: Script): string {
  const bitcom = BitCom.decode(script);
  if (!bitcom || bitcom.protocols.length !== 1) return "";
  return Utils.toHex(bitcom.protocols[0]!.script);
}

function subjectScripts(tx: Transaction): Script[] {
  return [
    ...tx.inputs.flatMap(input => input.unlockingScript ? [input.unlockingScript] : []),
    ...tx.outputs.map(output => output.lockingScript),
  ];
}

function subjectAncestryDepth(beef: Beef, subjectTxid: string): number {
  const byTxid = new Map(beef.txs.map(tx => [tx.txid, tx]));
  const visiting = new Set<string>();
  const memo = new Map<string, number>();
  const visit = (txid: string): number => {
    const cached = memo.get(txid);
    if (cached !== undefined) return cached;
    if (visiting.has(txid)) reject("ambiguous_beef_ancestry");
    const tx = byTxid.get(txid);
    if (!tx) return 0;
    visiting.add(txid);
    const depth = tx.inputTxids.length === 0 ? 1 : 1 + Math.max(0, ...tx.inputTxids.map(visit));
    visiting.delete(txid);
    memo.set(txid, depth);
    return depth;
  };
  return visit(subjectTxid);
}

function diagnosticsMatch(
  diagnostics: PostV2EvidenceInput["browserDiagnostics"],
  post: DerivedPostV2,
  signer: DerivedPostV2SignerEvidence,
): boolean {
  if (!diagnostics) return true;
  return (diagnostics.text === undefined || diagnostics.text === post.text) &&
    (diagnostics.latitude === undefined || diagnostics.latitude === post.latitude) &&
    (diagnostics.longitude === undefined || diagnostics.longitude === post.longitude) &&
    (diagnostics.geohash === undefined || diagnostics.geohash === post.geohash) &&
    (diagnostics.category === undefined || diagnostics.category === post.category) &&
    (diagnostics.claimedSignerAddress === undefined || diagnostics.claimedSignerAddress === signer.signerAddress);
}

function sha256(bytes: Uint8Array | number[]): string {
  return createHash("sha256").update(Uint8Array.from(bytes)).digest("hex");
}

function reject(code: PostV2RejectionCode): never {
  throw new Rejection(code);
}
