import {
  usePresentationOverlay,
  PresentationScopeContext,
} from '../../presentation/PresentationSurface';
import { toUserMessage } from '@waypoint/user-messages';
import { useMemo, useState } from 'react';
import { Button, Notice, TextArea, TextField, UI_MODAL_LAYER_CLASS } from '../../components/ui';

import { useComputeStore } from './store';

type Mode = 'runpod' | 'advanced';

function runpodManifest(name: string, endpointId: string): Record<string, unknown> {
  const id = `runpod-${endpointId.toLowerCase()}`;
  return {
    schemaVersion: 2,
    id,
    displayName: name,
    summary: `Optional connection to your existing ${name} Runpod Serverless endpoint. Protocol-tested template; this deployment is not yet live-qualified in DNAForge.`,
    docsUrl: 'https://docs.runpod.io/serverless/endpoints/overview',
    keyPageUrl: 'https://console.runpod.io/user/credentials',
    termsUrl: 'https://www.runpod.io/legal/terms-of-service',
    privacyUrl: 'https://www.runpod.io/legal/privacy-policy',
    transport: 'rest',
    baseUrl: `https://api.runpod.ai/v2/${endpointId}`,
    driver: {
      kind: 'http-job',
      submit: {
        method: 'POST',
        idPath: 'id',
        bodyTemplate: { input: '$settings' },
      },
      status: {
        method: 'GET',
        pathTemplate: '/status/{remote_id}',
        statePath: 'status',
        statusMap: {
          IN_QUEUE: 'queued',
          IN_PROGRESS: 'running',
          COMPLETED: 'completed',
          FAILED: 'failed',
          CANCELLED: 'canceled',
          TIMED_OUT: 'failed',
        },
      },
      result: { payloadPath: 'output', codec: 'raw-json' },
      cancel: {
        method: 'POST',
        pathTemplate: '/cancel/{remote_id}',
        statePath: 'status',
      },
    },
    auth: { scheme: 'header', headerName: 'authorization' },
    verify: { method: 'GET', target: '/health', expectKey: 'jobs' },
    catalog: 'static',
    jobModel: 'async',
    staging: 'inline',
    cost: 'rate-card',
    staticTools: [
      {
        id: 'endpoint',
        displayName: `${name} inference`,
        path: '/run',
        outputKind: 'binary',
        description:
          'Run this endpoint with its native JSON input. DNAForge preserves the provider-native output without claiming a model-specific scientific schema.',
        keywords: ['runpod', 'serverless', 'inference'],
        inputSchema: {
          type: 'object',
          description: 'The JSON object expected by this endpoint worker.',
        },
      },
    ],
    disclosure: `This sends job inputs to ${name} on Runpod under your own Runpod account. ${name} bills that account for worker execution; DNAForge does not charge for it.`,
    retentionNote:
      'Runpod keeps completed Serverless job results for a limited period. Import useful output promptly.',
    cancellation: {
      mode: 'provider',
      note: 'Runpod accepts cancellation requests for queued or running Serverless jobs.',
    },
    rateLimitRps: 2,
  };
}

