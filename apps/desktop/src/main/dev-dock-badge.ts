import { GLYPH_HEIGHT, GLYPH_ROWS, GLYPH_WIDTH, glyphKeyFor, SPACE } from './dev-dock-glyphs';

export { GLYPH_HEIGHT, GLYPH_WIDTH } from './dev-dock-glyphs';

export interface Bgra {
  b: number;
  g: number;
  r: number;
  a: number;
}

export const BADGE_BACKGROUND: Bgra = Object.freeze({ b: 18, g: 18, r: 22, a: 255 });
export const BADGE_FOREGROUND: Bgra = Object.freeze({ b: 255, g: 255, r: 255, a: 255 });
export const BADGE_MUTED: Bgra = Object.freeze({ b: 176, g: 176, r: 176, a: 255 });
export const BADGE_DEV_TAG: Bgra = Object.freeze({ b: 60, g: 180, r: 255, a: 255 });
export const BADGE_PACKAGED_TAG: Bgra = Object.freeze({ b: 255, g: 170, r: 90, a: 255 });

export interface DockBadgeGateInput {
  isReleaseBuild: boolean;
  badgeEnv: string | undefined;
}

export function shouldBadgeDockIcon(input: DockBadgeGateInput): boolean {
  if (input.isReleaseBuild) return false;
  const raw = (input.badgeEnv ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false;
  return true;
}

export type BadgeRuntime = 'dev' | 'packaged';

export interface BadgeLabel {
  runtime: BadgeRuntime;
  headline: string | null;
  words: string[];
  port: string | null;
}

export function badgeLabelIsEmpty(label: BadgeLabel): boolean {
  return label.headline === null && label.words.length === 0 && label.port === null;
}

export function runtimeTagText(runtime: BadgeRuntime): string {
  return runtime === 'dev' ? 'DEV' : 'PKG';
}

export function runtimeTagColor(runtime: BadgeRuntime): Bgra {
  return runtime === 'dev' ? BADGE_DEV_TAG : BADGE_PACKAGED_TAG;
}

const BRANCH_PREFIX = /^(feature|fix|chore|plan|test|docs|refactor|perf|ci)\//i;
const REPO_PREFIX = /^waypoint[-_]/i;
const TICKET = /^TASK[-_]?(\d+)[-_]?(.*)$/i;

export function deriveBadgeLabel(input: {
  label?: string | null;
  port?: string | number | null;
  packaged?: boolean;
}): BadgeLabel {
  let raw = (input.label ?? '').trim();
  raw = raw.replace(BRANCH_PREFIX, '').replace(REPO_PREFIX, '');

  let headline: string | null = null;
  const ticketMatch = TICKET.exec(raw);
  if (ticketMatch) {
    headline = ticketMatch[1] ?? null;
    raw = ticketMatch[2] ?? '';
  }

  const words = raw
    .split(/[-_.\s/]+/)
    .map((word) =>
      word
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9:+/.-]/g, '')
    )
    .filter((word) => word.length > 0);

  const portDigits = String(input.port ?? '')
    .trim()
    .replace(/\D/g, '');

  if (headline === null && words.length > 0 && /^\d/.test(words[0])) {
    headline = words[0];
    words.shift();
  }

  return {
    runtime: input.packaged === true ? 'packaged' : 'dev',
    headline,
    words,
    port: portDigits === '' ? null : portDigits,
  };
}

interface RectSpec {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function blendPixel(
  bitmap: Buffer,
  imageWidth: number,
  imageHeight: number,
  x: number,
  y: number,
  color: Bgra
): void {
  if (x < 0 || y < 0 || x >= imageWidth || y >= imageHeight) return;
  const offset = (y * imageWidth + x) * 4;
  if (offset + 3 >= bitmap.length) return;
  const alpha = Math.max(0, Math.min(255, color.a)) / 255;
  const inverse = 1 - alpha;
  bitmap[offset] = Math.round(color.b * alpha + bitmap[offset] * inverse);
  bitmap[offset + 1] = Math.round(color.g * alpha + bitmap[offset + 1] * inverse);
  bitmap[offset + 2] = Math.round(color.r * alpha + bitmap[offset + 2] * inverse);
  bitmap[offset + 3] = Math.max(bitmap[offset + 3], Math.round(color.a));
}

export function fillRect(
  bitmap: Buffer,
  imageWidth: number,
  imageHeight: number,
  rect: RectSpec,
  color: Bgra
): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      blendPixel(bitmap, imageWidth, imageHeight, x, y, color);
    }
  }
}

export function measureGlyphText(text: string, scale: number): number {
  if (text.length === 0) return 0;
  return text.length * GLYPH_WIDTH * scale + (text.length - 1) * scale;
}

export interface DrawTextOptions {
  text: string;
  originX: number;
  originY: number;
  scale: number;
  color: Bgra;
}

