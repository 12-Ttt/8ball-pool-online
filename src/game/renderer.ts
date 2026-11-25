import {
  BALL_RADIUS,
  BALL_STYLES,
  CENTER_Y,
  CLOTH_PALETTES,
  CORNER_GAP,
  FIELD_BOTTOM,
  FIELD_LEFT,
  FIELD_RIGHT,
  FIELD_TOP,
  FOOT_SPOT_X,
  HEAD_STRING_X,
  JAW_R,
  PLAY_H,
  PLAY_W,
  POCKETS,
  RAIL_DIAMONDS,
  RAIL_THICKNESS,
  SIDE_GAP,
  TABLE_H,
  TABLE_W,
} from './constants';
import type { AimPreview, Ball, ClothTheme } from './types';

export interface ChalkParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
}

export interface RenderState {
  balls: Ball[];
  clothTheme: ClothTheme;
  showCue: boolean;
  cueAngle: number;
  cuePower: number; // 0..1 pullback
  cueStrikeThrust: number; // 0..1 forward follow-through animation
  aimPreview: AimPreview | null;
  isBallInHand: boolean;
  kitchenOnly: boolean;
  cueDragValid: boolean;
  isDraggingCue: boolean;
  isRemoteTurn: boolean;
  particles: ChalkParticle[];
}

// Cache rendered static table layers per cloth theme so 60fps loop stays ultra-light
const tableCache = new Map<ClothTheme, HTMLCanvasElement>();

