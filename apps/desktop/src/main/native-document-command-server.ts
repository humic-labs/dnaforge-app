import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import type { NativeAnnotationDocumentOwner } from './native-annotation-document-owner';
import { fileDocumentAgentRequestSchema } from '../shared/file-document';
import type { NativeDocumentDispatcher } from './native-document-dispatcher';
import { NativeDocumentCommandError } from '../shared/native-document-error';
import {
  sequenceDocumentAgentRequestSchema,
  sequenceDocumentAgentResult,
} from '../shared/sequence-document';
import type { NativeSequenceWorkingCopyOwner } from './native-sequence-working-copy';
import { notebookDocumentSchema } from '../shared/notebook-document';
import type { NativeNotebookWorkingCopyOwner } from './notebook-document-owner';
import { workspaceSearchSchema } from '../shared/workspace-search-owner';
import { projectHistoryAgentRequestSchema } from '../shared/project-history';
import { importReviewSchema } from '../shared/import-review-command';
import { administrationAgentOperationSchema } from '../shared/administration';
import type { createNativeWorkspaceCommands } from './native-workspace-commands';
import type { NativeImportReviews } from './native-import-reviews';
import type { AdministrationOwner } from './administration-owner';
import { agentProjectScopeSchema } from '../shared/agent-project-scope';
import {
  inventoryExecuteRequestSchema,
  inventoryCatalogQuerySchema,
  inventoryCatalogUpdatePreviewRequestSchema,
  inventoryHistoryRequestSchema,
  inventoryMaterialQuerySchema,
  inventoryOperationRequestSchema,
  inventoryReadRequestSchema,
} from '../shared/inventory-command';
import type { createNativeInventoryOwner } from './inventory-owner';
import { hasRequiredCapabilities } from '../shared/capability-policy';
import type { NativeAgentAuthority } from './agent-grant-authority';
import {
  withAgentProjectScope,
  type RegisteredProjectAuthority,
} from './registered-project-authority';

const MAX_BODY_BYTES = 17 * 1024 * 1024;
const identity = z.string().min(1).max(128);
const agentAuthoritySchema = z
  .object({
    identityId: z.string().min(1).max(500),
    capabilities: z.array(z.string().min(1).max(200)).max(64),
  })
  .strict();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const target = z
  .object({
    operationId: z.string().min(1).max(256),
    targetDocumentId: z.string().min(1).max(1024),
  })
  .strict();
