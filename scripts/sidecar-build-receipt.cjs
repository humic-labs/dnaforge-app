#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  assertRequiredSidecarSourceInputs,
  computeSidecarSourceHashForInputs,
} = require('./lib/sidecar-source-hash.cjs');

const RECEIPT_NAME = 'dnaforge-sidecar-build-receipt.json';
const RECEIPT_SCHEMA = 'dnaforge.sidecar-build-receipt.v2';
const REQUIRED_PYTHON_VERSION = '3.12';
const SOURCE_INPUTS_CONTRACT_PATH = path.join(
  __dirname,
  '..',
  'apps',
  'api',
  'src',
  'sidecar-source-inputs.json'
);
const SOURCE_INPUTS_CONTRACT = JSON.parse(fs.readFileSync(SOURCE_INPUTS_CONTRACT_PATH, 'utf8'));

if (
  SOURCE_INPUTS_CONTRACT.schema !== 'dnaforge.sidecar-source-inputs.v1' ||
  !Array.isArray(SOURCE_INPUTS_CONTRACT.paths) ||
  SOURCE_INPUTS_CONTRACT.paths.length === 0
) {
  throw new Error('apps/api/src/sidecar-source-inputs.json is invalid');
}
try {
  assertRequiredSidecarSourceInputs(SOURCE_INPUTS_CONTRACT.paths);
} catch (error) {
  throw new Error('apps/api/src/sidecar-source-inputs.json is invalid', { cause: error });
}
const SOURCE_INPUTS = Object.freeze([...SOURCE_INPUTS_CONTRACT.paths]);

function computeSidecarSourceHash(repoRoot) {
  return computeSidecarSourceHashForInputs(repoRoot, SOURCE_INPUTS);
}

function executableNameForTarget(target) {
  return target.includes('windows') ? 'waypoint-api.exe' : 'waypoint-api';
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function bundleInventory(sidecarDir) {
  const root = path.resolve(sidecarDir);
  const entries = [];
  let totalBytes = 0;

  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (relative === RECEIPT_NAME) continue;
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) {
        visit(absolute);
      } else if (stat.isFile()) {
        totalBytes += stat.size;
        entries.push({
          path: relative,
          kind: 'file',
          bytes: stat.size,
          mode: stat.mode & 0o777,
          sha256: sha256File(absolute),
        });
      } else if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(absolute);
        if (path.isAbsolute(target)) {
          throw new Error(`sidecar bundle contains an absolute symbolic link: ${relative}`);
        }
        const resolved = path.resolve(path.dirname(absolute), target);
        if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
          throw new Error(`sidecar bundle symbolic link escapes its root: ${relative}`);
        }
        const realTarget = fs.realpathSync(resolved);
        if (realTarget !== root && !realTarget.startsWith(`${root}${path.sep}`)) {
          throw new Error(`sidecar bundle symbolic link resolves outside its root: ${relative}`);
        }
        entries.push({ path: relative, kind: 'symlink', target });
      } else {
        throw new Error(`sidecar bundle contains an unsupported filesystem entry: ${relative}`);
      }
    }
  }

  visit(root);
  const bundleSha256 = crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return { bundleSha256, bundleEntryCount: entries.length, bundleTotalBytes: totalBytes };
}

function writeReceipt({ repoRoot, sidecarDir, target, pythonVersion }) {
  const executable = path.join(sidecarDir, executableNameForTarget(target));
  if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
    throw new Error(`sidecar executable is missing: ${executable}`);
  }
  const { sourceHash, inputCount } = computeSidecarSourceHash(repoRoot);
  const inventory = bundleInventory(sidecarDir);
  const receipt = {
    schema: RECEIPT_SCHEMA,
    target,
    sourceHash,
    sourceInputCount: inputCount,
    executable: path.basename(executable),
    executableSha256: sha256File(executable),
    pythonVersion,
    ...inventory,
  };
  const receiptPath = path.join(sidecarDir, RECEIPT_NAME);
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
  return { receipt, receiptPath };
}

