#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');
const { collectStaticModuleSpecifiers } = require('./lib/bundle-module-specifiers.cjs');

const ROOT = path.join(__dirname, '..');
const BUNDLE = path.join(ROOT, 'out', 'main', 'index.js');
const MAIN_OUTPUT = path.dirname(BUNDLE);
const BUILTINS = new Set(
  builtinModules.flatMap((name) => [
    name,
    name.startsWith('node:') ? name.slice(5) : `node:${name}`,
  ])
);

const ALLOWED_EXTERNALS = [
  'better-sqlite3',
  'dugite',
  'linkedom',
];

function fail(message) {
  console.error(`[check-main-bundle] ❌ ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`[check-main-bundle] ✅ ${message}`);
}

if (!fs.existsSync(BUNDLE)) {
  fail(
    `built main bundle not found at ${BUNDLE}\n  Run: cd apps/desktop && npx electron-vite build`
  );
}

const chunks = fs
  .readdirSync(MAIN_OUTPUT, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
  .map((entry) => {
    const filename = path.join(entry.parentPath, entry.name);
    return { filename, source: fs.readFileSync(filename, 'utf8') };
  });
const source = chunks.map((chunk) => chunk.source).join('\n');

const matches = new Set(
  chunks.flatMap((chunk) => collectStaticModuleSpecifiers(chunk.source, chunk.filename))
);

const unexpected = [...matches]
  .filter((specifier) => {
    if (!specifier) return false;
    if (specifier.startsWith('.')) return false;
    if (specifier.startsWith('/')) return false;
    if (BUILTINS.has(specifier)) return false;
    if (specifier === 'electron') return false;
    if (ALLOWED_EXTERNALS.some((e) => (e instanceof RegExp ? e.test(specifier) : e === specifier)))
      return false;
    return true;
  })
  .sort();

if (unexpected.length > 0) {
  fail(
    `main bundle still contains ${unexpected.length} unexpected runtime package import(s):\n` +
      unexpected.map((name) => `  - ${name}`).join('\n') +
      '\n\n  This means the main process is not bundle-first yet.'
  );
}

ok(`main bundle is self-contained except for ${ALLOWED_EXTERNALS.length} allowlisted external(s)`);