function getTableBaseCanvas(theme: ClothTheme): HTMLCanvasElement {
  const cached = tableCache.get(theme);
  if (cached) return cached;

  const offscreen = document.createElement('canvas');
  offscreen.width = TABLE_W;
  offscreen.height = TABLE_H;
  const ctx = offscreen.getContext('2d')!;
  const pal = CLOTH_PALETTES[theme];

  // 1. Outer hardwood frame with rounded corners
  const outerR = 26;
  ctx.save();
  roundRectPath(ctx, 0, 0, TABLE_W, TABLE_H, outerR);
  const woodGrad = ctx.createLinearGradient(0, 0, TABLE_W, TABLE_H);
  woodGrad.addColorStop(0, pal.railWoodInner);
  woodGrad.addColorStop(0.5, pal.railWoodOuter);
  woodGrad.addColorStop(1, '#1d100a');
  ctx.fillStyle = woodGrad;
  ctx.fill();

  // Subtle wood grain lines clipped to frame
  ctx.clip();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.025)';
  ctx.lineWidth = 1.5;
  for (let y = 4; y < TABLE_H; y += 7) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(TABLE_W, y + Math.sin(y * 0.08) * 3);
    ctx.stroke();
  }

  // Outer rim top bevel highlight
  ctx.strokeStyle = 'rgba(255, 232, 198, 0.16)';
  ctx.lineWidth = 3;
  roundRectPath(ctx, 2, 2, TABLE_W - 4, TABLE_H - 4, outerR - 2);
  ctx.stroke();
  ctx.restore();

  // 2. Brushed brass corner plates & side pocket plates
  drawBrassPocketPlates(ctx);

  // 3. Inner recessed cushion lip (dark trim bordering felt)
  ctx.save();
  ctx.fillStyle = '#09110d';
  roundRectPath(ctx, FIELD_LEFT - 14, FIELD_TOP - 14, PLAY_W + 28, PLAY_H + 28, 12);
  ctx.fill();
  ctx.restore();

  // 4. Playing felt cloth surface
  ctx.save();
  ctx.beginPath();
  ctx.rect(FIELD_LEFT, FIELD_TOP, PLAY_W, PLAY_H);
  ctx.clip();

  const feltGrad = ctx.createRadialGradient(
    FIELD_LEFT + PLAY_W * 0.5,
    FIELD_TOP + PLAY_H * 0.5,
    40,
    FIELD_LEFT + PLAY_W * 0.5,
    FIELD_TOP + PLAY_H * 0.5,
    PLAY_W * 0.68,
  );
  feltGrad.addColorStop(0, pal.center);
  feltGrad.addColorStop(1, pal.edge);
  ctx.fillStyle = feltGrad;
  ctx.fillRect(FIELD_LEFT, FIELD_TOP, PLAY_W, PLAY_H);

  // Subtle woven baize micro-grain
  let seed = 1337;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  for (let i = 0; i < 9500; i++) {
    const gx = FIELD_LEFT + rand() * PLAY_W;
    const gy = FIELD_TOP + rand() * PLAY_H;
    ctx.fillStyle = i % 2 === 0 ? pal.grainLight : pal.grainDark;
    ctx.fillRect(gx, gy, 1.5, 1.5);
  }

  // Chinese 8-Ball (中式八球) baulk line & iconic D-zone semi-circle
  ctx.strokeStyle = 'rgba(243, 239, 230, 0.2)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(HEAD_STRING_X, FIELD_TOP + 2);
  ctx.lineTo(HEAD_STRING_X, FIELD_BOTTOM - 2);
  ctx.stroke();

  // D-shaped semi-circle facing left from the baulk line
  const dRadius = PLAY_H * 0.165;
  ctx.beginPath();
  ctx.arc(HEAD_STRING_X, CENTER_Y, dRadius, Math.PI * 0.5, Math.PI * 1.5);
  ctx.stroke();

  // Head spot, center spot, and foot spot (置球点)
  const drawSpot = (sx: number, sy: number) => {
    ctx.fillStyle = 'rgba(243, 239, 230, 0.36)';
    ctx.beginPath();
    ctx.arc(sx, sy, 3.2, 0, Math.PI * 2);
    ctx.fill();
  };
  drawSpot(HEAD_STRING_X, CENTER_Y);
  drawSpot(FIELD_LEFT + PLAY_W * 0.5, CENTER_Y);
  drawSpot(FOOT_SPOT_X, CENTER_Y);

  // Subtle inner cushion shadows cast onto the felt
  const shadowSize = 18;
  const topSh = ctx.createLinearGradient(0, FIELD_TOP, 0, FIELD_TOP + shadowSize);
  topSh.addColorStop(0, 'rgba(0, 0, 0, 0.42)');
  topSh.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = topSh;
  ctx.fillRect(FIELD_LEFT, FIELD_TOP, PLAY_W, shadowSize);

  const botSh = ctx.createLinearGradient(0, FIELD_BOTTOM, 0, FIELD_BOTTOM - shadowSize);
  botSh.addColorStop(0, 'rgba(0, 0, 0, 0.32)');
  botSh.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = botSh;
  ctx.fillRect(FIELD_LEFT, FIELD_BOTTOM - shadowSize, PLAY_W, shadowSize);

  const leftSh = ctx.createLinearGradient(FIELD_LEFT, 0, FIELD_LEFT + shadowSize, 0);
  leftSh.addColorStop(0, 'rgba(0, 0, 0, 0.38)');
  leftSh.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = leftSh;
  ctx.fillRect(FIELD_LEFT, FIELD_TOP, shadowSize, PLAY_H);

  const rightSh = ctx.createLinearGradient(FIELD_RIGHT, 0, FIELD_RIGHT - shadowSize, 0);
  rightSh.addColorStop(0, 'rgba(0, 0, 0, 0.38)');
  rightSh.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = rightSh;
  ctx.fillRect(FIELD_RIGHT - shadowSize, FIELD_TOP, shadowSize, PLAY_H);

  ctx.restore();

  // 5. Six beveled felt cushions bordering the playing field
  drawCushions(ctx, pal);

  // 6. Six recessed leather pockets
  for (const p of POCKETS) {
    // Outer leather collar shadow
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.drawRadius + 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fill();

    // Deep pocket hole
    const pGrad = ctx.createRadialGradient(p.x - 3, p.y - 3, 2, p.x, p.y, p.drawRadius);
    pGrad.addColorStop(0, '#07080a');
    pGrad.addColorStop(0.75, '#0b0c10');
    pGrad.addColorStop(1, '#1d1e24');
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.drawRadius, 0, Math.PI * 2);
    ctx.fillStyle = pGrad;
    ctx.fill();

    // Subtle metallic/leather inner rim
    ctx.strokeStyle = 'rgba(212, 168, 83, 0.25)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  // 7. Inlaid ivory diamond aiming sights along wooden rails
  for (const d of RAIL_DIAMONDS) {
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = '#e7decb';
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 2;
    ctx.fillRect(-3.6, -3.6, 7.2, 7.2);
    ctx.strokeStyle = '#9a7a3a';
    ctx.lineWidth = 0.8;
    ctx.strokeRect(-3.6, -3.6, 7.2, 7.2);
    ctx.restore();
  }

  tableCache.set(theme, offscreen);
  return offscreen;
}

