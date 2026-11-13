import { z } from 'zod';

export const terminalEmulationSchema = z
  .object({
    unicodeVersion: z.enum(['6', '11']),
    tabStopWidth: z.number().int().min(1).max(32),
  })
  .strict();

export type TerminalEmulation = z.infer<typeof terminalEmulationSchema>;

export const terminalRuntimePolicySchema = z
  .object({
    inheritEnvironment: z.boolean().default(true),
    locale: z.enum(['inherit', 'utf8']).default('inherit'),
    persistSessions: z.boolean().default(true),
    reviveSessions: z.boolean().default(true),
    historyLimit: z.number().int().min(0).max(1000).default(100),
    startupVisibility: z.enum(['remember', 'hidden', 'visible']).default('remember'),
    unicodeVersion: z.enum(['6', '11']).default('11'),
    tabStopWidth: z.number().int().min(1).max(32).default(8),
    confirmBusyClose: z.boolean().default(false),
    notifyNonzeroExit: z.boolean().default(false),
  })
  .strict();

export type TerminalRuntimePolicy = z.infer<typeof terminalRuntimePolicySchema>;
export const DEFAULT_TERMINAL_RUNTIME_POLICY = terminalRuntimePolicySchema.parse({});

export function parseTerminalRuntimePolicy(value: unknown): TerminalRuntimePolicy {
  return terminalRuntimePolicySchema.parse(value);
}

export function terminalEmulation(policy: TerminalEmulation): TerminalEmulation {
  return { unicodeVersion: policy.unicodeVersion, tabStopWidth: policy.tabStopWidth };
}