export function drawGlyphText(
  bitmap: Buffer,
  imageWidth: number,
  imageHeight: number,
  options: DrawTextOptions
): void {
  let cursorX = options.originX;
  for (const character of options.text) {
    const key = glyphKeyFor(character);
    if (key !== null) {
      const glyph = GLYPH_ROWS[key];
      for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
        const bits = glyph?.[row] ?? 0;
        for (let column = 0; column < GLYPH_WIDTH; column += 1) {
          if ((bits & (1 << (GLYPH_WIDTH - 1 - column))) === 0) continue;
          fillRect(
            bitmap,
            imageWidth,
            imageHeight,
            {
              x: cursorX + column * options.scale,
              y: options.originY + row * options.scale,
              width: options.scale,
              height: options.scale,
            },
            options.color
          );
        }
      }
    }
    cursorX += (GLYPH_WIDTH + 1) * options.scale;
  }
}

export interface BadgeTextLine {
  text: string;
  scale: number;
  originX: number;
  originY: number;
  color: Bgra;
}

export interface BadgeIconLayout {
  logo: RectSpec;
  headline: BadgeTextLine | null;
  body: BadgeTextLine[];
  cornerRadius: number;
}

export function wrapWords(words: string[], scale: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current === '' ? word : `${current}${SPACE}${word}`;
    if (measureGlyphText(candidate, scale) <= maxWidth || current === '') {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

function largestScaleFitting(text: string, maxWidth: number, maxScale: number): number {
  for (let scale = maxScale; scale > 1; scale -= 1) {
    if (measureGlyphText(text, scale) <= maxWidth) return scale;
  }
  return 1;
}

export function runtimeLineText(label: BadgeLabel): string {
  const tag = runtimeTagText(label.runtime);
  return label.port === null ? tag : `${tag}:${label.port}`;
}

export function computeBadgeIconLayout(
  imageWidth: number,
  imageHeight: number,
  label: BadgeLabel
): BadgeIconLayout | null {
  if (imageWidth <= 0 || imageHeight <= 0 || badgeLabelIsEmpty(label)) return null;

  const pad = Math.max(2, Math.round(imageWidth * 0.045));
  const gapX = Math.max(2, Math.round(imageWidth * 0.04));
  const gapY = Math.max(1, Math.round(imageHeight * 0.02));
  const blockGap = Math.max(2, Math.round(imageHeight * 0.035));
  const usableWidth = imageWidth - pad * 2;
  if (usableWidth < GLYPH_WIDTH) return null;
  const cornerRadius = Math.round(imageWidth * 0.22);

  const logoSize = Math.max(1, Math.round(imageWidth * 0.34));
  let headlineScale = 0;
  if (label.headline !== null && label.headline !== '') {
    const regionWidth = imageWidth - pad - (pad + logoSize + gapX);
    const heightCap = Math.max(1, Math.floor(logoSize / GLYPH_HEIGHT));
    headlineScale = Math.min(
      heightCap,
      largestScaleFitting(label.headline, Math.max(GLYPH_WIDTH, regionWidth), heightCap)
    );
  }
  const topHeight = logoSize;

  const runtimeText = runtimeLineText(label);
  const bottomBudget = imageHeight - pad * 2 - topHeight - blockGap;
  const maxBodyScale = Math.max(1, Math.floor(bottomBudget / GLYPH_HEIGHT));

  let bodyScale = 1;
  let wrapped: string[] = [];
  for (let scale = maxBodyScale; scale >= 1; scale -= 1) {
    const candidate = wrapWords(label.words, scale, usableWidth);
    const lineCount = candidate.length + 1;
    const total = lineCount * GLYPH_HEIGHT * scale + Math.max(0, lineCount - 1) * gapY;
    const runtimeFits = measureGlyphText(runtimeText, scale) <= usableWidth;
    const linesFit = candidate.every((line) => measureGlyphText(line, scale) <= usableWidth);
    if (total <= bottomBudget && runtimeFits && linesFit) {
      bodyScale = scale;
      wrapped = candidate;
      break;
    }
    if (scale === 1) {
      bodyScale = 1;
      wrapped = candidate;
    }
  }

  const lineHeight = GLYPH_HEIGHT * bodyScale;
  const heightOf = (lineCount: number): number =>
    lineCount * lineHeight + Math.max(0, lineCount - 1) * gapY;
  while (wrapped.length > 0 && heightOf(wrapped.length + 1) > bottomBudget) {
    wrapped = wrapped.slice(0, -1);
  }

  const bodyHeight = heightOf(wrapped.length + 1);
  const contentHeight = topHeight + blockGap + bodyHeight;
  const topY = Math.max(pad, Math.round((imageHeight - contentHeight) / 2));

  const logo: RectSpec = { x: pad, y: topY, width: logoSize, height: logoSize };

  let headline: BadgeTextLine | null = null;
  if (headlineScale > 0 && label.headline !== null) {
    const regionX = logo.x + logo.width + gapX;
    const regionWidth = imageWidth - pad - regionX;
    const textWidth = measureGlyphText(label.headline, headlineScale);
    headline = {
      text: label.headline,
      scale: headlineScale,
      originX: regionX + Math.max(0, Math.round((regionWidth - textWidth) / 2)),
      originY: topY + Math.round((logoSize - GLYPH_HEIGHT * headlineScale) / 2),
      color: BADGE_FOREGROUND,
    };
  }

  const body: BadgeTextLine[] = [];
  let cursorY = topY + topHeight + blockGap;
  for (const line of wrapped) {
    body.push({
      text: line,
      scale: bodyScale,
      originX: Math.round((imageWidth - measureGlyphText(line, bodyScale)) / 2),
      originY: cursorY,
      color: BADGE_FOREGROUND,
    });
    cursorY += lineHeight + gapY;
  }

  const tagText = runtimeTagText(label.runtime);
  const portText = label.port === null ? '' : `:${label.port}`;
  const runtimeWidth = measureGlyphText(runtimeText, bodyScale);
  const runtimeX = Math.round((imageWidth - runtimeWidth) / 2);
  body.push({
    text: tagText,
    scale: bodyScale,
    originX: runtimeX,
    originY: cursorY,
    color: runtimeTagColor(label.runtime),
  });
  if (portText !== '') {
    body.push({
      text: portText,
      scale: bodyScale,
      originX: runtimeX + measureGlyphText(tagText, bodyScale) + bodyScale,
      originY: cursorY,
      color: BADGE_MUTED,
    });
  }

  return { logo, headline, body, cornerRadius };
}

export function roundedInsetAtRow(row: number, height: number, radius: number): number {
  const fromEdge = Math.min(row, height - 1 - row);
  if (fromEdge >= radius) return 0;
  return (
    radius - Math.floor(Math.sqrt(Math.max(0, radius * radius - (radius - fromEdge - 1) ** 2)))
  );
}

export function fillRoundedRect(
  bitmap: Buffer,
  imageWidth: number,
  imageHeight: number,
  rect: RectSpec,
  radius: number,
  color: Bgra
): void {
  for (let row = 0; row < rect.height; row += 1) {
    const inset = roundedInsetAtRow(row, rect.height, radius);
    fillRect(
      bitmap,
      imageWidth,
      imageHeight,
      { x: rect.x + inset, y: rect.y + row, width: Math.max(0, rect.width - inset * 2), height: 1 },
      color
    );
  }
}

export function blitBitmap(
  destination: Buffer,
  destWidth: number,
  destHeight: number,
  source: Buffer,
  sourceWidth: number,
  sourceHeight: number,
  box: RectSpec
): void {
  if (sourceWidth <= 0 || sourceHeight <= 0 || box.width <= 0 || box.height <= 0) return;
  for (let y = 0; y < box.height; y += 1) {
    const sy = Math.min(sourceHeight - 1, Math.floor((y * sourceHeight) / box.height));
    for (let x = 0; x < box.width; x += 1) {
      const sx = Math.min(sourceWidth - 1, Math.floor((x * sourceWidth) / box.width));
      const so = (sy * sourceWidth + sx) * 4;
      if (so + 3 >= source.length) continue;
      blendPixel(destination, destWidth, destHeight, box.x + x, box.y + y, {
        b: source[so],
        g: source[so + 1],
        r: source[so + 2],
        a: source[so + 3],
      });
    }
  }
}

export interface LogoSource {
  bitmap: Buffer;
  width: number;
  height: number;
}

export function composeBadgeIcon(
  bitmap: Buffer,
  imageWidth: number,
  imageHeight: number,
  label: BadgeLabel,
  logo: LogoSource | null
): boolean {
  const layout = computeBadgeIconLayout(imageWidth, imageHeight, label);
  if (layout === null) return false;

  fillRoundedRect(
    bitmap,
    imageWidth,
    imageHeight,
    { x: 0, y: 0, width: imageWidth, height: imageHeight },
    layout.cornerRadius,
    BADGE_BACKGROUND
  );

  if (logo !== null) {
    blitBitmap(bitmap, imageWidth, imageHeight, logo.bitmap, logo.width, logo.height, layout.logo);
  }

  const lines: BadgeTextLine[] = layout.headline === null ? [] : [layout.headline];
  for (const line of layout.body) lines.push(line);
  for (const line of lines) {
    drawGlyphText(bitmap, imageWidth, imageHeight, {
      text: line.text,
      originX: line.originX,
      originY: line.originY,
      scale: line.scale,
      color: line.color,
    });
  }
  return lines.length > 0 || logo !== null;
}
