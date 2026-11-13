import { useEffect } from 'react';
import { useCommandRegistry } from './CommandScopeProvider';
import { COMMAND_SCOPES, type CommandHandler, type CommandId, type CommandScope } from './types';

interface UseCommandHandlerOptions {
  scope?: CommandScope;
  enabled?: () => boolean;
  active?: boolean;
  label?: string;
}

export function useCommandHandler<Payload = unknown>(
  command: CommandId,
  handler: CommandHandler<Payload>,
  options: UseCommandHandlerOptions = {}
): void {
  const { registerHandler } = useCommandRegistry();
  const scope = options.scope ?? COMMAND_SCOPES.appGlobal;
  const active = options.active ?? true;

  useEffect(() => {
    if (!active) return;
    return registerHandler({
      command,
      scope,
      handler,
      enabled: options.enabled,
      label: options.label,
    });
  }, [active, command, handler, options.enabled, options.label, registerHandler, scope]);
}
