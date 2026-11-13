import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertFactsOnly,
  parseAllModificationsHtml,
  parseModificationProductHtml,
  parseOligoProductIds,
  parseProductModificationCodes,
} from '../generate-idt-modification-catalog.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('parses placement from the three authoritative IDT table sections', () => {
  const row = (productId, code) => `<tr>
    <td><a href="/site/Catalog/Modifications/Product/${productId}">${code}</a></td>
    <td>12</td><td>34.5</td><td>Yes</td><td>No</td><td>Yes</td><td>No</td>
  </tr>`;
  const html = `
    <h3><a name="5'">5' Mods</a></h3><table>${row(1, '5Foo')}</table>
    <h3><a name="internal">Internal Mods</a></h3><table>${row(2, 'iFoo')}</table>
    <h3><a name="3'">3' Mods</a></h3><table>${row(3, '3Foo')}</table>
  `;

  assert.deepEqual(
    parseAllModificationsHtml(html).map(({ productId, vendorCode, placement }) => ({
      productId,
      vendorCode,
      placement,
    })),
    [
      { productId: 1, vendorCode: '5Foo', placement: 'five-prime' },
      { productId: 2, vendorCode: 'iFoo', placement: 'internal' },
      { productId: 3, vendorCode: '3Foo', placement: 'three-prime' },
    ]
  );
});

test('reads only the product name and category from a product page', () => {
  const html = `<div id="ModProduct">
    <h1>Int Example &amp;reg</h1>
    <a href="/site/Catalog/Modifications/Category/7">Return to Modified Bases Modifications</a>
    <p>Vendor description.</p>
    <div class="row"></div>
    <tr><td>Mod Code:</td><td>/iExample/</td></tr>
    <img alt="Structure" src="/site/Catalog/Modifications/GetStructureImage/123" />`;

  assert.deepEqual(parseModificationProductHtml(html, 'iExample'), {
    label: 'Int Example ®',
    categoryId: 7,
    categoryLabel: 'Modified Bases',
  });
});

test('parses product-specific modification availability without inferring it from labels', () => {
  assert.deepEqual(
    parseOligoProductIds(
      { OligoEntryProductInfo: [{ ProductID: 2111 }, { ProductID: 1418 }, { ProductID: 2111 }] },
      'rna'
    ),
    [2111, 1418]
  );
  assert.deepEqual(
    parseProductModificationCodes({
      ModsFive: [{ ModCode: '/5Phos/' }],
      ModsInternal: [{ ModCode: '/iSp18/' }],
      ModsThree: [{ ModCode: '/3SpC3/' }, { ModCode: '/5Phos/' }],
    }),
    ['5Phos', 'iSp18', '3SpC3']
  );
});

test('the checked-in snapshot holds catalog facts and no vendor images or text', async () => {
  const snapshot = JSON.parse(
    await readFile(
      path.resolve(
        desktopRoot,
        '../..',
        'packages/core/scientific-artifacts/src/shared/primers/vendor-data/idt-modification-catalog.snapshot.json'
      ),
      'utf8'
    )
  );

  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.entries.length, 259);
  assert.equal(
    snapshot.entries.filter((entry) => entry.supportedOrderTypes.includes('dna')).length,
    255
  );
  assert.equal(
    snapshot.entries.filter((entry) => entry.supportedOrderTypes.includes('rna')).length,
    243
  );
  assert.deepEqual(
    snapshot.entries.find((entry) => entry.vendorCode === '55HydMe-dC')?.supportedOrderTypes,
    ['dna']
  );
  assert.deepEqual(
    snapshot.entries.find((entry) => entry.vendorCode === '5Phos')?.supportedOrderTypes,
    ['dna', 'rna']
  );
  assert.deepEqual(
    snapshot.entries.find((entry) => entry.vendorCode === 'ZEN')?.supportedOrderTypes,
    []
  );
  assert.doesNotThrow(() => assertFactsOnly(snapshot));
  assert.throws(
    () =>
      assertFactsOnly({
        ...snapshot,
        entries: [{ ...snapshot.entries[0], description: 'Vendor prose.' }],
      }),
    /5Phos has non-catalog fields: description/
  );
  assert.throws(
    () => assertFactsOnly({ ...snapshot, structureImageCount: 86 }),
    /non-catalog fields: structureImageCount/
  );
  await assert.rejects(stat(path.join(desktopRoot, 'public/vendor/idt')), { code: 'ENOENT' });
});
