import { useId, useState } from 'react';
import { CloseIcon } from '../../components/icons/glyphs';
import tutorialUrl from './assets/benchling-export-flow.mp4?url';

const INTAKE_TUTORIAL_OPEN_STORAGE_KEY = 'dnaforge:benchling-migration:intake-tutorial-open:v1';

function readIntakeTutorialOpen(): boolean {
  try {
    return window.localStorage.getItem(INTAKE_TUTORIAL_OPEN_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

function writeIntakeTutorialOpen(open: boolean): void {
  try {
    window.localStorage.setItem(INTAKE_TUTORIAL_OPEN_STORAGE_KEY, String(open));
  } catch {}
}

export function BenchlingExportTutorial({
  align = 'start',
  layout = 'stacked',
  presentation = 'disclosure',
}: {
  align?: 'start' | 'center';
  layout?: 'stacked' | 'header';
  presentation?: 'disclosure' | 'intake';
}) {
  const intakePresentation = presentation === 'intake';
  const [open, setOpen] = useState(() => (intakePresentation ? readIntakeTutorialOpen() : false));
  const [mediaError, setMediaError] = useState(false);
  const panelId = useId();
  const descriptionId = useId();
  const headerLayout = layout === 'header';
  const toggleOpen = () => {
    setOpen((current) => {
      const next = !current;
      if (intakePresentation) writeIntakeTutorialOpen(next);
      if (next) setMediaError(false);
      return next;
    });
  };
  const trigger = (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      onClick={toggleOpen}
      className={`inline-flex items-center gap-2 rounded-md border border-accent/35 bg-accent/[0.05] px-2.5 py-1.5 text-[11px] font-medium text-accent transition-colors hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${
        headerLayout ? 'col-start-2 row-start-1' : ''
      }`}
    >
      {open ? (
        <CloseIcon size={12} />
      ) : (
        <span
          className="ml-0.5 h-0 w-0 border-y-[4px] border-l-[7px] border-y-transparent border-l-current"
          aria-hidden="true"
        />
      )}
      <span>{open ? 'Close video' : 'Watch how to export'}</span>
    </button>
  );

  return (
    <div
      className={headerLayout ? 'contents' : `mt-2 ${align === 'center' ? 'text-center' : ''}`}
      data-testid="benchling-export-tutorial"
    >
      {!open || !intakePresentation ? trigger : null}

      {open ? (
        <section
          id={panelId}
          aria-label="Benchling export tutorial player"
          aria-describedby={descriptionId}
          className={`w-full max-w-xl overflow-hidden rounded-lg border border-border bg-black text-left shadow-sm ${
            headerLayout
              ? 'col-span-full row-start-2 mt-0 justify-self-center'
              : `${intakePresentation ? '' : 'mt-2'} ${align === 'center' ? 'mx-auto' : ''}`
          }`}
        >
          <p id={descriptionId} className="sr-only">
            A silent, looping demonstration shows how to export a ZIP file from Benchling.
          </p>
          {mediaError ? (
            <div
              role="status"
              className="flex aspect-[8/5] w-full items-center justify-center bg-black px-8 text-center text-sm text-white"
            >
              The tutorial video could not play. You can continue with the written export steps.
            </div>
          ) : (
            <video
              src={tutorialUrl}
              data-testid="benchling-export-video"
              aria-hidden="true"
              className="aspect-[8/5] w-full bg-black object-contain"
              autoPlay
              loop
              muted
              playsInline
              preload="metadata"
              onError={() => setMediaError(true)}
            />
          )}
        </section>
      ) : null}

      {open && intakePresentation ? <div className="mt-2 text-center">{trigger}</div> : null}
    </div>
  );
}
