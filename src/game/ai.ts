import {
  BALL_RADIUS,
  CENTER_Y,
  FIELD_BOTTOM,
  FIELD_LEFT,
  FIELD_RIGHT,
  FIELD_TOP,
  HEAD_STRING_X,
  POCKETS,
} from './constants';
import { isValidCueBallPosition } from './physics';
import { getLegalTargetBallIds } from './rules';
import type { AIDifficulty, Ball, BallGroup, Vec2 } from './types';

export interface AIShotDecision {
  angle: number;
  power: number;
  spinX: number;
  spinY: number;
}

/** Check if segment A->B is unobstructed by any other active ball */
function isSegmentClear(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  balls: Ball[],
  ignoreIds: Set<number>,
  clearanceRadius: number,
): boolean {
  const vx = bx - ax;
  const vy = by - ay;
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1e-6) return true;

  const minDistSq = clearanceRadius * clearanceRadius;
  for (const b of balls) {
    if (b.pocketed || ignoreIds.has(b.id)) continue;
    const wx = b.x - ax;
    const wy = b.y - ay;
    const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / lenSq));
    const px = ax + t * vx;
    const py = ay + t * vy;
    const dx = b.x - px;
    const dy = b.y - py;
    if (dx * dx + dy * dy < minDistSq) {
      return false;
    }
  }
  return true;
}

/** Check whether cue ball deflection after impact risks scratching into a pocket */
function hasScratchRisk(
  ghostX: number,
  ghostY: number,
  cueDirX: number,
  cueDirY: number,
  normalX: number,
  normalY: number,
): boolean {
  const dot = cueDirX * normalX + cueDirY * normalY;
  const cdx = cueDirX - dot * normalX;
  const cdy = cueDirY - dot * normalY;
  const len = Math.hypot(cdx, cdy);
  if (len < 0.08) return false;
  const ux = cdx / len;
  const uy = cdy / len;

  for (const p of POCKETS) {
    const px = p.x - ghostX;
    const py = p.y - ghostY;
    const proj = px * ux + py * uy;
    if (proj <= 0 || proj > 420) continue;
    const perp = Math.abs(px * uy - py * ux);
    if (perp < p.captureRadius + 6) {
      return true;
    }
  }
  return false;
}

/** Choose optimal Ball-in-Hand placement for AI */
export function computeAIBallInHandSpot(
  balls: Ball[],
  group: BallGroup,
  isBreak: boolean,
  kitchenOnly: boolean,
): Vec2 {
  if (isBreak || kitchenOnly) {
    const candidates: Vec2[] = [
      { x: HEAD_STRING_X - 24, y: CENTER_Y },
      { x: HEAD_STRING_X - 26, y: CENTER_Y - 55 },
      { x: HEAD_STRING_X - 26, y: CENTER_Y + 55 },
    ];
    for (const c of candidates) {
      if (isValidCueBallPosition(c.x, c.y, balls, true)) return c;
    }
    return { x: HEAD_STRING_X - 24, y: CENTER_Y };
  }

  const legalIds = getLegalTargetBallIds(balls, group, false, false);
  let bestSpot: Vec2 | null = null;
  let bestScore = -Infinity;

  for (const target of balls) {
    if (target.pocketed || !legalIds.has(target.id)) continue;
    for (const pocket of POCKETS) {
      const toPocketX = pocket.x - target.x;
      const toPocketY = pocket.y - target.y;
      const distPocket = Math.hypot(toPocketX, toPocketY);
      if (distPocket < 10) continue;
      const ux = toPocketX / distPocket;
      const uy = toPocketY / distPocket;

      if (!isSegmentClear(target.x, target.y, pocket.x, pocket.y, balls, new Set([0, target.id]), BALL_RADIUS * 1.92)) {
        continue;
      }

      // Place cue ball straight behind the target ball for an easy pot
      for (const offset of [95, 145, 70, 200]) {
        const cx = target.x - ux * (BALL_RADIUS * 2 + offset);
        const cy = target.y - uy * (BALL_RADIUS * 2 + offset);
        if (!isValidCueBallPosition(cx, cy, balls, false)) continue;
        if (!isSegmentClear(cx, cy, target.x - ux * BALL_RADIUS * 2, target.y - uy * BALL_RADIUS * 2, balls, new Set([0, target.id]), BALL_RADIUS * 1.95)) {
          continue;
        }
        const score = 1000 - distPocket - Math.abs(offset - 115) * 0.6;
        if (score > bestScore) {
          bestScore = score;
          bestSpot = { x: cx, y: cy };
        }
      }
    }
  }

  if (bestSpot) return bestSpot;

  // Fallback: center-left open area
  const fallbackSpots: Vec2[] = [
    { x: HEAD_STRING_X, y: CENTER_Y },
    { x: (FIELD_LEFT + FIELD_RIGHT) * 0.5, y: CENTER_Y },
    { x: FIELD_LEFT + 140, y: FIELD_TOP + 120 },
    { x: FIELD_RIGHT - 140, y: FIELD_BOTTOM - 120 },
  ];
  for (const s of fallbackSpots) {
    if (isValidCueBallPosition(s.x, s.y, balls, false)) return s;
  }
  return { x: HEAD_STRING_X - 24, y: CENTER_Y };
}

