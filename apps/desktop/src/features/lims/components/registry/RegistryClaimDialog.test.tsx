import { withUserMessage } from '@waypoint/user-messages';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { LimsRegistrySummary } from '../../../../shared/lims';
import { RegistryClaimDialog } from './RegistryClaimDialog';
import type {
  OrganizationRegistryClaimPreparationRequest,
  PreparedOrganizationRegistryClaim,
} from '../../../../shared/org-registry-sync';

function summary(input: {
  id: string;
  name: string;
  kind: string;
  registryId: string;
}): LimsRegistrySummary {
  return {
    ...input,
    schemaSnapshot: {
      schemaId: `${input.kind}-schema`,
      schemaRevisionId: `${input.kind}-schema-v1`,
      name: input.kind,
      baseKind: input.kind,
      displayName: input.kind,
      version: 1,
      fields: [
        { key: 'species', label: 'Species', type: 'text' },
        { key: 'freezer', label: 'Freezer location', type: 'text' },
      ],
    },
    fieldValues: {},
    registrationStatus: 'registered',
    domainStatus: null,
    representation: { kind: 'record', label: 'Record', canOpen: false },
    summary: input.kind,
    linkSummary: { outgoingCount: 0, incomingCount: 0, notable: [] },
    searchableText: `${input.name} ${input.registryId}`,
    updatedAt: 1,
    archived: false,
  };
}

const localStrain = summary({
  id: 'local-strain',
  name: 'MG1655 local',
  kind: 'strain',
  registryId: 's000001',
});
const localPlasmid = summary({
  id: 'local-plasmid',
  name: 'pUC19 local',
  kind: 'plasmid',
  registryId: 'p000001',
});

