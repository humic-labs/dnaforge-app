#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const {
  generateWindowsAssociationInclude,
  loadFileAssociationRegistry,
} = require('./file-association-packaging.cjs');

const desktopRoot = resolve(__dirname, '..');
const registry = loadFileAssociationRegistry(desktopRoot);
writeFileSync(
  join(desktopRoot, 'resources', 'file-associations.generated.nsh'),
  generateWindowsAssociationInclude(registry)
);
