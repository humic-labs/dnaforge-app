   
                                                                          
  
                                                                          
                                                                               
                                                                          
                                                                             
                                                                          
                          
   

import { z } from 'zod';
import { platform } from '../../../platform';
import {
  MAX_MCP_HTTP_ALLOWED_HOSTS,
  launcherPlatform,
  normalizeAllowedHost,
  type McpHttpStatus,
} from '../../../shared/mcp-http';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';
import {
  externalMcpClientSnippets,
  externalMcpHttpSnippets,
} from '../../../shared/external-mcp-client-snippets';

export const getExternalAgentAccessSchema = z.object({}).strict();

export const configureExternalAgentAccessSchema = z
  .object({
    urlAccessEnabled: z
      .boolean()
      .optional()
      .describe(
        'Turn the local web address for MCP clients on or off. Off by default. Clients still ' +
          'need an access key that a person creates in Settings.'
      ),
    port: z
      .number()
      .int()
      .min(1024)
      .max(65535)
      .optional()
      .describe('Port of the local web address, http://127.0.0.1:<port>/mcp.'),
    allowedHosts: z
      .array(
        z.string().refine((host) => normalizeAllowedHost(host) !== null, {
          message: 'Use an exact host name with an optional :port, such as laptop.tailnet.ts.net.',
        })
      )
      .max(MAX_MCP_HTTP_ALLOWED_HOSTS)
      .optional()
      .describe(
        'Replaces the list of extra host names accepted besides this computer, for a relay such ' +
          'as `tailscale serve` that forwards to the local address. Exact names, no wildcards.'
      ),
  })
  .strict();

const mcpHttpOutput = z.object({
  enabled: z.boolean(),
  port: z.number().int(),
  allowedHosts: z.array(z.string()),
  state: z.enum(['off', 'listening', 'port-in-use', 'error', 'unavailable']),
  url: z.string().nullable(),
  message: z.string().optional(),
});
const setupSnippetOutput = z.object({
  id: z.string(),
  client: z.string(),
  where: z.string(),
  kind: z.enum(['command', 'json']),
  text: z.string(),
});
export const configureExternalAgentAccessOutputSchema = z.object({
  ok: z.literal(true),
  urlAccess: mcpHttpOutput,
  urlSetup: z.array(setupSnippetOutput),
});
export const externalAgentAccessOutputSchema = z.object({
  ok: z.literal(true),
  registration: z.object({
    state: z.enum(['pending', 'complete', 'failed', 'development-build']),
    launcher: z.string().nullable(),
    clients: z.array(
      z.object({
        client: z.enum(['Claude Code', 'Codex', 'Grok Build', 'Claude Desktop', 'Cursor']),
        status: z.enum([
          'current',
          'registered',
          'repaired',
          'name-conflict',
          'failed',
          'not-installed',
        ]),
      })
    ),
    error: z.string().optional(),
  }),
  urlAccess: mcpHttpOutput,
  localSetup: z.array(setupSnippetOutput),
  urlSetup: z.array(setupSnippetOutput),
  keyNote: z.string(),
});

export type ConfigureExternalAgentAccessInput = z.infer<typeof configureExternalAgentAccessSchema>;

export async function readExternalAgentAccess() {
  const [registration, urlAccess] = await Promise.all([
    platform().agentSdk.getExternalMcpRegistration(),
    platform().agentSdk.getMcpHttpStatus(),
  ]);
  return {
    registration,
    urlAccess,
    localSetup: registration.launcher
      ? externalMcpClientSnippets(registration.launcher, launcherPlatform(registration.launcher))
      : [],
    urlSetup: urlAccess.url ? externalMcpHttpSnippets(urlAccess.url) : [],
    keyNote:
      'Clients using the web address need an access key. A person creates it in Settings → ' +
      'AI → External tool access; agents cannot create keys.',
  };
}

export async function applyExternalAgentAccess(input: ConfigureExternalAgentAccessInput) {
  const current = await platform().agentSdk.getMcpHttpStatus();
  if (current.state === 'unavailable') {
    return toolFailure({
      code: 'URL_ACCESS_UNAVAILABLE',
      error: 'The local web address is available only in the installed DNAForge app.',
      retriable: false,
      stateChanged: false,
      partialEffects: [],
    });
  }
  const next: McpHttpStatus = await platform().agentSdk.setMcpHttp({
    enabled: input.urlAccessEnabled ?? current.enabled,
    port: input.port ?? current.port,
    allowedHosts: (input.allowedHosts ?? current.allowedHosts).map(
      (host) => normalizeAllowedHost(host) as string
    ),
  });
  if (next.state === 'port-in-use' || next.state === 'error') {
    return toolFailure({
      code: next.state === 'port-in-use' ? 'PORT_IN_USE' : 'URL_ACCESS_FAILED',
      error: next.message ?? 'The local web address could not start.',
      retriable: false,
      stateChanged: true,
      partialEffects: ['saved-settings'],
      details: { urlAccess: next },
    });
  }
  return toolSuccess({
    urlAccess: next,
    urlSetup: next.url ? externalMcpHttpSnippets(next.url) : [],
  });
}

export function createGetExternalAgentAccessTool() {
  return resultTool({
    description:
      'Read how outside AI apps connect to DNAForge: whether Claude Code and Codex are ' +
      'registered, whether the optional local web address is on, and copyable setup for ' +
      'other apps.',
    inputSchema: getExternalAgentAccessSchema,
    execute: async () => toolSuccess(await readExternalAgentAccess()),
  });
}

export function createConfigureExternalAgentAccessTool() {
  return resultTool({
    description:
      'Change the optional local web address that MCP clients can use instead of the ' +
      '`dnaforge mcp` command: turn it on or off, set its port, or set extra accepted host names ' +
      'for a relay such as Tailscale. Omitted fields keep their current value. Clients still ' +
      'need an access key that a person creates in Settings.',
    inputSchema: configureExternalAgentAccessSchema,
    execute: applyExternalAgentAccess,
  });
}
