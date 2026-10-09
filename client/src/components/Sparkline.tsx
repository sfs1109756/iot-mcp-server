import { useEffect, useState } from 'react';
import type { Metric } from '../types';

/** Tiny SVG trend line for one metric, refreshed every 10s. */
export function Sparkline({ deviceId, metric, minutes = 120 }: { deviceId: string; metric: Metric; minutes?: number }) {
  const [points, setPoints] = useState<number[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`/api/devices/${deviceId}/history?metric=${metric}&minutes=${minutes}`)
        .then((r) => r.json())
        .then((d) => alive && setPoints((d.points as { v: number }[]).map((p) => p.v)))
        .catch(() => {});
    load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [deviceId, metric, minutes]);

  if (points.length < 2) return <div className="spark empty" />;
  const w = 220;
  const h = 40;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const d = points
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / (points.length - 1)) * w).toFixed(1)},${(h - 3 - ((v - min) / span) * (h - 6)).toFixed(1)}`)
    .join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-label={`${metric} trend, last ${minutes} minutes`}>
      <path d={`${d} L${w},${h} L0,${h} Z`} fill="var(--accent-soft)" stroke="none" />
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
