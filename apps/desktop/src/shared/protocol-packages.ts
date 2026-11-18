import { z } from 'zod';
import type {
  NativeProtocolEditDeclarationsRequest,
  NativeProtocolRecordRunValuesRequest,
} from './protocol-value-edits';
export {
  protocolEditDeclarationsSchema,
  protocolRecordRunValuesSchema,
} from './protocol-value-edits';
export type {
  NativeProtocolEditDeclarationsRequest,
  NativeProtocolRecordRunValuesRequest,
} from './protocol-value-edits';

const text = z.string().min(1).max(1024);
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const scope = z.object({ project: text }).strict();
export const protocolPackageReadSchema = scope.extend({ entityId: text }).strict();
export const protocolPackageListSchema = scope
  .extend({
    kind: z.enum(['protocol', 'protocol-run']),
    query: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
export const protocolCreateSchema = scope
  .extend({
    initialProtocolText: z
      .string()
      .min(1)
      .max(16 * 1024 * 1024)
      .optional(),
    requestId: text,
    title: z.string().trim().min(1).max(500),
    parentPath: z.string().min(1).max(4096).optional(),
  })
  .strict();
export const protocolStartRunSchema = protocolCreateSchema
  .omit({ initialProtocolText: true })
  .extend({
    protocolId: text,
    expectedSourceSha256: sha256,
  })
  .strict();
export const protocolCreationInspectSchema = scope.extend({ requestId: text }).strict();
export const protocolPackageSaveSchema = protocolPackageReadSchema
  .extend({
    requestId: text,
    expectedSourceSha256: sha256,
    originalText: z
      .string()
      .min(1)
      .max(16 * 1024 * 1024),
  })
  .strict();
export const protocolRunSavedSourceSchema = z
  .object({
    schema: z.literal('dnaforge.protocol-run-saved-source.v1'),
    projectId: text,
    workspaceScope: text,
    runId: text,
    fileObjectUuid: text,
    title: z.string().min(1).max(500),
    originalText: z
      .string()
      .min(1)
      .max(16 * 1024 * 1024),
  })
  .strict();
export type ProtocolRunSavedSource = z.infer<typeof protocolRunSavedSourceSchema>;
export type NativeProtocolCreateRequest = z.infer<typeof protocolCreateSchema>;
export type NativeProtocolStartRunRequest = z.infer<typeof protocolStartRunSchema>;
export type NativeProtocolCreationInspectRequest = z.infer<typeof protocolCreationInspectSchema>;
export type NativeProtocolPackageReadRequest = z.infer<typeof protocolPackageReadSchema>;
export type NativeProtocolPackageListRequest = z.infer<typeof protocolPackageListSchema>;
export type NativeProtocolPackageSaveRequest = z.infer<typeof protocolPackageSaveSchema>;
export interface NativeProtocolPackageSnapshot {
  readonly readOnly: boolean;
  readonly projectId: string;
  readonly workspaceScope: string;
  readonly entityId: string;
  readonly portableId: string;
  readonly fileObjectUuid: string;
  readonly kind: 'protocol' | 'protocol-run';
  readonly title: string;
  readonly path: string;
  readonly originalText: string;
  readonly sourceSha256: `sha256:${string}`;
  readonly fileSha256: `sha256:${string}`;
  readonly creationRequestId: string | null;
  readonly definitionSha256: `sha256:${string}` | null;
}
export type NativeProtocolCreationResult =
  | {
      readonly kind: 'ready';
      readonly requestId: string;
      readonly package: NativeProtocolPackageSnapshot;
      readonly currentAvailability?:
        | {
            readonly kind: 'available';
            readonly path: string;
            readonly sourceSha256: `sha256:${string}`;
          }
        | { readonly kind: 'unavailable'; readonly message: string };
    }
  | {
      readonly kind: 'pending' | 'refused';
      readonly requestId: string;
      readonly entityId: string;
      readonly path: string;
      readonly message: string;
    }
  | { readonly kind: 'missing'; readonly requestId: string };
export interface NativeProtocolPackageChanged {
  readonly projectId: string;
  readonly entityId: string;
  readonly workspaceRoot: string;
  readonly path: string;
  readonly operation: 'create' | 'save';
}
export interface NativeProtocolClient {
  createProtocol(request: NativeProtocolCreateRequest): Promise<NativeProtocolCreationResult>;
  startRun(request: NativeProtocolStartRunRequest): Promise<NativeProtocolCreationResult>;
  inspectCreation(
    request: NativeProtocolCreationInspectRequest
  ): Promise<NativeProtocolCreationResult>;
  recoverCreation(
    request: NativeProtocolCreationInspectRequest
  ): Promise<NativeProtocolCreationResult>;
  readPackage(request: NativeProtocolPackageReadRequest): Promise<NativeProtocolPackageSnapshot>;
  readSavedProtocol(
    request: NativeProtocolPackageReadRequest
  ): Promise<NativeProtocolPackageSnapshot>;
  listPackages(
    request: NativeProtocolPackageListRequest
  ): Promise<readonly NativeProtocolPackageSnapshot[]>;
  savePackage(request: NativeProtocolPackageSaveRequest): Promise<NativeProtocolCreationResult>;
  editProtocolDeclarations(
    request: NativeProtocolEditDeclarationsRequest
  ): Promise<NativeProtocolCreationResult>;
  recordRunValues(
    request: NativeProtocolRecordRunValuesRequest
  ): Promise<NativeProtocolCreationResult>;
}
export interface NativeProtocolPlatformClient extends NativeProtocolClient {
  onChanged(listener: (change: NativeProtocolPackageChanged) => void): () => void;
}