const selection = target
  .extend({
    expectedOperationVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    expectedResultSha256: digest,
    expectedTargetDocumentRevision: z
      .string()
      .regex(/^annotation-document-v1:sha256:[a-f0-9]{64}$/),
    selectedCandidateIds: z
      .array(z.string().min(1).max(512))
      .min(1)
      .max(10_000)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
const commandSchema = z.discriminatedUnion('command', [
  z
    .object({
      ownerInstanceId: identity,
      projectScope: agentProjectScopeSchema,
      command: z.literal('inventory.execute'),
      request: inventoryExecuteRequestSchema,
      agent: agentAuthoritySchema.optional(),
    })
    .strict(),
  z
    .object({
      ownerInstanceId: identity,
      projectScope: agentProjectScopeSchema,
      command: z.literal('inventory.inspect'),
      request: inventoryReadRequestSchema,
      agent: agentAuthoritySchema.optional(),
    })
    .strict(),
  z
    .object({
      ownerInstanceId: identity,
      projectScope: agentProjectScopeSchema,
      command: z.literal('inventory.availability'),
      request: inventoryReadRequestSchema,
      agent: agentAuthoritySchema.optional(),
    })
    .strict(),
  z
    .object({
      ownerInstanceId: identity,
      projectScope: agentProjectScopeSchema,
      command: z.literal('inventory.operation'),
      request: inventoryOperationRequestSchema,
      agent: agentAuthoritySchema.optional(),
    })
    .strict(),
  z
    .object({
      ownerInstanceId: identity,
      projectScope: agentProjectScopeSchema,
      command: z.literal('inventory.history'),
      request: inventoryHistoryRequestSchema,
      agent: agentAuthoritySchema.optional(),
    })
    .strict(),
  z
    .object({
      ownerInstanceId: identity,
      projectScope: agentProjectScopeSchema,
      command: z.literal('inventory.projects'),
      request: z.object({}).strict(),
      agent: agentAuthoritySchema.optional(),
    })
    .strict(),
  z
    .object({
      ownerInstanceId: identity,
      projectScope: agentProjectScopeSchema,
      command: z.literal('inventory.materials'),
      request: inventoryMaterialQuerySchema,
      agent: agentAuthoritySchema.optional(),
    })
    .strict(),
  z
    .object({
      ownerInstanceId: identity,
      projectScope: agentProjectScopeSchema,
      command: z.literal('inventory.catalog'),
      request: inventoryCatalogQuerySchema,
      agent: agentAuthoritySchema.optional(),
    })
    .strict(),
  z
    .object({
      ownerInstanceId: identity,
      projectScope: agentProjectScopeSchema,
      command: z.literal('inventory.catalog-update-preview'),
      request: inventoryCatalogUpdatePreviewRequestSchema,
      agent: agentAuthoritySchema.optional(),
    })
    .strict(),
  z
    .object({
      ownerInstanceId: identity,
      projectScope: agentProjectScopeSchema,
      command: z.literal('project-scope.inspect'),
    })
    .strict(),
  z
    .object({
      ownerInstanceId: identity,
      projectScope: agentProjectScopeSchema,
      command: z.literal('notebook.execute'),
      request: notebookDocumentSchema,
    })
    .strict(),
  z
    .object({
      ownerInstanceId: identity,
      projectScope: agentProjectScopeSchema,
      command: z.literal('workspace.search'),
      request: workspaceSearchSchema,
    })
    .strict(),
  z
    .object({
      ownerInstanceId: identity,
      projectScope: agentProjectScopeSchema,
      command: z.literal('project-history.execute'),
      request: projectHistoryAgentRequestSchema,
    })
    .strict(),
  z
    .object({
      ownerInstanceId: identity,
      projectScope: agentProjectScopeSchema,
      command: z.literal('import-review.execute'),
      request: importReviewSchema,
      agent: agentAuthoritySchema,
    })
    .strict(),
  z
    .object({
      ownerInstanceId: identity,
      projectScope: agentProjectScopeSchema,
      command: z.literal('administration.execute'),
      request: z.object({ operation: administrationAgentOperationSchema }).strict(),
      agent: agentAuthoritySchema,
    })
    .strict(),
  z
    .object({
      ownerInstanceId: identity,
      projectScope: agentProjectScopeSchema,
      command: z.literal('file.execute'),
      request: fileDocumentAgentRequestSchema,
      agent: agentAuthoritySchema,
    })
    .strict(),
  z
    .object({
      ownerInstanceId: identity,
      projectScope: agentProjectScopeSchema,
      command: z.literal('sequence.execute'),
      request: sequenceDocumentAgentRequestSchema,
    })
    .strict(),
  z
    .object({
      ownerInstanceId: identity,
      projectScope: agentProjectScopeSchema,
      command: z.literal('annotation.inspect'),
      target,
      authority: z.unknown(),
    })
    .strict(),
  z
    .object({
      ownerInstanceId: identity,
      projectScope: agentProjectScopeSchema,
      command: z.literal('annotation.apply'),
      request: z.object({ actionId: identity, requestSha256: digest, selection }).strict(),
    })
    .strict(),
]);

interface NativeCommandReceiver {
  inspect(...args: Parameters<NativeAnnotationDocumentOwner['inspect']>): Promise<unknown>;
  apply(...args: Parameters<NativeAnnotationDocumentOwner['apply']>): Promise<unknown>;
  close(): Promise<void>;
}

interface NativeCommandAuthority {
  readonly token: string;
  readonly ownerInstanceId: string;
}

export async function startNativeDocumentCommandServer(options: {
  owner: NativeCommandReceiver;
  projectAuthority?: RegisteredProjectAuthority;
  fileOwner?: Pick<NativeDocumentDispatcher, 'executeAgent'>;
  sequenceOwner?: Pick<NativeSequenceWorkingCopyOwner, 'execute'>;
  notebookOwner?: Pick<NativeNotebookWorkingCopyOwner, 'executePublic'>;
  flushFileClients?(): Promise<void>;
  workspaceCommands?: Pick<ReturnType<typeof createNativeWorkspaceCommands>, 'search' | 'history'>;
  importReviews?: Pick<NativeImportReviews, 'executeAgent'>;
  administration?: Pick<AdministrationOwner, 'execute'>;
  inventory?: Pick<
    ReturnType<typeof createNativeInventoryOwner>,
    | 'execute'
    | 'inspect'
    | 'availability'
    | 'operation'
    | 'history'
    | 'projects'
    | 'materials'
    | 'catalog'
    | 'catalogUpdatePreview'
  >;
  authorizeInventoryAgent?(agent: NativeAgentAuthority, required: readonly string[]): Promise<void>;
  getAuthority(): NativeCommandAuthority | null;
}): Promise<{ url: string; close(): Promise<void> }> {
  let closing = false;
  let closed: Promise<void> | undefined;
  const server = createServer(
    { requestTimeout: 10_000, headersTimeout: 5_000, connectionsCheckingInterval: 1_000 },
    (req, res) => {
      void handle(req, res).catch(() => {
        if (!res.headersSent) failure(res, 500, 'NATIVE_DOCUMENT_OUTCOME_UNCONFIRMED', true);
        else res.destroy();
      });
    }
  );
  server.setTimeout(30_000, (socket) => socket.destroy());
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || req.url !== '/internal/native-documents/call') {
      failure(res, 404, 'NATIVE_DOCUMENT_ENDPOINT_UNAVAILABLE', false);
      return;
    }
    const available = options.getAuthority();
    if (closing || !available) {
      failure(res, 503, 'NATIVE_DOCUMENT_OWNER_UNAVAILABLE', false);
      return;
    }
    const authority = { ...available };
    const credential = nativeCredential(req);
    if (
      req.headers.origin !== undefined ||
      !credential ||
      !sameToken(credential, authority.token)
    ) {
      failure(res, 403, 'NATIVE_DOCUMENT_AUTHORITY_REQUIRED', false);
      return;
    }
    let body: z.infer<typeof commandSchema>;
    try {
      body = commandSchema.parse(await readBody(req));
    } catch (error) {
      failure(
        res,
        error instanceof BodyLimitError ? 413 : 400,
        'INVALID_NATIVE_DOCUMENT_REQUEST',
        false
      );
      return;
    }
    const current = options.getAuthority();
    if (
      closing ||
      !current ||
      body.ownerInstanceId !== authority.ownerInstanceId ||
      current.ownerInstanceId !== authority.ownerInstanceId ||
      !sameToken(current.token, authority.token)
    ) {
      failure(res, 409, 'NATIVE_DOCUMENT_OWNER_CHANGED', false);
      return;
    }
    let accepted = false;
    try {
      await withAgentProjectScope(body.projectScope, async () => {
        const assertCurrent = () => {
          const current = options.getAuthority();
          if (
            closing ||
            !current ||
            current.ownerInstanceId !== authority.ownerInstanceId ||
            !sameToken(current.token, authority.token)
          )
            throw new Error('NATIVE_DOCUMENT_OWNER_CHANGED');
        };
        if (body.command === 'project-scope.inspect') {
          if (!options.projectAuthority) {
            failure(res, 503, 'NATIVE_DOCUMENT_OWNER_UNAVAILABLE', false);
            return;
          }
          assertCurrent();
          const roots = options.projectAuthority.list().map((project) => project.path);
          json(res, 200, {
            ok: true,
            ownerInstanceId: authority.ownerInstanceId,
            result: { roots },
          });
          return;
        }
        if (
          body.command === 'workspace.search' ||
          body.command === 'project-history.execute' ||
          body.command === 'import-review.execute' ||
          body.command === 'administration.execute' ||
          body.command === 'inventory.execute' ||
          body.command === 'inventory.inspect' ||
          body.command === 'inventory.availability' ||
          body.command === 'inventory.operation' ||
          body.command === 'inventory.history' ||
          body.command === 'inventory.projects' ||
          body.command === 'inventory.catalog' ||
          body.command === 'inventory.catalog-update-preview' ||
          body.command === 'inventory.materials'
        ) {
          if (
            options.inventory &&
            body.command.startsWith('inventory.') &&
            'agent' in body &&
            body.agent
          ) {
            const required =
              body.command === 'inventory.execute'
                ? ['read-workspace', 'write-workspace']
                : ['read-workspace'];
            if (!hasRequiredCapabilities(body.agent.capabilities, required))
              throw new NativeDocumentCommandError(
                'INSUFFICIENT_SCOPE',
                'The current grant does not permit this inventory operation.',
                false
              );
            if (!options.authorizeInventoryAgent)
              throw new NativeDocumentCommandError(
                'INVENTORY_CAPABILITY_DENIED',
                'Current inventory agent access could not be verified.',
                false
              );
            try {
              await options.authorizeInventoryAgent(body.agent, required);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              throw new NativeDocumentCommandError(
                message.match(/^(INVENTORY_(?:CAPABILITY_DENIED|GRANTS_UNAVAILABLE)):/)?.[1] ??
                  'INVENTORY_CAPABILITY_DENIED',
                message,
                false
              );
            }
            assertCurrent();
          }
          const run = (() => {
            if (options.inventory) {
              const receiver = options.inventory;
              if (body.command === 'inventory.projects')
                return () => ({ kind: 'projects', projects: receiver.projects() });
              if (body.command === 'inventory.catalog') {
                const request = body.request;
                return () => ({ kind: 'catalog', entries: receiver.catalog(request) });
              }
              if (body.command === 'inventory.catalog-update-preview') {
                const request = body.request;
                return () => ({
                  kind: 'catalog-update-preview',
                  preview: receiver.catalogUpdatePreview(request),
                });
              }
              if (body.command === 'inventory.materials') {
                const request = body.request;
                return () => ({ kind: 'materials', page: receiver.materials(request) });
              }
              if (body.command === 'inventory.execute') {
                const request = body.request;
                const invocation = body.agent
                  ? {
                      actor: `agent:${body.agent.identityId}`,
                      principal: { kind: 'agent' as const, identityId: body.agent.identityId },
                    }
                  : undefined;
                return () => ({
                  kind: 'execution',
                  execution: receiver.execute(request, assertCurrent, invocation),
                });
              }
              if (body.command === 'inventory.inspect') {
                const request = body.request;
                return () => ({ kind: 'inspection', state: receiver.inspect(request) });
              }
              if (body.command === 'inventory.availability') {
                const request = body.request;
                const invocation = body.agent
                  ? { principal: { kind: 'agent' as const, identityId: body.agent.identityId } }
                  : undefined;
                return () => ({
                  kind: 'availability',
                  availability: receiver.availability(request, invocation),
                });
              }
              if (body.command === 'inventory.operation') {
                const request = body.request;
                return () => ({ kind: 'operation', receipt: receiver.operation(request) });
              }
              if (body.command === 'inventory.history') {
                const request = body.request;
                return () => ({ kind: 'history', entries: receiver.history(request) });
              }
            }
            if (body.command === 'workspace.search' && options.workspaceCommands) {
              const receiver = options.workspaceCommands,
                request = body.request;
              return () => receiver.search(request);
            }
            if (body.command === 'project-history.execute' && options.workspaceCommands) {
              const receiver = options.workspaceCommands,
                request = body.request;
              return () => receiver.history(request);
            }
            if (body.command === 'import-review.execute' && options.importReviews) {
              const receiver = options.importReviews,
                request = body.request,
                agent = body.agent;
              return () => receiver.executeAgent(request, agent, assertCurrent);
            }
            if (body.command === 'administration.execute' && options.administration) {
              const receiver = options.administration,
                request = body.request,
                agent = body.agent;
              return () => receiver.execute(request, assertCurrent, agent);
            }
            return null;
          })();
          if (!run) {
            failure(res, 503, 'NATIVE_DOCUMENT_OWNER_UNAVAILABLE', false);
            return;
          }
          if (
            body.command === 'project-history.execute' &&
            body.request.operation.kind !== 'inspect'
          )
            await options.flushFileClients?.();
          assertCurrent();
          accepted =
            body.command !== 'inventory.inspect' &&
            body.command !== 'inventory.availability' &&
            body.command !== 'inventory.operation' &&
            body.command !== 'inventory.history';
          if (
            body.command === 'inventory.projects' ||
            body.command === 'inventory.catalog' ||
            body.command === 'inventory.catalog-update-preview' ||
            body.command === 'inventory.materials'
          )
            accepted = false;
          const result = await run();
          json(res, 200, { ok: true, ownerInstanceId: authority.ownerInstanceId, result });
          return;
        }
        if (body.command === 'file.execute') {
          if (!options.fileOwner) {
            failure(res, 503, 'NATIVE_DOCUMENT_OWNER_UNAVAILABLE', false);
            return;
          }
          await options.flushFileClients?.();
          assertCurrent();
          accepted = true;
          const snapshot = await options.fileOwner.executeAgent(body.request, body.agent);
          const result = Object.fromEntries(
            Object.entries(snapshot).filter(
              ([key]) =>
                ![
                  'content',
                  'persistedContent',
                  'diskContent',
                  'tableData',
                  'headerRowValues',
                  'firstRowAsHeader',
                ].includes(key)
            )
          );
          json(res, 200, { ok: true, ownerInstanceId: authority.ownerInstanceId, result });
          return;
        }
        if (body.command === 'sequence.execute') {
          if (!options.sequenceOwner) {
            failure(res, 503, 'NATIVE_DOCUMENT_OWNER_UNAVAILABLE', false);
            return;
          }
          await options.flushFileClients?.();
          assertCurrent();
          accepted = true;
          const result = sequenceDocumentAgentResult(
            await options.sequenceOwner.execute(body.request),
            body.request.operation.kind
          );
          json(res, 200, { ok: true, ownerInstanceId: authority.ownerInstanceId, result });
          return;
        }
        if (body.command === 'notebook.execute') {
          if (!options.notebookOwner) {
            failure(res, 503, 'NATIVE_DOCUMENT_OWNER_UNAVAILABLE', false);
            return;
          }
          await options.flushFileClients?.();
          assertCurrent();
          accepted = true;
          const result = await options.notebookOwner.executePublic(body.request);
          json(res, 200, { ok: true, ownerInstanceId: authority.ownerInstanceId, result });
          return;
        }
        const result =
          body.command === 'annotation.inspect'
            ? options.owner.inspect(body.target, body.authority)
            : options.owner.apply(body.request);
        accepted = true;
        json(res, 200, {
          ok: true,
          ownerInstanceId: authority.ownerInstanceId,
          result: await result,
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof NativeDocumentCommandError) {
        json(res, 200, {
          ok: true,
          ownerInstanceId: authority.ownerInstanceId,
          result: {
            ok: false,
            code: error.code,
            error: message,
            retriable: false,
            stateChanged: error.stateChanged,
            partialEffects: error.partialEffects,
          },
        });
        return;
      }
      console.error(`[NativeDocuments] ${body.command} failed:`, error);
      failure(
        res,
        accepted ? 500 : 409,
        accepted ? 'NATIVE_DOCUMENT_OUTCOME_UNCONFIRMED' : 'NATIVE_DOCUMENT_REQUEST_REFUSED',
        accepted
      );
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('The native document listener has no loopback address.');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close() {
      if (!closed) {
        closing = true;
        const listenerClosed = new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
        closed = Promise.all([listenerClosed, options.owner.close()]).then(() => undefined);
      }
      return closed;
    },
  };
}

function nativeCredential(req: IncomingMessage): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === 'x-dnaforge-native-document-authority')
      values.push(req.rawHeaders[index + 1]);
  }
  return values.length === 1 ? values[0] : undefined;
}

function sameToken(first: string, second: string): boolean {
  const a = Buffer.from(first),
    b = Buffer.from(second);
  return a.length === b.length && timingSafeEqual(a, b);
}

class BodyLimitError extends Error {}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        chunks = [];
        return;
      }
      chunks.push(chunk);
    });
    req.once('error', reject);
    req.once('aborted', () => reject(new Error('The native request was interrupted.')));
    req.once('end', () => {
      if (size > MAX_BODY_BYTES) {
        reject(new BodyLimitError());
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function failure(res: ServerResponse, status: number, code: string, accepted: boolean): void {
  json(res, status, { ok: false, accepted, error: { code } });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Connection: 'close',
  });
  res.end(JSON.stringify(body));
}
