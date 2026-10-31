// @ts-check
// Backup thumbnails (MEM-054): a station photo re-encoded as a JPEG whose long side is at most
// maxSide, for backup_routes.js exportRoutes. Browser seams are injected so tests can pass fakes.

/**
 * @param {{
 *   createImageBitmap: (photo: any) => Promise<{width: number, height: number, close?: () => void}>,
 *   createCanvas: (width: number, height: number) => any,
 * }} deps
 * @returns {import("./backup_routes.js").Thumbnail}
 */
export function createThumbnail({ createImageBitmap, createCanvas }) {
  return async (photo, { maxSide, quality }) => {
    const bitmap = await createImageBitmap(photo);
    try {
      const { width: sourceWidth, height: sourceHeight } = bitmap;
      const k = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * k));
      const height = Math.max(1, Math.round(sourceHeight * k));
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("thumbnail: no 2d canvas context");
      ctx.drawImage(bitmap, 0, 0, width, height);
      /** @type {Blob | null} */
      const bytes = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (!bytes) throw new Error("thumbnail: JPEG encode failed");
      return { bytes, width, height, sourceWidth, sourceHeight };
    } finally {
      bitmap.close?.();
    }
  };
}
