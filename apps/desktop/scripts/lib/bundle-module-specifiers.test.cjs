const assert = require('node:assert/strict');
const test = require('node:test');
const { collectStaticModuleSpecifiers } = require('./bundle-module-specifiers.cjs');

test('import.meta cannot turn a later encoding string into a runtime package', () => {
  assert.deepEqual(
    collectStaticModuleSpecifiers(`
import fs from 'node:fs';
import.meta.url;
const text = fs.readFileSync('/fixture.env', 'utf-8');
`),
    ['node:fs']
  );
});

test('real static imports and re-exports remain visible across multiline declarations', () => {
  assert.deepEqual(
    collectStaticModuleSpecifiers(`
import 'unbundled-side-effect';
import {
  value
} from 'unbundled-package';
export { value as other } from 'unbundled-export';
`),
    ['unbundled-side-effect', 'unbundled-package', 'unbundled-export']
  );
});

test('comments and template text cannot declare packages', () => {
  assert.deepEqual(
    collectStaticModuleSpecifiers(`
/*
import fake from 'not-an-import';
*/
const text = \`\nimport fake from 'also-not-an-import';\`;
`),
    []
  );
});

test('malformed JavaScript cannot produce a passing dependency inspection', () => {
  assert.throws(
    () => collectStaticModuleSpecifiers('import {', 'broken.js'),
    /Cannot inspect broken.js/
  );
});
