'use client';

interface InternalCutSiteStepperProps {
  cutSiteCount: number;
  activeCutSiteIndex: number | null;
  onStep: (direction: 'next' | 'prev') => void;
}

export function InternalCutSiteStepper({
  cutSiteCount,
  activeCutSiteIndex,
  onStep,
}: InternalCutSiteStepperProps) {
  if (cutSiteCount <= 0) return null;
  const activeLabel = activeCutSiteIndex == null ? '–' : activeCutSiteIndex + 1;
  return (
    <div
      data-testid="internal-cut-site-stepper"
      role="group"
      aria-label="Internal cut site navigation"
      className="flex items-center gap-1 rounded border border-error/40 bg-error/10 px-1.5 py-0.5 text-[11px] font-medium leading-none text-error"
    >
      <span aria-hidden className="font-bold">
        !
      </span>
      <button
        type="button"
        aria-label="Previous internal cut site"
        data-testid="internal-cut-site-prev"
        onClick={(e) => {
          e.stopPropagation();
          onStep('prev');
        }}
        className="flex h-5 w-5 items-center justify-center rounded border border-error/50 bg-error/15 text-sm font-bold leading-none text-error hover:bg-error/35 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-error"
      >
        ◀
      </button>
      <span
        data-testid="internal-cut-site-stepper-label"
        className="whitespace-nowrap tabular-nums"
      >
        {activeLabel} of {cutSiteCount} internal cut {cutSiteCount === 1 ? 'site' : 'sites'}
      </span>
      <button
        type="button"
        aria-label="Next internal cut site"
        data-testid="internal-cut-site-next"
        onClick={(e) => {
          e.stopPropagation();
          onStep('next');
        }}
        className="flex h-5 w-5 items-center justify-center rounded border border-error/50 bg-error/15 text-sm font-bold leading-none text-error hover:bg-error/35 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-error"
      >
        ▶
      </button>
    </div>
  );
}
