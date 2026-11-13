const fs = require('node:fs');
const path = require('node:path');

const HELPER_PREFIXES = ['dna-indexer-', 'dna-coverage-', 'dna-process-guardian-', 'fastp-', 'minimap2-', 'samtools-'];
const DARWIN_SUFFIX_BY_ARCH = Object.freeze({
  arm64: 'aarch64-apple-darwin',
  x64: 'x86_64-apple-darwin',
});

function allowedDarwinSuffixes(archName) {
  if (archName === 'universal') {
    return new Set(Object.values(DARWIN_SUFFIX_BY_ARCH));
  }

  const suffix = DARWIN_SUFFIX_BY_ARCH[archName];
  if (!suffix) {
    throw new Error(
      `Unsupported macOS package architecture ${JSON.stringify(archName)}; ` +
        `expected one of: ${Object.keys(DARWIN_SUFFIX_BY_ARCH).join(', ')}, universal`
    );
  }
  return new Set([suffix]);
}

function helperSuffix(name) {
  const prefix = HELPER_PREFIXES.find((candidate) => name.startsWith(candidate));
  return prefix ? name.slice(prefix.length) : null;
}

function pruneForeignDarwinHelpers({ helpersDir, archName }) {
  const allowed = allowedDarwinSuffixes(archName);
  if (!fs.existsSync(helpersDir)) {
    return { kept: [], removed: [] };
  }

  const kept = [];
  const removed = [];
  for (const entry of fs.readdirSync(helpersDir, { withFileTypes: true })) {
    const suffix = helperSuffix(entry.name);
    if (suffix === null) {
      continue;
    }

    const entryPath = path.join(helpersDir, entry.name);
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      throw new Error(
        `Refusing to prune packaged helper ${entryPath}: expected a file or symbolic link`
      );
    }

    if (allowed.has(suffix)) {
      kept.push(entry.name);
      continue;
    }

    fs.unlinkSync(entryPath);
    removed.push(entry.name);
  }

  kept.sort();
  removed.sort();
  return { kept, removed };
}

module.exports = {
  DARWIN_SUFFIX_BY_ARCH,
  allowedDarwinSuffixes,
  pruneForeignDarwinHelpers,
};
