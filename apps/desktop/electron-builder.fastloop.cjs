'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const yaml = require('js-yaml');

const production = yaml.load(readFileSync(join(__dirname, 'electron-builder.yml'), 'utf8'));
const stubRoot = process.env.DNAFORGE_FASTLOOP_STUB_ROOT;
if (!stubRoot) {
  throw new Error('DNAFORGE_FASTLOOP_STUB_ROOT is required for the test-only package');
}

module.exports = {
  ...production,
  extraResources: [{ from: stubRoot, to: 'binaries', filter: ['**/*'] }],
  extraFiles: [],
};
