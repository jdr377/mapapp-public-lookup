import { Beef, Transaction } from "@bsv/sdk";
import { BitCom, Lock, MAP } from "@1sat/templates";
import { assertEvidenceLimit, EvidenceLimitError } from "../evidenceLimits";
import { validatePostV2Evidence, type DerivedPostV2, type DerivedPostV2SignerEvidence } from "../postV2Evidence";
import { validateSocialV2Evidence, type SocialV2EvidenceResult } from "../socialV2Evidence";
import type { TransactionEvidenceInput } from "../transactionEvidence";
import { validateSponsoredV2Evidence } from "../sponsoredV2Evidence";
import { validatePublicUpgradeV2Evidence } from "../sponsoredUpgradeV2Evidence";

// A separate public social work profile. The paid-root one-AIP profile is unchanged.
export const PUBLIC_SOCIAL_SIGNATURE_LIMIT = 4;
export type DiscoveredEvidence = { ok: false; code: string } | { ok: true; atomicBeef: Uint8Array };
export type OverlayPublicationEvidence = { ok: false; code: string }
  | { ok: true; txid: string; atomicBeef: Uint8Array };

/** Match stock Engine's BEEF subject selection, inside the shared worker budget. */
export function prepareOverlayPublicationEvidence(input: { atomicBeef: Uint8Array }): OverlayPublicationEvidence {
  try {
    assertEvidenceLimit("requestBytes", input.atomicBeef.byteLength);
    const txid = Transaction.fromBEEF(input.atomicBeef).id("hex");
    const packaged = prepareDiscoveredEvidence({ ...input, declaredSubjectTxid: txid });
    return packaged.ok ? { ...packaged, txid } : packaged;
  } catch (cause) { return { ok: false, code: cause instanceof EvidenceLimitError ? cause.code : "malformed_beef" }; }
}

/** Stock BRC-95 packaging only; original transaction bytes are never rebuilt. */
export function prepareDiscoveredEvidence(input: TransactionEvidenceInput): DiscoveredEvidence {
  try {
    assertEvidenceLimit("requestBytes", input.atomicBeef.byteLength);
    const beef = Beef.fromBinary(input.atomicBeef);
    assertEvidenceLimit("beefTransactions", beef.txs.length);
    if (beef.atomicTxid && beef.atomicTxid !== input.declaredSubjectTxid) return { ok: false, code: "subject_txid_mismatch" };
    if (!beef.findTxid(input.declaredSubjectTxid)?.tx) return { ok: false, code: "subject_transaction_missing" };
    const atomicBeef = beef.atomicTxid ? input.atomicBeef : Uint8Array.from(beef.toBinaryAtomic(input.declaredSubjectTxid));
    assertEvidenceLimit("requestBytes", atomicBeef.byteLength);
    return { ok: true, atomicBeef };
  } catch (cause) { return { ok: false, code: cause instanceof EvidenceLimitError ? cause.code : "malformed_beef" }; }
}
export type PublicSocialEvidence = Extract<SocialV2EvidenceResult, { ok: true }>;
export type PublicRecordEvidence = {
  txid: string; signerAddress: string;
  records: Array<{ kind: "contribution-root" | "contribution-reply" | "upgrade"; semanticVout: number;
    targetTxid?: string; collectionId?: string; mediaSha256?: string }>;
  ignoredOutputs: Array<{ vout: number; code: string }>;
};
export type PublicEvidenceResult = { ok: false; code: string }
  | { ok: true; family: "paid-root"; post: DerivedPostV2; signerEvidence: DerivedPostV2SignerEvidence }
  | { ok: true; family: "social"; social: PublicSocialEvidence }
  | { ok: true; family: "record"; record: PublicRecordEvidence };

