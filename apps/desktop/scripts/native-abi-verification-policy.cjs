'use strict';

function strictRuntimeAbiError({ strict, canRuntimeVerify, verdict }) {
  if (!strict) return null;
  if (!canRuntimeVerify) {
    return 'strict Electron ABI verification was required, but the Electron runtime probe was unavailable';
  }
  if (verdict !== 'pass') {
    return `strict Electron ABI verification was required, but the runtime probe was ${verdict ?? 'unavailable'}`;
  }
  return null;
}

module.exports = { strictRuntimeAbiError };
