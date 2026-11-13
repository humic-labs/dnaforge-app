import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SequencePaneControls } from './SequencePaneControls';

describe('sequence toolbar fit boundary', () => {
  it('uses the viewer minimum for slider, keyboard and disabled zoom-out button', () => {
    const onZoomChange = vi.fn();
    render(
      <SequencePaneControls
        mode="2d"
        onModeChange={vi.fn()}
        zoom={20}
        minZoom={20}
        onZoomChange={onZoomChange}
      />
    );
    const slider = screen.getByTestId<HTMLInputElement>('sequence-pane-zoom-slider');
    expect(slider.min).toBe('20');
    expect(screen.getByTestId('toolbar-zoom-out')).toBeDisabled();
    fireEvent.keyDown(slider, { key: 'Home' });
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(slider.value).toBe('20');
    expect(onZoomChange.mock.calls.map(([zoom]) => zoom)).toEqual([20, 20]);
    fireEvent.keyDown(slider, { key: 'End' });
    expect(onZoomChange).toHaveBeenLastCalledWith(120);
  });

  it('clamps button steps and reset to the same minimum without a smaller optimistic value', () => {
    const onZoomChange = vi.fn();
    render(
      <SequencePaneControls
        mode="2d"
        onModeChange={vi.fn()}
        zoom={110}
        minZoom={105}
        onZoomChange={onZoomChange}
      />
    );
    fireEvent.click(screen.getByTestId('toolbar-zoom-out'));
    expect(onZoomChange).toHaveBeenLastCalledWith(105);
    expect(screen.getByTestId<HTMLInputElement>('sequence-pane-zoom-slider').value).toBe('105');
    fireEvent.click(screen.getByTestId('toolbar-zoom-display'));
    expect(onZoomChange).toHaveBeenLastCalledWith(105);
  });
});