function drawBrassPocketPlates(ctx: CanvasRenderingContext2D): void {
  const brass = ctx.createLinearGradient(0, 0, TABLE_W, TABLE_H);
  brass.addColorStop(0, '#c89e4b');
  brass.addColorStop(0.35, '#8c6927');
  brass.addColorStop(0.65, '#ddb667');
  brass.addColorStop(1, '#78571e');

  ctx.save();
  ctx.fillStyle = brass;
  ctx.strokeStyle = 'rgba(0,0,0,0.45)';
  ctx.lineWidth = 1.5;

  // Four corner brass castings
  const cornerLen = 78;
  const r = 26;
  const drawCorner = (flipX: boolean, flipY: boolean) => {
    ctx.save();
    ctx.translate(flipX ? TABLE_W : 0, flipY ? TABLE_H : 0);
    ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1);
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(cornerLen, 0);
    ctx.lineTo(cornerLen - 10, RAIL_THICKNESS - 12);
    ctx.lineTo(RAIL_THICKNESS - 12, cornerLen - 10);
    ctx.lineTo(0, cornerLen);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  };

  drawCorner(false, false);
  drawCorner(true, false);
  drawCorner(false, true);
  drawCorner(true, true);

  // Two side pocket brass plates
  const midX = FIELD_LEFT + PLAY_W * 0.5;
  const drawSidePlate = (yTop: boolean) => {
    const y0 = yTop ? 0 : TABLE_H - (RAIL_THICKNESS - 12);
    const h = RAIL_THICKNESS - 12;
    ctx.beginPath();
    ctx.rect(midX - 38, y0, 76, h);
    ctx.fill();
    ctx.stroke();
  };
  drawSidePlate(true);
  drawSidePlate(false);

  ctx.restore();
}

