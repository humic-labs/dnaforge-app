export interface StepperTriangleProps {
  direction: 'up' | 'down';
  className?: string;
}

export function StepperTriangle({ direction, className }: StepperTriangleProps) {
  return (
    <svg className={className} viewBox="0 0 8 5" fill="currentColor" aria-hidden="true">
      <path d={direction === 'up' ? 'M4 0L8 5H0L4 0Z' : 'M4 5L0 0H8L4 5Z'} />
    </svg>
  );
}
