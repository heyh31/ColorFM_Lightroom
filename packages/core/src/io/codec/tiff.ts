/**
 * 16-bit RGB TIFF reader and writer.
 *
 * The reader exposes the raster as a sequence of chunks (strips for chunky
 * files, tiles for tiled ones) so callers never materialise a whole image:
 * decoding one chunk at a time is what keeps memory independent of pixel count.
 * Uncompressed, LZW, Deflate and PackBits data are understood, with the
 * horizontal predictor; JPEG-in-TIFF is not.
 *
 * The writer emits classic little-endian TIFF with uncompressed RGB16 strips,
 * which is what the pipeline produces and what Lightroom reads back.
 */

import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { inflateSync } from "node:zlib";

import { ColorfmError } from "../../error.js";

/** Subset of the TIFF tag vocabulary this codec needs. */
export const Tag = {
  ImageWidth: 256,
  ImageLength: 257,
  BitsPerSample: 258,
  Compression: 259,
  PhotometricInterpretation: 262,
  StripOffsets: 273,
  SamplesPerPixel: 277,
  RowsPerStrip: 278,
  StripByteCounts: 279,
  PlanarConfiguration: 284,
  Predictor: 317,
  TileWidth: 322,
  TileLength: 323,
  TileOffsets: 324,
  TileByteCounts: 325,
  SampleFormat: 339,
  IccProfile: 34675,
} as const;

/** True on every platform this runs on, but checked rather than assumed. */
const HOST_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const COMPRESSION_NONE = 1;
const COMPRESSION_LZW = 5;
const COMPRESSION_DEFLATE = 8;
const COMPRESSION_OLD_DEFLATE = 32946;
const COMPRESSION_PACKBITS = 32773;
const PHOTOMETRIC_RGB = 2;
const SAMPLE_FORMAT_UINT = 1;
const PREDICTOR_NONE = 1;
const PREDICTOR_HORIZONTAL = 2;

/** What the reader found in the header. */
export interface TiffInfo {
  width: number;
  height: number;
  bitsPerSample: number;
  samplesPerPixel: number;
  compression: number;
  photometric: number;
  planarConfiguration: number;
  predictor: number;
  littleEndian: boolean;
  tiled: boolean;
  /** Rows in a strip; `height` for a single-strip file, 0 when tiled. */
  rowsPerStrip: number;
  /** Number of chunks (strips or tiles). */
  chunkCount: number;
  /** Bytes of the embedded ICC profile, 0 when there is none. */
  iccProfileBytes: number;
}

interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** Raw value bytes (already resolved through an offset when needed). */
  bytes: Uint8Array;
}

const TYPE_SIZES: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
  13: 4, // IFD
};

/**
 * Reads `length` bytes at `offset`.
 * Short reads are an error: a truncated TIFF must not be silently padded.
 */
function readAt(fd: number, offset: number, length: number): Uint8Array {
  const buffer = Buffer.allocUnsafe(length);
  let done = 0;
  while (done < length) {
    const read = readSync(fd, buffer, done, length - done, offset + done);
    if (read === 0) throw ColorfmError.tiff("unexpected end of file");
    done += read;
  }
  return new Uint8Array(buffer.buffer, buffer.byteOffset, length);
}

/** Parses the header and first IFD of a TIFF file. */
export class TiffReader {
  readonly info: TiffInfo;
  private readonly fd: number;
  private readonly entries: Map<number, IfdEntry>;
  private readonly littleEndian: boolean;

  private constructor(fd: number, info: TiffInfo, entries: Map<number, IfdEntry>) {
    this.fd = fd;
    this.info = info;
    this.entries = entries;
    this.littleEndian = info.littleEndian;
  }

