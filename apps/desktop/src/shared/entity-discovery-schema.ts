import { z } from 'zod';
import { ENTITY_TYPE_ICON_KINDS } from '@waypoint/scientific-artifacts/shared/entity-types';
import { ENTITY_DISCOVERY_CATEGORY_KEYS, ENTITY_DISCOVERY_PROJECT_TYPES } from './entity-discovery';

export const entityDiscoveryScopeSchema = z
  .object({
    projectId: z.string().min(1).max(500).optional(),
    projectRoot: z.string().min(1).max(8192).optional(),
    projectRoots: z.array(z.string().min(1).max(8192)).max(128).optional(),
    includeArchived: z.boolean().optional(),
  })
  .strict();

export const entityDiscoveryFilterSchema = z
  .object({
    namedTypeKey: z.string().min(1).max(1000).optional(),
    category: z.enum(ENTITY_DISCOVERY_CATEGORY_KEYS).optional(),
    entityTypes: z.array(z.string().min(1).max(100)).max(100).optional(),
    registryKinds: z.array(z.string().min(1).max(100)).max(100).optional(),
    schemaId: z.string().min(1).max(500).optional(),
    role: z.literal('primer').optional(),
  })
  .strict();

export const entityDiscoveryRequestSchema = z
  .object({
    query: z.string().max(1000),
    scope: entityDiscoveryScopeSchema.optional(),
    filter: entityDiscoveryFilterSchema.optional(),
    preferredProjectId: z.string().min(1).max(500).optional(),
    preferredProjectRoot: z.string().min(1).max(8192).optional(),
    cursor: z.string().min(1).max(8192).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

export const entityDiscoveryResolveRequestSchema = z
  .object({
    ids: z.array(z.string().min(1).max(500)).max(1000),
    scope: entityDiscoveryScopeSchema.optional(),
  })
  .strict();

export const entityDiscoveryTypesRequestSchema = z
  .object({
    scope: entityDiscoveryScopeSchema.optional(),
  })
  .strict();

const entityColorContextSchema = z
  .object({
    kind: z.string().optional(),
    molecule: z.string().optional(),
    path: z.string().optional(),
    packageKind: z.string().optional(),
    isDirectory: z.boolean().optional(),
  })
  .strict()
  .optional();

export const entityDescriptorSchema = z
  .object({
    id: z.string(),
    type: z.enum(['registry', ...ENTITY_DISCOVERY_PROJECT_TYPES]),
    name: z.string(),
    sequenceLength: z.number().int().nonnegative().nullable().optional(),
    source: z.enum(['project', 'registry', 'primer']),
    namedTypeKey: z.string().min(1),
    iconKind: z.enum(ENTITY_TYPE_ICON_KINDS),
    iconContext: entityColorContextSchema,
    kindLabel: z.string(),
    path: z.string().nullable(),
    contentHash: z.string().nullable(),
    objectUuid: z.string().nullable(),
    registryKind: z.string().nullable(),
    registryId: z.string().nullable(),
    schemaId: z.string().nullable(),
    projectId: z.string().nullable(),
    projectRoot: z.string().nullable(),
    projectName: z.string().nullable(),
    archived: z.boolean(),
    localOnly: z.boolean().optional(),
  })
  .strict();

export const entityDiscoveryCoverageSchema = z
  .object({
    catalog: z.number().int().nonnegative(),
    registry: z.number().int().nonnegative(),
    primers: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
  })
  .strict();

export const entityDiscoveryPageSchema = z
  .object({
    items: z.array(entityDescriptorSchema),
    nextCursor: z.string().nullable(),
    generation: z.string(),
    coverage: entityDiscoveryCoverageSchema,
  })
  .strict();

export const entityDiscoveryResolutionSchema = z
  .object({
    items: z.array(
      z.discriminatedUnion('status', [
        z
          .object({
            id: z.string(),
            status: z.literal('available'),
            entity: entityDescriptorSchema,
          })
          .strict(),
        z.object({ id: z.string(), status: z.literal('unavailable') }).strict(),
      ])
    ),
    generation: z.string(),
    coverage: entityDiscoveryCoverageSchema,
  })
  .strict();

export const entityDiscoveryTypesSchema = z
  .object({
    items: z.array(
      z
        .object({
          key: z.string(),
          kind: z.enum(['type', 'shortcut']),
          label: z.string(),
          terms: z.array(z.string()),
          filter: entityDiscoveryFilterSchema,
          iconKind: z.enum(ENTITY_TYPE_ICON_KINDS),
          iconContext: entityColorContextSchema,
          count: z.number().int().nonnegative(),
        })
        .strict()
    ),
    generation: z.string(),
    coverage: entityDiscoveryCoverageSchema,
  })
  .strict();
