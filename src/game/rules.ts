import { CENTER_Y, FOOT_SPOT_X, HEAD_STRING_X } from './constants';
import { findSafeBallSpot, identityMat3 } from './physics';
import type {
  Ball,
  BallGroup,
  GameNotice,
  PlayerIndex,
  PlayerInfo,
  ShotRecord,
  TurnPhase,
} from './types';

export function getBallGroup(ballId: number): BallGroup {
  if (ballId >= 1 && ballId <= 7) return 'solids';
  if (ballId >= 9 && ballId <= 15) return 'stripes';
  return null;
}

export function getRemainingBallsForGroup(balls: Ball[], group: BallGroup): Ball[] {
  if (!group) return [];
  return balls.filter((b) => !b.pocketed && getBallGroup(b.id) === group);
}

/** Return the set of object ball IDs that are legal to hit first on the current turn */
export function getLegalTargetBallIds(
  balls: Ball[],
  playerGroup: BallGroup,
  isBreak: boolean,
  practiceMode: boolean,
): Set<number> {
  const activeObjects = balls.filter((b) => b.id !== 0 && !b.pocketed);
  if (practiceMode || isBreak) {
    return new Set(activeObjects.map((b) => b.id));
  }

  if (playerGroup === null) {
    // Open table: any solid or stripe (not 8-ball unless somehow only 8 remains)
    const nonEight = activeObjects.filter((b) => b.id !== 8);
    if (nonEight.length > 0) {
      return new Set(nonEight.map((b) => b.id));
    }
    return new Set(activeObjects.map((b) => b.id));
  }

  const remainingOwn = activeObjects.filter((b) => getBallGroup(b.id) === playerGroup);
  if (remainingOwn.length > 0) {
    return new Set(remainingOwn.map((b) => b.id));
  }
  // Own group cleared -> target is 8-ball
  return new Set([8]);
}

export interface TurnEvaluationInput {
  balls: Ball[];
  currentPlayer: PlayerIndex;
  players: [PlayerInfo, PlayerInfo];
  isBreak: boolean;
  practiceMode: boolean;
  shotRecord: ShotRecord;
  noticeCounter: number;
}

export interface TurnEvaluationResult {
  nextPlayer: PlayerIndex;
  nextPhase: TurnPhase;
  nextIsBreak: boolean;
  kitchenOnly: boolean;
  players: [PlayerInfo, PlayerInfo];
  winner: PlayerIndex | null;
  winReason: string;
  notice: GameNotice;
  reRackNeeded?: boolean;
}

function clonePlayers(players: [PlayerInfo, PlayerInfo]): [PlayerInfo, PlayerInfo] {
  return [
    { ...players[0], stats: { ...players[0].stats } },
    { ...players[1], stats: { ...players[1].stats } },
  ];
}

function respawnBall(balls: Ball[], ballId: number, prefX: number, prefY: number, kitchenOnly = false): void {
  const ball = balls.find((b) => b.id === ballId);
  if (!ball) return;
  const spot = findSafeBallSpot(balls, prefX, prefY, ballId, kitchenOnly);
  ball.x = spot.x;
  ball.y = spot.y;
  ball.vx = 0;
  ball.vy = 0;
  ball.spinX = 0;
  ball.spinY = 0;
  ball.hasPostHitSpin = false;
  ball.pocketed = false;
  ball.pocketAnim = 0;
  ball.rot = identityMat3();
}

