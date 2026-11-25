import React from 'react';
import { Clock } from 'lucide-react';
import type {
  Ball,
  ChatBubble,
  GameMode,
  GameNotice,
  PlayerIndex,
  PlayerInfo,
  TurnPhase,
} from '../game/types';
import { MiniBallIcon } from './MiniBallIcon';

interface ScoreboardProps {
  players: [PlayerInfo, PlayerInfo];
  currentPlayer: PlayerIndex;
  balls: Ball[];
  phase: TurnPhase;
  mode: GameMode;
  practiceMode: boolean;
  shotClockSeconds: number;
  timeLeft: number;
  notice: GameNotice | null;
  chatBubbles: Partial<Record<PlayerIndex, ChatBubble>>;
  localPlayerIndex: PlayerIndex | null;
  rackNumber?: number;
  matchScore?: [number, number];
}

const SOLID_IDS = [1, 2, 3, 4, 5, 6, 7];
const STRIPE_IDS = [9, 10, 11, 12, 13, 14, 15];

function PlayerPanel({
  player,
  index,
  isActive,
  balls,
  align,
  practiceMode,
  isLocalYou,
  bubble,
}: {
  player: PlayerInfo;
  index: PlayerIndex;
  isActive: boolean;
  balls: Ball[];
  align: 'left' | 'right';
  practiceMode: boolean;
  isLocalYou: boolean;
  bubble?: ChatBubble;
}) {
  const pocketedSet = new Set(balls.filter((b) => b.pocketed).map((b) => b.id));
  const groupIds =
    player.group === 'solids' ? SOLID_IDS : player.group === 'stripes' ? STRIPE_IDS : null;

  const remainingOwn = groupIds ? groupIds.filter((id) => !pocketedSet.has(id)).length : null;
  const isOnEight = groupIds !== null && remainingOwn === 0;

  const groupText = practiceMode
    ? '自由练习'
    : player.group === null
      ? '未分花色'
      : isOnEight
        ? '目标：黑 8'
        : player.group === 'solids'
          ? `全色球 · 余 ${remainingOwn}`
          : `花色球 · 余 ${remainingOwn}`;

  return (
    <div
      className={`relative flex-1 min-w-0 rounded-xl px-3.5 py-2.5 border transition-colors duration-200 ${
        isActive
          ? 'bg-[#191d25] border-[#d4a853]/70 shadow-[0_0_0_1px_rgba(212,168,83,0.18)]'
          : 'bg-[#14171d] border-white/8'
      }`}
    >
      {/* Floating emote/chat bubble for Online mode */}
      {bubble && (
        <div
          className={`absolute -bottom-9 z-20 px-3 py-1.5 rounded-lg bg-[#232834] border border-[#d4a853]/40 text-xs font-medium text-[#f3efe6] shadow-lg whitespace-nowrap max-w-[220px] truncate ${
            align === 'left' ? 'left-3' : 'right-3'
          }`}
        >
          {bubble.text}
        </div>
      )}

      <div
        className={`flex items-center justify-between gap-2 ${
          align === 'right' ? 'flex-row-reverse' : 'flex-row'
        }`}
      >
        <div
          className={`flex items-baseline gap-2 min-w-0 ${
            align === 'right' ? 'flex-row-reverse text-right' : 'text-left'
          }`}
        >
          <span className="text-sm font-semibold text-[#f3efe6] truncate">
            {player.name}
            {isLocalYou ? '（我）' : ''}
          </span>
          <span className="text-xs text-[#9ea6b4] whitespace-nowrap shrink-0">
            {groupText}
          </span>
        </div>

        <span
          className={`text-xs font-semibold whitespace-nowrap shrink-0 ${
            isActive ? 'text-[#d4a853]' : 'text-[#626b7c]'
          }`}
        >
          {isActive ? '当前击球' : index === 0 ? 'P1' : 'P2'}
        </span>
      </div>

      {/* Remaining Target Balls Strip */}
      <div
        className={`mt-2 flex items-center gap-1 min-h-[22px] ${
          align === 'right' ? 'justify-end' : 'justify-start'
        }`}
      >
        {practiceMode ? (
          <span className="text-xs text-[#8d96a6] tabular-nums">
            已进 {player.stats.potted} 球 · 连进 {player.stats.currentStreak}
          </span>
        ) : groupIds ? (
          <>
            {groupIds.map((id) => (
              <MiniBallIcon key={id} ballId={id} pocketed={pocketedSet.has(id)} size={21} />
            ))}
            <span className="mx-0.5 text-[#495162]" aria-hidden="true">
              /
            </span>
            <MiniBallIcon
              ballId={8}
              pocketed={pocketedSet.has(8)}
              highlight={isOnEight}
              size={22}
            />
          </>
        ) : (
          <span className="text-xs text-[#7c8596]">
            开球后首个合法进球决定全色或花色归属
          </span>
        )}
      </div>
    </div>
  );
}

