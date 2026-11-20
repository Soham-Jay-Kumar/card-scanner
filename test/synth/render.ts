/** Turns card content into pixels: Chrome for designed cards, sharp SVG for bulk ones. */
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import sharp from 'sharp';

import { markerClearance, markerSvg } from '../fake-openai/marker.ts';
import { phoneLine } from './content.ts';
import type { CardContent, Design } from './content.ts';

export const CARD_WIDTH = 1050;
export const CARD_HEIGHT = 600;

export function cardSize(content: CardContent): { width: number; height: number } {
  return content.design.layout === 'vertical' ? { width: CARD_HEIGHT, height: CARD_WIDTH } : { width: CARD_WIDTH, height: CARD_HEIGHT };
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function logo(design: Design, size: number): string {
  const c = design.accent;
  const shape = {
    circle: `<circle cx="50" cy="50" r="46" fill="${c}"/>`,
    square: `<rect x="8" y="8" width="84" height="84" rx="12" fill="${c}"/>`,
    diamond: `<path d="M50 4 96 50 50 96 4 50Z" fill="${c}"/>`,
    bars: `<rect x="8" y="10" width="20" height="80" fill="${c}"/><rect x="40" y="30" width="20" height="60" fill="${c}"/><rect x="72" y="50" width="20" height="40" fill="${c}"/>`,
    none: '',
  }[design.logo];
  return shape ? `<svg width="${size}" height="${size}" viewBox="0 0 100 100">${shape}</svg>` : '';
}

const line = (text: string, style: string) => `<div class="fit" style="${style};white-space:nowrap;width:fit-content">${escape(text)}</div>`;

function contactLines(content: CardContent, size: number): string {
  const lines = [...content.phones.map(phoneLine), ...content.emails, ...content.websites, ...content.extraLines];
  return lines.map((text) => line(text, `font-size:${size}px;line-height:1.32`)).join('');
}

function bodyHtml(content: CardContent, width: number, height: number): string {
  const { design } = content;
  const name = content.name ? line(content.name, `font-size:46px;font-weight:600;line-height:1.15`) : '';
  const position = content.position ? line(content.position, `font-size:27px;line-height:1.3;color:${design.accent}`) : '';
  const company = content.company ? line(content.company, `font-size:31px;font-weight:600;line-height:1.3`) : '';
  const top = markerClearance(width);
  const count = content.phones.length + content.emails.length + content.websites.length + content.extraLines.length;
  const size = count > 5 ? 21 : 25;

  switch (design.layout) {
    case 'center':
      return `<div style="position:absolute;inset:${top}px 60px 60px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:8px">${logo(design, 44)}${company}${name}${position}<div style="height:8px"></div>${contactLines(content, size)}</div>`;
    case 'split':
      return `<div style="position:absolute;left:0;top:${top}px;bottom:0;width:36%;background:${design.accent};color:#fff;padding:24px;box-sizing:border-box;display:flex;flex-direction:column;gap:14px">${logo({ ...design, accent: '#ffffff' }, 56)}<div style="font-size:26px;font-weight:600;line-height:1.2">${escape(content.company)}</div></div><div style="position:absolute;left:39%;right:60px;top:${top + 14}px;bottom:60px;display:flex;flex-direction:column;justify-content:center;gap:6px">${name}${position}<div style="height:10px"></div>${contactLines(content, size)}</div>`;
    case 'band':
      return `<div style="position:absolute;inset:${top}px 60px auto;display:flex;justify-content:space-between;align-items:flex-start"><div>${name}${position}${company}</div>${logo(design, 72)}</div><div style="position:absolute;left:60px;right:60px;bottom:62px">${contactLines(content, size)}</div>`;
    case 'vertical':
      return `<div style="position:absolute;inset:${top + 16}px 44px 60px;display:flex;flex-direction:column;gap:10px">${logo(design, 84)}<div style="height:12px"></div>${content.name ? line(content.name, 'font-size:38px;font-weight:600') : ''}${position}${company}<div style="flex:1"></div>${contactLines(content, 22)}</div>`;
    default:
      return `<div style="position:absolute;inset:${top}px 60px 60px;display:flex;flex-direction:column;gap:4px"><div style="display:flex;justify-content:space-between;align-items:flex-start"><div>${name}${position}${company}</div>${logo(design, 78)}</div><div style="flex:1"></div>${contactLines(content, size)}</div>`;
  }
}

export function cardHtml(content: CardContent, markerId: number): string {
  const { width, height } = cardSize(content);
  const { design } = content;
  const marker = `<svg style="position:absolute;left:0;top:0;z-index:2" width="${width}" height="${markerClearance(width)}">${markerSvg(markerId, width)}</svg>`;
  return `<!doctype html><meta charset="utf-8"><body style="margin:0"><div id="card" style="position:relative;width:${width}px;height:${height}px;background:${design.background};color:${design.ink};font-family:${design.font},'Hiragino Sans','PingFang SC','Kohinoor Devanagari','Geeza Pro',sans-serif;overflow:hidden">${marker}${bodyHtml(content, width, height)}</div></body>`;
}

/**
 * Shrinks any line that would run off the card or under a logo. Truth lists every
 * value as printed, so a value that runs off the edge would make the truth false.
 */
const SHRINK_TO_FIT = `(() => {
  const card = document.getElementById('card').getBoundingClientRect();
  const limit = card.right - 44;
  for (const el of document.querySelectorAll('.fit')) {
    let size = parseFloat(getComputedStyle(el).fontSize);
    while (el.getBoundingClientRect().right > limit && size > 10) {
      size -= 1;
      el.style.fontSize = size + 'px';
    }
  }
})()`;

export interface Renderer {
  render(content: CardContent, markerId: number): Promise<Buffer>;
  close(): Promise<void>;
}

/** Uses the installed Chrome. Playwright's own browser builds are not downloaded. */
export async function openRenderer(): Promise<Renderer> {
  const browser: Browser = await chromium.launch({ channel: 'chrome' });
  const page: Page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
  return {
    async render(content, markerId) {
      await page.setContent(cardHtml(content, markerId));
      await page.evaluate(SHRINK_TO_FIT);
      return page.locator('#card').screenshot({ type: 'png' });
    },
    close: () => browser.close(),
  };
}

/** A plain card drawn without a browser. Fast enough for thousands. */
export function bulkCardPng(content: CardContent, markerId: number, width = 840): Promise<Buffer> {
  const height = Math.round(width / (CARD_WIDTH / CARD_HEIGHT));
  const scale = width / CARD_WIDTH;
  const text = (x: number, y: number, size: number, value: string, weight = 400) =>
    `<text x="${x * scale}" y="${y * scale}" font-size="${size * scale}" font-weight="${weight}" font-family="Helvetica, Arial, sans-serif" fill="#1a1c20">${escape(value)}</text>`;
  const lines = [...content.phones.map(phoneLine), ...content.emails, ...content.websites];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#fdfcf8"/>${markerSvg(markerId, width)}${text(60, 190, 50, content.name, 600)}${text(60, 238, 30, content.position)}${text(60, 282, 32, content.company, 600)}${lines.map((value, index) => text(60, 380 + index * 42, 28, value)).join('')}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
