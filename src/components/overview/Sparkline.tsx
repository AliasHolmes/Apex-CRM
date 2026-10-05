interface SparklineProps {
  values: readonly number[];
  /** Accessible description, for example "Prospects added per day, last 14 days". */
  label: string;
  className?: string;
}

const WIDTH = 100;
const HEIGHT = 28;
const PADDING = 2;

/** Tiny dependency-free trend line. Inherits color from `currentColor`. */
export function Sparkline({ values, label, className }: SparklineProps) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const step = (WIDTH - PADDING * 2) / (values.length - 1);
  const points = values.map((value, index) => {
    const x = PADDING + index * step;
    const y = HEIGHT - PADDING - (value / max) * (HEIGHT - PADDING * 2);
    return [x, y] as const;
  });
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${PADDING},${HEIGHT} ${line} ${WIDTH - PADDING},${HEIGHT}`;
  const [lastX, lastY] = points[points.length - 1];

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      className={className ?? 'h-8 w-full text-primary'}
    >
      <polygon points={area} fill="currentColor" opacity="0.12" />
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={lastX} cy={lastY} r="1.8" fill="currentColor" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
