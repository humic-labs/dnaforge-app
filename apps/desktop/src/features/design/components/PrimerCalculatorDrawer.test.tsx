import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PrimerCalculatorDrawer, type PrimerCalculatorDrawerProps } from './PrimerCalculatorDrawer';
import {
  DEFAULT_TM_MODEL,
  DEFAULT_PRIMER_CONC_NM,
  DEFAULT_TM_CONDITIONS,
  OWCZARZY_TM_MODEL,
  type TmModel,
} from '../algorithms/tm-model';

const NEB_Q5: TmModel = { kind: 'neb', prodcode: 'q5-0', polymerase: 'q5' };

function renderDrawer(overrides: Partial<PrimerCalculatorDrawerProps> = {}) {
  const props: PrimerCalculatorDrawerProps = {
    tmModel: DEFAULT_TM_MODEL,
    onChangeModel: vi.fn(),
    concNm: DEFAULT_PRIMER_CONC_NM,
    onChangeConcNm: vi.fn(),
    conditions: DEFAULT_TM_CONDITIONS,
    onChangeConditions: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<PrimerCalculatorDrawer {...props} />) };
}

describe('PrimerCalculatorDrawer', () => {
  it('uses the shared Settings hierarchy for its full-size title', () => {
    renderDrawer();

    const heading = screen.getByRole('heading', { name: 'Tm calculation' });
    expect(heading).toHaveClass('text-xl', 'font-semibold', 'tracking-tight');
    expect(heading).not.toHaveClass('text-sm');
  });

  it('defaults to local and offers a FLAT NEB list (no nested optgroups)', () => {
    renderDrawer();
    const trigger = screen.getByTestId('tm-model-select');
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    expect(screen.getByRole('combobox', { name: 'Tm model' })).toBe(trigger);
    expect(trigger).toHaveAttribute('data-value', 'local');
    fireEvent.click(trigger);
    const menu = screen.getByTestId('tm-model-select-menu');
    expect(menu).toHaveAttribute('data-placement', 'below');
    expect(menu.querySelectorAll('optgroup')).toHaveLength(0);
    const optionValues = screen
      .getAllByRole('option')
      .map((option) => option.getAttribute('data-value'));
    expect(optionValues).toEqual(
      expect.arrayContaining([
        'local',
        'q5-0',
        'q5hs-0',
        'phusion-0',
        'onetaq-0',
        'taq-0',
        'lataq-0',
      ])
    );
    expect(screen.getByTestId('tm-model-select-option-local')).toHaveTextContent(
      'Default (SantaLucia)'
    );
    expect(screen.getByTestId('tm-model-select-option-q5-0')).toHaveTextContent('NEB Q5');
    expect(screen.getByTestId('tm-model-select-option-phusion-0')).toHaveTextContent(
      'NEB Phusion (HF)'
    );
  });

  it('selecting a NEB polymerase calls onChangeModel with the NEB model (prodcode + family)', () => {
    const { props } = renderDrawer();
    fireEvent.click(screen.getByTestId('tm-model-select'));
    fireEvent.click(screen.getByTestId('tm-model-select-option-phusion-0'));
    expect(props.onChangeModel).toHaveBeenCalledWith({
      kind: 'neb',
      prodcode: 'phusion-0',
      polymerase: 'phusion',
    });
  });

  it('reflects a NEB model passed in (select shows its prodcode + note appears)', () => {
    renderDrawer({ tmModel: NEB_Q5 });
    expect(screen.getByTestId('tm-model-select')).toHaveAttribute('data-value', 'q5-0');
    expect(screen.getByTestId('tm-model-neb-note')).toBeTruthy();
  });

  it('shows the NEB provenance note only when a NEB model is active', () => {
    const { rerender } = renderDrawer();
    expect(screen.queryByTestId('tm-model-neb-note')).toBeNull();
    rerender(
      <PrimerCalculatorDrawer
        tmModel={NEB_Q5}
        onChangeModel={vi.fn()}
        concNm={DEFAULT_PRIMER_CONC_NM}
        onChangeConcNm={vi.fn()}
      />
    );
    expect(screen.getByTestId('tm-model-neb-note').textContent).toContain('Q5');
  });

  it('shows the concentration and reports edits (Tm is concentration-dependent)', () => {
    const { props } = renderDrawer({ concNm: 500 });
    const input = screen.getByTestId('tm-primer-conc') as HTMLInputElement;
    expect(input.value).toBe('500');
    fireEvent.change(input, { target: { value: '250' } });
    expect(props.onChangeConcNm).toHaveBeenCalledWith(250);
  });

  it('offers Owczarzy and shows Na/Mg/dNTP fields only when it is active', () => {
    const { rerender } = renderDrawer();
    fireEvent.click(screen.getByTestId('tm-model-select'));
    expect(screen.getByTestId('tm-model-select-option-owczarzy')).toBeInTheDocument();
    expect(screen.queryByTestId('tm-owczarzy-conditions')).toBeNull();

    rerender(
      <PrimerCalculatorDrawer
        tmModel={OWCZARZY_TM_MODEL}
        onChangeModel={vi.fn()}
        concNm={DEFAULT_PRIMER_CONC_NM}
        onChangeConcNm={vi.fn()}
        conditions={DEFAULT_TM_CONDITIONS}
        onChangeConditions={vi.fn()}
      />
    );
    expect(screen.getByTestId('tm-owczarzy-conditions')).toBeTruthy();
    expect(screen.getByTestId('tm-monovalent')).toBeTruthy();
    expect(screen.getByTestId('tm-divalent')).toBeTruthy();
    expect(screen.getByTestId('tm-dntp')).toBeTruthy();
  });

  it('editing an Owczarzy condition reports the patch', () => {
    const { props } = renderDrawer({ tmModel: OWCZARZY_TM_MODEL });
    fireEvent.change(screen.getByTestId('tm-divalent'), { target: { value: '2' } });
    expect(props.onChangeConditions).toHaveBeenCalledWith({ divalentMm: 2 });
  });

  it('offers one complete reset action', () => {
    const onReset = vi.fn();
    renderDrawer({ onReset });

    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));

    expect(onReset).toHaveBeenCalledOnce();
  });
});
