import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Check,
  Copy,
  Flame,
  Hand,
  LogOut,
  RefreshCw,
  RotateCcw,
  Settings,
  Users,
  Volume2,
  VolumeX,
  Wifi,
} from 'lucide-react';
import { EmoteBar } from './components/EmoteBar';
import {
  GameOverModal,
  LobbyModal,
  type LobbyStartPayload,
  OnlineRoomModal,
  RulesModal,
  SettingsModal,
} from './components/Modals';
import { PoolCanvas } from './components/PoolCanvas';
import { PowerSlider } from './components/PowerSlider';
import { Scoreboard } from './components/Scoreboard';
import { SpinControl } from './components/SpinControl';
import { computeAIBallInHandSpot, computeAIShot } from './game/ai';
import { soundEngine } from './game/audio';
import { BALL_RADIUS } from './game/constants';
import {
  buildShareLink,
  clearRoomCodeFromUrl,
  getRoomCodeFromUrl,
  PeerRoomManager,
} from './game/peer';
import {
  areAllBallsStopped,
  computeAimPreview,
  createEmptyShotRecord,
  createInitialRack,
  deserializeBalls,
  isValidCueBallPosition,
  serializeBalls,
  stepPhysics,
  strikeCueBall,
} from './game/physics';
import type { ChalkParticle } from './game/renderer';
import { evaluateShotResult, getLegalTargetBallIds } from './game/rules';
import { RemoteSyncBuffer } from './game/syncBuffer';
import type {
  AIDifficulty,
  AimPreview,
  AuthoritativeStatePayload,
  Ball,
  ChatBubble,
  CompactBallTick,
  GameMode,
  GameNotice,
  GameSettings,
  PeerConnectionStatus,
  PeerMessage,
  PlayerIndex,
  PlayerInfo,
  ShotRecord,
  TurnPhase,
} from './game/types';

function createFreshPlayers(p1Name: string, p2Name: string): [PlayerInfo, PlayerInfo] {
  return [
    {
      name: p1Name,
      group: null,
      stats: { shots: 0, potted: 0, currentStreak: 0, maxStreak: 0, fouls: 0 },
    },
    {
      name: p2Name,
      group: null,
      stats: { shots: 0, potted: 0, currentStreak: 0, maxStreak: 0, fouls: 0 },
    },
  ];
}

function defaultAimAngleForRack(balls: Ball[]): number {
  const cue = balls.find((b) => b.id === 0);
  const apex = balls.find((b) => b.id === 1 && !b.pocketed);
  if (cue && apex) {
    return Math.atan2(apex.y - cue.y, apex.x - cue.x);
  }
  return 0;
}

