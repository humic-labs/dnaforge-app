'use strict';

const ABI_SIGNATURES = ['NODE_MODULE_VERSION', 'was compiled against a different Node.js version'];

const ARCH_SIGNATURES = [
  'incompatible architecture',
  'wrong ELF class',
  'not a valid Win32 application',
];

const LOAD_SIGNATURES = [
  'code signature',
  'not valid for use in process',
  'Library not loaded',
  'image not found',
  'cannot open shared object file',
  'operation not permitted',
  'EPERM',
];

function matchesAny(message, signatures) {
  const msg = message == null ? '' : String(message);
  return signatures.some((s) => msg.includes(s));
}

const isAbiError = (message) => matchesAny(message, ABI_SIGNATURES);
const isArchError = (message) => matchesAny(message, ARCH_SIGNATURES);
const isLoadError = (message) => matchesAny(message, LOAD_SIGNATURES);

module.exports = {
  ABI_SIGNATURES,
  ARCH_SIGNATURES,
  LOAD_SIGNATURES,
  matchesAny,
  isAbiError,
  isArchError,
  isLoadError,
};
