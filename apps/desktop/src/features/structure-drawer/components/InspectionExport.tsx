import { toUserMessage } from '@waypoint/user-messages';
import { useState } from 'react';
import { platform } from '../../../platform';
import type { MolecularView } from '../../page/public/embeds/structure3d/molecularView';
import { inspectionFigureSvg, inspectionMeasurementsCsv } from '../inspection-export';
import { reportSaveFailure } from '../../../lib/report-save-failure';

export function InspectionExport({ view }: { view: MolecularView }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState(false);
  const save = async (format: 'svg' | 'csv' | 'json') => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    setError(false);
    let phase: 'dialog' | 'serialize' | 'write' = 'dialog';
    let filePath: string | null = null;
    try {
      const name = view.title.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 80) || 'protein-analysis';
      filePath = await platform().dialog.save({
        defaultPath: `${name}.${format}`,
        filters: [
          {
            name:
              format === 'svg'
                ? 'Protein figure and evidence'
                : format === 'csv'
                  ? 'Residue measurements'
                  : 'Saved molecular view',
            extensions: [format],
          },
        ],
      });
      if (!filePath) return;
      phase = 'serialize';
      const content =
        format === 'svg'
          ? await inspectionFigureSvg(view)
          : format === 'csv'
            ? await inspectionMeasurementsCsv(view)
            : JSON.stringify(view, null, 2) + '\n';
      phase = 'write';
      await platform().fs.writeTextFileAtomic({ path: filePath, content });
      setMessage(`Exported ${filePath.split(/[\\/]/).pop()}`);
    } catch (cause) {
      reportSaveFailure('[InspectionExport] Save failed:', { format, phase, filePath }, cause);
      setError(true);
      setMessage(
        toUserMessage(cause instanceof Error ? cause.message : String(cause), 'structure.failed')
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="relative ml-auto" data-testid="inspection-export">
      <summary className="cursor-pointer rounded border border-border px-2 py-1">
        Export saved view
      </summary>
      <div className="absolute right-0 top-full z-20 mt-1 w-64 rounded border border-border bg-bg p-2 shadow-lg">
        <p className="mb-2">
          Exports the last saved snapshot. Save again to include later changes.
        </p>
        {(
          [
            ['svg', 'Figure and evidence (.svg)'],
            ['csv', 'Measurements (.csv)'],
            ['json', 'Complete saved scene (.json)'],
          ] as const
        ).map(([format, label]) => (
          <button
            type="button"
            key={format}
            disabled={busy || (format === 'csv' && !view.measurements?.length)}
            onClick={() => void save(format)}
            className="block w-full rounded px-2 py-1 text-left hover:bg-bg-muted disabled:opacity-50"
          >
            {label}
          </button>
        ))}
        {message && (
          <div role={error ? 'alert' : 'status'} className="mt-2 break-words">
            {message}
          </div>
        )}
      </div>
    </details>
  );
}
