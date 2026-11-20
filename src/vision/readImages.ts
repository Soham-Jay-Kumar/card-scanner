import path from 'node:path';
import sharp from 'sharp';
import type { Sharp } from 'sharp';
import { CONFIG } from '../shared/config.ts';
import type { CardCrop, ReadImages } from '../shared/contracts.ts';
import { enhanceContrast } from './enhance.ts';
import { stemOf, writeFileAtomic } from './files.ts';

/** Read C is this much larger than read A. */
const ENLARGE_FACTOR = 1.5;

const { cropMinLongEdge, cropMaxLongEdge, jpegQuality } = CONFIG.image;
/** A stops here so that C, ENLARGE_FACTOR larger, still fits under cropMaxLongEdge. */
const naturalMaxLongEdge = cropMaxLongEdge / ENLARGE_FACTOR;

function resizedTo(crop: CardCrop, longEdge: number): Sharp {
  return sharp(crop.path).resize({ width: longEdge, height: longEdge, fit: 'inside' });
}

async function saveJpeg(image: Sharp, outPath: string): Promise<string> {
  await writeFileAtomic(outPath, await image.jpeg({ quality: jpegQuality, chromaSubsampling: '4:4:4' }).toBuffer());
  return outPath;
}

export async function prepareCardReadImages(crop: CardCrop, outDir: string): Promise<ReadImages> {
  const longEdge = Math.max(crop.width, crop.height);
  const naturalEdge = Math.round(Math.min(naturalMaxLongEdge, Math.max(cropMinLongEdge, longEdge)));
  const enlargedEdge = Math.round(naturalEdge * ENLARGE_FACTOR);

  const outPath = (variant: keyof ReadImages) => path.join(outDir, `${stemOf(crop.path)}-${variant}.jpg`);
  const [A, B, C] = await Promise.all([
    saveJpeg(resizedTo(crop, naturalEdge), outPath('A')),
    saveJpeg(enhanceContrast(resizedTo(crop, naturalEdge)), outPath('B')),
    saveJpeg(resizedTo(crop, enlargedEdge), outPath('C')),
  ]);
  return { A, B, C };
}