function drawCushions(
  ctx: CanvasRenderingContext2D,
  pal: (typeof CLOTH_PALETTES)[ClothTheme],
): void {
  const midX = FIELD_LEFT + PLAY_W * 0.5;
  const r = JAW_R; // Exact match with physics circular rounded horns (圆弧袋角)

  const fillAndStrokeCushion = (drawPath: () => void, drawHighlight: () => void) => {
    ctx.save();
    drawPath();
    ctx.fillStyle = pal.cushion;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.strokeStyle = pal.cushionHighlight;
    ctx.lineWidth = 1.4;
    drawHighlight();
    ctx.stroke();
    ctx.restore();
  };

  // Top-left rounded cushion
  fillAndStrokeCushion(
    () => {
      ctx.beginPath();
      ctx.moveTo(FIELD_LEFT + CORNER_GAP - r, FIELD_TOP - r);
      ctx.lineTo(midX - SIDE_GAP + r, FIELD_TOP - r);
      ctx.arc(midX - SIDE_GAP, FIELD_TOP - r, r, 0, Math.PI * 0.5);
      ctx.lineTo(FIELD_LEFT + CORNER_GAP, FIELD_TOP);
      ctx.arc(FIELD_LEFT + CORNER_GAP, FIELD_TOP - r, r, Math.PI * 0.5, Math.PI);
      ctx.closePath();
    },
    () => {
      ctx.beginPath();
      ctx.arc(midX - SIDE_GAP, FIELD_TOP - r, r, 0.15, Math.PI * 0.5);
      ctx.lineTo(FIELD_LEFT + CORNER_GAP, FIELD_TOP);
      ctx.arc(FIELD_LEFT + CORNER_GAP, FIELD_TOP - r, r, Math.PI * 0.5, Math.PI - 0.15);
    },
  );

  // Top-right rounded cushion
  fillAndStrokeCushion(
    () => {
      ctx.beginPath();
      ctx.moveTo(midX + SIDE_GAP - r, FIELD_TOP - r);
      ctx.lineTo(FIELD_RIGHT - CORNER_GAP + r, FIELD_TOP - r);
      ctx.arc(FIELD_RIGHT - CORNER_GAP, FIELD_TOP - r, r, 0, Math.PI * 0.5);
      ctx.lineTo(midX + SIDE_GAP, FIELD_TOP);
      ctx.arc(midX + SIDE_GAP, FIELD_TOP - r, r, Math.PI * 0.5, Math.PI);
      ctx.closePath();
    },
    () => {
      ctx.beginPath();
      ctx.arc(FIELD_RIGHT - CORNER_GAP, FIELD_TOP - r, r, 0.15, Math.PI * 0.5);
      ctx.lineTo(midX + SIDE_GAP, FIELD_TOP);
      ctx.arc(midX + SIDE_GAP, FIELD_TOP - r, r, Math.PI * 0.5, Math.PI - 0.15);
    },
  );

  // Bottom-left rounded cushion
  fillAndStrokeCushion(
    () => {
      ctx.beginPath();
      ctx.moveTo(FIELD_LEFT + CORNER_GAP - r, FIELD_BOTTOM + r);
      ctx.arc(FIELD_LEFT + CORNER_GAP, FIELD_BOTTOM + r, r, Math.PI, Math.PI * 1.5);
      ctx.lineTo(midX - SIDE_GAP, FIELD_BOTTOM);
      ctx.arc(midX - SIDE_GAP, FIELD_BOTTOM + r, r, Math.PI * 1.5, Math.PI * 2);
      ctx.closePath();
    },
    () => {
      ctx.beginPath();
      ctx.arc(FIELD_LEFT + CORNER_GAP, FIELD_BOTTOM + r, r, Math.PI + 0.15, Math.PI * 1.5);
      ctx.lineTo(midX - SIDE_GAP, FIELD_BOTTOM);
      ctx.arc(midX - SIDE_GAP, FIELD_BOTTOM + r, r, Math.PI * 1.5, Math.PI * 2 - 0.15);
    },
  );

  // Bottom-right rounded cushion
  fillAndStrokeCushion(
    () => {
      ctx.beginPath();
      ctx.moveTo(midX + SIDE_GAP - r, FIELD_BOTTOM + r);
      ctx.arc(midX + SIDE_GAP, FIELD_BOTTOM + r, r, Math.PI, Math.PI * 1.5);
      ctx.lineTo(FIELD_RIGHT - CORNER_GAP, FIELD_BOTTOM);
      ctx.arc(FIELD_RIGHT - CORNER_GAP, FIELD_BOTTOM + r, r, Math.PI * 1.5, Math.PI * 2);
      ctx.closePath();
    },
    () => {
      ctx.beginPath();
      ctx.arc(midX + SIDE_GAP, FIELD_BOTTOM + r, r, Math.PI + 0.15, Math.PI * 1.5);
      ctx.lineTo(FIELD_RIGHT - CORNER_GAP, FIELD_BOTTOM);
      ctx.arc(FIELD_RIGHT - CORNER_GAP, FIELD_BOTTOM + r, r, Math.PI * 1.5, Math.PI * 2 - 0.15);
    },
  );

  // Left rounded cushion
  fillAndStrokeCushion(
    () => {
      ctx.beginPath();
      ctx.moveTo(FIELD_LEFT - r, FIELD_TOP + CORNER_GAP - r);
      ctx.arc(FIELD_LEFT - r, FIELD_TOP + CORNER_GAP, r, -Math.PI * 0.5, 0);
      ctx.lineTo(FIELD_LEFT, FIELD_BOTTOM - CORNER_GAP);
      ctx.arc(FIELD_LEFT - r, FIELD_BOTTOM - CORNER_GAP, r, 0, Math.PI * 0.5);
      ctx.closePath();
    },
    () => {
      ctx.beginPath();
      ctx.arc(FIELD_LEFT - r, FIELD_TOP + CORNER_GAP, r, -Math.PI * 0.5 + 0.15, 0);
      ctx.lineTo(FIELD_LEFT, FIELD_BOTTOM - CORNER_GAP);
      ctx.arc(FIELD_LEFT - r, FIELD_BOTTOM - CORNER_GAP, r, 0, Math.PI * 0.5 - 0.15);
    },
  );

  // Right rounded cushion
  fillAndStrokeCushion(
    () => {
      ctx.beginPath();
      ctx.moveTo(FIELD_RIGHT + r, FIELD_BOTTOM - CORNER_GAP + r);
      ctx.arc(FIELD_RIGHT + r, FIELD_BOTTOM - CORNER_GAP, r, Math.PI * 0.5, Math.PI);
      ctx.lineTo(FIELD_RIGHT, FIELD_TOP + CORNER_GAP);
      ctx.arc(FIELD_RIGHT + r, FIELD_TOP + CORNER_GAP, r, Math.PI, Math.PI * 1.5);
      ctx.closePath();
    },
    () => {
      ctx.beginPath();
      ctx.arc(FIELD_RIGHT + r, FIELD_BOTTOM - CORNER_GAP, r, Math.PI * 0.5 + 0.15, Math.PI);
      ctx.lineTo(FIELD_RIGHT, FIELD_TOP + CORNER_GAP);
      ctx.arc(FIELD_RIGHT + r, FIELD_TOP + CORNER_GAP, r, Math.PI, Math.PI * 1.5 - 0.15);
    },
  );
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** Draw a single 3D-shaded rolling pool ball */
function drawPoolBall(ctx: CanvasRenderingContext2D, ball: Ball): void {
  if (ball.pocketed && ball.pocketAnim >= 1) return;

  const scale = ball.pocketed ? Math.max(0.28, 1 - ball.pocketAnim * 0.72) : 1;
  const alpha = ball.pocketed ? Math.max(0, 1 - ball.pocketAnim * 0.95) : 1;
  const r = ball.radius * scale;
  const style = BALL_STYLES[ball.id];
  if (!style) return;

  ctx.save();
  ctx.globalAlpha = alpha;

  // 1. Directional contact shadow projected from overhead table lamp
  if (!ball.pocketed) {
    const lampX = FIELD_LEFT + PLAY_W * 0.5;
    const lampY = FIELD_TOP + PLAY_H * 0.5;
    const shDx = ((ball.x - lampX) / PLAY_W) * 6 + 2.5;
    const shDy = ((ball.y - lampY) / PLAY_H) * 5 + 3.5;

    ctx.beginPath();
    ctx.arc(ball.x + shDx, ball.y + shDy, r * 1.03, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
    ctx.fill();
  }

  // 2. Ball body clipped to sphere circle
  ctx.save();
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, r, 0, Math.PI * 2);
  ctx.clip();

  if (ball.id === 0) {
    // Ivory cue ball
    ctx.fillStyle = '#f8f5ee';
    ctx.fillRect(ball.x - r, ball.y - r, r * 2, r * 2);

    // Subtle red Pro-Cup orientation dots so players see cue spin visually!
    const m = ball.rot;
    const poles: Array<[number, number, number]> = [
      [m[2], m[5], m[8]],
      [-m[2], -m[5], -m[8]],
      [m[0], m[3], m[6]],
      [-m[0], -m[3], -m[6]],
    ];
    for (const [px, py, pz] of poles) {
      if (pz > 0.12) {
        ctx.fillStyle = `rgba(195, 38, 38, ${Math.min(0.85, pz * 0.95)})`;
        ctx.beginPath();
        ctx.ellipse(
          ball.x + px * r * 0.85,
          ball.y + py * r * 0.85,
          2.1 * scale,
          2.1 * scale * Math.max(0.35, pz),
          Math.atan2(py, px),
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
    }
  } else if (style.isStripe) {
    // Striped ball: ivory base + rotated equatorial color band
    ctx.fillStyle = '#f7f3e9';
    ctx.fillRect(ball.x - r, ball.y - r, r * 2, r * 2);

    // Orientation of the stripe band using local Y axis (rot[1], rot[4], rot[7])
    const ax = ball.rot[1];
    const ay = ball.rot[4];
    const az = ball.rot[7];
    const bandAngle = Math.atan2(ay, ax);
    const bandWidth = r * 1.12;

    ctx.save();
    ctx.translate(ball.x, ball.y);
    ctx.rotate(bandAngle);
    ctx.fillStyle = style.color;
    // Slight offset as pole tilts gives natural 3D stripe roll impression
    const tiltOffset = az * r * 0.25;
    ctx.fillRect(-r * 1.4, -bandWidth * 0.5 + tiltOffset, r * 2.8, bandWidth);
    ctx.restore();
  } else {
    // Solid ball
    ctx.fillStyle = style.color;
    ctx.fillRect(ball.x - r, ball.y - r, r * 2, r * 2);
  }

  // 3. Number disc & crisp numeral (projected from top or bottom pole of 3D rotation matrix)
  if (ball.id !== 0) {
    const m = ball.rot;
    // Choose whichever of the two opposing number poles faces upward (z >= 0)
    const sign = m[8] >= 0 ? 1 : -1;
    const nx = m[2] * sign;
    const ny = m[5] * sign;
    const nz = Math.max(0.15, m[8] * sign);

    const discX = ball.x + nx * r * 0.72;
    const discY = ball.y + ny * r * 0.72;
    const discR = r * 0.48;
    const squash = Math.max(0.32, nz);
    const tiltAngle = Math.atan2(ny, nx);

    ctx.save();
    ctx.translate(discX, discY);
    ctx.rotate(tiltAngle);
    ctx.scale(squash, 1);
    ctx.rotate(-tiltAngle);

    ctx.fillStyle = '#faf7f0';
    ctx.beginPath();
    ctx.arc(0, 0, discR, 0, Math.PI * 2);
    ctx.fill();

    // Subtle dark ring on disc edge for extra legibility
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.14)';
    ctx.lineWidth = 0.7;
    ctx.stroke();

    // Crisp bold ball number
    ctx.fillStyle = '#141518';
    ctx.font = `700 ${Math.round((ball.id >= 10 ? 8.5 : 9.8) * scale)}px "Plus Jakarta Sans", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(ball.id), 0, 0.6);

    // Classic underline beneath 6 and 9
    if (ball.id === 6 || ball.id === 9) {
      ctx.fillRect(-2.5 * scale, 4.2 * scale, 5 * scale, 0.9 * scale);
    }
    ctx.restore();
  }

  // 4. 3D spherical shading gradient (ambient occlusion + rim depth)
  const shadeGrad = ctx.createRadialGradient(
    ball.x - r * 0.34,
    ball.y - r * 0.34,
    r * 0.1,
    ball.x,
    ball.y,
    r,
  );
  shadeGrad.addColorStop(0, 'rgba(255, 255, 255, 0.24)');
  shadeGrad.addColorStop(0.45, 'rgba(255, 255, 255, 0)');
  shadeGrad.addColorStop(0.82, 'rgba(0, 0, 0, 0.24)');
  shadeGrad.addColorStop(1, 'rgba(0, 0, 0, 0.52)');
  ctx.fillStyle = shadeGrad;
  ctx.fillRect(ball.x - r, ball.y - r, r * 2, r * 2);

  // 5. Crisp overhead specular highlight
  ctx.fillStyle = 'rgba(255, 255, 255, 0.62)';
  ctx.beginPath();
  ctx.ellipse(
    ball.x - r * 0.32,
    ball.y - r * 0.34,
    r * 0.24,
    r * 0.14,
    -Math.PI / 4,
    0,
    Math.PI * 2,
  );
  ctx.fill();

  ctx.restore(); // end sphere clip

  // Fine outer contour so dark 8-ball stands out crisply against deep shadows
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, r - 0.3, 0, Math.PI * 2);
  ctx.strokeStyle = ball.id === 8 ? 'rgba(255, 255, 255, 0.14)' : 'rgba(0, 0, 0, 0.22)';
  ctx.lineWidth = 0.8;
  ctx.stroke();

  ctx.restore();
}

/** Draw Ghost Ball and dual aiming trajectory guides */
function drawAimPreview(ctx: CanvasRenderingContext2D, aim: AimPreview, isRemote: boolean): void {
  ctx.save();

  const lineAlpha = isRemote ? 0.42 : 0.84;
  const mainColor = aim.isIllegalTarget
    ? `rgba(248, 113, 113, ${lineAlpha})`
    : `rgba(243, 239, 230, ${lineAlpha})`;

  // 1. Primary cue line from cue ball to Ghost Ball
  ctx.strokeStyle = mainColor;
  ctx.lineWidth = 1.8;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.moveTo(aim.cueX, aim.cueY);
  ctx.lineTo(aim.ghostX, aim.ghostY);
  ctx.stroke();
  ctx.setLineDash([]);

  // 2. Ghost Ball ring at exact first impact point
  ctx.beginPath();
  ctx.arc(aim.ghostX, aim.ghostY, BALL_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = aim.isIllegalTarget
    ? 'rgba(239, 68, 68, 0.14)'
    : 'rgba(243, 239, 230, 0.11)';
  ctx.fill();
  ctx.strokeStyle = aim.isIllegalTarget
    ? 'rgba(248, 113, 113, 0.92)'
    : 'rgba(243, 239, 230, 0.78)';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // Illegal target X mark inside Ghost Ball
  if (aim.isIllegalTarget) {
    const s = 5;
    ctx.strokeStyle = 'rgba(248, 113, 113, 0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(aim.ghostX - s, aim.ghostY - s);
    ctx.lineTo(aim.ghostX + s, aim.ghostY + s);
    ctx.moveTo(aim.ghostX + s, aim.ghostY - s);
    ctx.lineTo(aim.ghostX - s, aim.ghostY + s);
    ctx.stroke();
  }

  // 3. Target ball short directional hint (fades cleanly toward tip)
  if (aim.targetLineEnd && !aim.isIllegalTarget) {
    const baseAlpha = isRemote ? 0.42 : 0.78;
    const grad = ctx.createLinearGradient(
      aim.ghostX,
      aim.ghostY,
      aim.targetLineEnd.x,
      aim.targetLineEnd.y,
    );
    grad.addColorStop(0, `rgba(212, 168, 83, ${baseAlpha})`);
    grad.addColorStop(1, 'rgba(212, 168, 83, 0.08)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(aim.ghostX, aim.ghostY);
    ctx.lineTo(aim.targetLineEnd.x, aim.targetLineEnd.y);
    ctx.stroke();

    if (aim.targetBounceEnd) {
      ctx.strokeStyle = `rgba(212, 168, 83, ${isRemote ? 0.22 : 0.4})`;
      ctx.lineWidth = 1.4;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(aim.targetLineEnd.x, aim.targetLineEnd.y);
      ctx.lineTo(aim.targetBounceEnd.x, aim.targetBounceEnd.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // 4. Cue ball post-impact deflection hint (fades softly)
  if (aim.cueDeflectEnd && !aim.isIllegalTarget) {
    const cGrad = ctx.createLinearGradient(
      aim.ghostX,
      aim.ghostY,
      aim.cueDeflectEnd.x,
      aim.cueDeflectEnd.y,
    );
    cGrad.addColorStop(0, `rgba(186, 230, 253, ${isRemote ? 0.3 : 0.62})`);
    cGrad.addColorStop(1, 'rgba(186, 230, 253, 0.05)');
    ctx.strokeStyle = cGrad;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(aim.ghostX, aim.ghostY);
    ctx.lineTo(aim.cueDeflectEnd.x, aim.cueDeflectEnd.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 5. Rail-only rebound preview when aiming at open cushion
  if (aim.railBounceEnd) {
    ctx.strokeStyle = `rgba(243, 239, 230, ${isRemote ? 0.25 : 0.5})`;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(aim.ghostX, aim.ghostY);
    ctx.lineTo(aim.railBounceEnd.x, aim.railBounceEnd.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();
}

/** Draw wooden billiard cue stick behind cue ball */
function drawCueStick(
  ctx: CanvasRenderingContext2D,
  cueX: number,
  cueY: number,
  angle: number,
  power: number,
  thrust: number,
  isRemote: boolean,
): void {
  ctx.save();
  ctx.globalAlpha = isRemote ? 0.72 : 1;
  ctx.translate(cueX, cueY);
  // Cue stick points opposite to shot direction
  ctx.rotate(angle + Math.PI);

  const pullback = power * 96;
  const tipGap = BALL_RADIUS + 8 + pullback - thrust * (pullback + 10);
  const cueLen = 370;

  // Soft cue shadow on table
  ctx.save();
  ctx.translate(3, 6);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
  ctx.beginPath();
  ctx.moveTo(tipGap, -2.8);
  ctx.lineTo(tipGap + cueLen, -6.2);
  ctx.lineTo(tipGap + cueLen, 6.2);
  ctx.lineTo(tipGap, 2.8);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Blue-chalked leather tip
  ctx.fillStyle = '#2563eb';
  ctx.fillRect(tipGap, -2.5, 4.5, 5);

  // Ivory ferrule
  ctx.fillStyle = '#f5f1e8';
  ctx.fillRect(tipGap + 4.5, -2.6, 8, 5.2);

  // Maple tapered shaft
  const shaftGrad = ctx.createLinearGradient(0, -4, 0, 4);
  shaftGrad.addColorStop(0, '#f3d9a8');
  shaftGrad.addColorStop(0.5, '#dfb778');
  shaftGrad.addColorStop(1, '#b88a4a');
  ctx.fillStyle = shaftGrad;
  ctx.beginPath();
  ctx.moveTo(tipGap + 12.5, -2.6);
  ctx.lineTo(tipGap + 215, -4.5);
  ctx.lineTo(tipGap + 215, 4.5);
  ctx.lineTo(tipGap + 12.5, 2.6);
  ctx.closePath();
  ctx.fill();

  // Brass joint collar
  ctx.fillStyle = '#d4a853';
  ctx.fillRect(tipGap + 215, -4.6, 6, 9.2);

  // Dark walnut / ebony grip butt
  const buttGrad = ctx.createLinearGradient(0, -6, 0, 6);
  buttGrad.addColorStop(0, '#3a241a');
  buttGrad.addColorStop(0.45, '#1d1411');
  buttGrad.addColorStop(1, '#100c0b');
  ctx.fillStyle = buttGrad;
  ctx.beginPath();
  ctx.moveTo(tipGap + 221, -4.6);
  ctx.lineTo(tipGap + cueLen, -6.3);
  ctx.lineTo(tipGap + cueLen, 6.3);
  ctx.lineTo(tipGap + 221, 4.6);
  ctx.closePath();
  ctx.fill();

  // Subtle brass wrap inlay bands on butt
  ctx.fillStyle = '#d4a853';
  ctx.fillRect(tipGap + 265, -5.1, 2.5, 10.2);
  ctx.fillRect(tipGap + 344, -6.0, 4, 12.0);

  // Rubber bumper cap
  ctx.fillStyle = '#0a0b0e';
  ctx.beginPath();
  ctx.arc(tipGap + cueLen, 0, 6.2, -Math.PI / 2, Math.PI / 2);
  ctx.fill();

  ctx.restore();
}

/** Draw Ball-in-Hand placement overlay (green valid / red invalid halo + break kitchen highlight) */
function drawBallInHandOverlay(
  ctx: CanvasRenderingContext2D,
  cue: Ball,
  kitchenOnly: boolean,
  valid: boolean,
  isDragging: boolean,
): void {
  ctx.save();

  if (kitchenOnly) {
    // Highlight legal break zone (behind head string)
    ctx.fillStyle = 'rgba(212, 168, 83, 0.08)';
    ctx.fillRect(FIELD_LEFT, FIELD_TOP, HEAD_STRING_X - FIELD_LEFT, PLAY_H);

    ctx.strokeStyle = 'rgba(212, 168, 83, 0.55)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(HEAD_STRING_X, FIELD_TOP + 2);
    ctx.lineTo(HEAD_STRING_X, FIELD_BOTTOM - 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Placement ring around cue ball
  const haloR = BALL_RADIUS + (isDragging ? 11 : 8);
  const strokeColor = valid ? '#34d399' : '#f87171';
  const fillColor = valid ? 'rgba(52, 211, 153, 0.16)' : 'rgba(248, 113, 113, 0.22)';

  ctx.beginPath();
  ctx.arc(cue.x, cue.y, haloR, 0, Math.PI * 2);
  ctx.fillStyle = fillColor;
  ctx.fill();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 2.2;
  ctx.stroke();

  // Four subtle directional placement ticks
  const tickInner = haloR + 3;
  const tickOuter = haloR + 8;
  ctx.lineWidth = 2;
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    ctx.beginPath();
    ctx.moveTo(cue.x + Math.cos(a) * tickInner, cue.y + Math.sin(a) * tickInner);
    ctx.lineTo(cue.x + Math.cos(a) * tickOuter, cue.y + Math.sin(a) * tickOuter);
    ctx.stroke();
  }

  ctx.restore();
}

export function renderBilliardsScene(ctx: CanvasRenderingContext2D, state: RenderState): void {
  // 1. Static cached table base
  const tableBase = getTableBaseCanvas(state.clothTheme);
  ctx.clearRect(0, 0, TABLE_W, TABLE_H);
  ctx.drawImage(tableBase, 0, 0);

  // 2. Ball-in-Hand overlay (underneath balls for kitchen shading, halo drawn right after cue ball)
  const cueBall = state.balls.find((b) => b.id === 0);

  if (state.isBallInHand && state.kitchenOnly) {
    ctx.save();
    ctx.fillStyle = 'rgba(212, 168, 83, 0.06)';
    ctx.fillRect(FIELD_LEFT, FIELD_TOP, HEAD_STRING_X - FIELD_LEFT, PLAY_H);
    ctx.restore();
  }

  // 3. Aiming guide & Ghost Ball (under active balls for clean layering)
  if (state.showCue && state.aimPreview) {
    drawAimPreview(ctx, state.aimPreview, state.isRemoteTurn);
  }

  // 4. All balls (pocketed-animating balls first, then active balls)
  for (const b of state.balls) {
    if (b.pocketed && b.pocketAnim < 1) {
      drawPoolBall(ctx, b);
    }
  }
  for (const b of state.balls) {
    if (!b.pocketed) {
      drawPoolBall(ctx, b);
    }
  }

  // 5. Ball-in-Hand halo on top of cue ball so red/green cue is crystal clear
  if (state.isBallInHand && cueBall && !cueBall.pocketed) {
    drawBallInHandOverlay(
      ctx,
      cueBall,
      state.kitchenOnly,
      state.cueDragValid,
      state.isDraggingCue,
    );
  }

  // 6. Chalk dust particles
  for (const p of state.particles) {
    const t = Math.max(0, 1 - p.life / p.maxLife);
    ctx.save();
    ctx.globalAlpha = t * 0.65;
    ctx.fillStyle = '#93c5fd';
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * (0.5 + t * 0.5), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 7. Cue stick
  if (state.showCue && cueBall && !cueBall.pocketed) {
    drawCueStick(
      ctx,
      cueBall.x,
      cueBall.y,
      state.cueAngle,
      state.cuePower,
      state.cueStrikeThrust,
      state.isRemoteTurn,
    );
  }
}
