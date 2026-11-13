import type {
  IconProps,
  PlannotateIconProps,
  AnnotationsIconProps,
  AlignmentIconProps,
  ComplementIconProps,
  TranslationIconProps,
  PrimerIconProps,
  CutSitesIconProps,
  SmartTranslationIconProps,
  REToolIconProps,
} from './types';

export function PlannotateIcon({ size = 16, className, hovered }: PlannotateIconProps) {
  const C = 2 * Math.PI * 9;
  const gray = { start: 300, span: 120 };
  const green = { start: 110, span: 80 };
  const yellow = { start: 220, span: 40 };

  const dash = (arc: { start: number; span: number }) => {
    const len = (arc.span / 360) * C;
    return { dasharray: `${len} ${C - len}`, offset: -(arc.start / 360) * C };
  };

  const grayD = dash(gray);
  const greenD = dash(green);
  const yellowD = dash(yellow);

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      className={className}
      style={{ overflow: 'visible' }}
    >
      <g
        style={{
          opacity: hovered ? 0.35 : 0.55,
          transform: hovered ? 'translate(0, 0)' : 'translate(1px, 0)',
          transition: 'opacity 0.15s ease-out, transform 0.15s ease-out',
        }}
      >
        <circle cx="12" cy="12" r="9" strokeWidth="1.5" />
        <circle
          cx="12"
          cy="12"
          r="9"
          strokeWidth="4"
          strokeDasharray={grayD.dasharray}
          strokeDashoffset={grayD.offset}
        />
      </g>
      {}
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke={hovered ? 'hsl(152, 55%, 42%)' : 'currentColor'}
        strokeWidth="4"
        strokeDasharray={greenD.dasharray}
        strokeDashoffset={greenD.offset}
        style={{
          opacity: hovered ? 1 : 0.5,
          transform: hovered ? 'translate(0, 0)' : 'translate(-3.464px, 2px)',
          transition: 'transform 0.15s ease-out, opacity 0.15s ease-out, stroke 0.15s ease-out',
        }}
      />
      {}
      <circle
        cx="12"
        cy="12"
        r="9"
        stroke={hovered ? 'hsl(42, 85%, 52%)' : 'currentColor'}
        strokeWidth="4"
        strokeDasharray={yellowD.dasharray}
        strokeDashoffset={yellowD.offset}
        style={{
          opacity: hovered ? 1 : 0.5,
          transform: hovered ? 'translate(0, 0)' : 'translate(-2px, -3.464px)',
          transition: 'transform 0.15s ease-out, opacity 0.15s ease-out, stroke 0.15s ease-out',
        }}
      />
    </svg>
  );
}

export function PlannotateSpinner({ size = 16, className }: IconProps) {
  const C = 2 * Math.PI * 9;

  const arcs: [number, number, string | undefined, number][] = [
    [300, 120, undefined, 0.35],
    [110, 80, 'hsl(152, 55%, 42%)', 1],
    [220, 40, 'hsl(42, 85%, 52%)', 1],
  ];

  const grayArc = arcs[0];
  const grayArcLen = (grayArc[1] / 360) * C;
  const grayGapLen = C - grayArcLen;
  const grayOffset = -(grayArc[0] / 360) * C;

  return (
    <div
      className={`animate-spin ${className ?? ''}`}
      style={{ width: size, height: size, animationDuration: '2.5s' }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
      >
        {}
        <g opacity="0.35">
          <circle cx="12" cy="12" r="9" strokeWidth="1.5" />
          <circle
            cx="12"
            cy="12"
            r="9"
            strokeWidth="4"
            strokeDasharray={`${grayArcLen} ${grayGapLen}`}
            strokeDashoffset={grayOffset}
          />
        </g>
        {}
        {arcs.slice(1).map(([startDeg, spanDeg, color], i) => {
          const arcLen = (spanDeg / 360) * C;
          const gapLen = C - arcLen;
          const offset = -(startDeg / 360) * C;
          return (
            <circle
              key={i}
              cx="12"
              cy="12"
              r="9"
              strokeWidth="4"
              stroke={color}
              strokeDasharray={`${arcLen} ${gapLen}`}
              strokeDashoffset={offset}
            />
          );
        })}
      </svg>
    </div>
  );
}

export function AnnotationsIcon({ size = 16, className, hovered }: AnnotationsIconProps) {
  const C = 2 * Math.PI * 9;
  const arc1Len = (90 / 360) * C;
  const arc1Offset = -(100 / 360) * C;
  const arc2Len = (60 / 360) * C;
  const arc2Offset = -(240 / 360) * C;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      className={className}
    >
      {}
      <g
        style={{
          opacity: hovered ? 1 : 0.55,
          transition: 'opacity 0.15s ease-out',
        }}
      >
        <circle cx="12" cy="12" r="9" strokeWidth="1.5" />
        {}
        <circle
          cx="12"
          cy="12"
          r="9"
          stroke={hovered ? 'hsl(152, 55%, 42%)' : 'currentColor'}
          strokeWidth="4"
          strokeDasharray={`${arc1Len} ${C - arc1Len}`}
          strokeDashoffset={arc1Offset}
          style={{ transition: 'stroke 0.15s ease-out' }}
        />
        {}
        <circle
          cx="12"
          cy="12"
          r="9"
          stroke={hovered ? 'hsl(152, 55%, 42%)' : 'currentColor'}
          strokeWidth="4"
          strokeDasharray={`${arc2Len} ${C - arc2Len}`}
          strokeDashoffset={arc2Offset}
          style={{ transition: 'stroke 0.15s ease-out' }}
        />
      </g>
    </svg>
  );
}