export default function App() {
  // --- Core Game State ---
  const [mode, setMode] = useState<GameMode>('local');
  const [aiDifficulty, setAiDifficulty] = useState<AIDifficulty>('pro');
  const [players, setPlayers] = useState<[PlayerInfo, PlayerInfo]>(() =>
    createFreshPlayers('玩家一', '玩家二'),
  );
  const [currentPlayer, setCurrentPlayer] = useState<PlayerIndex>(0);
  const [lastBreaker, setLastBreaker] = useState<PlayerIndex>(0);
  const [rackNumber, setRackNumber] = useState<number>(1);
  const [matchScore, setMatchScore] = useState<[number, number]>([0, 0]);
  const [phase, setPhase] = useState<TurnPhase>('AIMING');
  const [isBreak, setIsBreak] = useState<boolean>(true);
  const [kitchenOnly, setKitchenOnly] = useState<boolean>(true);
  const [winner, setWinner] = useState<PlayerIndex | null>(null);
  const [winReason, setWinReason] = useState<string>('');
  const [notice, setNotice] = useState<GameNotice | null>({
    id: 1,
    title: '中式八球 · 第 1 局开球',
    detail: '拖动台面瞄准，下拉右侧力度杆击球（可在左侧 D 区微调开球白球）',
    tone: 'info',
  });

  // UI mirror of balls (synced on turn boundaries and pocket events for Scoreboard icons)
  const [ballsSnapshot, setBallsSnapshot] = useState<Ball[]>(() => createInitialRack());

  // Settings
  const [settings, setSettings] = useState<GameSettings>({
    clothTheme: 'green',
    beginnerMode: false,
    practiceMode: false,
    shotClockSeconds: 0,
    muted: false,
  });

  // Shot controls
  const [powerUI, setPowerUI] = useState<number>(0);
  const [spinX, setSpinX] = useState<number>(0);
  const [spinY, setSpinY] = useState<number>(0);
  const [timeLeft, setTimeLeft] = useState<number>(0);
  const [cueDragValidUI, setCueDragValidUI] = useState<boolean>(true);

  // Modals
  const [showLobby, setShowLobby] = useState<boolean>(false);
  const [showOnlineModal, setShowOnlineModal] = useState<boolean>(false);
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [showRules, setShowRules] = useState<boolean>(false);

  // Online PeerJS state
  const [onlineNickname, setOnlineNickname] = useState<string>('球手');
  const [initialUrlRoomCode, setInitialUrlRoomCode] = useState<string>('');
  const [roomCode, setRoomCode] = useState<string>('');
  const [peerStatus, setPeerStatus] = useState<PeerConnectionStatus>('idle');
  const [peerStatusDetail, setPeerStatusDetail] = useState<string>('');
  const [peerError, setPeerError] = useState<string>('');
  const [localPlayerIndex, setLocalPlayerIndex] = useState<PlayerIndex | null>(null);
  const [copiedRoomTop, setCopiedRoomTop] = useState<boolean>(false);
  const [chatBubbles, setChatBubbles] = useState<Partial<Record<PlayerIndex, ChatBubble>>>({});
  const [rematchPending, setRematchPending] = useState<boolean>(false);
  const [opponentRequestedRematch, setOpponentRequestedRematch] = useState<boolean>(false);

  // --- High-frequency Mutable Refs for 60fps Canvas & Physics ---
  const ballsRef = useRef<Ball[]>(ballsSnapshot);
  const particlesRef = useRef<ChalkParticle[]>([]);
  const cueAngleRef = useRef<number>(defaultAimAngleForRack(ballsSnapshot));
  const cuePowerRef = useRef<number>(0);
  const cueStrikeThrustRef = useRef<number>(0);
  const spinRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const aimPreviewRef = useRef<AimPreview | null>(null);
  const cueDragValidRef = useRef<boolean>(true);
  const isDraggingCueRef = useRef<boolean>(false);

  const shotRecordRef = useRef<ShotRecord>(createEmptyShotRecord());
  const pendingShotRef = useRef<{
    angle: number;
    power: number;
    spinX: number;
    spinY: number;
    isLocalAuthority: boolean;
    shotSeq: number;
  } | null>(null);
  const noticeCounterRef = useRef<number>(2);
  const [refreshingUI, setRefreshingUI] = useState<boolean>(false);
  const lastAimSendTimeRef = useRef<number>(0);
  const lastDragSendTimeRef = useRef<number>(0);
  const lastBallTickSendTimeRef = useRef<number>(0);
  const lastSyncRequestSendTimeRef = useRef<number>(0);
  const localShotStartTimeRef = useRef<number>(0);
  const shotMovedBallIdsRef = useRef<Set<number>>(new Set());
  const shotSeqRef = useRef<number>(0);
  const activeRemoteShotSeqRef = useRef<number>(0);
  const remoteAimTargetRef = useRef<{ angle: number; power: number } | null>(null);
  const remoteSyncBufferRef = useRef<RemoteSyncBuffer>(new RemoteSyncBuffer());
  const remoteSyncWaitStartRef = useRef<number | null>(null);

  // Live state mirror ref for RAF/callbacks without stale closures
  const stateRef = useRef({
    mode,
    aiDifficulty,
    players,
    currentPlayer,
    lastBreaker,
    rackNumber,
    matchScore,
    phase,
    isBreak,
    kitchenOnly,
    settings,
    localPlayerIndex,
    onlineNickname,
  });
  stateRef.current = {
    mode,
    aiDifficulty,
    players,
    currentPlayer,
    lastBreaker,
    rackNumber,
    matchScore,
    phase,
    isBreak,
    kitchenOnly,
    settings,
    localPlayerIndex,
    onlineNickname,
  };

  const peerManagerRef = useRef<PeerRoomManager | null>(null);
  const aiTimersRef = useRef<number[]>([]);
  const aiAnimRafRef = useRef<number | null>(null);

  // Determine whether local user can interact right now
  const isLocalTurn = useMemo(() => {
    if (phase === 'GAME_OVER' || phase === 'SHOOTING' || phase === 'ANIMATING_CUE') return false;
    if (mode === 'ai' && currentPlayer === 1) return false;
    if (mode === 'online') {
      if (peerStatus !== 'connected') return false;
      return localPlayerIndex === currentPlayer;
    }
    return true;
  }, [currentPlayer, localPlayerIndex, mode, peerStatus, phase]);

  const isRemoteTurn = useMemo(() => {
    if (mode === 'online' && peerStatus === 'connected') {
      return localPlayerIndex !== currentPlayer;
    }
    if (mode === 'ai' && currentPlayer === 1) {
      return true;
    }
    return false;
  }, [currentPlayer, localPlayerIndex, mode, peerStatus]);

  const clearAIActivities = useCallback(() => {
    for (const id of aiTimersRef.current) {
      window.clearTimeout(id);
    }
    aiTimersRef.current = [];
    if (aiAnimRafRef.current !== null) {
      cancelAnimationFrame(aiAnimRafRef.current);
      aiAnimRafRef.current = null;
    }
  }, []);

  /** Recompute Ghost Ball and trajectory preview lines */
  const refreshAimPreview = useCallback(() => {
    const st = stateRef.current;
    const activeGroup = st.players[st.currentPlayer].group;
    const legalIds = getLegalTargetBallIds(
      ballsRef.current,
      activeGroup,
      st.isBreak,
      st.settings.practiceMode,
    );
    aimPreviewRef.current = computeAimPreview(
      ballsRef.current,
      cueAngleRef.current,
      spinRef.current.x,
      spinRef.current.y,
      st.settings.beginnerMode,
      legalIds,
    );
  }, []);

  // Recompute aim preview whenever relevant game settings or turns change
  useEffect(() => {
    refreshAimPreview();
  }, [currentPlayer, isBreak, phase, players, refreshAimPreview, settings.beginnerMode, settings.practiceMode]);

  // Sync mute state to Web Audio synthesizer
  useEffect(() => {
    soundEngine.setMuted(settings.muted);
  }, [settings.muted]);

  // Check URL `?room=XXXXXX` on initial mount
  useEffect(() => {
    const urlCode = getRoomCodeFromUrl();
    if (urlCode) {
      setInitialUrlRoomCode(urlCode);
      setShowOnlineModal(true);
    }
  }, []);

  const showBubble = useCallback((sender: PlayerIndex, text: string) => {
    const now = Date.now();
    setChatBubbles((prev) => ({
      ...prev,
      [sender]: { player: sender, text, timestamp: now },
    }));
    window.setTimeout(() => {
      setChatBubbles((prev) => {
        const cur = prev[sender];
        if (cur && cur.timestamp === now) {
          const next = { ...prev };
          delete next[sender];
          return next;
        }
        return prev;
      });
    }, 4200);
  }, []);

  const spawnChalkBurst = useCallback((cueX: number, cueY: number, angle: number, power: number) => {
    const tipX = cueX - Math.cos(angle) * BALL_RADIUS;
    const tipY = cueY - Math.sin(angle) * BALL_RADIUS;
    const count = Math.round(7 + power * 8);
    for (let i = 0; i < count; i++) {
      const spread = (Math.random() - 0.5) * 2.2;
      const spd = 25 + Math.random() * 85 * power;
      particlesRef.current.push({
        x: tipX + (Math.random() - 0.5) * 4,
        y: tipY + (Math.random() - 0.5) * 4,
        vx: Math.cos(angle + Math.PI + spread) * spd,
        vy: Math.sin(angle + Math.PI + spread) * spd,
        life: 0,
        maxLife: 0.25 + Math.random() * 0.22,
        size: 1.5 + Math.random() * 2.2,
      });
    }
  }, []);

  /** Apply an authoritative state payload (used on Online game start, post-shot sync, and rematch) */
  const applyAuthoritativeState = useCallback(
    (payload: AuthoritativeStatePayload) => {
      const restored = deserializeBalls(payload.balls);
      ballsRef.current = restored;
      setBallsSnapshot([...restored]);
      setCurrentPlayer(payload.currentPlayer);
      setLastBreaker(payload.lastBreaker);
      setRackNumber(payload.rackNumber);
      if (payload.matchScore) {
        setMatchScore([payload.matchScore[0], payload.matchScore[1]]);
      }
      setPhase(payload.phase);
      setIsBreak(payload.isBreak);
      setKitchenOnly(payload.kitchenOnly);
      setPlayers(payload.players);
      setWinner(payload.winner);
      setWinReason(payload.winReason);
      setNotice(payload.notice);

      cuePowerRef.current = 0;
      cueStrikeThrustRef.current = 0;
      setPowerUI(0);
      spinRef.current = { x: 0, y: 0 };
      setSpinX(0);
      setSpinY(0);
      cueDragValidRef.current = true;
      setCueDragValidUI(true);
      pendingShotRef.current = null;
      remoteAimTargetRef.current = null;
      remoteSyncBufferRef.current.reset();
      shotMovedBallIdsRef.current.clear();
      remoteSyncWaitStartRef.current = null;

      if (payload.isBreak) {
        cueAngleRef.current = defaultAimAngleForRack(restored);
      }

      if (stateRef.current.settings.shotClockSeconds > 0) {
        setTimeLeft(stateRef.current.settings.shotClockSeconds);
      }

      if (payload.notice?.tone === 'foul') {
        soundEngine.playFoul();
      } else if (payload.phase === 'GAME_OVER') {
        soundEngine.playWin();
      }

      // Refresh preview after refs update
      window.setTimeout(() => refreshAimPreview(), 0);
    },
    [refreshAimPreview],
  );

  /** Build current authoritative snapshot for PeerJS / WSS relay broadcast */
  const buildAuthoritativeSnapshot = useCallback(
    (override?: Partial<AuthoritativeStatePayload>): AuthoritativeStatePayload => {
      const st = stateRef.current;
      return {
        balls: serializeBalls(ballsRef.current),
        currentPlayer: override?.currentPlayer ?? st.currentPlayer,
        lastBreaker: override?.lastBreaker ?? st.lastBreaker,
        rackNumber: override?.rackNumber ?? st.rackNumber,
        matchScore: override?.matchScore ?? st.matchScore,
        phase: override?.phase ?? st.phase,
        isBreak: override?.isBreak ?? st.isBreak,
        kitchenOnly: override?.kitchenOnly ?? st.kitchenOnly,
        players: override?.players ?? st.players,
        winner: override?.winner !== undefined ? override.winner : null,
        winReason: override?.winReason ?? '',
        notice: override?.notice ?? null,
      };
    },
    [],
  );

  /** Start a fresh local / AI / practice game (supports alternating breaker, rack counter & cumulative series score) */
  const startNewLocalGame = useCallback(
    (
      payload: LobbyStartPayload,
      options?: { breaker?: PlayerIndex; rackNumber?: number; keepMatchScore?: boolean },
    ) => {
      clearAIActivities();
      peerManagerRef.current?.destroy();
      clearRoomCodeFromUrl();
      setRoomCode('');
      setPeerStatus('idle');
      setPeerError('');
      setLocalPlayerIndex(null);
      if (!options?.keepMatchScore || payload.mode === 'practice') {
        setMatchScore([0, 0]);
      }

      const rack = createInitialRack();
      ballsRef.current = rack;
      setBallsSnapshot([...rack]);

      const isPractice = payload.mode === 'practice';
      const breaker: PlayerIndex = isPractice ? 0 : (options?.breaker ?? 0);
      const nextRack = isPractice ? 1 : (options?.rackNumber ?? 1);

      setMode(payload.mode);
      setAiDifficulty(payload.aiDifficulty);
      setSettings((prev) => ({
        ...prev,
        clothTheme: payload.clothTheme,
        practiceMode: isPractice,
      }));

      const nextPlayers = createFreshPlayers(
        payload.p1Name,
        isPractice ? '练习台' : payload.p2Name,
      );
      setPlayers(nextPlayers);
      setCurrentPlayer(breaker);
      setLastBreaker(breaker);
      setRackNumber(nextRack);
      setPhase('AIMING');
      setIsBreak(!isPractice);
      setKitchenOnly(!isPractice);
      setWinner(null);
      setWinReason('');

      cueAngleRef.current = defaultAimAngleForRack(rack);
      cuePowerRef.current = 0;
      cueStrikeThrustRef.current = 0;
      setPowerUI(0);
      spinRef.current = { x: 0, y: 0 };
      setSpinX(0);
      setSpinY(0);
      cueDragValidRef.current = true;
      setCueDragValidUI(true);
      pendingShotRef.current = null;
      remoteAimTargetRef.current = null;
      remoteSyncBufferRef.current.reset();
      shotMovedBallIdsRef.current.clear();

      noticeCounterRef.current += 1;
      setNotice({
        id: noticeCounterRef.current,
        title: isPractice
          ? '中式八球自由练习已开始'
          : `第 ${nextRack} 局 · ${nextPlayers[breaker].name} 开球`,
        detail: isPractice
          ? '无限摆球且不判犯规，所有设置自由调整'
          : nextRack > 1
            ? '双方轮换开球 · 可先微调左侧 D 区白球位置'
            : '可先微调左侧 D 区开球白球，再拖动瞄准并下拉力度杆开球',
        tone: nextRack > 1 ? 'success' : 'info',
      });

      if (stateRef.current.settings.shotClockSeconds > 0) {
        setTimeLeft(stateRef.current.settings.shotClockSeconds);
      }

      setShowLobby(false);
      setShowOnlineModal(false);
      window.setTimeout(() => refreshAimPreview(), 0);
    },
    [clearAIActivities, refreshAimPreview],
  );

  /** Trigger cue strike animation and physics launch */
  const triggerStrike = useCallback(
    (
      angle: number,
      power: number,
      sX: number,
      sY: number,
      isLocalAuthority: boolean,
      broadcastToPeer: boolean,
      incomingShotSeq?: number,
    ) => {
      const cue = ballsRef.current.find((b) => b.id === 0);
      if (!cue || cue.pocketed) return;

      const seq = broadcastToPeer
        ? ++shotSeqRef.current
        : (incomingShotSeq ?? ++shotSeqRef.current);

      if (!isLocalAuthority) {
        activeRemoteShotSeqRef.current = seq;
        remoteAimTargetRef.current = null;
      }

      cueAngleRef.current = angle;
      cuePowerRef.current = power;
      cueStrikeThrustRef.current = 0;
      spinRef.current = { x: sX, y: sY };
      setPowerUI(power);
      setSpinX(sX);
      setSpinY(sY);

      pendingShotRef.current = {
        angle,
        power,
        spinX: sX,
        spinY: sY,
        isLocalAuthority,
        shotSeq: seq,
      };
      shotRecordRef.current = createEmptyShotRecord();
      lastBallTickSendTimeRef.current = 0;
      remoteSyncWaitStartRef.current = null;
      setPhase('ANIMATING_CUE');

      // Send shot immediately BEFORE local animation finishes so packet flies in parallel with cue thrust!
      if (broadcastToPeer && stateRef.current.mode === 'online') {
        peerManagerRef.current?.send({
          type: 'shot',
          shotSeq: seq,
          angle: Math.round(angle * 10000) / 10000,
          power: Math.round(power * 1000) / 1000,
          spinX: Math.round(sX * 100) / 100,
          spinY: Math.round(sY * 100) / 100,
          cueX: Math.round(cue.x * 10) / 10,
          cueY: Math.round(cue.y * 10) / 10,
        });
      }
    },
    [],
  );

  // --- PeerJS Message Handling ---
  const handlePeerMessage = useCallback(
    (msg: PeerMessage) => {
      const st = stateRef.current;

      switch (msg.type) {
        case 'hello': {
          // Host receives guest nickname -> either resume ongoing match on rejoin, or start Rack 1
          if (peerManagerRef.current?.getIsHost()) {
            const hostName = st.onlineNickname.trim() || '房主';
            const guestName = msg.name.trim() || '好友';
            const cleanSettings: GameSettings = {
              ...st.settings,
              practiceMode: false,
            };
            setSettings(cleanSettings);
            setMode('online');
            setLocalPlayerIndex(0);
            setRematchPending(false);
            setOpponentRequestedRematch(false);

            const isResumingOngoingMatch =
              st.mode === 'online' && st.phase !== 'GAME_OVER' && ballsRef.current.length > 0;

            if (isResumingOngoingMatch) {
              // Preserve the ongoing rack so a rejoining Guest continues right where they left off
              let resumePhase = st.phase;
              if (resumePhase === 'SHOOTING' || resumePhase === 'ANIMATING_CUE') {
                for (const b of ballsRef.current) {
                  b.vx = 0;
                  b.vy = 0;
                  b.spinX = 0;
                  b.spinY = 0;
                  b.hasPostHitSpin = false;
                }
                resumePhase = 'AIMING';
              }
              const resumedPlayers: [PlayerInfo, PlayerInfo] = [
                { ...st.players[0], name: hostName, stats: { ...st.players[0].stats } },
                { ...st.players[1], name: guestName, stats: { ...st.players[1].stats } },
              ];
              noticeCounterRef.current += 1;
              const resumedState: AuthoritativeStatePayload = {
                balls: serializeBalls(ballsRef.current),
                currentPlayer: st.currentPlayer,
                lastBreaker: st.lastBreaker,
                rackNumber: st.rackNumber,
                matchScore: [st.matchScore[0], st.matchScore[1]],
                phase: resumePhase,
                isBreak: st.isBreak,
                kitchenOnly: st.kitchenOnly,
                players: resumedPlayers,
                winner: null,
                winReason: '',
                notice: {
                  id: noticeCounterRef.current,
                  title: `${guestName} 已重新加入房间`,
                  detail: `已恢复第 ${st.rackNumber} 局当前球局 · 轮到 ${resumedPlayers[st.currentPlayer].name}`,
                  tone: 'success',
                },
              };

              applyAuthoritativeState(resumedState);
              peerManagerRef.current.send({
                type: 'start_game',
                hostName,
                guestName,
                settings: cleanSettings,
                initialState: resumedState,
              });
              setShowOnlineModal(false);
              setShowLobby(false);
              break;
            }

            const rack = createInitialRack();
            ballsRef.current = rack;
            const freshPlayers = createFreshPlayers(hostName, guestName);
            shotSeqRef.current = 0;
            activeRemoteShotSeqRef.current = 0;

            const isSameRoomNextRack = st.mode === 'online' && st.phase === 'GAME_OVER';
            const nextRackNum = isSameRoomNextRack ? st.rackNumber + 1 : 1;
            const nextBreakerIdx: PlayerIndex = isSameRoomNextRack
              ? st.lastBreaker === 0
                ? 1
                : 0
              : 0;
            const seriesScore: [number, number] = isSameRoomNextRack
              ? [st.matchScore[0], st.matchScore[1]]
              : [0, 0];

            noticeCounterRef.current += 1;
            const initialState: AuthoritativeStatePayload = {
              balls: serializeBalls(rack),
              currentPlayer: nextBreakerIdx,
              lastBreaker: nextBreakerIdx,
              rackNumber: nextRackNum,
              matchScore: seriesScore,
              phase: 'AIMING',
              isBreak: true,
              kitchenOnly: true,
              players: freshPlayers,
              winner: null,
              winReason: '',
              notice: {
                id: noticeCounterRef.current,
                title: `联机成功 · 第 ${nextRackNum} 局 ${freshPlayers[nextBreakerIdx].name} 开球`,
                detail: `${hostName} vs ${guestName} · 辅助线${cleanSettings.beginnerMode ? '开' : '关'}`,
                tone: 'success',
              },
            };

            applyAuthoritativeState(initialState);
            peerManagerRef.current.send({
              type: 'start_game',
              hostName,
              guestName,
              settings: cleanSettings,
              initialState,
            });
            setShowOnlineModal(false);
            setShowLobby(false);
          }
          break;
        }

        case 'start_game': {
          peerManagerRef.current?.stopHandshakeRetry();
          shotSeqRef.current = 0;
          activeRemoteShotSeqRef.current = 0;
          setMode('online');
          setLocalPlayerIndex(1);
          // Enforce Host's unified room rules on Guest (keep Guest's own muted preference)
          setSettings((prev) => ({
            ...prev,
            clothTheme: msg.settings.clothTheme,
            beginnerMode: msg.settings.beginnerMode,
            shotClockSeconds: msg.settings.shotClockSeconds,
            practiceMode: false,
          }));
          setRematchPending(false);
          setOpponentRequestedRematch(false);
          applyAuthoritativeState(msg.initialState);
          setShowOnlineModal(false);
          setShowLobby(false);
          break;
        }

        case 'aim': {
          remoteAimTargetRef.current = { angle: msg.angle, power: msg.power };
          spinRef.current = { x: msg.spinX, y: msg.spinY };
          setPowerUI(msg.power);
          setSpinX(msg.spinX);
          setSpinY(msg.spinY);
          break;
        }

        case 'drag_cue': {
          const cue = ballsRef.current.find((b) => b.id === 0);
          if (cue) {
            cue.x = msg.x;
            cue.y = msg.y;
            cueDragValidRef.current = msg.valid;
            setCueDragValidUI(msg.valid);
          }
          break;
        }

        case 'place_cue': {
          const cue = ballsRef.current.find((b) => b.id === 0);
          if (cue) {
            cue.x = msg.x;
            cue.y = msg.y;
            cue.pocketed = false;
            cue.pocketAnim = 0;
          }
          cueDragValidRef.current = true;
          setCueDragValidUI(true);
          setPhase('AIMING');
          refreshAimPreview();
          break;
        }

        case 'shot': {
          if (msg.shotSeq <= activeRemoteShotSeqRef.current) {
            break;
          }
          const cue = ballsRef.current.find((b) => b.id === 0);
          if (cue) {
            cue.x = msg.cueX;
            cue.y = msg.cueY;
          }
          const transport = peerManagerRef.current?.getTransport() ?? 'webrtc';
          remoteSyncBufferRef.current.startShot(
            msg.shotSeq,
            ballsRef.current,
            transport,
            performance.now(),
          );
          triggerStrike(msg.angle, msg.power, msg.spinX, msg.spinY, false, false, msg.shotSeq);
          break;
        }

        case 'balls_tick': {
          if (msg.shotSeq < activeRemoteShotSeqRef.current) {
            break;
          }
          const transport = peerManagerRef.current?.getTransport() ?? 'webrtc';

          // If balls_tick arrived before/without the shot packet during opponent's turn, start buffered playback immediately!
          if (msg.shotSeq > activeRemoteShotSeqRef.current) {
            if (st.localPlayerIndex === st.currentPlayer) {
              activeRemoteShotSeqRef.current = msg.shotSeq;
              break;
            }
            activeRemoteShotSeqRef.current = msg.shotSeq;
            remoteAimTargetRef.current = null;
            pendingShotRef.current = {
              angle: cueAngleRef.current,
              power: 0.5,
              spinX: 0,
              spinY: 0,
              isLocalAuthority: false,
              shotSeq: msg.shotSeq,
            };
            cuePowerRef.current = 0;
            cueStrikeThrustRef.current = 0;
            setPowerUI(0);
            remoteSyncWaitStartRef.current = null;
            remoteSyncBufferRef.current.pushTick(
              msg.shotSeq,
              msg.simTimeMs,
              msg.balls,
              ballsRef.current,
              transport,
              performance.now(),
            );
            setPhase('SHOOTING');
            break;
          }

          // Feed timestamped snapshot into the interpolation buffer (never snap balls directly)
          remoteSyncBufferRef.current.pushTick(
            msg.shotSeq,
            msg.simTimeMs,
            msg.balls,
            ballsRef.current,
            transport,
            performance.now(),
          );
          break;
        }

        case 'sync_state': {
          if (msg.shotSeq !== undefined && msg.shotSeq > activeRemoteShotSeqRef.current) {
            activeRemoteShotSeqRef.current = msg.shotSeq;
          }
          const isPlayingRemoteShot =
            st.mode === 'online' &&
            pendingShotRef.current !== null &&
            !pendingShotRef.current.isLocalAuthority &&
            (st.phase === 'SHOOTING' || st.phase === 'ANIMATING_CUE');

          if (isPlayingRemoteShot) {
            const queued = remoteSyncBufferRef.current.queueFinalState(
              msg.state,
              msg.shotSeq,
              performance.now(),
            );
            if (queued) {
              // If cue strike animation is still finishing on a short tap, transition smoothly into glide
              if (st.phase === 'ANIMATING_CUE') {
                cueStrikeThrustRef.current = 1;
              }
              break;
            }
          }

          remoteSyncBufferRef.current.reset();
          applyAuthoritativeState(msg.state);
          break;
        }

        case 'emote': {
          showBubble(msg.sender, msg.text);
          break;
        }

        case 'settings_update': {
          const safePatch: Partial<GameSettings> = {};
          if (msg.settings.clothTheme !== undefined) safePatch.clothTheme = msg.settings.clothTheme;
          if (msg.settings.beginnerMode !== undefined) safePatch.beginnerMode = msg.settings.beginnerMode;
          if (msg.settings.shotClockSeconds !== undefined) {
            safePatch.shotClockSeconds = msg.settings.shotClockSeconds;
          }
          if (Object.keys(safePatch).length > 0) {
            setSettings((prev) => ({ ...prev, ...safePatch }));
            noticeCounterRef.current += 1;
            const detailParts: string[] = [];
            if (safePatch.beginnerMode !== undefined) {
              detailParts.push(`新手辅助：${safePatch.beginnerMode ? '开启' : '关闭'}`);
            }
            if (safePatch.shotClockSeconds !== undefined) {
              detailParts.push(
                `倒计时：${safePatch.shotClockSeconds > 0 ? `${safePatch.shotClockSeconds}秒` : '关闭'}`,
              );
            }
            if (safePatch.clothTheme !== undefined) {
              detailParts.push('台呢风格已同步');
            }
            setNotice({
              id: noticeCounterRef.current,
              title: '房主已更新房间规则',
              detail: detailParts.join(' · '),
              tone: 'info',
            });
          }
          break;
        }

        case 'rematch_request': {
          setOpponentRequestedRematch(true);
          noticeCounterRef.current += 1;
          setNotice({
            id: noticeCounterRef.current,
            title: '对手发起了再来一局请求',
            detail: '点击“接受再来一局”立即轮换开球',
            tone: 'info',
          });
          break;
        }

        case 'rematch_accept': {
          setRematchPending(false);
          setOpponentRequestedRematch(false);
          applyAuthoritativeState(msg.initialState);
          break;
        }

        case 'request_sync': {
          // Reply with latest authoritative snapshot if we are not mid-local-shot
          const isMidLocalShot =
            pendingShotRef.current?.isLocalAuthority &&
            (st.phase === 'SHOOTING' || st.phase === 'ANIMATING_CUE');
          if (!isMidLocalShot && st.phase !== 'SHOOTING') {
            peerManagerRef.current?.send({
              type: 'sync_state',
              state: buildAuthoritativeSnapshot(),
              shotSeq: shotSeqRef.current,
            });
          }
          break;
        }
      }
    },
    [applyAuthoritativeState, buildAuthoritativeSnapshot, refreshAimPreview, showBubble, triggerStrike],
  );

  const handlePeerMessageRef = useRef(handlePeerMessage);
  handlePeerMessageRef.current = handlePeerMessage;

  // Initialize PeerRoomManager strictly once across the entire component lifetime
  useEffect(() => {
    const manager = new PeerRoomManager({
      onStatusChange: (status, detailText) => {
        setPeerStatus(status);
        if (status === 'error' || status === 'disconnected') {
          setPeerError(detailText ?? '');
          setPeerStatusDetail('');
        } else {
          setPeerError('');
          setPeerStatusDetail(detailText ?? '');
        }
      },
      onRoomCodeChange: (code) => {
        setRoomCode(code);
      },
      onConnected: (isHost) => {
        if (!isHost) {
          manager.startGuestHandshakeRetry(() => ({
            type: 'hello',
            name: stateRef.current.onlineNickname.trim() || '好友',
          }));
        }
      },
      onMessage: (msg) => {
        handlePeerMessageRef.current(msg);
      },
      onDisconnected: () => {
        remoteSyncBufferRef.current.reset();
        noticeCounterRef.current += 1;
        const isHostSide = manager.getIsHost();
        setNotice({
          id: noticeCounterRef.current,
          title: '对手已断开联机',
          detail: isHostSide
            ? '原房号已保持开启，好友重连可继续当前球局，或点击“退出房间”结束联机'
            : '可点击下方“退出房间”后输入原房号重新进入，或切换至本地/人机模式',
          tone: 'foul',
        });
      },
    });

    peerManagerRef.current = manager;
    return () => {
      manager.destroy();
    };
  }, []);

  // --- Main 60fps Physics + Cue Thrust + Particle Loop ---
  useEffect(() => {
    let rafId = 0;
    let lastTime = performance.now();

    const tick = (now: number) => {
      const dt = Math.min((now - lastTime) / 1000, 1 / 24);
      lastTime = now;

      // Update chalk particles
      if (particlesRef.current.length > 0) {
        const nextParticles: ChalkParticle[] = [];
        for (const p of particlesRef.current) {
          p.life += dt;
          if (p.life < p.maxLife) {
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vx *= 0.92;
            p.vy *= 0.92;
            nextParticles.push(p);
          }
        }
        particlesRef.current = nextParticles;
      }

      const st = stateRef.current;

      // 0. Smooth 60fps remote aiming interpolation (keeps cue silky even over throttled relay)
      if (
        st.mode === 'online' &&
        st.phase === 'AIMING' &&
        st.localPlayerIndex !== st.currentPlayer &&
        remoteAimTargetRef.current
      ) {
        const target = remoteAimTargetRef.current;
        let angleDelta = target.angle - cueAngleRef.current;
        while (angleDelta > Math.PI) angleDelta -= Math.PI * 2;
        while (angleDelta < -Math.PI) angleDelta += Math.PI * 2;
        const alpha = 1 - Math.exp(-22 * dt);
        const powerDelta = target.power - cuePowerRef.current;
        if (Math.abs(angleDelta) > 0.0008 || Math.abs(powerDelta) > 0.002) {
          cueAngleRef.current += angleDelta * alpha;
          cuePowerRef.current += powerDelta * alpha;
          refreshAimPreview();
        }
      }

      // 1. Cue stick forward strike animation
      // For remote shots, the brief strike window (~65-90ms) naturally absorbs initial interpolation buffering
      if (st.phase === 'ANIMATING_CUE' && pendingShotRef.current) {
        const transport = peerManagerRef.current?.getTransport() ?? 'webrtc';
        const thrustRate = pendingShotRef.current.isLocalAuthority
          ? 12.5
          : transport === 'relay'
            ? 11
            : 15;
        cueStrikeThrustRef.current = Math.min(1, cueStrikeThrustRef.current + dt * thrustRate);
        if (cueStrikeThrustRef.current >= 1) {
          const shot = pendingShotRef.current;
          const cue = ballsRef.current.find((b) => b.id === 0);
          if (cue) {
            spawnChalkBurst(cue.x, cue.y, shot.angle, shot.power);
          }

          if (shot.isLocalAuthority) {
            strikeCueBall(ballsRef.current, shot.angle, shot.power, shot.spinX, shot.spinY);
            localShotStartTimeRef.current = now;
            lastBallTickSendTimeRef.current = now;
            shotMovedBallIdsRef.current.clear();
            shotMovedBallIdsRef.current.add(0);

            // Emit initial t=0 velocity frame immediately on cue impact to prime opponent's sync buffer
            if (st.mode === 'online' && cue) {
              peerManagerRef.current?.send({
                type: 'balls_tick',
                shotSeq: shot.shotSeq,
                simTimeMs: 0,
                balls: [
                  [
                    0,
                    Math.round(cue.x * 10) / 10,
                    Math.round(cue.y * 10) / 10,
                    Math.round(cue.vx),
                    Math.round(cue.vy),
                    0,
                  ],
                ],
              });
            }
          }

          soundEngine.playCueStrike(shot.power, st.isBreak);
          cuePowerRef.current = 0;
          cueStrikeThrustRef.current = 0;
          setPowerUI(0);
          setPhase('SHOOTING');
        }
      } else if (st.phase === 'ANIMATING_CUE' && !pendingShotRef.current) {
        // Recover immediately if cue animation lost its pending shot reference
        setPhase('AIMING');
      }

      // 2. Shooting phase: remote shots use the State Synchronization Interpolation Buffer;
      // local shots run authoritative sub-stepping physics and emit timestamped snapshots.
      if (st.phase === 'SHOOTING') {
        const activeShot = pendingShotRef.current;

        // Branch A: Remote online player's shot -> smooth buffered interpolation playback
        if (st.mode === 'online' && activeShot && !activeShot.isLocalAuthority) {
          const sampleResult = remoteSyncBufferRef.current.sampleIntoBalls(
            ballsRef.current,
            dt,
            now,
            {
              onBallHit: (speed) => soundEngine.playBallCollision(speed),
              onRailHit: (speed) => soundEngine.playRailHit(speed),
              onPocket: () => soundEngine.playPocketDrop(),
            },
          );

          if (sampleResult.pocketEventHappened) {
            setBallsSnapshot([...ballsRef.current]);
          }

          if (sampleResult.readyFinalState) {
            applyAuthoritativeState(sampleResult.readyFinalState);
          } else {
            // Auto-heal if the final sync_state packet was dropped during high latency
            const lastActivity = remoteSyncBufferRef.current.getLastActivityLocalMs();
            if (
              !remoteSyncBufferRef.current.hasPendingFinalState() &&
              lastActivity > 0 &&
              now - lastActivity > 2000 &&
              now - lastSyncRequestSendTimeRef.current > 2000
            ) {
              lastSyncRequestSendTimeRef.current = now;
              peerManagerRef.current?.send({ type: 'request_sync' });
            }
          }

          rafId = requestAnimationFrame(tick);
          return;
        }

        // Branch B: Authoritative local / AI / practice / local-online-shooter physics
        let pocketEventHappened = false;
        stepPhysics(ballsRef.current, dt, shotRecordRef.current, {
          onBallHit: (speed) => soundEngine.playBallCollision(speed),
          onRailHit: (speed) => soundEngine.playRailHit(speed),
          onPocket: () => {
            soundEngine.playPocketDrop();
            pocketEventHappened = true;
          },
        });

        // Safety watchdog: never allow a shot to hang indefinitely from micro-oscillation
        if (localShotStartTimeRef.current > 0 && now - localShotStartTimeRef.current > 14000) {
          for (const b of ballsRef.current) {
            b.vx = 0;
            b.vy = 0;
            b.spinX = 0;
            b.spinY = 0;
            b.hasPostHitSpin = false;
          }
        }

        if (pocketEventHappened) {
          setBallsSnapshot([...ballsRef.current]);
        }

        // Stream timestamped velocity snapshots from local shooter to opponent's interpolation buffer
        if (st.mode === 'online' && activeShot?.isLocalAuthority) {
          const tickInterval = peerManagerRef.current?.getTransport() === 'relay' ? 85 : 50;
          if (now - lastBallTickSendTimeRef.current >= tickInterval) {
            lastBallTickSendTimeRef.current = now;
            const simTimeMs = Math.max(1, Math.round(now - localShotStartTimeRef.current));
            const compact: CompactBallTick[] = [];
            for (const b of ballsRef.current) {
              const moving = b.vx * b.vx + b.vy * b.vy > 4;
              if (moving || b.pocketed) {
                shotMovedBallIdsRef.current.add(b.id);
              }
              if (shotMovedBallIdsRef.current.has(b.id)) {
                compact.push([
                  b.id,
                  Math.round(b.x * 10) / 10,
                  Math.round(b.y * 10) / 10,
                  Math.round(b.vx),
                  Math.round(b.vy),
                  b.pocketed ? 1 : 0,
                ]);
              }
            }
            if (compact.length > 0) {
              peerManagerRef.current?.send({
                type: 'balls_tick',
                shotSeq: activeShot.shotSeq,
                simTimeMs,
                balls: compact,
              });
            }
          }
        }

        if (areAllBallsStopped(ballsRef.current)) {
          const shot = pendingShotRef.current;

          // Authoritative turn rule resolution
          const evalResult = evaluateShotResult({
            balls: ballsRef.current,
            currentPlayer: st.currentPlayer,
            players: st.players,
            isBreak: st.isBreak,
            practiceMode: st.settings.practiceMode,
            shotRecord: shotRecordRef.current,
            noticeCounter: noticeCounterRef.current,
          });
          noticeCounterRef.current = evalResult.notice.id;

          if (evalResult.reRackNeeded) {
            const freshRack = createInitialRack();
            ballsRef.current = freshRack;
            cueAngleRef.current = defaultAimAngleForRack(freshRack);
          }

          setBallsSnapshot([...ballsRef.current]);
          setPlayers(evalResult.players);
          setCurrentPlayer(evalResult.nextPlayer);
          setPhase(evalResult.nextPhase);
          setIsBreak(evalResult.nextIsBreak);
          setKitchenOnly(evalResult.kitchenOnly);
          setWinner(evalResult.winner);
          setWinReason(evalResult.winReason);
          setNotice(evalResult.notice);

          spinRef.current = { x: 0, y: 0 };
          setSpinX(0);
          setSpinY(0);
          cueDragValidRef.current = true;
          setCueDragValidUI(true);
          pendingShotRef.current = null;
          shotMovedBallIdsRef.current.clear();
          remoteSyncWaitStartRef.current = null;

          if (st.settings.shotClockSeconds > 0) {
            setTimeLeft(st.settings.shotClockSeconds);
          }

          const nextMatchScore: [number, number] = [st.matchScore[0], st.matchScore[1]];
          if (
            evalResult.nextPhase === 'GAME_OVER' &&
            evalResult.winner !== null &&
            !st.settings.practiceMode
          ) {
            nextMatchScore[evalResult.winner] += 1;
            setMatchScore(nextMatchScore);
          }

          if (evalResult.notice.tone === 'foul') {
            soundEngine.playFoul();
          } else if (evalResult.nextPhase === 'GAME_OVER') {
            soundEngine.playWin();
          }

          // Broadcast authoritative final ball positions, rules & cumulative room score
          if (st.mode === 'online' && shot?.isLocalAuthority) {
            const snapshot: AuthoritativeStatePayload = {
              balls: serializeBalls(ballsRef.current),
              currentPlayer: evalResult.nextPlayer,
              lastBreaker: st.lastBreaker,
              rackNumber: st.rackNumber,
              matchScore: nextMatchScore,
              phase: evalResult.nextPhase,
              isBreak: evalResult.nextIsBreak,
              kitchenOnly: evalResult.kitchenOnly,
              players: evalResult.players,
              winner: evalResult.winner,
              winReason: evalResult.winReason,
              notice: evalResult.notice,
            };
            peerManagerRef.current?.send({
              type: 'sync_state',
              state: snapshot,
              shotSeq: shot.shotSeq,
            });
          }

          window.setTimeout(() => refreshAimPreview(), 0);
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [applyAuthoritativeState, refreshAimPreview, spawnChalkBurst]);

  // --- AI Opponent Turn Automation (Split cleanly by phase so AI_THINKING never self-cancels) ---
  useEffect(() => {
    if (mode !== 'ai' || currentPlayer !== 1) return;

    if (phase === 'BALL_IN_HAND') {
      clearAIActivities();
      const id = window.setTimeout(() => {
        const spot = computeAIBallInHandSpot(
          ballsRef.current,
          stateRef.current.players[1].group,
          stateRef.current.isBreak,
          stateRef.current.kitchenOnly,
        );
        const cue = ballsRef.current.find((b) => b.id === 0);
        if (cue) {
          cue.x = spot.x;
          cue.y = spot.y;
          cue.pocketed = false;
          cue.pocketAnim = 0;
        }
        setBallsSnapshot([...ballsRef.current]);
        const nextId = window.setTimeout(() => {
          setPhase('AI_THINKING');
        }, 300);
        aiTimersRef.current.push(nextId);
      }, 450);
      aiTimersRef.current.push(id);
      return clearAIActivities;
    }

    if (phase === 'AIMING') {
      clearAIActivities();
      const id = window.setTimeout(() => {
        setPhase('AI_THINKING');
      }, 380);
      aiTimersRef.current.push(id);
      return clearAIActivities;
    }

    if (phase === 'AI_THINKING') {
      clearAIActivities();

      // Safety: ensure cue ball is on table before AI computes shot
      const cue = ballsRef.current.find((b) => b.id === 0);
      if (cue && cue.pocketed) {
        const spot = computeAIBallInHandSpot(
          ballsRef.current,
          stateRef.current.players[1].group,
          false,
          false,
        );
        cue.x = spot.x;
        cue.y = spot.y;
        cue.pocketed = false;
        cue.pocketAnim = 0;
        setBallsSnapshot([...ballsRef.current]);
      }

      const decision = computeAIShot(
        ballsRef.current,
        stateRef.current.players[1].group,
        stateRef.current.isBreak,
        stateRef.current.aiDifficulty,
      );

      const startAngle = cueAngleRef.current;
      // Shortest angular interpolation
      let delta = decision.angle - startAngle;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;

      const aimDuration = 680;
      const chargeDuration = 460;
      const t0 = performance.now();

      spinRef.current = { x: decision.spinX, y: decision.spinY };
      setSpinX(decision.spinX);
      setSpinY(decision.spinY);

      const animateAI = (now: number) => {
        const elapsed = now - t0;
        if (elapsed < aimDuration) {
          const t = elapsed / aimDuration;
          const ease = 1 - Math.pow(1 - t, 3);
          cueAngleRef.current = startAngle + delta * ease;
          refreshAimPreview();
          aiAnimRafRef.current = requestAnimationFrame(animateAI);
          return;
        }

        cueAngleRef.current = startAngle + delta;
        refreshAimPreview();

        const chargeElapsed = elapsed - aimDuration;
        if (chargeElapsed < chargeDuration) {
          const ct = chargeElapsed / chargeDuration;
          const p = decision.power * Math.sin((ct * Math.PI) / 2);
          cuePowerRef.current = p;
          setPowerUI(p);
          aiAnimRafRef.current = requestAnimationFrame(animateAI);
          return;
        }

        aiAnimRafRef.current = null;
        triggerStrike(
          decision.angle,
          decision.power,
          decision.spinX,
          decision.spinY,
          true,
          false,
        );
      };

      aiAnimRafRef.current = requestAnimationFrame(animateAI);
      return clearAIActivities;
    }

    return undefined;
  }, [clearAIActivities, currentPlayer, mode, phase, refreshAimPreview, triggerStrike]);

  // --- Shot Clock Countdown (Wall-Clock Accurate + Dual-Side Online Fail-Safe) ---
  useEffect(() => {
    if (
      settings.shotClockSeconds <= 0 ||
      settings.practiceMode ||
      (phase !== 'AIMING' && phase !== 'BALL_IN_HAND') ||
      (mode === 'online' && (peerStatus === 'disconnected' || peerStatus === 'error'))
    ) {
      return;
    }

    const totalSec = settings.shotClockSeconds;
    const deadlineMs = Date.now() + totalSec * 1000;
    setTimeLeft(totalSec);
    let lastWholeSec = totalSec;
    let timeoutFired = false;

    const triggerTimeoutFoul = () => {
      if (timeoutFired) return;
      timeoutFired = true;
      window.clearInterval(interval);

      const st = stateRef.current;
      if (st.phase !== 'AIMING' && st.phase !== 'BALL_IN_HAND') return;

      const timedOutPlayer = st.currentPlayer;
      const opponent: PlayerIndex = timedOutPlayer === 0 ? 1 : 0;

      // Ensure cue ball is legally on the table before granting full-table Ball-in-Hand
      const cue = ballsRef.current.find((b) => b.id === 0);
      if (cue) {
        cue.pocketed = false;
        cue.pocketAnim = 0;
        cue.vx = 0;
        cue.vy = 0;
        cue.spinX = 0;
        cue.spinY = 0;
        cue.hasPostHitSpin = false;
        if (!isValidCueBallPosition(cue.x, cue.y, ballsRef.current, false)) {
          const safeSpot = computeAIBallInHandSpot(
            ballsRef.current,
            st.players[opponent].group,
            false,
            false,
          );
          cue.x = safeSpot.x;
          cue.y = safeSpot.y;
        }
      }

      const updatedPlayers: [PlayerInfo, PlayerInfo] = [
        { ...st.players[0], stats: { ...st.players[0].stats } },
        { ...st.players[1], stats: { ...st.players[1].stats } },
      ];
      updatedPlayers[timedOutPlayer].stats.fouls += 1;
      updatedPlayers[timedOutPlayer].stats.currentStreak = 0;

      noticeCounterRef.current += 1;
      const foulNotice: GameNotice = {
        id: noticeCounterRef.current,
        title: `${updatedPlayers[timedOutPlayer].name} 击球超时犯规`,
        detail: `自动换人 · ${updatedPlayers[opponent].name} 获得全场自由球`,
        tone: 'foul',
      };

      // Reset transient aiming/drag states cleanly outside React updater
      cuePowerRef.current = 0;
      cueStrikeThrustRef.current = 0;
      isDraggingCueRef.current = false;
      pendingShotRef.current = null;
      remoteAimTargetRef.current = null;
      remoteSyncBufferRef.current.reset();
      cueDragValidRef.current = true;
      setCueDragValidUI(true);
      setPowerUI(0);
      setTimeLeft(totalSec);

      soundEngine.playFoul();
      setBallsSnapshot([...ballsRef.current]);
      setPlayers(updatedPlayers);
      setCurrentPlayer(opponent);
      setPhase('BALL_IN_HAND');
      setIsBreak(false);
      setKitchenOnly(false);
      setNotice(foulNotice);

      if (st.mode === 'online') {
        const nextSeq = ++shotSeqRef.current;
        peerManagerRef.current?.send({
          type: 'sync_state',
          shotSeq: nextSeq,
          state: buildAuthoritativeSnapshot({
            currentPlayer: opponent,
            phase: 'BALL_IN_HAND',
            isBreak: false,
            kitchenOnly: false,
            players: updatedPlayers,
            notice: foulNotice,
          }),
        });
      }
    };

    const interval = window.setInterval(() => {
      if (timeoutFired) return;
      const nowMs = Date.now();
      const remaining = Math.max(0, (deadlineMs - nowMs) / 1000);
      setTimeLeft(remaining);

      const whole = Math.ceil(remaining);
      if (whole < lastWholeSec && whole <= 5 && whole >= 1) {
        soundEngine.playTick();
      }
      lastWholeSec = whole;

      if (remaining <= 0) {
        const st = stateRef.current;
        const isLocalTurn =
          st.mode === 'local' ||
          (st.mode === 'ai' && st.currentPlayer === 0) ||
          (st.mode === 'online' && st.localPlayerIndex === st.currentPlayer);

        if (isLocalTurn) {
          triggerTimeoutFoul();
        } else if (st.mode === 'online' && nowMs >= deadlineMs + 1200) {
          // Online fail-safe: if active peer's tab was throttled/frozen past 0s,
          // waiting opponent claims Ball-in-Hand after a 1.2s network grace window and syncs both sides.
          triggerTimeoutFoul();
        }
      }
    }, 100);

    return () => window.clearInterval(interval);
  }, [
    buildAuthoritativeSnapshot,
    currentPlayer,
    localPlayerIndex,
    mode,
    peerStatus,
    phase,
    rackNumber,
    settings.practiceMode,
    settings.shotClockSeconds,
  ]);

  // --- User Interaction Handlers ---

  const broadcastAimThrottled = useCallback((angle: number, power: number, sX: number, sY: number) => {
    if (stateRef.current.mode !== 'online') return;
    const now = performance.now();
    // Adaptive throttle: keep WSS relay channel uncongested so `shot` arrives instantly
    const minInterval = peerManagerRef.current?.getTransport() === 'relay' ? 120 : 45;
    if (now - lastAimSendTimeRef.current < minInterval) return;
    lastAimSendTimeRef.current = now;
    peerManagerRef.current?.send({
      type: 'aim',
      angle: Math.round(angle * 10000) / 10000,
      power: Math.round(power * 100) / 100,
      spinX: Math.round(sX * 100) / 100,
      spinY: Math.round(sY * 100) / 100,
    });
  }, []);

  const handleAimChange = useCallback(
    (angle: number) => {
      cueAngleRef.current = angle;
      refreshAimPreview();
      broadcastAimThrottled(angle, cuePowerRef.current, spinRef.current.x, spinRef.current.y);
    },
    [broadcastAimThrottled, refreshAimPreview],
  );

  const handlePowerChange = useCallback(
    (power: number) => {
      cuePowerRef.current = power;
      setPowerUI(power);
      broadcastAimThrottled(cueAngleRef.current, power, spinRef.current.x, spinRef.current.y);
    },
    [broadcastAimThrottled],
  );

  const handleCancelCharge = useCallback(() => {
    cuePowerRef.current = 0;
    setPowerUI(0);
    broadcastAimThrottled(cueAngleRef.current, 0, spinRef.current.x, spinRef.current.y);
  }, [broadcastAimThrottled]);

  const handleSpinChange = useCallback(
    (nx: number, ny: number) => {
      spinRef.current = { x: nx, y: ny };
      setSpinX(nx);
      setSpinY(ny);
      refreshAimPreview();
      broadcastAimThrottled(cueAngleRef.current, cuePowerRef.current, nx, ny);
    },
    [broadcastAimThrottled, refreshAimPreview],
  );

  const handleUserShoot = useCallback(
    (power: number) => {
      if (!isLocalTurn || phase !== 'AIMING') return;
      soundEngine.unlock();
      triggerStrike(
        cueAngleRef.current,
        power,
        spinRef.current.x,
        spinRef.current.y,
        true,
        stateRef.current.mode === 'online',
      );
    },
    [isLocalTurn, phase, triggerStrike],
  );

  const handleBallInHandMove = useCallback((x: number, y: number, valid: boolean) => {
    const cue = ballsRef.current.find((b) => b.id === 0);
    if (!cue) return;
    cue.x = x;
    cue.y = y;
    cue.pocketed = false;
    cue.pocketAnim = 0;
    cueDragValidRef.current = valid;
    setCueDragValidUI(valid);

    if (stateRef.current.mode === 'online') {
      const now = performance.now();
      const dragInterval = peerManagerRef.current?.getTransport() === 'relay' ? 100 : 40;
      if (now - lastDragSendTimeRef.current >= dragInterval) {
        lastDragSendTimeRef.current = now;
        peerManagerRef.current?.send({
          type: 'drag_cue',
          x: Math.round(x * 10) / 10,
          y: Math.round(y * 10) / 10,
          valid,
        });
      }
    }
  }, []);

  const handleBallInHandConfirm = useCallback(
    (x: number, y: number) => {
      const cue = ballsRef.current.find((b) => b.id === 0);
      if (!cue) return;
      const valid = isValidCueBallPosition(x, y, ballsRef.current, stateRef.current.kitchenOnly);
      if (!valid) return;
      cue.x = x;
      cue.y = y;
      cueDragValidRef.current = true;
      setCueDragValidUI(true);
      setBallsSnapshot([...ballsRef.current]);
      setPhase('AIMING');
      refreshAimPreview();

      if (stateRef.current.mode === 'online') {
        peerManagerRef.current?.send({ type: 'place_cue', x, y });
      }
    },
    [refreshAimPreview],
  );

  const handleEnterManualCueMove = () => {
    if (!isLocalTurn || phase !== 'AIMING') return;
    if (!settings.practiceMode && !isBreak) return;
    cuePowerRef.current = 0;
    setPowerUI(0);
    setPhase('BALL_IN_HAND');
    const cue = ballsRef.current.find((b) => b.id === 0);
    if (cue) {
      const valid = isValidCueBallPosition(cue.x, cue.y, ballsRef.current, isBreak && !settings.practiceMode);
      cueDragValidRef.current = valid;
      setCueDragValidUI(valid);
    }
  };

  const handleUpdateSettings = (patch: Partial<GameSettings>) => {
    // In online mode, Guest can only toggle local audio (`muted`); room rules belong exclusively to Host
    if (mode === 'online' && localPlayerIndex === 1) {
      if (patch.muted !== undefined) {
        setSettings((prev) => ({ ...prev, muted: patch.muted! }));
      }
      return;
    }

    const effectivePatch: Partial<GameSettings> = { ...patch };
    if (mode === 'online') {
      delete effectivePatch.practiceMode;
    }

    setSettings((prev) => {
      const next = { ...prev, ...effectivePatch };
      if (effectivePatch.practiceMode !== undefined && mode !== 'online') {
        if (effectivePatch.practiceMode) {
          setMode('practice');
        } else if (mode === 'practice') {
          setMode('local');
        }
      }
      return next;
    });

    if (mode === 'online' && peerManagerRef.current?.getIsHost()) {
      const syncPatch: Partial<GameSettings> = {};
      if (effectivePatch.clothTheme !== undefined) syncPatch.clothTheme = effectivePatch.clothTheme;
      if (effectivePatch.beginnerMode !== undefined) {
        syncPatch.beginnerMode = effectivePatch.beginnerMode;
      }
      if (effectivePatch.shotClockSeconds !== undefined) {
        syncPatch.shotClockSeconds = effectivePatch.shotClockSeconds;
      }
      if (Object.keys(syncPatch).length > 0) {
        peerManagerRef.current.send({ type: 'settings_update', settings: syncPatch });
      }
    }
  };

  const handleRematch = () => {
    const nextBreaker: PlayerIndex = lastBreaker === 0 ? 1 : 0;
    const nextRack = rackNumber + 1;

    if (mode === 'online') {
      if (opponentRequestedRematch) {
        // Accept rematch and generate fresh synchronized rack with strict alternating breaker
        const rack = createInitialRack();
        ballsRef.current = rack;
        const freshPlayers = createFreshPlayers(players[0].name, players[1].name);
        noticeCounterRef.current += 1;
        const initialState: AuthoritativeStatePayload = {
          balls: serializeBalls(rack),
          currentPlayer: nextBreaker,
          lastBreaker: nextBreaker,
          rackNumber: nextRack,
          matchScore: [stateRef.current.matchScore[0], stateRef.current.matchScore[1]],
          phase: 'AIMING',
          isBreak: true,
          kitchenOnly: true,
          players: freshPlayers,
          winner: null,
          winReason: '',
          notice: {
            id: noticeCounterRef.current,
            title: `第 ${nextRack} 局 · ${freshPlayers[nextBreaker].name} 开球`,
            detail: `当前总比分 ${stateRef.current.matchScore[0]} : ${stateRef.current.matchScore[1]} · 双方轮换开球权`,
            tone: 'success',
          },
        };
        setOpponentRequestedRematch(false);
        setRematchPending(false);
        applyAuthoritativeState(initialState);
        peerManagerRef.current?.send({
          type: 'rematch_accept',
          initialState,
        });
      } else {
        setRematchPending(true);
        peerManagerRef.current?.send({ type: 'rematch_request' });
      }
      return;
    }

    const isPractice = mode === 'practice' || settings.practiceMode;
    startNewLocalGame(
      {
        mode,
        p1Name: players[0].name,
        p2Name: players[1].name,
        aiDifficulty,
        clothTheme: settings.clothTheme,
      },
      isPractice
        ? { breaker: 0, rackNumber: 1, keepMatchScore: false }
        : { breaker: nextBreaker, rackNumber: nextRack, keepMatchScore: true },
    );
  };

  const handleSendEmote = (text: string) => {
    const sender: PlayerIndex =
      mode === 'online' && localPlayerIndex !== null ? localPlayerIndex : currentPlayer;
    showBubble(sender, text);
    if (mode === 'online') {
      peerManagerRef.current?.send({ type: 'emote', text, sender });
    }
  };

  const handleCreateRoom = () => {
    const code = peerManagerRef.current?.createRoom() ?? '';
    setRoomCode(code);
  };

  const handleJoinRoom = (code: string) => {
    setRoomCode(code);
    peerManagerRef.current?.joinRoom(code);
  };

  /** Cleanly exit current online room and open room modal ready to rejoin or create a new room */
  const handleLeaveOnlineRoom = () => {
    const prevCode = roomCode;
    const wasHost = peerManagerRef.current?.getIsHost() ?? false;

    peerManagerRef.current?.destroy();
    clearRoomCodeFromUrl();
    remoteSyncBufferRef.current.reset();
    pendingShotRef.current = null;
    remoteAimTargetRef.current = null;
    cuePowerRef.current = 0;
    cueStrikeThrustRef.current = 0;
    isDraggingCueRef.current = false;
    setPowerUI(0);

    setRoomCode('');
    setPeerStatus('idle');
    setPeerStatusDetail('');
    setPeerError('');
    setLocalPlayerIndex(null);
    setRematchPending(false);
    setOpponentRequestedRematch(false);
    setMatchScore([0, 0]);

    if (mode === 'online') {
      setMode('local');
    }

    // If Guest leaves an active room, pre-fill the previous 6-digit code for 1-click rejoin
    setInitialUrlRoomCode(!wasHost && prevCode ? prevCode : '');
    setShowOnlineModal(true);

    noticeCounterRef.current += 1;
    setNotice({
      id: noticeCounterRef.current,
      title: prevCode ? `已退出房间 ${prevCode}` : '已退出联机房间',
      detail:
        !wasHost && prevCode
          ? '已为您保留原房号，点击“加入房间开战”即可重连续玩'
          : '您可以新建房间、输入房号加入或切换单机模式',
      tone: 'info',
    });
  };

  const handleCopyInviteLinkTop = async () => {
    if (!roomCode) return;
    const url = buildShareLink(roomCode);
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // noop
    }
    setCopiedRoomTop(true);
    setTimeout(() => setCopiedRoomTop(false), 1800);
  };

  /** One-click in-app refresh & state sync recovery without breaking the current match */
  const handleRefreshRecover = () => {
    soundEngine.unlock();
    setRefreshingUI(true);
    window.setTimeout(() => setRefreshingUI(false), 750);

    cuePowerRef.current = 0;
    cueStrikeThrustRef.current = 0;
    setPowerUI(0);
    isDraggingCueRef.current = false;

    if (mode === 'online') {
      if (peerStatus === 'disconnected' || peerStatus === 'error') {
        setShowOnlineModal(true);
        return;
      }

      // If it's our own stuck shot, settle velocities so authoritative sync_state is sent right away
      if (
        localPlayerIndex === currentPlayer &&
        (phase === 'SHOOTING' || phase === 'ANIMATING_CUE')
      ) {
        for (const b of ballsRef.current) {
          b.vx = 0;
          b.vy = 0;
          b.spinX = 0;
          b.spinY = 0;
          b.hasPostHitSpin = false;
        }
        if (phase === 'ANIMATING_CUE') {
          pendingShotRef.current = null;
          setPhase('AIMING');
        }
        peerManagerRef.current?.send({
          type: 'sync_state',
          state: buildAuthoritativeSnapshot({ phase: 'AIMING' }),
          shotSeq: shotSeqRef.current,
        });
      } else {
        // Request latest authoritative table state from opponent immediately
        lastSyncRequestSendTimeRef.current = performance.now();
        peerManagerRef.current?.send({ type: 'request_sync' });
      }

      noticeCounterRef.current += 1;
      setNotice({
        id: noticeCounterRef.current,
        title: '已刷新并请求同步',
        detail: '正在拉取最新球局状态，如仍未恢复可点击右上角重连',
        tone: 'info',
      });
      refreshAimPreview();
      return;
    }

    // Local / AI / Practice mode: unstick any stalled animation, AI timer, or micro-oscillating ball
    clearAIActivities();
    if (phase === 'SHOOTING') {
      for (const b of ballsRef.current) {
        b.vx = 0;
        b.vy = 0;
        b.spinX = 0;
        b.spinY = 0;
        b.hasPostHitSpin = false;
      }
      if (!pendingShotRef.current) {
        setPhase('AIMING');
      }
    } else if (phase === 'ANIMATING_CUE' || phase === 'AI_THINKING') {
      pendingShotRef.current = null;
      setPhase('AIMING');
    }
    setBallsSnapshot([...ballsRef.current]);
    refreshAimPreview();

    noticeCounterRef.current += 1;
    setNotice({
      id: noticeCounterRef.current,
      title: '已刷新当前球局',
      detail: '已解除卡顿状态并保留当前比分与球位',
      tone: 'success',
    });
  };

  const modeLabel =
    mode === 'online'
      ? `在线联机 · 房间 ${roomCode}`
      : mode === 'ai'
        ? `人机对战 · ${aiDifficulty === 'pro' ? '进阶 AI' : '简易 AI'}`
        : mode === 'practice' || settings.practiceMode
          ? '自由练球模式'
          : '同屏双人对战';

  const canMoveCueManually =
    isLocalTurn && phase === 'AIMING' && (settings.practiceMode || isBreak);

  // Active player consecutive-pot streak (2+ pots triggers center-screen pop-up & scoreboard flame counter)
  const activeStreakPlayer = players[currentPlayer];
  const activeStreakCount =
    phase !== 'GAME_OVER' ? activeStreakPlayer.stats.currentStreak : 0;
  const showStreakCounter = activeStreakCount >= 2;
  const streakTierLabel = soundEngine.pickStreakLine(Math.max(2, activeStreakCount)).title;

  const [streakBurst, setStreakBurst] = useState<{
    id: number;
    count: number;
    playerName: string;
    epicTitle: string;
    badge: string;
    tagLabel: string;
  } | null>(null);
  const lastStreakTriggerRef = useRef<{ player: PlayerIndex; count: number }>({
    player: 0,
    count: 0,
  });
  const lastBreakNoticeIdRef = useRef<number | null>(null);
  const prevIsBreakRef = useRef<boolean>(isBreak);

  useEffect(() => {
    const wasBreak = prevIsBreakRef.current;
    prevIsBreakRef.current = isBreak;

    if (phase === 'GAME_OVER') {
      lastStreakTriggerRef.current = { player: currentPlayer, count: 0 };
      setStreakBurst(null);
      return;
    }

    // 1. Break-and-pot ("开球有下") callout — works in local, AI, online, and practice modes
    const noticeId = notice?.id ?? null;
    const isStandardBreakPot = Boolean(
      notice &&
        noticeId !== lastBreakNoticeIdRef.current &&
        (notice.title.startsWith('开球进球') || notice.title.startsWith('开球进黑 8')),
    );
    const isPracticeBreakPot = Boolean(
      wasBreak &&
        !isBreak &&
        activeStreakCount >= 1 &&
        noticeId !== null &&
        noticeId !== lastBreakNoticeIdRef.current,
    );

    if (isStandardBreakPot || isPracticeBreakPot) {
      lastBreakNoticeIdRef.current = noticeId;
      lastStreakTriggerRef.current = { player: currentPlayer, count: activeStreakCount };
      const callout = soundEngine.playBreakPotCallout();
      const burstId = Date.now();
      setStreakBurst({
        id: burstId,
        count: Math.max(1, activeStreakCount),
        playerName: activeStreakPlayer.name,
        epicTitle: callout.title,
        badge: callout.badge,
        tagLabel: activeStreakCount >= 2 ? `开球连下 ${activeStreakCount} 球` : '开球有下',
      });
      const timer = window.setTimeout(() => {
        setStreakBurst((cur) => (cur && cur.id === burstId ? null : cur));
      }, 2400);
      return () => window.clearTimeout(timer);
    }

    // 2. Regular shots: only 2+ consecutive pots (连杆) trigger voice callout + pop-up
    if (activeStreakCount < 2) {
      lastStreakTriggerRef.current = { player: currentPlayer, count: activeStreakCount };
      return;
    }

    const prev = lastStreakTriggerRef.current;
    const isFreshIncrease =
      prev.player !== currentPlayer || activeStreakCount > prev.count;
    lastStreakTriggerRef.current = { player: currentPlayer, count: activeStreakCount };

    if (!isFreshIncrease) return;

    const callout = soundEngine.playStreakCallout(activeStreakCount);
    const burstId = Date.now();
    setStreakBurst({
      id: burstId,
      count: activeStreakCount,
      playerName: activeStreakPlayer.name,
      epicTitle: callout.title,
      badge: callout.badge,
      tagLabel: `${activeStreakCount} 连杆`,
    });

    const timer = window.setTimeout(() => {
      setStreakBurst((cur) => (cur && cur.id === burstId ? null : cur));
    }, 2400);

    return () => window.clearTimeout(timer);
  }, [activeStreakCount, activeStreakPlayer.name, currentPlayer, isBreak, notice, phase]);

  return (
    <div className="min-h-screen bg-[#0e1014] text-[#f3efe6] flex flex-col">
      {/* Clean 3-Zone Top Bar */}
      <header className="w-full border-b border-white/8 bg-[#12151b]/95 backdrop-blur-xs sticky top-0 z-30">
        <div className="max-w-[1340px] mx-auto px-4 sm:px-6 h-14 flex items-center justify-between gap-6">
          {/* Zone 1: Single-line Brand Wordmark */}
          <div className="text-base sm:text-lg font-bold tracking-tight text-[#f3efe6] whitespace-nowrap shrink-0">
            金杆八球
          </div>

          {/* Zone 2: Concise single-line navigation controls */}
          <nav className="flex items-center gap-4 sm:gap-6 text-xs sm:text-sm font-medium text-[#b5becd]">
            <button
              type="button"
              onClick={() => setShowRules(true)}
              className="inline-flex items-center gap-1.5 hover:text-[#f3efe6] transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <BookOpen className="w-3.5 h-3.5 text-[#d4a853]" />
              <span>规则</span>
            </button>

            <button
              type="button"
              onClick={() => setShowSettings(true)}
              className="inline-flex items-center gap-1.5 hover:text-[#f3efe6] transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <Settings className="w-3.5 h-3.5 text-[#d4a853]" />
              <span>设置</span>
            </button>

            <button
              type="button"
              onClick={() => {
                soundEngine.unlock();
                handleUpdateSettings({ muted: !settings.muted });
              }}
              className="inline-flex items-center gap-1.5 hover:text-[#f3efe6] transition-colors cursor-pointer whitespace-nowrap shrink-0"
              aria-label={settings.muted ? '取消静音' : '一键静音'}
            >
              {settings.muted ? (
                <VolumeX className="w-3.5 h-3.5 text-[#f87171]" />
              ) : (
                <Volume2 className="w-3.5 h-3.5 text-[#d4a853]" />
              )}
              <span className="hidden sm:inline">{settings.muted ? '已静音' : '音效'}</span>
            </button>

            <button
              type="button"
              onClick={handleRefreshRecover}
              className="inline-flex items-center gap-1.5 hover:text-[#f3efe6] transition-colors cursor-pointer whitespace-nowrap shrink-0"
              title={mode === 'online' ? '卡顿时点击立即同步最新球局状态' : '卡顿时点击解除卡顿（不重置当前球局）'}
            >
              <RefreshCw
                className={`w-3.5 h-3.5 text-[#d4a853] ${refreshingUI ? 'animate-spin' : ''}`}
              />
              <span>{mode === 'online' ? '刷新同步' : '刷新'}</span>
            </button>

            {mode !== 'online' && (
              <button
                type="button"
                onClick={handleRematch}
                className="inline-flex items-center gap-1.5 hover:text-[#f3efe6] transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5 text-[#d4a853]" />
                <span className="hidden sm:inline">重开</span>
              </button>
            )}
          </nav>

          {/* Zone 3: 1 Primary Action */}
          <div className="shrink-0">
            <button
              type="button"
              onClick={() => setShowLobby(true)}
              className="px-3.5 sm:px-4 py-2 rounded-lg bg-[#d4a853] hover:bg-[#e1b866] text-[#111317] text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 inline-flex items-center gap-1.5"
            >
              <Users className="w-3.5 h-3.5" />
              <span>模式 / 联机</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Arena Workspace */}
      <main className="flex-1 w-full max-w-[1340px] mx-auto px-3 sm:px-6 py-3 sm:py-4 flex flex-col justify-center gap-3">
        {/* Top Scoreboard HUD + Dynamic Flame Streak Counter */}
        <div className="w-full flex flex-col xl:flex-row items-stretch gap-2.5">
          <div className="flex-1 min-w-0">
            <Scoreboard
              players={players}
              currentPlayer={currentPlayer}
              balls={ballsSnapshot}
              phase={phase}
              mode={mode}
              practiceMode={settings.practiceMode}
              shotClockSeconds={settings.shotClockSeconds}
              timeLeft={timeLeft}
              notice={notice}
              chatBubbles={chatBubbles}
              localPlayerIndex={localPlayerIndex}
              rackNumber={rackNumber}
              matchScore={matchScore}
            />
          </div>

          {showStreakCounter && (
            <div
              key={`${activeStreakPlayer.name}-${activeStreakCount}`}
              role="status"
              aria-live="polite"
              className="animate-streak-pop relative overflow-hidden shrink-0 xl:w-48 rounded-xl px-4 py-2.5 bg-[#1b1411] border border-[#f97316]/55 shadow-[0_0_24px_rgba(249,115,22,0.22)] flex items-center justify-between xl:justify-center gap-3"
            >
              {/* Animated warm radial flame aura */}
              <div
                aria-hidden="true"
                className="animate-streak-aura pointer-events-none absolute -inset-2 rounded-2xl"
                style={{
                  background:
                    'radial-gradient(circle at 26% 50%, rgba(249,115,22,0.34) 0%, rgba(234,88,12,0.12) 48%, rgba(0,0,0,0) 78%)',
                }}
              />

              {/* Gliding light sheen */}
              <div
                aria-hidden="true"
                className="animate-streak-sheen pointer-events-none absolute inset-y-0 w-16 bg-gradient-to-r from-transparent via-[#fde68a]/25 to-transparent"
              />

              {/* Dynamic flame emblem */}
              <div className="relative z-10 flex items-center justify-center w-10 h-10 rounded-lg bg-gradient-to-b from-[#f97316]/25 to-[#dc2626]/20 border border-[#fb923c]/35 shrink-0">
                <Flame className="animate-streak-flame w-6 h-6 text-[#fb923c] fill-[#f97316]/75" />
              </div>

              {/* Streak count & player readout */}
              <div className="relative z-10 min-w-0 flex-1 xl:flex-initial">
                <div className="flex items-baseline gap-1.5">
                  <span className="font-mono-num text-xl font-bold leading-none text-[#fef3c7] drop-shadow-[0_0_8px_rgba(249,115,22,0.6)]">
                    {activeStreakCount}
                  </span>
                  <span className="text-sm font-bold text-[#fb923c] whitespace-nowrap">
                    连杆
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-[#fdba74]/90 truncate">
                  <span className="truncate">{activeStreakPlayer.name}</span>
                  <span className="opacity-50" aria-hidden="true">
                    ·
                  </span>
                  <span className="whitespace-nowrap shrink-0 text-[#fde68a]">
                    {streakTierLabel}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Billiard Table + Side Dock (Desktop) / Bottom Dock (Mobile) */}
        <div className="flex flex-col lg:flex-row items-center lg:items-stretch gap-3 sm:gap-4">
          {/* Dominant Table Surface */}
          <div className="relative w-full flex-1 min-w-0 flex flex-col items-center justify-center">
            <PoolCanvas
              ballsRef={ballsRef}
              particlesRef={particlesRef}
              clothTheme={settings.clothTheme}
              phase={phase}
              canInteract={isLocalTurn}
              isRemoteTurn={isRemoteTurn}
              kitchenOnly={kitchenOnly && !settings.practiceMode}
              cueAngleRef={cueAngleRef}
              cuePowerRef={cuePowerRef}
              cueStrikeThrustRef={cueStrikeThrustRef}
              aimPreviewRef={aimPreviewRef}
              cueDragValidRef={cueDragValidRef}
              isDraggingCueRef={isDraggingCueRef}
              onAimChange={handleAimChange}
              onDirectPowerChange={handlePowerChange}
              onShoot={handleUserShoot}
              onCancelCharge={handleCancelCharge}
              onBallInHandMove={handleBallInHandMove}
              onBallInHandConfirm={handleBallInHandConfirm}
              onUnlockAudio={() => soundEngine.unlock()}
            />

            {/* Main-screen center pop-up streak celebration (2+ consecutive pots, non-blocking) */}
            {streakBurst && (
              <div
                key={streakBurst.id}
                aria-live="polite"
                className="pointer-events-none select-none absolute inset-0 z-20 flex items-center justify-center p-4"
              >
                <div className="animate-streak-stage relative">
                  {/* Expanding golden-flame shockwave ring radiating outside card */}
                  <div
                    aria-hidden="true"
                    className="animate-streak-ring pointer-events-none absolute -inset-2.5 rounded-3xl border-2 border-[#fbbf24]/65 shadow-[0_0_24px_rgba(249,115,22,0.5)]"
                  />

                  <div className="relative flex items-center gap-3.5 sm:gap-4 px-6 sm:px-8 py-3.5 sm:py-4 rounded-2xl bg-[#16100d]/92 border border-[#fb923c]/70 shadow-[0_14px_48px_rgba(0,0,0,0.68),0_0_40px_rgba(249,115,22,0.38)] backdrop-blur-xs overflow-hidden">
                    {/* Warm radial fire aura */}
                    <div
                      aria-hidden="true"
                      className="animate-streak-aura pointer-events-none absolute -inset-4"
                      style={{
                        background:
                          streakBurst.count >= 4
                            ? 'radial-gradient(circle at 28% 50%, rgba(251,191,36,0.42) 0%, rgba(249,115,22,0.24) 44%, rgba(0,0,0,0) 76%)'
                            : 'radial-gradient(circle at 28% 50%, rgba(249,115,22,0.38) 0%, rgba(234,88,12,0.16) 48%, rgba(0,0,0,0) 76%)',
                      }}
                    />

                    {/* Gliding metallic sheen */}
                    <div
                      aria-hidden="true"
                      className="animate-streak-sheen pointer-events-none absolute inset-y-0 w-24 bg-gradient-to-r from-transparent via-[#fef3c7]/30 to-transparent"
                    />

                    {/* Flame emblem */}
                    <div className="relative z-10 flex items-center justify-center w-12 h-12 sm:w-14 sm:h-14 rounded-xl bg-gradient-to-b from-[#f97316]/35 to-[#dc2626]/25 border border-[#fbbf24]/50 shrink-0 shadow-[0_0_20px_rgba(249,115,22,0.45)]">
                      <Flame className="animate-streak-flame w-7 h-7 sm:w-8 sm:h-8 text-[#fde047] fill-[#f97316]" />
                    </div>

                    {/* Bold Three Kingdoms Kill style streak callout */}
                    <div className="relative z-10 pr-1">
                      <div className="text-xl sm:text-2xl font-extrabold tracking-wider text-[#fef3c7] drop-shadow-[0_0_16px_rgba(249,115,22,0.85)] whitespace-nowrap">
                        {streakBurst.epicTitle}！
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-xs sm:text-sm font-semibold">
                        <span className="text-[#f3efe6] max-w-[140px] truncate">
                          {streakBurst.playerName}
                        </span>
                        <span className="text-[#fb923c]/60" aria-hidden="true">
                          ·
                        </span>
                        <span className="font-mono-num text-[#fb923c] whitespace-nowrap">
                          {streakBurst.tagLabel}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Desktop Right Control Dock (Spin + Vertical Power Slider) */}
          <aside className="hidden lg:flex flex-col items-center justify-between w-[112px] shrink-0 rounded-2xl bg-[#14171d] border border-white/8 py-4 px-3">
            <SpinControl
              spinX={spinX}
              spinY={spinY}
              disabled={!isLocalTurn || phase !== 'AIMING'}
              onChange={handleSpinChange}
            />

            <div className="w-full border-t border-white/8 my-2" />

            <PowerSlider
              power={powerUI}
              disabled={!isLocalTurn || phase !== 'AIMING'}
              orientation="vertical"
              onPowerChange={handlePowerChange}
              onReleaseShoot={handleUserShoot}
              onCancel={handleCancelCharge}
            />
          </aside>

          {/* Mobile / Tablet Bottom Control Dock */}
          <div className="flex lg:hidden items-center gap-3 w-full rounded-xl bg-[#14171d] border border-white/8 px-3.5 py-2.5">
            <SpinControl
              spinX={spinX}
              spinY={spinY}
              disabled={!isLocalTurn || phase !== 'AIMING'}
              compact
              onChange={handleSpinChange}
            />
            <div className="w-px h-10 bg-white/10 shrink-0" />
            <div className="flex-1 min-w-0">
              <PowerSlider
                power={powerUI}
                disabled={!isLocalTurn || phase !== 'AIMING'}
                orientation="horizontal"
                onPowerChange={handlePowerChange}
                onReleaseShoot={handleUserShoot}
                onCancel={handleCancelCharge}
              />
            </div>
          </div>
        </div>

        {/* Clean Context Action Bar Below Table */}
        <div className="flex flex-wrap items-center justify-between gap-2.5 px-1 text-xs text-[#9ea6b4]">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-[#d8dde6]">{modeLabel}</span>
            <span className="opacity-35" aria-hidden="true">
              ·
            </span>
            <span>
              {phase === 'BALL_IN_HAND'
                ? isLocalTurn
                  ? kitchenOnly && !settings.practiceMode
                    ? '请在左侧开球线后（D 区）拖拽摆放白球（绿圈为合法位置）'
                    : '请在台面空白处拖拽摆放白球（绿圈合法，红圈重叠）'
                  : '等待对手摆放自由球...'
                : isRemoteTurn
                  ? mode === 'ai'
                    ? '电脑对手正在计算走位与出杆...'
                    : '对手回合，实时同步瞄准中...'
                  : '拖拽台面瞄准 · 拉动右侧力度杆或回拉球杆击球 · 右键取消'}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Ball-in-Hand quick confirm button */}
            {phase === 'BALL_IN_HAND' && isLocalTurn && (
              <button
                type="button"
                disabled={!cueDragValidUI}
                onClick={() => {
                  const cue = ballsRef.current.find((b) => b.id === 0);
                  if (cue) handleBallInHandConfirm(cue.x, cue.y);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#10b981] hover:bg-[#059669] disabled:opacity-40 text-[#081711] text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap"
              >
                <Check className="w-3.5 h-3.5" />
                确认白球位置
              </button>
            )}

            {/* Adjust break cue ball or free-practice cue placement */}
            {canMoveCueManually && (
              <button
                type="button"
                onClick={handleEnterManualCueMove}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#191d25] hover:bg-[#232834] border border-white/10 text-xs font-medium text-[#f3efe6] transition-colors cursor-pointer whitespace-nowrap"
              >
                <Hand className="w-3.5 h-3.5 text-[#d4a853]" />
                {isBreak && !settings.practiceMode ? '调整开球位' : '移动白球'}
              </button>
            )}

            {/* Online room quick invite copy, emote chat & leave/rejoin */}
            {mode === 'online' && (
              <>
                {roomCode && (
                  <button
                    type="button"
                    onClick={handleCopyInviteLinkTop}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#191d25] hover:bg-[#232834] border border-white/10 text-xs font-medium text-[#f3efe6] transition-colors cursor-pointer whitespace-nowrap"
                  >
                    {copiedRoomTop ? (
                      <Check className="w-3.5 h-3.5 text-[#34d399]" />
                    ) : (
                      <Copy className="w-3.5 h-3.5 text-[#d4a853]" />
                    )}
                    <span>{copiedRoomTop ? '已复制链接' : `房间 ${roomCode}`}</span>
                  </button>
                )}
                <EmoteBar onSend={handleSendEmote} disabled={peerStatus !== 'connected'} />
                <button
                  type="button"
                  onClick={handleLeaveOnlineRoom}
                  title="退出当前联机房间（可随时凭房号重新进入）"
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#221518] hover:bg-[#2f1a1f] border border-[#ef4444]/35 text-xs font-medium text-[#fca5a5] transition-colors cursor-pointer whitespace-nowrap"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  <span>退出房间</span>
                </button>
              </>
            )}

            {mode !== 'online' && (
              <button
                type="button"
                onClick={() => setShowOnlineModal(true)}
                className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  peerStatus === 'waiting' && roomCode
                    ? 'bg-[#231e14] hover:bg-[#2d2618] border-[#d4a853]/50 text-[#f3efe6]'
                    : 'bg-[#191d25] hover:bg-[#232834] border-white/10 text-[#f3efe6]'
                }`}
              >
                <Wifi className="w-3.5 h-3.5 text-[#d4a853]" />
                {peerStatus === 'waiting' && roomCode
                  ? `房间 ${roomCode} · 等待好友中`
                  : '邀请好友联机'}
              </button>
            )}
          </div>
        </div>
      </main>

      {/* Modals */}
      {showLobby && (
        <LobbyModal
          initialP1={players[0].name}
          initialP2={mode === 'local' ? players[1].name : '玩家二'}
          initialDifficulty={aiDifficulty}
          clothTheme={settings.clothTheme}
          canClose
          onClose={() => setShowLobby(false)}
          onStartLocalOrAI={startNewLocalGame}
          onOpenOnline={(nick) => {
            setOnlineNickname(nick);
            setShowLobby(false);
            setShowOnlineModal(true);
          }}
        />
      )}

      {showOnlineModal && (
        <OnlineRoomModal
          nickname={onlineNickname}
          initialJoinCode={initialUrlRoomCode}
          roomCode={roomCode}
          status={peerStatus}
          statusDetail={peerStatusDetail}
          errorText={peerError}
          settings={settings}
          onUpdateRoomRules={handleUpdateSettings}
          onNicknameChange={setOnlineNickname}
          onCreateRoom={handleCreateRoom}
          onJoinRoom={handleJoinRoom}
          onLeaveRoom={handleLeaveOnlineRoom}
          onCancelConnect={() => {
            peerManagerRef.current?.destroy();
            setPeerStatus('idle');
            setPeerStatusDetail('');
            setPeerError('');
          }}
          onClose={() => {
            setShowOnlineModal(false);
            // Keep active or waiting host room alive in background when closing the modal
            if (peerStatus !== 'connected' && peerStatus !== 'waiting' && mode !== 'online') {
              peerManagerRef.current?.destroy();
              setPeerStatus('idle');
              setPeerStatusDetail('');
              setRoomCode('');
            }
          }}
        />
      )}

      {showSettings && (
        <SettingsModal
          settings={settings}
          isOnline={mode === 'online'}
          isOnlineGuest={mode === 'online' && localPlayerIndex === 1}
          onUpdate={handleUpdateSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showRules && <RulesModal onClose={() => setShowRules(false)} />}

      {phase === 'GAME_OVER' && winner !== null && (
        <GameOverModal
          winner={winner}
          winReason={winReason}
          players={players}
          matchScore={matchScore}
          nextBreakerName={players[lastBreaker === 0 ? 1 : 0].name}
          nextRackNumber={rackNumber + 1}
          isOnline={mode === 'online'}
          rematchPending={rematchPending}
          opponentRequestedRematch={opponentRequestedRematch}
          onRematch={handleRematch}
          onOpenLobby={() => {
            setWinner(null);
            setShowLobby(true);
          }}
        />
      )}
    </div>
  );
}
