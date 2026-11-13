import {
  SidecarSessionAuthority,
  type SidecarSessionSnapshot,
  type SidecarSpawnReason,
} from './sidecar-session-authority';
import { getApiUrl } from './config';
import { createSidecarFetch } from './sidecar-request-auth';

const inheritedToken = process.env.DNAFORGE_MCP_SESSION_TOKEN;
const inheritedHumanOperationToken = process.env.DNAFORGE_HUMAN_OPERATION_TOKEN;
const inheritedNativeDocumentToken = process.env.DNAFORGE_NATIVE_DOCUMENT_TOKEN;
const inheritedNativeDocumentOwnerId = process.env.DNAFORGE_NATIVE_DOCUMENT_OWNER_ID;

export const sidecarSessionAuthority = new SidecarSessionAuthority({
  ...(inheritedToken ? { initialToken: inheritedToken } : {}),
  ...(inheritedHumanOperationToken
    ? { initialHumanOperationToken: inheritedHumanOperationToken }
    : {}),
  ...(inheritedNativeDocumentToken && inheritedNativeDocumentOwnerId
    ? {
        initialNativeDocumentToken: inheritedNativeDocumentToken,
        initialNativeDocumentOwnerId: inheritedNativeDocumentOwnerId,
      }
    : {}),
});

delete process.env.DNAFORGE_MCP_SESSION_TOKEN;
delete process.env.DNAFORGE_HUMAN_OPERATION_TOKEN;
delete process.env.DNAFORGE_NATIVE_DOCUMENT_TOKEN;
delete process.env.DNAFORGE_NATIVE_DOCUMENT_OWNER_ID;
delete process.env.DNAFORGE_NATIVE_DOCUMENT_URL;
delete process.env.DNAFORGE_SIDECAR_SESSION_GENERATION;

let nativeDocumentCommandServer: Readonly<{ url: string; ownerInstanceId: string }> | undefined;

export function registerNativeDocumentCommandServer(
  url: string,
  ownerInstanceId: string
): () => void {
  const address = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(url);
  if (!address || Number(address[1]) > 65535) {
    throw new Error('The native document command server must use an exact loopback address.');
  }
  const authority = sidecarSessionAuthority.nativeDocumentAuthority(
    sidecarSessionAuthority.snapshot()
  );
  if (!authority || authority.ownerInstanceId !== ownerInstanceId) {
    throw new Error('The native document command server belongs to a different owner.');
  }
  if (nativeDocumentCommandServer) {
    throw new Error('A native document command server is already registered.');
  }
  const registration = Object.freeze({ url, ownerInstanceId });
  nativeDocumentCommandServer = registration;
  return () => {
    if (nativeDocumentCommandServer === registration) nativeDocumentCommandServer = undefined;
  };
}

export function nativeDocumentCommandEnv(snapshot: SidecarSessionSnapshot): Record<string, string> {
  const authority = sidecarSessionAuthority.nativeDocumentAuthority(snapshot);
  return authority && nativeDocumentCommandServer?.ownerInstanceId === authority.ownerInstanceId
    ? { DNAFORGE_NATIVE_DOCUMENT_URL: nativeDocumentCommandServer.url }
    : {};
}

export function prepareSidecarSpawn(reason: SidecarSpawnReason): SidecarSessionSnapshot {
  return sidecarSessionAuthority.prepareManagedSpawn(reason);
}

export const sidecarFetch = createSidecarFetch({
  getBaseUrl: getApiUrl,
  getCurrentToken: () => sidecarSessionAuthority.currentToken(),
  getHumanOperationToken: () =>
    sidecarSessionAuthority.humanOperationToken(sidecarSessionAuthority.snapshot()),
});

export const nativeDocumentFetch = createSidecarFetch({
  getBaseUrl: getApiUrl,
  getCurrentToken: () => sidecarSessionAuthority.currentToken(),
  getNativeDocumentToken: () =>
    sidecarSessionAuthority.nativeDocumentAuthority(sidecarSessionAuthority.snapshot())?.token,
});
