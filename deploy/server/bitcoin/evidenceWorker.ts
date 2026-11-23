import { isMainThread } from "node:worker_threads";
import { EvidenceLimitError, TRANSACTION_EVIDENCE_LIMITS, assertEvidenceLimit, evidenceParseDeadlineMs } from "./evidenceLimits";
import type { TransactionEvidenceInput } from "./transactionEvidence";
import { prepareOverlayPublicationEvidence, validatePublicPublicationEvidence, type OverlayPublicationEvidence, type PublicEvidenceResult } from "./publications/evidence";

type WorkerMessage = { input: TransactionEvidenceInput; mode: "public-publication" | "overlay-packaging" };
type WorkerReady = { ready: true };

const workerScope = globalThis as typeof globalThis & {
  postMessage?: (value: PublicEvidenceResult | OverlayPublicationEvidence | WorkerReady) => void;
  onmessage?: (event: MessageEvent<WorkerMessage>) => void;
};

// Bun evaluates this module inside the worker spawned below. The worker does
// only deterministic parsing and returns cloneable derived evidence.
// Bun also exposes postMessage on its main thread; it does not identify a worker.
if (!isMainThread && typeof workerScope.postMessage === "function") {
  workerScope.onmessage = event => {
    workerScope.postMessage!(event.data.mode === "overlay-packaging" ? prepareOverlayPublicationEvidence(event.data.input)
      : validatePublicPublicationEvidence(event.data.input));
  };
  workerScope.postMessage({ ready: true });
}

export interface TransactionEvidenceWorker {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: WorkerMessage): void;
  terminate(): void | Promise<unknown>;
  ref?(): void;
  unref?(): void;
}

export type TransactionEvidenceWorkerFactory = () => TransactionEvidenceWorker;

const defaultWorkerFactory: TransactionEvidenceWorkerFactory = () =>
  new Worker(new URL("./evidenceWorker.ts", import.meta.url), { type: "module" }) as TransactionEvidenceWorker;

let activeParses = 0;
type ParseWorker = {
  worker: TransactionEvidenceWorker;
  factory: TransactionEvidenceWorkerFactory;
  constructionAttempt: number;
  ready: boolean;
  busy: boolean;
};
const parseWorkers: ParseWorker[] = [];
// Four initial workers plus at most twelve replacements. The installed Windows
// Bun runtime retains about 32 MiB per terminated parser worker even after GC;
// endless timeout/error replacements must fail closed rather than exhaust the
// host. Healthy workers remain reusable after this construction budget is spent.
export const EVIDENCE_WORKER_PROCESS_CONSTRUCTION_LIMIT = 16;
// Worker module import is a service-startup cost, separate from the bounded
// execution budget for evidence sent to an already-ready worker.
export const EVIDENCE_WORKER_STARTUP_DEADLINE_MS = 5_000;
const constructionAttempts = new WeakMap<TransactionEvidenceWorkerFactory, number>();

type WorkerFailureReason = "startup_deadline" | "parse_deadline" | "construction_failed"
  | "post_message_failed" | "active_worker_error" | "idle_worker_error" | "capacity_reassignment";

function reportWorkerFailure(factory: TransactionEvidenceWorkerFactory, reason: WorkerFailureReason, attempt: number): void {
  if (factory !== defaultWorkerFactory) return;
  // At most one failure diagnostic per constructed worker (or failed start),
  // bounded by the process construction limit. Never log evidence or raw errors.
  console.error(`[evidence-worker] reason=${reason} attempt=${attempt} constructions=${constructionAttempts.get(factory) ?? 0}/${EVIDENCE_WORKER_PROCESS_CONSTRUCTION_LIMIT}`);
}

function retireWorker(slot: ParseWorker, reason: WorkerFailureReason): void {
  const index = parseWorkers.indexOf(slot);
  if (index < 0) return;
  parseWorkers.splice(index, 1);
  reportWorkerFailure(slot.factory, reason, slot.constructionAttempt);
  slot.worker.onmessage = null;
  slot.worker.onerror = null;
  // Bun's Web Worker terminate() returns void; injected implementations may
  // return a promise. A failed worker never re-enters the reusable pool.
  try { void Promise.resolve(slot.worker.terminate()).catch(() => {}); } catch { /* Already unavailable. */ }
}

