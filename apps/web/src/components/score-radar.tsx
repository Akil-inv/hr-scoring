'use client';

import { scoreTone } from '@/lib/review';

/**
 * The panel profile: one shape for the panel's average on each dimension,
 * tinted rose, sand or sage by the overall average. Same drawing as the PDF
 * report, sized for the app's dark background.
 */
export default function ScoreRadar({
  axes, average, max, rings = 5, size = 240, fmt = (v) => (v === null ? '–' : String(v)),
}: {
  axes: { id: string; name: string; value: number | null; max: number }[];
  /** Overall average and what it is out of, for the colour. */
  average: number | null;
  max: number;
  /** Rings drawn: the rating scale (e.g. 5) or 5 for points. */
  rings?: number;
  size?: number;
  fmt?: (v: number | null) => string;
}) {
  if (axes.length < 3) return null;
  const tone = scoreTone(average, max);
  const W = size + 150;
  const H = size + 64;
  const cx = W / 2;
  const cy = H / 2 + 6;
  const R = size / 2 - 22;
  const n = axes.length;
  const ang = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
  const pt = (i: number, r: number) => [cx + r * Math.cos(ang(i)), cy + r * Math.sin(ang(i))];
  const poly = (f: number) => axes.map((_, i) => pt(i, R * f).join(',')).join(' ');
  const shape = axes.map((a, i) => pt(i, R * Math.max(0, Math.min(1, (a.value ?? 0) / (a.max || 1)))).join(',')).join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img"
      aria-label={`Panel profile: ${axes.map((a) => `${a.name} ${a.value ?? 'not scored'} of ${a.max}`).join(', ')}`}>
      {Array.from({ length: rings }, (_, k) => (k + 1) / rings).map((f) => (
        <polygon key={f} points={poly(f)} fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth={f === 1 ? 1 : 0.7} />
      ))}
      {axes.map((a, i) => {
        const [x, y] = pt(i, R);
        return <line key={a.id} x1={cx} y1={cy} x2={x} y2={y} stroke="rgba(255,255,255,0.09)" strokeWidth={0.7} />;
      })}
      <polygon points={shape} fill={tone.fill} fillOpacity={0.88} stroke={tone.line} strokeWidth={1} strokeLinejoin="round" />
      {axes.map((a, i) => {
        const c = Math.cos(ang(i));
        const s = Math.sin(ang(i));
        const [lx, ly] = pt(i, R + 10);
        const anchor = c > 0.3 ? 'start' : c < -0.3 ? 'end' : 'middle';
        const words = a.name.split(' ');
        const lines: string[] = [];
        for (const w of words) {
          const last = lines[lines.length - 1];
          if (last && (last + ' ' + w).length <= 15) lines[lines.length - 1] = `${last} ${w}`;
          else lines.push(w);
        }
        const h = lines.length * 14 + 14;
        const top = s < -0.9 ? ly - h : s > 0.3 ? ly + 6 : ly - h / 2 + 6;
        return (
          <text key={a.id} x={lx} y={top} textAnchor={anchor} fontSize={12.5} fill="rgb(203,213,225)">
            {lines.map((l, k) => <tspan key={k} x={lx} dy={k === 0 ? 0 : 14}>{l}</tspan>)}
            <tspan x={lx} dy={14} fill="rgb(148,163,184)" fontFamily="ui-monospace, monospace" fontSize={11.5}>
              {fmt(a.value)} / {a.max}
            </tspan>
          </text>
        );
      })}
    </svg>
  );
}
