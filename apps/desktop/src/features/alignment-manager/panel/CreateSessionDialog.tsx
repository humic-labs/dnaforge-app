import {
  usePresentationOverlay,
  PresentationScopeContext,
} from '../../../presentation/PresentationSurface';
import { toUserMessage, userMessage } from '@waypoint/user-messages';
import React, { useState, useCallback } from 'react';
import type { SessionMode } from '../types';

interface CreateSessionDialogProps {
  referenceName: string;
  queryFiles: Array<{ path: string; name: string }>;
  onCreate: (name: string, mode: SessionMode) => void;
  onCancel: () => void;
}

export function CreateSessionDialog({
  referenceName,
  queryFiles,
  onCreate,
  onCancel,
}: CreateSessionDialogProps) {
  const presentationOverlay = usePresentationOverlay('modal');

  const [sessionName, setSessionName] = useState('');
  const [mode, setMode] = useState<SessionMode>('one-per-clone');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();

      const trimmedName = sessionName.trim();
      if (!trimmedName) {
        setError(userMessage('failure.session-name-is-required'));
        return;
      }

      onCreate(trimmedName, mode);
    },
    [sessionName, mode, onCreate]
  );

  const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSessionName(e.target.value);
    setError(null);
  }, []);

  return (
    <PresentationScopeContext.Provider value={presentationOverlay.scope}>
      <div
        className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
        onClick={onCancel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        ref={presentationOverlay.bindRef(undefined, '0')}
      >
        <div
          className="bg-bg border border-border rounded-lg shadow-xl w-full max-w-md mx-4"
          onClick={(e) => e.stopPropagation()}
        >
          {}
          <div className="px-6 py-4 border-b border-border">
            <h2 id="dialog-title" className="text-lg font-medium text-text-primary">
              Create Verification Session
            </h2>
          </div>

          {}
          <form onSubmit={handleSubmit}>
            <div className="px-6 py-4 space-y-4">
              {}
              <div>
                <label className="block text-xs text-text-secondary mb-1">Reference</label>
                <div className="text-sm text-text-primary font-medium">{referenceName}</div>
              </div>

              {}
              <div>
                <label htmlFor="session-name" className="block text-xs text-text-secondary mb-1">
                  Session Name <span className="text-red-400">*</span>
                </label>
                <input
                  id="session-name"
                  type="text"
                  value={sessionName}
                  onChange={handleNameChange}
                  placeholder="e.g., Cloning Run 1"
                  className={`w-full px-3 py-2 bg-bg-secondary border rounded text-sm text-text-primary placeholder:text-text-secondary/50 focus:outline-none focus:ring-2 focus:ring-accent ${
                    error ? 'border-red-500' : 'border-border'
                  }`}
                  autoFocus
                />
                {error && (
                  <p className="mt-1 text-xs text-red-400">
                    {toUserMessage(error, 'alignment.failed')}
                  </p>
                )}
              </div>

              {}
              <div>
                <label className="block text-xs text-text-secondary mb-1">
                  Files to align ({queryFiles.length})
                </label>
                <div className="max-h-32 overflow-y-auto bg-bg-secondary border border-border rounded p-2">
                  {queryFiles.map((file, idx) => (
                    <div key={idx} className="text-sm text-text-primary truncate py-0.5">
                      • {file.name}
                    </div>
                  ))}
                </div>
              </div>

              {}
              <div>
                <label className="block text-xs text-text-secondary mb-2">Mode</label>
                <div className="space-y-2">
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="radio"
                      name="mode"
                      value="one-per-clone"
                      checked={mode === 'one-per-clone'}
                      onChange={() => setMode('one-per-clone')}
                      className="mt-1"
                    />
                    <div>
                      <div className="text-sm text-text-primary font-medium">
                        1 clone per sequence
                      </div>
                      <div className="text-xs text-text-secondary">
                        Each file is a different clone. Compare results side-by-side.
                      </div>
                    </div>
                  </label>

                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="radio"
                      name="mode"
                      value="multi-per-clone"
                      checked={mode === 'multi-per-clone'}
                      onChange={() => setMode('multi-per-clone')}
                      className="mt-1"
                    />
                    <div>
                      <div className="text-sm text-text-primary font-medium">
                        Multiple sequences per clone
                      </div>
                      <div className="text-xs text-text-secondary">
                        All files are from the same clone (e.g., different primers). Merge coverage.
                      </div>
                    </div>
                  </label>
                </div>
              </div>
            </div>

            {}
            <div className="px-6 py-4 border-t border-border flex justify-end gap-3">
              <button
                type="button"
                onClick={onCancel}
                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-sm bg-accent text-white rounded hover:bg-accent/80"
              >
                Create & Align
              </button>
            </div>
          </form>
        </div>
      </div>
    </PresentationScopeContext.Provider>
  );
}
