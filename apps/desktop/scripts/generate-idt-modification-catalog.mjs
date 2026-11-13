#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const IDT_CATALOG_SOURCE_URL =
  'https://www.idtdna.com/site/catalog/Modifications/GetAllMods';
export const IDT_PRODUCT_ROOT = 'https://www.idtdna.com/site/Catalog/Modifications/Product';
export const IDT_PRODUCT_INFO_ROOT = 'https://www.idtdna.com/site/order/products/GetProductInfo';
export const IDT_PRODUCT_MODIFICATIONS_ROOT = 'https://www.idtdna.com/api/product/GetModsByProduct';
export const EXPECTED_PLACEMENT_COUNTS = {
  'five-prime': 114,
  internal: 51,
  'three-prime': 94,
};
export const SNAPSHOT_FIELDS = [
  'schemaVersion',
  'vendor',
  'retrievedAt',
  'sourceUrl',
  'availabilitySources',
  'officialSlashCodeCount',
  'entries',
];
export const ENTRY_FIELDS = [
  'productId',
  'vendorCode',
  'placement',
  'extinctionCoefficient',
  'molecularWeight',
  'requiresHplc',
  'requiresIeHplc',
  'allowsPage',
  'requiresRnaseFree',
  'supportedOrderTypes',
  'label',
  'categoryId',
  'categoryLabel',
  'productUrl',
];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, '..');
const snapshotPath = path.resolve(
  desktopRoot,
  '../..',
  'packages/core/scientific-artifacts/src/shared/primers/vendor-data/idt-modification-catalog.snapshot.json'
);

const ENTITY_NAMES = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
  reg: '®',
  trade: '™',
};

function decodeHtml(value) {
  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    decoded = decoded
      .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number(decimal)))
      .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replace(/&([a-z]+);?/gi, (match, name) => ENTITY_NAMES[name.toLowerCase()] ?? match);
  }
  return decoded;
}

function textContent(value) {
  return decodeHtml(value.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseAllModificationsHtml(html) {
  const placements = {
    "5'": 'five-prime',
    internal: 'internal',
    "3'": 'three-prime',
  };
  const entries = [];
  const sectionPattern =
    /<h3>\s*<a\s+name="(5'|internal|3')"[^>]*>[\s\S]*?<\/h3>\s*<table[^>]*>([\s\S]*?)<\/table>/gi;

  for (const section of html.matchAll(sectionPattern)) {
    const placement = placements[section[1]];
    const rows = section[2].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
    for (const row of rows) {
      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) =>
        textContent(cell[1])
      );
      if (cells.length !== 7) continue;
      const productLink = row[1].match(
        /href="\/site\/Catalog\/Modifications\/Product\/(\d+)"[^>]*>([^<]+)<\/a>/i
      );
      if (!productLink) continue;
      entries.push({
        productId: Number(productLink[1]),
        vendorCode: textContent(productLink[2]),
        placement,
        extinctionCoefficient: Number(cells[1]),
        molecularWeight: Number(cells[2]),
        requiresHplc: cells[3] === 'Yes',
        requiresIeHplc: cells[4] === 'Yes',
        allowsPage: cells[5] === 'Yes',
        requiresRnaseFree: cells[6] === 'Yes',
      });
    }
  }
  return entries;
}

export function parseModificationProductHtml(html, expectedCode) {
  const product = html.match(/<div\s+id="ModProduct">([\s\S]*?)<div\s+class="row">/i)?.[1] ?? '';
  const label = textContent(product.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '');
  const category = product.match(
    /href="\/site\/Catalog\/Modifications\/Category\/(\d+)"[^>]*>Return to\s+([\s\S]*?)\s+Modifications<\/a>/i
  );
  const publishedCode = textContent(
    html.match(/<td>\s*Mod Code:\s*<\/td>\s*<td>\s*\/([^/]+)\/\s*<\/td>/i)?.[1] ?? ''
  );

  if (publishedCode !== expectedCode) {
    throw new Error(
      `IDT product page code mismatch: expected ${expectedCode}, received ${publishedCode || '(blank)'}`
    );
  }

  const categoryId = category ? Number(category[1]) : null;
  return {
    label: label || expectedCode,
    categoryId: categoryId && categoryId > 0 ? categoryId : null,
    categoryLabel: categoryId && categoryId > 0 ? textContent(category?.[2] ?? '') : null,
  };
}

