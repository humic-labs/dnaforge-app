import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createAppTmCalculator, useSettingsStore } from '../../junction-workbench/settings';
import { DEFAULT_TM_MODEL, OWCZARZY_TM_MODEL } from '../algorithms/tm-model';
import { resetDesignPcrTmSettingsToDefaults } from '../apply-design-pcr-tm';
import { useDesignStore } from '../store';
import { computeDraftAssembly } from '../algorithms/draft-assembly';
import { AssemblyPcrTmConfigurator } from './AssemblyPcrTmConfigurator';

vi.mock('../apply-design-pcr-tm', () => ({
  applyDesignPcrTmModel: vi.fn(() => true),
  refreshDesignPrimerTmsFromSettings: vi.fn(),
  resetDesignPcrTmSettingsToDefaults: vi.fn(() => true),
}));

describe('AssemblyPcrTmConfigurator', () => {
  it('saves primer rules before drafting a Gibson assembly', () => {
    const id = useDesignStore.getState().createDesign('Primer rules', 'circular', 'gibson');
    render(<AssemblyPcrTmConfigurator designId={id} method="gibson" />);
    fireEvent.click(screen.getByTestId('assembly-pcr-mix-settings'));
    fireEvent.click(screen.getByLabelText('Use primer rules'));
    fireEvent.change(screen.getByLabelText('PCR target (°C)'), { target: { value: '6' } });
    expect(screen.getByLabelText('PCR target (°C)')).toHaveValue(6);
    expect(useDesignStore.getState().designs[id].primerDesignConstraints?.targetPcrTm).not.toBe(6);
    fireEvent.change(screen.getByLabelText('PCR target (°C)'), { target: { value: '65' } });
    fireEvent.change(screen.getByLabelText('Overlap (bp)'), { target: { value: '4' } });
    expect(screen.getByLabelText('Overlap (bp)')).toHaveValue(4);
    fireEvent.change(screen.getByLabelText('Overlap (bp)'), { target: { value: '40' } });
    expect(useDesignStore.getState().designs[id].primerDesignConstraints).toEqual({
      targetPcrTm: 65,
      overlapLength: 40,
    });
    fireEvent.change(screen.getByLabelText('Overlap (bp)'), { target: { value: '0' } });
    expect(useDesignStore.getState().designs[id].primerDesignConstraints?.overlapLength).toBe(40);
    fireEvent.blur(screen.getByLabelText('Overlap (bp)'));
    expect(screen.getByLabelText('Overlap (bp)')).toHaveValue(40);
    fireEvent.click(screen.getByLabelText('Use primer rules'));
    expect(useDesignStore.getState().designs[id].primerDesignConstraints).toBeUndefined();
  });

  it('shows calculated Tm under the active model and states when the PCR target cannot be reached', () => {
    useSettingsStore.setState({
      tmModel: OWCZARZY_TM_MODEL,
      tmModelExplicit: true,
      tmConditions: { monovalentMm: 100, divalentMm: 2, dntpMm: 0.2 },
    });
    const id = useDesignStore.getState().createDesign('Short template', 'circular', 'gibson');
    const original = useDesignStore.getState().designs[id];
    const input = {
      ...original,
      primerDesignConstraints: { targetPcrTm: 75, overlapLength: 15 },
      regions: ['a', 'b'].map((key) => ({
        id: key,
        sourceSequenceId: key,
        sourceSequenceName: key,
        sourceStart: 0,
        sourceEnd: 16,
        sequence: 'AT'.repeat(8),
        annotations: [],
        sourceType: 'pcr' as const,
      })),
    };
    const drafted = {
      ...input,
      ...computeDraftAssembly(input, undefined, createAppTmCalculator(null)),
    };
    useDesignStore.setState({ designs: { [id]: drafted } });
    render(<AssemblyPcrTmConfigurator designId={id} method="gibson" />);
    fireEvent.click(screen.getByRole('button', { name: 'Target 75°C outside local Tm range' }));
    const status = screen.getByTestId('assembly-primer-rules-status');
    expect(status).toHaveTextContent(
      `Local binding Tm ${drafted.designPrimers[0].forward.tm.toFixed(1)}`
    );
    expect(status).toHaveTextContent('target 75°C');
    expect(status).toHaveTextContent(
      'Target is outside the available local binding-site Tm range for 4 of 4 primers.'
    );
  });

  it('keeps nM and PBS target inside the settings panel, not on the mix row', () => {
    useSettingsStore.setState({ tmModel: DEFAULT_TM_MODEL, tmModelExplicit: false });
    render(<AssemblyPcrTmConfigurator designId="d1" method="goldengate" />);

    expect(screen.getByTestId('tm-model-select')).toBeInTheDocument();
    expect(screen.queryByTestId('tm-primer-conc')).toBeNull();
    expect(screen.queryByTestId('assembly-workbench-default-pcr-tm')).toBeNull();
    expect(
      screen.getByTestId('assembly-pcr-mix-settings').querySelector('[data-icon="settings-gear"]')
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('assembly-pcr-mix-settings'));
    expect(screen.getByTestId('assembly-pcr-mix-settings-panel')).toBeInTheDocument();
    expect(screen.getByTestId('tm-primer-conc')).toBeInTheDocument();
    expect(screen.getByTestId('assembly-workbench-default-pcr-tm')).toBeInTheDocument();
  });

  it('resets the complete primer Tm configuration from the mix panel', () => {
    render(<AssemblyPcrTmConfigurator designId="d1" method="goldengate" />);

    fireEvent.click(screen.getByTestId('assembly-pcr-mix-settings'));
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));

    expect(resetDesignPcrTmSettingsToDefaults).toHaveBeenCalledWith('d1');
  });

  it.each([
    ['above', 41],
    ['below', 300],
  ])(
    'opens the mix panel %s a trigger with %ipx below it and keeps it inside the window',
    (placement, roomBelow) => {
      useSettingsStore.setState({ tmModel: OWCZARZY_TM_MODEL, tmModelExplicit: true });
      render(<AssemblyPcrTmConfigurator designId="d1" method="goldengate" />);
      const trigger = screen.getByTestId('assembly-pcr-mix-settings');
      const bottom = window.innerHeight - roomBelow;
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
        top: bottom - 27,
        bottom,
        left: 600,
        right: 627,
        width: 27,
        height: 27,
        x: 600,
        y: bottom - 27,
        toJSON: () => ({}),
      } as DOMRect);
      fireEvent.click(trigger);

      const panel = screen.getByTestId('assembly-pcr-mix-settings-panel');
      expect(panel).toHaveAttribute('data-placement', placement);
      expect(panel).toHaveStyle({ overflowY: 'auto' });
      const maxHeight = Number.parseFloat(panel.style.maxHeight);
      const top =
        placement === 'above'
          ? window.innerHeight - Number.parseFloat(panel.style.bottom) - maxHeight
          : Number.parseFloat(panel.style.top);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top + maxHeight).toBeLessThanOrEqual(window.innerHeight);
      expect(screen.getByRole('button', { name: 'Reset to defaults' })).toBeInTheDocument();
    }
  );
});
