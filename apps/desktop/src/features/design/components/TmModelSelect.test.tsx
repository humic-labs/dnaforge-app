import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { installAnalyticsFirehose } from '../../../lib/analytics-firehose';
import { DEFAULT_TM_MODEL } from '../algorithms/tm-model';
import { TmModelSelect } from './TmModelSelect';

describe('Tm model selection privacy', () => {
  it.each([false, true])(
    'keeps polymerase choices private with settingsAppearance=%s',
    (settingsAppearance) => {
      const capture = vi.fn();
      const onChange = vi.fn();
      const uninstall = installAnalyticsFirehose({ capture });
      try {
        render(
          <TmModelSelect
            value={DEFAULT_TM_MODEL}
            onChange={onChange}
            settingsAppearance={settingsAppearance}
          />
        );
        fireEvent.click(screen.getByTestId('tm-model-select'));
        const menu = screen.getByTestId('tm-model-select-menu');
        fireEvent.click(screen.getByTestId('tm-model-select-option-q5-0'));
        expect(onChange).toHaveBeenCalledExactlyOnceWith({
          kind: 'neb',
          prodcode: 'q5-0',
          polymerase: 'q5',
        });
        expect(capture).toHaveBeenCalledWith(
          'interaction_observed',
          expect.objectContaining({ target_test_id: 'tm-model-select' })
        );
        expect(JSON.stringify(capture.mock.calls)).not.toContain('q5-0');
        for (const attribute of ['data-ph-no-capture', 'data-analytics-block', 'data-ph-mask']) {
          expect(menu).toHaveAttribute(attribute);
        }
        expect(menu).toHaveClass('ph-no-capture', 'rr-block');
        expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
      } finally {
        uninstall();
      }
    }
  );
});
