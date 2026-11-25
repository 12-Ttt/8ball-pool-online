import React, { useEffect, useRef } from 'react';
import { BALL_RADIUS, TABLE_H, TABLE_W } from '../game/constants';
import { clampCueBallPosition, isValidCueBallPosition } from '../game/physics';
import { type ChalkParticle, renderBilliardsScene } from '../game/renderer';
import type { AimPreview, Ball, ClothTheme, TurnPhase } from '../game/types';

export interface PoolCanvasProps {
  ballsRef: React.MutableRefObject<Ball[]>;
  particlesRef: React.MutableRefObject<ChalkParticle[]>;
  clothTheme: ClothTheme;
  phase: TurnPhase;
  canInteract: boolean;
  isRemoteTurn: boolean;
  kitchenOnly: boolean;
  cueAngleRef: React.MutableRefObject<number>;
  cuePowerRef: React.MutableRefObject<number>;
  cueStrikeThrustRef: React.MutableRefObject<number>;
  aimPreviewRef: React.MutableRefObject<AimPreview | null>;
  cueDragValidRef: React.MutableRefObject<boolean>;
  isDraggingCueRef: React.MutableRefObject<boolean>;
  onAimChange: (angle: number) => void;
  onDirectPowerChange: (power: number) => void;
  onShoot: (power: number) => void;
  onCancelCharge: () => void;
  onBallInHandMove: (x: number, y: number, valid: boolean) => void;
  onBallInHandConfirm: (x: number, y: number) => void;
  onUnlockAudio: () => void;
}

