import { useCallback, useEffect, useId, useMemo } from 'react';
import { useCommandRegistry } from './CommandScopeProvider';
import type { CommandScope, CommandScopeHandle } from './types';
import { usePresentationScope } from '../presentation/PresentationSurface';

interface UseCommandScopeOptions {
  claimOnMount?: boolean;
  enabled?: boolean;
}

export function useCommandScope(
  scope: CommandScope,
  options: UseCommandScopeOptions = {}
): CommandScopeHandle {
  const { claimScope, releaseScope } = useCommandRegistry();
  const presentation = usePresentationScope();
  const ownerId = useId();
  const enabled = options.enabled ?? true;

  const claim = useCallback(() => {
    if (!enabled) return;
    claimScope(scope, ownerId, presentation.id);
  }, [claimScope, enabled, ownerId, scope, presentation.id]);

  const release = useCallback(() => {
    releaseScope(scope, ownerId);
  }, [ownerId, releaseScope, scope]);

  useEffect(() => {
    if (!enabled) {
      release();
      return;
    }
    if (options.claimOnMount) {
      claim();
    }
    return release;
  }, [claim, enabled, options.claimOnMount, release]);

  const eventHandlers = useMemo(
    () => ({
      onFocusCapture: claim,
      onMouseDownCapture: claim,
    }),
    [claim]
  );

  return { claim, release, eventHandlers };
}
