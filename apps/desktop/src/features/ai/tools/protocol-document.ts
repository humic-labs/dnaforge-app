import { z } from 'zod';
import { protocolDocumentAgentRequestSchema } from '../../../shared/protocol-command';
import { resultTool, toolFailure } from '../../agent-bridge/public/tool-result';

export const PROTOCOL_DOCUMENT_DESCRIPTION =
  'Create, inspect and save native Protocol and Protocol Run packages in an explicit project through one durable owner. Use list-packages with packageKind protocol or protocol-run, then read-saved-protocol to obtain the exact saved sourceSha256. Start-run requires that canonical protocolId and expectedSourceSha256; it freezes the actual saved source and definition, independently of any stale declared version. Creating a run records in-progress tracking only and has no stock, hardware or scientific-success effect. Edit-protocol-declarations and record-run-values require entityId, expectedSourceSha256 and choices with ordered upserts and reason. These preserve unselected rows and unsupported types; saved keys and types cannot change and omission never deletes. Supported new values are text, finite safe numbers, booleans and canonical UTC dates. Declared Run values must pin the frozen definitionSha256; local actual values cannot shadow declarations and measurements are local only. Recording values never completes a Run or attributes a result to a physical aliquot. Keep one stable requestId for every creation or edit. After a missing acknowledgement inspect-creation and recover-creation with that same requestId; never allocate a replacement request to hide uncertainty. Pending means the exact file or write intent is retained and catalog recovery is incomplete. Ready recovery returns the original result and cannot undo later edits or moves. Save-package requires the current sourceSha256 and complete originalText; immutable creation and frozen protocol anchors cannot change. Draft paper protocols must be finalized through their existing authoring workflow before starting. Saved source is observed file evidence, not an accepted scientific revision.';

export const protocolDocumentOutputSchema = z
  .object({
    ok: z.literal(true),
    kind: z.enum(['ready', 'pending', 'refused', 'missing', 'package', 'packages']),
  })
  .passthrough();

export function createProtocolDocumentTool() {
  return resultTool({
    description: PROTOCOL_DOCUMENT_DESCRIPTION,
    inputSchema: protocolDocumentAgentRequestSchema,
    execute: async () =>
      toolFailure({
        code: 'PROTOCOL_NATIVE_ROUTE_REQUIRED',
        error: 'Protocol package actions require the authenticated native command route.',
        retriable: false,
        stateChanged: false,
        partialEffects: [],
      }),
  });
}
