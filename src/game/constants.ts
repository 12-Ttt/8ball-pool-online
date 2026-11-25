import type { ClothTheme, Vec2 } from './types';

// Logical playing surface dimensions (2:1 regulation pool table proportions)
export const PLAY_W = 1000;
export const PLAY_H = 500;
export const RAIL_THICKNESS = 58;
export const TABLE_W = PLAY_W + RAIL_THICKNESS * 2;
export const TABLE_H = PLAY_H + RAIL_THICKNESS * 2;

// Playing field bounds inside full canvas coordinate space
export const FIELD_LEFT = RAIL_THICKNESS;
export const FIELD_RIGHT = RAIL_THICKNESS + PLAY_W;
export const FIELD_TOP = RAIL_THICKNESS;
export const FIELD_BOTTOM = RAIL_THICKNESS + PLAY_H;

// Standard ball geometry & physics parameters
export const BALL_RADIUS = 14;
export const HEAD_STRING_X = FIELD_LEFT + PLAY_W * 0.25;
export const FOOT_SPOT_X = FIELD_LEFT + PLAY_W * 0.75;
export const CENTER_Y = FIELD_TOP + PLAY_H * 0.5;

// Pocket geometry
export interface PocketDef {
  id: number;
  x: number;
  y: number;
  captureRadius: number;
  /** Outer slate bevel/lip radius where gentle shots glide around the curved jaw into the drop */
  lipRadius: number;
  drawRadius: number;
  isCorner: boolean;
}

// Chinese 8-Ball (中式八球) rounded snooker-style pocket geometry (~1.54x corner / ~1.57x side throat)
const CORNER_OFFSET = 2;
const SIDE_OFFSET = 10;

export const POCKETS: PocketDef[] = [
  { id: 0, x: FIELD_LEFT + CORNER_OFFSET, y: FIELD_TOP + CORNER_OFFSET, captureRadius: 21.5, lipRadius: 33, drawRadius: 23.5, isCorner: true },
  { id: 1, x: FIELD_LEFT + PLAY_W * 0.5, y: FIELD_TOP - SIDE_OFFSET, captureRadius: 21.5, lipRadius: 32, drawRadius: 23, isCorner: false },
  { id: 2, x: FIELD_RIGHT - CORNER_OFFSET, y: FIELD_TOP + CORNER_OFFSET, captureRadius: 21.5, lipRadius: 33, drawRadius: 23.5, isCorner: true },
  { id: 3, x: FIELD_LEFT + CORNER_OFFSET, y: FIELD_BOTTOM - CORNER_OFFSET, captureRadius: 21.5, lipRadius: 33, drawRadius: 23.5, isCorner: true },
  { id: 4, x: FIELD_LEFT + PLAY_W * 0.5, y: FIELD_BOTTOM + SIDE_OFFSET, captureRadius: 21.5, lipRadius: 32, drawRadius: 23, isCorner: false },
  { id: 5, x: FIELD_RIGHT - CORNER_OFFSET, y: FIELD_BOTTOM - CORNER_OFFSET, captureRadius: 21.5, lipRadius: 33, drawRadius: 23.5, isCorner: true },
];

// Rounded cushion transition points (exact C1 tangency with flat rails via JAW_R)
export const CORNER_GAP = 36;
export const SIDE_GAP = 35;

// Circular rounded pocket horns (圆弧袋角) tangent to the flat cushions
export interface JawKnuckle {
  x: number;
  y: number;
  r: number;
}

export const JAW_R = 13;

export const JAW_KNUCKLES: JawKnuckle[] = [
  // Top-left pocket rounded horns
  { x: FIELD_LEFT + CORNER_GAP, y: FIELD_TOP - JAW_R, r: JAW_R },
  { x: FIELD_LEFT - JAW_R, y: FIELD_TOP + CORNER_GAP, r: JAW_R },
  // Top-middle pocket rounded horns
  { x: FIELD_LEFT + PLAY_W * 0.5 - SIDE_GAP, y: FIELD_TOP - JAW_R, r: JAW_R },
  { x: FIELD_LEFT + PLAY_W * 0.5 + SIDE_GAP, y: FIELD_TOP - JAW_R, r: JAW_R },
  // Top-right pocket rounded horns
  { x: FIELD_RIGHT - CORNER_GAP, y: FIELD_TOP - JAW_R, r: JAW_R },
  { x: FIELD_RIGHT + JAW_R, y: FIELD_TOP + CORNER_GAP, r: JAW_R },
  // Bottom-left pocket rounded horns
  { x: FIELD_LEFT + CORNER_GAP, y: FIELD_BOTTOM + JAW_R, r: JAW_R },
  { x: FIELD_LEFT - JAW_R, y: FIELD_BOTTOM - CORNER_GAP, r: JAW_R },
  // Bottom-middle pocket rounded horns
  { x: FIELD_LEFT + PLAY_W * 0.5 - SIDE_GAP, y: FIELD_BOTTOM + JAW_R, r: JAW_R },
  { x: FIELD_LEFT + PLAY_W * 0.5 + SIDE_GAP, y: FIELD_BOTTOM + JAW_R, r: JAW_R },
  // Bottom-right pocket rounded horns
  { x: FIELD_RIGHT - CORNER_GAP, y: FIELD_BOTTOM + JAW_R, r: JAW_R },
  { x: FIELD_RIGHT + JAW_R, y: FIELD_BOTTOM - CORNER_GAP, r: JAW_R },
];

