import type { RemoteAlignmentConnectRequestV1 } from '../shared/remote-genomics-ipc';
import { RemoteGenomicsError } from './remote-genomics-error';

export function assertRemoteReadBackend(
  request: RemoteAlignmentConnectRequestV1,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform === 'win32' && !request.tileServerReceiptPath?.trim()) {
    throw new RemoteGenomicsError(
      'helper-failed',
      'Windows read tracks require the Linux compute service. Choose Compute reads on cluster and provide its connection receipt. SSH login and file browsing remain available.'
    );
  }
}
