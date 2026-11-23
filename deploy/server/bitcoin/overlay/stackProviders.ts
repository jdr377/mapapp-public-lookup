import { ArcadeClient, ChaintracksClient } from "@1sat/client";
import type { Broadcaster, ChainTracker } from "@bsv/sdk";
import type { TopicAnchorHeaderResolver } from "@bsv/overlay";
import { readBoundedBody } from "../../http/requestSecurity";
import { assertEvidenceLimit } from "../evidenceLimits";
import { isAcceptedRelayStatus, isNetworkObservedRelayStatus } from "../relayStatus";
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Stock clients, one selected Stack origin, no alternate header or relay provider. */
export function createOverlayStackProviders(stackOrigin: string, options: {
  fetch?: FetchLike; timeoutMs?: number; allowPrivateHttp?: boolean; requireNetworkObservation?: boolean;
} = {}): { chainTracker: ChainTracker; broadcaster: Broadcaster; topicAnchorHeaderResolver: TopicAnchorHeaderResolver } {
  const origin = new URL(stackOrigin), timeoutMs = options.timeoutMs ?? 10_000;
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/"
    || !(origin.protocol === "https:" || origin.protocol === "http:" && (loopback(origin.hostname)
      || options.allowPrivateHttp === true && privateHost(origin.hostname)))
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
    throw new Error("overlay_stack_configuration_invalid");
  const fetcher = options.fetch ?? fetch;
  const boundedFetch: FetchLike = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== origin.origin || url.username || url.password
      || !(url.pathname.startsWith("/1sat/chaintracks/") || url.pathname === "/1sat/tx"))
      throw new Error("overlay_stack_route_invalid");
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(init?.signal ? [init.signal] : [])]);
    const response = await fetcher(url, { ...init, signal, redirect: "error" });
    const bytes = await readBoundedBody(response, 64 * 1024, signal);
    if (bytes === null) throw new Error("overlay_stack_response_too_large");
    return new Response(bytes.length ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer : null,
      { status: response.status, headers: response.headers });
  };
  const clientOptions = { fetch: boundedFetch as typeof fetch, timeout: timeoutMs };
  const headers = new ChaintracksClient(origin.origin, clientOptions);
  // ArcadeClient's public root argument selects Stack's existing BEEF /1sat/tx route.
  const relay = new ArcadeClient(`${origin.origin}/1sat`, clientOptions);
  const accepted = options.requireNetworkObservation ? isNetworkObservedRelayStatus : isAcceptedRelayStatus;
  const height = (value: number) => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("overlay_stack_height_invalid");
    return value;
  };
  return {
    // OverlayExpress otherwise installs a separate WhatsOnChain block-hash resolver,
    // even when a custom ChainTracker is supplied and BASM synchronization is off.
    async topicAnchorHeaderResolver(blockHeight) {
      const header = await headers.findHeaderForHeight(height(blockHeight));
      if (!header) return undefined;
      if (header.height !== blockHeight || !/^[0-9a-fA-F]{64}$/u.test(header.hash)
        || !/^[0-9a-fA-F]{64}$/u.test(header.merkleRoot)) throw new Error("overlay_stack_header_invalid");
      return { blockHeight, blockHash: header.hash.toLowerCase(), merkleRoot: header.merkleRoot.toLowerCase() };
    },
    chainTracker: {
      async currentHeight() { return height(await headers.currentHeight()); },
      async isValidRootForHeight(root, blockHeight) {
        if (!/^[0-9a-f]{64}$/u.test(root)) throw new Error("overlay_stack_root_invalid");
        return headers.isValidRootForHeight(root, height(blockHeight));
      },
    },
    broadcaster: {
      async broadcast(tx) {
        const txid = tx.id("hex");
        try {
          const beef = tx.toAtomicBEEFUint8Array();
          assertEvidenceLimit("requestBytes", beef.byteLength);
          const result = await relay.submitTransaction(beef);
          if (result?.txid !== txid || !accepted(result.txStatus))
            return { status: "error", txid, code: "overlay_stack_broadcast_unaccepted", description: "Stack did not acknowledge this transaction as accepted." };
          return { status: "success", txid, message: "1sat-stack accepted this transaction." };
        } catch {
          // An uncertain spend is never automatically repeated or sent elsewhere.
          return { status: "error", txid, code: "overlay_stack_broadcast_unavailable", description: "Stack broadcast is unavailable; retain the original evidence before recovery." };
        }
      },
    },
  };
}

function loopback(host: string) { return ["127.0.0.1", "[::1]", "localhost"].includes(host); }
function privateHost(host: string) {
  const parts = host.split(".").map(Number);
  return loopback(host) || host === "host.docker.internal" || /^[a-z][a-z0-9-]*$/u.test(host)
    || /^[a-z0-9.-]+\.internal$/u.test(host) || /^\[f[cd][0-9a-f:]+\]$/u.test(host)
    || parts.length === 4 && parts.every(p => Number.isInteger(p) && p >= 0 && p <= 255)
      && (parts[0] === 10 || parts[0] === 192 && parts[1] === 168 || parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31);
}
