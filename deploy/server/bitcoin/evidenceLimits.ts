import { TRANSACTION_EVIDENCE_MAX_BYTES, TRANSACTION_SUBJECT_SCRIPT_MAX_BYTES } from "../../shared/mediaLimits";

export interface TransactionEvidenceMeasurements {
  requestBytes: number;
  beefTransactions: number;
  ancestryDepth: number;
  subjectInputs: number;
  subjectOutputs: number;
  aggregateSubjectScriptBytes: number;
  scriptPushes: number;
  bitcomProtocols: number;
  aipVerificationAttempts: number;
  concurrentParses: number;
  parseDeadlineMs: number;
}

/**
 * R31's independent ceilings. These are admission limits, not parser defaults:
 * callers must measure evidence before signature verification, persistence,
 * projection, or any 1sat-stack request.
 */
export const TRANSACTION_EVIDENCE_LIMITS: Readonly<TransactionEvidenceMeasurements> = Object.freeze({
  requestBytes: TRANSACTION_EVIDENCE_MAX_BYTES,
  beefTransactions: 64,
  ancestryDepth: 32,
  subjectInputs: 128,
  subjectOutputs: 32,
  aggregateSubjectScriptBytes: TRANSACTION_SUBJECT_SCRIPT_MAX_BYTES,
  scriptPushes: 512,
  bitcomProtocols: 8,
  aipVerificationAttempts: 1,
  concurrentParses: 4,
  parseDeadlineMs: 24_000,
});

/** Preserve the 500 ms budget for small jobs; bound larger jobs by byte count. */
export function evidenceParseDeadlineMs(requestBytes: number): number {
  assertEvidenceLimit("requestBytes", requestBytes);
  if (requestBytes <= 1024 * 1024) return 500;
  return Math.min(TRANSACTION_EVIDENCE_LIMITS.parseDeadlineMs,
    Math.ceil(requestBytes / (1024 * 1024)) * 1_500);
}

export type EvidenceLimitCode = `evidence_budget_${keyof TransactionEvidenceMeasurements}`;

export class EvidenceLimitError extends Error {
  readonly code: EvidenceLimitCode;
  readonly limit: number;
  readonly actual: number;

  constructor(key: keyof TransactionEvidenceMeasurements, limit: number, actual: number) {
    super(`transaction evidence exceeds ${key} limit`);
    this.name = "EvidenceLimitError";
    this.code = `evidence_budget_${key}`;
    this.limit = limit;
    this.actual = actual;
  }
}

export function assertEvidenceLimit<K extends keyof TransactionEvidenceMeasurements>(key: K, actual: number): number {
  if (!Number.isSafeInteger(actual) || actual < 0) {
    throw new TypeError(`invalid evidence measurement: ${key}`);
  }
  const limit = TRANSACTION_EVIDENCE_LIMITS[key];
  if (actual > limit) {
    throw new EvidenceLimitError(key, limit, actual);
  }
  return actual;
}

export function assertEvidenceLimits(
  measurements: Partial<TransactionEvidenceMeasurements>,
): TransactionEvidenceMeasurements {
  for (const key of Object.keys(TRANSACTION_EVIDENCE_LIMITS) as Array<keyof TransactionEvidenceMeasurements>) {
    const actual = measurements[key];
    if (typeof actual !== "number") {
      throw new TypeError(`invalid evidence measurement: ${key}`);
    }
    assertEvidenceLimit(key, actual);
  }
  return measurements as TransactionEvidenceMeasurements;
}
