import {
  BALL_RADIUS,
  FIELD_BOTTOM,
  FIELD_LEFT,
  FIELD_RIGHT,
  FIELD_TOP,
  ROLLING_DECEL,
} from './constants';
import { applyRollingRotation } from './physics';
import type {
  AuthoritativeStatePayload,
  Ball,
  CompactBallTick,
} from './types';

export interface BufferedBallSample {
  x: number;
  y: number;
  vx: number;
  vy: number;
  pocketed: boolean;
}

export interface SyncSnapshot {
  /** Shooter-relative simulation time in ms since cue strike */
  simTimeMs: number;
  /** Local performance.now() timestamp when received */
  receivedAtMs: number;
  /** Full or delta ball states indexed by ball id */
  balls: Map<number, BufferedBallSample>;
}

export interface SyncBufferAudioCallbacks {
  onBallHit?: (speed: number) => void;
  onRailHit?: (speed: number) => void;
  onPocket?: () => void;
}

export interface SyncBufferSampleResult {
  /** True if any ball transitioned into pocketed state this frame */
  pocketEventHappened: boolean;
  /** Non-null once the buffered playback finishes and an authoritative sync_state is ready to commit */
  readyFinalState: AuthoritativeStatePayload | null;
}

/**
 * State Synchronization & Snapshot Interpolation Buffer for online P2P / WSS relay billiards.
 *
 * Instead of snapping balls immediately on every incoming tick or letting uncoordinated
 * client physics diverge and jitter under high latency, this buffer:
 *  1. Collects timestamped ball snapshots (`simTimeMs`) from the shooting peer.
 *  2. Maintains an adaptive interpolation delay (`baseDelayMs + jitterMargin`) so playback
 *     almost always interpolates smoothly between two known snapshots (`s0` and `s1`).
 *  3. Uses velocity-aware Hermite interpolation along smooth paths and automatically falls
 *     back to linear interpolation across rail/ball collision deflections to prevent overshoot.
 *  4. Gracefully dead-reckons with damping during transient packet stalls (clamped to rails),
 *     then smoothly converges without snapping when packets resume.
 *  5. Queues incoming `sync_state` until buffered playback catches up to the final resting frame.
 */
export class RemoteSyncBuffer {
  private activeShotSeq = 0;
  private snapshots: SyncSnapshot[] = [];

  /** Current interpolated playback cursor in shooter-relative simulation ms */
  private renderSimTimeMs = 0;
  private initializedPlayback = false;
  private firstSnapshotLocalMs = 0;

  /** Adaptive jitter estimator (EWMA of inter-arrival timing deviation) */
  private jitterMs = 0;
  private lastPacketLocalMs = 0;
  private lastPacketSimMs = 0;

  /** Deferred authoritative final state waiting for playback to finish */
  private pendingFinalState: AuthoritativeStatePayload | null = null;
  private finalStateQueuedAtMs = 0;
  private finalSimTimeMs = 0;

  /** Track audio cooldowns & previous velocity per ball to synthesize subtle impact cues */
  private prevVelByBall = new Map<number, { vx: number; vy: number }>();
  private lastCollisionAudioMs = 0;
  private lastRailAudioMs = 0;

  /** Target interpolation delay bounds (ms) */
  private baseDelayMs = 95;
  private readonly minDelayMs = 75;
  private readonly maxDelayMs = 260;
  private readonly maxExtrapolationMs = 190;
  private readonly maxFinalStateHoldMs = 420;

  public reset(): void {
    this.activeShotSeq = 0;
    this.snapshots = [];
    this.renderSimTimeMs = 0;
    this.initializedPlayback = false;
    this.firstSnapshotLocalMs = 0;
    this.jitterMs = 0;
    this.lastPacketLocalMs = 0;
    this.lastPacketSimMs = 0;
    this.pendingFinalState = null;
    this.finalStateQueuedAtMs = 0;
    this.finalSimTimeMs = 0;
    this.prevVelByBall.clear();
  }

  public getActiveShotSeq(): number {
    return this.activeShotSeq;
  }