  /** Opens a file and validates that it is an RGB 16-bit TIFF. */
  static open(path: string): TiffReader {
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch (error) {
      throw ColorfmError.io(`cannot open ${path}: ${(error as Error).message}`, error);
    }
    try {
      return TiffReader.parse(fd);
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  private static parse(fd: number): TiffReader {
    const header = readAt(fd, 0, 8);
    const order = String.fromCharCode(header[0], header[1]);
    const littleEndian = order === "II";
    if (!littleEndian && order !== "MM") {
      throw ColorfmError.tiff("not a TIFF file");
    }
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const magic = view.getUint16(2, littleEndian);
    if (magic === 43) {
      throw ColorfmError.tiff("BigTIFF is not supported");
    }
    if (magic !== 42) throw ColorfmError.tiff("not a TIFF file");

    const ifdOffset = view.getUint32(4, littleEndian);
    const entries = TiffReader.readIfd(fd, ifdOffset, littleEndian);
    const info = TiffReader.describe(entries, littleEndian);
    return new TiffReader(fd, info, entries);
  }

  private static readIfd(fd: number, offset: number, littleEndian: boolean): Map<number, IfdEntry> {
    const countBytes = readAt(fd, offset, 2);
    const count = new DataView(countBytes.buffer, countBytes.byteOffset, 2).getUint16(0, littleEndian);
    const raw = readAt(fd, offset + 2, count * 12);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const entries = new Map<number, IfdEntry>();

    for (let i = 0; i < count; i += 1) {
      const base = i * 12;
      const tag = view.getUint16(base, littleEndian);
      const type = view.getUint16(base + 2, littleEndian);
      const valueCount = view.getUint32(base + 4, littleEndian);
      const size = (TYPE_SIZES[type] ?? 0) * valueCount;
      let bytes: Uint8Array;
      if (size <= 4 || TYPE_SIZES[type] === undefined) {
        bytes = raw.subarray(base + 8, base + 8 + Math.min(size, 4));
      } else {
        const valueOffset = view.getUint32(base + 8, littleEndian);
        bytes = readAt(fd, valueOffset, size);
      }
      entries.set(tag, { tag, type, count: valueCount, bytes });
    }
    return entries;
  }

  private static describe(entries: Map<number, IfdEntry>, littleEndian: boolean): TiffInfo {
    const read = (tag: number, fallback?: number): number => {
      const entry = entries.get(tag);
      if (!entry) {
        if (fallback === undefined) throw ColorfmError.tiff(`missing tag ${tag}`);
        return fallback;
      }
      const values = TiffReader.numbers(entry, littleEndian);
      if (values.length === 0) throw ColorfmError.tiff(`empty tag ${tag}`);
      return values[0];
    };

    const width = read(Tag.ImageWidth);
    const height = read(Tag.ImageLength);
    const bitsEntry = entries.get(Tag.BitsPerSample);
    if (!bitsEntry) throw ColorfmError.tiff("missing tag 258");
    const bits = TiffReader.numbers(bitsEntry, littleEndian);
    const samplesPerPixel = read(Tag.SamplesPerPixel, 1);
    const bitsPerSample = bits[0];
    for (const value of bits) {
      if (value !== bitsPerSample) {
        throw ColorfmError.unsupported(`mixed bit depths ${bits.join("/")}`);
      }
    }

    const compression = read(Tag.Compression, COMPRESSION_NONE);
    const photometric = read(Tag.PhotometricInterpretation, 2);
    const planarConfiguration = read(Tag.PlanarConfiguration, 1);
    const predictor = read(Tag.Predictor, PREDICTOR_NONE);

    const tileOffsets = entries.get(Tag.TileOffsets);
    const tiled = tileOffsets !== undefined;
    const chunkCount = tiled
      ? TiffReader.numbers(tileOffsets, littleEndian).length
      : TiffReader.numbers(
          entries.get(Tag.StripOffsets) ?? { tag: 0, type: 0, count: 0, bytes: new Uint8Array() },
          littleEndian,
        ).length;

    // 2^32-1 is the conventional "one strip" value; clamping to the height
    // keeps the arithmetic below in range for both spellings.
    const rowsPerStrip = tiled ? 0 : Math.min(read(Tag.RowsPerStrip, height), height);
    const icc = entries.get(Tag.IccProfile);

    return {
      width,
      height,
      bitsPerSample,
      samplesPerPixel,
      compression,
      photometric,
      planarConfiguration,
      predictor,
      littleEndian,
      tiled,
      rowsPerStrip,
      chunkCount,
      iccProfileBytes: icc ? icc.count : 0,
    };
  }

  /** Interprets a tag's bytes as unsigned integers. */
  private static numbers(entry: IfdEntry, littleEndian: boolean): number[] {
    const view = new DataView(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength);
    const out: number[] = [];
    switch (entry.type) {
      case 1:
      case 6:
      case 7:
        for (let i = 0; i < entry.count; i += 1) out.push(entry.bytes[i]);
        return out;
      case 3:
      case 8:
        for (let i = 0; i < entry.count; i += 1) out.push(view.getUint16(i * 2, littleEndian));
        return out;
      case 4:
      case 9:
      case 13:
        for (let i = 0; i < entry.count; i += 1) out.push(view.getUint32(i * 4, littleEndian));
        return out;
      default:
        return out;
    }
  }

  /** Raw ICC profile bytes, or `undefined` when the file has no profile. */
  readIccProfile(): Uint8Array | undefined {
    const entry = this.entries.get(Tag.IccProfile);
    return entry ? entry.bytes.slice() : undefined;
  }

  /** Offsets of the chunks in file order. */
  chunkOffsets(): number[] {
    const entry = this.entries.get(this.info.tiled ? Tag.TileOffsets : Tag.StripOffsets);
    if (!entry) return [];
    return TiffReader.numbers(entry, this.littleEndian);
  }

  /** Byte counts of the chunks in file order. */
  chunkByteCounts(): number[] {
    const entry = this.entries.get(this.info.tiled ? Tag.TileByteCounts : Tag.StripByteCounts);
    if (!entry) return [];
    return TiffReader.numbers(entry, this.littleEndian);
  }

  /**
   * Decodes one chunk into 16-bit samples, in file interleaving.
   *
   * The returned array is a view on freshly decoded data, so callers may keep
   * it; the predictor has already been undone.
   */
  /**
   * Raw bytes for `rows` rows of an uncompressed strip, starting at `firstRow`.
   *
   * In a strip layout those rows are one contiguous byte range, so a band can
   * read exactly its own rows instead of materialising the whole strip. That is
   * what lets a single-strip Lightroom export be split across threads: the
   * largest strip is the whole image, and decoding it per worker would cost
   * more than the transform.
   */
  readStripBytes(index: number, firstRow: number, rows: number): Uint8Array {
    const offsets = this.chunkOffsets();
    const counts = this.chunkByteCounts();
    if (index < 0 || index >= offsets.length) {
      throw ColorfmError.tiff(`chunk ${index} out of range`);
    }
    const rowBytes = this.info.width * this.info.samplesPerPixel * (this.info.bitsPerSample / 8);
    const start = firstRow * rowBytes;
    const length = rows * rowBytes;
    if (firstRow < 0 || rows <= 0 || start + length > counts[index]) {
      throw ColorfmError.tiff(`rows ${firstRow}+${rows} are outside strip ${index}`);
    }
    return readAt(this.fd, offsets[index] + start, length);
  }

  readChunk(index: number): Uint16Array {
    if (this.info.tiled) {
      throw ColorfmError.unsupported("tiled TIFF cannot be edited in place");
    }
    const offsets = this.chunkOffsets();
    const counts = this.chunkByteCounts();
    if (index < 0 || index >= offsets.length) {
      throw ColorfmError.tiff(`chunk ${index} out of range`);
    }
    const compressed = readAt(this.fd, offsets[index], counts[index]);
    // The decoded size comes from the geometry, not from the compressed byte
    // count: a PackBits block is usually smaller than what it expands to, and
    // using the wrong number silently truncates the strip.
    const raw = this.decompress(compressed, this.decodedSize(index));
    const samples = this.toSamples(raw);

    if (this.info.predictor === PREDICTOR_HORIZONTAL) {
      const rowSamples = this.info.width * this.info.samplesPerPixel;
      undoHorizontalPredictor(samples, rowSamples, this.info.bitsPerSample);
    }
    return samples;
  }

  /** Bytes a strip occupies once decompressed, from the header geometry. */
  private decodedSize(index: number): number {
    const { width, height, samplesPerPixel, bitsPerSample, rowsPerStrip } = this.info;
    const rowBytes = width * samplesPerPixel * (bitsPerSample / 8);
    const first = index * rowsPerStrip;
    const rows = Math.max(0, Math.min(rowsPerStrip, height - first));
    return rows * rowBytes;
  }

  private decompress(data: Uint8Array, expectedBytes: number): Uint8Array {
    switch (this.info.compression) {
      case COMPRESSION_NONE:
        return data;
      case COMPRESSION_LZW:
        return lzwDecode(data);
      case COMPRESSION_DEFLATE:
      case COMPRESSION_OLD_DEFLATE:
        return new Uint8Array(inflateSync(data));
      case COMPRESSION_PACKBITS:
        return packBitsDecode(data, expectedBytes);
      default:
        throw ColorfmError.unsupported(`TIFF compression ${this.info.compression}`);
    }
  }

  private toSamples(raw: Uint8Array): Uint16Array {
    const { bitsPerSample } = this.info;
    if (bitsPerSample === 16) {
      // A little-endian file on a little-endian host needs no byte shuffling,
      // so the decoded bytes can be reinterpreted instead of copied: this is
      // 96 million conversions fewer on a 32 MP frame.
      if (this.littleEndian === HOST_LITTLE_ENDIAN && raw.byteOffset % 2 === 0) {
        return new Uint16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
      }
      const count = Math.floor(raw.length / 2);
      const out = new Uint16Array(count);
      for (let i = 0; i < count; i += 1) {
        const at = i * 2;
        out[i] = this.littleEndian ? raw[at] | (raw[at + 1] << 8) : (raw[at] << 8) | raw[at + 1];
      }
      return out;
    }
    if (bitsPerSample === 8) {
      const out = new Uint16Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) out[i] = raw[i];
      return out;
    }
    throw ColorfmError.unsupported(`${bitsPerSample}-bit samples`);
  }

  /** True when the raster is chunky RGB16 with no predictor. */
  get isPlainRgb16(): boolean {
    const { photometric, samplesPerPixel, bitsPerSample, planarConfiguration, predictor } = this.info;
    return (
      photometric === PHOTOMETRIC_RGB &&
      samplesPerPixel === 3 &&
      bitsPerSample === 16 &&
      planarConfiguration === 1 &&
      predictor === PREDICTOR_NONE
    );
  }

  /** Rejects rasters this pipeline cannot color-transform. */
  requireRgb16(): void {
    const { photometric, samplesPerPixel, bitsPerSample } = this.info;
    if (photometric !== PHOTOMETRIC_RGB || samplesPerPixel !== 3 || bitsPerSample !== 16) {
      throw ColorfmError.unsupported(
        `expected RGB 16-bit TIFF, got photometric ${photometric}, ${samplesPerPixel} samples, ${bitsPerSample} bits`,
      );
    }
    if (this.info.planarConfiguration !== 1) {
      throw ColorfmError.unsupported("planar TIFF is not supported");
    }
    const format = this.entries.get(Tag.SampleFormat);
    if (format) {
      for (const value of TiffReader.numbers(format, this.littleEndian)) {
        if (value !== SAMPLE_FORMAT_UINT) {
          throw ColorfmError.unsupported(`sample format ${value}`);
        }
      }
    }
  }

  close(): void {
    closeSync(this.fd);
  }
}

/** Undoes horizontal differencing for 16-bit samples. */
function undoHorizontalPredictor(samples: Uint16Array, rowSamples: number, bits: number): void {
  if (bits !== 16) throw ColorfmError.unsupported(`predictor with ${bits}-bit samples`);
  for (let row = 0; row + rowSamples <= samples.length; row += rowSamples) {
    for (let i = rowSamples - 1; i >= 3; i -= 1) {
      samples[row + i] = (samples[row + i] + samples[row + i - 3]) & 0xffff;
    }
  }
}

/**
 * TIFF-flavoured LZW: MSB-first codes, 9-bit start, early change, and a CLEAR
 * code that resets the dictionary.
 *
 * Entries are stored as a prefix table plus a last-byte table instead of one
 * array per string: a 45 MP strip has millions of dictionary lookups, and
 * materialising each string would dominate the cost.
 */
function lzwDecode(data: Uint8Array): Uint8Array {
  const CLEAR = 256;
  const EOI = 257;
  const MAX_CODES = 4096;

  const prefix = new Int32Array(MAX_CODES);
  const suffix = new Uint8Array(MAX_CODES);
  for (let i = 0; i < 256; i += 1) {
    prefix[i] = -1;
    suffix[i] = i;
  }

  const stack = new Uint8Array(MAX_CODES);
  let out = new Uint8Array(Math.max(1024, data.length * 3));
  let outAt = 0;

  const next = { value: 258 };
  let codeWidth = 9;
  let bitBuffer = 0;
  let bitCount = 0;
  let position = 0;
  let previous = -1;
  let first = 0;

  const grow = (needed: number): void => {
    if (outAt + needed <= out.length) return;
    let size = out.length * 2;
    while (size < outAt + needed) size *= 2;
    const bigger = new Uint8Array(size);
    bigger.set(out.subarray(0, outAt));
    out = bigger;
  };

  for (;;) {
    while (bitCount < codeWidth) {
      if (position >= data.length) {
        return out.subarray(0, outAt);
      }
      bitBuffer = (bitBuffer << 8) | data[position];
      position += 1;
      bitCount += 8;
    }
    bitCount -= codeWidth;
    const code = (bitBuffer >>> bitCount) & ((1 << codeWidth) - 1);
    bitBuffer &= (1 << bitCount) - 1;

    if (code === EOI) return out.subarray(0, outAt);
    if (code === CLEAR) {
      next.value = 258;
      codeWidth = 9;
      previous = -1;
      continue;
    }

    let inCode = code;
    let sp = 0;
    if (code >= next.value) {
      if (previous < 0) throw ColorfmError.tiff("corrupt LZW stream");
      stack[sp++] = first;
      inCode = previous;
    }
    while (inCode >= 256) {
      if (sp >= MAX_CODES) throw ColorfmError.tiff("corrupt LZW stream");
      stack[sp++] = suffix[inCode];
      inCode = prefix[inCode];
    }
    stack[sp++] = inCode;
    first = inCode;

    grow(sp);
    while (sp > 0) out[outAt++] = stack[--sp];

    if (previous >= 0 && next.value < MAX_CODES) {
      prefix[next.value] = previous;
      suffix[next.value] = first;
      next.value += 1;
    }
    previous = code;

    // Early change: the encoder widens one code before the table is full.
    if (next.value + 1 > (1 << codeWidth) - 1 && codeWidth < 12) codeWidth += 1;
  }
}

/** PackBits (TIFF 32773) run-length decoding. */
function packBitsDecode(data: Uint8Array, expectedBytes: number): Uint8Array {
  const out = new Uint8Array(expectedBytes);
  let inPos = 0;
  let outPos = 0;
  while (inPos < data.length && outPos < expectedBytes) {
    const header = (data[inPos++] << 24) >> 24;
    if (header >= 0) {
      const count = header + 1;
      for (let i = 0; i < count && outPos < expectedBytes; i += 1) {
        out[outPos++] = data[inPos++];
      }
    } else if (header !== -128) {
      const count = 1 - header;
      const value = data[inPos++];
      for (let i = 0; i < count && outPos < expectedBytes; i += 1) out[outPos++] = value;
    }
  }
  return out;
}

/** Layout constants for the writer. */
const HEADER_BYTES = 8;

interface WriteEntry {
  tag: number;
  type: number;
  count: number;
  values: number[];
  /** Raw bytes for UNDEFINED payloads such as the ICC profile. */
  raw?: Uint8Array;
}

/**
 * Streaming writer for uncompressed RGB16 strips.
 *
 * Strip offsets follow from the header size, the tag directory and the
 * predictable strip sizes, so every byte position is known before the first
 * pixel is written and the file is produced in one forward pass.
 */
export class Rgb16TiffWriter {
  private readonly fd: number;
  private readonly width: number;
  private readonly rowsPerStrip: number;
  private readonly stripCount: number;
  private readonly lastStripRows: number;
  private written = 0;
  private closed = false;

