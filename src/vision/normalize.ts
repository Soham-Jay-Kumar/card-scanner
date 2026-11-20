import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Sharp } from 'sharp';
import { CONFIG } from '../shared/config.ts';
import type { NormalizedImage } from '../shared/contracts.ts';
import { applyOrientation, readDng } from './dng.ts';
import { writeFileAtomic } from './files.ts';
import { heicToPng } from './heic.ts';

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'gif' | 'tiff' | 'heic' | 'avif';

/**
 * Working copies are cropped from and read many times, so they are kept close to
 * lossless. Full chroma keeps coloured text on coloured card stock crisp.
 */
export const MASTER_JPEG = { quality: 95, chromaSubsampling: '4:4:4' } as const;

const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs']);
const AVIF_BRANDS = new Set(['avif', 'avis']);
/** Generic HEIF containers: the compatible brands decide what they really hold. */
const GENERIC_HEIF_BRANDS = new Set(['mif1', 'msf1']);

function brandsOf(bytes: Buffer): string[] {
  const boxSize = Math.min(bytes.readUInt32BE(0), bytes.length);
  const brands = [bytes.toString('latin1', 8, 12)];
  for (let at = 16; at + 4 <= boxSize; at += 4) brands.push(bytes.toString('latin1', at, at + 4));
  return brands;
}

function isoMediaFormat(bytes: Buffer): ImageFormat | null {
  if (bytes.length < 12 || bytes.toString('latin1', 4, 8) !== 'ftyp') return null;
  const brands = brandsOf(bytes);
  if (brands.some((brand) => AVIF_BRANDS.has(brand))) return 'avif';
  if (brands.some((brand) => HEIC_BRANDS.has(brand) || GENERIC_HEIF_BRANDS.has(brand))) return 'heic';
  return null;
}

/** The real format, from magic bytes. A file's name is never trusted. */
export function detectFormat(bytes: Buffer): ImageFormat | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  const head = bytes.toString('latin1', 0, 12);
  if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return 'gif';
  if (head.startsWith('RIFF') && head.slice(8) === 'WEBP') return 'webp';
  if (head.startsWith('II*\0') || head.startsWith('MM\0*')) return 'tiff';
  return isoMediaFormat(bytes);
}

/** The DNG's largest embedded JPEG, when it is clearly bigger than the first image sharp would decode. */
function largerPreview(dng: NonNullable<ReturnType<typeof readDng>>, bytes: Buffer) {
  const best = dng.previews[0];
  if (!best?.jpeg) return null;
  const longEdge = Math.max(best.width, best.height);
  if (longEdge < Math.max(dng.first.width, dng.first.height) * 1.25) return null;
  const { offset, length } = best.jpeg;
  if (length <= 0 || offset < 0 || offset + length > bytes.length) return null;
  return { longEdge, jpeg: bytes.subarray(offset, offset + length) };
}

/** Same source always gives the same output name, so a re-run overwrites its own file. */
function outputName(sourcePath: string): string {
  const hash = createHash('sha256').update(path.resolve(sourcePath)).digest('hex').slice(0, 16);
  return `normalized-${hash}.jpg`;
}

export async function normalizeImage(input: {
  sourcePath: string;
  originalName: string;
  outDir: string;
}): Promise<NormalizedImage> {
  const { sourcePath, originalName, outDir } = input;
  const bytes = await readFile(sourcePath);
  if (bytes.length === 0) throw new Error(`"${originalName}" is an empty file.`);

  const format = detectFormat(bytes);
  if (!format) {
    throw new Error(`"${originalName}" is not a supported image. Expected JPEG, PNG, WebP, GIF, TIFF, DNG, HEIC or AVIF.`);
  }

  // A DNG can hold a thumbnail first and its real picture later, and sharp only reads the first.
  const dng = format === 'tiff' ? readDng(bytes) : null;
  const preview = dng ? largerPreview(dng, bytes) : null;
  if (dng) {
    const usable = Math.max(Math.max(dng.first.width, dng.first.height), preview?.longEdge ?? 0);
    if (usable < CONFIG.image.cropMinLongEdge) {
      throw new Error(
        `"${originalName}" is a DNG whose only viewable image is ${usable} pixels across` +
          (dng.largestLongEdge > usable ? ` (its raw sensor data is ${dng.largestLongEdge}, which this app cannot decode)` : '') +
          `, too small to read a card from. Export it as a JPEG or HEIC from Photos and upload that instead.`,
      );
    }
  }

  try {
    // failOn 'error' rejects truncated files but tolerates the harmless warnings
    // real camera JPEGs often raise. Only the first frame of an animation is read.
    const decoded: Sharp = preview
      ? applyOrientation(sharp(preview.jpeg, { failOn: 'error' }), dng!.orientation)
      : sharp(format === 'heic' ? await heicToPng(bytes) : bytes, { failOn: 'error', autoOrient: true });
    const { data, info } = await decoded
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .jpeg(MASTER_JPEG)
      .toBuffer({ resolveWithObject: true });

    const outPath = path.join(outDir, outputName(sourcePath));
    await writeFileAtomic(outPath, data);
    return { path: outPath, width: info.width, height: info.height, sourceFormat: dng ? 'dng' : format };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`"${originalName}" looks like ${dng ? 'dng' : format} but could not be decoded, so it may be corrupt: ${reason}`);
  }
}
