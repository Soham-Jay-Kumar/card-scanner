import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { Sharp } from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDng } from './dng.ts';
import { detectFormat, normalizeImage } from './normalize.ts';
import {
  cornerColourAt,
  cornersMatch,
  cornersRaw,
  isNear,
  pixelAt,
  rawPixels,
  withTempDir,
} from './testFixtures.ts';

const run = promisify(execFile);
const HEIC_TIMEOUT = 120_000;

let dir: string;
let cleanup: () => Promise<void>;
beforeAll(async () => {
  ({ dir, cleanup } = await withTempDir('normalize'));
});
afterAll(() => cleanup());

async function normalizeBytes(bytes: Buffer, originalName: string, outName = 'out') {
  const sourcePath = path.join(dir, `source-${Math.random().toString(36).slice(2)}-${originalName}`);
  await writeFile(sourcePath, bytes);
  return normalizeImage({ sourcePath, originalName, outDir: path.join(dir, outName) });
}

/** Where a stored pixel lands on screen, straight from the EXIF definition of each tag. */
function toDisplay(orientation: number, x: number, y: number, w: number, h: number): [number, number] {
  switch (orientation) {
    case 2: return [w - 1 - x, y];
    case 3: return [w - 1 - x, h - 1 - y];
    case 4: return [x, h - 1 - y];
    case 5: return [y, x];
    case 6: return [h - 1 - y, x];
    case 7: return [h - 1 - y, w - 1 - x];
    case 8: return [y, w - 1 - x];
    default: return [x, y];
  }
}

/** Pixels stored the way a camera would for this tag. Built by hand so sharp isn't marking its own work. */
function storedForOrientation(orientation: number, displayWidth: number, displayHeight: number) {
  const swapped = orientation >= 5;
  const width = swapped ? displayHeight : displayWidth;
  const height = swapped ? displayWidth : displayHeight;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [dx, dy] = toDisplay(orientation, x, y, width, height);
      pixels.set(cornerColourAt(dx, dy, displayWidth, displayHeight), (y * width + x) * 3);
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } });
}

describe('detectFormat', () => {
  const ftyp = (major: string, ...compatible: string[]) => {
    const brands = [major, '\0\0\0\0', ...compatible].join('');
    const size = Buffer.alloc(4);
    size.writeUInt32BE(8 + brands.length);
    return Buffer.concat([size, Buffer.from(`ftyp${brands}`, 'latin1')]);
  };

  it('identifies HEIC and AVIF from their brands', () => {
    expect(detectFormat(ftyp('heic', 'mif1', 'heic'))).toBe('heic');
    expect(detectFormat(ftyp('mif1', 'mif1', 'heic'))).toBe('heic');
    expect(detectFormat(ftyp('avif', 'mif1', 'avif'))).toBe('avif');
    expect(detectFormat(ftyp('mif1', 'avif'))).toBe('avif');
  });

  it('rejects video in the same container, and short or unknown files', () => {
    expect(detectFormat(ftyp('mp42', 'isom'))).toBeNull();
    expect(detectFormat(Buffer.from('%PDF-1.7 hello'))).toBeNull();
    expect(detectFormat(Buffer.from('PK\x03\x04zipfile'))).toBeNull();
    expect(detectFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(detectFormat(Buffer.from([0xff]))).toBeNull();
    expect(detectFormat(Buffer.alloc(0))).toBeNull();
  });
});

describe('EXIF orientation', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('turns orientation %i upright, checked by pixels', async (orientation) => {
    const jpeg = await storedForOrientation(orientation, 240, 140).withMetadata({ orientation }).jpeg({ quality: 95 }).toBuffer();
    expect((await sharp(jpeg).metadata()).orientation).toBe(orientation);

    const result = await normalizeBytes(jpeg, `photo-${orientation}.jpg`);

    expect([result.width, result.height]).toEqual([240, 140]);
    expect(cornersMatch(await rawPixels(result.path))).toBe(true);
    const written = await sharp(result.path).metadata();
    expect([written.width, written.height]).toEqual([240, 140]);
    expect(written.orientation ?? 1).toBe(1);
  });

  it('applies orientation in WebP too', async () => {
    const webp = await storedForOrientation(6, 240, 140).withMetadata({ orientation: 6 }).webp({ lossless: true }).toBuffer();
    const result = await normalizeBytes(webp, 'photo.webp');
    expect(cornersMatch(await rawPixels(result.path))).toBe(true);
  });
});

