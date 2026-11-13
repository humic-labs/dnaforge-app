const fs = require('node:fs');
const path = require('node:path');
const { packagedHelperIntegrityProblem } = require('./verify-package-helpers.cjs');

function metadataPath(appPath) {
  return path.join(appPath, 'Contents', 'Resources', 'tool-provenance');
}

function existingEntry(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function helperMetadataDirectory(appPath) {
  const destination = metadataPath(appPath);
  const entry = existingEntry(destination);
  if (!entry) return path.join(appPath, 'Contents', 'Helpers');
  if (!entry.isDirectory()) throw new Error('Invalid Mac helper metadata directory.');
  return destination;
}

function relocateMacHelperMetadata(appPath) {
  const helpers = path.join(appPath, 'Contents', 'Helpers');
  const records = fs.readdirSync(helpers).filter((name) => name.endsWith('.json'));
  if (records.length) {
    const destination = metadataPath(appPath);
    fs.mkdirSync(destination, { recursive: true });
    helperMetadataDirectory(appPath);
    for (const name of records) {
      if (!fs.lstatSync(path.join(helpers, name)).isFile())
        throw new Error(`Invalid Mac helper metadata input: ${name}`);
      if (existingEntry(path.join(destination, name)))
        throw new Error(`Mac helper metadata already exists: ${name}`);
    }
    for (const name of records)
      fs.renameSync(path.join(helpers, name), path.join(destination, name));
  }
  const machOMagic = new Set([
    'cffaedfe',
    'feedfacf',
    'cefaedfe',
    'feedface',
    'cafebabe',
    'bebafeca',
    'cafebabf',
    'bfbafeca',
  ]);
  for (const name of fs.readdirSync(helpers)) {
    const file = path.join(helpers, name);
    const entry = fs.lstatSync(file);
    if (entry.isDirectory() && /\.(app|framework|xpc|bundle)$/.test(name)) continue;
    const prefix = Buffer.alloc(1024);
    if (entry.isFile()) {
      const descriptor = fs.openSync(file, 'r');
      try {
        fs.readSync(descriptor, prefix, 0, prefix.length, 0);
      } finally {
        fs.closeSync(descriptor);
      }
    }
    const problem = packagedHelperIntegrityProblem(entry, prefix, 'darwin');
    if (problem || !machOMagic.has(prefix.subarray(0, 4).toString('hex')))
      throw new Error(`Non-code helper entry ${name}: ${problem || 'is not Mach-O code'}`);
  }
}

module.exports = { helperMetadataDirectory, relocateMacHelperMetadata };
