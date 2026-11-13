'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function describeNativeBinary(binaryPath, { platform: targetPlatform, arch: targetArch }) {
  if (targetPlatform === 'win32') {
    const bytes = fs.readFileSync(binaryPath);
    if (bytes.length < 0x40 || bytes.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error('not a Windows PE file');
    }

    const peOffset = bytes.readUInt32LE(0x3c);
    if (
      bytes.length < peOffset + 6 ||
      bytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0'
    ) {
      throw new Error('invalid Windows PE header');
    }

    const machine = bytes.readUInt16LE(peOffset + 4);
    const actualArch =
      machine === 0x8664
        ? 'x64'
        : machine === 0xaa64
          ? 'arm64'
          : `unknown(0x${machine.toString(16)})`;
    if (actualArch !== targetArch) {
      throw new Error(`binary architecture mismatch — expected ${targetArch}, got ${actualArch}`);
    }
    return `Windows PE machine=${actualArch} (0x${machine.toString(16)})`;
  }

  const fileOutput = execFileSync('file', ['-b', binaryPath], { encoding: 'utf8' }).trim();
  if (targetPlatform === 'darwin' && !fileOutput.includes('Mach-O')) {
    throw new Error('not a macOS Mach-O executable');
  }
  const isArm = fileOutput.includes('arm64') || fileOutput.includes('aarch64');
  const isX64 = fileOutput.includes('x86_64') || fileOutput.includes('x86-64');
  const archOk = targetArch === 'arm64' ? isArm : isX64;

  if (!archOk) {
    throw new Error(
      `binary architecture mismatch — expected ${targetArch}, got: ${fileOutput.split(':').pop().trim()}`
    );
  }
  return fileOutput.split(':').pop().trim();
}

const DNA_HELPER_SPECS = Object.freeze([
  Object.freeze({ name: 'dna-indexer', probeArgs: ['--version'], supportedSchema: /schema 2$/ }),
  Object.freeze({
    name: 'dna-coverage',
    probeArgs: ['schema-version'],
    supportedSchema: /schema 2$/,
  }),
]);

const FASTP_HELPER_SPEC = Object.freeze({
  name: 'fastp',
  probeArgs: ['--version'],
  supportedSchema: /^fastp 1\.4\.0$/,
});

module.exports = { describeNativeBinary, DNA_HELPER_SPECS, FASTP_HELPER_SPEC };
