import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { AdvancedSettingsDrawer } from './AdvancedSettingsDrawer';
import { ViewRecipeDropdown } from './ViewRecipeDropdown';
import { availableViewRecipesForStructure } from '../utils/viewRecipeAvailability';
import {
  DEFAULT_MOLECULAR_PRESENTATION_PREFERENCES,
  useMolecularPresentationPreferences,
} from '../molstar/molecularPresentationPreferences';
import { resolveMolViewSpecRenderProfile } from '../molstar/molecularRenderProfile';

describe('authored view framing', () => {
  it('authors framing only through the explicit View navigation action', () => {
    const onUseCurrentFraming = vi.fn();
    const onSettingsChange = vi.fn();
    render(
      <AdvancedSettingsDrawer
        isOpen
        onClose={vi.fn()}
        settings={{}}
        onSettingsChange={onSettingsChange}
        onUseCurrentFraming={onUseCurrentFraming}
      />
    );
    expect(onUseCurrentFraming).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Use current framing' }));
    expect(onUseCurrentFraming).toHaveBeenCalledOnce();
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it('disables framing while the authored scene is not ready', () => {
    const onUseCurrentFraming = vi.fn();
    render(
      <AdvancedSettingsDrawer
        isOpen
        onClose={vi.fn()}
        settings={{}}
        onSettingsChange={vi.fn()}
        onUseCurrentFraming={onUseCurrentFraming}
        framingDisabled
      />
    );
    const action = screen.getByRole('button', { name: 'Use current framing' });
    expect(action).toBeDisabled();
    fireEvent.click(action);
    expect(onUseCurrentFraming).not.toHaveBeenCalled();
  });
});

describe('new-scene nucleic acid preferences', () => {
  it('does not offer a preference that can hide the sequence panel', () => {
    const onSettingsChange = vi.fn();
    render(
      <AdvancedSettingsDrawer
        isOpen
        onClose={vi.fn()}
        settings={{}}
        onSettingsChange={onSettingsChange}
      />
    );
    expect(screen.queryByRole('switch', { name: /sequence/i })).toBeNull();
    expect(onSettingsChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reset to Defaults' }));
    expect(screen.queryByRole('switch', { name: /sequence/i })).toBeNull();
  });
  beforeEach(() =>
    useMolecularPresentationPreferences
      .getState()
      .update(DEFAULT_MOLECULAR_PRESENTATION_PREFERENCES)
  );

  it('changes the actual path preference without changing selected-base chemistry', () => {
    render(
      <AdvancedSettingsDrawer isOpen onClose={vi.fn()} settings={{}} onSettingsChange={vi.fn()} />
    );
    const backbone = screen.getByRole('combobox', { name: 'Nucleic acid backbone' });
    expect(backbone).toHaveValue('ribbon');
    fireEvent.change(backbone, { target: { value: 'authored' } });
    expect(useMolecularPresentationPreferences.getState().preferences).toMatchObject({
      nucleotideBackbone: 'authored',
      nucleotideDetail: 'simplified',
    });

    const b = MVSData.createBuilder();
    b.download({ url: 'structure.cif' })
      .parse({ format: 'mmcif' })
      .modelStructure()
      .component({ selector: 'nucleic' })
      .representation({
        type: 'cartoon',
        size_factor: 0.35,
        custom: {
          molstar_representation_params: {
            sizeFactor: 0.05,
            aspectRatio: 1,
            nucleicProfile: 'elliptical',
          },
        },
      });
    const result = resolveMolViewSpecRenderProfile(b.getState(), 'default', () => true);
    if (result.kind === 'multiple') throw Error('Expected one scene');
    const rep = result.root.children![0].children![0].children![0].children![0].children![0];
    expect(rep.params).toMatchObject({ size_factor: 0.35 });
    expect(rep.custom?.molstar_representation_params).toMatchObject({
      sizeFactor: 0.05,
      aspectRatio: 1,
      nucleicProfile: 'elliptical',
    });
    expect(
      JSON.parse(localStorage.getItem('dnaforge:molecular-presentation-preferences')!).state
        .preferences.nucleotideBackbone
    ).toBe('authored');
    fireEvent.click(screen.getByRole('button', { name: 'Reset to Defaults' }));
    expect(backbone).toHaveValue('ribbon');
  });
});

it('Escape dismisses the active advanced-settings drawer', () => {
  const onClose = vi.fn();
  render(
    <AdvancedSettingsDrawer isOpen onClose={onClose} settings={{}} onSettingsChange={vi.fn()} />
  );
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledOnce();
});

it.each(['trigger', 'menu option'])(
  'Escape closes only the recipe picker with focus on %s',
  (target) => {
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    try {
      const onClose = vi.fn();
      render(
        <AdvancedSettingsDrawer
          isOpen
          onClose={onClose}
          settings={{}}
          onSettingsChange={vi.fn()}
          primaryControls={
            <ViewRecipeDropdown
              layout="sidebar"
              activeRecipeId="cartoon"
              recipes={availableViewRecipesForStructure({ source: 'pdb', pdbId: '1FS0' })}
              onSelectRecipe={vi.fn()}
            />
          }
        />
      );
      const trigger = screen.getByTestId('structure-view-recipe-trigger');
      trigger.focus();
      fireEvent.click(trigger);
      expect(screen.getByTestId('structure-view-recipe-menu')).toBeInTheDocument();
      const focused = target === 'trigger' ? trigger : screen.getAllByRole('menuitemradio')[0];
      focused.focus();
      fireEvent.keyDown(focused, { key: 'Escape' });
      expect(screen.queryByTestId('structure-view-recipe-menu')).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
      expect(trigger).toHaveFocus();
      fireEvent.keyDown(trigger, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      frame.mockRestore();
    }
  }
);

it('leaves the drawer open when Escape belongs to a notebook picker above it', () => {
  const onClose = vi.fn();
  render(
    <>
      <AdvancedSettingsDrawer isOpen onClose={onClose} settings={{}} onSettingsChange={vi.fn()} />
      <div role="dialog" aria-modal="true" aria-label="Notebook picker">
        <input aria-label="Picker search" />
      </div>
    </>
  );
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Picker search' }), { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();
});
