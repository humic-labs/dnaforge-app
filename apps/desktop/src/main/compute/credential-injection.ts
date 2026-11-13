import { COMPUTE_CREDENTIAL_HEADER } from '../../shared/compute-ipc';
import {
  authorizedSidecarDestination,
  injectReadySidecarSessionHeader,
  stripSidecarSessionHeaders,
  type SidecarRequestHeaders,
  type SidecarHeaderFailureStage,
  type SidecarRequestOwner,
} from '../sidecar-request-auth';

const COMPUTE_PATH = /^\/compute\/([a-z][a-z0-9_-]{1,63})\/(?!providers$)[a-z_]+\/?$/;

export function computeProviderFromPath(pathname: string): string | null {
  const match = COMPUTE_PATH.exec(pathname);
  return match ? match[1] : null;
}

export function stripComputeCredentialHeaders(
  headers: SidecarRequestHeaders
): SidecarRequestHeaders {
  const out: SidecarRequestHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === COMPUTE_CREDENTIAL_HEADER.toLowerCase()) continue;
    out[name] = value;
  }
  return out;
}

export interface InjectComputeCredentialInput {
  readonly requestUrl: string;
  readonly sidecarBaseUrl: string;
  readonly isAuthorized: () => boolean;
  readonly requestHeaders: SidecarRequestHeaders;
  readonly readCredential: (providerId: string) => Promise<string | null>;
}

export async function injectComputeCredentialHeader(
  input: InjectComputeCredentialInput
): Promise<SidecarRequestHeaders> {
  const headers = stripComputeCredentialHeaders(input.requestHeaders);
  const destination = authorizedSidecarDestination(input.requestUrl, input.sidecarBaseUrl);
  if (!destination) return headers;
  if (!input.isAuthorized()) throw new Error('SIDECAR_SESSION_UNAVAILABLE');
  const providerId = computeProviderFromPath(destination.pathname);
  if (!providerId) return headers;
  const secret = await input.readCredential(providerId);
  if (!input.isAuthorized()) throw new Error('SIDECAR_SESSION_UNAVAILABLE');
  if (!secret) return headers;
  return { ...headers, [COMPUTE_CREDENTIAL_HEADER]: secret };
}

export function createSidecarRequestHeaderHandler(options: {
  readonly isTrustedOwner: (details: SidecarRequestOwner) => boolean;
  readonly getSidecarBaseUrl: () => string;
  readonly authority: Parameters<typeof injectReadySidecarSessionHeader>[0]['authority'];
  readonly readCredential: InjectComputeCredentialInput['readCredential'];
  readonly onError: (error: unknown, stage: SidecarHeaderFailureStage, requestUrl: string) => void;
}) {
  return (
    details: SidecarRequestOwner & {
      url: string;
      requestHeaders: SidecarRequestHeaders;
    },
    callback: (result: { requestHeaders: SidecarRequestHeaders } | { cancel: true }) => void
  ): void => {
    const sidecarBaseUrl = options.getSidecarBaseUrl();
    const strippedHeaders = stripComputeCredentialHeaders(
      stripSidecarSessionHeaders(details.requestHeaders)
    );
    if (
      !options.isTrustedOwner(details) ||
      !authorizedSidecarDestination(details.url, sidecarBaseUrl)
    ) {
      callback({ requestHeaders: strippedHeaders });
      return;
    }
    let snapshot: Awaited<ReturnType<typeof options.authority.waitForReadySnapshot>> | undefined;
    const isAuthorized = (): boolean =>
      Boolean(
        snapshot?.state === 'ready' &&
        options.authority.isCurrent(snapshot) &&
        options.isTrustedOwner(details) &&
        authorizedSidecarDestination(details.url, options.getSidecarBaseUrl()) &&
        options.getSidecarBaseUrl() === sidecarBaseUrl
      );
    let failureStage: SidecarHeaderFailureStage = 'sidecar-session';
    void injectReadySidecarSessionHeader({
      requestUrl: details.url,
      sidecarBaseUrl,
      requestHeaders: strippedHeaders,
      authority: {
        waitForReadySnapshot: async (timeoutMs) => {
          snapshot = await options.authority.waitForReadySnapshot(timeoutMs);
          return snapshot;
        },
        isCurrent: (ready) => options.authority.isCurrent(ready),
        humanOperationToken: options.authority.humanOperationToken
          ? (ready) => options.authority.humanOperationToken?.(ready)
          : undefined,
      },
    })
      .then((requestHeaders) => {
        failureStage = 'compute-header';
        return injectComputeCredentialHeader({
          requestUrl: details.url,
          sidecarBaseUrl,
          isAuthorized,
          requestHeaders,
          readCredential: options.readCredential,
        });
      })
      .then((requestHeaders) => {
        failureStage = 'header-callback';
        if (!isAuthorized()) throw new Error('SIDECAR_SESSION_UNAVAILABLE');
        callback({ requestHeaders });
      })
      .catch((error: unknown) => {
        options.onError(error, failureStage, details.url);
        callback({ cancel: true });
      });
  };
}