export function parseOligoProductIds(value, orderType) {
  if (!value || !Array.isArray(value.OligoEntryProductInfo)) {
    throw new Error(`IDT ${orderType.toUpperCase()} product response is missing its product list.`);
  }
  const productIds = value.OligoEntryProductInfo.map((product) => product?.ProductID);
  if (
    productIds.length === 0 ||
    productIds.some((productId) => !Number.isInteger(productId) || productId <= 0)
  ) {
    throw new Error(`IDT ${orderType.toUpperCase()} product response contains an invalid ID.`);
  }
  return [...new Set(productIds)];
}

export function parseProductModificationCodes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('IDT product modification response is invalid.');
  }
  if (!Object.values(value).some((modifications) => Array.isArray(modifications))) {
    throw new Error('IDT product modification response is missing its modification lists.');
  }
  const codes = [];
  for (const modifications of Object.values(value)) {
    if (!Array.isArray(modifications)) continue;
    for (const modification of modifications) {
      const notation = modification?.ModCode;
      if (typeof notation !== 'string' || !/^\/[A-Za-z0-9_-]+\/$/.test(notation)) {
        throw new Error(`IDT product modification response contains invalid code ${notation}.`);
      }
      codes.push(notation.slice(1, -1));
    }
  }
  return [...new Set(codes)];
}

function assertCatalog(entries) {
  const expectedTotal = Object.values(EXPECTED_PLACEMENT_COUNTS).reduce(
    (total, count) => total + count,
    0
  );
  if (entries.length !== expectedTotal) {
    throw new Error(`Expected ${expectedTotal} IDT catalog rows, received ${entries.length}.`);
  }
  const codes = new Set();
  const productIds = new Set();
  for (const entry of entries) {
    if (!/^[A-Za-z0-9_-]+$/.test(entry.vendorCode)) {
      throw new Error(`Unsafe IDT vendor code: ${entry.vendorCode}`);
    }
    if (codes.has(entry.vendorCode.toLowerCase())) {
      throw new Error(`Duplicate IDT vendor code: ${entry.vendorCode}`);
    }
    if (productIds.has(entry.productId)) {
      throw new Error(`Duplicate IDT product ID: ${entry.productId}`);
    }
    codes.add(entry.vendorCode.toLowerCase());
    productIds.add(entry.productId);
  }
  for (const [placement, expected] of Object.entries(EXPECTED_PLACEMENT_COUNTS)) {
    const actual = entries.filter((entry) => entry.placement === placement).length;
    if (actual !== expected) {
      throw new Error(`Expected ${expected} ${placement} rows, received ${actual}.`);
    }
  }
}

export function assertFactsOnly(snapshot) {
  const extraFields = (value, allowed) =>
    Object.keys(value).filter((key) => !allowed.includes(key));
  const extraHeaderFields = extraFields(snapshot, SNAPSHOT_FIELDS);
  if (extraHeaderFields.length > 0) {
    throw new Error(`IDT snapshot has non-catalog fields: ${extraHeaderFields.join(', ')}`);
  }
  for (const entry of snapshot.entries) {
    const extraEntryFields = extraFields(entry, ENTRY_FIELDS);
    if (extraEntryFields.length > 0) {
      throw new Error(
        `IDT snapshot row ${entry.vendorCode} has non-catalog fields: ${extraEntryFields.join(', ')}`
      );
    }
  }
}

const cookieJar = new Map();