describe('format detection beats the file name', () => {
  const image = () => sharp(cornersRaw(120, 80), { raw: { width: 120, height: 80, channels: 3 } });

  it.each([
    ['png', 'really-a-png.jpg', (i: Sharp) => i.png()],
    ['jpeg', 'really-a-jpeg.png', (i: Sharp) => i.jpeg()],
    ['webp', 'really-a-webp.heic', (i: Sharp) => i.webp()],
    ['gif', 'really-a-gif.jpg', (i: Sharp) => i.gif()],
    ['tiff', 'no-extension', (i: Sharp) => i.tiff()],
  ])('reads %s from %s', async (format, name, encode) => {
    const result = await normalizeBytes(await encode(image()).toBuffer(), name);
    expect(result.sourceFormat).toBe(format);
    expect((await sharp(result.path).metadata()).format).toBe('jpeg');
    expect(cornersMatch(await rawPixels(result.path))).toBe(true);
  });
});

describe('corrupt files', () => {
  const jpeg = () => sharp(cornersRaw(200, 150), { raw: { width: 200, height: 150, channels: 3 } }).jpeg().toBuffer();
  const png = () => sharp(cornersRaw(200, 150), { raw: { width: 200, height: 150, channels: 3 } }).png().toBuffer();

  it('names the file when it is empty', async () => {
    await expect(normalizeBytes(Buffer.alloc(0), 'blank.jpg')).rejects.toThrow(/"blank\.jpg" is an empty file/);
  });

  it('rejects things that are not images, whatever they are called', async () => {
    await expect(normalizeBytes(Buffer.from('just some notes'), 'notes.jpg')).rejects.toThrow(/"notes\.jpg" is not a supported image/);
    await expect(normalizeBytes(Buffer.from('%PDF-1.7 ...'), 'scan.png')).rejects.toThrow(/not a supported image/);
    await expect(normalizeBytes(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"/>'), 'x.svg')).rejects.toThrow(/not a supported image/);
  });

  it('rejects a real header followed by garbage', async () => {
    const garbage = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4096, 0x5a)]);
    await expect(normalizeBytes(garbage, 'broken.jpg')).rejects.toThrow(/"broken\.jpg" looks like jpeg but could not be decoded/);
  });

  it('rejects truncated JPEG and PNG files', async () => {
    const wholeJpeg = await jpeg();
    await expect(normalizeBytes(wholeJpeg.subarray(0, wholeJpeg.length / 2), 'half.jpg')).rejects.toThrow(/could not be decoded/);
    const wholePng = await png();
    await expect(normalizeBytes(wholePng.subarray(0, wholePng.length / 2), 'half.png')).rejects.toThrow(/could not be decoded/);
  });

  it('writes nothing when decoding fails', async () => {
    const whole = await jpeg();
    await normalizeBytes(whole.subarray(0, whole.length / 2), 'half.jpg', 'failed-out').catch(() => {});
    expect(existsSync(path.join(dir, 'failed-out'))).toBe(false);
  });

  it('reports a missing file', async () => {
    await expect(normalizeImage({ sourcePath: path.join(dir, 'gone.jpg'), originalName: 'gone.jpg', outDir: dir })).rejects.toThrow(/ENOENT/);
  });
});

describe('sizes', () => {
  it('keeps a very small image as it is', async () => {
    const png = await sharp(cornersRaw(16, 10), { raw: { width: 16, height: 10, channels: 3 } }).png().toBuffer();
    const result = await normalizeBytes(png, 'tiny.png');
    expect([result.width, result.height]).toEqual([16, 10]);
  });

  it('keeps every pixel of a very large image, because a 30-card photo needs them all', async () => {
    const jpeg = await sharp({ create: { width: 5000, height: 3000, channels: 3, background: '#808080' } }).jpeg({ quality: 50 }).toBuffer();
    const result = await normalizeBytes(jpeg, 'huge.jpg');
    expect([result.width, result.height]).toEqual([5000, 3000]);
    expect((await sharp(result.path).metadata()).width).toBe(5000);
  });
});

