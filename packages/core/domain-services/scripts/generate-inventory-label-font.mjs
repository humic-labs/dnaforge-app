import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import opentype from 'opentype.js';
import prettier from 'prettier';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(import.meta.url);
const desktopRequire = createRequire(resolve(root, 'apps/desktop/package.json'));
const fontPackage = JSON.parse(
  await readFile(desktopRequire.resolve('@fontsource/jetbrains-mono/package.json'), 'utf8')
);
const parserPackage = JSON.parse(
  await readFile(require.resolve('opentype.js/package.json'), 'utf8')
);
if (fontPackage.version !== '5.3.0' || parserPackage.version !== '2.0.0') {
  throw new Error(
    'Inventory label font generation requires the pinned source and parser versions.'
  );
}
const source = await readFile(
  desktopRequire.resolve('@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff')
);
const sha256 = createHash('sha256').update(source).digest('hex');
if (sha256 !== '658b9ee07b0249cf910a8d6f3d812d46c962bae81d7379a0355b1db35c61586f') {
  throw new Error('The pinned inventory label source font hash differs.');
}
const font = opentype.parse(
  source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength)
);
const round = (value) => Math.round(value * 1_000) / 1_000;
const glyphs = Array.from({ length: 95 }, (_, offset) => {
  const code = offset + 32;
  const glyph = font.charToGlyph(String.fromCharCode(code));
  if (!glyph.index || !Number.isFinite(glyph.advanceWidth))
    throw new Error(`Missing ASCII glyph ${code}.`);
  const path = glyph.getPath(0, 0, 33, { hinting: false });
  const d = path.toPathData({ decimalPlaces: 3, flipY: false, optimize: false });
  const bounds = path.getBoundingBox();
  const advance = round((glyph.advanceWidth * 33) / font.unitsPerEm);
  if ((code === 32) !== (d === '') || !/^[MLCQZ\d., -]*$/.test(d)) {
    throw new Error(`Unsupported ASCII glyph geometry ${code}.`);
  }
  const metrics = {
    advance,
    left: round(bounds.x1),
    top: round(bounds.y1),
    right: round(bounds.x2),
    bottom: round(bounds.y2),
    d,
  };
  if (
    ![advance, metrics.left, metrics.top, metrics.right, metrics.bottom].every(Number.isFinite) ||
    metrics.left < 0 ||
    metrics.right > advance
  ) {
    throw new Error(`Unsupported ASCII glyph metrics ${code}.`);
  }
  return metrics;
});
const data = {
  name: 'DNAForgeInventoryLabelAscii',
  source: {
    family: 'JetBrains Mono',
    package: '@fontsource/jetbrains-mono',
    version: '5.3.0',
    file: 'files/jetbrains-mono-latin-400-normal.woff',
    url: 'https://registry.npmjs.org/@fontsource/jetbrains-mono/-/jetbrains-mono-5.3.0.tgz',
    sha256: `sha256:${sha256}`,
    license: 'OFL-1.1',
  },
  generator: { name: 'opentype.js', version: '2.0.0' },
  sizeDots: 33,
  ascentDots: Math.ceil(Math.max(...glyphs.map((glyph) => -glyph.top))),
  descentDots: Math.ceil(Math.max(...glyphs.map((glyph) => glyph.bottom))),
  glyphs,
};
const output = resolve(root, 'packages/core/domain-services/src/inventory-label-font.ts');
const license =
  '/* SPDX-License-Identifier: OFL-1.1\n * Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)\n */\n';
const content = await prettier.format(
  `${license}export const inventoryLabelFont = ${JSON.stringify(data)} as const;\n`,
  {
    ...(await prettier.resolveConfig(output)),
    parser: 'typescript',
  }
);
if (process.argv.includes('--write')) {
  await writeFile(output, content);
} else if ((await readFile(output, 'utf8')) !== content) {
  throw new Error('The inventory label glyph data differs from its pinned source.');
}
process.stdout.write(
  `Inventory label font ${process.argv.includes('--write') ? 'generated' : 'matches'}: 95 ASCII glyphs, ${sha256}\n`
);
