import { type ReactNode } from 'react';
import type { AssemblyDrawerStep as AssemblyDrawerStepDefinition } from './assembly-drawer-sections';

export function AssemblyDrawerStep({
  step,
  headerRight,
  children,
}: {
  step: AssemblyDrawerStepDefinition;
  headerRight?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      data-testid={`assembly-drawer-step-${step.id}`}
      data-step={step.number}
      data-step-id={step.id}
      className="min-w-0"
    >
      <div
        className={`flex items-center justify-between gap-2 px-4 pb-1 ${
          step.number === 1 ? 'pt-2' : 'pt-3'
        }`}
      >
        <h2
          data-testid={`assembly-drawer-step-title-${step.id}`}
          className="min-w-0 truncate text-xl font-semibold leading-7 text-fg"
        >
          {step.label}
        </h2>
        {headerRight ? <div className="shrink-0">{headerRight}</div> : null}
      </div>
      <div data-testid={`assembly-drawer-step-body-${step.id}`} className="min-w-0 px-4 pb-2">
        {children}
      </div>
    </section>
  );
}
