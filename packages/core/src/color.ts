/**
 * Colour management: ICC profiles and sRGB <-> working-space conversion.
 *
 * Placeholder. The contract it must serve: decode the ICC profile of the
 * incoming TIFF into sRGB-encoded float **without clamping**, let the model
 * work in that domain, then convert back and re-embed the original profile.
 *
 * The current TIFF path is not ICC-aware: it treats 16-bit samples as already
 * being sRGB-encoded and copies the profile through untouched.
 */

/** Bytes of an embedded profile, carried through unchanged. */
export interface IccProfile {
  readonly bytes: Uint8Array;
}

/** True when this build performs real colour management. */
export const ICC_AWARE = false;
