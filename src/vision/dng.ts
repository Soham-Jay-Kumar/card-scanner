/**
 * DNG is a TIFF container that can hold several images: usually a small thumbnail,
 * one or more JPEG previews, and the raw sensor data. sharp reads only the first
 * image in the file. For an iPhone DNG that is a full-size 8-bit JPEG preview,
 * which is what we want. For many other DNGs it is a thumbnail a few hundred
 * pixels wide, and decoding it would quietly shrink a sharp photo to nothing.
 * So the file's own image list is read here and the largest preview is chosen.
 *
 * The file comes from outside, so every read is bounds-checked and any malformed
 * structure means "not understood": the caller then decodes the file as a plain TIFF.
 */
import type { Sharp } from 'sharp';

const TAG = {
  newSubfileType: 254,
  width: 256,
  height: 257,
  compression: 259,
  photometric: 262,
  stripOffsets: 273,
  orientation: 274,
  stripByteCounts: 279,
  subIfds: 330,
  tileWidth: 322,
  jpegOffset: 513,
  jpegLength: 514,
  dngVersion: 50706,
} as const;

const COMPRESSION_OLD_JPEG = 6;
const COMPRESSION_JPEG = 7;
const PHOTOMETRIC_RGB = 2;
const PHOTOMETRIC_YCBCR = 6;
const MAX_IFDS = 32;
const MAX_ENTRIES = 512;

export interface DngImage {
  width: number;
  height: number;
  /** Where the file holds a complete JPEG for this image, when it holds one. */
  jpeg: { offset: number; length: number } | null;
}

export interface DngInfo {
  /** EXIF orientation of the main image, 1 to 8. Previews inherit it. */
  orientation: number;
  /** The first image, the one sharp decodes. */
  first: DngImage;
  /** Every image that is a viewable JPEG, largest first. */
  previews: DngImage[];
  /** The long edge of the largest image of any kind, raw sensor data included. */
  largestLongEdge: number;
}

class Reader {
  // Declared in full, not as constructor parameter properties: node runs this file by
  // stripping types, and that syntax needs a real compile step.
  private readonly bytes: Buffer;
  private readonly little: boolean;
  constructor(bytes: Buffer, little: boolean) {
    this.bytes = bytes;
    this.little = little;
  }
  u16(at: number): number {
    if (at < 0 || at + 2 > this.bytes.length) throw new RangeError('read past end');
    return this.little ? this.bytes.readUInt16LE(at) : this.bytes.readUInt16BE(at);
  }
  u32(at: number): number {
    if (at < 0 || at + 4 > this.bytes.length) throw new RangeError('read past end');
    return this.little ? this.bytes.readUInt32LE(at) : this.bytes.readUInt32BE(at);
  }
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

interface Entry {
  type: number;
  count: number;
  /** Offset of the value bytes: the entry itself when they fit in four, else the pointed-to place. */
  at: number;
}

function readIfd(reader: Reader, offset: number): { entries: Map<number, Entry>; next: number } {
  const count = reader.u16(offset);
  if (count > MAX_ENTRIES) throw new RangeError('too many entries');
  const entries = new Map<number, Entry>();
  for (let index = 0; index < count; index += 1) {
    const base = offset + 2 + index * 12;
    const type = reader.u16(base + 2);
    const valueCount = reader.u32(base + 4);
    const size = (TYPE_SIZE[type] ?? 1) * valueCount;
    entries.set(reader.u16(base), { type, count: valueCount, at: size <= 4 ? base + 8 : reader.u32(base + 8) });
  }
  return { entries, next: reader.u32(offset + 2 + count * 12) };
}

function valueAt(reader: Reader, entry: Entry | undefined, index = 0): number | null {
  if (!entry || index >= entry.count) return null;
  if (entry.type === 3) return reader.u16(entry.at + index * 2);
  if (entry.type === 4 || entry.type === 13) return reader.u32(entry.at + index * 4);
  return null;
}

/** A complete JPEG stored as one strip, or as an old-style JPEG pointer. Tiled and multi-strip files are skipped. */
function jpegOf(reader: Reader, entries: Map<number, Entry>, compression: number | null) {
  if (entries.has(TAG.tileWidth)) return null;
  if (compression === COMPRESSION_OLD_JPEG) {
    const offset = valueAt(reader, entries.get(TAG.jpegOffset));
    const length = valueAt(reader, entries.get(TAG.jpegLength));
    return offset !== null && length !== null ? { offset, length } : null;
  }
  if (compression !== COMPRESSION_JPEG) return null;
  const strips = entries.get(TAG.stripOffsets);
  if (!strips || strips.count !== 1) return null;
  const offset = valueAt(reader, strips);
  const length = valueAt(reader, entries.get(TAG.stripByteCounts));
  return offset !== null && length !== null ? { offset, length } : null;
}

/** Null when the file is not a DNG, or its structure can't be followed. */
export function readDng(bytes: Buffer): DngInfo | null {
  try {
    if (bytes.length < 8) return null;
    const mark = bytes.toString('latin1', 0, 2);
    if (mark !== 'II' && mark !== 'MM') return null;
    const reader = new Reader(bytes, mark === 'II');
    if (reader.u16(2) !== 42) return null;

    const images: Array<DngImage & { viewable: boolean }> = [];
    const seen = new Set<number>();
    let orientation = 1;
    let isDng = false;
    const queue = [reader.u32(4)];
    for (let offset = queue.shift(); offset !== undefined && seen.size < MAX_IFDS; offset = queue.shift()) {
      if (offset === 0 || seen.has(offset)) continue;
      seen.add(offset);
      const { entries, next } = readIfd(reader, offset);
      if (seen.size === 1) {
        orientation = valueAt(reader, entries.get(TAG.orientation)) ?? 1;
        isDng = entries.has(TAG.dngVersion);
      }
      const width = valueAt(reader, entries.get(TAG.width));
      const height = valueAt(reader, entries.get(TAG.height));
      if (width && height) {
        const photometric = valueAt(reader, entries.get(TAG.photometric));
        const jpeg = jpegOf(reader, entries, valueAt(reader, entries.get(TAG.compression)));
        const colour = photometric === PHOTOMETRIC_RGB || photometric === PHOTOMETRIC_YCBCR;
        images.push({ width, height, jpeg, viewable: colour && jpeg !== null });
      }
      const subs = entries.get(TAG.subIfds);
      for (let index = 0; subs && index < subs.count; index += 1) queue.push(valueAt(reader, subs, index) ?? 0);
      queue.push(next);
    }

    const first = images[0];
    if (!isDng || !first) return null;
    const area = (image: DngImage) => image.width * image.height;
    return {
      orientation: orientation >= 1 && orientation <= 8 ? orientation : 1,
      first,
      previews: images.filter((image) => image.viewable).sort((a, b) => area(b) - area(a)),
      largestLongEdge: Math.max(...images.map((image) => Math.max(image.width, image.height))),
    };
  } catch {
    return null;
  }
}

/**
 * Turns stored pixels upright for an EXIF orientation, for a preview that carries no
 * orientation of its own. sharp mirrors before it rotates, which is why 5 and 7
 * use the opposite turn to the textbook "rotate, then mirror".
 */
export function applyOrientation(image: Sharp, orientation: number): Sharp {
  switch (orientation) {
    case 2: return image.flop();
    case 3: return image.rotate(180);
    case 4: return image.flip();
    case 5: return image.rotate(270).flop();
    case 6: return image.rotate(90);
    case 7: return image.rotate(90).flop();
    case 8: return image.rotate(270);
    default: return image;
  }
}
