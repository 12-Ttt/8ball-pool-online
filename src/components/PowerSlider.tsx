import React, { useRef } from 'react';
import { X } from 'lucide-react';

interface PowerSliderProps {
  power: number; // 0..1
  disabled: boolean;
  orientation: 'vertical' | 'horizontal';
  onPowerChange: (power: number) => void;
  onReleaseShoot: (power: number) => void;
  onCancel: () => void;
}

export const PowerSlider: React.FC<PowerSliderProps> = ({
  power,
  disabled,
  orientation,
  onPowerChange,
  onReleaseShoot,
  onCancel,
}) => {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const latestPowerRef = useRef(power);
  latestPowerRef.current = power;

  const computePowerFromEvent = (clientX: number, clientY: number): number => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    if (orientation === 'vertical') {
      const ratio = (clientY - rect.top) / rect.height;
      return Math.max(0, Math.min(1, ratio));
    }
    const ratio = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(1, ratio));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (e.button === 2) {
      draggingRef.current = false;
      pointerIdRef.current = null;
      onCancel();
      return;
    }
    draggingRef.current = true;
    pointerIdRef.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = computePowerFromEvent(e.clientX, e.clientY);
    latestPowerRef.current = p;
    onPowerChange(p);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || pointerIdRef.current !== e.pointerId) return;
    const p = computePowerFromEvent(e.clientX, e.clientY);
    latestPowerRef.current = p;
    onPowerChange(p);
  };

  const handlePointerEnd = (e: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    if (!draggingRef.current || pointerIdRef.current !== e.pointerId) return;
    draggingRef.current = false;
    pointerIdRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // noop
    }

    const finalPower = latestPowerRef.current;
    if (!cancelled && finalPower >= 0.06) {
      onReleaseShoot(finalPower);
    } else {
      onCancel();
    }
  };

  const pct = Math.round(power * 100);
  const isArmed = power >= 0.06;

  if (orientation === 'horizontal') {
    return (
      <div className="flex items-center gap-3 w-full">
        <div className="flex flex-col shrink-0 w-16">
          <span className="text-[11px] text-[#9ea6b4]">击球力度</span>
          <span className="font-mono-num text-sm font-semibold text-[#f3efe6]">{pct}%</span>
        </div>

        <div
          ref={trackRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={(e) => handlePointerEnd(e, false)}
          onPointerCancel={(e) => handlePointerEnd(e, true)}
          onContextMenu={(e) => e.preventDefault()}
          className={`relative flex-1 h-12 rounded-xl bg-[#14171d] border border-white/10 overflow-hidden touch-none select-none ${
            disabled ? 'opacity-45 cursor-not-allowed' : 'cursor-ew-resize'
          }`}
          role="slider"
          aria-label="击球力度拉杆"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          {/* Power fill bar */}
          <div
            className="absolute inset-y-0 left-0 transition-[opacity] duration-75"
            style={{
              width: `${pct}%`,
              background:
                'linear-gradient(90deg, rgba(16,185,129,0.55) 0%, rgba(212,168,83,0.75) 55%, rgba(239,68,68,0.85) 100%)',
            }}
          />

          {/* Subtle cue handle graphic */}
          <div
            className="absolute top-1/2 -translate-y-1/2 h-4 rounded-full pointer-events-none flex items-center"
            style={{
              left: `calc(${pct}% - 10px)`,
              width: '120px',
            }}
          >
            <div className="w-2.5 h-3.5 rounded-l bg-[#2563eb]" />
            <div className="w-2 h-3.5 bg-[#f3efe6]" />
            <div className="flex-1 h-3.5 bg-gradient-to-r from-[#dfb778] via-[#b88a4a] to-[#3a241a] rounded-r border border-black/30" />
          </div>

          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <span className="text-xs font-medium text-[#f3efe6]/80 drop-shadow">
              {isArmed ? '松手击球 · 滑回左侧取消' : '向右拉动蓄力击球'}
            </span>
          </div>
        </div>

        {isArmed && (
          <button
            type="button"
            onClick={onCancel}
            className="h-12 px-3 rounded-xl bg-[#1e222b] hover:bg-[#2a303d] text-[#f3efe6] border border-white/10 flex items-center gap-1 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
            取消
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-2.5 select-none">
      <div className="flex flex-col items-center">
        <span className="text-[11px] text-[#9ea6b4] whitespace-nowrap">力度拉杆</span>
        <span className="font-mono-num text-sm font-semibold text-[#f3efe6]">{pct}%</span>
      </div>

      <div
        ref={trackRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(e) => handlePointerEnd(e, false)}
        onPointerCancel={(e) => handlePointerEnd(e, true)}
        onContextMenu={(e) => e.preventDefault()}
        className={`relative w-14 h-56 rounded-xl bg-[#14171d] border border-white/10 overflow-hidden touch-none ${
          disabled ? 'opacity-45 cursor-not-allowed' : 'cursor-ns-resize'
        }`}
        role="slider"
        aria-label="击球力度拉杆"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        {/* Scale tick marks */}
        <div className="absolute inset-x-2 inset-y-3 flex flex-col justify-between pointer-events-none opacity-30">
          {[0, 25, 50, 75, 100].map((mark) => (
            <div key={mark} className="w-full border-t border-dashed border-white/40" />
          ))}
        </div>

        {/* Gradient charge bar */}
        <div
          className="absolute inset-x-0 top-0"
          style={{
            height: `${pct}%`,
            background:
              'linear-gradient(180deg, rgba(16,185,129,0.45) 0%, rgba(212,168,83,0.75) 55%, rgba(239,68,68,0.88) 100%)',
          }}
        />

        {/* Cue stick vertical pull indicator */}
        <div
          className="absolute left-1/2 -translate-x-1/2 w-3.5 flex flex-col items-center pointer-events-none"
          style={{
            top: `calc(${pct}% + 6px)`,
            height: '180px',
          }}
        >
          <div className="w-2.5 h-2 rounded-t bg-[#2563eb]" />
          <div className="w-2.5 h-2.5 bg-[#f3efe6]" />
          <div className="w-3 flex-1 bg-gradient-to-b from-[#e4bf80] via-[#b88a4a] to-[#2e1b13] rounded-b shadow" />
        </div>

        {/* Bottom hint */}
        <div className="absolute inset-x-0 bottom-2 text-center pointer-events-none">
          <span className="text-[10px] font-medium text-[#f3efe6]/70">
            {isArmed ? '松手' : '下拉'}
          </span>
        </div>
      </div>

      <button
        type="button"
        disabled={!isArmed}
        onClick={onCancel}
        className={`w-full py-1.5 px-2 rounded-lg text-[11px] font-medium transition-colors whitespace-nowrap ${
          isArmed
            ? 'bg-[#2a1f22] text-[#fca5a5] hover:bg-[#3a252a] cursor-pointer'
            : 'bg-transparent text-[#646d7d] cursor-default'
        }`}
      >
        {isArmed ? '取消蓄力' : '右键取消'}
      </button>
    </div>
  );
};
