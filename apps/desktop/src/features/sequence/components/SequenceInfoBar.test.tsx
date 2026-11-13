import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DOCUMENT_TAB_UNDERBAR_MIN_CLASS } from '../public/document-tab-underbar';
import { SequenceInfoBar } from './SequenceInfoBar';
import {
  sequenceDisplayName,
  quickLookSequenceDisplayName,
} from '../../../shared/sequence-presentation';

describe('SequenceInfoBar', () => {
  it.each([
    ['PBR322 Follow-up.gb', 'PBR322 Follow-up'],
    ['PBR322 Follow-up.GBK', 'PBR322 Follow-up'],
    ['PBR322 Follow-up.gb.gz', 'PBR322 Follow-up'],
    ['  PBR322 Follow-up.gb  ', 'PBR322 Follow-up'],
    ['Construct v2.1', 'Construct v2.1'],
    ['E. coli MG1655', 'E. coli MG1655'],
  ])('renders the admitted name and tooltip for %s', (raw, expected) => {
    render(<SequenceInfoBar documentLabel={sequenceDisplayName(raw)} />);
    const label = screen.getByTestId('sequence-info-path');
    expect(label).toHaveTextContent(expected);
    expect(label.textContent).toBe(expected);
    expect(label).toHaveAttribute('title', expected);
  });

  it('renders the admitted Quick Look source and record without import extensions', () => {
    render(
      <SequenceInfoBar documentLabel={quickLookSequenceDisplayName('two-record.gb', 'Record 1')} />
    );
    const label = screen.getByTestId('sequence-info-path');
    expect(label.textContent).toBe('Quick Look / two-record / Record 1');
    expect(label).toHaveAttribute('title', 'Quick Look / two-record / Record 1');
  });

  it('renders runtime metadata and a caller-stable edit action in the shared bar', () => {
    const onEdit = vi.fn();

    render(
      <SequenceInfoBar
        documentLabel={sequenceDisplayName('Hosted sequence')}
        sequenceLength={3005}
        circular
        trailingContent={<span data-testid="revision">Revision 2</span>}
        onEdit={onEdit}
        editButtonTestId="hosted-edit-sequence"
      />
    );

    expect(screen.getByTestId('sequence-info-bar')).toHaveTextContent('3,005 bp');
    expect(screen.getByTestId('revision')).toHaveTextContent('Revision 2');
    fireEvent.click(screen.getByTestId('hosted-edit-sequence'));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('keeps Quick Look identity and import action inside the existing header', () => {
    const onImportToEdit = vi.fn();

    render(
      <SequenceInfoBar
        documentLabel={sequenceDisplayName('Quick Look / SLI_505.gbk')}
        sequenceLength={166379}
        circular={false}
        accessMode={{ kind: 'read-only', onImportToEdit }}
      />
    );

    const bar = screen.getByTestId('sequence-info-bar');
    expect(bar).toHaveTextContent('Quick Look / SLI_505');
    expect(bar).toHaveTextContent('Read Only');
    expect(bar).not.toHaveTextContent('quick-look-packages');
    expect(bar).not.toHaveTextContent('uuid');

    fireEvent.click(screen.getByTestId('quick-look-import-button'));
    expect(screen.getByTestId('quick-look-import-button')).toHaveTextContent('Import to Edit');
    expect(onImportToEdit).toHaveBeenCalledTimes(1);
  });

  it('renders the  view controls for circular sequences', () => {
    const onViewModeChange = vi.fn();
    const onRendererVisibilityChange = vi.fn();
    const onMapLayoutChange = vi.fn();

    render(
      <SequenceInfoBar
        documentLabel={sequenceDisplayName('pUC19')}
        sequenceLength={2686}
        circular
        viewMode="2d"
        onViewModeChange={onViewModeChange}
        rendererVisibility="both"
        onRendererVisibilityChange={onRendererVisibilityChange}
        mapLayout="vertical"
        onMapLayoutChange={onMapLayoutChange}
      />
    );

    expect(screen.getByTestId('sequence-renderer-visibility-toggle')).toBeVisible();
    expect(screen.getByTestId('sequence-renderer-visibility-both')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByTestId('sequence-view-mode-toggle')).toBeVisible();
    expect(screen.getByTestId('sequence-view-mode-2d')).toHaveTextContent('Wrap');
    expect(screen.getByTestId('sequence-view-mode-2d')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('sequence-view-mode-1d')).not.toBeInTheDocument();
    expect(screen.getByTestId('sequence-map-layout-toggle')).toBeVisible();
    expect(screen.getByTestId('sequence-map-layout-vertical')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.queryByTestId('sequence-map-shape-toggle')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sequence-renderer-visibility-sequence'));
    fireEvent.click(screen.getByTestId('sequence-renderer-visibility-map'));
    fireEvent.click(screen.getByTestId('sequence-map-layout-horizontal'));
    fireEvent.click(screen.getByTestId('sequence-view-mode-tracks'));

    expect(onRendererVisibilityChange).toHaveBeenNthCalledWith(1, 'sequence');
    expect(onRendererVisibilityChange).toHaveBeenNthCalledWith(2, 'map');
    expect(onMapLayoutChange).toHaveBeenCalledWith('horizontal');
    expect(onViewModeChange).toHaveBeenCalledWith('tracks');
  });

  it('hides the circular map-shape control for linear sequences', () => {
    render(
      <SequenceInfoBar
        documentLabel={sequenceDisplayName('Linear sequence')}
        sequenceLength={1000}
        circular={false}
        viewMode="2d"
        onViewModeChange={vi.fn()}
        rendererVisibility="both"
        onRendererVisibilityChange={vi.fn()}
        mapLayout="vertical"
        onMapLayoutChange={vi.fn()}
      />
    );

    expect(screen.getByTestId('sequence-renderer-visibility-toggle')).toBeVisible();
    expect(screen.getByTestId('sequence-map-layout-toggle')).toBeVisible();
    expect(screen.getByTestId('sequence-view-mode-toggle')).toBeVisible();
    expect(screen.queryByTestId('sequence-map-shape-toggle')).not.toBeInTheDocument();
  });

  it('hides the layout control when only one surface is selected', () => {
    render(
      <SequenceInfoBar
        documentLabel={sequenceDisplayName('pUC19')}
        sequenceLength={2686}
        circular
        viewMode="2d"
        onViewModeChange={vi.fn()}
        rendererVisibility="sequence"
        onRendererVisibilityChange={vi.fn()}
        mapLayout="vertical"
        onMapLayoutChange={vi.fn()}
      />
    );

    expect(screen.getByTestId('sequence-renderer-visibility-toggle')).toBeVisible();
    expect(screen.queryByTestId('sequence-map-layout-toggle')).not.toBeInTheDocument();
  });

  it('matches the taller draft-assembly bar directly under the tab', () => {
    render(
      <SequenceInfoBar
        documentLabel={sequenceDisplayName('Final assembly')}
        sequenceLength={12}
        circular
      />
    );

    expect(screen.getByTestId('sequence-info-bar').className).toContain(
      DOCUMENT_TAB_UNDERBAR_MIN_CLASS
    );
  });
});
