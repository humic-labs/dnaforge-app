import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RegistryCompactDrawer } from './RegistryCompactDrawer';
import type { LimsRegistrySummary } from '../../../../shared/lims';

function controls() {
  const add = vi.fn();
  return {
    add,
    props: {
      registrySearch: '',
      setRegistrySearch: vi.fn(),
      expandRegistry: vi.fn(),
      actionsMenu: <button onClick={add}>Add registry record</button>,
      scopeControls: <div>Local registry scope</div>,
      messageBar: null,
      registryCompactScrollRef: createRef<HTMLDivElement>(),
      registryCompactSentinelRef: createRef<HTMLDivElement>(),
      summaries: [],
      selectRegistrySummary: vi.fn(),
      openRegistrySummary: vi.fn(),
      registryLoading: false,
      registryHasMore: false,
      registryLoadingMore: false,
      unconnectedEntityIds: new Set<string>(),
    },
  };
}

describe('compact Registry controls', () => {
  it('preserves controlled search and the Expand action', () => {
    const { props } = controls();
    const { rerender } = render(<RegistryCompactDrawer {...props} />);
    const search = screen.getByRole('textbox', { name: 'Search registry' });
    fireEvent.change(search, { target: { value: 'plasmid' } });
    expect(props.setRegistrySearch).toHaveBeenCalledExactlyOnceWith('plasmid');
    rerender(<RegistryCompactDrawer {...props} registrySearch="plasmid" />);
    expect(search).toHaveValue('plasmid');
    fireEvent.click(screen.getByRole('button', { name: 'Expand registry' }));
    expect(props.expandRegistry).toHaveBeenCalledTimes(1);
  });

  it('preserves Details, Open, Add and scope without the removed Unconnected filter', () => {
    const { props, add } = controls();
    const summary: LimsRegistrySummary = {
      id: 'one',
      kind: 'strain',
      name: 'Reviewed strain',
      registryId: 's000001',
      schemaSnapshot: {
        schemaId: 'strain-schema',
        schemaRevisionId: 'strain-schema-v1',
        name: 'strain',
        baseKind: 'strain',
        displayName: 'Strain',
        version: 1,
        fields: [],
      },
      fieldValues: {},
      registrationStatus: 'registered',
      domainStatus: null,
      representation: { kind: 'record_file', label: 'Record', canOpen: true },
      summary: 'Strain',
      linkSummary: { outgoingCount: 0, incomingCount: 0, notable: [] },
      searchableText: 'Reviewed strain s000001',
      updatedAt: 1,
      archived: false,
    };
    render(
      <RegistryCompactDrawer
        {...props}
        summaries={[summary]}
        unconnectedEntityIds={new Set(['one'])}
      />
    );
    expect(screen.queryByRole('button', { name: /Unconnected/ })).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('lims-registry-compact-unconnected-filter')
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('lims-registry-compact-failed-one')).toBeVisible();
    fireEvent.click(
      screen.getByRole('button', { name: 'Show details for Reviewed strain', exact: true })
    );
    expect(props.selectRegistrySummary).toHaveBeenCalledExactlyOnceWith(summary);
    expect(props.openRegistrySummary).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open Reviewed strain', exact: true }));
    expect(props.openRegistrySummary).toHaveBeenCalledExactlyOnceWith(summary);
    expect(props.selectRegistrySummary).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Add registry record' }));
    expect(add).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Local registry scope')).toBeVisible();
  });
});
