import { describe, expect, it } from 'vitest';

import { ignoreStdioStreamError, isBrokenStdioError } from '../stdio-errors';

function errnoError(code: string, syscall?: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${syscall ?? ''} ${code}`), { code, syscall });
}

describe('stdio-errors', () => {
  it('treats a closed terminal, a closed pipe and a destroyed stream as broken stdio', () => {
    expect(isBrokenStdioError(errnoError('EIO', 'write'))).toBe(true);
    expect(isBrokenStdioError(errnoError('EPIPE', 'write'))).toBe(true);
    expect(isBrokenStdioError(errnoError('ERR_STREAM_DESTROYED'))).toBe(true);
  });

  it('leaves real failures to the crash handler', () => {
    expect(isBrokenStdioError(errnoError('EIO', 'read'))).toBe(false);
    expect(isBrokenStdioError(errnoError('ENOENT', 'open'))).toBe(false);
    expect(isBrokenStdioError(new TypeError('boom'))).toBe(false);
    expect(isBrokenStdioError(null)).toBe(false);
  });

  it('never rethrows a stream error', () => {
    expect(() => ignoreStdioStreamError(errnoError('EIO', 'write'))).not.toThrow();
    expect(() => ignoreStdioStreamError(errnoError('EACCES', 'write'))).not.toThrow();
  });
});
