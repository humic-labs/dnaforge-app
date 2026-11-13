import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type SetStateAction,
} from 'react';

export function useWorkspaceViewerEditMode(
  owner: string,
  initialEditMode: boolean,
  readOnly: boolean,
  editingPending = false,
  savePending = false
) {
  const suspended = editingPending && !savePending;
  const initial = {
    owner,
    active: initialEditMode && !readOnly && !suspended,
    consumed: initialEditMode && !readOnly && !suspended,
  };
  const [state, setState] = useState(initial);
  const authority = useRef({ owner, readOnly, suspended });
  useLayoutEffect(() => {
    authority.current = { owner, readOnly, suspended };
  }, [owner, readOnly, suspended]);
  if (state.owner !== owner) setState(initial);
  useEffect(() => {
    setState((current) => {
      if (current.owner !== owner) return current;
      if (readOnly) return current.active ? { ...current, active: false } : current;
      if (suspended) return current;
      return initialEditMode && !current.consumed
        ? { ...current, active: true, consumed: true }
        : current;
    });
  }, [initialEditMode, owner, readOnly, suspended, state.active]);
  const setIsEditMode = useCallback(
    (value: SetStateAction<boolean>) => {
      setState((current) => {
        if (
          current.owner !== owner ||
          authority.current.owner !== owner ||
          authority.current.readOnly ||
          authority.current.suspended
        )
          return current;
        const active = typeof value === 'function' ? value(current.active) : value;
        return active === current.active ? current : { ...current, active };
      });
    },
    [owner]
  );
  const active = !readOnly && (state.owner === owner ? state.active : initial.active);
  return [active && !suspended, setIsEditMode, active && !editingPending && !savePending] as const;
}
