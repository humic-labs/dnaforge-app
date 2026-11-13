const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { SOURCE_LOCK_BYTES, ngsToolSuffix } = require('./ngs-tools.cjs');
const { helperMetadataDirectory } = require('./mac-helper-metadata.cjs');
const digest = (data) => createHash('sha256').update(data).digest('hex');

function collectAppOwnedToolSources({ appPath, arch }) {
  const helpers = path.join(appPath, 'Contents', 'Helpers');
  const metadata = helperMetadataDirectory(appPath);
  const receiptName = 'ngs-tools.build.json';
  const receiptFile = path.join(metadata, receiptName);
  if (!fs.existsSync(receiptFile)) {
    if (fs.readdirSync(helpers).some((file) => /^(minimap2|samtools)-/.test(file)))
      throw new Error('Packaged NGS tools have no source-build receipt.');
    return [];
  }
  if (!fs.lstatSync(receiptFile).isFile() || fs.statSync(receiptFile).size > 256 * 1024) {
    throw new Error('Invalid NGS tool producer receipt.');
  }
  const raw = fs.readFileSync(receiptFile);
  const receipt = JSON.parse(raw);
  const suffix = ngsToolSuffix(arch);
  const lockFile = path.join(metadata, 'ngs-tools.source.lock.json');
  if (!fs.lstatSync(lockFile).isFile() || fs.statSync(lockFile).size > 64 * 1024)
    throw new Error('Invalid packaged NGS source lock.');
  const lock = fs.readFileSync(lockFile);
  if (
    digest(lock) !== digest(SOURCE_LOCK_BYTES) ||
    receipt.sourceLockSha256 !== digest(lock) ||
    receipt.schema !== 'dnaforge.ngs-tools-build.v1' ||
    receipt.phase !== 'source-build-before-package-signing' ||
    receipt.target !== suffix ||
    receipt.profile !== 'local-bam-v1'
  )
    throw new Error('Packaged NGS tools have an incompatible source receipt.');
  if (!receipt.tools || Object.keys(receipt.tools).sort().join(',') !== 'minimap2,samtools')
    throw new Error('Packaged NGS tool source set is incomplete.');
  const sources = ['minimap2', 'samtools'].map((name) => {
    const tool = receipt.tools[name];
    if (tool.file !== `${name}-${suffix}` || !/^[0-9a-f]{64}$/.test(tool.sha256))
      throw new Error('Packaged NGS tool source identity is invalid.');
    return { file: tool.file, sourceReceiptFile: receiptName, sourceBuildSha256: tool.sha256 };
  });
  const coverageReceiptName = 'coverage-build-provenance.json';
  const coverageReceipt = path.join(metadata, coverageReceiptName);
  if (fs.existsSync(coverageReceipt)) {
    if (!fs.lstatSync(coverageReceipt).isFile() || fs.statSync(coverageReceipt).size > 256 * 1024)
      throw new Error('Invalid coverage producer receipt.');
    const coverage = JSON.parse(fs.readFileSync(coverageReceipt, 'utf8'));
    if (
      coverage.schema !== 'dnaforge.coverage-helper-artifact/v1' ||
      coverage.target !== suffix ||
      !/^[0-9a-f]{64}$/.test(coverage.binarySha256)
    )
      throw new Error('Incompatible coverage producer receipt.');
    sources.push({
      file: `dna-coverage-${suffix}`,
      sourceReceiptFile: coverageReceiptName,
      sourceBuildSha256: coverage.binarySha256,
    });
  }
  return sources;
}
module.exports = { collectAppOwnedToolSources };
