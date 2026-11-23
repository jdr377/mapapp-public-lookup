import { createHash } from "node:crypto";
import { AIP, B, B_PREFIX, BitCom, Lock, MAP, MAP_PREFIX } from "@1sat/templates";
import { Beef, Script, Utils } from "@bsv/sdk";
import { MEDIA_RELAY_SAFE_MAX_BYTES } from "../../shared/mediaLimits";
import { assertEvidenceLimit, EvidenceLimitError } from "./evidenceLimits";

const AIP_PREFIX = "15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva";
const TXID = /^[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;

export type UpgradeFreshnessPolicy = {
  readonly network: "main" | "test";
  readonly lockSatoshis: number;
  readonly tipHeight: number;
  readonly maxTipSkewBlocks: number;
  readonly durations: Readonly<Record<"1D" | "7D" | "1M" | "3M", number>>;
};

export type SponsoredUpgradeV2 = {
  format: "mapapp_upgrade_v2";
  txid: string;
  semanticVout: number;
  targetTxid: string;
  family: "text_root" | "media_root" | "media_reply";
  media?: {
    content: Uint8Array;
    contentType: "image/webp" | "video/webm";
    byteSize: number;
    sha256: string;
  };
  freshness?: {
    vout: number;
    satoshis: number;
    unlockHeight: number;
    lockerAddress: string;
    duration: "1D" | "7D" | "1M" | "3M";
  };
};

export type SponsoredUpgradeV2SignerEvidence = {
  readonly signerAddress: string;
  readonly algorithm: "BITCOIN_ECDSA";
  readonly signatureHex: string;
  readonly signedSemantics: Readonly<{
    kind: "mapapp_upgrade_v2";
    map: Readonly<Record<string, string>>;
  }>;
  readonly provenance: Readonly<{
    protocol: typeof AIP_PREFIX;
    subjectTxid: string;
    vout: number;
    signatureScope: "all_preceding_bitcom_fields";
    verifier: "@1sat/templates/AIP.verify";
  }>;
};

export type SponsoredUpgradeV2EvidenceResult =
  | {
      ok: true;
      txid: string;
      signerAddress: string;
      upgrades: readonly SponsoredUpgradeV2[];
      signerEvidences: readonly SponsoredUpgradeV2SignerEvidence[];
      ignoredOutputs: readonly { vout: number; code: string }[];
    }
  | { ok: false; code: string };

/** Historical public records prove the Lock itself, not a creation-time duration. */
type UpgradeRecord = Omit<SponsoredUpgradeV2, "freshness"> & {
  freshness?: Omit<NonNullable<SponsoredUpgradeV2["freshness"]>, "duration"> & {
    duration?: "1D" | "7D" | "1M" | "3M";
  };
};
type PublicUpgradeResult = Exclude<SponsoredUpgradeV2EvidenceResult, { ok: true }> | {
  ok: true; txid: string; signerAddress: string; upgrades: readonly UpgradeRecord[];
  signerEvidences: readonly SponsoredUpgradeV2SignerEvidence[]; ignoredOutputs: readonly { vout: number; code: string }[];
};

export function validatePublicUpgradeV2Evidence(input: {
  atomicBeef: Uint8Array; declaredSubjectTxid: string; lockSatoshis: number;
}): PublicUpgradeResult {
  return validateUpgradeEvidence({ ...input, policy: { lockSatoshis: input.lockSatoshis } });
}

export function isMapAppUpgradeV2Candidate(input: {
  atomicBeef: Uint8Array;
  declaredSubjectTxid: string;
}): boolean {
  try {
    const beef = Beef.fromBinary(input.atomicBeef);
    const outputs = beef.atomicTxid ? beef.findTxid(beef.atomicTxid)?.tx?.outputs : undefined;
    return outputs?.some(output => {
      const map = MAP.decode(output.lockingScript);
      return map?.data.app === "mapapp" && map.data.type === "upgrade";
    }) ?? false;
  } catch {
    return false;
  }
}

export function validateSponsoredUpgradeV2Evidence(input: {
  atomicBeef: Uint8Array;
  declaredSubjectTxid: string;
  policy: UpgradeFreshnessPolicy;
}): SponsoredUpgradeV2EvidenceResult {
  // A creation policy always requires matchingDuration; the public record path
  // deliberately has no current-tip policy or invented historical duration.
  return validateUpgradeEvidence(input) as SponsoredUpgradeV2EvidenceResult;
}

function validateUpgradeEvidence(input: {
  atomicBeef: Uint8Array; declaredSubjectTxid: string;
  policy: UpgradeFreshnessPolicy | Pick<UpgradeFreshnessPolicy, "lockSatoshis">;
}): PublicUpgradeResult {
  try {
    assertEvidenceLimit("requestBytes", input.atomicBeef.byteLength);
    if (!TXID.test(input.declaredSubjectTxid)) return fail("upgrade_subject_txid_mismatch");
    const beef = Beef.fromBinary(input.atomicBeef);
    if (!beef.atomicTxid) return fail("upgrade_non_atomic_beef");
    if (beef.atomicTxid !== input.declaredSubjectTxid) return fail("upgrade_subject_txid_mismatch");
    const tx = beef.findTxid(beef.atomicTxid)?.tx;
    if (!tx || tx.id("hex") !== beef.atomicTxid) return fail("upgrade_subject_transaction_missing");
    assertEvidenceLimit("subjectInputs", tx.inputs.length);
    assertEvidenceLimit("subjectOutputs", tx.outputs.length);
    if (!beef.verifyValid(true).valid) return fail("upgrade_malformed_beef");
    if (!Number.isSafeInteger(input.policy.lockSatoshis) || input.policy.lockSatoshis <= 0 ||
      ("tipHeight" in input.policy && (!Number.isSafeInteger(input.policy.tipHeight) || input.policy.tipHeight <= 0 ||
      !Number.isSafeInteger(input.policy.maxTipSkewBlocks) || input.policy.maxTipSkewBlocks < 0))) {
      return fail("upgrade_policy_invalid");
    }

    const candidates = tx.outputs.flatMap((output, vout) => {
      const map = MAP.decode(output.lockingScript);
      return map?.data.app === "mapapp" && map.data.type === "upgrade" ? [{ output, vout }] : [];
    });
    if (candidates.length === 0) return fail("upgrade_protocol_shape_mismatch");

    const parsed = candidates.map(({ output, vout }) => validateSemanticOutput({
      semantic: output,
      semanticVout: vout,
      nextOutput: tx.outputs[vout + 1],
      txid: beef.atomicTxid!,
      policy: input.policy,
    }));
    const accepted = parsed.filter((result): result is Extract<SemanticResult, { ok: true }> => result.ok);
    if (accepted.length === 0) {
      const failed = parsed.find((result): result is Extract<SemanticResult, { ok: false }> => !result.ok);
      return fail(failed?.code ?? "upgrade_protocol_shape_mismatch");
    }
    const signerAddress = accepted[0]!.signerAddress;
    if (accepted.some(result => result.signerAddress !== signerAddress)) {
      return fail("upgrade_mixed_signers_unsupported");
    }
    return {
      ok: true,
      txid: beef.atomicTxid,
      signerAddress,
      upgrades: Object.freeze(accepted.map(result => result.upgrade)),
      signerEvidences: Object.freeze(accepted.map(result => result.signerEvidence)),
      ignoredOutputs: Object.freeze(parsed.flatMap((result, index) => result.ok ? [] : [{ vout: candidates[index]!.vout, code: result.code }])),
    };
  } catch (error) {
    if (error instanceof UpgradeRejection || error instanceof EvidenceLimitError) return fail(error.code);
    return fail("upgrade_malformed_beef");
  }
}

type SemanticResult =
  | { ok: true; signerAddress: string; upgrade: UpgradeRecord; signerEvidence: SponsoredUpgradeV2SignerEvidence }
  | { ok: false; code: string };

function validateSemanticOutput(input: {
  semantic: { satoshis?: number; lockingScript: Script };
  semanticVout: number;
  nextOutput: { satoshis?: number; lockingScript: Script } | undefined;
  txid: string;
  policy: UpgradeFreshnessPolicy | Pick<UpgradeFreshnessPolicy, "lockSatoshis">;
}): SemanticResult {
  try {
    const { semantic, semanticVout, nextOutput, txid, policy } = input;
    if (!semantic || semantic.satoshis !== 0) return fail("upgrade_protocol_shape_mismatch");
    const bitcom = BitCom.decode(semantic.lockingScript);
    if (!bitcom || !hasStandalonePrefix(bitcom)) return fail("upgrade_protocol_shape_mismatch");
    const hasMedia = bitcom.protocols[0]?.protocol === B_PREFIX;
    const expectedProtocols = hasMedia ? [B_PREFIX, MAP_PREFIX, AIP_PREFIX] : [MAP_PREFIX, AIP_PREFIX];
    if (bitcom.protocols.length !== expectedProtocols.length ||
      expectedProtocols.some((protocol, index) => bitcom.protocols[index]?.protocol !== protocol)) {
      return fail("upgrade_protocol_shape_mismatch");
    }

    const mapIndex = hasMedia ? 1 : 0;
    const map = MAP.decode(semantic.lockingScript);
    const keys = Object.keys(map?.data ?? {});
    const expectedKeys = hasMedia ? ["app", "type", "tx", "mediaSha256"] : ["app", "type", "tx"];
    if (!map || map.cmd !== "SET" ||
      keys.length !== expectedKeys.length ||
      !expectedKeys.every((key, index) => keys[index] === key) ||
      map.data.app !== "mapapp" || map.data.type !== "upgrade" ||
      !TXID.test(map.data.tx ?? "") ||
      canonicalProtocol(MAP.set(map.data)) !== Utils.toHex(bitcom.protocols[mapIndex]!.script)) {
      return fail("upgrade_map_invalid");
    }

    let media: SponsoredUpgradeV2["media"];
    if (hasMedia) {
      if (!HASH.test(map.data.mediaSha256 ?? "")) return fail("upgrade_media_hash_invalid");
      const decoded = B.decode(semantic.lockingScript);
      if (!decoded || decoded.encoding !== "binary" || decoded.filename !== undefined ||
        (decoded.mediaType !== "image/webp" && decoded.mediaType !== "video/webm") ||
        canonicalProtocol(B.binary(decoded.data, decoded.mediaType)) !== Utils.toHex(bitcom.protocols[0]!.script)) {
        return fail("upgrade_media_invalid");
      }
      const content = Uint8Array.from(decoded.data);
      if (!validContainer(content, decoded.mediaType) ||
        content.byteLength === 0 || content.byteLength > MEDIA_RELAY_SAFE_MAX_BYTES ||
        sha256(content) !== map.data.mediaSha256) {
        return fail("upgrade_media_invalid");
      }
      media = {
        content,
        contentType: decoded.mediaType,
        byteSize: content.byteLength,
        sha256: map.data.mediaSha256,
      };
    } else if (map.data.mediaSha256 !== undefined) {
      return fail("upgrade_media_invalid");
    }

    const aips = AIP.decode(bitcom);
    if (aips.length !== 1 || aips[0]!.data.algorithm !== "BITCOIN_ECDSA" ||
      aips[0]!.data.fieldIndexes !== undefined || !aips[0]!.verify() ||
      canonicalProtocol(aips[0]!.lock()) !== Utils.toHex(bitcom.protocols[bitcom.protocols.length - 1]!.script)) {
      return fail("upgrade_signature_invalid");
    }

    const decodedLock = nextOutput ? canonicalLock(nextOutput.lockingScript) : null;
    let freshness: UpgradeRecord["freshness"];
    if (decodedLock) {
      if (nextOutput!.satoshis !== policy.lockSatoshis) {
        return fail("upgrade_lock_invalid");
      }
      const duration = "tipHeight" in policy ? matchingDuration(decodedLock.until, policy) : undefined;
      if ("tipHeight" in policy && !duration) return fail("upgrade_lock_invalid");
      freshness = {
        vout: semanticVout + 1,
        satoshis: nextOutput!.satoshis,
        unlockHeight: decodedLock.until,
        lockerAddress: decodedLock.address,
        ...(duration ? { duration } : {}),
      };
    }

    // Root families require a Lock. Media replies deliberately omit it. The
    // database target-kind check in U12.2 decides which media variant this is.
    const family: SponsoredUpgradeV2["family"] = media
      ? freshness ? "media_root" : "media_reply"
      : freshness ? "text_root" : (() => { throw new UpgradeRejection("upgrade_lock_invalid"); })();
    const upgrade: UpgradeRecord = {
      format: "mapapp_upgrade_v2",
      txid,
      semanticVout,
      targetTxid: map.data.tx!,
      family,
      ...(media ? { media } : {}),
      ...(freshness ? { freshness } : {}),
    };
    const signerAddress = aips[0]!.data.address;
    return {
      ok: true,
      signerAddress,
      upgrade,
      signerEvidence: Object.freeze({
        signerAddress,
        algorithm: "BITCOIN_ECDSA",
        signatureHex: Utils.toHex(aips[0]!.data.signature),
        signedSemantics: Object.freeze({
          kind: "mapapp_upgrade_v2",
          map: Object.freeze({ ...map.data }),
        }),
        provenance: Object.freeze({
          protocol: AIP_PREFIX,
          subjectTxid: txid,
          vout: semanticVout,
          signatureScope: "all_preceding_bitcom_fields",
          verifier: "@1sat/templates/AIP.verify",
        }),
      }),
    };
  } catch (error) {
    if (error instanceof UpgradeRejection || error instanceof EvidenceLimitError) return fail(error.code);
    return fail("upgrade_malformed_beef");
  }
}

class UpgradeRejection extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function matchingDuration(unlockHeight: number, policy: UpgradeFreshnessPolicy): "1D" | "7D" | "1M" | "3M" | null {
  for (const duration of ["1D", "7D", "1M", "3M"] as const) {
    const expected = policy.tipHeight + policy.durations[duration];
    if (Math.abs(unlockHeight - expected) <= policy.maxTipSkewBlocks) return duration;
  }
  return null;
}

function canonicalLock(script: Script): { address: string; until: number } | null {
  const decoded = Lock.decode(script);
  return decoded && Lock.lock(decoded.address, decoded.until).toHex() === script.toHex() ? decoded : null;
}

function hasStandalonePrefix(bitcom: NonNullable<ReturnType<typeof BitCom.decode>>): boolean {
  return bitcom.scriptPrefix.length === 1 && bitcom.scriptPrefix[0] === 0;
}

function canonicalProtocol(script: Script): string {
  const decoded = BitCom.decode(script);
  return decoded?.protocols.length === 1 ? Utils.toHex(decoded.protocols[0]!.script) : "";
}

function validContainer(bytes: Uint8Array, contentType: "image/webp" | "video/webm"): boolean {
  const ascii = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.byteLength, 256))).toLowerCase();
  if (ascii.includes("<script") || ascii.includes("<html") || ascii.includes("<!doctype")) return false;
  return contentType === "image/webp"
    ? bytes.byteLength >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    : bytes.byteLength >= 4 &&
      bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(code: string): Extract<SponsoredUpgradeV2EvidenceResult, { ok: false }> {
  return { ok: false, code };
}