describe('colour', () => {
  const base = () => sharp(cornersRaw(120, 80), { raw: { width: 120, height: 80, channels: 3 } });

  async function expectSrgb(filePath: string) {
    const metadata = await sharp(filePath).metadata();
    expect(metadata.space).toBe('srgb');
    expect(metadata.channels).toBe(3);
    expect(metadata.icc).toBeUndefined();
  }

  it('converts CMYK to sRGB', async () => {
    const cmyk = await base().toColourspace('cmyk').jpeg().toBuffer();
    expect((await sharp(cmyk).metadata()).space).toBe('cmyk');
    const result = await normalizeBytes(cmyk, 'print.jpg');
    await expectSrgb(result.path);
    expect(isNear(pixelAt(await rawPixels(result.path), 20, 20), [220, 30, 30], 70)).toBe(true);
  });

  it('converts a wide-gamut P3 photo to sRGB rather than just dropping the profile', async () => {
    const p3 = await base().withIccProfile('p3').png().toBuffer();
    const stored = await sharp(p3, { ignoreIcc: true }).raw().toBuffer({ resolveWithObject: true });
    const storedRed = pixelAt({ data: stored.data, width: stored.info.width, height: stored.info.height, channels: stored.info.channels }, 20, 20);
    const result = await normalizeBytes(p3, 'iphone.png');
    await expectSrgb(result.path);
    const red = pixelAt(await rawPixels(result.path), 20, 20);
    expect(isNear(red, [220, 30, 30], 14)).toBe(true);
    expect(isNear(storedRed, [220, 30, 30], 14)).toBe(false);
  });

  it('gives greyscale and 16-bit images three 8-bit sRGB channels', async () => {
    const grey = await normalizeBytes(await base().greyscale().jpeg().toBuffer(), 'grey.jpg');
    await expectSrgb(grey.path);
    const deep = await normalizeBytes(await base().toColourspace('rgb16').png().toBuffer(), 'deep.png');
    await expectSrgb(deep.path);
    expect((await sharp(deep.path).metadata()).depth).toBe('uchar');
  });

  it('flattens transparency onto white', async () => {
    const transparent = await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const result = await normalizeBytes(transparent, 'clear.png');
    expect(isNear(pixelAt(await rawPixels(result.path), 20, 20), [255, 255, 255], 2)).toBe(true);
  });
});

describe('animated GIF', () => {
  it('uses the first frame only', async () => {
    const frame = (colour: number) => Buffer.alloc(64 * 48 * 3, colour);
    const stacked = Buffer.concat([frame(230), frame(20), frame(120)]);
    const gif = await sharp(stacked, { raw: { width: 64, height: 48 * 3, channels: 3, pageHeight: 48 } }).gif().toBuffer();
    expect((await sharp(gif, { animated: true }).metadata()).pages).toBe(3);

    const result = await normalizeBytes(gif, 'spinner.gif');

    expect([result.width, result.height]).toEqual([64, 48]);
    expect(result.sourceFormat).toBe('gif');
    expect(isNear(pixelAt(await rawPixels(result.path), 32, 24), [230, 230, 230], 12)).toBe(true);
  });
});

describe('safe re-runs', () => {
  it('gives the same output path for the same source and overwrites it', async () => {
    const png = await sharp(cornersRaw(60, 40), { raw: { width: 60, height: 40, channels: 3 } }).png().toBuffer();
    const sourcePath = path.join(dir, 'stable.png');
    await writeFile(sourcePath, png);
    const outDir = path.join(dir, 'rerun');

    const first = await normalizeImage({ sourcePath, originalName: 'stable.png', outDir });
    const firstBytes = await readFile(first.path);
    const second = await normalizeImage({ sourcePath, originalName: 'renamed.png', outDir });

    expect(second.path).toBe(first.path);
    expect(await readFile(second.path)).toEqual(firstBytes);
    expect(await readdir(outDir)).toEqual([path.basename(first.path)]);
  });

  it('gives two files with the same name different outputs', async () => {
    const png = await sharp(cornersRaw(60, 40), { raw: { width: 60, height: 40, channels: 3 } }).png().toBuffer();
    const a = path.join(dir, 'a-card.png');
    const b = path.join(dir, 'b-card.png');
    await writeFile(a, png);
    await writeFile(b, png);
    const outDir = path.join(dir, 'collide');
    const first = await normalizeImage({ sourcePath: a, originalName: 'card.png', outDir });
    const second = await normalizeImage({ sourcePath: b, originalName: 'card.png', outDir });
    expect(first.path).not.toBe(second.path);
  });
});