export const PoolCanvas: React.FC<PoolCanvasProps> = ({
  ballsRef,
  particlesRef,
  clothTheme,
  phase,
  canInteract,
  isRemoteTurn,
  kitchenOnly,
  cueAngleRef,
  cuePowerRef,
  cueStrikeThrustRef,
  aimPreviewRef,
  cueDragValidRef,
  isDraggingCueRef,
  onAimChange,
  onDirectPowerChange,
  onShoot,
  onCancelCharge,
  onBallInHandMove,
  onBallInHandConfirm,
  onUnlockAudio,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointerModeRef = useRef<'none' | 'aim' | 'pullback' | 'drag_cue'>('none');
  const activePointerIdRef = useRef<number | null>(null);
  const pullStartRef = useRef<{ x: number; y: number; angle: number }>({ x: 0, y: 0, angle: 0 });
  const dragCueOffsetRef = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });
  const lastPropsRef = useRef({ clothTheme, phase, canInteract, isRemoteTurn, kitchenOnly });

  lastPropsRef.current = { clothTheme, phase, canInteract, isRemoteTurn, kitchenOnly };

  // Dedicated 60fps canvas render loop decoupled from React re-renders
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = TABLE_W * dpr;
    canvas.height = TABLE_H * dpr;

    let rafId = 0;
    const drawFrame = () => {
      const p = lastPropsRef.current;
      const showCue =
        p.phase === 'AIMING' ||
        p.phase === 'ANIMATING_CUE' ||
        p.phase === 'AI_THINKING';

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderBilliardsScene(ctx, {
        balls: ballsRef.current,
        clothTheme: p.clothTheme,
        showCue,
        cueAngle: cueAngleRef.current,
        cuePower: cuePowerRef.current,
        cueStrikeThrust: cueStrikeThrustRef.current,
        aimPreview: p.phase === 'AIMING' || p.phase === 'AI_THINKING' ? aimPreviewRef.current : null,
        isBallInHand: p.phase === 'BALL_IN_HAND',
        kitchenOnly: p.kitchenOnly,
        cueDragValid: cueDragValidRef.current,
        isDraggingCue: isDraggingCueRef.current,
        isRemoteTurn: p.isRemoteTurn,
        particles: particlesRef.current,
      });
      ctx.restore();

      rafId = requestAnimationFrame(drawFrame);
    };

    rafId = requestAnimationFrame(drawFrame);
    return () => cancelAnimationFrame(rafId);
  }, [
    aimPreviewRef,
    ballsRef,
    cueAngleRef,
    cueDragValidRef,
    cuePowerRef,
    cueStrikeThrustRef,
    isDraggingCueRef,
    particlesRef,
  ]);

  const clientToTable = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * TABLE_W,
      y: ((clientY - rect.top) / rect.height) * TABLE_H,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    onUnlockAudio();

    // Right-click cancels active cue pullback immediately
    if (e.button === 2) {
      if (pointerModeRef.current === 'pullback' || cuePowerRef.current > 0) {
        pointerModeRef.current = 'none';
        activePointerIdRef.current = null;
        onCancelCharge();
      }
      return;
    }

    if (!canInteract) return;
    if (activePointerIdRef.current !== null) return;

    const pt = clientToTable(e.clientX, e.clientY);
    const cue = ballsRef.current.find((b) => b.id === 0);
    if (!cue || cue.pocketed) return;

    activePointerIdRef.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);

    if (phase === 'BALL_IN_HAND') {
      pointerModeRef.current = 'drag_cue';
      isDraggingCueRef.current = true;
      const distToCue = Math.hypot(pt.x - cue.x, pt.y - cue.y);
      if (distToCue <= BALL_RADIUS * 2.5) {
        dragCueOffsetRef.current = { dx: cue.x - pt.x, dy: cue.y - pt.y };
      } else {
        dragCueOffsetRef.current = { dx: 0, dy: 0 };
        const clamped = clampCueBallPosition(pt.x, pt.y, kitchenOnly);
        const valid = isValidCueBallPosition(clamped.x, clamped.y, ballsRef.current, kitchenOnly);
        onBallInHandMove(clamped.x, clamped.y, valid);
      }
      return;
    }

    if (phase === 'AIMING') {
      // Check if user grabbed behind the cue stick axis (direct drag-to-pullback charging!)
      const vx = pt.x - cue.x;
      const vy = pt.y - cue.y;
      const dist = Math.hypot(vx, vy);
      const backX = -Math.cos(cueAngleRef.current);
      const backY = -Math.sin(cueAngleRef.current);
      const projAlongBack = vx * backX + vy * backY;
      const perpDist = Math.abs(vx * -backY + vy * backX);

      // Grabbing directly on the wooden cue shaft triggers smooth pull-back charging
      if (projAlongBack > BALL_RADIUS + 8 && projAlongBack < 360 && perpDist < 24) {
        pointerModeRef.current = 'pullback';
        pullStartRef.current = { x: pt.x, y: pt.y, angle: cueAngleRef.current };
        return;
      }

      // Otherwise aim directly toward pointer location
      pointerModeRef.current = 'aim';
      if (dist > 4) {
        const angle = Math.atan2(pt.y - cue.y, pt.x - cue.x);
        onAimChange(angle);
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (activePointerIdRef.current !== e.pointerId) return;
    if (!canInteract) return;

    const pt = clientToTable(e.clientX, e.clientY);
    const cue = ballsRef.current.find((b) => b.id === 0);
    if (!cue || cue.pocketed) return;

    if (pointerModeRef.current === 'drag_cue') {
      const targetX = pt.x + dragCueOffsetRef.current.dx;
      const targetY = pt.y + dragCueOffsetRef.current.dy;
      const clamped = clampCueBallPosition(targetX, targetY, kitchenOnly);
      const valid = isValidCueBallPosition(clamped.x, clamped.y, ballsRef.current, kitchenOnly);
      onBallInHandMove(clamped.x, clamped.y, valid);
      return;
    }

    if (pointerModeRef.current === 'aim') {
      const dx = pt.x - cue.x;
      const dy = pt.y - cue.y;
      if (dx * dx + dy * dy > 16) {
        const angle = Math.atan2(dy, dx);
        onAimChange(angle);
      }
      return;
    }

    if (pointerModeRef.current === 'pullback') {
      const start = pullStartRef.current;
      const backX = -Math.cos(start.angle);
      const backY = -Math.sin(start.angle);
      const deltaX = pt.x - start.x;
      const deltaY = pt.y - start.y;
      const pullPx = deltaX * backX + deltaY * backY;
      const normalized = Math.max(0, Math.min(1, pullPx / 165));
      onDirectPowerChange(normalized);
    }
  };

  const finishPointer = (e: React.PointerEvent<HTMLCanvasElement>, cancelled = false) => {
    if (activePointerIdRef.current !== e.pointerId) return;
    activePointerIdRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // noop
    }

    const mode = pointerModeRef.current;
    pointerModeRef.current = 'none';

    if (mode === 'drag_cue') {
      isDraggingCueRef.current = false;
      const cue = ballsRef.current.find((b) => b.id === 0);
      if (cue && cueDragValidRef.current && !cancelled) {
        onBallInHandConfirm(cue.x, cue.y);
      }
      return;
    }

    if (mode === 'pullback') {
      const power = cuePowerRef.current;
      if (!cancelled && power >= 0.06) {
        onShoot(power);
      } else {
        onCancelCharge();
      }
    }
  };

  const cursorClass = !canInteract
    ? 'cursor-default'
    : phase === 'BALL_IN_HAND'
      ? 'cursor-grab active:cursor-grabbing'
      : 'cursor-crosshair';

  return (
    <div className="relative w-full select-none">
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(e) => finishPointer(e, false)}
        onPointerCancel={(e) => finishPointer(e, true)}
        onContextMenu={(e) => e.preventDefault()}
        className={`block w-full h-auto rounded-2xl shadow-[0_24px_60px_rgba(0,0,0,0.65)] touch-none ${cursorClass}`}
        style={{ aspectRatio: `${TABLE_W} / ${TABLE_H}` }}
      />
    </div>
  );
};
