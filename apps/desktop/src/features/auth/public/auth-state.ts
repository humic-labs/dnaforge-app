import type { DesktopAuthState } from '../../../shared/auth-types';

export type DesktopAuthSnapshot = Readonly<{
  state: DesktopAuthState;
  hydrated: boolean;
}>;

type Subscriber = (snapshot: DesktopAuthSnapshot, previous: DesktopAuthSnapshot) => void;

let snapshot: DesktopAuthSnapshot = { state: { status: 'signed-out' }, hydrated: false };
const subscribers = new Set<Subscriber>();

export function getDesktopAuthSnapshot(): DesktopAuthSnapshot {
  return snapshot;
}

export function subscribeDesktopAuthSnapshot(subscriber: Subscriber): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export function publishDesktopAuthSnapshot(next: DesktopAuthSnapshot): void {
  if (next.state === snapshot.state && next.hydrated === snapshot.hydrated) return;
  const previous = snapshot;
  snapshot = { state: next.state, hydrated: next.hydrated };
  for (const subscriber of subscribers) subscriber(snapshot, previous);
}
