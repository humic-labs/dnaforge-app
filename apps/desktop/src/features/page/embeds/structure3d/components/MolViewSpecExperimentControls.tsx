import { toUserMessage } from '@waypoint/user-messages';
import { useState } from 'react';
import type { MolstarPlugin } from '../molstar';
import {
  applyMolViewSpecScene,
  getMolViewSpecScene,
  resolveMolViewSpecAgentScene,
} from '../molstar/molViewSpec';

type ViewEvidence = { title: string; url: string };

type ViewMetadata = {
  title: string;
  caption: string;
  evidence: ViewEvidence[];
};

export function MolViewSpecExperimentControls({
  plugin,
  originalScene,
  originalCameraSnapshot,
  onSceneApplied,
  onFit,
  onSaveView,
}: {
  plugin: MolstarPlugin | null;
  originalScene: string | undefined;
  originalCameraSnapshot: string | undefined;
  onSceneApplied: (scene: string, cameraSnapshot: string | undefined) => void;
  onFit: () => void;
  onSaveView?: (metadata: ViewMetadata) => Promise<string>;
}) {
  const [applying, setApplying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [sceneText, setSceneText] = useState('');
  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [evidenceTitle, setEvidenceTitle] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [pinnedLink, setPinnedLink] = useState('');
  const [error, setError] = useState<string | null>(null);

  const toggleEditor = () => {
    if (!plugin) return;
    if (!editing) {
      try {
        setSceneText(getMolViewSpecScene(plugin).scene);
        setError(null);
      } catch (cause) {
        setError(toUserMessage(cause, 'structure.failed'));
        return;
      }
    }
    setEditing(!editing);
  };

  const applyDraft = async () => {
    if (!plugin || applying || saving) return;
    setApplying(true);
    setError(null);
    setPinnedLink('');
    try {
      const current = getMolViewSpecScene(plugin);
      const compiled = resolveMolViewSpecAgentScene(
        plugin,
        sceneText,
        current.resources.map((resource) => resource.uri)
      );
      await applyMolViewSpecScene(plugin, compiled);
      const appliedScene = getMolViewSpecScene(plugin).scene;
      const camera = plugin.canvas3d?.camera.getSnapshot();
      setSceneText(appliedScene);
      onSceneApplied(appliedScene, camera ? JSON.stringify(camera) : undefined);
    } catch (cause) {
      setError(toUserMessage(cause, 'structure.failed'));
    } finally {
      setApplying(false);
    }
  };

  const pinView = async () => {
    if (!plugin || !onSaveView || applying || saving || !title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const url = evidenceUrl.trim();
      const evidence = url ? [{ title: evidenceTitle.trim() || url, url }] : [];
      const link = await onSaveView({ title: title.trim(), caption: caption.trim(), evidence });
      setPinnedLink(link);
    } catch (cause) {
      setError(toUserMessage(cause, 'structure.failed'));
    } finally {
      setSaving(false);
    }
  };

  const restoreOriginal = async () => {
    if (!plugin || applying) return;
    setApplying(true);
    setError(null);
    try {
      if (!originalScene)
        throw new Error('No original MolViewSpec scene is available for this view.');
      await applyMolViewSpecScene(plugin, originalScene);
      onSceneApplied(originalScene, originalCameraSnapshot);
    } catch (cause) {
      setError(toUserMessage(cause, 'structure.failed'));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div
      data-testid="mvs-experiment-controls"
      className="relative border-t border-border bg-bg px-3 py-1.5 text-xs text-fg"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg-muted">MolViewSpec view</span>
        <button
          type="button"
          data-testid="mvs-original-view"
          disabled={!plugin || !originalScene || applying}
          onClick={() => void restoreOriginal()}
          className="rounded border border-border px-2 py-1 wp-interactive disabled:opacity-50"
        >
          Original view
        </button>
        <button
          type="button"
          data-testid="mvs-fit-view"
          disabled={!plugin || applying}
          onClick={onFit}
          className="rounded border border-border px-2 py-1 wp-interactive disabled:opacity-50"
        >
          Fit view
        </button>
        <button
          type="button"
          data-testid="mvs-edit-scene"
          disabled={!plugin || applying || saving}
          onClick={toggleEditor}
          className="rounded border border-border px-2 py-1 wp-interactive disabled:opacity-50"
        >
          {editing ? 'Close scene lab' : 'Edit scene'}
        </button>
        {onSaveView && (
          <button
            type="button"
            data-testid="mvs-open-pin-view"
            disabled={!plugin || applying || saving}
            onClick={() => setPinning(!pinning)}
            className="rounded border border-border px-2 py-1 wp-interactive disabled:opacity-50"
          >
            {pinning ? 'Close pin form' : 'Pin view'}
          </button>
        )}
        {applying && <span role="status">Applying view…</span>}
      </div>
      {editing && (
        <div className="grid gap-2 pt-2" data-testid="mvs-scene-lab">
          <label className="grid gap-1">
            <span>MolViewSpec JSON</span>
            <textarea
              data-testid="mvs-scene-json"
              value={sceneText}
              onChange={(event) => setSceneText(event.target.value)}
              spellCheck={false}
              className="h-40 w-full resize-y rounded border border-border bg-bg p-2 font-mono text-[11px]"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="mvs-apply-scene"
              disabled={!sceneText.trim() || applying || saving}
              onClick={() => void applyDraft()}
              className="rounded border border-border px-2 py-1 wp-interactive disabled:opacity-50"
            >
              Apply scene
            </button>
            <span className="text-fg-muted">Review the rendered view before pinning it.</span>
          </div>
        </div>
      )}
      {pinning && onSaveView && (
        <div
          data-testid="mvs-pin-form"
          className="mt-2 grid w-full gap-2 rounded border border-border bg-bg p-3"
        >
          <input
            data-testid="mvs-view-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="View title"
            className="rounded border border-border bg-bg px-2 py-1"
          />
          <input
            data-testid="mvs-view-caption"
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            placeholder="What this view explains"
            className="rounded border border-border bg-bg px-2 py-1"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              data-testid="mvs-evidence-title"
              value={evidenceTitle}
              onChange={(event) => setEvidenceTitle(event.target.value)}
              placeholder="Evidence title"
              className="min-w-0 rounded border border-border bg-bg px-2 py-1"
            />
            <input
              data-testid="mvs-evidence-url"
              value={evidenceUrl}
              onChange={(event) => setEvidenceUrl(event.target.value)}
              placeholder="https://…"
              className="min-w-0 rounded border border-border bg-bg px-2 py-1"
            />
          </div>
          <button
            type="button"
            data-testid="mvs-pin-view"
            disabled={!title.trim() || applying || saving}
            onClick={() => void pinView()}
            className="w-fit rounded border border-border px-2 py-1 wp-interactive disabled:opacity-50"
          >
            {saving ? 'Pinning…' : 'Pin reviewed view'}
          </button>
          {pinnedLink && (
            <input
              data-testid="mvs-pinned-link"
              readOnly
              value={pinnedLink}
              aria-label="Pinned molecular view link"
              className="rounded border border-border bg-bg px-2 py-1 font-mono text-[11px]"
            />
          )}
        </div>
      )}
      {error && (
        <div data-testid="mvs-experiment-error" role="alert" className="pt-1 text-red-500">
          {toUserMessage(error, 'structure.failed')}
        </div>
      )}
    </div>
  );
}