  constructor(path: string, width: number, height: number, rowsPerStrip: number, iccProfile?: Uint8Array) {
    if (!(width > 0) || !(height > 0)) throw ColorfmError.tiff("image must be non-empty");
    this.fd = openSync(path, "w");
    this.width = width;
    this.rowsPerStrip = Math.max(1, Math.min(Math.floor(rowsPerStrip), height));
    this.stripCount = Math.ceil(height / this.rowsPerStrip);
    this.lastStripRows = height - (this.stripCount - 1) * this.rowsPerStrip;

    const entries: WriteEntry[] = [
      { tag: Tag.ImageWidth, type: 4, count: 1, values: [width] },
      { tag: Tag.ImageLength, type: 4, count: 1, values: [height] },
      { tag: Tag.BitsPerSample, type: 3, count: 3, values: [16, 16, 16] },
      { tag: Tag.Compression, type: 3, count: 1, values: [COMPRESSION_NONE] },
      { tag: Tag.PhotometricInterpretation, type: 3, count: 1, values: [PHOTOMETRIC_RGB] },
      { tag: Tag.StripOffsets, type: 4, count: this.stripCount, values: [] },
      { tag: Tag.SamplesPerPixel, type: 3, count: 1, values: [3] },
      { tag: Tag.RowsPerStrip, type: 4, count: 1, values: [this.rowsPerStrip] },
      { tag: Tag.StripByteCounts, type: 4, count: this.stripCount, values: [] },
      { tag: Tag.PlanarConfiguration, type: 3, count: 1, values: [1] },
      { tag: Tag.SampleFormat, type: 3, count: 3, values: [1, 1, 1] },
    ];
    if (iccProfile && iccProfile.length > 0) {
      entries.push({ tag: Tag.IccProfile, type: 7, count: iccProfile.length, values: [], raw: iccProfile });
    }
    entries.sort((a, b) => a.tag - b.tag);

    // Pass one: size the out-of-line values so the pixel data start is known.
    const ifdBytes = 2 + entries.length * 12 + 4;
    let extraSize = 0;
    for (const entry of entries) {
      const byteSize = (TYPE_SIZES[entry.type] ?? 1) * entry.count;
      if (byteSize > 4) extraSize += byteSize + (byteSize % 2);
    }
    let dataStart = HEADER_BYTES + ifdBytes + extraSize;
    dataStart += dataStart % 2;

    // Pass two: strip positions, now that the data start is fixed.
    const stripSizes: number[] = [];
    for (let i = 0; i < this.stripCount; i += 1) {
      const rows = i === this.stripCount - 1 ? this.lastStripRows : this.rowsPerStrip;
      stripSizes.push(rows * width * 6);
    }
    const offsets: number[] = [];
    let at = dataStart;
    for (const size of stripSizes) {
      offsets.push(at);
      at += size;
    }
    for (const entry of entries) {
      if (entry.tag === Tag.StripOffsets) entry.values = offsets;
      if (entry.tag === Tag.StripByteCounts) entry.values = stripSizes;
    }

    const ifd = Buffer.alloc(HEADER_BYTES + ifdBytes);
    ifd.write("II", 0, "latin1");
    ifd.writeUInt16LE(42, 2);
    ifd.writeUInt32LE(HEADER_BYTES, 4);
    ifd.writeUInt16LE(entries.length, HEADER_BYTES);
    const extras: Buffer[] = [];
    let extraOffset = HEADER_BYTES + ifdBytes;

    entries.forEach((entry, index) => {
      const byteSize = (TYPE_SIZES[entry.type] ?? 1) * entry.count;
      const base = HEADER_BYTES + 2 + index * 12;
      ifd.writeUInt16LE(entry.tag, base);
      ifd.writeUInt16LE(entry.type, base + 2);
      ifd.writeUInt32LE(entry.count, base + 4);

      const payload: Buffer = entry.raw
        ? Buffer.from(entry.raw)
        : encodeValues(entry.type, entry.count, entry.values);
      if (byteSize <= 4) {
        payload.copy(ifd, base + 8, 0, Math.min(payload.length, 4));
      } else {
        ifd.writeUInt32LE(extraOffset, base + 8);
        const padded = payload.length % 2 === 1 ? Buffer.concat([payload, Buffer.alloc(1)]) : payload;
        extras.push(padded);
        extraOffset += byteSize + (byteSize % 2);
      }
    });
    ifd.writeUInt32LE(0, HEADER_BYTES + 2 + entries.length * 12);

    writeSync(this.fd, ifd, 0, ifd.length);
    for (const extra of extras) writeSync(this.fd, extra, 0, extra.length);
    const padding = dataStart - (HEADER_BYTES + ifdBytes + extraSize);
    if (padding > 0) writeSync(this.fd, Buffer.alloc(padding), 0, padding);
  }