function acquireWorker(factory: TransactionEvidenceWorkerFactory): ParseWorker {
  const reusable = parseWorkers.find(slot => !slot.busy && slot.factory === factory);
  if (reusable) {
    reusable.busy = true;
    reusable.worker.ref?.();
    return reusable;
  }
  const attempts = constructionAttempts.get(factory) ?? 0;
  if (attempts >= EVIDENCE_WORKER_PROCESS_CONSTRUCTION_LIMIT) {
    throw new Error("evidence worker construction budget exhausted");
  }
  // Factory injection is used by tests; it must not create a second independent
  // process-wide worker budget beside the production validators.
  if (parseWorkers.length >= TRANSACTION_EVIDENCE_LIMITS.concurrentParses) {
    const idle = parseWorkers.find(slot => !slot.busy);
    if (!idle) throw new Error("evidence worker capacity unavailable");
    retireWorker(idle, "capacity_reassignment");
  }
  constructionAttempts.set(factory, attempts + 1);
  if (attempts + 1 === EVIDENCE_WORKER_PROCESS_CONSTRUCTION_LIMIT && factory === defaultWorkerFactory) {
    console.error("[evidence-worker] final worker construction attempt; investigate parser failures before restarting the API");
  }
  let worker: TransactionEvidenceWorker;
  try { worker = factory(); }
  catch (error) {
    reportWorkerFailure(factory, "construction_failed", attempts + 1);
    throw error;
  }
  const slot = { worker, factory, constructionAttempt: attempts + 1, ready: false, busy: true };
  parseWorkers.push(slot);
  return slot;
}

/**
 * Process admission and finite startup/parse deadlines for the synchronous public
 * dependency parsers. A successful parse releases its worker for reuse: Bun on
 * Windows retains substantial native memory after repeated worker termination.
 * All production modes share four workers and sixteen construction attempts
 * per process. Exhausted replacement capacity returns evidence_worker_unavailable;
 * healthy workers and unrelated reads continue. An operator must investigate
 * failures before restarting the API to recover replacement capacity. Ordinary
 * validation rejections do not consume another attempt. No waiting queue.
 */
function createBoundedEvidenceValidator<T extends PublicEvidenceResult | OverlayPublicationEvidence>(
  workerFactory: TransactionEvidenceWorkerFactory, mode: WorkerMessage["mode"],
): (input: TransactionEvidenceInput) => Promise<T> {
  return async input => {
    try {
      assertEvidenceLimit("requestBytes", input.atomicBeef.byteLength);
    } catch (error) {
      if (error instanceof EvidenceLimitError) return { ok: false, code: error.code } as T;
      return { ok: false, code: "malformed_beef" } as T;
    }
    if (activeParses >= TRANSACTION_EVIDENCE_LIMITS.concurrentParses) {
      return { ok: false, code: "evidence_budget_concurrentParses" } as T;
    }

    activeParses += 1;
    let slot: ParseWorker | undefined;
    try {
      return await new Promise<T>(resolve => {
        let settled = false;
        let deadline: ReturnType<typeof setTimeout> | null = null;
        const finish = (result: T, retirementReason?: WorkerFailureReason) => {
          if (settled) return;
          settled = true;
          if (deadline) clearTimeout(deadline);
          if (slot) {
            if (retirementReason) retireWorker(slot, retirementReason);
            else {
              slot.busy = false;
              slot.worker.onmessage = null;
              const idle = slot;
              slot.worker.onerror = () => retireWorker(idle, "idle_worker_error");
              slot.worker.unref?.();
            }
          }
          resolve(result);
        };
        const armDeadline = (reason: "startup_deadline" | "parse_deadline", ms: number) => {
          if (deadline) clearTimeout(deadline);
          deadline = setTimeout(() => finish({ ok: false, code: "evidence_budget_parseDeadlineMs" } as T, reason), ms);
        };
        try {
          slot = acquireWorker(workerFactory);
        } catch {
          finish({ ok: false, code: "evidence_worker_unavailable" } as T);
          return;
        }
        const send = () => {
          armDeadline("parse_deadline", evidenceParseDeadlineMs(input.atomicBeef.byteLength));
          try { slot!.worker.postMessage({ input, ...(mode ? { mode } : {}) }); }
          catch { finish({ ok: false, code: "evidence_worker_unavailable" } as T, "post_message_failed"); }
        };
        slot.worker.onmessage = event => {
          if (settled) return;
          const message = event.data as T | WorkerReady;
          if ("ready" in message) {
            if (slot!.ready) return;
            slot!.ready = true;
            send();
            return;
          }
          finish(message);
        };
        slot.worker.onerror = () => finish({ ok: false, code: "evidence_worker_unavailable" } as T, "active_worker_error");
        if (slot.ready) send();
        else armDeadline("startup_deadline", EVIDENCE_WORKER_STARTUP_DEADLINE_MS);
      });
    } finally {
      activeParses -= 1;
    }
  };
}

export const validatePublicPublicationEvidenceBounded = createBoundedEvidenceValidator<PublicEvidenceResult>(defaultWorkerFactory, "public-publication");
const prepareOverlayBounded = createBoundedEvidenceValidator<OverlayPublicationEvidence>(defaultWorkerFactory, "overlay-packaging");
export const prepareOverlayPublicationEvidenceBounded = (input: { atomicBeef: Uint8Array }) =>
  // This packaging mode derives the subject; no caller-declared subject is used.
  prepareOverlayBounded({ ...input, declaredSubjectTxid: "" });