function receiptProblems({ repoRoot, sidecarDir, target, verifyExecutableHash = true }) {
  const receiptPath = path.join(sidecarDir, RECEIPT_NAME);
  if (!fs.existsSync(receiptPath)) return [`sidecar build receipt is missing: ${receiptPath}`];

  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  } catch (error) {
    return [`sidecar build receipt is unreadable: ${error.message}`];
  }

  const problems = [];
  if (receipt.schema !== RECEIPT_SCHEMA) {
    problems.push(
      `sidecar receipt schema is ${JSON.stringify(receipt.schema)}, expected ${RECEIPT_SCHEMA}`
    );
  }
  if (receipt.target !== target) {
    problems.push(
      `sidecar receipt target is ${JSON.stringify(receipt.target)}, expected ${target}`
    );
  }
  if (
    typeof receipt.pythonVersion !== 'string' ||
    !new RegExp(`^(?:Python )?${REQUIRED_PYTHON_VERSION.replace('.', '\\.')}(?:\\.|$)`).test(
      receipt.pythonVersion
    )
  ) {
    problems.push(
      `sidecar receipt Python is ${JSON.stringify(receipt.pythonVersion)}, expected ${REQUIRED_PYTHON_VERSION}.x`
    );
  }
  const { sourceHash, inputCount } = computeSidecarSourceHash(repoRoot);
  if (receipt.sourceHash !== sourceHash) {
    problems.push(
      `sidecar source hash is stale (${String(receipt.sourceHash || '<missing>')}), expected ${sourceHash}`
    );
  }
  if (receipt.sourceInputCount !== inputCount) {
    problems.push(
      `sidecar receipt input count is ${String(receipt.sourceInputCount)}, expected ${inputCount}`
    );
  }

  const executableName = executableNameForTarget(target);
  const executable = path.join(sidecarDir, executableName);
  if (receipt.executable !== executableName) {
    problems.push(
      `sidecar receipt executable is ${JSON.stringify(receipt.executable)}, expected ${executableName}`
    );
  }
  if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
    problems.push(`sidecar receipt executable is missing: ${executable}`);
  } else if (verifyExecutableHash) {
    const executableSha256 = sha256File(executable);
    if (receipt.executableSha256 !== executableSha256) {
      problems.push(
        `sidecar executable hash is ${executableSha256}, receipt records ${String(receipt.executableSha256 || '<missing>')}`
      );
    }
  }
  if (verifyExecutableHash) {
    let inventory;
    try {
      inventory = bundleInventory(sidecarDir);
    } catch (error) {
      problems.push(`sidecar bundle cannot be inventoried: ${error.message}`);
      return problems;
    }
    if (receipt.bundleSha256 !== inventory.bundleSha256) {
      problems.push(
        `sidecar bundle hash is ${inventory.bundleSha256}, receipt records ${String(receipt.bundleSha256 || '<missing>')}`
      );
    }
    if (receipt.bundleEntryCount !== inventory.bundleEntryCount) {
      problems.push(
        `sidecar bundle entry count is ${inventory.bundleEntryCount}, receipt records ${String(receipt.bundleEntryCount)}`
      );
    }
    if (receipt.bundleTotalBytes !== inventory.bundleTotalBytes) {
      problems.push(
        `sidecar bundle byte count is ${inventory.bundleTotalBytes}, receipt records ${String(receipt.bundleTotalBytes)}`
      );
    }
  }
  return problems;
}

function readOption(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function main(args = process.argv.slice(2)) {
  const command = args[0];
  const repoRoot = path.resolve(readOption(args, '--repo-root') || path.join(__dirname, '..'));
  if (command === 'source-hash') {
    process.stdout.write(computeSidecarSourceHash(repoRoot).sourceHash);
    return 0;
  }
  const sidecarDirOption = readOption(args, '--sidecar-dir');
  const target = readOption(args, '--target');
  if (!sidecarDirOption || !target) {
    throw new Error(
      'usage: sidecar-build-receipt.cjs <source-hash|write|verify> [--sidecar-dir <dir>] [--target <triple>]'
    );
  }
  const sidecarDir = path.resolve(sidecarDirOption);

  if (command === 'write') {
    const { receiptPath, receipt } = writeReceipt({
      repoRoot,
      sidecarDir,
      target,
      pythonVersion: readOption(args, '--python-version') || 'unknown',
    });
    console.log(
      `[sidecar-build-receipt] wrote ${receiptPath} (source ${receipt.sourceHash.slice(0, 12)}, executable ${receipt.executableSha256.slice(0, 12)})`
    );
    return 0;
  }
  if (command === 'verify') {
    const problems = receiptProblems({ repoRoot, sidecarDir, target });
    if (problems.length > 0) {
      for (const problem of problems) console.error(`[sidecar-build-receipt] ${problem}`);
      return 1;
    }
    console.log(`[sidecar-build-receipt] PASS: exact current source and executable bytes`);
    return 0;
  }
  throw new Error(`unknown command: ${command || '<missing>'}`);
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`[sidecar-build-receipt] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  RECEIPT_NAME,
  RECEIPT_SCHEMA,
  REQUIRED_PYTHON_VERSION,
  SOURCE_INPUTS,
  computeSidecarSourceHash,
  bundleInventory,
  executableNameForTarget,
  receiptProblems,
  writeReceipt,
};