  public getTargetDelayMs(): number {
    return Math.min(this.maxDelayMs, Math.max(this.minDelayMs, this.baseDelayMs + this.jitterMs * 1.4));
  }

  public hasPendingFinalState(): boolean {
    return this.pendingFinalState !== null;
  }

  public getLastActivityLocalMs(): number {
    return Math.max(this.firstSnapshotLocalMs, this.lastPacketLocalMs, this.finalStateQueuedAtMs);
  }

  /**
   * Begin buffering a new remote shot at `simTimeMs = 0` with the current table state.
   * Sets a transport-appropriate base interpolation delay (smaller on direct WebRTC, slightly
   * larger on WSS relay to absorb network jitter).
   */
  public startShot(
    shotSeq: number,
    initialBalls: Ball[],
    transport: 'none' | 'webrtc' | 'relay',
    nowMs: number,
  ): void {
    this.reset();
    this.activeShotSeq = shotSeq;
    this.baseDelayMs = transport === 'relay' ? 145 : 90;
    this.firstSnapshotLocalMs = nowMs;

    const map = new Map<number, BufferedBallSample>();
    for (const b of initialBalls) {
      map.set(b.id, {
        x: b.x,
        y: b.y,
        vx: 0,
        vy: 0,
        pocketed: b.pocketed,
      });
    }

    this.snapshots.push({
      simTimeMs: 0,
      receivedAtMs: nowMs,
      balls: map,
    });
    this.lastPacketLocalMs = nowMs;
    this.lastPacketSimMs = 0;
    // Start playback slightly behind `0` so there is a small smooth interpolation buffer before motion begins
    this.renderSimTimeMs = -this.baseDelayMs * 0.55;
    this.initializedPlayback = true;
  }

  /**
   * Ingest a timestamped `balls_tick` frame from the shooting peer.
   * Delta packets inherit unchanged balls from the latest snapshot so every stored snapshot
   * is self-contained and interpolation is O(N) with zero missing-ball edge cases.
   */
  public pushTick(
    shotSeq: number,
    simTimeMs: number,
    ticks: CompactBallTick[],
    currentBalls: Ball[],
    transport: 'none' | 'webrtc' | 'relay',
    nowMs: number,
  ): boolean {
    if (shotSeq < this.activeShotSeq) {
      return false;
    }

    if (shotSeq > this.activeShotSeq) {
      this.startShot(shotSeq, currentBalls, transport, nowMs);
    }

    const latest = this.snapshots[this.snapshots.length - 1];
    // Ignore out-of-order / duplicate older frames
    if (latest && simTimeMs <= latest.simTimeMs && this.snapshots.length > 1) {
      return false;
    }

    // Update adaptive RFC-3550-style inter-arrival jitter estimate
    if (this.lastPacketLocalMs > 0 && simTimeMs > this.lastPacketSimMs) {
      const localDelta = nowMs - this.lastPacketLocalMs;
      const simDelta = simTimeMs - this.lastPacketSimMs;
      const transitDiff = Math.abs(localDelta - simDelta);
      // Clamp outliers caused by tab backgrounding
      const clampedDiff = Math.min(transitDiff, 220);
      this.jitterMs = this.jitterMs * 0.8 + clampedDiff * 0.2;
    }
    this.lastPacketLocalMs = nowMs;
    this.lastPacketSimMs = simTimeMs;

    // Clone previous snapshot state so non-moving balls remain intact
    const merged = new Map<number, BufferedBallSample>();
    if (latest) {
      for (const [id, sample] of latest.balls.entries()) {
        merged.set(id, { ...sample, vx: 0, vy: 0 });
      }
    } else {
      for (const b of currentBalls) {
        merged.set(b.id, {
          x: b.x,
          y: b.y,
          vx: 0,
          vy: 0,
          pocketed: b.pocketed,
        });
      }
    }

    for (const [id, x, y, vx, vy, pocketedFlag] of ticks) {
      merged.set(id, {
        x,
        y,
        vx,
        vy,
        pocketed: pocketedFlag === 1,
      });
    }

    this.snapshots.push({
      simTimeMs,
      receivedAtMs: nowMs,
      balls: merged,
    });

    // Keep memory bounded while retaining enough history for smooth bracketing
    if (this.snapshots.length > 48) {
      this.snapshots.splice(0, this.snapshots.length - 48);
    }

    return true;
  }

