// Dependency-free so the background-removal worker can share the limits without loading Nest.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 16_000_000;
export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
