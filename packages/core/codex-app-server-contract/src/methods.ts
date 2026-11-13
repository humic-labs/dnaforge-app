import { manifest } from './manifest';

export const UPSTREAM_PROTOCOL_CLIENT_REQUEST_METHODS = [
  ...manifest.upstreamProtocolMethods.client,
] as const;

export const UPSTREAM_PROTOCOL_SERVER_REQUEST_METHODS = [
  ...manifest.upstreamProtocolMethods.server,
] as const;

export const UPSTREAM_PROTOCOL_SERVER_NOTIFICATION_METHODS = [
  ...manifest.upstreamProtocolMethods.notification,
] as const;

export type KnownUpstreamClientRequestMethod =
  (typeof UPSTREAM_PROTOCOL_CLIENT_REQUEST_METHODS)[number];
export type KnownUpstreamServerRequestMethod =
  (typeof UPSTREAM_PROTOCOL_SERVER_REQUEST_METHODS)[number];
export type KnownUpstreamServerNotificationMethod =
  (typeof UPSTREAM_PROTOCOL_SERVER_NOTIFICATION_METHODS)[number];

const CLIENT_METHODS_SET = new Set<string>(UPSTREAM_PROTOCOL_CLIENT_REQUEST_METHODS);
const SERVER_METHODS_SET = new Set<string>(UPSTREAM_PROTOCOL_SERVER_REQUEST_METHODS);
const NOTIFICATION_METHODS_SET = new Set<string>(UPSTREAM_PROTOCOL_SERVER_NOTIFICATION_METHODS);

export function isKnownUpstreamClientRequestMethod(
  method: string
): method is KnownUpstreamClientRequestMethod {
  return CLIENT_METHODS_SET.has(method);
}

export function isKnownUpstreamServerRequestMethod(
  method: string
): method is KnownUpstreamServerRequestMethod {
  return SERVER_METHODS_SET.has(method);
}

export function isKnownUpstreamServerNotificationMethod(
  method: string
): method is KnownUpstreamServerNotificationMethod {
  return NOTIFICATION_METHODS_SET.has(method);
}
