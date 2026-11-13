'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const {
  helperExecutableName,
  packagedHelperIntegrityProblem,
} = require('./verify-package-helpers.cjs');
const { describeNativeBinary, DNA_HELPER_SPECS } = require('./native-binary.cjs');
const { inspectDnaIndexerContract } = require('./dna-indexer-contract.cjs');

function parseLfsPointer(text) {
  const match =
    /^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize ([1-9][0-9]*)\n$/.exec(
      text
    );
  if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 1024) {
    throw new Error('expected an exact three-line Git LFS pointer for a compiled helper');
  }
  return { sha256: match[1], size: Number(match[2]) };
}

function git(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function helperInputStatus({
  repoRoot,
  platform,
  arch,
  probe = spawnSync,
  indexerContractProbe = inspectDnaIndexerContract,
}) {
  const problems = [];
  const missing = [];
  let sourceCommit;
  try {
    sourceCommit = git(repoRoot, ['rev-parse', '--verify', 'HEAD']).trim();
    if (!/^[a-f0-9]{40}$/.test(sourceCommit))
      throw new Error('HEAD is not an immutable source commit');
    const helpersDir = path.resolve(repoRoot, 'apps/desktop/resources/helpers');
    for (
      let parent = helpersDir;
      parent !== path.resolve(repoRoot);
      parent = path.dirname(parent)
    ) {
      try {
        if (fs.lstatSync(parent).isSymbolicLink())
          throw new Error(`helper input parent is a symlink: ${parent}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    for (const spec of DNA_HELPER_SPECS) {
      const relativePath = `apps/desktop/resources/helpers/${helperExecutableName(spec.name, platform, arch)}`;
      try {
        const treeEntry = git(repoRoot, ['ls-tree', sourceCommit, '--', relativePath]);
        if (!treeEntry.startsWith('100755 blob ')) {
          throw new Error(
            `no executable LFS input in source ${sourceCommit}; supply the reviewed ${arch} object, do not compile a replacement`
          );
        }
        const pointer = git(repoRoot, ['show', `${sourceCommit}:${relativePath}`]);
        const expected = parseLfsPointer(pointer);
        git(repoRoot, ['diff', '--cached', '--quiet', sourceCommit, '--', relativePath]);
        const helperPath = path.join(repoRoot, relativePath);
        let stat;
        try {
          stat = fs.lstatSync(helperPath);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          missing.push(relativePath);
          problems.push(`${spec.name}: missing exact-source Git LFS helper`);
          continue;
        }
        if (!stat.isFile()) throw new Error('helper is not a regular file');
        if (stat.size > 1024 && stat.size !== expected.size)
          throw new Error(
            'helper size differs from the exact source LFS object; preserve local bytes'
          );
        const bytes = fs.readFileSync(helperPath);
        if (
          bytes.toString('utf8', 0, 256).startsWith('version https://git-lfs.github.com/spec/v1')
        ) {
          if (bytes.toString('utf8') !== pointer)
            throw new Error('local LFS pointer differs from source; preserve local changes');
          missing.push(relativePath);
          problems.push(`${spec.name}: Git LFS pointer requires hydration`);
          continue;
        }
        const integrity = packagedHelperIntegrityProblem(stat, bytes.subarray(0, 256), platform);
        if (integrity) throw new Error(integrity);
        if (
          bytes.length !== expected.size ||
          createHash('sha256').update(bytes).digest('hex') !== expected.sha256
        ) {
          throw new Error(
            'helper size or SHA-256 differs from the exact source LFS object; preserve local bytes'
          );
        }
        describeNativeBinary(helperPath, { platform, arch });
        const result = probe(helperPath, spec.probeArgs, {
          encoding: 'utf8',
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
        if (result.error || result.status !== 0 || !spec.supportedSchema.test(output)) {
          throw new Error(
            `unsupported helper schema or failed probe (exit ${String(result.status)})`
          );
        }
        if (spec.name === 'dna-indexer') {
          const contract = indexerContractProbe(helperPath);
          if (contract.problem) {
            throw new Error(`incompatible indexed-genome output contract: ${contract.problem}`);
          }
        }
      } catch (error) {
        problems.push(`${spec.name}: ${error.message}`);
      }
    }
  } catch (error) {
    problems.push(`native helper source authority: ${error.message}`);
  }
  return { problems, missing, sourceCommit };
}

function acquireHelperInputs(options, { runGit = git } = {}) {
  const status = helperInputStatus(options);
  if (!status.missing.length || status.problems.length !== status.missing.length) return status;
  try {
    runGit(options.repoRoot, ['lfs', 'version']);
    runGit(options.repoRoot, [
      'lfs',
      'fetch',
      '--include=' + status.missing.join(','),
      '--exclude=',
      'origin',
      status.sourceCommit,
    ]);
    if (git(options.repoRoot, ['rev-parse', 'HEAD']).trim() !== status.sourceCommit) {
      throw new Error('source changed during helper acquisition');
    }
    const beforeCheckout = helperInputStatus(options);
    if (
      beforeCheckout.sourceCommit !== status.sourceCommit ||
      beforeCheckout.problems.length !== beforeCheckout.missing.length ||
      JSON.stringify(beforeCheckout.missing) !== JSON.stringify(status.missing)
    ) {
      throw new Error('helper paths or inputs changed during acquisition; preserve local bytes');
    }
    for (const relativePath of status.missing) {
      git(options.repoRoot, [
        'diff',
        '--cached',
        '--quiet',
        status.sourceCommit,
        '--',
        relativePath,
      ]);
      const localPath = path.join(options.repoRoot, relativePath);
      try {
        const stat = fs.lstatSync(localPath);
        if (
          !stat.isFile() ||
          stat.size > 1024 ||
          fs.readFileSync(localPath, 'utf8') !==
            git(options.repoRoot, ['show', `${status.sourceCommit}:${relativePath}`])
        ) {
          throw new Error('helper changed during acquisition; preserve local bytes');
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    runGit(options.repoRoot, ['lfs', 'checkout', ...status.missing]);
  } catch (error) {
    return {
      ...status,
      problems: [...status.problems, `exact-source Git LFS acquisition failed: ${error.message}`],
    };
  }
  return helperInputStatus(options);
}

module.exports = { acquireHelperInputs, helperInputStatus, parseLfsPointer };
