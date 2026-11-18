/**
 * Float32 arithmetic helpers.
 *
 * The pixel pipeline is defined in single precision, so every intermediate
 * value is rounded to f32 after each operation. JS numbers are doubles, hence
 * the explicit `f32()` calls around each multiply/add: they are what keeps the
 * results identical to a native f32 implementation instead of drifting.
 *
 * `expf` is a portable single-precision exponential built from a 2^(k/128)
 * table and a quadratic residual. It reproduces the exact bit pattern of the
 * platform C library's `expf` for every input the pipeline can produce, which
 * matters because Swish divides by it on every hidden unit.
 */

export const f32: (x: number) => number = Math.fround;

/** f32 addition. */
export function add(a: number, b: number): number {
  return Math.fround(a + b);
}

/** f32 subtraction. */
export function sub(a: number, b: number): number {
  return Math.fround(a - b);
}

/** f32 multiplication. */
export function mul(a: number, b: number): number {
  return Math.fround(a * b);
}

const scratch = new DataView(new ArrayBuffer(8));

function bitsToDouble(bits: bigint): number {
  scratch.setBigUint64(0, bits, false);
  return scratch.getFloat64(0);
}

/**
 * 2^(k/128) for k in 0..127, as exact doubles: the nearest double to the real
 * power, so a table lookup never introduces rounding of its own.
 */
const POW2_OVER_128_TABLE: readonly bigint[] = [
  0x3ff0000000000000n,
  0x3ff0163da9fb3335n,
  0x3ff02c9a3e778061n,
  0x3ff04315e86e7f85n,
  0x3ff059b0d3158574n,
  0x3ff0706b29ddf6den,
  0x3ff0874518759bc8n,
  0x3ff09e3ecac6f383n,
  0x3ff0b5586cf9890fn,
  0x3ff0cc922b7247f7n,
  0x3ff0e3ec32d3d1a2n,
  0x3ff0fb66affed31bn,
  0x3ff11301d0125b51n,
  0x3ff12abdc06c31ccn,
  0x3ff1429aaea92de0n,
  0x3ff15a98c8a58e51n,
  0x3ff172b83c7d517bn,
  0x3ff18af9388c8dean,
  0x3ff1a35beb6fcb75n,
  0x3ff1bbe084045cd4n,
  0x3ff1d4873168b9aan,
  0x3ff1ed5022fcd91dn,
  0x3ff2063b88628cd6n,
  0x3ff21f49917ddc96n,
  0x3ff2387a6e756238n,
  0x3ff251ce4fb2a63fn,
  0x3ff26b4565e27cddn,
  0x3ff284dfe1f56381n,
  0x3ff29e9df51fdee1n,
  0x3ff2b87fd0dad990n,
  0x3ff2d285a6e4030bn,
  0x3ff2ecafa93e2f56n,
  0x3ff306fe0a31b715n,
  0x3ff32170fc4cd831n,
  0x3ff33c08b26416ffn,
  0x3ff356c55f929ff1n,
  0x3ff371a7373aa9cbn,
  0x3ff38cae6d05d866n,
  0x3ff3a7db34e59ff7n,
  0x3ff3c32dc313a8e5n,
  0x3ff3dea64c123422n,
  0x3ff3fa4504ac801cn,
  0x3ff4160a21f72e2an,
  0x3ff431f5d950a897n,
  0x3ff44e086061892dn,
  0x3ff46a41ed1d0057n,
  0x3ff486a2b5c13cd0n,
  0x3ff4a32af0d7d3den,
  0x3ff4bfdad5362a27n,
  0x3ff4dcb299fddd0dn,
  0x3ff4f9b2769d2ca7n,
  0x3ff516daa2cf6642n,
  0x3ff5342b569d4f82n,
  0x3ff551a4ca5d920fn,
  0x3ff56f4736b527dan,
  0x3ff58d12d497c7fdn,
  0x3ff5ab07dd485429n,
  0x3ff5c9268a5946b7n,
  0x3ff5e76f15ad2148n,
  0x3ff605e1b976dc09n,
  0x3ff6247eb03a5585n,
  0x3ff6434634ccc320n,
  0x3ff6623882552225n,
  0x3ff68155d44ca973n,
  0x3ff6a09e667f3bcdn,
  0x3ff6c012750bdabfn,
  0x3ff6dfb23c651a2fn,
  0x3ff6ff7df9519484n,
  0x3ff71f75e8ec5f74n,
  0x3ff73f9a48a58174n,
  0x3ff75feb564267c9n,
  0x3ff780694fde5d3fn,
  0x3ff7a11473eb0187n,
  0x3ff7c1ed0130c132n,
  0x3ff7e2f336cf4e62n,
  0x3ff80427543e1a12n,
  0x3ff82589994cce13n,
  0x3ff8471a4623c7adn,
  0x3ff868d99b4492edn,
  0x3ff88ac7d98a6699n,
  0x3ff8ace5422aa0dbn,
  0x3ff8cf3216b5448cn,
  0x3ff8f1ae99157736n,
  0x3ff9145b0b91ffc6n,
  0x3ff93737b0cdc5e5n,
  0x3ff95a44cbc8520fn,
  0x3ff97d829fde4e50n,
  0x3ff9a0f170ca07ban,
  0x3ff9c49182a3f090n,
  0x3ff9e86319e32323n,
  0x3ffa0c667b5de565n,
  0x3ffa309bec4a2d33n,
  0x3ffa5503b23e255dn,
  0x3ffa799e1330b358n,
  0x3ffa9e6b5579fdbfn,
  0x3ffac36bbfd3f37an,
  0x3ffae89f995ad3adn,
  0x3ffb0e07298db666n,
  0x3ffb33a2b84f15fbn,
  0x3ffb59728de5593an,
  0x3ffb7f76f2fb5e47n,
  0x3ffba5b030a1064an,
  0x3ffbcc1e904bc1d2n,
  0x3ffbf2c25bd71e09n,
  0x3ffc199bdd85529cn,
  0x3ffc40ab5fffd07an,
  0x3ffc67f12e57d14bn,
  0x3ffc8f6d9406e7b5n,
  0x3ffcb720dcef9069n,
  0x3ffcdf0b555dc3fan,
  0x3ffd072d4a07897cn,
  0x3ffd2f87080d89f2n,
  0x3ffd5818dcfba487n,
  0x3ffd80e316c98398n,
  0x3ffda9e603db3285n,
  0x3ffdd321f301b460n,
  0x3ffdfc97337b9b5fn,
  0x3ffe264614f5a129n,
  0x3ffe502ee78b3ff6n,
  0x3ffe7a51fbc74c83n,
  0x3ffea4afa2a490dan,
  0x3ffecf482d8e67f1n,
  0x3ffefa1bee615a27n,
  0x3fff252b376bba97n,
  0x3fff50765b6e4540n,
  0x3fff7bfdad9cbe14n,
  0x3fffa7c1819e90d8n,
  0x3fffd3c22b8f71f1n,
];

