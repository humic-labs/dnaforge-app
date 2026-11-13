export function isBrokenStdioError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as NodeJS.ErrnoException;
  if (err.code === 'ERR_STREAM_DESTROYED') return true;
  return (err.code === 'EPIPE' || err.code === 'EIO') && err.syscall?.toUpperCase() === 'WRITE';
}

export function ignoreStdioStreamError(_err: NodeJS.ErrnoException): void {}
