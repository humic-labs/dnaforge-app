import { userMessage } from '@waypoint/user-messages';
import { expectToastCall } from '../../test/toast-assertions';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileHandlingSettings } from './FileHandlingSettings';
import { REVEAL_OPEN_DOCUMENT_EVENT } from './handler-status-source';

const mocks = vi.hoisted(() => ({
  queryHandlers: vi.fn(),
  requestDefault: vi.fn(),
  addToast: vi.fn(),
  dialogOpen: vi.fn(),
  openQuickLookSource: vi.fn(),
}));

vi.mock('../../platform', () => ({
  platform: () => ({
    fileAssociations: {
      queryHandlers: mocks.queryHandlers,
      requestDefault: mocks.requestDefault,
    },
    dialog: {
      open: mocks.dialogOpen,
    },
  }),
}));
vi.mock('../../lib/open-quick-look-source', () => ({
  openQuickLookSource: mocks.openQuickLookSource,
}));
vi.mock('../../stores/toast-store', () => ({
  useToastStore: {
    getState: () => ({ addToast: mocks.addToast }),
  },
}));

describe('FileHandlingSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryHandlers.mockResolvedValue([
      {
        familyId: 'genbank',
        state: 'other',
        handlerName: 'Preview',
        handlerPath: '/System/Applications/Preview.app',
        defaultAction: 'native',
        detail: null,
      },
      {
        familyId: 'snapgene',
        state: 'default',
        handlerName: 'DNAForge',
        handlerPath: '/Applications/DNAForge.app',
        defaultAction: 'native',
        detail: null,
      },
    ]);
    mocks.requestDefault.mockResolvedValue({
      familyId: 'genbank',
      outcome: 'requested',
      detail: null,
    });
    mocks.dialogOpen.mockResolvedValue(null);
    mocks.openQuickLookSource.mockResolvedValue('tab-1');
  });

  it('keeps the newest status when an older native query finishes last', async () => {
    let finishOldQuery: (value: unknown) => void = () => {};
    mocks.queryHandlers.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldQuery = resolve;
        })
    );
    render(<FileHandlingSettings />);
    fireEvent.focus(window);
    await waitFor(() =>
      expect(screen.getByTestId('file-handler-status-genbank')).toHaveTextContent(
        'Default: Preview'
      )
    );
    await act(async () =>
      finishOldQuery([
        {
          familyId: 'genbank',
          state: 'default',
          handlerName: 'DNAForge',
          handlerPath: null,
          defaultAction: 'native',
          detail: null,
        },
      ])
    );
    expect(screen.getByTestId('file-handler-status-genbank')).toHaveTextContent('Default: Preview');
  });

  it('shows query failures and lets a fresh query recover without losing preview access', async () => {
    mocks.queryHandlers.mockRejectedValueOnce(new Error('Native status service unavailable'));
    render(<FileHandlingSettings />);
    await waitFor(() =>
      expect(screen.getByTestId('file-handler-status-genbank')).toHaveTextContent(
        userMessage('fileAssociations.unavailable')
      )
    );
    expect(screen.getByTestId('file-handler-preview-genbank')).toBeEnabled();
    fireEvent.click(screen.getByTestId('file-handler-refresh'));
    await waitFor(() =>
      expect(screen.getByTestId('file-handler-status-genbank')).toHaveTextContent(
        'Default: Preview'
      )
    );
  });

  it('does not announce success from a confirmation superseded by a newer native query', async () => {
    let finishConfirmation: (value: unknown) => void = () => {};
    render(<FileHandlingSettings />);
    const action = await screen.findByRole('button', { name: 'Make DNAForge default' });
    mocks.queryHandlers.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishConfirmation = resolve;
        })
    );
    fireEvent.click(action);
    await waitFor(() => expect(mocks.queryHandlers).toHaveBeenCalledTimes(2));
    fireEvent.focus(window);
    await waitFor(() => expect(mocks.queryHandlers).toHaveBeenCalledTimes(3));
    await act(async () =>
      finishConfirmation([
        {
          familyId: 'genbank',
          state: 'default',
          handlerName: 'DNAForge',
          handlerPath: null,
          defaultAction: 'native',
          detail: null,
        },
      ])
    );
    expect(screen.getByTestId('file-handler-status-genbank')).toHaveTextContent('Default: Preview');
    expect(mocks.addToast).not.toHaveBeenCalled();
  });

  it('reports a preview failure without leaving Settings or locking its controls', async () => {
    mocks.dialogOpen.mockResolvedValue('/Users/scientist/pUC19.gb');
    mocks.openQuickLookSource.mockRejectedValueOnce(new Error('Source is unreadable'));
    const onReveal = vi.fn();
    window.addEventListener(REVEAL_OPEN_DOCUMENT_EVENT, onReveal);
    try {
      render(<FileHandlingSettings />);
      fireEvent.click(screen.getByTestId('file-handler-preview-genbank'));
      await waitFor(() =>
        expect(mocks.addToast).toHaveBeenCalledWith(
          userMessage('file.previewFailed'),
          expect.any(Object)
        )
      );
      expect(onReveal).not.toHaveBeenCalled();
      expect(screen.getByTestId('file-handler-preview-genbank')).toBeEnabled();
    } finally {
      window.removeEventListener(REVEAL_OPEN_DOCUMENT_EVENT, onReveal);
    }
  });

  it('distinguishes changing a default from opening a preview and serializes actions', async () => {
    let finishRequest: (value: unknown) => void = () => {};
    mocks.requestDefault.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRequest = resolve;
        })
    );
    render(<FileHandlingSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Make DNAForge default' }));
    expect(screen.getByTestId('file-handler-preview-genbank')).toHaveTextContent('Preview a file');
    expect(screen.getByTestId('file-handler-preview-snapgene')).toBeDisabled();
    await act(async () =>
      finishRequest({ familyId: 'genbank', outcome: 'requested', detail: null })
    );
    expectToastCall(
      mocks.addToast,
      'The system did not report DNAForge as the default app.',
      'warning'
    );
    expect(screen.getByTestId('file-handler-preview-snapgene')).toBeEnabled();
  });

  it.each([
    { selection: null, shouldWarn: false },
    { selection: '/Users/scientist/wrong.dna', shouldWarn: true },
  ])(
    'keeps Settings open when the selection cannot open: $selection',
    async ({ selection, shouldWarn }) => {
      mocks.dialogOpen.mockResolvedValue(selection);
      const onReveal = vi.fn();
      window.addEventListener(REVEAL_OPEN_DOCUMENT_EVENT, onReveal);
      try {
        render(<FileHandlingSettings />);
        fireEvent.click(screen.getByTestId('file-handler-preview-genbank'));
        await waitFor(() => expect(mocks.dialogOpen).toHaveBeenCalledOnce());
        await waitFor(() =>
          expect(screen.getByTestId('file-handler-preview-genbank')).toBeEnabled()
        );
        expect(mocks.openQuickLookSource).not.toHaveBeenCalled();
        expect(onReveal).not.toHaveBeenCalled();
        expect(mocks.addToast).toHaveBeenCalledTimes(shouldWarn ? 1 : 0);
      } finally {
        window.removeEventListener(REVEAL_OPEN_DOCUMENT_EVENT, onReveal);
      }
    }
  );

  it('shows every supported extension, what DNAForge does, and the current handler', async () => {
    render(<FileHandlingSettings />);

    expect(await screen.findByTestId('file-handler-genbank')).toHaveTextContent(
      '.gb, .gbk, .gbff, .genbank'
    );
    expect(screen.getByTestId('file-handling-settings')).toHaveTextContent('Import to Edit');
    expect(screen.getByTestId('file-handler-genbank')).toHaveTextContent('Preview');
    expect(screen.getByTestId('file-handler-genbank')).toHaveTextContent(
      '.gb, .gbk, .gbff, .genbank'
    );
    expect(screen.getByTestId('file-handler-preview-genbank')).toHaveTextContent('Preview a file');
    expect(screen.getByTestId('file-handler-snapgene')).toHaveTextContent('.dna');
    expect(screen.getByTestId('file-handler-snapgene')).toHaveTextContent('Imports as GenBank');
    expect(screen.getByTestId('file-handler-snapgene')).toHaveTextContent(
      'format compatibility is under review'
    );
    expect(screen.queryByText('format-validation-pending')).toBeNull();
  });

  it('re-queries after a native request and reports the factual default', async () => {
    mocks.queryHandlers
      .mockResolvedValueOnce([
        {
          familyId: 'genbank',
          state: 'other',
          handlerName: 'Preview',
          handlerPath: null,
          defaultAction: 'native',
          detail: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          familyId: 'genbank',
          state: 'default',
          handlerName: 'DNAForge',
          handlerPath: null,
          defaultAction: 'native',
          detail: null,
        },
      ]);
    render(<FileHandlingSettings />);
    const action = await screen.findByRole('button', { name: 'Make DNAForge default' });

    fireEvent.click(action);

    await waitFor(() =>
      expect(screen.getByTestId('file-handler-genbank')).toHaveTextContent('DNAForge is default')
    );
    expect(mocks.requestDefault).toHaveBeenCalledWith('genbank');
    expectToastCall(
      mocks.addToast,
      'DNAForge is now the default app for GenBank files.',
      'success'
    );
  });

  it('labels the Windows system-settings action without claiming it changes the default', async () => {
    mocks.queryHandlers.mockResolvedValue([
      {
        familyId: 'genbank',
        state: 'other',
        handlerName: 'Notepad',
        handlerPath: null,
        defaultAction: 'system-settings',
        detail: null,
      },
    ]);
    mocks.requestDefault.mockResolvedValue({
      familyId: 'genbank',
      outcome: 'opened-settings',
      detail: null,
    });
    render(<FileHandlingSettings />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open Windows Default Apps' }));

    await waitFor(() => expect(mocks.requestDefault).toHaveBeenCalledWith('genbank'));
    expect(mocks.addToast).not.toHaveBeenCalledWith(expect.any(String), 'success');
  });

  it('shows Finder steps when this window cannot register itself as the default', async () => {
    mocks.queryHandlers.mockResolvedValue([
      {
        familyId: 'genbank',
        state: 'other',
        handlerName: 'SnapGene',
        handlerPath: '/Applications/SnapGene.app',
        defaultAction: 'instructions',
        detail: null,
      },
      {
        familyId: 'snapgene',
        state: 'other',
        handlerName: 'SnapGene',
        handlerPath: '/Applications/SnapGene.app',
        defaultAction: 'instructions',
        detail: null,
      },
    ]);
    render(<FileHandlingSettings />);

    expect(await screen.findByTestId('file-handler-howto')).toHaveTextContent('File → Get Info');
    expect(screen.getByTestId('file-handler-howto')).toHaveTextContent('Change All');
    expect(screen.getByTestId('file-handler-howto')).toHaveTextContent(
      'This development window cannot register itself as the default app.'
    );
    expect(screen.queryByRole('button', { name: 'Make DNAForge default' })).toBeNull();
  });

  it('opens a chosen file as a Quick Look and leaves Settings', async () => {
    mocks.dialogOpen.mockResolvedValue('/Users/scientist/Downloads/pUC19.gb');
    const revealed: string[] = [];
    const onReveal = (event: Event) => {
      revealed.push(event.type);
    };
    window.addEventListener(REVEAL_OPEN_DOCUMENT_EVENT, onReveal);
    render(<FileHandlingSettings />);
    fireEvent.click(await screen.findByTestId('file-handler-preview-genbank'));

    await waitFor(() => expect(mocks.openQuickLookSource).toHaveBeenCalled());
    expect(mocks.dialogOpen).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Preview a GenBank file',
        filters: [{ name: 'GenBank', extensions: ['gb', 'gbk', 'gbff', 'genbank'] }],
      })
    );
    expect(mocks.openQuickLookSource).toHaveBeenCalledWith({
      sourcePath: '/Users/scientist/Downloads/pUC19.gb',
      familyId: 'genbank',
      sourceSurface: 'menu',
    });
    expect(revealed).toEqual([REVEAL_OPEN_DOCUMENT_EVENT]);
    window.removeEventListener(REVEAL_OPEN_DOCUMENT_EVENT, onReveal);
  });

  it('re-queries the factual handler state when the app regains focus', async () => {
    render(<FileHandlingSettings />);
    await waitFor(() => expect(mocks.queryHandlers).toHaveBeenCalledOnce());

    fireEvent.focus(window);

    await waitFor(() => expect(mocks.queryHandlers).toHaveBeenCalledTimes(2));
  });
});
