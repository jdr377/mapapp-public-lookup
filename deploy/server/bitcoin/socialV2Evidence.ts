import { createHash } from "node:crypto";
import { AIP, B, B_PREFIX, BitCom, Lock, MAP, MAP_PREFIX } from "@1sat/templates";
import { Beef, Utils, type Script } from "@bsv/sdk";
import { MEDIA_RELAY_SAFE_MAX_BYTES } from "../../shared/mediaLimits";

const AIP_PREFIX = "15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva";
const TXID = /^[0-9a-f]{64}$/;
const SUPPORTED_MEDIA = new Set(["image/webp", "video/webm"]);

export type SocialV2Action =
  | { kind: "reply"; targetTxid: string; text: string; media?: SocialV2Media }
  | { kind: "like" | "unlike"; targetTxid: string }
  | { kind: "follow" | "unfollow"; targetBapId: string }
  | { kind: "hide"; targetTxid: string; previousHideTxid?: string }
  | { kind: "freshen"; targetTxid: string; afterHideTxid?: string; lock: { vout: number; satoshis: number; unlockHeight: number; address: string } };

export type SocialV2SemanticAction = SocialV2Action & { semanticVout: number };

export type SocialV2Media = {
  vout: 1;
  kind: "image" | "video";
  contentType: "image/webp" | "video/webm";
  bytes: Uint8Array;
  byteSize: number;
  sha256: string;
};

export type SocialV2EvidenceResult =
  | {
      ok: true;
      txid: string;
      signerAddress: string;
      action: SocialV2SemanticAction;
      actions: SocialV2SemanticAction[];
      ignoredOutputs: Array<{ vout: number; code: SocialV2RejectionCode }>;
    }
  | { ok: false; code: SocialV2RejectionCode };

export type SocialV2RejectionCode =
  | "malformed_beef" | "non_atomic_beef" | "subject_txid_mismatch" | "subject_transaction_missing"
  | "social_protocol_shape_mismatch" | "social_map_fields_invalid" | "social_signature_invalid"
  | "reply_text_invalid" | "reply_media_invalid" | "freshen_lock_invalid";