export function AlignmentIcon({ size = 16, className, hovered }: AlignmentIconProps) {
  const reads = [
    { x1: 4, x2: 14, shift: 1 },
    { x1: 7, x2: 19, shift: 2 },
    { x1: 3, x2: 15, shift: 0.5 },
    { x1: 9, x2: 21, shift: 1.5 },
    { x1: 5, x2: 16, shift: 2.5 },
    { x1: 6, x2: 13, shift: 1 },
  ];
  const yStart = 9.5;
  const yStep = 2.5;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      className={className}
    >
      {}
      <line x1="2" y1="3.5" x2="22" y2="3.5" strokeWidth="2.2" opacity="0.7" strokeLinecap="butt" />
      <line x1="2" y1="6.5" x2="22" y2="6.5" strokeWidth="2.2" opacity="0.7" strokeLinecap="butt" />
      {}
      {reads.map((read, i) => (
        <line
          key={i}
          x1={read.x1}
          y1={yStart + i * yStep}
          x2={read.x2}
          y2={yStart + i * yStep}
          strokeWidth="2.2"
          opacity={0.5}
          style={{
            transform: `translateX(${hovered ? 0 : read.shift}px)`,
            transition: 'transform 0.15s ease-out',
          }}
        />
      ))}
    </svg>
  );
}

export function ComplementIcon({ size = 16, className, hovered, active }: ComplementIconProps) {
  const fwdGreen = 'hsl(152, 55%, 42%)';
  const revGreen = 'hsl(152, 45%, 32%)';
  const isActive = active ?? false;
  const fwdStroke = isActive ? revGreen : 'currentColor';
  const midStroke = isActive ? fwdGreen : hovered ? 'hsl(0, 0%, 65%)' : 'currentColor';
  const extStroke = isActive ? fwdGreen : 'hsl(0, 0%, 65%)';
  const extOpacity = hovered ? 1 : 0;
  const ticks = [4.5, 8.4, 12, 15.6, 19.5];

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      className={className}
    >
      <g opacity="0.7">
        {}
        <line
          x1="3"
          y1="7"
          x2="21"
          y2="7"
          strokeWidth="2"
          strokeLinecap="round"
          style={{ stroke: fwdStroke }}
        />
        {}
        {ticks.map((x) => (
          <line
            key={`a${x}`}
            x1={x}
            y1="7"
            x2={x}
            y2="10.5"
            strokeWidth="1.6"
            strokeLinecap="butt"
            style={{ stroke: fwdStroke }}
          />
        ))}
        {}
        {ticks.map((x) => (
          <line
            key={`b${x}`}
            x1={x}
            y1="10.5"
            x2={x}
            y2="11.5"
            strokeWidth="1.6"
            strokeLinecap="butt"
            style={{ stroke: midStroke }}
          />
        ))}
        {}
        {ticks.map((x) => (
          <line
            key={`c${x}`}
            x1={x}
            y1="11.5"
            x2={x}
            y2="14"
            strokeWidth="1.6"
            strokeLinecap="butt"
            style={{ opacity: extOpacity, stroke: extStroke, transition: 'opacity 0.15s ease-out' }}
          />
        ))}
        {}
        <line
          x1="3"
          y1="14"
          x2="21"
          y2="14"
          strokeWidth="2"
          strokeLinecap="round"
          style={{ opacity: extOpacity, stroke: extStroke, transition: 'opacity 0.15s ease-out' }}
        />
      </g>
    </svg>
  );
}