  /**
   * Queue the authoritative post-shot `sync_state` from the shooter.
   * Appends the exact final resting ball layout as the terminal snapshot so buffered playback
   * glides into the authoritative end state with zero visual pop.
   */
  public queueFinalState(
    state: AuthoritativeStatePayload,
    shotSeq: number | undefined,
    nowMs: number,
  ): boolean {
    // If no active buffered shot is playing, commit immediately outside the buffer
    if (!this.initializedPlayback || this.snapshots.length === 0) {
      return false;
    }
    if (shotSeq !== undefined && this.activeShotSeq > 0 && shotSeq < this.activeShotSeq) {
      return false;
    }

    const latest = this.snapshots[this.snapshots.length - 1];
    const estimatedEndSimMs = Math.max(
      latest.simTimeMs + 95,
      this.renderSimTimeMs + 110,
    );

    const finalMap = new Map<number, BufferedBallSample>();
    for (const sb of state.balls) {
      finalMap.set(sb.id, {
        x: sb.x,
        y: sb.y,
        vx: 0,
        vy: 0,
        pocketed: sb.pocketed,
      });
    }

    this.snapshots.push({
      simTimeMs: estimatedEndSimMs,
      receivedAtMs: nowMs,
      balls: finalMap,
    });

    this.pendingFinalState = state;
    this.finalStateQueuedAtMs = nowMs;
    this.finalSimTimeMs = estimatedEndSimMs;
    return true;
  }

