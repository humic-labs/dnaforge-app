import { toUserMessage } from '@waypoint/user-messages';
import { useEffect, useMemo, useRef, useState } from 'react';
import { platform } from '../../platform';
import { parseLimsSchemaFields, type LimsSchemaDefinitionView } from '../../shared/lims';
import type { OrganizationRegistryView } from '../../shared/org-registry-sync';
import type { WorkspaceSyncOrganizationSummary } from '../../shared/workspace-sync-ipc';
import type { RegistrySchemaSource } from '../lims/public/RegistrySettingsContent';

export function organizationRegistrySchemas(
  registry: OrganizationRegistryView
): LimsSchemaDefinitionView[] {
  return registry.schemas.flatMap((schema) => {
    const revision = registry.schemaRevisions.find((item) => item.id === schema.currentRevisionId);
    const version = typeof schema.version === 'number' ? schema.version : revision?.version;
    if (
      schema.archivedAt ||
      schema.archived === true ||
      typeof schema.id !== 'string' ||
      typeof schema.currentRevisionId !== 'string' ||
      typeof schema.name !== 'string' ||
      typeof version !== 'number'
    )
      return [];
    return [
      {
        schemaId: schema.id,
        currentRevisionId: schema.currentRevisionId,
        entityKind: schema.name,
        baseKind: typeof schema.baseKind === 'string' ? schema.baseKind : schema.name,
        displayName: typeof schema.displayName === 'string' ? schema.displayName : schema.name,
        description: typeof schema.description === 'string' ? schema.description : null,
        version,
        builtin: false,
        fields: parseLimsSchemaFields(
          JSON.stringify({ fields: revision?.fields ?? schema.fields ?? [] })
        ).fields,
      },
    ];
  });
}

export function useOrganizationRegistrySchemaSources(options: {
  accountId: string | null;
  organizations: WorkspaceSyncOrganizationSummary[];
  refreshRevision?: number;
}) {
  const [snapshot, setSnapshot] = useState<{
    accountId: string | null;
    registries: Record<string, OrganizationRegistryView>;
  }>({ accountId: null, registries: {} });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const context = useRef(options);
  context.current = options;
  const signature = options.organizations
    .map((org) => `${org.orgId}:${org.displayName}:${org.isAdministrator}`)
    .sort()
    .join('|');

  useEffect(() => {
    const accountId = options.accountId;
    let current = true;
    setError(null);
    setNotice(null);
    if (!accountId) {
      setSnapshot({ accountId: null, registries: {} });
      return;
    }
    const organizations = context.current.organizations;
    const read = platform().cloudSync?.getOrganizationRegistry;
    if (!read) return;
    void Promise.allSettled(
      organizations.map(async (org) => {
        const result = await read(org.orgId);
        if (!result.ok) throw new Error(`${org.displayName}: ${result.message}`);
        if (result.registry.orgId !== org.orgId)
          throw new Error('The organization definition scope changed.');
        return [org.orgId, result.registry] as const;
      })
    ).then((results) => {
      if (!current || context.current.accountId !== accountId) return;
      const registries: Record<string, OrganizationRegistryView> = {};
      const errors: string[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') registries[result.value[0]] = result.value[1];
        else
          errors.push(
            result.reason instanceof Error
              ? result.reason.message
              : 'Organization definitions could not load.'
          );
      }
      setSnapshot({ accountId, registries });
      setError(errors.length ? toUserMessage(errors.join(' '), 'account.failed') : null);
    });
    return () => {
      current = false;
    };
  }, [options.accountId, signature, retry, options.refreshRevision]);

  const sources = useMemo<RegistrySchemaSource[]>(() => {
    const accountId = options.accountId;
    if (!accountId || snapshot.accountId !== accountId) return [];
    return options.organizations.flatMap((organization) => {
      const orgId = organization.orgId;
      const registry = snapshot.registries[orgId];
      if (!registry || registry.state.status === 'access_revoked') return [];
      const schemas = organizationRegistrySchemas(registry);
      const assertCurrent = () => {
        const current = context.current;
        const member = current.organizations.find((org) => org.orgId === orgId);
        if (current.accountId !== accountId || !member?.isAdministrator) {
          throw new Error(
            'Organization editing access changed. Reload the definitions before saving.'
          );
        }
      };
      const install = (next: OrganizationRegistryView) => {
        if (context.current.accountId !== accountId || next.orgId !== orgId) return;
        setSnapshot((current) =>
          current.accountId === accountId
            ? { ...current, registries: { ...current.registries, [orgId]: next } }
            : current
        );
      };
      const refresh = async () => {
        if (context.current.accountId !== accountId) return;
        const client = platform().cloudSync;
        if (!client?.getOrganizationRegistry)
          throw new Error('Organization definitions are unavailable.');
        const result = await client.getOrganizationRegistry(orgId);
        if (!result.ok) throw new Error(result.message);
        install(result.registry);
      };
      const mutate = async (
        operation: 'schema.create' | 'schema.refine',
        payload: Record<string, unknown>
      ) => {
        assertCurrent();
        const client = platform().cloudSync;
        if (!client?.mutateOrganizationRegistry)
          throw new Error('Organization editing is unavailable.');
        const result = await client.mutateOrganizationRegistry(orgId, {
          mutationId: crypto.randomUUID(),
          operation,
          payload,
        });
        if (!result.ok) throw new Error(result.message);
        assertCurrent();
        install(result.registry);
        setNotice(
          result.sync.status === 'ready'
            ? null
            : `Changes for ${organization.displayName} are queued and will appear after synchronization.`
        );
      };
      return [
        {
          id: `organization:${orgId}`,
          label: organization.displayName,
          schemas,
          readOnly:
            !organization.isAdministrator || registry.state.lastErrorCode === 'NOT_CONFIGURED',
          onChanged: refresh,
          onDefine: async (input) =>
            mutate('schema.create', {
              id: crypto.randomUUID(),
              revisionId: crypto.randomUUID(),
              name: input.name,
              displayName: input.displayName,
              baseKind: input.baseKind ?? input.name,
              description: input.description ?? null,
              fields: input.fields,
            }),
          onRefine: async (input) => {
            assertCurrent();
            const client = platform().cloudSync;
            if (!client?.getOrganizationRegistry)
              throw new Error('Organization definitions are unavailable.');
            const result = await client.getOrganizationRegistry(orgId);
            if (!result.ok) throw new Error(result.message);
            const schema = organizationRegistrySchemas(result.registry).find(
              (item) => item.schemaId === input.schemaId
            );
            if (!schema || schema.currentRevisionId !== input.expectedRevisionId) {
              throw new Error('This schema changed. Reload its current version before saving.');
            }
            await mutate('schema.refine', {
              id: schema.schemaId,
              revisionId: crypto.randomUUID(),
              expectedVersion: schema.version,
              description: input.description === undefined ? schema.description : input.description,
              fields: input.fields,
            });
          },
        },
      ];
    });
  }, [options.accountId, signature, snapshot]);

  return { sources, error, notice, retry: () => setRetry((value) => value + 1) };
}
