/** A public reference, signed by the poster; it grants no issuer or ownership authority. */
export function normalizePostCollection(value: string): string | null {
  const match = /^([a-f\d]{64})[._](\d+)$/i.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) > 0xffffffff) return null;
  return `${match[1]!.toLowerCase()}_${Number(match[2])}`;
}

export function postCollectionMap(collectionId: string | undefined): { collectionId?: string } {
  if (collectionId === undefined) return {};
  const canonical = normalizePostCollection(collectionId);
  if (!canonical) throw Error("Invalid collection reference.");
  return { collectionId: canonical };
}

/** Wire data has one spelling, so duplicate aliases cannot create distinct links. */
export function isCanonicalPostCollection(value: unknown): value is string {
  return typeof value === "string" && normalizePostCollection(value) === value;
}