  /**
   * Advance the interpolation clock by `dtSec` and write smoothly interpolated ball positions
   * and rolling rotations into `balls`.
   */
  public sampleIntoBalls(
    balls: Ball[],
    dtSec: number,
    nowMs: number,
    audio?: SyncBufferAudioCallbacks,
  ): SyncBufferSampleResult {
    if (!this.initializedPlayback || this.snapshots.length === 0) {
      return { pocketEventHappened: false, readyFinalState: null };
    }

    const latest = this.snapshots[this.snapshots.length - 1];
    const targetDelayMs = this.getTargetDelayMs();

    // Estimate the shooter's current simulation clock right now based on the latest snapshot
    const estimatedRemoteNowSimMs =
      this.pendingFinalState !== null
        ? this.finalSimTimeMs
        : latest.simTimeMs + Math.min(nowMs - latest.receivedAtMs, this.maxExtrapolationMs);

    const desiredRenderSimMs =
      this.pendingFinalState !== null
        ? this.finalSimTimeMs
        : estimatedRemoteNowSimMs - targetDelayMs;

    // Gentle playback speed adjustment (clock drift / buffer-level servo) to eliminate hiccups
    const bufferErrorMs = desiredRenderSimMs - this.renderSimTimeMs;
    let playbackScale = 1.0;

    if (this.pendingFinalState !== null) {
      // Slightly accelerate catch-up once the shot has ended so turn transition feels responsive
      playbackScale = 1.25;
    } else if (this.snapshots.length < 2 && nowMs - this.firstSnapshotLocalMs < targetDelayMs) {
      // Still filling the initial interpolation buffer window
      playbackScale = 0.65;
    } else if (bufferErrorMs > 35) {
      // Falling behind target delay -> gently speed up (max +18%)
      playbackScale = Math.min(1.18, 1 + (bufferErrorMs - 35) * 0.0014);
    } else if (bufferErrorMs < -35) {
      // Running too close to live edge -> gently slow down (min -15%) to rebuild cushion
      playbackScale = Math.max(0.85, 1 + (bufferErrorMs + 35) * 0.0014);
    }

    // If extremely far behind (e.g. browser tab was backgrounded), jump close to desired time
    if (bufferErrorMs > 650) {
      this.renderSimTimeMs = desiredRenderSimMs;
    } else {
      this.renderSimTimeMs += dtSec * 1000 * playbackScale;
    }

    // Never rewind before t=0 once we're ready to render balls
    const clampedRenderMs = Math.max(0, this.renderSimTimeMs);

    // Prune snapshots strictly older than the bracketing left snapshot
    while (this.snapshots.length > 2 && this.snapshots[1].simTimeMs <= clampedRenderMs) {
      this.snapshots.shift();
    }

    let pocketEventHappened = false;

    // Find bracketing snapshots [s0, s1] around clampedRenderMs
    let s0 = this.snapshots[0];
    let s1 = this.snapshots[this.snapshots.length - 1];
    let isExtrapolating = false;

    if (clampedRenderMs >= latest.simTimeMs) {
      s0 = latest;
      s1 = latest;
      isExtrapolating = true;
    } else {
      for (let i = 0; i < this.snapshots.length - 1; i++) {
        if (
          this.snapshots[i].simTimeMs <= clampedRenderMs &&
          clampedRenderMs <= this.snapshots[i + 1].simTimeMs
        ) {
          s0 = this.snapshots[i];
          s1 = this.snapshots[i + 1];
          break;
        }
      }
    }

    const spanMs = Math.max(1, s1.simTimeMs - s0.simTimeMs);
    const alpha = isExtrapolating
      ? 0
      : Math.max(0, Math.min(1, (clampedRenderMs - s0.simTimeMs) / spanMs));
    const spanSec = spanMs / 1000;
    const extrapSec = isExtrapolating
      ? Math.min((clampedRenderMs - latest.simTimeMs) / 1000, this.maxExtrapolationMs / 1000)
      : 0;

    for (const ball of balls) {
      const a = s0.balls.get(ball.id);
      const b = s1.balls.get(ball.id);
      if (!a) continue;

      const prevX = ball.x;
      const prevY = ball.y;

      if (isExtrapolating || !b || s0 === s1) {
        if (a.pocketed) {
          if (!ball.pocketed) {
            ball.pocketed = true;
            ball.pocketAnim = 1;
            ball.vx = 0;
            ball.vy = 0;
            pocketEventHappened = true;
            audio?.onPocket?.();
          }
          ball.x = a.x;
          ball.y = a.y;
        } else {
          // Damped velocity extrapolation clamped strictly inside playfield cushions
          const speed = Math.hypot(a.vx, a.vy);
          let targetX = a.x;
          let targetY = a.y;
          if (speed > 4 && extrapSec > 0) {
            const decel = ROLLING_DECEL;
            const effectiveT = Math.min(extrapSec, speed / Math.max(decel, 1));
            const avgScale = Math.max(0, 1 - (decel * effectiveT) / (2 * speed));
            targetX = a.x + a.vx * effectiveT * avgScale;
            targetY = a.y + a.vy * effectiveT * avgScale;
            targetX = Math.max(FIELD_LEFT + BALL_RADIUS, Math.min(FIELD_RIGHT - BALL_RADIUS, targetX));
            targetY = Math.max(FIELD_TOP + BALL_RADIUS, Math.min(FIELD_BOTTOM - BALL_RADIUS, targetY));
          }
          const smoothBlend = 1 - Math.exp(-26 * dtSec);
          ball.x += (targetX - ball.x) * smoothBlend;
          ball.y += (targetY - ball.y) * smoothBlend;
          ball.vx = a.vx;
          ball.vy = a.vy;
        }
      } else {
        // Bracketed interpolation between s0 and s1
        const becomesPocketed = b.pocketed && (a.pocketed || alpha >= 0.55);
        if (becomesPocketed) {
          if (!ball.pocketed) {
            ball.pocketed = true;
            ball.pocketAnim = 1;
            ball.vx = 0;
            ball.vy = 0;
            pocketEventHappened = true;
            audio?.onPocket?.();
          }
          ball.x = b.x;
          ball.y = b.y;
        } else if (!a.pocketed) {
          const interp = this.interpolateBallPair(a, b, alpha, spanSec);
          ball.x = interp.x;
          ball.y = interp.y;
          ball.vx = interp.vx;
          ball.vy = interp.vy;

          // Subtle collision / rail audio detection from sudden velocity deflection
          const prevV = this.prevVelByBall.get(ball.id);
          if (prevV) {
            const dvx = interp.vx - prevV.vx;
            const dvy = interp.vy - prevV.vy;
            const impulse = Math.hypot(dvx, dvy);
            if (impulse > 165) {
              const nearRail =
                ball.x <= FIELD_LEFT + BALL_RADIUS + 8 ||
                ball.x >= FIELD_RIGHT - BALL_RADIUS - 8 ||
                ball.y <= FIELD_TOP + BALL_RADIUS + 8 ||
                ball.y >= FIELD_BOTTOM - BALL_RADIUS - 8;
              if (nearRail && nowMs - this.lastRailAudioMs > 55) {
                this.lastRailAudioMs = nowMs;
                audio?.onRailHit?.(impulse * 0.7);
              } else if (!nearRail && nowMs - this.lastCollisionAudioMs > 45) {
                this.lastCollisionAudioMs = nowMs;
                audio?.onBallHit?.(impulse * 0.8);
              }
            }
          }
          this.prevVelByBall.set(ball.id, { vx: interp.vx, vy: interp.vy });
        }
      }

      // Roll the 3D ball texture realistically along its visual displacement
      if (!ball.pocketed) {
        const dx = ball.x - prevX;
        const dy = ball.y - prevY;
        if (dx * dx + dy * dy > 1e-4) {
          applyRollingRotation(ball.rot, dx, dy, ball.radius);
        }
      }
    }

    // Check if deferred authoritative sync_state is now ready to commit seamlessly
    let readyFinalState: AuthoritativeStatePayload | null = null;
    if (this.pendingFinalState !== null) {
      const reachedEnd = clampedRenderMs >= this.finalSimTimeMs - 4;
      const exceededMaxHold = nowMs - this.finalStateQueuedAtMs >= this.maxFinalStateHoldMs;
      if (reachedEnd || exceededMaxHold) {
        readyFinalState = this.pendingFinalState;
        this.reset();
      }
    }

    return { pocketEventHappened, readyFinalState };
  }

