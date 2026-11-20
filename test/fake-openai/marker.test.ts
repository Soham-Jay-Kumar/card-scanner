/**
 * The card ID must survive everything the app does to an image, including cropping
 * from a sheet of 42 cards at phone-photo resolution.
 */
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { buildSheet } from '../synth/sheets.ts';
import { decodeCells, decodeMarkers, encodeCells, markerSvg, markerToBox, MAX_MARKER_ID, primaryMarker } from './marker.ts';

async function card(id: number, width = 1050, background = '#ffffff'): Promise<Buffer> {
  const height = Math.round(width / 1.75);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${background}"/>${markerSvg(id, width)}<circle cx="${width / 2}" cy="${height * 0.6}" r="${height / 6}" fill="#884422"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

describe('marker code', () => {
  it('round-trips every ID, with no neighbouring cells alike', () => {
    for (let id = 0; id <= MAX_MARKER_ID; id += 1) {
      const cells = encodeCells(id);
      expect(decodeCells(cells)).toBe(id);
      for (let index = 1; index < cells.length; index += 1) expect(cells[index]).not.toBe(cells[index - 1]);
    }
  });

  it('turns down a damaged code', () => {
    const cells = encodeCells(1234);
    const reversed = [...cells].reverse();
    expect(decodeCells(reversed)).toBeNull();
    expect(decodeCells(cells.slice(0, -1))).toBeNull();

    let accepted = 0;
    for (let index = 1; index <= 11; index += 1) {
      for (const colour of [1, 2, 3, 5]) {
        if (colour === cells[index]) continue;
        const damaged = [...cells];
        damaged[index] = colour;
        const decoded = decodeCells(damaged);
        if (decoded !== null) {
          expect(decoded).not.toBe(1234);
          accepted += 1;
        }
      }
    }
    // A change in one cell shifts every later value, and the 5-bit check catches about 31 in 32.
    expect(accepted).toBeLessThanOrEqual(3);
  });
});

describe('finding markers in images', () => {
  it('reports direction and box for every rotation', async () => {
    const image = await card(77);
    for (const [angle, rotation] of [[0, 0], [90, 270], [180, 180], [270, 90]] as const) {
      const turned = await sharp(image).rotate(angle).png().toBuffer();
      const markers = await decodeMarkers(turned);
      expect(markers.map((marker) => marker.id)).toEqual([77]);
      const box = markerToBox(markers[0]!, 1.75);
      expect(box.rotation).toBe(rotation);
      expect(box.x_max - box.x_min).toBeGreaterThan(960);
      expect(box.y_max - box.y_min).toBeGreaterThan(960);
    }
  });

  it('survives the read image steps: crop, enlarge, sharpen, JPEG', async () => {
    const image = await card(2048, 700);
    const enlarged = await sharp(image).resize({ width: 3000 }).jpeg({ quality: 92 }).toBuffer();
    const enhanced = await sharp(image).resize({ width: 1800 }).normalise().clahe({ width: 64, height: 64 }).sharpen({ sigma: 1.4 }).jpeg({ quality: 92 }).toBuffer();
    expect((await decodeMarkers(enlarged)).map((marker) => marker.id)).toEqual([2048]);
    expect((await decodeMarkers(enhanced)).map((marker) => marker.id)).toEqual([2048]);
  });

  it('reads a dark card, a dim photo and a blurred one', async () => {
    const dark = await card(901, 900, '#14171c');
    const dim = await sharp(await card(902, 900)).linear(0.25, 0).png().toBuffer();
    const blurred = await sharp(await card(903, 900)).blur(4).png().toBuffer();
    expect((await decodeMarkers(dark)).map((marker) => marker.id)).toEqual([901]);
    expect((await decodeMarkers(dim)).map((marker) => marker.id)).toEqual([902]);
    expect((await decodeMarkers(blurred)).map((marker) => marker.id)).toEqual([903]);
  });

  it('finds nothing in an image with no strip', async () => {
    const plain = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#808080' } }).png().toBuffer();
    expect(await decodeMarkers(plain)).toEqual([]);
  });

  it('picks the card filling the frame over a neighbour whose strip shows at the edge', async () => {
    const main = await card(10);
    const neighbour = await card(11);
    const tall = await sharp({ create: { width: 1050, height: 720, channels: 3, background: '#808080' } })
      .composite([
        { input: main, left: 0, top: 0 },
        { input: neighbour, left: 0, top: 608 },
      ])
      .png()
      .toBuffer();
    const markers = await decodeMarkers(tall);
    expect(markers.map((marker) => marker.id).sort()).toEqual([10, 11]);
    expect(primaryMarker(markers, () => 1.75)?.id).toBe(10);
  });
});

describe('markers on sheets of 30 or more cards', () => {
  // One case by default for speed. RUN_FULL_SYNTH=1 runs the rest.
  const cases = [
    { count: 42, layout: 'uneven', resolution: 'phone_low' },
    ...(process.env.RUN_FULL_SYNTH === '1'
      ? ([
          { count: 42, layout: 'grid', resolution: 'phone' },
          { count: 42, layout: 'mixed_rotation', resolution: 'phone' },
          { count: 36, layout: 'overlap', resolution: 'phone' },
        ] as const)
      : []),
  ] as const;

  for (const { count, layout, resolution } of cases) {
    it(`finds all ${count} on a ${layout} sheet at ${resolution}, and in each crop`, async () => {
      const ids = Array.from({ length: count }, (_, index) => 500 + index);
      const cards = await Promise.all(ids.map((id) => card(id, 700)));
      const sheet = await buildSheet(cards, { layout, resolution, seed: 3 });
      const seen = await decodeMarkers(sheet.image, [3000]);
      expect(seen.map((marker) => marker.id)).toEqual(ids);

      // The same crop-and-enlarge Vision does, with its 4% margin, so neighbours' slivers come along.
      const { data, info } = await sharp(sheet.image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const raw = { raw: { width: info.width, height: info.height, channels: info.channels } };
      for (const place of sheet.placed.filter((_, index) => index % 5 === 0)) {
        const marginX = place.box.width * 0.04;
        const marginY = place.box.height * 0.04;
        const left = Math.max(0, Math.floor(place.box.x - marginX));
        const top = Math.max(0, Math.floor(place.box.y - marginY));
        const width = Math.min(info.width - left, Math.ceil(place.box.width + 2 * marginX));
        const height = Math.min(info.height - top, Math.ceil(place.box.height + 2 * marginY));
        // Two steps on purpose: chaining resize after rotate makes sharp rotate before it extracts.
        const upright = await sharp(data, raw).extract({ left, top, width, height }).rotate(place.rotationNeeded).png().toBuffer();
        const crop = await sharp(upright).resize({ width: 1800, height: 1800, fit: 'inside' }).jpeg({ quality: 92 }).toBuffer();
        const markers = await decodeMarkers(crop);
        expect(primaryMarker(markers, () => 1.75)?.id).toBe(ids[place.index]);
      }
    }, 60_000);
  }
});