export function evaluateShotResult(input: TurnEvaluationInput): TurnEvaluationResult {
  const {
    balls,
    currentPlayer,
    isBreak,
    practiceMode,
    shotRecord,
    noticeCounter,
  } = input;

  const opponent: PlayerIndex = currentPlayer === 0 ? 1 : 0;
  const players = clonePlayers(input.players);
  const active = players[currentPlayer];
  const other = players[opponent];

  active.stats.shots += 1;

  const pocketedObjects = shotRecord.pocketedIds.filter((id) => id !== 0);
  const pocketedEight = pocketedObjects.includes(8);
  const pocketedSolids = pocketedObjects.filter((id) => id >= 1 && id <= 7);
  const pocketedStripes = pocketedObjects.filter((id) => id >= 9 && id <= 15);
  const anyObjectPocketed = pocketedObjects.length > 0;

  // --- FREE PRACTICE MODE ---
  if (practiceMode) {
    if (shotRecord.cueScratched) {
      respawnBall(balls, 0, HEAD_STRING_X - 24, CENTER_Y, false);
    }
    if (anyObjectPocketed) {
      active.stats.potted += pocketedObjects.length;
      active.stats.currentStreak += pocketedObjects.length;
      active.stats.maxStreak = Math.max(active.stats.maxStreak, active.stats.currentStreak);
    } else {
      active.stats.currentStreak = 0;
    }

    const remainingObjects = balls.filter((b) => b.id !== 0 && !b.pocketed);
    if (remainingObjects.length === 0) {
      return {
        nextPlayer: currentPlayer,
        nextPhase: 'AIMING',
        nextIsBreak: false,
        kitchenOnly: false,
        players,
        winner: null,
        winReason: '',
        reRackNeeded: true,
        notice: {
          id: noticeCounter + 1,
          title: '全清台！已为您重新摆球',
          detail: '自由练习模式',
          tone: 'success',
        },
      };
    }

    return {
      nextPlayer: currentPlayer,
      nextPhase: shotRecord.cueScratched ? 'BALL_IN_HAND' : 'AIMING',
      nextIsBreak: false,
      kitchenOnly: false,
      players,
      winner: null,
      winReason: '',
      notice: shotRecord.cueScratched
        ? {
            id: noticeCounter + 1,
            title: '白球落袋 · 请重新摆放白球',
            detail: '自由练习模式不判犯规',
            tone: 'info',
          }
        : anyObjectPocketed
          ? {
              id: noticeCounter + 1,
              title: `进球 +${pocketedObjects.length}`,
              detail: `当前连进 ${active.stats.currentStreak} 球`,
              tone: 'success',
            }
          : {
              id: noticeCounter + 1,
              title: '继续练习',
              detail: '可随时点击“移动白球”摆位',
              tone: 'info',
            },
    };
  }

  // --- STANDARD AMERICAN 8-BALL RULES ---

  // Determine what balls were legal BEFORE this shot finished
  const remainingOwnBefore =
    active.group === null
      ? []
      : balls.filter((b) => {
          if (b.id === 0 || b.id === 8) return false;
          if (getBallGroup(b.id) !== active.group) return false;
          // If pocketed during THIS shot, it was still on the table before the shot!
          return !b.pocketed || pocketedObjects.includes(b.id);
        });

  const wasShootingForEight = active.group !== null && remainingOwnBefore.length === 0;

  // 1. Check fouls
  let foulReason: string | null = null;

  if (shotRecord.cueScratched) {
    foulReason = '白球落袋（洗袋）';
  } else if (shotRecord.firstHitBallId === null) {
    foulReason = '空杆未碰到任何目标球';
  } else if (isBreak) {
    // Break shot requirement: pocket a ball or drive at least 4 object balls to rails
    if (!anyObjectPocketed && shotRecord.breakRailBallIds.size < 4) {
      foulReason = '开球未进球且碰库不足 4 球';
    }
  } else {
    // Regular shot first-hit legality check
    if (active.group === null) {
      // Open table: cannot hit 8-ball first
      if (shotRecord.firstHitBallId === 8) {
        foulReason = '未分花色时不能先碰黑 8';
      }
    } else if (wasShootingForEight) {
      if (shotRecord.firstHitBallId !== 8) {
        foulReason = '清台后必须先碰黑 8';
      }
    } else {
      const hitGroup = getBallGroup(shotRecord.firstHitBallId);
      if (hitGroup !== active.group) {
        foulReason =
          shotRecord.firstHitBallId === 8
            ? '己方球未清完，不能先碰黑 8'
            : '未先碰到己方花色目标球';
      }
    }

    // Rail contact requirement after first hit
    if (!foulReason && !anyObjectPocketed && !shotRecord.railHitAfterContact) {
      foulReason = '撞击后未进球且无球碰库';
    }
  }

  // 2. Special handling when 8-ball is pocketed (中式八球规则)
  if (pocketedEight) {
    if (isBreak) {
      if (foulReason) {
        // 中式八球规则：开球黑 8 进袋同时犯规（如白球洗袋）直接判负
        active.stats.fouls += 1;
        active.stats.currentStreak = 0;
        return {
          nextPlayer: opponent,
          nextPhase: 'GAME_OVER',
          nextIsBreak: false,
          kitchenOnly: false,
          players,
          winner: opponent,
          winReason: `${active.name} 开球击落黑 8 同时犯规（${foulReason}），按中八规则直接判负`,
          notice: {
            id: noticeCounter + 1,
            title: '开球进黑 8 且犯规 · 判负',
            detail: `${other.name} 赢得本局胜利`,
            tone: 'foul',
          },
        };
      }
      // Clean break with 8-ball -> re-spot 8-ball on foot spot, breaker continues on open table
      respawnBall(balls, 8, FOOT_SPOT_X, CENTER_Y, false);
      const nonEightCount = pocketedObjects.filter((id) => id !== 8).length;
      active.stats.potted += nonEightCount;
      active.stats.currentStreak += nonEightCount;
      active.stats.maxStreak = Math.max(active.stats.maxStreak, active.stats.currentStreak);
      return {
        nextPlayer: currentPlayer,
        nextPhase: 'AIMING',
        nextIsBreak: false,
        kitchenOnly: false,
        players,
        winner: null,
        winReason: '',
        notice: {
          id: noticeCounter + 1,
          title: '开球进黑 8 · 已复位至置球点',
          detail: `${active.name} 继续击球（桌面未分花色）`,
          tone: 'info',
        },
      };
    }

    // Regular play 8-ball pocketed -> Match ends immediately!
    if (!wasShootingForEight) {
      active.stats.fouls += 1;
      active.stats.currentStreak = 0;
      return {
        nextPlayer: opponent,
        nextPhase: 'GAME_OVER',
        nextIsBreak: false,
        kitchenOnly: false,
        players,
        winner: opponent,
        winReason: `${active.name} 提前误打黑 8 进袋，直接判负`,
        notice: {
          id: noticeCounter + 1,
          title: '误打黑 8 进袋 · 判负',
          detail: `${other.name} 赢得本局胜利`,
          tone: 'foul',
        },
      };
    }

    if (foulReason) {
      active.stats.fouls += 1;
      active.stats.currentStreak = 0;
      return {
        nextPlayer: opponent,
        nextPhase: 'GAME_OVER',
        nextIsBreak: false,
        kitchenOnly: false,
        players,
        winner: opponent,
        winReason: `${active.name} 击落黑 8 时犯规（${foulReason}），直接判负`,
        notice: {
          id: noticeCounter + 1,
          title: '打黑 8 犯规 · 判负',
          detail: `${foulReason}，${other.name} 赢得本局`,
          tone: 'foul',
        },
      };
    }

    // Clean legal 8-ball pot -> Current player WINS!
    active.stats.potted += 1;
    active.stats.currentStreak += 1;
    active.stats.maxStreak = Math.max(active.stats.maxStreak, active.stats.currentStreak);
    return {
      nextPlayer: currentPlayer,
      nextPhase: 'GAME_OVER',
      nextIsBreak: false,
      kitchenOnly: false,
      players,
      winner: currentPlayer,
      winReason: `${active.name} 清台后合法击落黑 8，精彩获胜！`,
      notice: {
        id: noticeCounter + 1,
        title: `${active.name} 获胜！`,
        detail: '合法击落黑 8',
        tone: 'success',
      },
    };
  }

  // 3. Handle standard fouls (non-8-ball)
  if (foulReason) {
    active.stats.fouls += 1;
    active.stats.currentStreak = 0;

    if (shotRecord.cueScratched) {
      respawnBall(balls, 0, HEAD_STRING_X - 24, CENTER_Y, false);
    }

    return {
      nextPlayer: opponent,
      nextPhase: 'BALL_IN_HAND',
      nextIsBreak: false,
      kitchenOnly: false,
      players,
      winner: null,
      winReason: '',
      notice: {
        id: noticeCounter + 1,
        title: `犯规：${foulReason}`,
        detail: `${other.name} 获得自由球（Ball-in-Hand）`,
        tone: 'foul',
      },
    };
  }

  // 4. Clean break (no foul) -> table remains open; continue if any ball pocketed
  if (isBreak) {
    if (anyObjectPocketed) {
      active.stats.potted += pocketedObjects.length;
      active.stats.currentStreak += pocketedObjects.length;
      active.stats.maxStreak = Math.max(active.stats.maxStreak, active.stats.currentStreak);
      return {
        nextPlayer: currentPlayer,
        nextPhase: 'AIMING',
        nextIsBreak: false,
        kitchenOnly: false,
        players,
        winner: null,
        winReason: '',
        notice: {
          id: noticeCounter + 1,
          title: `开球进球 +${pocketedObjects.length}`,
          detail: `${active.name} 继续击球 · 桌面仍未分花色`,
          tone: 'success',
        },
      };
    }

    active.stats.currentStreak = 0;
    return {
      nextPlayer: opponent,
      nextPhase: 'AIMING',
      nextIsBreak: false,
      kitchenOnly: false,
      players,
      winner: null,
      winReason: '',
      notice: {
        id: noticeCounter + 1,
        title: '开球未进球',
        detail: `轮到 ${other.name} 击球 · 桌面未分花色`,
        tone: 'info',
      },
    };
  }

  // 5. Open table after break -> First legally pocketed ball assigns Solids vs Stripes
  if (active.group === null) {
    if (pocketedSolids.length > 0 || pocketedStripes.length > 0) {
      let assigned: BallGroup;
      if (pocketedSolids.length > 0 && pocketedStripes.length === 0) {
        assigned = 'solids';
      } else if (pocketedStripes.length > 0 && pocketedSolids.length === 0) {
        assigned = 'stripes';
      } else {
        // Both fell: assign the group of the first ball contacted (or first pocketed)
        assigned = getBallGroup(shotRecord.firstHitBallId ?? pocketedObjects[0]) ?? 'solids';
      }

      active.group = assigned;
      other.group = assigned === 'solids' ? 'stripes' : 'solids';

      const ownCount = assigned === 'solids' ? pocketedSolids.length : pocketedStripes.length;
      active.stats.potted += ownCount;
      active.stats.currentStreak += ownCount;
      active.stats.maxStreak = Math.max(active.stats.maxStreak, active.stats.currentStreak);

      const groupLabel = assigned === 'solids' ? '全色球 (1-7)' : '花色球 (9-15)';
      return {
        nextPlayer: currentPlayer,
        nextPhase: 'AIMING',
        nextIsBreak: false,
        kitchenOnly: false,
        players,
        winner: null,
        winReason: '',
        notice: {
          id: noticeCounter + 1,
          title: `花色确定：${active.name} 归属${groupLabel}`,
          detail: `${active.name} 继续击球`,
          tone: 'success',
        },
      };
    }

    // Open table dry shot -> switch turns
    active.stats.currentStreak = 0;
    return {
      nextPlayer: opponent,
      nextPhase: 'AIMING',
      nextIsBreak: false,
      kitchenOnly: false,
      players,
      winner: null,
      winReason: '',
      notice: {
        id: noticeCounter + 1,
        title: `轮到 ${other.name} 击球`,
        detail: '桌面仍未分花色，击进任意球即可选定花色',
        tone: 'info',
      },
    };
  }

  // 6. Groups already assigned -> continue if at least one of active player's own group fell
  const ownPocketed = active.group === 'solids' ? pocketedSolids : pocketedStripes;
  if (ownPocketed.length > 0) {
    active.stats.potted += ownPocketed.length;
    active.stats.currentStreak += ownPocketed.length;
    active.stats.maxStreak = Math.max(active.stats.maxStreak, active.stats.currentStreak);

    const stillRemaining = getRemainingBallsForGroup(balls, active.group).length;
    return {
      nextPlayer: currentPlayer,
      nextPhase: 'AIMING',
      nextIsBreak: false,
      kitchenOnly: false,
      players,
      winner: null,
      winReason: '',
      notice: {
        id: noticeCounter + 1,
        title: stillRemaining === 0 ? `${active.name} 已清完花色！` : `${active.name} 进球 +${ownPocketed.length}`,
        detail:
          stillRemaining === 0
            ? '下一杆请合法击落黑 8 制胜'
            : `连进 ${active.stats.currentStreak} 球，继续击球`,
        tone: 'success',
      },
    };
  }

  // No own balls pocketed -> pass turn
  active.stats.currentStreak = 0;
  return {
    nextPlayer: opponent,
    nextPhase: 'AIMING',
    nextIsBreak: false,
    kitchenOnly: false,
    players,
    winner: null,
    winReason: '',
    notice: {
      id: noticeCounter + 1,
      title: `轮到 ${other.name} 击球`,
      detail:
        other.group === null
          ? '桌面未分花色'
          : getRemainingBallsForGroup(balls, other.group).length === 0
            ? '目标球：黑 8'
            : other.group === 'solids'
              ? '目标球：全色球 (1-7)'
              : '目标球：花色球 (9-15)',
      tone: 'info',
    },
  };
}
