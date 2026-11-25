export type GameMode = 'local' | 'ai' | 'online' | 'practice';
export type AIDifficulty = 'easy' | 'pro';
export type ClothTheme = 'green' | 'blue' | 'burgundy';
export type BallGroup = 'solids' | 'stripes' | null;
export type PlayerIndex = 0 | 1;

export type TurnPhase =
  | 'AIMING'
  | 'BALL_IN_HAND'
  | 'SHOOTING'
  | 'ANIMATING_CUE'
  | 'AI_THINKING'
  | 'GAME_OVER';

export interface Vec2 {
  x: number;
  y: number;
}

/** 3x3 rotation matrix stored row-major for realistic 3D ball rolling */
export type Mat3 = [
  number, number, number,
  number, number, number,
  number, number, number,
];

export interface Ball {
  id: number; // 0 = cue ball, 1-7 = solids, 8 = eight ball, 9-15 = stripes
  x: number;
  y: number;
  vx: number;
  vy: number;
  spinX: number; // -1 (left English) to +1 (right English)
  spinY: number; // -1 (draw/backspin) to +1 (follow/topspin)
  hasPostHitSpin: boolean;
  strikeDirX: number;
  strikeDirY: number;
  radius: number;
  pocketed: boolean;
  pocketAnim: number; // 0..1 shrink progress into pocket
  pocketTargetX: number;
  pocketTargetY: number;
  rot: Mat3;
}

export interface ShotRecord {
  firstHitBallId: number | null;
  pocketedIds: number[];
  railHitAfterContact: boolean;
  breakRailBallIds: Set<number>;
  cueScratched: boolean;
  cueBallHitRailCount: number;
}

export interface PlayerStats {
  shots: number;
  potted: number;
  currentStreak: number;
  maxStreak: number;
  fouls: number;
}

export interface PlayerInfo {
  name: string;
  group: BallGroup;
  stats: PlayerStats;
}

export interface GameSettings {
  clothTheme: ClothTheme;
  beginnerMode: boolean;
  practiceMode: boolean;
  shotClockSeconds: number; // 0 = off, 30, 45
  muted: boolean;
}

export interface GameNotice {
  id: number;
  title: string;
  detail?: string;
  tone: 'info' | 'foul' | 'success';
}

export interface AimPreview {
  cueX: number;
  cueY: number;
  ghostX: number;
  ghostY: number;
  hitBallId: number | null;
  isIllegalTarget: boolean;
  targetLineEnd: Vec2 | null;
  targetBounceEnd: Vec2 | null;
  cueDeflectEnd: Vec2 | null;
  railBounceEnd: Vec2 | null;
}

export interface SerializedBall {
  id: number;
  x: number;
  y: number;
  pocketed: boolean;
  rot: Mat3;
}

export interface AuthoritativeStatePayload {
  balls: SerializedBall[];
  currentPlayer: PlayerIndex;
  lastBreaker: PlayerIndex;
  rackNumber: number;
  phase: TurnPhase;
  isBreak: boolean;
  kitchenOnly: boolean;
  players: [PlayerInfo, PlayerInfo];
  winner: PlayerIndex | null;
  winReason: string;
  notice: GameNotice | null;
}

export interface ChatBubble {
  player: PlayerIndex;
  text: string;
  timestamp: number;
}

export type PeerConnectionStatus =
  | 'idle'
  | 'creating'
  | 'waiting'
  | 'joining'
  | 'connected'
  | 'disconnected'
  | 'error';

/** Compact live ball frame: [id, x, y, vx, vy, pocketed(0|1)] */
export type CompactBallTick = [number, number, number, number, number, number];

export type PeerMessage =
  | {
      type: 'hello';
      name: string;
      settings?: Partial<GameSettings>;
    }
  | {
      type: 'start_game';
      hostName: string;
      guestName: string;
      settings: GameSettings;
      initialState: AuthoritativeStatePayload;
    }
  | {
      type: 'aim';
      angle: number;
      power: number;
      spinX: number;
      spinY: number;
    }
  | {
      type: 'drag_cue';
      x: number;
      y: number;
      valid: boolean;
    }
  | {
      type: 'place_cue';
      x: number;
      y: number;
    }
  | {
      type: 'shot';
      shotSeq: number;
      angle: number;
      power: number;
      spinX: number;
      spinY: number;
      cueX: number;
      cueY: number;
    }
  | {
      type: 'balls_tick';
      shotSeq: number;
      /** Milliseconds elapsed on the shooting peer since cue impact (clock-skew-free) */
      simTimeMs: number;
      balls: CompactBallTick[];
    }
  | {
      type: 'sync_state';
      state: AuthoritativeStatePayload;
      shotSeq?: number;
    }
  | {
      type: 'emote';
      text: string;
      sender: PlayerIndex;
    }
  | {
      type: 'settings_update';
      settings: Partial<GameSettings>;
    }
  | {
      type: 'rematch_request';
    }
  | {
      type: 'rematch_accept';
      initialState: AuthoritativeStatePayload;
    }
  | {
      type: 'request_sync';
    };