  /** Appends one strip: `rows` rows of RGB16 samples, row-major. */
  writeStrip(samples: Uint16Array): void {
    if (this.written >= this.stripCount) throw ColorfmError.tiff("too many strips");
    const rows = this.written === this.stripCount - 1 ? this.lastStripRows : this.rowsPerStrip;
    const expected = rows * this.width * 3;
    if (samples.length < expected) throw ColorfmError.tiff("strip is short");
    const bytes = Buffer.allocUnsafe(expected * 2);
    for (let i = 0; i < expected; i += 1) bytes.writeUInt16LE(samples[i], i * 2);
    writeSync(this.fd, bytes, 0, bytes.length);
    this.written += 1;
  }

  /** Number of strips already written. */
  get stripsWritten(): number {
    return this.written;
  }

  /** Number of strips the header announces. */
  get expectedStrips(): number {
    return this.stripCount;
  }

  /** Flushes and closes; the file is only complete after this returns. */
  finish(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }
}

function encodeValues(type: number, count: number, values: number[]): Buffer {
  const buffer = Buffer.alloc((TYPE_SIZES[type] ?? 1) * count);
  for (let i = 0; i < count; i += 1) {
    if (type === 3) buffer.writeUInt16LE(values[i] ?? 0, i * 2);
    else if (type === 4) buffer.writeUInt32LE(values[i] ?? 0, i * 4);
    else if (type === 1 || type === 7) buffer[i] = values[i] ?? 0;
  }
  return buffer;
}
