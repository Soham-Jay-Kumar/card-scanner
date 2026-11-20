import type { Sharp } from 'sharp';

/**
 * Stretches luminance across the full range, then sharpens. Both work on
 * luminance only, so hue survives and light text on dark stock stays light.
 */
export function enhanceContrast(image: Sharp): Sharp {
  return image.normalise({ lower: 1, upper: 99 }).sharpen({ sigma: 1 });
}
