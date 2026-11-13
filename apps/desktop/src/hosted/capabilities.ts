import { type UserMessage, userMessage } from '@waypoint/user-messages';
import { useSyncExternalStore } from 'react';
import { isHostedBrowserRuntime } from '../utils/environment';

export type DemoAccess = 'allowed' | UserMessage;

export interface HostedCapabilityEntry {
  readonly browser: boolean;
  readonly demo: DemoAccess;
}

export const HOSTED_CAPABILITIES = {
  primers: { browser: true, demo: 'allowed' },
  'server-jobs': { browser: true, demo: userMessage('guidance.sign-up-to-run-this') },
  'external-lookups': { browser: true, demo: userMessage('guidance.sign-up-to-search') },
  'share-links': { browser: true, demo: userMessage('guidance.sign-up-to-share') },
  'reference-genomes': { browser: false, demo: 'allowed' },
} as const satisfies Record<string, HostedCapabilityEntry>;

export type HostedCapabilityId = keyof typeof HOSTED_CAPABILITIES;

export type HostedCapabilityState =
  | { readonly kind: 'available' }
  | { readonly kind: 'hidden' }
  | { readonly kind: 'sign-up'; readonly label: UserMessage };

let demoSession = false;
const listeners = new Set<() => void>();

export function setHostedDemoSession(active: boolean): void {
  if (demoSession === active) return;
  demoSession = active;
  for (const listener of listeners) listener();
}

export function isHostedDemoSession(): boolean {
  return isHostedBrowserRuntime() && demoSession;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function hostedCapabilityState(
  id: HostedCapabilityId,
  hosted = isHostedBrowserRuntime(),
  demo = demoSession
): HostedCapabilityState {
  if (!hosted) return { kind: 'available' };
  const entry: HostedCapabilityEntry = HOSTED_CAPABILITIES[id];
  if (!entry.browser) return { kind: 'hidden' };
  return demo && entry.demo !== 'allowed'
    ? { kind: 'sign-up', label: entry.demo }
    : { kind: 'available' };
}

export function isHostedCapabilityShown(id: HostedCapabilityId): boolean {
  return hostedCapabilityState(id).kind !== 'hidden';
}

export function useHostedDemoSession(): boolean {
  return useSyncExternalStore(subscribe, isHostedDemoSession, isHostedDemoSession);
}

export function useHostedCapability(id: HostedCapabilityId): HostedCapabilityState {
  const demo = useHostedDemoSession();
  return hostedCapabilityState(id, isHostedBrowserRuntime(), demo);
}

let keepWorkListener: ((reason: UserMessage | null) => void) | null = null;

export function onHostedKeepWorkRequest(
  listener: (reason: UserMessage | null) => void
): () => void {
  keepWorkListener = listener;
  return () => {
    if (keepWorkListener === listener) keepWorkListener = null;
  };
}

export function requestHostedKeepWork(reason: UserMessage | null = null): void {
  keepWorkListener?.(reason);
}

export class HostedSignUpRequiredError extends Error {
  constructor(readonly guidance: UserMessage) {
    super(guidance);
    this.name = 'HostedSignUpRequiredError';
  }
}

export function requireHostedCapability(id: HostedCapabilityId): void {
  const state = hostedCapabilityState(id);
  if (state.kind !== 'sign-up') return;
  requestHostedKeepWork(state.label);
  throw new HostedSignUpRequiredError(state.label);
}
