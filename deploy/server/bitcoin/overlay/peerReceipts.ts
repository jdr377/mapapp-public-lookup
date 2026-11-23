import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { assertEvidenceLimit, EvidenceLimitError } from "../evidenceLimits";
import { validatePublicPublicationEvidenceBounded } from "../evidenceWorker";

export type PeerReceipt = { txid: string; acceptedVouts: number[] };
export type PeerReceipts = ReturnType<typeof createPeerReceipts>;
type EvidenceOutpoint = { semanticVout: number };
type StoredEvidence = {
  txid: string;
  family: "paid-root" | "social" | "record";
  atomic_beef: Buffer;
  derived_post: { records?: EvidenceOutpoint[]; actions?: EvidenceOutpoint[] };
};

function receipt(row: StoredEvidence): PeerReceipt {
  const outputs = row.family === "record" ? row.derived_post.records
    : row.family === "social" ? row.derived_post.actions : [{ semanticVout: 0 }];
  if (!outputs) throw Error("publication_receipt_invalid");
  return { txid: row.txid, acceptedVouts: outputs.map(output => output.semanticVout) };
}

export function createPeerReceipts(pool: Pool, freshnessLockSats: number) {
  async function find(txid: string) {
    const result = await pool.query<StoredEvidence>(
      "SELECT txid,family,atomic_beef,derived_post FROM public_publications.roots WHERE txid=$1", [txid]);
    return result.rows[0];
  }

  return {
    async status(txid: string) {
      const existing = await find(txid);
      return existing && receipt(existing);
    },
    async submit({ txid, atomicBeef }: { txid: string; atomicBeef: Uint8Array }) {
      try {
        assertEvidenceLimit("requestBytes", atomicBeef.byteLength);
        const bytes = Buffer.from(atomicBeef);
        const result = await validatePublicPublicationEvidenceBounded({
          atomicBeef: bytes, declaredSubjectTxid: txid, freshnessLockSats,
        });
        if (!result.ok) return { code: result.code };

        const evidence = result.family === "record" ? { records: result.record.records.map(({ semanticVout }) => ({ semanticVout })) }
          : result.family === "social" ? { actions: result.social.actions.map(({ semanticVout }) => ({ semanticVout })) }
          : {};
        const insert = await pool.query<StoredEvidence>(
          `INSERT INTO public_publications.roots
            (txid,family,atomic_beef,evidence_hash,derived_post,signer_evidence,owns_projection)
            VALUES ($1,$2,$3,$4,$5,'{}',false) ON CONFLICT (txid) DO NOTHING
            RETURNING txid,family,atomic_beef,derived_post`,
          [txid, result.family, bytes, createHash("sha256").update(bytes).digest("hex"), JSON.stringify(evidence)]);
        const stored = insert.rows[0] ?? await find(txid);
        if (!stored || stored.family !== result.family || !stored.atomic_beef.equals(bytes))
          return { code: "publication_evidence_conflict" };
        return { receipt: receipt(stored) };
      } catch (error) {
        if (error instanceof EvidenceLimitError) return { code: error.code };
        if (error && typeof error === "object" && "code" in error && error.code === "23514")
          return { code: "publication_capacity_or_invariant" };
        return { code: "publication_repository_unavailable" };
      }
    },
  };
}
