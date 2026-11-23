// Post precision preserves the objective paid and sponsored post parsers' contract.
export const POST_GEOHASH_MIN_PRECISION = 8;
export const POST_GEOHASH_MAX_PRECISION = 16;
export const POST_GEOHASH_DEFAULT_PRECISION = 9;
export const POST_GEOHASH_PATTERN = /^[0123456789bcdefghjkmnpqrstuvwxyz]{8,16}$/;

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export type GeohashBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export function encodeGeohash(lat: number, lng: number, precision = 6): string {
  const safePrecision = Math.max(4, Math.min(16, Math.trunc(precision)));
  const latRange: [number, number] = [-90, 90];
  const lngRange: [number, number] = [-180, 180];
  const bits = [16, 8, 4, 2, 1];
  let isEven = true;
  let bit = 0;
  let ch = 0;
  let geohash = "";

  const safeLat = clampFinite(lat, -90, 90);
  const safeLng = clampFinite(lng, -180, 180);

  while (geohash.length < safePrecision) {
    if (isEven) {
      const mid = (lngRange[0] + lngRange[1]) / 2;
      if (safeLng >= mid) {
        ch |= bits[bit] ?? 0;
        lngRange[0] = mid;
      } else {
        lngRange[1] = mid;
      }
    } else {
      const mid = (latRange[0] + latRange[1]) / 2;
      if (safeLat >= mid) {
        ch |= bits[bit] ?? 0;
        latRange[0] = mid;
      } else {
        latRange[1] = mid;
      }
    }

    isEven = !isEven;
    if (bit < 4) {
      bit += 1;
    } else {
      geohash += BASE32[ch] ?? "0";
      bit = 0;
      ch = 0;
    }
  }

  return geohash;
}

export function geohashBounds(geohash: string): GeohashBounds | null {
  const safeGeohash = geohash.trim().toLowerCase();
  if (!safeGeohash) return null;

  const latRange: [number, number] = [-90, 90];
  const lngRange: [number, number] = [-180, 180];
  let isEven = true;

  for (const character of safeGeohash) {
    const value = BASE32.indexOf(character);
    if (value < 0) return null;

    for (const mask of [16, 8, 4, 2, 1]) {
      if (isEven) {
        bisectRange(lngRange, (value & mask) !== 0);
      } else {
        bisectRange(latRange, (value & mask) !== 0);
      }
      isEven = !isEven;
    }
  }

  return {
    west: lngRange[0],
    south: latRange[0],
    east: lngRange[1],
    north: latRange[1],
  };
}

function bisectRange(range: [number, number], useUpperHalf: boolean): void {
  const mid = (range[0] + range[1]) / 2;
  if (useUpperHalf) {
    range[0] = mid;
  } else {
    range[1] = mid;
  }
}

function clampFinite(value: number, min: number, max: number): number {
  if (value === Number.POSITIVE_INFINITY) return max;
  if (value === Number.NEGATIVE_INFINITY) return min;
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
