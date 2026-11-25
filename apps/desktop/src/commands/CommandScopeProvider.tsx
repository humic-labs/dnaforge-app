import { CHAT_FIRST_INPUT, chatFirstCommandAllowed, isManualInput } from '../lib/chat-first-input';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { DEFAULT_COMMAND_BINDINGS } from './defaultBindings';
import { registerMountedCommandRegistry } from './mounted-command-registry';
import { presentationAllows, presentationOwner } from '../presentation/ownership';
import {
  createCommandResult,
  isCommandBlockedByScope,
  isEditableCommandTarget,
  keyboardCommandBelongsToTarget,
  matchesCommandBinding,
  resolveCommandHandler,
} from './commandRegistry';
import {
  DOCUMENT_COMMAND_SCOPES,
  FOCUS_COMMAND_SCOPES,
  COMMAND_SCOPES,
  type CommandContext,
  type CommandDispatchResult,
  type CommandHandlerRegistration,
  type CommandId,
  type CommandRegistryContextValue,
  type CommandScope,
  type CommandScopeProviderProps,
  type CommandSystemDebugState,
} from './types';

const CommandRegistryContext = createContext<CommandRegistryContextValue | null>(null);
let commandRegistrationCounter = 0;

const NOOP_COMMAND_REGISTRY: CommandRegistryContextValue = {
  dispatchCommand: (command) => ({ command, handled: false, blocked: false, scope: null }),
  registerHandler: () => () => undefined,
  claimScope: () => undefined,
  releaseScope: () => undefined,
  getDebugState: () => ({ activeScopes: [], lastCommand: null }),
};

export function useCommandRegistry(): CommandRegistryContextValue {
  const value = useContext(CommandRegistryContext);
  return value ?? NOOP_COMMAND_REGISTRY;
}

function debugWindowEnabled(): boolean {
  return import.meta.env.DEV === true || import.meta.env.MODE === 'test';
}

type CommandDebugWindow = Window & {
  __waypointCommandDebug?: () => CommandSystemDebugState;
};

function commandDebugWindow(): CommandDebugWindow {
  return window as CommandDebugWindow;
}

function publishDebugState(getDebugState: () => CommandSystemDebugState): void {
  if (!debugWindowEnabled()) return;
  commandDebugWindow().__waypointCommandDebug = getDebugState;
}

