#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { inspectDnaIndexerContract } = require('./lib/dna-indexer-contract.cjs');

const helperArgument = process.argv[2];
if (!helperArgument || process.argv.length !== 3) {
  console.error('Usage: node apps/desktop/scripts/verify-dna-indexer-contract.cjs <dna-indexer>');
  process.exitCode = 2;
} else {
  const helperPath = path.resolve(helperArgument);
  const result = inspectDnaIndexerContract(helperPath);
  if (result.problem) {
    console.error(`[verify-dna-indexer-contract] FAILED: ${result.problem}`);
    process.exitCode = 1;
  } else {
    console.log(
      `[verify-dna-indexer-contract] PASS: ${path.basename(helperPath)} emits the current BGZF genome bundle`
    );
  }
}
