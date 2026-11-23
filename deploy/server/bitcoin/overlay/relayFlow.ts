import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";
import type { Broadcaster } from "@bsv/sdk";

/** Engine documents historical imports as non-broadcasting, but 2.6.5 still
 * calls Broadcaster for unproven history in historical-tx-no-spv mode.
 * Scope the host's public sync operations, never global Engine settings: a
 * concurrent current submission must keep the configured relay and failure gate.
 */
export function createOverlayRelayFlow(liveBroadcaster: Broadcaster) {
  const history = new AsyncLocalStorage<true>();
  const historical = <T>(work: () => T): T => history.run(true, work);
  const broadcaster: Broadcaster = {
    async broadcast(tx) {
      if (history.getStore() === true) {
        // This is an import disposition, not a network acknowledgement. Engine
        // stores topical history only; it cannot advance MapApp network/proof facts.
        return { status: "success", txid: tx.id("hex"), message: "Historical synchronization: network broadcast not requested." };
      }
      return liveBroadcaster.broadcast(tx);
    },
  };
  // Install before the stock admin routes. A caller-supplied header/body cannot
  // put /submit into this scope, and the stock admin authentication still runs.
  const manualSync: RequestHandler = (request, _response, next) => {
    if (request.method === "POST" && ["/admin/startGASPSync", "/admin/startBASMSync"].includes(request.path)) historical(next);
    else next();
  };
  return { broadcaster, historical, manualSync };
}
