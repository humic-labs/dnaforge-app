import { useCallback, useRef, useState } from 'react';

export function useDocumentDraft<T extends object>(initial: () => T) {
  const [snapshot, setSnapshot] = useState(() => ({ value: initial(), revision: 0 }));
  const live = useRef(snapshot);
  const read = useCallback(() => live.current, []);
  const edit = useCallback((fields: Partial<T>) => {
    const previous = live.current;
    if (
      Object.entries(fields).every(([key, value]) =>
        Object.is(previous.value[key as keyof T], value)
      )
    )
      return;
    live.current = { value: { ...previous.value, ...fields }, revision: previous.revision + 1 };
    setSnapshot(live.current);
  }, []);
  return { value: snapshot.value, revision: snapshot.revision, read, edit };
}