async function fetchOk(url) {
  let currentUrl = url;
  for (let redirect = 0; redirect < 5; redirect += 1) {
    const response = await fetch(currentUrl, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'DNAForge IDT catalog snapshot generator',
        ...(cookieJar.size > 0
          ? { Cookie: [...cookieJar.entries()].map(([key, value]) => `${key}=${value}`).join('; ') }
          : {}),
      },
    });
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(';');
      const separator = pair.indexOf('=');
      if (separator > 0) cookieJar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`${currentUrl} redirected without a Location header.`);
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    if (!response.ok) throw new Error(`${currentUrl} returned HTTP ${response.status}.`);
    return response;
  }
  throw new Error(`${url} exceeded the redirect limit.`);
}

async function mapConcurrent(values, concurrency, mapper) {
  const output = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

async function fetchOrderTypeAvailability(orderType) {
  const upper = orderType.toUpperCase();
  const productInfoUrl = `${IDT_PRODUCT_INFO_ROOT}?type=${upper}&isDuplex=false`;
  const productIds = parseOligoProductIds(await (await fetchOk(productInfoUrl)).json(), orderType);
  const codesByProduct = await mapConcurrent(productIds, 8, async (productId) => {
    const url = `${IDT_PRODUCT_MODIFICATIONS_ROOT}?productId=${productId}&type=${upper}`;
    return parseProductModificationCodes(await (await fetchOk(url)).json());
  });
  return {
    orderType,
    productInfoUrl,
    productIds,
    codes: new Set(codesByProduct.flat()),
  };
}

async function refresh() {
  const listingHtml = await (await fetchOk(IDT_CATALOG_SOURCE_URL)).text();
  const listing = parseAllModificationsHtml(listingHtml);
  assertCatalog(listing);

  const availability = await Promise.all([
    fetchOrderTypeAvailability('dna'),
    fetchOrderTypeAvailability('rna'),
  ]);

  const entries = await mapConcurrent(listing, 16, async (entry) => {
    const productUrl = `${IDT_PRODUCT_ROOT}/${entry.productId}`;
    const productHtml = await (await fetchOk(productUrl)).text();
    return {
      ...entry,
      supportedOrderTypes: availability
        .filter((product) => product.codes.has(entry.vendorCode))
        .map((product) => product.orderType),
      ...parseModificationProductHtml(productHtml, entry.vendorCode),
      productUrl,
    };
  });

  const snapshot = {
    schemaVersion: 2,
    vendor: 'idt',
    retrievedAt: new Date().toISOString().slice(0, 10),
    sourceUrl: IDT_CATALOG_SOURCE_URL,
    availabilitySources: availability.map(({ orderType, productInfoUrl, productIds }) => ({
      orderType,
      productInfoUrl,
      productModificationsUrlTemplate: `${IDT_PRODUCT_MODIFICATIONS_ROOT}?productId={productId}&type=${orderType.toUpperCase()}`,
      productIds,
    })),
    officialSlashCodeCount: entries.length,
    entries,
  };
  assertFactsOnly(snapshot);
  const temporarySnapshot = `${snapshotPath}.refresh-${process.pid}`;
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await writeFile(temporarySnapshot, `${JSON.stringify(snapshot, null, 2)}\n`);
  await rename(temporarySnapshot, snapshotPath);
  process.stdout.write(`Wrote ${entries.length} IDT catalog rows.\n`);
}

async function check() {
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  assertCatalog(snapshot.entries);
  assertFactsOnly(snapshot);
  if (snapshot.officialSlashCodeCount !== snapshot.entries.length) {
    throw new Error('IDT snapshot count metadata does not match its entries.');
  }
  process.stdout.write(`PASS: ${snapshot.entries.length} IDT rows, catalog facts only.\n`);
}

const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const command = process.argv[2] ?? '--check';
  if (command === '--refresh') await refresh();
  else if (command === '--check') await check();
  else throw new Error(`Unknown argument ${command}; use --refresh or --check.`);
}