/** Calculate an AI shot based on difficulty tier */
export function computeAIShot(
  balls: Ball[],
  group: BallGroup,
  isBreak: boolean,
  difficulty: AIDifficulty,
): AIShotDecision {
  const cue = balls.find((b) => b.id === 0);
  if (!cue || cue.pocketed) {
    return { angle: 0, power: 0.5, spinX: 0, spinY: 0 };
  }

  // Opening break shot
  if (isBreak) {
    const apex = balls.find((b) => !b.pocketed && b.id !== 0);
    const baseAngle = apex ? Math.atan2(apex.y - cue.y, apex.x - cue.x) : 0;
    const jitter = (Math.random() - 0.5) * (difficulty === 'pro' ? 0.015 : 0.05);
    return {
      angle: baseAngle + jitter,
      power: difficulty === 'pro' ? 0.96 : 0.85,
      spinX: 0,
      spinY: difficulty === 'pro' ? 0.15 : 0,
    };
  }

  const legalIds = getLegalTargetBallIds(balls, group, false, false);
  const candidates: Array<{
    angle: number;
    power: number;
    spinX: number;
    spinY: number;
    score: number;
  }> = [];

  for (const target of balls) {
    if (target.pocketed || !legalIds.has(target.id)) continue;

    for (const pocket of POCKETS) {
      const toPocketX = pocket.x - target.x;
      const toPocketY = pocket.y - target.y;
      const distToPocket = Math.hypot(toPocketX, toPocketY);
      if (distToPocket < 10) continue;

      const pDirX = toPocketX / distToPocket;
      const pDirY = toPocketY / distToPocket;

      // Exact Ghost Ball point behind the target ball along pocket axis
      const ghostX = target.x - pDirX * (BALL_RADIUS * 2);
      const ghostY = target.y - pDirY * (BALL_RADIUS * 2);

      // Ghost ball must stay inside playable bounds
      if (
        ghostX < FIELD_LEFT + BALL_RADIUS ||
        ghostX > FIELD_RIGHT - BALL_RADIUS ||
        ghostY < FIELD_TOP + BALL_RADIUS ||
        ghostY > FIELD_BOTTOM - BALL_RADIUS
      ) {
        continue;
      }

      const cueToGhostX = ghostX - cue.x;
      const cueToGhostY = ghostY - cue.y;
      const distCueToGhost = Math.hypot(cueToGhostX, cueToGhostY);
      if (distCueToGhost < 2) continue;

      const cDirX = cueToGhostX / distCueToGhost;
      const cDirY = cueToGhostY / distCueToGhost;

      // Cut alignment: 1.0 = dead straight, 0 = 90-degree thin cut (impossible)
      const alignment = cDirX * pDirX + cDirY * pDirY;
      const minAlignment = difficulty === 'pro' ? 0.24 : 0.42;
      if (alignment < minAlignment) continue;

      const ignoreSet = new Set<number>([0, target.id]);

      // Verify both paths are unobstructed
      const pathToGhostClear = isSegmentClear(
        cue.x,
        cue.y,
        ghostX,
        ghostY,
        balls,
        ignoreSet,
        BALL_RADIUS * 1.96,
      );
      if (!pathToGhostClear) continue;

      const pathToPocketClear = isSegmentClear(
        target.x,
        target.y,
        pocket.x,
        pocket.y,
        balls,
        ignoreSet,
        BALL_RADIUS * 1.92,
      );
      if (!pathToPocketClear) continue;

      const scratchRisk = hasScratchRisk(ghostX, ghostY, cDirX, cDirY, pDirX, pDirY);

      // Shot scoring
      let score = alignment * 120 - distCueToGhost * 0.08 - distToPocket * 0.11;
      if (!pocket.isCorner) {
        // Side pockets need a cleaner entry angle
        const sideEntry = Math.abs(pDirY);
        if (sideEntry < 0.35) score -= 45;
        else score += 8;
      }
      if (scratchRisk) score -= difficulty === 'pro' ? 85 : 30;

      // Estimate smooth required power calibrated to lively tournament cloth
      const totalDist = distCueToGhost + distToPocket;
      const cutComp = 1 / Math.max(0.45, alignment);
      const rawPower = Math.min(0.72, Math.max(0.18, (totalDist / 1750) * cutComp + 0.13));

      // Subtle positional spin for Pro AI
      let spinY = 0;
      if (difficulty === 'pro') {
        if (scratchRisk) spinY = -0.55; // Draw back to avoid scratch
        else if (alignment > 0.88 && distToPocket < 260) spinY = -0.2;
      }

      candidates.push({
        angle: Math.atan2(cueToGhostY, cueToGhostX),
        power: rawPower,
        spinX: 0,
        spinY,
        score,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length > 0) {
    // Easy AI sometimes chooses a slightly suboptimal shot and has noticeable aim jitter
    const pickIdx =
      difficulty === 'pro'
        ? 0
        : Math.min(candidates.length - 1, Math.floor(Math.random() * Math.min(3, candidates.length)));
    const chosen = candidates[pickIdx];
    const maxErrDeg = difficulty === 'pro' ? 0.38 : 2.9;
    const errRad = ((Math.random() * 2 - 1) * maxErrDeg * Math.PI) / 180;
    const powerJitter = difficulty === 'pro' ? (Math.random() - 0.5) * 0.04 : (Math.random() - 0.5) * 0.16;

    return {
      angle: chosen.angle + errRad,
      power: Math.max(0.22, Math.min(0.95, chosen.power + powerJitter)),
      spinX: chosen.spinX,
      spinY: chosen.spinY,
    };
  }

  // No clear potting shot -> play a legal contact / safety shot directly or via 1-rail kick!
  const legalTargets = balls.filter((b) => !b.pocketed && legalIds.has(b.id));
  for (const target of legalTargets) {
    if (isSegmentClear(cue.x, cue.y, target.x, target.y, balls, new Set([0, target.id]), BALL_RADIUS * 1.9)) {
      const ang = Math.atan2(target.y - cue.y, target.x - cue.x);
      return {
        angle: ang + (Math.random() - 0.5) * 0.03,
        power: 0.48,
        spinX: 0,
        spinY: 0,
      };
    }
  }

  // Snookered -> attempt a 1-rail kick shot off top or bottom rail to touch a legal ball
  if (legalTargets.length > 0) {
    const target = legalTargets[0];
    const mirrorYs = [
      2 * (FIELD_TOP + BALL_RADIUS) - target.y,
      2 * (FIELD_BOTTOM - BALL_RADIUS) - target.y,
    ];
    for (const my of mirrorYs) {
      const ang = Math.atan2(my - cue.y, target.x - cue.x);
      return {
        angle: ang,
        power: 0.64,
        spinX: 0,
        spinY: 0,
      };
    }
  }

  return { angle: 0, power: 0.5, spinX: 0, spinY: 0 };
}
