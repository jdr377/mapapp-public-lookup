export function isAcceptedRelayStatus(status: string | null | undefined): boolean {
  return isPublicRelayStatus(status);
}

export function isPublicRelayStatus(status: string | null | undefined): boolean {
  return (
    status === "ACCEPTED_BY_NETWORK" ||
    status === "SEEN_ON_NETWORK" ||
    status === "SEEN_MULTIPLE_NODES" ||
    status === "MINED" ||
    status === "IMMUTABLE"
  );
}

// Current Arcade deployments can acknowledge larger transactions before peer
// distribution succeeds. Paid MapApp projection therefore requires direct
// network observation, while callers may still treat ACCEPTED_BY_NETWORK as a
// successful submission acknowledgement.
export function isNetworkObservedRelayStatus(status: string | null | undefined): boolean {
  return (
    status === "SEEN_ON_NETWORK" ||
    status === "SEEN_MULTIPLE_NODES" ||
    status === "MINED" ||
    status === "IMMUTABLE"
  );
}

export function relayStatusFromTxStatus(value: Record<string, unknown>): string | null {
  const status = value.txStatus ?? value.status ?? value.result;
  return typeof status === "string" ? status : null;
}
