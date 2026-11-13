import type { StateCreator, StoreApi } from 'zustand';

interface RevisionState {
  revision: number;
}

type ZustandSet<T> = (
  partial:
    | T
    | Partial<T>
    | ((state: T) => T | Partial<T>)
    | ((state: T) => T | Partial<T> | undefined),
  replace?: boolean | undefined
) => void;

function isFunctionPartial<T>(
  partial: unknown
): partial is (state: T) => T | Partial<T> | undefined {
  return typeof partial === 'function';
}

export function withRevision<T extends RevisionState>(
  initializer: StateCreator<T, [], []>
): StateCreator<T, [], []> {
  return (set, get, api) => {
    const wrappedSet: ZustandSet<T> = (partial, replace) => {
      if (replace === true) {
        (set as ZustandSet<T>)(partial, replace);
        return;
      }
      if (isFunctionPartial<T>(partial)) {
        (set as ZustandSet<T>)((state) => {
          const result = partial(state);
          if (result === undefined) return undefined;
          if ((result as unknown) === (state as unknown)) {
            return result;
          }
          return { ...result, revision: state.revision + 1 } as T | Partial<T>;
        }, replace);
        return;
      }
      const before = get();
      (set as ZustandSet<T>)(
        { ...(partial as Partial<T>), revision: before.revision + 1 } as T | Partial<T>,
        replace
      );
    };

    const originalApiSetState = api.setState;
    (api as StoreApi<T>).setState = ((partial, replace) => {
      if (replace === true) {
        originalApiSetState(partial, replace as never);
        return;
      }
      if (isFunctionPartial<T>(partial)) {
        originalApiSetState((state) => {
          const result = partial(state);
          if (result === undefined) return result as Partial<T>;
          if ((result as unknown) === (state as unknown)) return result;
          return { ...result, revision: state.revision + 1 } as T | Partial<T>;
        }, replace as never);
        return;
      }
      const before = get();
      originalApiSetState(
        { ...(partial as Partial<T>), revision: before.revision + 1 } as T | Partial<T>,
        replace as never
      );
    }) as StoreApi<T>['setState'];

    return initializer(wrappedSet as Parameters<typeof initializer>[0], get, api);
  };
}
