import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parse } = require('yaml');
const layout = require('../lib/dmg-window-layout.cjs');
const { readPng } = require('../lib/read-png.cjs');
const { mix, readDesktopTheme, rgbCss } = require('../lib/theme-color.cjs');

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('macOS disk image window', () => {
  it('is narrower than the electron-builder default and keeps the app left of Applications', () => {
    const config = parse(readFileSync(path.join(desktopRoot, 'electron-builder.yml'), 'utf8'));
    assert.deepEqual(config.dmg, layout.builderDmg());
    assert.ok(layout.windowSize.width < 540);
    assert.ok(layout.windowSize.height < 380);
    assert.ok(layout.app.x < layout.applications.x);
    assert.equal(layout.app.y, layout.applications.y);

    const iconRadius = layout.iconSize / 2;
    const gap = layout.applications.x - iconRadius - (layout.app.x + iconRadius);
    assert.ok(gap >= 80 && gap <= 140, `arrow gap ${gap}px`);
    assert.ok(layout.app.x - iconRadius >= 40);
    assert.ok(layout.windowSize.width - (layout.applications.x + iconRadius) >= 40);
    assert.ok(layout.app.y - iconRadius >= 48);
    assert.ok(layout.windowSize.height - (layout.app.y + iconRadius) >= 56);
  });

  it('keeps the validation package on the same window', () => {
    const source = readFileSync(path.join(desktopRoot, 'electron-builder.validation.cjs'), 'utf8');
    assert.match(source, /dmg:\s*\{[\s\S]*\.\.\.productionConfig\.dmg/);
  });

  it('morphs the theme green into the theme yellow and draws one arrow', () => {
    const svg = readFileSync(path.join(desktopRoot, 'resources', 'dmg-background.svg'), 'utf8');
    const theme = readDesktopTheme(path.join(desktopRoot, layout.themeStylesheet));
    const faintGreen = mix(theme.background, theme.green, layout.backgroundTint);
    const faintYellow = mix(theme.background, theme.yellow, layout.backgroundTint);
    assert.equal((svg.match(/<path /g) || []).length, 1);
    assert.match(svg, / Z"/);
    assert.ok(svg.includes(rgbCss(faintGreen)));
    assert.ok(svg.includes(rgbCss(faintYellow)));
    assert.equal(svg.includes(`stop-color="${rgbCss(theme.green)}"`), false);
    assert.ok(svg.includes(`fill="${rgbCss(theme.arrow)}"`));
    assert.doesNotMatch(svg, /helix|polyline|<line /);

    for (const [file, scale] of [
      ['dmg-background.png', 1],
      ['dmg-background@2x.png', 2],
    ]) {
      const image = readPng(readFileSync(path.join(desktopRoot, 'resources', file)));
      assert.equal(image.width, layout.windowSize.width * scale);
      assert.equal(image.height, layout.windowSize.height * scale);
      const midX = Math.round(((layout.app.x + layout.applications.x) / 2) * scale);
      const midY = Math.round(layout.app.y * scale);
      const arrow = image.pixel(midX, midY);
      const left = image.pixel(Math.round(24 * scale), Math.round(layout.windowSize.height * 0.72 * scale));
      const right = image.pixel(
        Math.round((layout.windowSize.width - 24) * scale),
        Math.round(28 * scale)
      );
      assert.ok(Math.abs(arrow.r - theme.arrow.r) < 28, `${file} arrow`);
      assert.ok(left.g > left.r, `${file} green side`);
      assert.ok(right.r > right.b, `${file} yellow side`);
      assert.ok(left.r + left.g + left.b > 640, `${file} green side is faint`);
      assert.ok(right.r + right.g + right.b > 640, `${file} yellow side is faint`);
    }
  });
});
