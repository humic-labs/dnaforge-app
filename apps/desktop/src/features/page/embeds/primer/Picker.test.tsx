// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock('../../../../platform', () => ({ platform: () => ({ entityDiscovery: mocks }) }));
vi.mock('../../entity-ref/reference-context', () => ({
  useOptionalReferenceContext: () => ({ owningRoot: '/workspace/research' }),
}));
import { PrimerPicker } from './Picker';
function page(items: unknown[]) {
  return {
    items,
    nextCursor: null,
    generation: 'generation',
    coverage: { catalog: 0, registry: 0, primers: items.length, excluded: 0 },
  };
}
function picker() {
  return render(<PrimerPicker data={{}} onAdvance={vi.fn()} onBack={vi.fn()} onCancel={vi.fn()} />);
}
beforeEach(() => {
  mocks.search.mockReset().mockResolvedValue(page([]));
});
describe('PrimerPicker product language', () => {
  it('describes an empty product library without exposing its database', async () => {
    picker();
    expect(await screen.findByText('No primers found')).toBeInTheDocument();
    expect(screen.queryByText(/database/i)).toBeNull();
  });
  it('does not label installation-backed primers with workspace-scope language', async () => {
    mocks.search.mockResolvedValue(
      page([
        {
          id: 'primer-f2-forward',
          type: 'primer',
          name: 'F2 forward',
          sequence: 'ACGTACGT',
          sequenceLength: 8,
          registryId: null,
          path: null,
          localOnly: true,
          kindLabel: 'Primer',
          projectName: null,
        },
      ])
    );
    picker();
    await waitFor(() => expect(screen.getByText('F2 forward')).toBeInTheDocument());
    expect(screen.getByRole('option', { name: /F2 forward/ })).toHaveTextContent('8 bp');
    expect(document.body.textContent).not.toMatch(/workspace only|workspace scope|database/i);
  });
});
