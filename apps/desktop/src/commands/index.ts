export {
  assertUniqueCommandDefinitions,
  getHighestActiveBlockingScope,
  getHighestActiveFocusScope,
  isCommandBlockedByScope,
  isEditableCommandTarget,
  matchesCommandBinding,
  resolveCommandHandler,
} from './commandRegistry';
export {
  CommandScopeProvider,
  CommandScopeProviderForTest,
  useCommandRegistry,
} from './CommandScopeProvider';
export { DEFAULT_COMMAND_BINDINGS } from './defaultBindings';
export { useCommandHandler } from './useCommandHandler';
export { useCommandScope } from './useCommandScope';
export {
  BLOCKING_COMMAND_SCOPES,
  COMMAND_IDS,
  COMMAND_SCOPES,
  COMMAND_SCOPE_PRIORITY,
  FOCUS_COMMAND_SCOPES,
  type CommandBinding,
  type CommandContext,
  type CommandDefinition,
  type CommandDispatchResult,
  type CommandHandler,
  type CommandHandlerRegistration,
  type CommandId,
  type CommandRegistryContextValue,
  type CommandScope,
  type CommandScopeHandle,
  type CommandSystemDebugState,
} from './types';
