import type { CreateVisionService } from '../shared/contracts.ts';
import { cropCards } from './crop.ts';
import { locateCards } from './locate.ts';
import { normalizeImage } from './normalize.ts';
import { assessImageQuality } from './quality.ts';
import { prepareCardReadImages } from './readImages.ts';

export const createVisionService: CreateVisionService = ({ llm }) => ({
  normalize: normalizeImage,
  assessQuality: assessImageQuality,
  locate: (image, ctx) => locateCards(llm, image, ctx),
  crop: cropCards,
  prepareReadImages: prepareCardReadImages,
});