describe('Registry local claim dialog', () => {
  it('finds records beyond the visible Registry page and retains selections across searches', async () => {
    const searchRecords = vi.fn(async (search: string) => ({
      summaries: search === 'pUC19' ? [localPlasmid] : [localStrain],
      totalCount: search === 'pUC19' ? 1 : 51,
      limit: 50,
      offset: 0,
    }));
    const schemas = [localStrain, localPlasmid].map((record) => ({
      id: `${record.kind}-org-schema`,
      currentRevisionId: `${record.kind}-org-v1`,
      name: record.kind,
      baseKind: record.kind,
      displayName: record.kind,
      version: 1,
      fields: [],
    }));
    const prepareClaim = vi.fn(async (request: OrganizationRegistryClaimPreparationRequest) => {
      const record = [localStrain, localPlasmid].find((record) => record.id === request.entityId)!;
      return {
        mutationId: record.id,
        sourceEntityId: record.id,
        sourceRegistryId: record.registryId,
        sourceRevision: 'a'.repeat(64),
        homeWorkspaceId: '40000000-0000-4000-8000-000000000001',
        homeProjectUuid: '30000000-0000-4000-8000-000000000001',
        homeProjectName: 'Original home',
        payload: {
          id: record.id,
          schemaId: request.schemaId,
          schemaRevisionId: request.schemaRevisionId,
          name: record.name,
          kind: record.kind,
          fields: {},
        },
      } satisfies PreparedOrganizationRegistryClaim;
    });
    render(
      <RegistryClaimDialog
        organizationName="Acme Bio"
        localRecords={[localStrain]}
        searchRecords={searchRecords}
        schemas={schemas}
        prepareClaim={prepareClaim}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    await waitFor(() => expect(searchRecords).toHaveBeenCalledWith(''));
    fireEvent.change(screen.getByLabelText('Find saved records'), { target: { value: 'pUC19' } });
    const older = await screen.findByTestId(`registry-claim-record-${localPlasmid.id}`);
    fireEvent.click(within(older).getByRole('checkbox'));
    expect(searchRecords).toHaveBeenCalledWith('pUC19');
    fireEvent.change(screen.getByLabelText('Find saved records'), { target: { value: '' } });
    const first = await screen.findByTestId(`registry-claim-record-${localStrain.id}`);
    fireEvent.click(within(first).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /review 2 records/i }));
    expect(await screen.findByTestId(`registry-claim-preview-${localPlasmid.id}`)).toBeVisible();
    expect(screen.getByTestId(`registry-claim-preview-${localStrain.id}`)).toBeVisible();
    expect(prepareClaim.mock.calls.map(([request]) => request.entityId).sort()).toEqual(
      [localPlasmid.id, localStrain.id].sort()
    );
  });

  it.each([true, false])(
    'requires selection, readable fields and separate confirmation with organization fields declared=%s',
    async (declared) => {
      const prepared: PreparedOrganizationRegistryClaim = {
        mutationId: '50000000-0000-4000-8000-000000000001',
        sourceEntityId: localStrain.id,
        sourceRegistryId: localStrain.registryId,
        sourceRevision: 'a'.repeat(64),
        homeWorkspaceId: '40000000-0000-4000-8000-000000000001',
        homeProjectUuid: '30000000-0000-4000-8000-000000000001',
        homeProjectName: 'Original home',
        payload: {
          id: localStrain.id,
          schemaId: '11111111-1111-4111-8111-111111111111',
          schemaRevisionId: '22222222-2222-4222-8222-222222222222',
          homeWorkspaceId: '40000000-0000-4000-8000-000000000001',
          kind: localStrain.kind,
          name: localStrain.name,
          fields: { species: 'E. coli', freezer: 'A/01' },
        },
      };
      const prepareClaim = vi.fn(async () => prepared);
      const onConfirm = vi.fn(async () => ({ ok: true as const }));
      render(
        <RegistryClaimDialog
          organizationName="Acme Bio"
          localRecords={[localStrain, localPlasmid]}
          schemas={[
            {
              id: '11111111-1111-4111-8111-111111111111',
              currentRevisionId: '22222222-2222-4222-8222-222222222222',
              name: 'strain',
              baseKind: 'strain',
              displayName: 'Strain',
              version: 2,
              fields: declared
                ? [
                    { key: 'species', label: 'Species', type: 'text' },
                    { key: 'freezer', label: 'Freezer location', type: 'text' },
                  ]
                : [],
            },
          ]}
          prepareClaim={prepareClaim}
          onConfirm={onConfirm}
          onCancel={vi.fn()}
        />
      );

      expect(screen.getByText(/nothing is sent until you confirm/i)).toBeVisible();
      expect(screen.getByTestId('registry-claim-record-local-plasmid')).toHaveTextContent(
        /no compatible organization schema/i
      );
      expect(screen.getByRole('button', { name: /review 0 records/i })).toBeDisabled();

      fireEvent.click(
        within(screen.getByTestId('registry-claim-record-local-strain')).getByRole('checkbox')
      );
      expect(prepareClaim).not.toHaveBeenCalled();
      expect(onConfirm).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: /review 1 record/i }));

      expect(await screen.findByText(/fields to register/i)).toBeVisible();
      expect(screen.getByTestId('registry-claim-custody-notice')).toHaveTextContent(
        'Acme Bio will retain custody if you leave the organization.'
      );
      expect(screen.getByText('Freezer location', { exact: true })).toBeVisible();
      expect(screen.getByText('A/01', { exact: true })).toBeVisible();
      expect(screen.getByText('E. coli', { exact: true })).toBeVisible();
      expect(screen.getByTestId(`registry-claim-preview-${localStrain.id}`)).toHaveTextContent(
        'Strain · v2'
      );
      expect(screen.getByText(/each record keeps its identity and home project/i)).toBeVisible();
      expect(screen.getByTestId(`registry-claim-home-${localStrain.id}`)).toHaveTextContent(
        'Original home'
      );
      expect(prepareClaim).toHaveBeenCalledWith({
        entityId: localStrain.id,
        schemaId: '11111111-1111-4111-8111-111111111111',
        schemaRevisionId: '22222222-2222-4222-8222-222222222222',
      });
      expect(onConfirm).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: /confirm and register 1 record/i }));
      await waitFor(() => expect(onConfirm).toHaveBeenCalledOnce());
      expect(onConfirm).toHaveBeenCalledWith([prepared]);
      expect(prepared.payload.id).toBe(localStrain.id);
    }
  );

  it('shows a refused home preparation without enabling confirmation', async () => {
    const onConfirm = vi.fn();
    const prepareClaim = vi.fn(async () => {
      throw withUserMessage(
        new Error('Registration requires an existing organization home project.'),
        'registry.organizationHomeRequired'
      );
    });
    render(
      <RegistryClaimDialog
        organizationName="Acme Bio"
        localRecords={[localStrain]}
        schemas={[
          {
            id: '11111111-1111-4111-8111-111111111111',
            currentRevisionId: '22222222-2222-4222-8222-222222222222',
            name: 'strain',
            baseKind: 'strain',
            displayName: 'Strain',
          },
        ]}
        prepareClaim={prepareClaim}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    );
    fireEvent.click(
      within(screen.getByTestId(`registry-claim-record-${localStrain.id}`)).getByRole('checkbox')
    );
    fireEvent.click(screen.getByRole('button', { name: /review 1 record/i }));
    expect(
      await screen.findByText(/requires an existing organization home project/i)
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: /confirm and register/i })).not.toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