export const Scoreboard: React.FC<ScoreboardProps> = ({
  players,
  currentPlayer,
  balls,
  phase,
  mode,
  practiceMode,
  shotClockSeconds,
  timeLeft,
  notice,
  chatBubbles,
  localPlayerIndex,
  rackNumber = 1,
  matchScore = [0, 0],
}) => {
  const showClock = shotClockSeconds > 0 && !practiceMode && phase !== 'GAME_OVER';
  const isUrgent = showClock && timeLeft <= 5;
  const clockPct = shotClockSeconds > 0 ? Math.max(0, Math.min(100, (timeLeft / shotClockSeconds) * 100)) : 100;

  return (
    <div className="w-full space-y-2">
      <div className="flex flex-col sm:flex-row items-stretch gap-2.5">
        <PlayerPanel
          player={players[0]}
          index={0}
          isActive={currentPlayer === 0 && phase !== 'GAME_OVER'}
          balls={balls}
          align="left"
          practiceMode={practiceMode}
          isLocalYou={mode === 'online' && localPlayerIndex === 0}
          bubble={chatBubbles[0]}
        />

        {/* Center Cumulative Series Score / Shot Clock Divider */}
        <div className="flex sm:flex-col items-center justify-between sm:justify-center px-3.5 py-2 rounded-xl bg-[#14171d] border border-white/8 sm:w-40 shrink-0 gap-1.5 sm:gap-1">
          {!practiceMode && (
            <div className="flex items-center justify-center gap-2 leading-none">
              <span
                className={`font-mono-num text-lg sm:text-xl font-extrabold tabular-nums ${
                  matchScore[0] > matchScore[1] ? 'text-[#d4a853]' : 'text-[#f3efe6]'
                }`}
              >
                {matchScore[0]}
              </span>
              <span className="text-xs font-bold text-[#626b7c]" aria-hidden="true">
                :
              </span>
              <span
                className={`font-mono-num text-lg sm:text-xl font-extrabold tabular-nums ${
                  matchScore[1] > matchScore[0] ? 'text-[#d4a853]' : 'text-[#f3efe6]'
                }`}
              >
                {matchScore[1]}
              </span>
            </div>
          )}

          {showClock ? (
            <div className="flex sm:flex-col items-center gap-2 sm:gap-1 sm:w-full">
              <div className="flex items-center gap-1">
                <Clock
                  className={`w-3 h-3 ${isUrgent ? 'text-[#f87171]' : 'text-[#d4a853]'}`}
                />
                <span
                  className={`font-mono-num text-xs font-bold ${
                    isUrgent ? 'text-[#f87171]' : 'text-[#f3efe6]'
                  }`}
                >
                  {Math.ceil(timeLeft)}s
                </span>
                <span className="text-[10px] text-[#8d96a6] font-mono-num whitespace-nowrap">
                  · 第{rackNumber}局
                </span>
              </div>
              <div className="w-20 sm:w-full h-1.5 rounded-full bg-white/8 overflow-hidden">
                <div
                  className={`h-full transition-[width] duration-150 ${
                    isUrgent ? 'bg-[#ef4444]' : 'bg-[#d4a853]'
                  }`}
                  style={{ width: `${clockPct}%` }}
                />
              </div>
            </div>
          ) : (
            <div className="text-right sm:text-center sm:w-full">
              <div className="text-[11px] text-[#8d96a6] whitespace-nowrap font-mono-num">
                {practiceMode ? '中式八球 · 练球' : `第 ${rackNumber} 局 · 总比分`}
              </div>
              <div className="text-[11px] font-semibold text-[#d8dde6] mt-0.5 whitespace-nowrap">
                {phase === 'BALL_IN_HAND'
                  ? '自由球摆位'
                  : phase === 'SHOOTING'
                    ? '走球中'
                    : phase === 'AI_THINKING'
                      ? '电脑瞄准中'
                      : phase === 'GAME_OVER'
                        ? '本局结束'
                        : '瞄准击球'}
              </div>
            </div>
          )}
        </div>

        {!practiceMode && (
          <PlayerPanel
            player={players[1]}
            index={1}
            isActive={currentPlayer === 1 && phase !== 'GAME_OVER'}
            balls={balls}
            align="right"
            practiceMode={false}
            isLocalYou={mode === 'online' && localPlayerIndex === 1}
            bubble={chatBubbles[1]}
          />
        )}
      </div>

      {/* Single-line clean event notice banner */}
      {notice && (
        <div
          className={`flex items-center justify-center gap-2 px-4 py-1.5 rounded-lg text-xs border transition-colors ${
            notice.tone === 'foul'
              ? 'bg-[#2a171a] border-[#ef4444]/35 text-[#fecaca]'
              : notice.tone === 'success'
                ? 'bg-[#12261e] border-[#10b981]/35 text-[#a7f3d0]'
                : 'bg-[#161a22] border-white/10 text-[#d8dde6]'
          }`}
        >
          <span className="font-semibold">{notice.title}</span>
          {notice.detail && (
            <>
              <span className="opacity-40" aria-hidden="true">
                ·
              </span>
              <span className="opacity-90">{notice.detail}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
};