export function TranslationIcon({ size = 14, className, hovered }: TranslationIconProps) {
  const atgShift = hovered ? 0 : 7;
  const lineShift = hovered ? 0 : 5.5;
  const lineOpacity = hovered ? 0.3 : 0;
  const mShift = hovered ? 0 : 4.5;
  const mOpacity = hovered ? 0.7 : 0;
  const t = 'transform 0.15s ease-out, opacity 0.15s ease-out';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      className={className}
    >
      <text
        x="12"
        y="5"
        fontSize="8"
        fontWeight="700"
        fontFamily="monospace"
        fill="currentColor"
        stroke="none"
        opacity="0.7"
        textAnchor="middle"
        dominantBaseline="central"
        style={{ transform: `translateY(${atgShift}px)`, transition: t }}
      >
        ATG
      </text>
      <line
        x1="5"
        y1="10.5"
        x2="19"
        y2="10.5"
        strokeWidth="1.8"
        style={{ opacity: lineOpacity, transform: `translateY(${lineShift}px)`, transition: t }}
      />
      <text
        x="12"
        y="17.5"
        fontSize="12.5"
        fontWeight="900"
        fontFamily="monospace"
        fill="currentColor"
        stroke="none"
        textAnchor="middle"
        dominantBaseline="central"
        style={{ opacity: mOpacity, transform: `translateY(${mShift}px)`, transition: t }}
      >
        M
      </text>
    </svg>
  );
}

export function PrimerIcon({ size = 16, className, hovered, active }: PrimerIconProps) {
  const isActive = active ?? false;
  const translateY = hovered ? 1.5 : 0;
  const templateStroke = isActive ? 'hsl(152, 45%, 32%)' : 'currentColor';
  const primerStroke = isActive ? 'hsl(152, 55%, 50%)' : 'currentColor';
  const templateOpacity = isActive ? 0.9 : 0.7;
  const primerOpacity = isActive ? 0.9 : 0.25;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      className={className}
    >
      {}
      <line
        x1="2"
        y1="10.5"
        x2="22"
        y2="10.5"
        strokeWidth="2.2"
        opacity={templateOpacity}
        strokeLinecap="butt"
        style={{ stroke: templateStroke }}
      />
      <line
        x1="2"
        y1="13.5"
        x2="22"
        y2="13.5"
        strokeWidth="2.2"
        opacity={templateOpacity}
        strokeLinecap="butt"
        style={{ stroke: templateStroke }}
      />
      {}
      <g
        opacity={primerOpacity}
        style={{
          transform: `translateY(${translateY}px)`,
          transition: 'transform 0.15s ease-out',
          stroke: primerStroke,
        }}
      >
        <line x1="4" y1="6" x2="14" y2="6" strokeWidth="2.2" strokeLinecap="butt" />
        <polygon points="10.5,3 14,4.9 10.5,4.9" fill={primerStroke} stroke="none" />
      </g>
      {}
      <g
        opacity={primerOpacity}
        style={{
          transform: `translateY(${-translateY}px)`,
          transition: 'transform 0.15s ease-out',
          stroke: primerStroke,
        }}
      >
        <line x1="10" y1="18" x2="20" y2="18" strokeWidth="2.2" strokeLinecap="butt" />
        <polygon points="13.5,21 10,19.1 13.5,19.1" fill={primerStroke} stroke="none" />
      </g>
    </svg>
  );
}

