import {
  BALL_RADIUS,
  BALL_RESTITUTION,
  CENTER_Y,
  CORNER_GAP,
  DRAG_FACTOR,
  FIELD_BOTTOM,
  FIELD_LEFT,
  FIELD_RIGHT,
  FIELD_TOP,
  FOOT_SPOT_X,
  HEAD_STRING_X,
  JAW_KNUCKLES,
  MAX_SHOT_SPEED,
  MIN_SHOT_SPEED,
  PLAY_W,
  POCKETS,
  RAIL_RESTITUTION,
  ROLLING_DECEL,
  SIDE_GAP,
  STOP_SPEED_SQ,
  SUBSTEPS,
} from './constants';
import type {
  AimPreview,
  Ball,
  Mat3,
  SerializedBall,
  ShotRecord,
  Vec2,
} from './types';

export interface PhysicsCallbacks {
  onBallHit?: (impactSpeed: number, ballA: number, ballB: number) => void;
  onRailHit?: (impactSpeed: number, ballId: number) => void;
  onPocket?: (ballId: number, pocketId: number) => void;
}

export function identityMat3(): Mat3 {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

/** Rotate a 3x3 matrix around a 2D rolling displacement (dx, dy) on the table plane */
export function applyRollingRotation(m: Mat3, dx: number, dy: number, radius: number): void {
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return;
  const angle = dist / radius;
  // Rolling axis lies on the table plane perpendicular to velocity: (-dy/dist, dx/dist, 0)
  const ux = -dy / dist;
  const uy = dx / dist;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;

  // Rodrigues rotation matrix R around unit vector (ux, uy, 0)
  const r00 = t * ux * ux + c;
  const r01 = t * ux * uy;
  const r02 = uy * s;
  const r10 = t * ux * uy;
  const r11 = t * uy * uy + c;
  const r12 = -ux * s;
  const r20 = -uy * s;
  const r21 = ux * s;
  const r22 = c;

  // New matrix = R * m
  const a00 = r00 * m[0] + r01 * m[3] + r02 * m[6];
  const a01 = r00 * m[1] + r01 * m[4] + r02 * m[7];
  const a02 = r00 * m[2] + r01 * m[5] + r02 * m[8];

  const a10 = r10 * m[0] + r11 * m[3] + r12 * m[6];
  const a11 = r10 * m[1] + r11 * m[4] + r12 * m[7];
  const a12 = r10 * m[2] + r11 * m[5] + r12 * m[8];

  const a20 = r20 * m[0] + r21 * m[3] + r22 * m[6];
  const a21 = r20 * m[1] + r21 * m[4] + r22 * m[7];
  const a22 = r20 * m[2] + r21 * m[5] + r22 * m[8];

  m[0] = a00; m[1] = a01; m[2] = a02;
  m[3] = a10; m[4] = a11; m[5] = a12;
  m[6] = a20; m[7] = a21; m[8] = a22;
}

function makeBall(id: number, x: number, y: number): Ball {
  // Give each object ball a pleasant initial orientation so its number faces upward
  const rot = identityMat3();
  if (id !== 0) {
    // Small random yaw/tilt so balls look organic on rack while keeping numbers legible
    const yaw = ((id * 37) % 360) * (Math.PI / 180);
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    rot[0] = cy;
    rot[1] = -sy;
    rot[3] = sy;
    rot[4] = cy;
  }
  return {
    id,
    x,
    y,
    vx: 0,
    vy: 0,
    spinX: 0,
    spinY: 0,
    hasPostHitSpin: false,
    strikeDirX: 0,
    strikeDirY: 0,
    radius: BALL_RADIUS,
    pocketed: false,
    pocketAnim: 0,
    pocketTargetX: 0,
    pocketTargetY: 0,
    rot,
  };
}

/** Standard American 8-ball 15-ball triangle rack + cue ball */
export function createInitialRack(): Ball[] {
  const balls: Ball[] = [];

  // Cue ball starts centered on the head spot
  balls.push(makeBall(0, HEAD_STRING_X - 24, CENTER_Y));

  // Standard 8-ball rack order:
  // Row 0 (apex): 1 ball
  // Row 2 center (index 4): 8-ball
  // Row 4 corners (index 10 & 14): 1 solid and 1 stripe
  const rackOrder = [
    1,
    9, 2,
    10, 8, 3,
    4, 11, 5, 12,
    13, 6, 14, 7, 15,
  ];

  const spacing = BALL_RADIUS * 2 + 0.35;
  const colStep = spacing * Math.cos(Math.PI / 6); // sqrt(3)/2

  let idx = 0;
  for (let row = 0; row < 5; row++) {
    const x = FOOT_SPOT_X + row * colStep;
    const startY = CENTER_Y - (row * spacing) / 2;
    for (let col = 0; col <= row; col++) {
      const y = startY + col * spacing;
      const id = rackOrder[idx++];
      balls.push(makeBall(id, x, y));
    }
  }

  return balls;
}

export function serializeBalls(balls: Ball[]): SerializedBall[] {
  return balls.map((b) => ({
    id: b.id,
    x: Math.round(b.x * 10) / 10,
    y: Math.round(b.y * 10) / 10,
    pocketed: b.pocketed,
    rot: b.rot.map((v) => Math.round(v * 1000) / 1000) as Mat3,
  }));
}

export function deserializeBalls(serialized: SerializedBall[]): Ball[] {
  return serialized.map((s) => ({
    id: s.id,
    x: s.x,
    y: s.y,
    vx: 0,
    vy: 0,
    spinX: 0,
    spinY: 0,
    hasPostHitSpin: false,
    strikeDirX: 0,
    strikeDirY: 0,
    radius: BALL_RADIUS,
    pocketed: s.pocketed,
    pocketAnim: s.pocketed ? 1 : 0,
    pocketTargetX: s.x,
    pocketTargetY: s.y,
    rot: [...s.rot] as Mat3,
  }));
}

export function createEmptyShotRecord(): ShotRecord {
  return {
    firstHitBallId: null,
    pocketedIds: [],
    railHitAfterContact: false,
    breakRailBallIds: new Set<number>(),
    cueScratched: false,
    cueBallHitRailCount: 0,
  };
}

/** Launch the cue ball with chosen angle, normalized power (0..1), and English spin (-1..1) */
export function strikeCueBall(
  balls: Ball[],
  angle: number,
  power: number,
  spinX: number,
  spinY: number,
): void {
  const cue = balls.find((b) => b.id === 0);
  if (!cue || cue.pocketed) return;

  const clampedPower = Math.max(0.05, Math.min(1, power));
  // Near-linear curve gives strong, responsive mid-range shots and explosive full-power breaks
  const curved = Math.pow(clampedPower, 1.08);
  const speed = MIN_SHOT_SPEED + (MAX_SHOT_SPEED - MIN_SHOT_SPEED) * curved;
  const dirX = Math.cos(angle);
  const dirY = Math.sin(angle);

  cue.vx = dirX * speed;
  cue.vy = dirY * speed;
  cue.spinX = Math.max(-1, Math.min(1, spinX));
  cue.spinY = Math.max(-1, Math.min(1, spinY));
  cue.hasPostHitSpin = Math.abs(cue.spinY) > 0.05;
  cue.strikeDirX = dirX;
  cue.strikeDirY = dirY;
}

export function areAllBallsStopped(balls: Ball[]): boolean {
  for (const b of balls) {
    if (b.pocketed) {
      if (b.pocketAnim < 1) return false;
      continue;
    }
    const speedSq = b.vx * b.vx + b.vy * b.vy;
    if (speedSq > 0.01) return false;
  }
  return true;
}

function isInHorizontalFlatRail(x: number): boolean {
  const midX = FIELD_LEFT + PLAY_W * 0.5;
  const inLeftSegment = x >= FIELD_LEFT + CORNER_GAP && x <= midX - SIDE_GAP;
  const inRightSegment = x >= midX + SIDE_GAP && x <= FIELD_RIGHT - CORNER_GAP;
  return inLeftSegment || inRightSegment;
}

function isInVerticalFlatRail(y: number): boolean {
  return y >= FIELD_TOP + CORNER_GAP && y <= FIELD_BOTTOM - CORNER_GAP;
}

function recordRailImpact(
  ball: Ball,
  impactSpeed: number,
  shotRecord: ShotRecord,
  callbacks: PhysicsCallbacks,
): void {
  if (shotRecord.firstHitBallId !== null) {
    shotRecord.railHitAfterContact = true;
  }
  if (ball.id !== 0) {
    shotRecord.breakRailBallIds.add(ball.id);
  } else {
    shotRecord.cueBallHitRailCount += 1;
  }
  callbacks.onRailHit?.(impactSpeed, ball.id);
}

/** Advance all balls by dt seconds using high-precision sub-stepping */
export function stepPhysics(
  balls: Ball[],
  dt: number,
  shotRecord: ShotRecord,
  callbacks: PhysicsCallbacks,
): void {
  const clampedDt = Math.min(dt, 1 / 30);
  const subDt = clampedDt / SUBSTEPS;

  // Advance pocket shrink animations outside substeps
  for (const b of balls) {
    if (b.pocketed && b.pocketAnim < 1) {
      b.pocketAnim = Math.min(1, b.pocketAnim + clampedDt * 5.2);
      b.x += (b.pocketTargetX - b.x) * Math.min(1, clampedDt * 14);
      b.y += (b.pocketTargetY - b.y) * Math.min(1, clampedDt * 14);
    }
  }

  for (let step = 0; step < SUBSTEPS; step++) {
    // 1. Integrate positions, rolling rotation, and cloth friction
    for (const b of balls) {
      if (b.pocketed) continue;

      const speedSq = b.vx * b.vx + b.vy * b.vy;
      if (speedSq === 0) continue;

      const dx = b.vx * subDt;
      const dy = b.vy * subDt;
      b.x += dx;
      b.y += dy;

      applyRollingRotation(b.rot, dx, dy, b.radius);

      // Smooth rolling friction + gentle aerodynamic/cloth drag
      const speed = Math.sqrt(speedSq);
      const decel = (ROLLING_DECEL + speed * DRAG_FACTOR) * subDt;
      if (speed <= decel || speedSq < STOP_SPEED_SQ) {
        b.vx = 0;
        b.vy = 0;
        b.spinX = 0;
        b.spinY = 0;
        b.hasPostHitSpin = false;
      } else {
        const nextSpeed = speed - decel;
        const scale = nextSpeed / speed;
        b.vx *= scale;
        b.vy *= scale;

        // Apply subtle curve (swerve) from heavy side spin at lower speeds
        if (b.id === 0 && Math.abs(b.spinX) > 0.08 && speed < 650) {
          const perpX = -b.vy / speed;
          const perpY = b.vx / speed;
          const swerve = b.spinX * 14 * subDt;
          b.vx += perpX * swerve;
          b.vy += perpY * swerve;
        }

        // Gradual spin decay across felt
        const spinDecay = Math.exp(-0.55 * subDt);
        b.spinX *= spinDecay;
        b.spinY *= spinDecay;
      }
    }

    // 2. Pocket capture & realistic Chinese 8-Ball slate-lip slide-in (轻推顺弧滑袋)
    for (const b of balls) {
      if (b.pocketed) continue;
      for (const p of POCKETS) {
        const dx = b.x - p.x;
        const dy = b.y - p.y;
        const distSq = dx * dx + dy * dy;

        if (distSq < p.captureRadius * p.captureRadius) {
          b.pocketed = true;
          b.pocketAnim = 0.01;
          b.pocketTargetX = p.x;
          b.pocketTargetY = p.y;
          b.vx = 0;
          b.vy = 0;
          b.spinX = 0;
          b.spinY = 0;
          b.hasPostHitSpin = false;

          if (b.id === 0) {
            shotRecord.cueScratched = true;
          } else if (!shotRecord.pocketedIds.includes(b.id)) {
            shotRecord.pocketedIds.push(b.id);
          }
          callbacks.onPocket?.(b.id, p.id);
          break;
        }

        // Slate cutout lip gravity bevel: gentle/medium shots rolling along the rounded horn
        // tip smoothly over the curved slate edge into the pocket, while fast shots skim/reject naturally
        if (distSq < p.lipRadius * p.lipRadius && distSq > 1e-6) {
          const dist = Math.sqrt(distSq);
          const speed = Math.hypot(b.vx, b.vy);
          const toPx = -dx / dist;
          const toPy = -dy / dist;
          const radialVel = b.vx * toPx + b.vy * toPy;

          const depth = Math.max(
            0,
            Math.min(1, 1 - (dist - p.captureRadius) / Math.max(1, p.lipRadius - p.captureRadius)),
          );
          // Full acceptance on soft shots (<=180 u/s), fading smoothly to 0 on hard shots (>=620 u/s)
          const softFactor = 1 - Math.min(1, Math.max(0, (speed - 180) / 440));

          // Only act on moving balls so a ball wedged at rest against a jaw never oscillates infinitely
          if (softFactor > 0 && speed > 4 && radialVel > -55) {
            // Pull gently down the curved pocket shelf toward the drop center
            const pullAccel = (260 + 620 * depth * depth) * softFactor;
            b.vx += toPx * pullAccel * subDt;
            b.vy += toPy * pullAccel * subDt;

            // Once past the curved slate tipping edge (depth > 0.58), ensure moving ball tips cleanly into drop
            if (depth > 0.58 && radialVel > -10 && radialVel < 32) {
              const boost = (32 - radialVel) * Math.min(1, subDt * 18);
              b.vx += toPx * boost;
              b.vy += toPy * boost;
            }
          }
          break;
        }
      }
    }

    // 3. Cushion & Pocket Jaw collisions
    for (const b of balls) {
      if (b.pocketed) continue;
      const r = b.radius;

      // Top rail
      if (b.y - r < FIELD_TOP && isInHorizontalFlatRail(b.x)) {
        b.y = FIELD_TOP + r;
        if (b.vy < 0) {
          const impact = Math.abs(b.vy);
          b.vy = -b.vy * RAIL_RESTITUTION;
          if (b.id === 0 && Math.abs(b.spinX) > 0.04) {
            b.vx += b.spinX * impact * 0.42;
            b.spinX *= 0.45;
          }
          recordRailImpact(b, impact, shotRecord, callbacks);
        }
      }

      // Bottom rail
      if (b.y + r > FIELD_BOTTOM && isInHorizontalFlatRail(b.x)) {
        b.y = FIELD_BOTTOM - r;
        if (b.vy > 0) {
          const impact = Math.abs(b.vy);
          b.vy = -b.vy * RAIL_RESTITUTION;
          if (b.id === 0 && Math.abs(b.spinX) > 0.04) {
            b.vx -= b.spinX * impact * 0.42;
            b.spinX *= 0.45;
          }
          recordRailImpact(b, impact, shotRecord, callbacks);
        }
      }

      // Left rail
      if (b.x - r < FIELD_LEFT && isInVerticalFlatRail(b.y)) {
        b.x = FIELD_LEFT + r;
        if (b.vx < 0) {
          const impact = Math.abs(b.vx);
          b.vx = -b.vx * RAIL_RESTITUTION;
          if (b.id === 0 && Math.abs(b.spinX) > 0.04) {
            b.vy -= b.spinX * impact * 0.42;
            b.spinX *= 0.45;
          }
          recordRailImpact(b, impact, shotRecord, callbacks);
        }
      }

      // Right rail
      if (b.x + r > FIELD_RIGHT && isInVerticalFlatRail(b.y)) {
        b.x = FIELD_RIGHT - r;
        if (b.vx > 0) {
          const impact = Math.abs(b.vx);
          b.vx = -b.vx * RAIL_RESTITUTION;
          if (b.id === 0 && Math.abs(b.spinX) > 0.04) {
            b.vy += b.spinX * impact * 0.42;
            b.spinX *= 0.45;
          }
          recordRailImpact(b, impact, shotRecord, callbacks);
        }
      }

      // Rounded Chinese 8-Ball pocket jaw horn collisions (圆弧袋角：轻推顺弧滑进，大力吐袋)
      for (const jaw of JAW_KNUCKLES) {
        const dx = b.x - jaw.x;
        const dy = b.y - jaw.y;
        const minDist = r + jaw.r;
        const distSq = dx * dx + dy * dy;
        if (distSq < minDist * minDist && distSq > 1e-8) {
          const dist = Math.sqrt(distSq);
          const nx = dx / dist;
          const ny = dy / dist;
          const overlap = minDist - dist;
          b.x += nx * overlap;
          b.y += ny * overlap;

          const vn = b.vx * nx + b.vy * ny;
          if (vn < 0) {
            const impactSpeed = Math.abs(vn);
            // Soft hits on the rounded cloth-wrapped horn absorb normal kick so the ball hugs the arc
            // into the pocket; hard hits rebound sharply off the compressed rubber ("轻吃袋、重吐袋")
            const speedT = Math.min(1, Math.max(0, (impactSpeed - 65) / 420));
            const jawRestitution = 0.34 + speedT * (RAIL_RESTITUTION - 0.34);

            b.vx -= (1 + jawRestitution) * vn * nx;
            b.vy -= (1 + jawRestitution) * vn * ny;
            recordRailImpact(b, impactSpeed, shotRecord, callbacks);
          }
        }
      }

      // Safety outer pocket liner bounds so a high-speed ball near a pocket mouth never escapes canvas
      const margin = 12;
      if (b.x < FIELD_LEFT - margin) {
        b.x = FIELD_LEFT - margin;
        b.vx = Math.abs(b.vx) * 0.5;
      } else if (b.x > FIELD_RIGHT + margin) {
        b.x = FIELD_RIGHT + margin;
        b.vx = -Math.abs(b.vx) * 0.5;
      }
      if (b.y < FIELD_TOP - margin) {
        b.y = FIELD_TOP - margin;
        b.vy = Math.abs(b.vy) * 0.5;
      } else if (b.y > FIELD_BOTTOM + margin) {
        b.y = FIELD_BOTTOM + margin;
        b.vy = -Math.abs(b.vy) * 0.5;
      }
    }

    // 4. Ball-to-Ball elastic collisions
    const count = balls.length;
    for (let i = 0; i < count; i++) {
      const a = balls[i];
      if (a.pocketed) continue;

      for (let j = i + 1; j < count; j++) {
        const b = balls[j];
        if (b.pocketed) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const minDist = a.radius + b.radius;
        const distSq = dx * dx + dy * dy;

        if (distSq < minDist * minDist && distSq > 1e-9) {
          const dist = Math.sqrt(distSq);
          const nx = dx / dist;
          const ny = dy / dist;

          // Positional separation (exact half-overlap push prevents sticky overlap)
          const overlap = (minDist - dist) * 0.502;
          a.x -= nx * overlap;
          a.y -= ny * overlap;
          b.x += nx * overlap;
          b.y += ny * overlap;

          // Relative velocity along collision normal
          const rvx = b.vx - a.vx;
          const rvy = b.vy - a.vy;
          const velAlongNormal = rvx * nx + rvy * ny;

          if (velAlongNormal < 0) {
            const impulse = (-(1 + BALL_RESTITUTION) * velAlongNormal) / 2;
            const ix = impulse * nx;
            const iy = impulse * ny;

            a.vx -= ix;
            a.vy -= iy;
            b.vx += ix;
            b.vy += iy;

            const impactSpeed = Math.abs(velAlongNormal);

            // Track first object ball hit by cue ball
            if (a.id === 0 && shotRecord.firstHitBallId === null) {
              shotRecord.firstHitBallId = b.id;
            } else if (b.id === 0 && shotRecord.firstHitBallId === null) {
              shotRecord.firstHitBallId = a.id;
            }

            // Apply cue ball follow (topspin) / draw (backspin) & slight cut throw
            const cue = a.id === 0 ? a : b.id === 0 ? b : null;
            const obj = a.id === 0 ? b : b.id === 0 ? a : null;
            if (cue && obj && cue.hasPostHitSpin) {
              // Follow/Draw acts along the cue's strike axis proportional to directness of hit
              const spinImpulse = cue.spinY * impactSpeed * 0.56;
              cue.vx += cue.strikeDirX * spinImpulse;
              cue.vy += cue.strikeDirY * spinImpulse;

              // Side English imparts subtle tangential throw on object ball
              if (Math.abs(cue.spinX) > 0.1) {
                const tx = -ny;
                const ty = nx;
                const throwMag = -cue.spinX * impactSpeed * 0.045;
                obj.vx += tx * throwMag;
                obj.vy += ty * throwMag;
              }
              cue.hasPostHitSpin = false;
            }

            callbacks.onBallHit?.(impactSpeed, a.id, b.id);
          }
        }
      }
    }
  }
}

/** Check if a cue ball placement is legal */
export function isValidCueBallPosition(
  x: number,
  y: number,
  balls: Ball[],
  kitchenOnly: boolean,
): boolean {
  const pad = BALL_RADIUS + 1.5;
  const maxX = kitchenOnly ? HEAD_STRING_X - BALL_RADIUS : FIELD_RIGHT - pad;
  if (x < FIELD_LEFT + pad || x > maxX || y < FIELD_TOP + pad || y > FIELD_BOTTOM - pad) {
    return false;
  }

  // Must not sit inside any pocket mouth
  for (const p of POCKETS) {
    const dist = Math.hypot(x - p.x, y - p.y);
    if (dist < p.captureRadius + BALL_RADIUS * 0.45) {
      return false;
    }
  }

  // Must not overlap any active object ball
  for (const b of balls) {
    if (b.id === 0 || b.pocketed) continue;
    const dist = Math.hypot(x - b.x, y - b.y);
    if (dist < BALL_RADIUS * 2 + 1.5) {
      return false;
    }
  }

  return true;
}

/** Clamp raw pointer position into playable area (respecting kitchen if needed) */
export function clampCueBallPosition(x: number, y: number, kitchenOnly: boolean): Vec2 {
  const pad = BALL_RADIUS + 2;
  const maxX = kitchenOnly ? HEAD_STRING_X - BALL_RADIUS : FIELD_RIGHT - pad;
  return {
    x: Math.max(FIELD_LEFT + pad, Math.min(maxX, x)),
    y: Math.max(FIELD_TOP + pad, Math.min(FIELD_BOTTOM - pad, y)),
  };
}

/** Find a clean non-overlapping position near preferred (x, y) */
export function findSafeBallSpot(
  balls: Ball[],
  preferredX: number,
  preferredY: number,
  ignoreBallId: number,
  kitchenOnly = false,
): Vec2 {
  const testValid = (tx: number, ty: number): boolean => {
    const pad = BALL_RADIUS + 2;
    const maxX = kitchenOnly ? HEAD_STRING_X - BALL_RADIUS : FIELD_RIGHT - pad;
    if (tx < FIELD_LEFT + pad || tx > maxX || ty < FIELD_TOP + pad || ty > FIELD_BOTTOM - pad) {
      return false;
    }
    for (const b of balls) {
      if (b.id === ignoreBallId || b.pocketed) continue;
      if (Math.hypot(tx - b.x, ty - b.y) < BALL_RADIUS * 2 + 2) return false;
    }
    return true;
  };

  if (testValid(preferredX, preferredY)) {
    return { x: preferredX, y: preferredY };
  }

  // Spiral search around preferred point
  for (let radius = 8; radius <= 320; radius += 8) {
    for (let deg = 0; deg < 360; deg += 20) {
      const rad = (deg * Math.PI) / 180;
      const cx = preferredX + Math.cos(rad) * radius;
      const cy = preferredY + Math.sin(rad) * radius;
      if (testValid(cx, cy)) return { x: cx, y: cy };
    }
  }

  return { x: HEAD_STRING_X - 24, y: CENTER_Y };
}

/** Raycast a swept circle of radius R against rails to find first rail bounce */
function raycastRails(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  radius: number,
): { t: number; nx: number; ny: number } {
  let bestT = Infinity;
  let nx = 0;
  let ny = 0;

  const minX = FIELD_LEFT + radius;
  const maxX = FIELD_RIGHT - radius;
  const minY = FIELD_TOP + radius;
  const maxY = FIELD_BOTTOM - radius;

  if (dx < -1e-6) {
    const t = (minX - ox) / dx;
    if (t > 0 && t < bestT) {
      bestT = t;
      nx = 1;
      ny = 0;
    }
  } else if (dx > 1e-6) {
    const t = (maxX - ox) / dx;
    if (t > 0 && t < bestT) {
      bestT = t;
      nx = -1;
      ny = 0;
    }
  }

  if (dy < -1e-6) {
    const t = (minY - oy) / dy;
    if (t > 0 && t < bestT) {
      bestT = t;
      nx = 0;
      ny = 1;
    }
  } else if (dy > 1e-6) {
    const t = (maxY - oy) / dy;
    if (t > 0 && t < bestT) {
      bestT = t;
      nx = 0;
      ny = -1;
    }
  }

  return { t: bestT, nx, ny };
}

/** Compute Ghost Ball & dual trajectory lines for aiming preview */
export function computeAimPreview(
  balls: Ball[],
  angle: number,
  spinX: number,
  spinY: number,
  beginnerMode: boolean,
  legalBallIds: Set<number>,
): AimPreview | null {
  const cue = balls.find((b) => b.id === 0);
  if (!cue || cue.pocketed) return null;

  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const combinedR = BALL_RADIUS * 2;
  const combinedRSq = combinedR * combinedR;

  let bestT = Infinity;
  let hitBall: Ball | null = null;

  for (const b of balls) {
    if (b.id === 0 || b.pocketed) continue;
    const ocX = b.x - cue.x;
    const ocY = b.y - cue.y;
    const proj = ocX * dx + ocY * dy;
    if (proj <= 0) continue;

    const perpSq = ocX * ocX + ocY * ocY - proj * proj;
    if (perpSq >= combinedRSq) continue;

    const thc = Math.sqrt(combinedRSq - perpSq);
    const t = proj - thc;
    if (t >= 0 && t < bestT) {
      bestT = t;
      hitBall = b;
    }
  }

  const railHit = raycastRails(cue.x, cue.y, dx, dy, BALL_RADIUS);

  // Cue hits rail before any object ball
  if (!hitBall || railHit.t < bestT) {
    const ghostX = cue.x + dx * railHit.t;
    const ghostY = cue.y + dy * railHit.t;

    let railBounceEnd: Vec2 | null = null;
    if (beginnerMode) {
      // Reflect direction off rail (including side English visual hint)
      let rdx = railHit.nx !== 0 ? -dx : dx;
      let rdy = railHit.ny !== 0 ? -dy : dy;
      if (Math.abs(spinX) > 0.05) {
        if (railHit.ny === 1) rdx += spinX * 0.25;
        else if (railHit.ny === -1) rdx -= spinX * 0.25;
        else if (railHit.nx === 1) rdy -= spinX * 0.25;
        else if (railHit.nx === -1) rdy += spinX * 0.25;
        const len = Math.hypot(rdx, rdy) || 1;
        rdx /= len;
        rdy /= len;
      }

      const bounceLen = 165;
      const secondRail = raycastRails(ghostX, ghostY, rdx, rdy, BALL_RADIUS);
      const actualBounce = Math.min(bounceLen, secondRail.t);
      railBounceEnd = {
        x: ghostX + rdx * actualBounce,
        y: ghostY + rdy * actualBounce,
      };
    }

    return {
      cueX: cue.x,
      cueY: cue.y,
      ghostX,
      ghostY,
      hitBallId: null,
      isIllegalTarget: false,
      targetLineEnd: null,
      targetBounceEnd: null,
      cueDeflectEnd: null,
      railBounceEnd,
    };
  }

  // Cue hits an object ball -> always show cue-to-target-ball Ghost Ball contact
  const ghostX = cue.x + dx * bestT;
  const ghostY = cue.y + dy * bestT;
  const isIllegalTarget = legalBallIds.size > 0 && !legalBallIds.has(hitBall.id);

  // Normal mode (beginnerMode === false): only keep cue-ball to target-ball line (no post-hit lines)
  if (!beginnerMode) {
    return {
      cueX: cue.x,
      cueY: cue.y,
      ghostX,
      ghostY,
      hitBallId: hitBall.id,
      isIllegalTarget,
      targetLineEnd: null,
      targetBounceEnd: null,
      cueDeflectEnd: null,
      railBounceEnd: null,
    };
  }

  // Beginner Assist Mode: also show post-impact target trajectory, rail rebound, and cue separation angle
  const nx = (hitBall.x - ghostX) / combinedR;
  const ny = (hitBall.y - ghostY) / combinedR;

  const targetMaxLen = 235;
  const targetRail = raycastRails(hitBall.x, hitBall.y, nx, ny, BALL_RADIUS);
  const targetLen = Math.min(targetMaxLen, targetRail.t);
  const targetLineEnd: Vec2 = {
    x: hitBall.x + nx * targetLen,
    y: hitBall.y + ny * targetLen,
  };

  let targetBounceEnd: Vec2 | null = null;
  if (targetRail.t < targetMaxLen) {
    const brx = targetRail.nx !== 0 ? -nx : nx;
    const bry = targetRail.ny !== 0 ? -ny : ny;
    const remaining = Math.min(110, targetMaxLen - targetRail.t + 55);
    const nextRail = raycastRails(targetLineEnd.x, targetLineEnd.y, brx, bry, BALL_RADIUS);
    const seg = Math.min(remaining, nextRail.t);
    targetBounceEnd = {
      x: targetLineEnd.x + brx * seg,
      y: targetLineEnd.y + bry * seg,
    };
  }

  // Cue ball separation angle vector after elastic impact + follow/draw spin preview
  const dot = dx * nx + dy * ny;
  let cdx = dx - dot * nx;
  let cdy = dy - dot * ny;

  if (Math.abs(spinY) > 0.05) {
    cdx += dx * spinY * dot * 0.56;
    cdy += dy * spinY * dot * 0.56;
  }

  const cLen = Math.hypot(cdx, cdy);
  let cueDeflectEnd: Vec2 | null = null;
  if (cLen > 0.06) {
    const ux = cdx / cLen;
    const uy = cdy / cLen;
    const deflectDist = Math.min(115, Math.max(30, cLen * 130));
    const defRail = raycastRails(ghostX, ghostY, ux, uy, BALL_RADIUS);
    const dLen = Math.min(deflectDist, defRail.t);
    cueDeflectEnd = {
      x: ghostX + ux * dLen,
      y: ghostY + uy * dLen,
    };
  }

  return {
    cueX: cue.x,
    cueY: cue.y,
    ghostX,
    ghostY,
    hitBallId: hitBall.id,
    isIllegalTarget,
    targetLineEnd,
    targetBounceEnd,
    cueDeflectEnd,
    railBounceEnd: null,
  };
}
