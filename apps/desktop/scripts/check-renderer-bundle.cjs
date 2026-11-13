#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RENDERER_DIR = path.join(ROOT, 'out', 'renderer');

const FORBIDDEN_LITERALS = ['import.meta.env.DEV', 'import.meta.env.MODE'];

const FORBIDDEN_DEV_SURFACE_MARKERS = [
  'dev-scenarios-button',
  'svg-gallery-button',
  '__scenarios',
  'applyScenarioDev',
  '__mockUtils',
  'MockSetup',
];

function fail(msg) {
  console.error(`[check-renderer-bundle] ❌ ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`[check-renderer-bundle] ✅ ${msg}`);
}

if (!fs.existsSync(RENDERER_DIR)) {
  fail(`Renderer build not found at ${RENDERER_DIR}. Run \`npx electron-vite build\` first.`);
}

function walkBundle(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkBundle(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = walkBundle(RENDERER_DIR);
if (files.length === 0) fail(`No .js files found under ${RENDERER_DIR}`);

const violations = [];
for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  for (const needle of FORBIDDEN_LITERALS) {
    if (content.includes(needle)) {
      violations.push({ file: path.relative(ROOT, file), needle });
    }
  }
  for (const needle of FORBIDDEN_DEV_SURFACE_MARKERS) {
    if (content.includes(needle)) {
      violations.push({ file: path.relative(ROOT, file), needle });
    }
  }
}

if (violations.length > 0) {
  console.error(
    '[check-renderer-bundle] ❌ Forbidden dev/build markers found in production renderer bundle:\n'
  );
  for (const v of violations) console.error(`  ${v.file}: "${v.needle}"`);
  console.error(
    '\nThis means either Vite env substitution broke or a dev-only surface is still reachable from the production renderer graph.'
  );
  console.error('Check electron.vite.config.ts, dynamic import gates, and dev-only UI imports.');
  process.exit(1);
}

ok(
  `Vite env substitution and dev-surface stripping verified across ${files.length} renderer bundle file(s) (${FORBIDDEN_LITERALS.length + FORBIDDEN_DEV_SURFACE_MARKERS.length} forbidden markers checked).`
);
