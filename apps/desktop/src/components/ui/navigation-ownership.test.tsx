import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NavigationList, NavigationRow } from './navigation';

afterEach(() => vi.useRealTimers());

it('keeps activation and actions separate and shows the action tooltip without a dwell delay', () => {
  vi.useFakeTimers();
  const activate = vi.fn();
  const move = vi.fn();
  render(
    <NavigationList role="tablist" aria-label="Sessions" aria-orientation="vertical">
      <NavigationRow
        title="Shell"
        detail="/a/long/workspace/path"
        status={{ label: 'Ready', tone: 'success' }}
        selection={{ kind: 'tab', selected: true, tabIndex: 0 }}
        onActivate={activate}
        actions={[{ id: 'move-to-tab', label: 'Move terminal to tab', onInvoke: move }]}
      />
    </NavigationList>
  );
  const primary = screen.getByRole('tab');
  const action = screen.getByRole('button', { name: 'Move terminal to tab' });
  expect(primary).toHaveAttribute('aria-selected', 'true');
  expect(primary.querySelector('button')).toBeNull();
  fireEvent.click(primary);
  expect(activate).toHaveBeenCalledOnce();
  fireEvent.mouseEnter(action);
  act(() => vi.advanceTimersByTime(0));
  const tooltip = screen.getByRole('tooltip');
  expect(tooltip).toHaveTextContent('Move terminal to tab');
  expect(action).toHaveAttribute('aria-describedby', tooltip.id);
  fireEvent.click(action);
  expect(move).toHaveBeenCalledOnce();
  expect(activate).toHaveBeenCalledOnce();
});

it('keeps private appearance props out of the shared navigation DOM', () => {
  const override = { className: 'private-style', style: { padding: 5, fontSize: 11 } };
  const { container } = render(
    <NavigationList {...override}>
      <NavigationRow
        {...override}
        title="Shell"
        detail="/workspace"
        selection={{ kind: 'none' }}
        onActivate={() => undefined}
      />
    </NavigationList>
  );
  expect(container.querySelector('.private-style')).toBeNull();
  for (const element of container.querySelectorAll(
    '[data-ui-navigation-list], [data-ui-navigation-row]'
  ))
    expect(element).not.toHaveAttribute('style');
});