  /**
   * Cubic Hermite interpolation along smooth rolling segments, automatically falling back to
   * linear interpolation when a sharp collision/bounce occurred inside the interval so balls
   * never curve outside rails or through other balls.
   */
  private interpolateBallPair(
    a: BufferedBallSample,
    b: BufferedBallSample,
    t: number,
    dtSec: number,
  ): { x: number; y: number; vx: number; vy: number } {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);

    const speedA = Math.hypot(a.vx, a.vy);
    const speedB = Math.hypot(b.vx, b.vy);
    const vx = a.vx + (b.vx - a.vx) * t;
    const vy = a.vy + (b.vy - a.vy) * t;

    // Detect bounce or abrupt stop between a and b -> use crisp linear interpolation
    let useHermite = dist > 2 && dtSec > 0.005 && dtSec < 0.35 && speedA > 12 && speedB > 12;
    if (useHermite) {
      const dot = (a.vx * b.vx + a.vy * b.vy) / (speedA * speedB);
      const chordSpeed = dist / dtSec;
      const avgSpeed = (speedA + speedB) * 0.5;
      // If direction turned > ~28 deg or speed mismatch indicates mid-interval bounce, stay linear
      if (dot < 0.88 || Math.abs(chordSpeed - avgSpeed) > avgSpeed * 0.35) {
        useHermite = false;
      }
    }

    if (!useHermite) {
      return {
        x: a.x + dx * t,
        y: a.y + dy * t,
        vx,
        vy,
      };
    }

    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;

    const rawX = h00 * a.x + h10 * (a.vx * dtSec) + h01 * b.x + h11 * (b.vx * dtSec);
    const rawY = h00 * a.y + h10 * (a.vy * dtSec) + h01 * b.y + h11 * (b.vy * dtSec);

    return {
      x: Math.max(FIELD_LEFT + BALL_RADIUS, Math.min(FIELD_RIGHT - BALL_RADIUS, rawX)),
      y: Math.max(FIELD_TOP + BALL_RADIUS, Math.min(FIELD_BOTTOM - BALL_RADIUS, rawY)),
      vx,
      vy,
    };
  }
}
