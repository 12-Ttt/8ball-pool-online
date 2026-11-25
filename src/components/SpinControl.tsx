import React, { useRef } from 'react';
import { RotateCcw } from 'lucide-react';

interface SpinControlProps {
  spinX: number; // -1..1
  spinY: number; // -1..1 (+1 = topspin/follow, -1 = backspin/draw)
  disabled: boolean;
  compact?: boolean;
  onChange: (spinX: number, spinY: number) => void;
}

const MAX_RADIUS_RATIO = 0.78;

function describeSpin(spinX: number, spinY: number): string {
  const parts: string[] = [];
  if (spinY > 0.18) parts.push('高杆');
  else if (spinY < -0.18) parts.push('低杆');

  if (spinX < -0.18) parts.push('左塞');
  else if (spinX > 0.18) parts.push('右塞');

  return parts.length > 0 ? parts.join(' · ') : '中杆';
}

export const SpinControl: React.FC<SpinControlProps> = ({
  spinX,
  spinY,
  disabled,
  compact = false,
  onChange,
}) => {
  const ballRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  const updateFromClient = (clientX: number, clientY: number) => {
    const el = ballRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const r = rect.width / 2;

    let nx = (clientX - cx) / r;
    // Screen Y goes down; topspin (+1) is at top of cue ball
    let ny = -(clientY - cy) / r;

    const mag = Math.hypot(nx, ny);
    if (mag > MAX_RADIUS_RATIO) {
      nx = (nx / mag) * MAX_RADIUS_RATIO;
      ny = (ny / mag) * MAX_RADIUS_RATIO;
    }

    // Normalize back to -1..1 range within safe miscue circle
    const outX = Math.max(-1, Math.min(1, nx / MAX_RADIUS_RATIO));
    const outY = Math.max(-1, Math.min(1, ny / MAX_RADIUS_RATIO));
    onChange(outX, outY);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    updateFromClient(e.clientX, e.clientY);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || disabled) return;
    updateFromClient(e.clientX, e.clientY);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // noop
    }
  };

  const sizeClass = compact ? 'w-14 h-14' : 'w-20 h-20';
  const dotLeftPct = 50 + spinX * MAX_RADIUS_RATIO * 50;
  const dotTopPct = 50 - spinY * MAX_RADIUS_RATIO * 50;
  const isCentered = Math.abs(spinX) < 0.05 && Math.abs(spinY) < 0.05;

  return (
    <div className={`flex ${compact ? 'flex-row items-center gap-3' : 'flex-col items-center gap-2'} select-none`}>
      <div
        ref={ballRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        title="拖拽调整击球点（高杆/低杆/左右塞）"
        className={`relative ${sizeClass} rounded-full touch-none shrink-0 ${
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
        }`}
        style={{
          background:
            'radial-gradient(circle at 32% 30%, #ffffff 0%, #f1ece0 55%, #cfc7b4 100%)',
          boxShadow:
            'inset -4px -5px 10px rgba(0,0,0,0.28), 0 4px 12px rgba(0,0,0,0.45)',
        }}
      >
        {/* Crosshair guides */}
        <div className="absolute inset-x-2 top-1/2 -translate-y-px h-px bg-black/15 pointer-events-none" />
        <div className="absolute inset-y-2 left-1/2 -translate-x-px w-px bg-black/15 pointer-events-none" />
        {/* Safe strike zone circle */}
        <div className="absolute inset-[11%] rounded-full border border-dashed border-black/15 pointer-events-none" />

        {/* Chalk hit-point dot */}
        <div
          className="absolute w-3.5 h-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#dc2626] border-2 border-white shadow pointer-events-none"
          style={{
            left: `${dotLeftPct}%`,
            top: `${dotTopPct}%`,
          }}
        />
      </div>

      <div className={`flex flex-col ${compact ? 'items-start' : 'items-center'} gap-1`}>
        <span className="text-[11px] font-medium text-[#f3efe6] whitespace-nowrap">
          {describeSpin(spinX, spinY)}
        </span>
        {!isCentered ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(0, 0)}
            className="inline-flex items-center gap-1 text-[11px] text-[#d4a853] hover:text-[#e6c173] transition-colors cursor-pointer whitespace-nowrap"
          >
            <RotateCcw className="w-3 h-3" />
            回中杆
          </button>
        ) : (
          <span className="text-[10px] text-[#8d96a6] whitespace-nowrap">加塞微调</span>
        )}
      </div>
    </div>
  );
};