export function CutSitesIcon({ size = 16, className, hovered, active }: CutSitesIconProps) {
  const isActive = active ?? false;
  const templateStroke = isActive ? 'hsl(152, 45%, 32%)' : 'currentColor';
  const templateOpacity = isActive ? 0.9 : 0.7;
  const cutStroke = hovered || isActive ? 'hsl(152, 55%, 50%)' : 'currentColor';
  const cutOpacity = hovered || isActive ? 0.9 : 0.25;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      className={className}
    >
      {}
      <line
        x1="2"
        y1="10.5"
        x2="22"
        y2="10.5"
        strokeWidth="2.2"
        strokeLinecap="butt"
        style={{ stroke: templateStroke, opacity: templateOpacity }}
      />
      <line
        x1="2"
        y1="13.5"
        x2="22"
        y2="13.5"
        strokeWidth="2.2"
        strokeLinecap="butt"
        style={{ stroke: templateStroke, opacity: templateOpacity }}
      />
      {}
      <g
        style={{
          stroke: cutStroke,
          opacity: cutOpacity,
          transition: 'opacity 0.15s ease-out, stroke 0.15s ease-out',
        }}
      >
        <polyline
          points="16,7.5 16,12 8,12 8,16.5"
          strokeWidth="2"
          strokeLinecap="butt"
          strokeLinejoin="miter"
          fill="none"
        />
      </g>
    </svg>
  );
}

export function SmartTranslationIcon({ size = 16, className, hovered }: SmartTranslationIconProps) {
  const xs = [2, 5.5, 9, 12.5, 16];
  const chevronH = 3;
  const chevronW = 1.5;
  const t = 2.5;
  const topY = 8;
  const botY = 16;
  const centerY = 12;
  const shiftTop = hovered ? centerY - topY : 0;
  const shiftBot = hovered ? centerY - botY : 0;

  const chevron = (cx: number, cy: number) =>
    `${cx},${cy - chevronH} ${cx + t},${cy - chevronH} ${cx + t + chevronW},${cy} ${cx + t},${cy + chevronH} ${cx},${cy + chevronH} ${cx + chevronW},${cy}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      className={className}
    >
      {}
      <g style={{ transform: `translateY(${shiftTop}px)`, transition: 'transform 0.15s ease-out' }}>
        <polygon points={chevron(xs[0], topY)} fill="currentColor" stroke="none" opacity="0.5" />
        <polygon points={chevron(xs[1], topY)} fill="currentColor" stroke="none" opacity="0.5" />
        <polygon points={chevron(xs[2], topY)} fill="currentColor" stroke="none" opacity="0.5" />
        <polygon points={chevron(xs[3], topY)} fill="currentColor" stroke="none" opacity="0.5" />
      </g>
      {}
      <g style={{ transform: `translateY(${shiftBot}px)`, transition: 'transform 0.15s ease-out' }}>
        <polygon points={chevron(xs[2], botY)} fill="currentColor" stroke="none" opacity="0.5" />
        <polygon points={chevron(xs[3], botY)} fill="currentColor" stroke="none" opacity="0.5" />
        <polygon points={chevron(xs[4], botY)} fill="currentColor" stroke="none" opacity="0.5" />
      </g>
    </svg>
  );
}

export function REToolIcon({ size = 16, className, hovered }: REToolIconProps) {
  const shift = hovered ? 1 : 0;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      className={className}
    >
      {}
      <line
        x1="2"
        y1="10.5"
        x2="14"
        y2="10.5"
        strokeWidth="2.2"
        opacity="0.7"
        strokeLinecap="butt"
        style={{ transform: `translateX(${-shift}px)`, transition: 'transform 0.15s ease-out' }}
      />
      <line
        x1="15"
        y1="10.5"
        x2="22"
        y2="10.5"
        strokeWidth="2.2"
        opacity="0.7"
        strokeLinecap="butt"
        style={{ transform: `translateX(${shift}px)`, transition: 'transform 0.15s ease-out' }}
      />
      {}
      <line
        x1="2"
        y1="13.5"
        x2="9"
        y2="13.5"
        strokeWidth="2.2"
        opacity="0.7"
        strokeLinecap="butt"
        style={{ transform: `translateX(${-shift}px)`, transition: 'transform 0.15s ease-out' }}
      />
      <line
        x1="10"
        y1="13.5"
        x2="22"
        y2="13.5"
        strokeWidth="2.2"
        opacity="0.7"
        strokeLinecap="butt"
        style={{ transform: `translateX(${shift}px)`, transition: 'transform 0.15s ease-out' }}
      />
    </svg>
  );
}
