import type { RemoteSshFailureCode } from '../shared/remote-genomics-ipc';

export class RemoteGenomicsError extends Error {
  constructor(
    readonly code: RemoteSshFailureCode,
    message: string
  ) {
    super(message);
    this.name = 'RemoteGenomicsError';
  }
}
