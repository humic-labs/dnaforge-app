'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROBE_NAME = 'contract';
const EXPECTED_OUTPUTS = Object.freeze([
  `${PROBE_NAME}.fa.gz`,
  `${PROBE_NAME}.fa.gz.fai`,
  `${PROBE_NAME}.fa.gz.gzi`,
  `${PROBE_NAME}.gff3.gz`,
  `${PROBE_NAME}.gff3.gz.tbi`,
]);

function bgzfProblem(bytes, label) {
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8) {
    return `${label} is not gzip data`;
  }
  if ((bytes[3] & 0x04) === 0) return `${label} is gzip, but not BGZF`;

  const extraLength = bytes.readUInt16LE(10);
  const extraEnd = 12 + extraLength;
  if (extraEnd > bytes.length) return `${label} has a truncated gzip extra field`;
  for (let offset = 12; offset + 4 <= extraEnd; ) {
    const fieldLength = bytes.readUInt16LE(offset + 2);
    const fieldEnd = offset + 4 + fieldLength;
    if (fieldEnd > extraEnd) return `${label} has a malformed gzip extra field`;
    if (bytes[offset] === 0x42 && bytes[offset + 1] === 0x43 && fieldLength === 2) return null;
    offset = fieldEnd;
  }
  return `${label} is gzip, but has no BGZF BC field`;
}

function dnaIndexerBundleProblem(outputDir) {
  let outputNames;
  try {
    outputNames = fs.readdirSync(outputDir).sort();
  } catch (error) {
    return `could not inspect the output directory: ${error.message}`;
  }
  if (JSON.stringify(outputNames) !== JSON.stringify(EXPECTED_OUTPUTS)) {
    return (
      `output inventory must be ${EXPECTED_OUTPUTS.join(', ')}; got ` +
      (outputNames.length > 0 ? outputNames.join(', ') : '<empty>')
    );
  }

  for (const name of EXPECTED_OUTPUTS) {
    const outputPath = path.join(outputDir, name);
    const stat = fs.statSync(outputPath);
    if (!stat.isFile() || stat.size === 0) return `${name} is not a non-empty regular file`;
  }

  for (const name of [
    `${PROBE_NAME}.fa.gz`,
    `${PROBE_NAME}.gff3.gz`,
    `${PROBE_NAME}.gff3.gz.tbi`,
  ]) {
    const problem = bgzfProblem(fs.readFileSync(path.join(outputDir, name)), name);
    if (problem) return problem;
  }

  const fai = fs.readFileSync(path.join(outputDir, `${PROBE_NAME}.fa.gz.fai`), 'utf8');
  if (!fai.startsWith(`${PROBE_NAME}\t80\t`)) {
    return `${PROBE_NAME}.fa.gz.fai does not index the emitted 80-base sequence`;
  }

  const gzi = fs.readFileSync(path.join(outputDir, `${PROBE_NAME}.fa.gz.gzi`));
  if (gzi.length < 8) return `${PROBE_NAME}.fa.gz.gzi is truncated`;
  const entryCount = gzi.readBigUInt64LE(0);
  if (entryCount > BigInt(Number.MAX_SAFE_INTEGER)) {
    return `${PROBE_NAME}.fa.gz.gzi has an unsafe entry count`;
  }
  if (gzi.length !== 8 + Number(entryCount) * 16) {
    return `${PROBE_NAME}.fa.gz.gzi length does not match its entry count`;
  }

  return null;
}

function diagnosticFrom(result) {
  const output = `${result.stderr || ''}${result.stdout || ''}`.trim();
  if (result.error) return result.error.message;
  return output ? output.slice(0, 1_000) : 'no diagnostic output';
}

function inspectDnaIndexerContract(helperPath, { run = spawnSync } = {}) {
  const probeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dna-indexer-contract-'));
  const inputFasta = path.join(probeRoot, 'input.fa');
  const inputGff3 = path.join(probeRoot, 'input.gff3');
  const outputDir = path.join(probeRoot, 'output');
  fs.mkdirSync(outputDir);
  fs.writeFileSync(
    inputFasta,
    Buffer.concat([Buffer.from(`>${PROBE_NAME}\n`), Buffer.alloc(80, 0x41), Buffer.from('\n')])
  );
  fs.writeFileSync(
    inputGff3,
    [
      '##gff-version 3',
      `##sequence-region ${PROBE_NAME} 1 80`,
      `${PROBE_NAME}\tDNAForge\tgene\t2\t20\t.\t+\t.\tID=gene-1`,
      '',
    ].join('\n')
  );

  try {
    const result = run(
      helperPath,
      [
        'ingest-gff3',
        '--in',
        inputGff3,
        '--in-fasta',
        inputFasta,
        '--out-dir',
        outputDir,
        '--name',
        PROBE_NAME,
      ],
      {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
      }
    );
    if (result.error || result.status !== 0) {
      return {
        problem: `indexing probe failed (exit ${String(result.status)}): ${diagnosticFrom(result)}`,
      };
    }
    return { problem: dnaIndexerBundleProblem(outputDir), outputNames: [...EXPECTED_OUTPUTS] };
  } catch (error) {
    return { problem: `indexing probe could not run: ${error.message}` };
  } finally {
    fs.rmSync(probeRoot, { recursive: true, force: true });
  }
}

module.exports = {
  EXPECTED_OUTPUTS,
  bgzfProblem,
  dnaIndexerBundleProblem,
  inspectDnaIndexerContract,
};