/** Stack may return ordinary BEEF. Package and validate within one hard budget. */
/** Deterministic public dispatcher; run in the shared bounded evidence worker. */
export function validatePublicPublicationEvidence(input: TransactionEvidenceInput): PublicEvidenceResult {
  try {
    assertEvidenceLimit("requestBytes", input.atomicBeef.byteLength);
    const beef = Beef.fromBinary(input.atomicBeef);
    if (!beef.atomicTxid) return { ok: false, code: "non_atomic_beef" };
    if (beef.atomicTxid !== input.declaredSubjectTxid) return { ok: false, code: "subject_txid_mismatch" };
    assertEvidenceLimit("beefTransactions", beef.txs.length);
    const tx = beef.findTxid(beef.atomicTxid)?.tx;
    if (!tx) return { ok: false, code: "subject_transaction_missing" };
    assertEvidenceLimit("subjectInputs", tx.inputs.length);
    assertEvidenceLimit("subjectOutputs", tx.outputs.length);
    const scripts = [...tx.inputs.flatMap(i => i.unlockingScript ? [i.unlockingScript] : []), ...tx.outputs.map(o => o.lockingScript)];
    assertEvidenceLimit("aggregateSubjectScriptBytes", scripts.reduce((sum, s) => sum + s.toBinary().length, 0));
    assertEvidenceLimit("scriptPushes", scripts.reduce((sum, s) => sum + s.chunks.filter(c => c.data !== undefined).length, 0));
    const byId = new Map(beef.txs.map(t => [t.txid, t]));
    const seen = new Set<string>(), path = new Set<string>(), depths = new Map<string, number>();
    function depth(id: string): number {
      const cached = depths.get(id); if (cached !== undefined) return cached;
      if (path.has(id)) throw new Error("cycle");
      const entry = byId.get(id); if (!entry) return 0;
      path.add(id); seen.add(id);
      const n = 1 + Math.max(0, ...entry.inputTxids.map(depth)); path.delete(id); depths.set(id, n); return n;
    }
    assertEvidenceLimit("ancestryDepth", depth(beef.atomicTxid));
    if (seen.size !== beef.txs.length || !beef.verifyValid(true).valid) return { ok: false, code: "ambiguous_beef_ancestry" };
    let signatures = 0;
    for (const output of tx.outputs) {
      const protocols = BitCom.decode(output.lockingScript)?.protocols ?? [];
      assertEvidenceLimit("bitcomProtocols", protocols.length);
      signatures += protocols.filter(p => p.protocol === "15PciHG22SNLQJXMoSUaWVi7WSqc7hCfva").length;
    }
    if (signatures > PUBLIC_SOCIAL_SIGNATURE_LIMIT) return { ok: false, code: "publication_social_signature_budget" };
    const firstMap = tx.outputs[0] ? MAP.decode(tx.outputs[0].lockingScript)?.data : null;
    if (firstMap?.type === "post") {
      if (firstMap.context === "geohash" && firstMap.mediaSha256 === undefined) {
        const root = validatePostV2Evidence(input);
        if (root.ok) return { ...root, family: "paid-root" };
        // A Lock/media-bearing paid candidate cannot escape its existing gates
        // by being relabelled as a lockless contribution.
        if (tx.outputs.slice(1).some(o => Lock.decode(o.lockingScript) || BitCom.decode(o.lockingScript))) return root;
      } else if (firstMap.context === "tx" && firstMap.mediaSha256 === undefined) {
        const social = validateSocialV2Evidence(input);
        return social.ok ? { ok: true, family: "social", social } : social;
      }
      const contribution = validateSponsoredV2Evidence(input);
      if (!contribution.ok) return contribution;
      if (tx.outputs.slice(1).some(o => Lock.decode(o.lockingScript) || BitCom.decode(o.lockingScript)))
        return { ok: false, code: "publication_contribution_outputs_invalid" };
      return { ok: true, family: "record", record: { txid: input.declaredSubjectTxid, signerAddress: contribution.signerAddress,
        records: ["root" in contribution
          ? { kind: "contribution-root", semanticVout: 0, ...(contribution.root.collectionId ? { collectionId: contribution.root.collectionId } : {}), ...(contribution.root.mediaSha256 ? { mediaSha256: contribution.root.mediaSha256 } : {}) }
          : { kind: "contribution-reply", semanticVout: 0, targetTxid: contribution.reply.targetTxid,
            ...(contribution.reply.offchainMediaSha256 ? { mediaSha256: contribution.reply.offchainMediaSha256 } : {}) }], ignoredOutputs: [] } };
    }
    if (tx.outputs.some(o => MAP.decode(o.lockingScript)?.data.type === "upgrade")) {
      const result = validatePublicUpgradeV2Evidence({ ...input, lockSatoshis: input.freshnessLockSats ?? 0 });
      if (!result.ok) return result;
      return { ok: true, family: "record", record: { txid: result.txid, signerAddress: result.signerAddress,
        records: result.upgrades.map(u => ({ kind: "upgrade", semanticVout: u.semanticVout, targetTxid: u.targetTxid,
          ...(u.media ? { mediaSha256: u.media.sha256 } : {}) })), ignoredOutputs: [...result.ignoredOutputs] } };
    }
    const social = validateSocialV2Evidence(input);
    return social.ok ? { ok: true, family: "social", social } : social;
  } catch (cause) {
    return { ok: false, code: cause instanceof EvidenceLimitError ? cause.code : "malformed_beef" };
  }
}
