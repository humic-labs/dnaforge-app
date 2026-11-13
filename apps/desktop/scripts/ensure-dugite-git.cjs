#!/usr/bin/env node

const path = require('node:path');
const { atomicWriteJson, ensureDugiteRuntime, normalizeArch } = require('./lib/dugite-runtime.cjs');

function parseArguments(argv) {
  const options = { verifyOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--verify-only') {
      options.verifyOnly = true;
    } else if (argument === '--arch' || argument === '--receipt') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      options[argument === '--arch' ? 'arch' : 'receiptPath'] = value;
      index += 1;
    } else if (argument.startsWith('--arch=')) {
      options.arch = argument.slice('--arch='.length);
    } else if (argument.startsWith('--receipt=')) {
      options.receiptPath = argument.slice('--receipt='.length);
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const arch = normalizeArch(
    args.arch || process.env.ARCH || process.env.npm_config_arch || process.arch
  );
  const result = await ensureDugiteRuntime({ arch, verifyOnly: args.verifyOnly });
  if (args.receiptPath) await atomicWriteJson(path.resolve(args.receiptPath), result.receipt);

  const disposition = result.provisioned ? 'provisioned' : 'verified';
  const execution = result.receipt.executionVerified
    ? result.receipt.gitVersion
    : 'execution deferred (cross-architecture target)';
  console.log(
    `[ensure-dugite-git] ${disposition} Dugite ${result.receipt.dugiteVersion} runtime ` +
      `for ${result.receipt.platform}/${result.receipt.arch}; ${execution}; ` +
      `archive sha256=${result.receipt.archiveSha256}`
  );
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      `[ensure-dugite-git] FATAL${error?.code ? ` ${error.code}` : ''}: ${error?.message || error}`
    );
    process.exitCode = 1;
  });
}

module.exports = { main, parseArguments };
