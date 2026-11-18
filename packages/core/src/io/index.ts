/**
 * Image I/O: 16-bit TIFF read/write with metadata passthrough, plus the
 * model-input thumbnails and UI previews derived from the same files.
 *
 * Two rules it must follow:
 *
 * * read/write pixels only — EXIF, GPS, keywords and ratings are copied, not
 *   regenerated;
 * * stream row strips instead of materialising a whole 45 MP f32 buffer.
 */

export * from "./metadata.js";
export * from "./thumb.js";
export * from "./tiff.js";
export { Rgb16TiffWriter, TiffReader, Tag } from "./codec/tiff.js";
export * as png from "./codec/png.js";
export * as jpeg from "./codec/jpeg.js";
