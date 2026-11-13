import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const layout = require('./lib/dmg-window-layout.cjs');
const { readPng } = require('./lib/read-png.cjs');
const { readDesktopTheme, rgbCss, mix } = require('./lib/theme-color.cjs');

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resourceDir = path.join(desktopRoot, 'resources');
const { windowSize, app, applications } = layout;

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1]];
}

function add(a, b) {
  return [a[0] + b[0], a[1] + b[1]];
}

function mul(a, scale) {
  return [a[0] * scale, a[1] * scale];
}

function length(a) {
  return Math.hypot(a[0], a[1]);
}

function unit(a) {
  const span = length(a) || 1;
  return [a[0] / span, a[1] / span];
}

function roundedPolygon(points, radii) {
  const count = points.length;
  const corners = points.map((curr, index) => {
    const prev = points[(index + count - 1) % count];
    const next = points[(index + 1) % count];
    const towardPrev = unit(sub(prev, curr));
    const towardNext = unit(sub(next, curr));
    const turn = Math.acos(Math.min(1, Math.max(-1, towardPrev[0] * towardNext[0] + towardPrev[1] * towardNext[1])));
    const radius = radii[index] ?? 0;
    const cut =
      radius <= 0 || turn < 0.05
        ? 0
        : Math.min(
            radius / Math.tan(turn / 2),
            length(sub(prev, curr)) / 2.2,
            length(sub(next, curr)) / 2.2
          );
    return {
      start: add(curr, mul(towardPrev, cut)),
      end: add(curr, mul(towardNext, cut)),
      control: curr,
      curve: cut > 0.2,
    };
  });
  const format = (point) => `${point[0].toFixed(2)} ${point[1].toFixed(2)}`;
  let path = `M ${format(corners[0].start)}`;
  for (let index = 0; index < count; index += 1) {
    const corner = corners[index];
    const next = corners[(index + 1) % count];
    path += corner.curve ? ` Q ${format(corner.control)} ${format(corner.end)}` : ` L ${format(corner.end)}`;
    if (length(sub(next.start, corner.end)) > 0.2) path += ` L ${format(next.start)}`;
  }
  return `${path} Z`;
}

function arrowPath() {
  const midX = (app.x + applications.x) / 2;
  const midY = app.y;
  const tail = midX - 32;
  const tip = midX + 32;
  const neck = tip - 16;
  const shaft = 2.6;
  const head = 9.5;
  return roundedPolygon(
    [
      [tail, midY - shaft],
      [neck, midY - shaft],
      [neck, midY - head],
      [tip, midY],
      [neck, midY + head],
      [neck, midY + shaft],
      [tail, midY + shaft],
    ],
    [shaft, 2.4, 2.2, 1.6, 2.2, 2.4, shaft]
  );
}

function wash(themeColor, background) {
  return mix(background, themeColor, layout.backgroundTint);
}

function backgroundSvg(theme) {
  const green = rgbCss(wash(theme.green, theme.background));
  const yellow = rgbCss(wash(theme.yellow, theme.background));
  const blend = rgbCss(wash(mix(theme.green, theme.yellow, 0.5), theme.background));
  const arrow = rgbCss(theme.arrow);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${windowSize.width}" height="${windowSize.height}" viewBox="0 0 ${windowSize.width} ${windowSize.height}">
  <defs>
    <linearGradient id="morph" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${green}"/>
      <stop offset="0.48" stop-color="${blend}"/>
      <stop offset="1" stop-color="${yellow}"/>
    </linearGradient>
  </defs>
  <rect width="${windowSize.width}" height="${windowSize.height}" fill="${rgbCss(theme.background)}"/>
  <rect width="${windowSize.width}" height="${windowSize.height}" fill="url(#morph)"/>
  <path d="${arrowPath()}" fill="${arrow}"/>
</svg>
`;
}

function renderPngs(svgPath) {
  const png1x = path.join(resourceDir, 'dmg-background.png');
  const png2x = path.join(resourceDir, 'dmg-background@2x.png');
  execFileSync('rsvg-convert', ['-w', String(windowSize.width), '-h', String(windowSize.height), svgPath, '-o', png1x]);
  execFileSync('rsvg-convert', [
    '-w',
    String(windowSize.width * 2),
    '-h',
    String(windowSize.height * 2),
    svgPath,
    '-o',
    png2x,
  ]);
  return { png1x, png2x };
}

function close(a, b) {
  return Math.abs(a.r - b.r) < 28 && Math.abs(a.g - b.g) < 28 && Math.abs(a.b - b.b) < 28;
}

function assertPicture(pngPath, theme, scale) {
  const image = readPng(readFileSync(pngPath));
  if (image.width !== windowSize.width * scale || image.height !== windowSize.height * scale) {
    throw new Error(`${pngPath} is ${image.width}x${image.height}`);
  }
  const midX = Math.round(((app.x + applications.x) / 2) * scale);
  const midY = Math.round(app.y * scale);
  const arrow = image.pixel(midX, midY);
  const left = image.pixel(Math.round(24 * scale), Math.round(windowSize.height * 0.72 * scale));
  const right = image.pixel(Math.round((windowSize.width - 24) * scale), Math.round(28 * scale));
  if (!close(arrow, theme.arrow)) {
    throw new Error(`arrow pixel ${arrow.r},${arrow.g},${arrow.b} is not the theme foreground`);
  }
  if (left.g <= left.r || right.r <= right.b) {
    throw new Error(`background does not move from green (${left.r},${left.g},${left.b}) to yellow (${right.r},${right.g},${right.b})`);
  }
}

function main() {
  const theme = readDesktopTheme(path.join(desktopRoot, layout.themeStylesheet));
  const svgPath = path.join(resourceDir, 'dmg-background.svg');
  const svg = backgroundSvg(theme);
  if ((svg.match(/<path /g) || []).length !== 1) {
    throw new Error('the installer arrow must be one path');
  }
  writeFileSync(svgPath, svg);
  const { png1x, png2x } = renderPngs(svgPath);
  assertPicture(png1x, theme, 1);
  assertPicture(png2x, theme, 2);
  process.stdout.write(`${path.relative(desktopRoot, png1x)}\n${path.relative(desktopRoot, png2x)}\n`);
}

main();
