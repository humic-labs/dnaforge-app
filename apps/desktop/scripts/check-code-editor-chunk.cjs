#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ASSETS_DIR = path.join(ROOT, 'out', 'renderer', 'assets');

const MIN_BYTES = 400 * 1024;
const MAX_BYTES = 1.4 * 1024 * 1024;
const CM_SIGNATURE = 'cm-content';

function fail(msg) {
  console.error(`[check-code-editor-chunk] ❌ ${msg}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`[check-code-editor-chunk] ✅ ${msg}`);
}

if (!fs.existsSync(ASSETS_DIR)) {
  fail(`No build output at ${ASSETS_DIR}. Run \`npx electron-vite build\` first.`);
}

const files = fs.readdirSync(ASSETS_DIR);

const codeEditorChunks = files.filter((f) => /^CodeEditor-.*\.js$/.test(f));
if (codeEditorChunks.length === 0) {
  fail(
    'No CodeEditor-*.js chunk found. The lazy import boundary in TextViewerTab ' +
      'was likely removed — CodeMirror is now in the startup bundle.'
  );
}
if (codeEditorChunks.length > 1) {
  fail(
    `Expected exactly one CodeEditor chunk, found ${codeEditorChunks.length}: ${codeEditorChunks}`
  );
}
const chunk = codeEditorChunks[0];
const chunkPath = path.join(ASSETS_DIR, chunk);
const chunkBytes = fs.statSync(chunkPath).size;
const chunkSrc = fs.readFileSync(chunkPath, 'utf-8');

if (!chunkSrc.includes(CM_SIGNATURE)) {
  fail(`CodeMirror signature "${CM_SIGNATURE}" not found in ${chunk}; chunk is not what we think.`);
}

const jsAssets = files.filter((f) => /\.js$/.test(f));
const chunksWithCm = jsAssets.filter((f) =>
  fs.readFileSync(path.join(ASSETS_DIR, f), 'utf-8').includes(CM_SIGNATURE)
);
const leaked = chunksWithCm.filter((f) => f !== chunk);
if (leaked.length > 0) {
  fail(
    `CodeMirror signature "${CM_SIGNATURE}" found in ${leaked.length} chunk(s) ` +
      `besides the lazy ${chunk}: ${leaked.join(', ')}. CodeMirror is reachable ` +
      'at startup (entry or a shared chunk the entry imports) — the lazy() ' +
      'boundary in TextViewerTab is broken or a shared import pulled it in.'
  );
}

if (chunkBytes < MIN_BYTES) {
  fail(
    `${chunk} is ${(chunkBytes / 1024).toFixed(0)} KB, below the ${(MIN_BYTES / 1024).toFixed(0)} KB ` +
      'floor — CodeMirror may have leaked out of its own chunk.'
  );
}
if (chunkBytes > MAX_BYTES) {
  fail(
    `${chunk} is ${(chunkBytes / 1024 / 1024).toFixed(2)} MB, over the ` +
      `${(MAX_BYTES / 1024 / 1024).toFixed(2)} MB ceiling. The code editor bundle ballooned — ` +
      'investigate before raising this cap (a raised cap is a deliberate, reviewed decision).'
  );
}

ok(
  `${chunk} = ${(chunkBytes / 1024 / 1024).toFixed(2)} MB; CodeMirror signature ` +
    `confined to this one chunk across ${jsAssets.length} JS assets (not reachable ` +
    `at startup). Lazy code-split intact, size within ` +
    `[${(MIN_BYTES / 1024).toFixed(0)} KB, ${(MAX_BYTES / 1024 / 1024).toFixed(2)} MB].`
);
