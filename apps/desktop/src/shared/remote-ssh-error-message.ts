export function remoteSshErrorMessage(error: unknown): string {
  let message = (error instanceof Error ? error.message : String(error)).trim();
  for (;;) {
    const unwrapped = message
      .replace(/^Error:\s*/u, '')
      .replace(/^Error invoking remote method '[^']+':\s*/u, '')
      .replace(/^RemoteGenomicsError:\s*/u, '');
    if (unwrapped === message) return message;
    message = unwrapped;
  }
}