describe('HEIC', () => {
  /** A real HEIC made by macOS, or null where sips can't produce one. */
  async function makeHeic(jpeg: Buffer, name: string): Promise<Buffer | null> {
    const input = path.join(dir, `${name}.jpg`);
    const output = path.join(dir, `${name}.heic`);
    await writeFile(input, jpeg);
    try {
      await run('sips', ['-s', 'format', 'heic', input, '--out', output]);
      return await readFile(output);
    } catch {
      return null;
    }
  }

  it('converts a real HEIC', async (context) => {
    const jpeg = await sharp(cornersRaw(400, 240), { raw: { width: 400, height: 240, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    const heic = await makeHeic(jpeg, 'plain');
    if (!heic) return context.skip('sips could not produce a HEIC here');

    const result = await normalizeBytes(heic, 'IMG_0001.HEIC');

    expect(result.sourceFormat).toBe('heic');
    expect([result.width, result.height]).toEqual([400, 240]);
    expect((await sharp(result.path).metadata()).format).toBe('jpeg');
    expect(cornersMatch(await rawPixels(result.path))).toBe(true);
  }, HEIC_TIMEOUT);

  it('applies the rotation stored in the HEIC container, as iPhones write it', async (context) => {
    const jpeg = await storedForOrientation(6, 400, 240).withMetadata({ orientation: 6 }).jpeg({ quality: 95 }).toBuffer();
    const heic = await makeHeic(jpeg, 'rotated');
    if (!heic) return context.skip('sips could not produce a HEIC here');
    expect(heic.includes(Buffer.from('irot'))).toBe(true);

    const result = await normalizeBytes(heic, 'IMG_0002.HEIC');

    expect([result.width, result.height]).toEqual([400, 240]);
    expect(cornersMatch(await rawPixels(result.path))).toBe(true);
  }, HEIC_TIMEOUT);

  it('detects a HEIC named .jpg and rejects a truncated one', async (context) => {
    const jpeg = await sharp(cornersRaw(400, 240), { raw: { width: 400, height: 240, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
    const heic = await makeHeic(jpeg, 'mislabelled');
    if (!heic) return context.skip('sips could not produce a HEIC here');

    expect((await normalizeBytes(heic, 'holiday.jpg')).sourceFormat).toBe('heic');
    await expect(normalizeBytes(heic.subarray(0, heic.length / 2), 'half.heic')).rejects.toThrow(/"half\.heic" looks like heic but could not be decoded/);
  }, HEIC_TIMEOUT);
});

describe('DNG', () => {
  type Tiff = { tag: number; type: 1 | 3 | 4; count: number; value: number | number[] };

  /** One 12-byte little-endian TIFF entry with its value stored inline. */
  function entry({ tag, type, count, value }: Tiff): Buffer {
    const out = Buffer.alloc(12);
    out.writeUInt16LE(tag, 0);
    out.writeUInt16LE(type, 2);
    out.writeUInt32LE(count, 4);
    if (type === 3) out.writeUInt16LE(value as number, 8);
    else if (type === 4) out.writeUInt32LE(value as number, 8);
    else Buffer.from(value as number[]).copy(out, 8);
    return out;
  }
  const ifd = (entries: Tiff[]) =>
    Buffer.concat([Buffer.from([entries.length & 255, entries.length >> 8]), ...entries.map(entry), Buffer.alloc(4)]);

  /**
   * A DNG laid out like Adobe's: a tiny thumbnail as the first image, then a SubIFD
   * holding the full-size JPEG preview. Stored upright-or-not according to `orientation`.
   */
  function buildDng(input: { orientation: number; jpeg: Buffer; width: number; height: number; raw?: { width: number; height: number } }): Buffer {
    const subEntries = (jpegAt: number): Tiff[] => [
      { tag: 254, type: 4, count: 1, value: 0 },
      { tag: 256, type: 4, count: 1, value: input.width },
      { tag: 257, type: 4, count: 1, value: input.height },
      { tag: 259, type: 3, count: 1, value: 7 },
      { tag: 262, type: 3, count: 1, value: 6 },
      { tag: 273, type: 4, count: 1, value: jpegAt },
      { tag: 277, type: 3, count: 1, value: 3 },
      { tag: 279, type: 4, count: 1, value: input.jpeg.length },
    ];
    const ifd0 = (subAt: number, thumbAt: number): Tiff[] => [
      { tag: 254, type: 4, count: 1, value: 1 },
      { tag: 256, type: 4, count: 1, value: 64 },
      { tag: 257, type: 4, count: 1, value: 40 },
      { tag: 259, type: 3, count: 1, value: 1 },
      { tag: 262, type: 3, count: 1, value: 2 },
      { tag: 273, type: 4, count: 1, value: thumbAt },
      { tag: 274, type: 3, count: 1, value: input.orientation },
      { tag: 277, type: 3, count: 1, value: 3 },
      { tag: 279, type: 4, count: 1, value: 16 },
      { tag: 330, type: 4, count: 1, value: subAt },
      { tag: 50706, type: 1, count: 4, value: [1, 4, 0, 0] },
    ];
    const ifd0Size = ifd(ifd0(0, 0)).length;
    const subAt = 8 + ifd0Size;
    const thumbAt = subAt + ifd(subEntries(0)).length;
    const jpegAt = thumbAt + 16;
    const header = Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
    return Buffer.concat([header, ifd(ifd0(subAt, thumbAt)), ifd(subEntries(jpegAt)), Buffer.alloc(16), input.jpeg]);
  }

  it.each([1, 2, 3, 4, 5, 6, 7, 8])(
    'uses the full-size preview, not the thumbnail, and turns orientation %i upright',
    async (orientation) => {
      const stored = storedForOrientation(orientation, 1800, 1100);
      const jpeg = await stored.jpeg({ quality: 95 }).toBuffer();
      const { width, height } = await sharp(jpeg).metadata();
      const dng = buildDng({ orientation, jpeg, width: width!, height: height! });

      const result = await normalizeBytes(dng, `IMG_${orientation}.DNG`);

      expect(result.sourceFormat).toBe('dng');
      expect([result.width, result.height]).toEqual([1800, 1100]);
      expect(cornersMatch(await rawPixels(result.path))).toBe(true);
    },
  );

  it('refuses a DNG whose only viewable image is a thumbnail, and says what to do', async () => {
    const tinyJpeg = await storedForOrientation(1, 400, 240).jpeg().toBuffer();
    const dng = buildDng({ orientation: 1, jpeg: tinyJpeg, width: 400, height: 240 });
    await expect(normalizeBytes(dng, 'thumb.dng')).rejects.toThrow(/"thumb\.dng" is a DNG whose only viewable image is 400 pixels across.*Export it as a JPEG or HEIC/);
  });

  it('reads a plain TIFF with a .dng name as a TIFF', async () => {
    const tiff = await sharp(cornersRaw(400, 240), { raw: { width: 400, height: 240, channels: 3 } }).tiff().toBuffer();
    const result = await normalizeBytes(tiff, 'IMG_0001.DNG');

    expect(result.sourceFormat).toBe('tiff');
    expect(cornersMatch(await rawPixels(result.path))).toBe(true);
  });

  it('does not trust a damaged DNG structure', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const dng = buildDng({ orientation: 1, jpeg, width: 2000, height: 1000 });
    expect(readDng(dng)).not.toBeNull();
    expect(readDng(dng.subarray(0, 30))).toBeNull();
    const loop = Buffer.from(dng);
    loop.writeUInt32LE(8, 8 + 2 + 11 * 12); // IFD0's next-IFD pointer back to itself
    expect(readDng(loop)).not.toBeNull();
    expect(readDng(Buffer.from('II*\0\xff\xff\xff\xff', 'latin1'))).toBeNull();
  });

  it('decodes a real iPhone DNG when one is on this machine', async (context) => {
    const sample = path.join(process.env.HOME ?? '', 'Downloads', 'IMG_7681.DNG');
    if (!existsSync(sample)) return context.skip('no sample DNG available');

    const result = await normalizeImage({ sourcePath: sample, originalName: 'IMG_7681.DNG', outDir: path.join(dir, 'dng') });
    expect(result.sourceFormat).toBe('dng');
    expect(Math.max(result.width, result.height)).toBeGreaterThanOrEqual(4000);
  }, HEIC_TIMEOUT);
});
