import type { LookupService, Storage, TopicManager } from "@bsv/overlay";
import { prepareOverlayPublicationEvidenceBounded, validatePublicPublicationEvidenceBounded } from "../evidenceWorker";
import { assertEvidenceLimit, TRANSACTION_EVIDENCE_LIMITS } from "../evidenceLimits";
import type { PeerReceipts, PeerReceipt } from "./peerReceipts";

export const MAPAPP_TOPIC = "tm_mapapp";
export const MAPAPP_LOOKUP = "ls_mapapp";
type Options = {
  receipts: PeerReceipts;
  storage: Pick<Storage, "findOutput">;
  freshnessLockSats: number;
};
export class MapAppOverlayError extends Error {
  constructor(readonly code: string) { super(code); this.name = "MapAppOverlayError"; }
}

/** No callback index: immutable evidence receipts select records; engine storage owns membership. */
export function createMapAppOverlay(options: Options) {
  if (!Number.isSafeInteger(options.freshnessLockSats) || options.freshnessLockSats < 1)
    throw new MapAppOverlayError("publication_configuration_invalid");
  const documentation = `MapApp publication policy v4; freshness Lock value ${options.freshnessLockSats} satoshis.
Canonical public roots/replies/social actions use the existing bounded MapApp validators.
Only semantic OP_FALSE OP_RETURN outputs are admitted; media and Lock siblings are evidence.
Records are append-only: no invented spent-input history. Receipt admission precedes engine
admission and is independent of network observation, authorship resolution, visibility or moderation.
Canonical authored contributions (including signed mediaSha256) and upgrades are evidence-only
records. Existing app workflows own sponsorship, media retention and projection; a topic record
does not establish those relationships or expose an off-chain object. Identity remains separate. Root MAP may additionally carry canonical collectionId,
covered by the same AIP signature; this reference grants no issuer or ownership authority.
ls_mapapp accepts exactly {"txid":"<lowercase 64-hex>"}; at most 32 semantic outputs, no paging.
It selects immutable receipts and current engine membership, then the engine supplies BEEF.
No additional lookup write is required. Eviction is enforced by engine membership.
Ordinary BEEF is packaged using stock BRC-95 without rebuilding transactions. Same-subject
different evidence is subject to the existing immutable receipt conflict rule; recovery uses
only retained original bytes, with historical submission (no broadcast). Operators sharing
tm_mapapp must agree on this publication version and Lock-value policy.`;
  const metadata = { name: "MapApp public publications", shortDescription: "Canonical public semantic records", version: "4" };

  async function prepare(beef: number[]) {
    assertEvidenceLimit("requestBytes", beef.length);
    if (!beef.length || beef.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255))
      throw new MapAppOverlayError("malformed_beef");
    const prepared = await prepareOverlayPublicationEvidenceBounded({ atomicBeef: Uint8Array.from(beef) });
    if (!prepared.ok) throw new MapAppOverlayError(prepared.code);
    return prepared;
  }
  async function retained(receipt: PeerReceipt) {
    const outputs = [];
    for (const outputIndex of vouts(receipt)) {
      const output = await options.storage.findOutput(receipt.txid, outputIndex, MAPAPP_TOPIC, false);
      if (output && output.txid === receipt.txid && output.outputIndex === outputIndex
        && output.topic === MAPAPP_TOPIC && output.spent === false) outputs.push({ txid: receipt.txid, outputIndex });
    }
    return outputs;
  }

  const topicManager: TopicManager = {
    async identifyAdmissibleOutputs(beef, _previousCoins, offChainValues, _mode, context) {
      if (offChainValues?.length) throw new MapAppOverlayError("publication_offchain_values_unsupported");
      const prepared = await prepare(beef);
      if (context?.dryRun) {
        const result = await validatePublicPublicationEvidenceBounded({ atomicBeef: prepared.atomicBeef,
          declaredSubjectTxid: prepared.txid, freshnessLockSats: options.freshnessLockSats });
        if (!result.ok) throw new MapAppOverlayError(result.code);
        return { outputsToAdmit: result.family === "record" ? result.record.records.map(record => record.semanticVout)
          : result.family === "social" ? result.social.actions.map(action => action.semanticVout) : [result.post.vout], coinsToRetain: [] };
      }
      // Stock Engine can swallow lookup hook errors and permanently skip hooks on replay.
      // Retain first, including direct Engine and historical-sync calls, rather than in a hook.
      const result = await options.receipts.submit({ txid: prepared.txid, atomicBeef: prepared.atomicBeef });
      if (!("receipt" in result)) throw new MapAppOverlayError(result.code);
      return { outputsToAdmit: vouts(result.receipt), coinsToRetain: [] };
    },
    getDocumentation: async () => documentation,
    getMetaData: async () => metadata,
  };
  const lookupService: LookupService = {
    admissionMode: "whole-tx", spendNotificationMode: "none",
    // Receipts already exist before topical admission. These hooks own no second state.
    outputAdmittedByTopic() {},
    outputEvicted() {},
    async lookup(question) {
      if (question.service !== MAPAPP_LOOKUP || !question.query || typeof question.query !== "object"
        || Array.isArray(question.query) || Object.keys(question.query).length !== 1 || Object.keys(question.query)[0] !== "txid"
        || !("txid" in question.query))
        throw new MapAppOverlayError("publication_lookup_invalid");
      const txid = question.query.txid;
      requireTxid(txid);
      const receipt = await options.receipts.status(txid);
      return receipt ? retained(receipt) : [];
    },
    getDocumentation: async () => documentation,
    getMetaData: async () => metadata,
  };
  return { topicManager, lookupService };
}

/** Register only MapApp modules. Stock identity/MessageBox/SHIP/SLAP stay with their host. */
export function configureMapAppOverlay(host: {
  configureTopicManager(name: string, manager: TopicManager): void;
  configureLookupService(name: string, service: LookupService): void;
}, options: Options) {
  const adapter = createMapAppOverlay(options);
  host.configureTopicManager(MAPAPP_TOPIC, adapter.topicManager);
  host.configureLookupService(MAPAPP_LOOKUP, adapter.lookupService);
  return adapter;
}

function vouts(receipt: PublicRootReceipt): number[] {
  const result = receipt.family === "social" || receipt.family === "record" ? receipt.acceptedVouts : [0];
  const limit = TRANSACTION_EVIDENCE_LIMITS.subjectOutputs;
  if (!result?.length || result.length > limit || new Set(result).size !== result.length
    || result.some(vout => !Number.isInteger(vout) || vout < 0 || vout >= limit))
    throw new MapAppOverlayError("publication_receipt_invalid");
  return result;
}
function requireTxid(txid: unknown): asserts txid is string {
  if (typeof txid !== "string" || !/^[0-9a-f]{64}$/u.test(txid)) throw new MapAppOverlayError("publication_subject_invalid");
}
