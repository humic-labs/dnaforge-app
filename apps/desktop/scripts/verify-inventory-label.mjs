import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import jsQR from 'jsqr';
import sharp from 'sharp';

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
for (const name of ['--svg', '--expected', '--out'])
  assert.ok(args.includes(name), `Pass ${name}.`);
const input = path.resolve(option('--svg'));
const expectedPath = path.resolve(option('--expected'));
const out = path.resolve(option('--out'));
const root = path.resolve(import.meta.dirname, '../../..');
assert.ok(!out.startsWith(`${root}${path.sep}`), 'Keep label evidence outside the checkout.');
mkdirSync(out, { recursive: true });
const expected = JSON.parse(readFileSync(expectedPath, 'utf8'));
assert.equal(typeof expected.value, 'string');
assert.ok(expected.value.length > 0);
assert.match(expected.sha256, /^[a-f0-9]{64}$/u);
const bytes = readFileSync(input);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const receipt = {
  schema: 'dnaforge.inventory-label-pixel-proof.v1',
  status: 'running',
  startedAt: new Date().toISOString(),
  input,
  expectedPath,
  svgSha256: sha256(bytes),
  expectedBytes: Array.from(Buffer.from(expected.value, 'ascii')),
  observations: [],
};

async function decodeSvg(svg, name, rotation = 0) {
  const raster = sharp(svg, { density: 300, limitInputPixels: 16_000_000 })
    .rotate(rotation)
    .resize(
      Math.round(rotation === 90 ? expected.media.heightDots : expected.media.widthDots),
      Math.round(rotation === 90 ? expected.media.widthDots : expected.media.heightDots),
      {
        fit: 'fill',
        kernel: 'nearest',
      }
    )
    .flatten({ background: '#ffffff' })
    .ensureAlpha();
  const { data, info } = await raster.raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 4);
  const png = await sharp(data, { raw: info }).png().toBuffer();
  writeFileSync(path.join(out, `${name}.png`), png);
  const pixels = new Uint8ClampedArray(data);
  const result = jsQR(pixels, info.width, info.height, { inversionAttempts: 'dontInvert' });
  return { result, pixels, info, pngSha256: sha256(png) };
}

try {
  for (const key of ['widthDots', 'heightDots'])
    assert.ok(
      Number.isFinite(expected.media[key]) && expected.media[key] > 0 && expected.media[key] <= 1000
    );
  assert.equal(receipt.svgSha256, expected.sha256, 'Read back the exact exported artifact bytes.');
  writeFileSync(path.join(out, 'exported-label.svg'), bytes);
  for (const rotation of [0, 90]) {
    const decoded = await decodeSvg(bytes, `exported-${rotation}`, rotation);
    assert.ok(decoded.result, 'The actual exported SVG pixels must decode.');
    assert.deepEqual(
      decoded.result.binaryData,
      receipt.expectedBytes,
      'Compare full decoded bytes.'
    );
    const location = decoded.result.location;
    const corners = [
      location.topLeftCorner,
      location.topRightCorner,
      location.bottomLeftCorner,
      location.bottomRightCorner,
    ];
    const minX = Math.max(0, Math.floor(Math.min(...corners.map((point) => point.x))) - 2);
    const minY = Math.max(0, Math.floor(Math.min(...corners.map((point) => point.y))) - 2);
    const maxX = Math.min(
      decoded.info.width,
      Math.ceil(Math.max(...corners.map((point) => point.x))) + 2
    );
    const maxY = Math.min(
      decoded.info.height,
      Math.ceil(Math.max(...corners.map((point) => point.y))) + 2
    );
    for (let y = minY; y < maxY; y++)
      for (let x = minX; x < maxX; x++) {
        const offset = (y * decoded.info.width + x) * 4;
        decoded.pixels.fill(255, offset, offset + 4);
      }
    assert.equal(
      jsQR(decoded.pixels, decoded.info.width, decoded.info.height, {
        inversionAttempts: 'dontInvert',
      }),
      null,
      'The remaining label pixels must not contain a second QR code.'
    );
    receipt.observations.push({
      rotation,
      width: decoded.info.width,
      height: decoded.info.height,
      pngSha256: decoded.pngSha256,
      decodedBytes: decoded.result.binaryData,
      location,
    });
  }
  const symbol = expected.symbol;
  for (const key of ['xDots', 'yDots', 'sizeDots'])
    assert.ok(Number.isFinite(symbol[key]) && symbol[key] >= 0);
  assert.ok(symbol.sizeDots > 0);
  const damaged = Buffer.from(
    bytes
      .toString('utf8')
      .replace(
        '</svg>',
        `<rect x="${symbol.xDots}" y="${symbol.yDots}" width="${symbol.sizeDots}" height="${symbol.sizeDots}" fill="#ffffff"/></svg>`
      )
  );
  assert.notEqual(sha256(damaged), receipt.svgSha256);
  writeFileSync(path.join(out, 'damaged-symbol.svg'), damaged);
  const negative = await decodeSvg(damaged, 'damaged-symbol');
  assert.equal(
    negative.result,
    null,
    'Erasing actual symbol geometry must fail independent decoding.'
  );
  receipt.negative = { svgSha256: sha256(damaged), pngSha256: negative.pngSha256, decoded: false };
  receipt.status = 'passed';
} catch (cause) {
  receipt.status = 'failed';
  receipt.failure = cause instanceof Error ? cause.stack : String(cause);
  process.exitCode = 1;
} finally {
  receipt.finishedAt = new Date().toISOString();
  writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ status: receipt.status, out, failure: receipt.failure }));
}
