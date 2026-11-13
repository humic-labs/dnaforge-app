import { useEffect, useRef } from 'react';

const eventName = 'waypoint:open-managed-sequence-metadata';
let pending: string | null = null;

export function requestManagedSequenceMetadata(packageId: string): void {
  pending = packageId;
  window.dispatchEvent(new CustomEvent(eventName, { detail: packageId }));
}

export function useManagedSequenceMetadataRequest(
  packageId: string | undefined,
  open: () => void
): void {
  const callback = useRef(open);
  callback.current = open;
  useEffect(() => {
    if (!packageId) return;
    const deliver = () => {
      if (pending !== packageId) return;
      pending = null;
      callback.current();
    };
    deliver();
    window.addEventListener(eventName, deliver);
    return () => window.removeEventListener(eventName, deliver);
  }, [packageId]);
}