// Physics tuning constants
export const SUBSTEPS = 16;
export const MAX_SHOT_SPEED = 2350; // logical units / second
export const MIN_SHOT_SPEED = 180;
export const BALL_RESTITUTION = 0.95;
export const RAIL_RESTITUTION = 0.83;
export const ROLLING_DECEL = 118; // smooth tournament cloth rolling deceleration (units/s^2)
export const DRAG_FACTOR = 0.24; // light aerodynamic/felt drag for crisp glide
export const STOP_SPEED_SQ = 14; // clean rest threshold

export interface BallStyle {
  color: string;
  secondary?: string;
  isStripe: boolean;
  label: string;
}

export const BALL_STYLES: Record<number, BallStyle> = {
  0: { color: '#f7f4ec', isStripe: false, label: '白球' },
  1: { color: '#eab308', isStripe: false, label: '1号' },
  2: { color: '#1d4ed8', isStripe: false, label: '2号' },
  3: { color: '#dc2626', isStripe: false, label: '3号' },
  4: { color: '#6d28d9', isStripe: false, label: '4号' },
  5: { color: '#ea580c', isStripe: false, label: '5号' },
  6: { color: '#15803d', isStripe: false, label: '6号' },
  7: { color: '#881337', isStripe: false, label: '7号' },
  8: { color: '#141518', isStripe: false, label: '黑8' },
  9: { color: '#eab308', isStripe: true, label: '9号' },
  10: { color: '#1d4ed8', isStripe: true, label: '10号' },
  11: { color: '#dc2626', isStripe: true, label: '11号' },
  12: { color: '#6d28d9', isStripe: true, label: '12号' },
  13: { color: '#ea580c', isStripe: true, label: '13号' },
  14: { color: '#15803d', isStripe: true, label: '14号' },
  15: { color: '#881337', isStripe: true, label: '15号' },
};

export interface ClothPalette {
  name: string;
  center: string;
  edge: string;
  cushion: string;
  cushionHighlight: string;
  grainLight: string;
  grainDark: string;
  railWoodOuter: string;
  railWoodInner: string;
  swatch: string;
}

export const CLOTH_PALETTES: Record<ClothTheme, ClothPalette> = {
  green: {
    name: '经典中八绿',
    center: '#0e6943',
    edge: '#084129',
    cushion: '#0a4e32',
    cushionHighlight: '#178355',
    grainLight: 'rgba(255, 255, 255, 0.025)',
    grainDark: 'rgba(0, 0, 0, 0.045)',
    railWoodOuter: '#3b2014',
    railWoodInner: '#59311e',
    swatch: '#0e6943',
  },
  blue: {
    name: '中八大师蓝',
    center: '#1b587d',
    edge: '#0f3650',
    cushion: '#144462',
    cushionHighlight: '#27729e',
    grainLight: 'rgba(255, 255, 255, 0.024)',
    grainDark: 'rgba(0, 0, 0, 0.05)',
    railWoodOuter: '#272b34',
    railWoodInner: '#3b414f',
    swatch: '#1b587d',
  },
  burgundy: {
    name: '复古酒红',
    center: '#6b1d2c',
    edge: '#3f0f19',
    cushion: '#511420',
    cushionHighlight: '#8b2a3c',
    grainLight: 'rgba(255, 255, 255, 0.022)',
    grainDark: 'rgba(0, 0, 0, 0.055)',
    railWoodOuter: '#2d1a14',
    railWoodInner: '#472920',
    swatch: '#6b1d2c',
  },
};

export const QUICK_EMOTES: string[] = [
  '👏 好球！',
  '🔥 漂亮走位',
  '😅 手滑了',
  '🤔 容我想想',
  '🎯 这杆稳了',
  '👑 承让承让',
];

// Diamond sight positions along outer rails
export const RAIL_DIAMONDS: Vec2[] = (() => {
  const pts: Vec2[] = [];
  // Top and bottom rails (6 diamonds each, 3 per half)
  for (let i = 1; i <= 7; i++) {
    if (i === 4) continue; // side pocket
    const x = FIELD_LEFT + (PLAY_W / 8) * i;
    pts.push({ x, y: RAIL_THICKNESS * 0.45 });
    pts.push({ x, y: TABLE_H - RAIL_THICKNESS * 0.45 });
  }
  // Left and right rails (3 diamonds each)
  for (let j = 1; j <= 3; j++) {
    const y = FIELD_TOP + (PLAY_H / 4) * j;
    pts.push({ x: RAIL_THICKNESS * 0.45, y });
    pts.push({ x: TABLE_W - RAIL_THICKNESS * 0.45, y });
  }
  return pts;
})();
