/**
 * The application category catalog.  Keep this runtime-neutral: both the
 * browser and server contracts import these values directly.
 */
export const MAPAPP_CATEGORY_TOKENS = [
  "🌱", "📍", "🧭", "🎨", "🎵", "🍽️", "☕", "🛒",
  "🏀", "🎮", "📰", "💬", "📸", "🎬", "💻", "🛠️",
  "🏠", "🚗", "🌊", "⛰️", "🌳", "🐾", "🎓", "🏥",
  "⚠️", "🎉", "💼", "🔬", "✈️", "🧘", "🪙", "❤️",
] as const;

export const DEFAULT_MAPAPP_CATEGORY = MAPAPP_CATEGORY_TOKENS[0];

export type MapAppCategoryToken = (typeof MAPAPP_CATEGORY_TOKENS)[number];
