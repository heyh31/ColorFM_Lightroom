/**
 * Metadata pass-through boundary.
 *
 * The TIFF transform preserves metadata by copying the source file and
 * rewriting only the pixel ranges, so EXIF, IPTC, XMP and the embedded
 * thumbnail survive without being parsed here.
 *
 * This module is where the policy for the re-encode path belongs: which tags
 * to regenerate, how to merge a source and a destination that disagree, and
 * how to report tags that could not be carried over. Nothing is implemented
 * yet; the re-encode path currently keeps only the ICC profile.
 */

/** Tag families the writer may need to reproduce once re-encoding is smarter. */
export type MetadataFamily = "exif" | "iptc" | "xmp" | "icc" | "thumbnail";

/** Families that survive the in-place path, where pixels are the only change. */
export const PRESERVED_IN_PLACE: readonly MetadataFamily[] = ["exif", "iptc", "xmp", "icc", "thumbnail"];

/** Families that survive a full re-encode. */
export const PRESERVED_ON_REENCODE: readonly MetadataFamily[] = ["icc"];
