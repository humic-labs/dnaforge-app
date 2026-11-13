import { useSpinnerWord } from './spinner-words';

const helixKeyframes = `
@keyframes helix-swap {
  0%, 20% { transform: translateX(-3px); }
  50%, 70% { transform: translateX(3px); }
  100% { transform: translateX(-3px); }
}
@keyframes helix-swap-r {
  0%, 20% { transform: translateX(3px); }
  50%, 70% { transform: translateX(-3px); }
  100% { transform: translateX(3px); }
}
`;

function HelixPair({ cy, delay, flip }: { cy: number; delay: number; flip: boolean }) {
  const anim = (name: string) => `${name} 2s cubic-bezier(0.4, 0, 0.2, 1) ${delay}s infinite`;

  return (
    <g>
      <circle
        cx="7"
        cy={cy}
        r="1.5"
        fill="currentColor"
        opacity={flip ? 0.5 : 1}
        style={{ animation: anim(flip ? 'helix-swap-r' : 'helix-swap') }}
      />
      <rect
        x="5.5"
        y={cy - 1.5}
        width="3"
        height="3"
        rx="0.4"
        fill="currentColor"
        opacity={flip ? 1 : 0.5}
        style={{ animation: anim(flip ? 'helix-swap' : 'helix-swap-r') }}
      />
    </g>
  );
}

export function TypingDots() {
  return (
    <span className="inline-flex items-center text-accent">
      <style>{helixKeyframes}</style>
      <svg width="14" height="28" viewBox="0 0 14 28" fill="none">
        <HelixPair cy={3} delay={0} flip={false} />
        <HelixPair cy={9} delay={0.15} flip={true} />
        <HelixPair cy={15} delay={0.3} flip={false} />
        <HelixPair cy={21} delay={0.45} flip={true} />
        <HelixPair cy={27} delay={0.6} flip={false} />
      </svg>
    </span>
  );
}

export function StreamingCursor() {
  return <span className="inline-block w-1.5 h-4 ml-0.5 bg-accent rounded-sm animate-pulse" />;
}

export function ThinkingLabel() {
  const { word, visible } = useSpinnerWord();

  return (
    <div className="flex items-center gap-2 text-fg-muted text-sm">
      <TypingDots />
      <span className="transition-opacity duration-200" style={{ opacity: visible ? 1 : 0 }}>
        {word}
      </span>
    </div>
  );
}
