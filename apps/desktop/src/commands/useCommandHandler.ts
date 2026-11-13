import { useEffect } from 'react';
import { useCommandRegistry } from './CommandScopeProvider';
import { COMMAND_SCOPES, type CommandHandler, type CommandId, type CommandScope } from './types';
import { usePresentationScope } from '../presentation/PresentationSurface';

interface UseCommandHandlerOptions {
  scope?: CommandScope;
  enabled?: () => boolean;
  active?: boolean;
  label?: string;
  surfaceId?: string;
}

export function useCommandHandler<Payload = unknown>(
  command: CommandId,
  handler: CommandHandler<Payload>,
  options: UseCommandHandlerOptions = {}
): void {
  const { registerHandler } = useCommandRegistry();
  const presentation = usePresentationScope();
  const surfaceId = options.surfaceId ?? presentation.id;
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
      surfaceId,
    });
  }, [active, command, handler, options.enabled, options.label, registerHandler, scope, surfaceId]);
}
