export function trackTileErrorRetryable(error: unknown): boolean {
  if (
    error &&
    typeof error === 'object' &&
    'retryable' in error &&
    typeof error.retryable === 'boolean'
  )
    return error.retryable;
  const message = error instanceof Error ? error.message : String(error);
  return !(
    /\b(?:ENOENT|EACCES|EPERM|ENOTDIR)\b|no such file or directory/i.test(message) ||
    /indexed genomic source is not a regular file|local indexed track is outside every active project|select this local indexed track through the DNAForge file picker/i.test(
      message
    ) ||
    /^upstream-truncated:/i.test(message) ||
    /source changed|source validator changed|source length changed|source format changed/i.test(
      message
    ) ||
    /does not support byte ranges|invalid content-range|wrong byte range|truncated byte range/i.test(
      message
    ) ||
    /not (?:a|an) (?:BigWig|BigBed)|incompatible with|zoom in to (?:keep|render)/i.test(message) ||
    /\bHTTP (?:401|403|404|409|416|422)\b/i.test(message)
  );
}

export function trackTileErrorScope(error: unknown): 'source' | 'request' {
  const message = error instanceof Error ? error.message : String(error);
  return /^upstream-truncated:|zoom in to (?:keep|render)/i.test(message) ? 'request' : 'source';
}