export function AddComputeEndpointDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const presentationOverlay = usePresentationOverlay('modal');

  const installManifest = useComputeStore((state) => state.installManifest);
  const [mode, setMode] = useState<Mode>('runpod');
  const [name, setName] = useState('');
  const [endpointId, setEndpointId] = useState('');
  const [manifestJson, setManifestJson] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runpodProblem = useMemo(() => {
    const trimmedName = name.trim();
    const trimmedEndpoint = endpointId.trim();
    if (!trimmedName || !trimmedEndpoint) return null;
    if (trimmedName.length > 80) return 'Endpoint name must be 80 characters or fewer.';
    if (!/^[A-Za-z0-9_-]{2,48}$/.test(trimmedEndpoint)) {
      return 'Runpod endpoint ID must be 2–48 letters, numbers, dashes, or underscores.';
    }
    return null;
  }, [endpointId, name]);

  if (!open) return null;

  const canSubmit =
    !busy &&
    (mode === 'runpod'
      ? Boolean(name.trim() && endpointId.trim() && !runpodProblem)
      : Boolean(manifestJson.trim()));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const serialized =
        mode === 'runpod'
          ? JSON.stringify(runpodManifest(name.trim(), endpointId.trim()), null, 2)
          : manifestJson;
      const result = await installManifest(serialized);
      if (!result.ok) {
        setError(toUserMessage(result, 'operation.failed'));
        return;
      }
      onClose();
    } catch (cause) {
      setError(toUserMessage(cause, 'operation.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PresentationScopeContext.Provider value={presentationOverlay.scope}>
      <div
        className={`fixed inset-0 ${UI_MODAL_LAYER_CLASS} flex items-center justify-center bg-black/40 p-4`}
        role="dialog"
        aria-modal="true"
        aria-label="Add compute endpoint"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !busy) onClose();
        }}
        ref={presentationOverlay.bindRef(undefined, '0')}
      >
        <div className="flex max-h-[88vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-bg shadow-xl">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-medium text-fg">Add compute endpoint</h2>
              <p className="mt-0.5 text-[11px] text-fg-subtle">
                Install configuration only. API keys are verified and stored separately.
              </p>
            </div>
            <button
              type="button"
              aria-label="Close"
              className="text-fg-subtle hover:text-fg disabled:opacity-50"
              disabled={busy}
              onClick={onClose}
            >
              ×
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
            <div className="flex gap-2" role="tablist" aria-label="Endpoint type">
              <Button
                type="button"
                role="tab"
                aria-selected={mode === 'runpod'}
                variant={mode === 'runpod' ? 'primary' : 'secondary'}
                onClick={() => setMode('runpod')}
              >
                Runpod Serverless
              </Button>
              <Button
                type="button"
                role="tab"
                aria-selected={mode === 'advanced'}
                variant={mode === 'advanced' ? 'primary' : 'secondary'}
                onClick={() => setMode('advanced')}
              >
                Advanced manifest
              </Button>
            </div>

            {mode === 'runpod' ? (
              <div className="space-y-4">
                <p className="text-xs leading-5 text-fg-muted">
                  Point DNAForge at one existing Runpod Serverless endpoint. Its model and worker
                  stay provider-native; DNAForge owns only the job lifecycle, audit trail, and
                  imported result.
                </p>
                <p className="text-xs leading-5 text-fg-muted">
                  This optional template is protocol-tested, not live-qualified. You do not need a
                  Runpod account to use Jobs or the other providers.
                </p>
                <div className="space-y-1.5">
                  <label htmlFor="compute-endpoint-name" className="text-xs font-medium text-fg">
                    Endpoint name
                  </label>
                  <TextField
                    id="compute-endpoint-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Protein Lab GPU"
                    disabled={busy}
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="runpod-endpoint-id" className="text-xs font-medium text-fg">
                    Runpod endpoint ID
                  </label>
                  <TextField
                    id="runpod-endpoint-id"
                    value={endpointId}
                    onChange={(event) => setEndpointId(event.target.value)}
                    placeholder="Your endpoint ID, not the API key"
                    spellCheck={false}
                    disabled={busy}
                  />
                  <p className="text-[11px] text-fg-subtle">
                    The API key is requested after installation and never enters this manifest.
                  </p>
                </div>
                {runpodProblem && <Notice tone="error">{runpodProblem}</Notice>}
              </div>
            ) : (
              <div className="space-y-2">
                <label htmlFor="compute-manifest-json" className="text-xs font-medium text-fg">
                  Manifest JSON
                </label>
                <TextArea
                  id="compute-manifest-json"
                  monospace
                  rows={12}
                  value={manifestJson}
                  onChange={(event) => setManifestJson(event.target.value)}
                  placeholder="Paste a schemaVersion 2 compute manifest"
                  spellCheck={false}
                  disabled={busy}
                />
                <p className="text-[11px] leading-4 text-fg-subtle">
                  Supported reusable drivers: MCP tool map, NVIDIA Cloud Functions, and asynchronous
                  HTTP jobs. Credential or routing headers in a manifest are rejected.
                </p>
              </div>
            )}

            {error && (
              <Notice tone="error">
                <span className="whitespace-pre-wrap">
                  {toUserMessage(error, 'operation.failed')}
                </span>
              </Notice>
            )}
          </div>

          <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
            <Button type="button" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => void submit()}
              disabled={!canSubmit}
            >
              {busy ? 'Installing and restarting…' : 'Install endpoint'}
            </Button>
          </div>
        </div>
      </div>
    </PresentationScopeContext.Provider>
  );
}
