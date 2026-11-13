import { z } from 'zod';
import { platform } from '../../../platform';
import { isRemoteSshTarget } from '../../../shared/remote-ssh-target';
import { resultTool, toolFailure, toolSuccess } from '../../agent-bridge/public/tool-result';

const target = z
  .string()
  .trim()
  .refine(isRemoteSshTarget, 'Use an SSH alias or user@host without options.');
export const getRemoteHostsSchema = z
  .object({
    target: target
      .optional()
      .describe(
        'When supplied, explicitly check this saved host using an existing connection. Omit to read cached host observations only.'
      ),
  })
  .strict();
export const manageRemoteHostSchema = z
  .object({
    action: z.enum(['save', 'rename', 'forget', 'sign_in', 'open_terminal', 'end_connection']),
    target: target.optional(),
    endpointId: z.string().trim().min(1).max(200).optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const GET_REMOTE_HOSTS_DESCRIPTION =
  'List saved SSH hosts and their last observed access, or explicitly check one saved target using an existing connection. No new authentication, MFA prompt, file browsing or computation is started. Report checkedAt and state honestly; saved metadata is not authenticated access.';
export const MANAGE_REMOTE_HOST_DESCRIPTION =
  'Manage the same Remote hosts used by the person: save target/displayName before login; rename endpointId/displayName; forget endpointId metadata; sign_in or open_terminal for a target; end_connection for a target. Only request sign_in/open_terminal when the user asks to authenticate or open a terminal. Institution-supported authentication happens in the real Terminal; ask the person to complete it there and then check access. Never request, accept or store a password or MFA code. A sign-in request is not proof of access. Forget preserves tracks and active sessions; ending a connection preserves external masters and refuses active data consumers.';

const remoteFailureSchema = z.object({ code: z.string(), message: z.string() });
const remoteAccessOutput = z.object({
  target: z.string(),
  state: z.enum(['not-checked', 'signing-in', 'verified', 'needs-authentication', 'unavailable']),
  checkedAt: z.number().nullable(),
  connection: z.enum(['none', 'dnaforge', 'external']),
  activeConsumers: z.number().int().nonnegative(),
  lastFailure: remoteFailureSchema.nullable(),
});
const remoteHostOutput = z.object({
  profile: z.object({
    endpointId: z.string(),
    displayName: z.string(),
    target: z.string(),
    lastConnectedAt: z.number().nullable(),
    observedPlatform: z.string().nullable(),
    lastFailure: remoteFailureSchema.nullable(),
  }),
  access: remoteAccessOutput,
});
export const getRemoteHostsOutputSchema = z.union([
  z.object({ ok: z.literal(true), hosts: z.array(remoteHostOutput) }),
  z.object({ ok: z.literal(true), access: remoteAccessOutput }),
]);
export const manageRemoteHostOutputSchema = z.union([
  z.object({ ok: z.literal(true), host: remoteHostOutput.nullable() }),
  z.object({ ok: z.literal(true), forgotten: z.boolean() }),
  z.object({
    ok: z.literal(true),
    access: remoteAccessOutput,
    requiresUserAuthentication: z.boolean().optional(),
    nextStep: z.string().optional(),
  }),
  z.object({ ok: z.literal(true), terminalRequested: z.boolean(), nextStep: z.string() }),
]);

const failure = (error: unknown, mutation: boolean) =>
  toolFailure({
    code: 'REMOTE_HOST_OPERATION_FAILED',
    error: error instanceof Error ? error.message : String(error),
    retriable: false,
    stateChanged: mutation ? 'unknown' : false,
    partialEffects: [],
  });

export function createGetRemoteHostsTool() {
  return resultTool({
    description: GET_REMOTE_HOSTS_DESCRIPTION,
    inputSchema: getRemoteHostsSchema,
    execute: async (input) => {
      const api = platform().remoteHosts;
      if (!api) return failure(new Error('Remote hosts require the DNAForge desktop app.'), false);
      try {
        if (input.target) return toolSuccess({ access: await api.checkAccess(input.target) });
        return toolSuccess({ hosts: await api.list() });
      } catch (error) {
        return failure(error, false);
      }
    },
  });
}

export function createManageRemoteHostTool() {
  return resultTool({
    description: MANAGE_REMOTE_HOST_DESCRIPTION,
    inputSchema: manageRemoteHostSchema,
    execute: async (input) => {
      const api = platform().remoteHosts;
      if (!api) return failure(new Error('Remote hosts require the DNAForge desktop app.'), false);
      const metadataAction = input.action === 'rename' || input.action === 'forget';
      if (
        (metadataAction ? !input.endpointId : !input.target) ||
        (input.action === 'rename' && !input.displayName)
      ) {
        return toolFailure({
          code: 'INVALID_REQUEST',
          error: metadataAction
            ? 'Supply endpointId and, for rename, displayName.'
            : 'Supply the SSH target.',
          retriable: false,
          stateChanged: false,
          partialEffects: [],
        });
      }
      try {
        switch (input.action) {
          case 'save':
            return toolSuccess({
              host: await api.save({
                target: input.target!,
                displayName: input.displayName ?? input.target!,
              }),
            });
          case 'rename':
            return toolSuccess({ host: await api.rename(input.endpointId!, input.displayName!) });
          case 'forget':
            return toolSuccess({ forgotten: await api.forget(input.endpointId!) });
          case 'sign_in': {
            const access = await api.signIn(input.target!);
            return toolSuccess({
              access,
              requiresUserAuthentication: access.state !== 'verified',
              nextStep:
                access.state === 'verified'
                  ? 'Use the observed access timestamp.'
                  : 'Complete your institution’s login in Terminal, then check access in Remote hosts.',
            });
          }
          case 'open_terminal':
            await api.openTerminal(input.target!);
            return toolSuccess({
              terminalRequested: true,
              nextStep:
                'Continue in Terminal. Check access separately before reporting a verified connection.',
            });
          case 'end_connection':
            return toolSuccess({ access: await api.endConnection(input.target!) });
        }
      } catch (error) {
        return failure(error, true);
      }
    },
  });
}
