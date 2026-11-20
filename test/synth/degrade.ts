/** Ways a card photo goes wrong. Each one is plain sharp or pixel work, and repeatable. */
import sharp from 'sharp';

export type Degradation =
  | { kind: 'table'; colour?: string; marginFraction?: number }
  | { kind: 'rotate'; angle: 90 | 180 | 270 }
  | { kind: 'skew'; degrees: number }
  | { kind: 'perspective'; strength: number }
  | { kind: 'blur'; sigma: number }
  | { kind: 'dim'; factor: number }
  | { kind: 'glare' }
  | { kind: 'shrink'; width: number };

const TABLE = '#6f6256';

function hexToRgb(hex: string): [number, number, number] {
  const value = parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** Solves for the eight numbers of a homography mapping four points to four others. */
function homography(from: Array<[number, number]>, to: Array<[number, number]>): number[] {
  const rows: number[][] = [];
  for (let index = 0; index < 4; index += 1) {
    const [x, y] = from[index]!;
    const [u, v] = to[index]!;
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let column = 0; column < 8; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 8; row += 1) {
      if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivot]![column]!)) pivot = row;
    }
    [rows[column], rows[pivot]] = [rows[pivot]!, rows[column]!];
    const lead = rows[column]![column]!;
    for (let cell = column; cell < 9; cell += 1) rows[column]![cell]! /= lead;
    for (let row = 0; row < 8; row += 1) {
      if (row === column) continue;
      const factor = rows[row]![column]!;
      for (let cell = column; cell < 9; cell += 1) rows[row]![cell]! -= factor * rows[column]![cell]!;
    }
  }
  return rows.map((row) => row[8]!);
}

async function perspective(image: Buffer, strength: number, background: string): Promise<Buffer> {
  const { data, info } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const inset = strength * width;
  // Far side of the card leans away, so spacing along the strip truly changes.
  const seen: Array<[number, number]> = [
    [inset * 0.5, inset * 0.6],
    [width - 1, 0],
    [width - 1, height - 1],
    [inset * 0.5, height - 1 - inset * 0.6],
  ];
  const source: Array<[number, number]> = [
    [0, 0],
    [width - 1, 0],
    [width - 1, height - 1],
    [0, height - 1],
  ];
  const [a, b, c, d, e, f, g, h] = homography(seen, source) as [number, number, number, number, number, number, number, number];
  const fill = hexToRgb(background);
  const out = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const scale = g * x + h * y + 1;
      const sx = (a * x + b * y + c) / scale;
      const sy = (d * x + e * y + f) / scale;
      const at = (y * width + x) * 3;
      if (sx < 0 || sy < 0 || sx >= width - 1 || sy >= height - 1) {
        out[at] = fill[0];
        out[at + 1] = fill[1];
        out[at + 2] = fill[2];
        continue;
      }
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const dx = sx - x0;
      const dy = sy - y0;
      for (let band = 0; band < 3; band += 1) {
        const p = (x0 + y0 * width) * channels + band;
        const q = p + channels;
        const r = p + width * channels;
        const s = r + channels;
        out[at + band] = Math.round(
          data[p]! * (1 - dx) * (1 - dy) + data[q]! * dx * (1 - dy) + data[r]! * (1 - dx) * dy + data[s]! * dx * dy,
        );
      }
    }
  }
  return sharp(out, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function glare(image: Buffer): Promise<Buffer> {
  const { width, height } = await sharp(image).metadata();
  // Low on the card, so it washes out printed text and never the marker strip at the top.
  const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><radialGradient id="g"><stop offset="0" stop-color="#fff" stop-opacity="0.95"/><stop offset="0.45" stop-color="#fff" stop-opacity="0.6"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><ellipse cx="${width * 0.66}" cy="${height * 0.74}" rx="${width * 0.3}" ry="${height * 0.2}" fill="url(#g)"/></svg>`;
  return sharp(image).composite([{ input: Buffer.from(overlay), blend: 'over' }]).png().toBuffer();
}

export async function applyDegradations(image: Buffer, steps: Degradation[]): Promise<Buffer> {
  let current = image;
  for (const step of steps) {
    switch (step.kind) {
      case 'table': {
        const { width } = await sharp(current).metadata();
        const margin = Math.round(width * (step.marginFraction ?? 0.08));
        current = await sharp(current)
          .extend({ top: margin, bottom: margin, left: margin, right: margin, background: step.colour ?? TABLE })
          .png()
          .toBuffer();
        break;
      }
      case 'rotate':
        current = await sharp(current).rotate(step.angle).png().toBuffer();
        break;
      case 'skew':
        current = await sharp(current).rotate(step.degrees, { background: TABLE }).png().toBuffer();
        break;
      case 'perspective':
        current = await perspective(current, step.strength, TABLE);
        break;
      case 'blur':
        current = await sharp(current).blur(step.sigma).png().toBuffer();
        break;
      case 'dim':
        current = await sharp(current).linear([step.factor, step.factor * 0.94, step.factor * 0.84], [0, 0, 0]).png().toBuffer();
        break;
      case 'glare':
        current = await glare(current);
        break;
      case 'shrink':
        current = await sharp(current).resize({ width: step.width }).png().toBuffer();
        break;
    }
  }
  return current;
}

/** A busy photo with no card in it. */
export function noCardPhoto(width = 1600, height = 1200): Promise<Buffer> {
  const shapes = Array.from({ length: 18 }, (_, index) => {
    const x = (index * 433) % width;
    const y = (index * 271) % height;
    const r = 40 + ((index * 37) % 160);
    const shade = 60 + ((index * 53) % 120);
    return `<ellipse cx="${x}" cy="${y}" rx="${r}" ry="${r * 0.6}" fill="rgb(${shade},${shade - 20},${shade - 40})" opacity="0.7"/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="#8c7a64"/><stop offset="1" stop-color="#3f3a33"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>${shapes}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toBuffer();
}
