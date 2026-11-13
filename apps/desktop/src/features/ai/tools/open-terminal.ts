import { z } from 'zod';
import { platform } from '../../../platform';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import { openTerminalView, TerminalOpeningError } from '../../terminal/public/open-terminal';

export const OPEN_TERMINAL_DESCRIPTION =
  'Open a native integrated terminal. mode tab creates a separate app tab; subtab adds a terminal ' +
  'within its parent app tab; split adds a pane beside the parent terminal. parentSessionId targets ' +
  'an existing terminal using a returned sessionId; omitted means the current terminal. cwd is an ' +
  'optional absolute local directory. Uses the configured default shell and does not execute a command.';

export const openTerminalSchema = z
  .object({
    mode: z
      .enum(['tab', 'subtab', 'split'])
      .default('tab')
      .describe('New app tab, child subtab, or split pane.'),
    parentSessionId: z
      .string()
      .uuid()
      .optional()
      .describe('Existing native terminal session ID. Defaults to the current terminal.'),
    cwd: z
      .string()
      .min(1)
      .max(32768)
      .refine((value) => !value.includes('\0'))
      .optional()
      .describe(
        'Absolute local directory; defaults to the parent directory or the workspace/home.'
      ),
  })
  .strict();

export const openTerminalOutputSchema = z.object({
  ok: z.literal(true),
  sessionId: z.string().uuid(),
  groupId: z.string().min(1),
  viewId: z.string().min(1),
  tabId: z.string().min(1).nullable(),
  title: z.string(),
  cwd: z.string().min(1),
});

export function createOpenTerminalTool() {
  return resultTool({
    description: OPEN_TERMINAL_DESCRIPTION,
    inputSchema: openTerminalSchema,
    execute: async (request) => {
      if (!platform().terminal)
        return toolFailure({
          code: 'TERMINAL_UNAVAILABLE',
          error: 'Native terminals require the desktop app.',
          retriable: false,
          stateChanged: false,
          partialEffects: [],
        });
      try {
        return toolSuccess({ ...(await openTerminalView(request)) });
      } catch (error) {
        const failure = error instanceof TerminalOpeningError ? error : undefined;
        return toolFailure({
          code: failure?.code ?? 'TERMINAL_OPEN_FAILED',
          error: error instanceof Error ? error.message : String(error),
          retriable: failure?.retriable ?? false,
          stateChanged: failure?.stateChanged ?? 'unknown',
          partialEffects: failure?.sessionId ? [{ sessionId: failure.sessionId }] : [],
        });
      }
    },
  });
}
