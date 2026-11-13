import { useEffect, useRef } from 'react';

export const MANAGED_SEQUENCE_RENAME_EVENT = 'waypoint:rename-managed-sequence';

export interface ManagedSequenceRenameRequest {
  packageId: string;
  requestId: number;
}

let pending: ManagedSequenceRenameRequest | null = null;
let nextRequestId = 1;
const consumedNameEditRequestIds = new Set<number>();

export function requestManagedSequenceRename(packageId: string): ManagedSequenceRenameRequest {
  const request = { packageId, requestId: nextRequestId++ };
  pending = request;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(MANAGED_SEQUENCE_RENAME_EVENT, { detail: request }));
  }
  return request;
}

export function peekManagedSequenceRename(packageId: string): ManagedSequenceRenameRequest | null {
  if (!pending || pending.packageId !== packageId) return null;
  return pending;
}

export function acknowledgeManagedSequenceRename(packageId: string, requestId: number): void {
  if (pending?.packageId === packageId && pending.requestId === requestId) {
    pending = null;
  }
}

export function consumeManagedSequenceNameEdit(requestId: number): boolean {
  if (!requestId || consumedNameEditRequestIds.has(requestId)) return false;
  consumedNameEditRequestIds.add(requestId);
  return true;
}

export function clearManagedSequenceRenameRequest(): void {
  pending = null;
  consumedNameEditRequestIds.clear();
}

export function useManagedSequenceRenameRequest(
  packageId: string | undefined,
  onRename: (requestId: number) => void
): void {
  const onRenameRef = useRef(onRename);
  onRenameRef.current = onRename;

  useEffect(() => {
    if (!packageId) return;

    const deliver = (request: ManagedSequenceRenameRequest | null | undefined) => {
      if (!request || request.packageId !== packageId) return;
      onRenameRef.current(request.requestId);
    };

    deliver(peekManagedSequenceRename(packageId));

    const onRequest = (event: Event) => {
      deliver((event as CustomEvent<ManagedSequenceRenameRequest>).detail);
    };

    window.addEventListener(MANAGED_SEQUENCE_RENAME_EVENT, onRequest);
    return () => window.removeEventListener(MANAGED_SEQUENCE_RENAME_EVENT, onRequest);
  }, [packageId]);
}