export function CommandScopeProvider({ children }: CommandScopeProviderProps) {
  const handlersRef = useRef(new Map<string, CommandHandlerRegistration>());
  const scopeClaimsRef = useRef(new Map<CommandScope, Map<string, string>>());
  const lastCommandRef = useRef<CommandDispatchResult | null>(null);
  const keyboardListenerAttachedRef = useRef(false);
  const keyboardEventCountRef = useRef(0);
  const lastKeyboardEventRef = useRef<CommandSystemDebugState['lastKeyboardEvent']>(null);

  const getActiveScopes = useCallback((event?: KeyboardEvent): Set<CommandScope> => {
    const active = new Set<CommandScope>([COMMAND_SCOPES.appGlobal]);

    const presentation = presentationOwner.getSnapshot(event);
    for (const id of presentation.overlays) {
      if (!presentationAllows(presentation, id, 'presentation')) continue;
      active.add(
        presentation.surfaces[id].capture === 'modal'
          ? COMMAND_SCOPES.modal
          : COMMAND_SCOPES.menuContext
      );
    }
    for (const [scope, owners] of scopeClaimsRef.current) {
      if ([...owners.values()].some((id) => presentationAllows(presentation, id, 'keyboard')))
        active.add(scope);
    }
    return active;
  }, []);

  const getDebugState = useCallback(
    (): CommandSystemDebugState => ({
      activeScopes: Array.from(getActiveScopes()),
      lastCommand: lastCommandRef.current,
      keyboardListenerAttached: keyboardListenerAttachedRef.current,
      keyboardEventCount: keyboardEventCountRef.current,
      lastKeyboardEvent: lastKeyboardEventRef.current,
    }),
    [getActiveScopes]
  );

  const claimScope = useCallback((scope: CommandScope, ownerId: string, surfaceId = 'window') => {
    if (FOCUS_COMMAND_SCOPES.has(scope) && presentationOwner.allows(surfaceId, 'keyboard')) {
      for (const claimedScope of scopeClaimsRef.current.keys()) {
        if (claimedScope === scope || !FOCUS_COMMAND_SCOPES.has(claimedScope)) continue;
        if (DOCUMENT_COMMAND_SCOPES.has(claimedScope) && !DOCUMENT_COMMAND_SCOPES.has(scope))
          continue;
        scopeClaimsRef.current.delete(claimedScope);
      }
    }

    const owners = scopeClaimsRef.current.get(scope) ?? new Map<string, string>();
    owners.set(ownerId, surfaceId);
    scopeClaimsRef.current.set(scope, owners);
  }, []);

  const releaseScope = useCallback((scope: CommandScope, ownerId: string) => {
    const owners = scopeClaimsRef.current.get(scope);
    if (!owners) return;
    owners.delete(ownerId);
    if (owners.size === 0) {
      scopeClaimsRef.current.delete(scope);
    }
  }, []);

  const registerHandler = useCallback(
    <Payload,>(registration: CommandHandlerRegistration<Payload>) => {
      commandRegistrationCounter += 1;
      const key = `${registration.command}:${registration.scope}:${commandRegistrationCounter}`;
      handlersRef.current.set(key, registration as CommandHandlerRegistration);
      return () => {
        handlersRef.current.delete(key);
      };
    },
    []
  );

  const dispatchCommand = useCallback(
    <Payload,>(
      command: CommandId,
      context: Partial<CommandContext<Payload>> = {}
    ): CommandDispatchResult => {
      const source = context.source ?? 'ui';
      if (
        CHAT_FIRST_INPUT &&
        !chatFirstCommandAllowed(
          command,
          source,
          isManualInput(context.event?.target ?? document.activeElement)
        )
      ) {
        const result = createCommandResult(command, null, false, true);
        lastCommandRef.current = result;
        return result;
      }
      const event = source === 'keyboard' ? context.event : undefined;
      const activeScopes = getActiveScopes(event);
      const registrations = Array.from(handlersRef.current.values()).filter((registration) =>
        event
          ? presentationOwner.allowsEvent(registration.surfaceId ?? 'window', 'keyboard', event)
          : presentationOwner.allows(
              registration.surfaceId ?? 'window',
              source === 'ui' ? 'presentation' : 'keyboard'
            )
      );
      const handler = resolveCommandHandler(command, registrations, activeScopes);
      const bypassBlockingScopes = new Set(context.bypassBlockingScopes ?? []);
      const blocked =
        source === 'keyboard' || source === 'electron-menu' || source === 'agent'
          ? isCommandBlockedByScope(handler, activeScopes, bypassBlockingScopes)
          : false;

      if (blocked || !handler) {
        const result = createCommandResult(command, handler, false, blocked);
        lastCommandRef.current = result;
        return result;
      }

      const handledResult = handler.handler({
        command,
        source,
        event: context.event,
        payload: context.payload,
      });
      const result = createCommandResult(command, handler, handledResult !== false, false);
      lastCommandRef.current = result;
      return result;
    },
    [getActiveScopes]
  );

  useEffect(() => {
    publishDebugState(getDebugState);
    return () => {
      if (debugWindowEnabled()) {
        delete commandDebugWindow().__waypointCommandDebug;
      }
    };
  }, [getDebugState]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      keyboardEventCountRef.current += 1;
      lastKeyboardEventRef.current = {
        key: event.key,
        code: event.code,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        target:
          event.target instanceof HTMLElement
            ? (event.target.getAttribute('data-testid') ?? event.target.tagName)
            : null,
        matchedCommand: null,
      };
      for (const binding of DEFAULT_COMMAND_BINDINGS) {
        if (!matchesCommandBinding(event, binding)) continue;

        if (keyboardCommandBelongsToTarget(event, binding.command, true)) return;
        lastKeyboardEventRef.current = {
          ...lastKeyboardEventRef.current,
          matchedCommand: binding.command,
        };
        if (!binding.allowInInput && isEditableCommandTarget(event.target)) return;
        const result = dispatchCommand(binding.command, {
          source: 'keyboard',
          event,
          bypassBlockingScopes: binding.allowInInput ? [COMMAND_SCOPES.inputEditor] : undefined,
        });

        if (result.handled || result.blocked) {
          if (binding.preventDefault !== false) {
            event.preventDefault();
          }
          return;
        }
      }
    };

    keyboardListenerAttachedRef.current = true;
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      keyboardListenerAttachedRef.current = false;
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [dispatchCommand]);

  const value = useMemo<CommandRegistryContextValue>(
    () => ({
      dispatchCommand,
      registerHandler,
      claimScope,
      releaseScope,
      getDebugState,
    }),
    [claimScope, dispatchCommand, getDebugState, registerHandler, releaseScope]
  );

  useEffect(() => registerMountedCommandRegistry(value), [value]);

  return (
    <CommandRegistryContext.Provider value={value}>{children}</CommandRegistryContext.Provider>
  );
}

export function CommandScopeProviderForTest({ children }: { children: ReactNode }) {
  return <CommandScopeProvider>{children}</CommandScopeProvider>;
}
