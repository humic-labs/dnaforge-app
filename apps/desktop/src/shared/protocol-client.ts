import type { NativeProtocolPlatformClient } from './protocol-packages';

export function unavailableProtocolClient(): NativeProtocolPlatformClient {
  const unavailable = async (): Promise<never> => {
    throw new Error('Native protocol packages are unavailable in this environment.');
  };
  return {
    createProtocol: unavailable,
    startRun: unavailable,
    inspectCreation: unavailable,
    recoverCreation: unavailable,
    readPackage: unavailable,
    readSavedProtocol: unavailable,
    listPackages: unavailable,
    savePackage: unavailable,
    onChanged: () => () => {},
  };
}