export function validateSocialV2Evidence(input: {
  atomicBeef: Uint8Array;
  declaredSubjectTxid: string;
  freshnessLockSats?: number;
}): SocialV2EvidenceResult {
  try {
    if (!TXID.test(input.declaredSubjectTxid)) return fail("subject_txid_mismatch");
    const beef = Beef.fromBinary(input.atomicBeef);
    if (!beef.atomicTxid) return fail("non_atomic_beef");
    if (beef.atomicTxid !== input.declaredSubjectTxid) return fail("subject_txid_mismatch");
    const tx = beef.findTxid(beef.atomicTxid)?.tx;
    if (!tx) return fail("subject_transaction_missing");
    if (tx.id("hex") !== beef.atomicTxid || !beef.verifyValid(true).valid) return fail("malformed_beef");
    const firstMap = tx.outputs[0] ? MAP.decode(tx.outputs[0]!.lockingScript) : null;
    if (firstMap?.data.app === "mapapp" && firstMap.data.type === "post") {
      const root = tx.outputs[0]!;
      if (root.satoshis !== 0) return fail("social_protocol_shape_mismatch");
      const bitcom = BitCom.decode(root.lockingScript);
      if (!bitcom || firstMap.cmd !== "SET" || !hasStandalonePrefix(bitcom) || bitcom.protocols.length !== 3 ||
        bitcom.protocols[0]?.protocol !== B_PREFIX || bitcom.protocols[1]?.protocol !== MAP_PREFIX ||
        bitcom.protocols[2]?.protocol !== AIP_PREFIX) return fail("social_protocol_shape_mismatch");
      if (canonicalProtocol(MAP.set(firstMap.data)) !== Utils.toHex(bitcom.protocols[1]!.script)) return fail("social_map_fields_invalid");
      const aip = validAip(bitcom);
      if (!aip) return fail("social_signature_invalid");
      const decodedMap = firstMap;
      if (!exactMap(decodedMap.data, ["app", "type", "context", "contextValue"]) ||
        decodedMap.data.context !== "tx" || !TXID.test(decodedMap.data.contextValue ?? "")) {
        return fail("social_map_fields_invalid");
      }
      const text = B.decode(root.lockingScript);
      if (!text || text.mediaType !== "text/plain" || text.encoding !== "utf-8" || text.filename !== undefined) {
        return fail("reply_text_invalid");
      }
      const bytes = Uint8Array.from(text.data);
      const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (!body || canonicalProtocol(B.text(body, "text/plain")) !== Utils.toHex(bitcom.protocols[0]!.script)) return fail("reply_text_invalid");
      let media: SocialV2Media | undefined;
      if (tx.outputs[1]) {
        const decoded = B.decode(tx.outputs[1]!.lockingScript);
        const mediaBitcom = BitCom.decode(tx.outputs[1]!.lockingScript);
        if (decoded && (tx.outputs[1]!.satoshis !== 0 || !mediaBitcom || !hasStandalonePrefix(mediaBitcom) ||
          mediaBitcom.protocols.length !== 1 || mediaBitcom.protocols[0]?.protocol !== B_PREFIX ||
          decoded.encoding !== "binary" || decoded.filename !== undefined || !SUPPORTED_MEDIA.has(decoded.mediaType)
          || canonicalProtocol(B.binary(decoded.data, decoded.mediaType)) !== Utils.toHex(mediaBitcom.protocols[0]!.script))) {
          return fail("reply_media_invalid");
        }
        if (decoded) {
          const mediaBytes = Uint8Array.from(decoded.data);
          if (mediaBytes.byteLength > MEDIA_RELAY_SAFE_MAX_BYTES) return fail("reply_media_invalid");
          media = {
            vout: 1,
            kind: decoded.mediaType === "video/webm" ? "video" : "image",
            contentType: decoded.mediaType as "image/webp" | "video/webm",
          bytes: mediaBytes,
          byteSize: mediaBytes.byteLength,
            sha256: sha256(mediaBytes),
          };
        }
      }
      const action: SocialV2SemanticAction = {
        kind: "reply", targetTxid: decodedMap.data.contextValue!, text: body,
        ...(media ? { media } : {}), semanticVout: 0,
      };
      return {
        ok: true, txid: beef.atomicTxid, signerAddress: aip.data.address,
        action, actions: [action], ignoredOutputs: [],
      };
    }

    const actions: SocialV2SemanticAction[] = [];
    const ignoredOutputs: Array<{ vout: number; code: SocialV2RejectionCode }> = [];
    let signerAddress: string | null = null;
    for (let vout = 0; vout < tx.outputs.length; vout += 1) {
      const output = tx.outputs[vout]!;
      const decodedMap = MAP.decode(output.lockingScript);
      const type = decodedMap?.data.type;
      if (!["like", "unlike", "follow", "unfollow", "freshen", "hide"].includes(type ?? "")) continue;
      if (decodedMap?.data.app !== "mapapp") {
        ignoredOutputs.push({ vout, code: "social_map_fields_invalid" });
        continue;
      }
      const bitcom = BitCom.decode(output.lockingScript);
      if (output.satoshis !== 0 || !bitcom || decodedMap.cmd !== "SET" || !hasStandalonePrefix(bitcom) ||
        bitcom.protocols.length !== 2 || bitcom.protocols[0]?.protocol !== MAP_PREFIX ||
        bitcom.protocols[1]?.protocol !== AIP_PREFIX) {
        ignoredOutputs.push({ vout, code: "social_protocol_shape_mismatch" });
        continue;
      }
      const aip = validAip(bitcom);
      if (!aip) {
        ignoredOutputs.push({ vout, code: "social_signature_invalid" });
        continue;
      }
      if (signerAddress && signerAddress !== aip.data.address) return fail("social_signature_invalid");
      signerAddress = aip.data.address;
      if (canonicalProtocol(MAP.set(decodedMap.data)) !== Utils.toHex(bitcom.protocols[0]!.script)) {
        ignoredOutputs.push({ vout, code: "social_map_fields_invalid" });
        continue;
      }
      if (type === "like" || type === "unlike") {
        if (!exactMap(decodedMap.data, ["app", "type", "tx"]) || !TXID.test(decodedMap.data.tx ?? "")) {
          ignoredOutputs.push({ vout, code: "social_map_fields_invalid" });
          continue;
        }
        actions.push({ kind: type, targetTxid: decodedMap.data.tx!, semanticVout: vout });
      } else if (type === "follow" || type === "unfollow") {
        if (!exactMap(decodedMap.data, ["app", "type", "bapId"]) || !decodedMap.data.bapId?.trim()) {
          ignoredOutputs.push({ vout, code: "social_map_fields_invalid" });
          continue;
        }
        actions.push({ kind: type, targetBapId: decodedMap.data.bapId, semanticVout: vout });
      } else {
        const referenceKey = type === "hide" ? "previousHide" : "afterHide";
        const reference = decodedMap.data[referenceKey];
        if (!exactMap(decodedMap.data, reference === undefined ? ["app", "type", "tx"] : ["app", "type", "tx", referenceKey])
          || !TXID.test(decodedMap.data.tx ?? "")
          || (reference !== undefined && (!TXID.test(reference) || reference === beef.atomicTxid || reference === decodedMap.data.tx))) {
          ignoredOutputs.push({ vout, code: "social_map_fields_invalid" });
          continue;
        }
        if (type === "hide") {
          if (vout !== 0) return fail("social_protocol_shape_mismatch");
          actions.push({ kind: "hide", targetTxid: decodedMap.data.tx!, semanticVout: vout, ...(reference ? { previousHideTxid: reference } : {}) });
          continue;
        }
        const lockOutput = tx.outputs[vout + 1];
        const lock = lockOutput && Lock.decode(lockOutput.lockingScript);
        if (!lockOutput || !lock || Lock.lock(lock.address, lock.until).toHex() !== lockOutput.lockingScript.toHex() ||
          !Number.isSafeInteger(input.freshnessLockSats) || input.freshnessLockSats! <= 0 ||
          lockOutput.satoshis === undefined || lockOutput.satoshis !== input.freshnessLockSats) {
          ignoredOutputs.push({ vout, code: "freshen_lock_invalid" });
          continue;
        }
        actions.push({
          kind: "freshen", targetTxid: decodedMap.data.tx!, semanticVout: vout,
          ...(reference ? { afterHideTxid: reference } : {}),
          lock: { vout: vout + 1, satoshis: lockOutput.satoshis, unlockHeight: lock.until, address: lock.address },
        });
        vout += 1;
      }
    }
    if (actions.length > 1 && actions.some(action => action.kind === "hide")) return fail("social_protocol_shape_mismatch");
    if (!actions.length || !signerAddress) {
      return fail(ignoredOutputs[0]?.code ?? "social_protocol_shape_mismatch");
    }
    return { ok: true, txid: beef.atomicTxid, signerAddress, action: actions[0]!, actions, ignoredOutputs };
  } catch {
    return fail("malformed_beef");
  }
}

function validAip(bitcom: NonNullable<ReturnType<typeof BitCom.decode>>) {
  const aip = AIP.decode(bitcom);
  if (aip.length !== 1 || aip[0]!.data.algorithm !== "BITCOIN_ECDSA" ||
    aip[0]!.data.fieldIndexes !== undefined || !aip[0]!.verify()
    || canonicalProtocol(aip[0]!.lock()) !== Utils.toHex(bitcom.protocols.at(-1)!.script)) return null;
  return aip[0]!;
}

function hasStandalonePrefix(bitcom: NonNullable<ReturnType<typeof BitCom.decode>>): boolean {
  return bitcom.scriptPrefix.length === 1 && bitcom.scriptPrefix[0] === 0;
}

function exactMap(data: Record<string, string>, keys: string[]): boolean {
  return Object.keys(data).length === keys.length && keys.every((key, index) => Object.keys(data)[index] === key);
}
function canonicalProtocol(script: Script): string {
  const bitcom = BitCom.decode(script);
  return bitcom?.protocols.length === 1 ? Utils.toHex(bitcom.protocols[0]!.script) : "";
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(code: SocialV2RejectionCode): Extract<SocialV2EvidenceResult, { ok: false }> {
  return { ok: false, code };
}