const POW2_OVER_128: Float64Array = Float64Array.from(POW2_OVER_128_TABLE, bitsToDouble);

/** Exact powers of two for the exponent range the model can reach. */
const POW2_OFFSET = 256;
const POW2: Float64Array = (() => {
  const table = new Float64Array(2 * POW2_OFFSET + 1);
  for (let i = 0; i <= 2 * POW2_OFFSET; i += 1) {
    table[i] = 2 ** (i - POW2_OFFSET);
  }
  return table;
})();

/** 2^n for an integer n, exact while it is representable. */
export function pow2i(n: number): number {
  const shifted = n + POW2_OFFSET;
  if (Number.isInteger(n) && shifted >= 0 && shifted < POW2.length) {
    return POW2[shifted];
  }
  return 2 ** n;
}

/** 128 * log2(e): the argument scaling of the exponential. */
const LOG2E_TIMES_128 = 184.6649652337873;
/** Linear term of the residual polynomial, ln(2)/128. */
const C0 = 0.0054152173088967536;
/** Quadratic term, (ln(2)/128)^2 / 2. */
const C1 = 1.4662262378543872e-5;

/**
 * e^x in single precision.
 *
 * Writes 128 * log2(e) * x = t + r and evaluates
 * 2^(t/128) * (1 + r * (c0 + c1 * r)), with the power taken from the table so
 * only one rounding happens at the end.
 */
export function expf(x: number): number {
  const value = Math.fround(x);
  if (Number.isNaN(value)) return NaN;
  if (value === Infinity) return Infinity;
  if (value === -Infinity) return 0;
  if (value > 88.72283935546875) return Infinity;
  if (value < -103.97208404541016) return 0;
  // Below 2^-14 the linear term is all that survives the f32 rounding.
  if (Math.abs(value) < 6.103515625e-5) return Math.fround(1 + value);

  const scaled = LOG2E_TIMES_128 * value;
  const t = Math.round(scaled);
  const k = ((t % 128) + 128) % 128;
  const r = scaled - t;
  const hi = POW2_OVER_128[k] * pow2i((t - k) / 128);
  return Math.fround(hi + hi * (r * (C0 + C1 * r)));
}

/** Swish activation: x * sigmoid(x), written as x / (1 + e^-x). */
export function swishf(x: number): number {
  return Math.fround(x / Math.fround(1 + expf(-x)));
}

/** Clamps to [0, 1], mapping NaN to 0 the way `f32::max` then `min` would. */
export function clamp01(x: number): number {
  if (!(x > 0)) return 0;
  return x > 1 ? 1 : x;
}

/**
 * 16-bit code to unit float, exactly as `value / 65535` rounds to f32.
 *
 * A division per channel costs noticeably more than a load across a 32 MP
 * frame, and both the decoder and the fused kernel need the same values.
 */
export const U16_TO_UNIT: Float32Array = (() => {
  const table = new Float32Array(65536);
  for (let i = 0; i < table.length; i += 1) table[i] = i / 65535;
  return table;
})();

/** `(clamp(c, 0, 1) * 65535).round()` with the product taken in f32. */
export function quantizeU16(value: number): number {
  const clamped = value > 0 ? (value > 1 ? 1 : value) : 0;
  return Math.round(Math.fround(clamped * 65535));
}
