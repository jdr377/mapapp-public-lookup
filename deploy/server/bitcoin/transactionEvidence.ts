/** Input to the deterministic public-record validator. */
export interface TransactionEvidenceInput {
  atomicBeef: Uint8Array;
  declaredSubjectTxid: string;
  readonly freshnessLockSats?: number;
}
