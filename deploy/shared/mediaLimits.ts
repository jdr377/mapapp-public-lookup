// Owner-authorized large-media relay requalification (mapapp-ofjm, 2026-10-31).
// This allowance does not establish network observation or mining.
export const MEDIA_RELAY_SAFE_MAX_BYTES = 8 * 1024 * 1024;
export const MEDIA_RELAY_SAFE_MAX_BYTES_LABEL = "8 MiB";
export const MEDIA_RELAY_SAFE_LIMIT_MESSAGE =
  "Processed media must be 8 MiB or smaller.";
export const MEDIA_RELAY_SAFE_BYTE_SIZE_MESSAGE =
  "media.byteSize must be 8 MiB or smaller.";

// Avatars retain their independent profile allowance.
export const PROFILE_AVATAR_MAX_BYTES = 99 * 1024;

// Allow transaction framing and ancestry in addition to an 8 MiB attachment.
export const TRANSACTION_EVIDENCE_MAX_BYTES = 16 * 1024 * 1024;
export const TRANSACTION_SUBJECT_SCRIPT_MAX_BYTES = MEDIA_RELAY_SAFE_MAX_BYTES + 256 * 1024;
