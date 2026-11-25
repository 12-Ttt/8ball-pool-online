import React, { useEffect, useState } from 'react';
import {
  BookOpen,
  Bot,
  Check,
  Copy,
  Link2,
  LogOut,
  RefreshCw,
  Settings,
  Sliders,
  Target,
  Trophy,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import { CLOTH_PALETTES } from '../game/constants';
import { buildShareLink, normalizeRoomCode } from '../game/peer';
import type {
  AIDifficulty,
  ClothTheme,
  GameMode,
  GameSettings,
  PeerConnectionStatus,
  PlayerIndex,
  PlayerInfo,
} from '../game/types';

/* -------------------------------------------------------------------------- */
/* Modal Wrapper                                                              */
/* -------------------------------------------------------------------------- */

function ModalShell({
  title,
  subtitle,
  onClose,
  canClose = true,
  maxWidth = 'max-w-lg',
  children,
}: {
  title: string;
  subtitle?: string;
  onClose?: () => void;
  canClose?: boolean;
  maxWidth?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs">
      <div
        className={`w-full ${maxWidth} rounded-2xl bg-[#151820] border border-white/10 shadow-[0_24px_70px_rgba(0,0,0,0.75)] overflow-hidden`}
      >
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-white/8">
          <div>
            <h2 className="text-lg font-semibold text-[#f3efe6]">{title}</h2>
            {subtitle && <p className="text-xs text-[#9ea6b4] mt-0.5">{subtitle}</p>}
          </div>
          {canClose && onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-[#9ea6b4] hover:text-[#f3efe6] hover:bg-white/8 transition-colors cursor-pointer"
              aria-label="关闭弹窗"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="p-6 max-h-[80vh] overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Mode Lobby Modal                                                           */
/* -------------------------------------------------------------------------- */

export interface LobbyStartPayload {
  mode: GameMode;
  p1Name: string;
  p2Name: string;
  aiDifficulty: AIDifficulty;
  clothTheme: ClothTheme;
}

export const LobbyModal: React.FC<{
  initialP1: string;
  initialP2: string;
  initialDifficulty: AIDifficulty;
  clothTheme: ClothTheme;
  canClose: boolean;
  onClose: () => void;
  onStartLocalOrAI: (payload: LobbyStartPayload) => void;
  onOpenOnline: (nickname: string) => void;
}> = ({
  initialP1,
  initialP2,
  initialDifficulty,
  clothTheme,
  canClose,
  onClose,
  onStartLocalOrAI,
  onOpenOnline,
}) => {
  const [selectedMode, setSelectedMode] = useState<GameMode>('local');
  const [p1Name, setP1Name] = useState(initialP1);
  const [p2Name, setP2Name] = useState(initialP2);
  const [aiDifficulty, setAiDifficulty] = useState<AIDifficulty>(initialDifficulty);
  const [theme, setTheme] = useState<ClothTheme>(clothTheme);

  const handleLaunch = () => {
    const cleanP1 = p1Name.trim() || '玩家一';
    const cleanP2 = p2Name.trim() || '玩家二';
    if (selectedMode === 'online') {
      onOpenOnline(cleanP1);
      return;
    }
    onStartLocalOrAI({
      mode: selectedMode,
      p1Name: cleanP1,
      p2Name:
        selectedMode === 'ai'
          ? aiDifficulty === 'pro'
            ? '进阶 AI'
            : '简易 AI'
          : cleanP2,
      aiDifficulty,
      clothTheme: theme,
    });
  };

  const modes: Array<{
    id: GameMode;
    title: string;
    desc: string;
    icon: React.ReactNode;
  }> = [
    {
      id: 'local',
      title: '同屏双人对战',
      desc: '同一设备轮流击球，支持自定义昵称',
      icon: <Users className="w-4 h-4" />,
    },
    {
      id: 'online',
      title: '在线联机（免后端）',
      desc: '直连 + 加密中继自动切换，房主统一制定规则',
      icon: <Wifi className="w-4 h-4" />,
    },
    {
      id: 'ai',
      title: '单人人机对战',
      desc: '简易与进阶两档 AI 对手陪练',
      icon: <Bot className="w-4 h-4" />,
    },
    {
      id: 'practice',
      title: '自由练球模式',
      desc: '无限摆球、不判犯规，所有辅助设置自由调整',
      icon: <Target className="w-4 h-4" />,
    },
  ];

  return (
    <ModalShell
      title="开始新对局"
      subtitle="中式八球（中八）标准赛制 · 选择游玩模式与台桌配色"
      canClose={canClose}
      onClose={onClose}
      maxWidth="max-w-xl"
    >
      <div className="space-y-5">
        {/* 2x2 Mode Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {modes.map((m) => {
            const active = selectedMode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setSelectedMode(m.id)}
                className={`p-3.5 rounded-xl border text-left transition-colors cursor-pointer ${
                  active
                    ? 'bg-[#1f2430] border-[#d4a853] text-[#f3efe6]'
                    : 'bg-[#101319] border-white/8 text-[#c2c9d6] hover:border-white/18'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={active ? 'text-[#d4a853]' : 'text-[#8d96a6]'}>{m.icon}</span>
                  <span className="text-sm font-semibold">{m.title}</span>
                </div>
                <p className="text-xs text-[#8d96a6] mt-1.5 leading-relaxed">{m.desc}</p>
              </button>
            );
          })}
        </div>

        {/* Mode-specific fields */}
        {selectedMode === 'local' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            <label className="block space-y-1.5">
              <span className="text-xs text-[#9ea6b4]">玩家 1 昵称</span>
              <input
                type="text"
                maxLength={14}
                value={p1Name}
                onChange={(e) => setP1Name(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[#0f1217] border border-white/12 text-sm text-[#f3efe6] focus:outline-none focus:border-[#d4a853]"
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs text-[#9ea6b4]">玩家 2 昵称</span>
              <input
                type="text"
                maxLength={14}
                value={p2Name}
                onChange={(e) => setP2Name(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[#0f1217] border border-white/12 text-sm text-[#f3efe6] focus:outline-none focus:border-[#d4a853]"
              />
            </label>
          </div>
        )}

        {selectedMode === 'ai' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
            <label className="block space-y-1.5">
              <span className="text-xs text-[#9ea6b4]">你的昵称</span>
              <input
                type="text"
                maxLength={14}
                value={p1Name}
                onChange={(e) => setP1Name(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[#0f1217] border border-white/12 text-sm text-[#f3efe6] focus:outline-none focus:border-[#d4a853]"
              />
            </label>
            <div className="space-y-1.5">
              <span className="text-xs text-[#9ea6b4]">AI 难度</span>
              <div className="grid grid-cols-2 gap-1.5 p-1 rounded-lg bg-[#0f1217] border border-white/10">
                <button
                  type="button"
                  onClick={() => setAiDifficulty('easy')}
                  className={`py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                    aiDifficulty === 'easy'
                      ? 'bg-[#d4a853] text-[#111317]'
                      : 'text-[#9ea6b4] hover:text-[#f3efe6]'
                  }`}
                >
                  简易 AI
                </button>
                <button
                  type="button"
                  onClick={() => setAiDifficulty('pro')}
                  className={`py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                    aiDifficulty === 'pro'
                      ? 'bg-[#d4a853] text-[#111317]'
                      : 'text-[#9ea6b4] hover:text-[#f3efe6]'
                  }`}
                >
                  进阶 AI
                </button>
              </div>
            </div>
          </div>
        )}

        {(selectedMode === 'online' || selectedMode === 'practice') && (
          <label className="block space-y-1.5 pt-1">
            <span className="text-xs text-[#9ea6b4]">你的昵称</span>
            <input
              type="text"
              maxLength={14}
              value={p1Name}
              onChange={(e) => setP1Name(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-[#0f1217] border border-white/12 text-sm text-[#f3efe6] focus:outline-none focus:border-[#d4a853]"
            />
          </label>
        )}

        {/* Cloth Theme Picker */}
        <div className="space-y-2 pt-1 border-t border-white/8">
          <span className="text-xs text-[#9ea6b4]">台呢纹理配色</span>
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(CLOTH_PALETTES) as ClothTheme[]).map((key) => {
              const pal = CLOTH_PALETTES[key];
              const active = theme === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTheme(key)}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
                    active
                      ? 'bg-[#1f2430] border-[#d4a853] text-[#f3efe6]'
                      : 'bg-[#101319] border-white/8 text-[#9ea6b4] hover:text-[#f3efe6]'
                  }`}
                >
                  <span
                    className="w-3.5 h-3.5 rounded-full border border-white/25 shrink-0"
                    style={{ backgroundColor: pal.swatch }}
                  />
                  <span className="truncate">{pal.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex justify-end gap-2.5 pt-2">
          {canClose && (
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2.5 rounded-lg text-xs font-medium text-[#9ea6b4] hover:text-[#f3efe6] hover:bg-white/6 transition-colors cursor-pointer"
            >
              取消
            </button>
          )}
          <button
            type="button"
            onClick={handleLaunch}
            className="px-6 py-2.5 rounded-lg bg-[#d4a853] hover:bg-[#e1b866] text-[#111317] text-sm font-semibold transition-colors cursor-pointer whitespace-nowrap"
          >
            {selectedMode === 'online' ? '进入联机大厅' : '立即开局'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
};

/* -------------------------------------------------------------------------- */
/* Online Room Modal (PeerJS P2P)                                             */
/* -------------------------------------------------------------------------- */

export const OnlineRoomModal: React.FC<{
  nickname: string;
  initialJoinCode: string;
  roomCode: string;
  status: PeerConnectionStatus;
  statusDetail: string;
  errorText: string;
  settings: GameSettings;
  onUpdateRoomRules: (patch: Partial<GameSettings>) => void;
  onNicknameChange: (name: string) => void;
  onCreateRoom: () => void;
  onJoinRoom: (code: string) => void;
  onCancelConnect: () => void;
  onLeaveRoom: () => void;
  onClose: () => void;
}> = ({
  nickname,
  initialJoinCode,
  roomCode,
  status,
  statusDetail,
  errorText,
  settings,
  onUpdateRoomRules,
  onNicknameChange,
  onCreateRoom,
  onJoinRoom,
  onCancelConnect,
  onLeaveRoom,
  onClose,
}) => {
  const [tab, setTab] = useState<'create' | 'join'>(initialJoinCode ? 'join' : 'create');
  const [joinInput, setJoinInput] = useState(initialJoinCode);
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  useEffect(() => {
    if (initialJoinCode) {
      setJoinInput(initialJoinCode);
      setTab('join');
    }
  }, [initialJoinCode]);

  const shareUrl = roomCode ? buildShareLink(roomCode) : '';
  const hasActiveOrStaleRoom =
    Boolean(roomCode) &&
    (status === 'connected' || status === 'waiting' || status === 'creating' || status === 'disconnected');

  const copyText = async (text: string, which: 'code' | 'link') => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    if (which === 'code') {
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 1800);
    } else {
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 1800);
    }
  };

  return (
    <ModalShell
      title="中式八球在线联机"
      subtitle="房主统一制定房间规则，支持 P2P 直连与自动加密中继"
      onClose={onClose}
    >
      <div className="space-y-4">
        {hasActiveOrStaleRoom && (
          <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl bg-[#1a1f29] border border-[#d4a853]/35">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-[#f3efe6] truncate">
                当前房间：<span className="font-mono-num text-[#d4a853]">{roomCode}</span>
              </div>
              <div className="text-[11px] text-[#9ea6b4] truncate">
                {status === 'connected'
                  ? '联机对局进行中'
                  : status === 'disconnected'
                    ? '连接已断开，可退出后重新加入'
                    : '房间等待中'}
              </div>
            </div>
            <button
              type="button"
              onClick={onLeaveRoom}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#2a171a] hover:bg-[#3a1f24] border border-[#ef4444]/35 text-xs font-medium text-[#fecaca] transition-colors cursor-pointer shrink-0 whitespace-nowrap"
            >
              <LogOut className="w-3.5 h-3.5" />
              退出房间
            </button>
          </div>
        )}

        <label className="block space-y-1.5">
          <span className="text-xs text-[#9ea6b4]">我的联机昵称</span>
          <input
            type="text"
            maxLength={14}
            value={nickname}
            onChange={(e) => onNicknameChange(e.target.value)}
            placeholder="请输入昵称"
            className="w-full px-3 py-2 rounded-lg bg-[#0f1217] border border-white/12 text-sm text-[#f3efe6] focus:outline-none focus:border-[#d4a853]"
          />
        </label>

        {/* Segmented Create / Join Tabs */}
        <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-[#0f1217] border border-white/8">
          <button
            type="button"
            onClick={() => setTab('create')}
            className={`py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
              tab === 'create'
                ? 'bg-[#212633] text-[#f3efe6]'
                : 'text-[#8d96a6] hover:text-[#f3efe6]'
            }`}
          >
            创建房间（房主）
          </button>
          <button
            type="button"
            onClick={() => setTab('join')}
            className={`py-2 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
              tab === 'join'
                ? 'bg-[#212633] text-[#f3efe6]'
                : 'text-[#8d96a6] hover:text-[#f3efe6]'
            }`}
          >
            加入房间（受邀）
          </button>
        </div>

        {tab === 'create' ? (
          <div className="space-y-3.5">
            {/* Host-controlled unified room rules */}
            <div className="p-3.5 rounded-xl bg-[#101319] border border-white/8 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-[#f3efe6]">房间规则（双方统一生效）</span>
                <span className="text-[11px] text-[#8d96a6]">由房主制定</span>
              </div>

              <label className="flex items-center justify-between gap-3 cursor-pointer">
                <div>
                  <div className="text-xs font-medium text-[#e4e8f0]">新手辅助线</div>
                  <div className="text-[11px] text-[#8d96a6]">关闭仅保留白球至目标球连线；开启后显示击球后路线、分离角与碰库预测</div>
                </div>
                <input
                  type="checkbox"
                  checked={settings.beginnerMode}
                  onChange={(e) => onUpdateRoomRules({ beginnerMode: e.target.checked })}
                  className="w-4 h-4 accent-[#d4a853] cursor-pointer"
                />
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1 border-t border-white/6">
                <div className="space-y-1.5">
                  <span className="text-[11px] text-[#9ea6b4]">击球倒计时</span>
                  <div className="grid grid-cols-3 gap-1">
                    {[
                      { label: '关闭', value: 0 },
                      { label: '30秒', value: 30 },
                      { label: '45秒', value: 45 },
                    ].map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => onUpdateRoomRules({ shotClockSeconds: opt.value })}
                        className={`py-1.5 rounded-md border text-[11px] font-medium transition-colors cursor-pointer ${
                          settings.shotClockSeconds === opt.value
                            ? 'bg-[#1f2430] border-[#d4a853] text-[#f3efe6]'
                            : 'bg-[#0b0d12] border-white/8 text-[#8d96a6] hover:text-[#f3efe6]'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <span className="text-[11px] text-[#9ea6b4]">台呢配色</span>
                  <div className="grid grid-cols-3 gap-1">
                    {(Object.keys(CLOTH_PALETTES) as ClothTheme[]).map((key) => {
                      const pal = CLOTH_PALETTES[key];
                      const active = settings.clothTheme === key;
                      return (
                        <button
                          key={key}
                          type="button"
                          onClick={() => onUpdateRoomRules({ clothTheme: key })}
                          className={`flex items-center justify-center gap-1 py-1.5 px-1.5 rounded-md border text-[11px] font-medium transition-colors cursor-pointer ${
                            active
                              ? 'bg-[#1f2430] border-[#d4a853] text-[#f3efe6]'
                              : 'bg-[#0b0d12] border-white/8 text-[#8d96a6] hover:text-[#f3efe6]'
                          }`}
                          title={pal.name}
                        >
                          <span
                            className="w-2.5 h-2.5 rounded-full border border-white/25 shrink-0"
                            style={{ backgroundColor: pal.swatch }}
                          />
                          <span className="truncate">{key === 'green' ? '经典绿' : key === 'blue' ? '大师蓝' : '酒红'}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {!roomCode || (status !== 'creating' && status !== 'waiting' && status !== 'connected') ? (
              <div className="p-4 rounded-xl bg-[#101319] border border-white/8 space-y-3 text-center">
                <p className="text-xs text-[#9ea6b4] leading-relaxed">
                  首局由房主开球，后续再来一局将严格双方轮换开球。
                </p>
                <button
                  type="button"
                  onClick={onCreateRoom}
                  className="w-full py-2.5 rounded-lg bg-[#d4a853] hover:bg-[#e1b866] text-[#111317] text-sm font-semibold transition-colors cursor-pointer"
                >
                  创建联机房间
                </button>
              </div>
            ) : (
              <div className="p-4 rounded-xl bg-[#101319] border border-[#d4a853]/35 space-y-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-[#9ea6b4] shrink-0">6 位房间号</span>
                  <span className="text-xs text-[#d4a853] truncate">
                    {statusDetail ||
                      (status === 'creating'
                        ? '正在分配房间...'
                        : status === 'waiting'
                          ? '等待好友加入...'
                          : '已连接')}
                  </span>
                </div>

                <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg bg-[#0b0d12] border border-white/8">
                  <span className="font-mono-num text-2xl sm:text-3xl font-bold tracking-[0.22em] text-[#f3efe6]">
                    {roomCode}
                  </span>
                  <button
                    type="button"
                    onClick={() => copyText(roomCode, 'code')}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#1d222c] hover:bg-[#272e3c] text-xs font-medium text-[#f3efe6] transition-colors cursor-pointer shrink-0"
                  >
                    {copiedCode ? <Check className="w-3.5 h-3.5 text-[#34d399]" /> : <Copy className="w-3.5 h-3.5" />}
                    {copiedCode ? '已复制' : '复制房号'}
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => copyText(shareUrl, 'link')}
                  className="w-full py-2.5 px-4 rounded-lg bg-[#d4a853] hover:bg-[#e1b866] text-[#111317] text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors cursor-pointer"
                >
                  {copiedLink ? <Check className="w-4 h-4" /> : <Link2 className="w-4 h-4" />}
                  {copiedLink ? '邀请链接已复制，发给好友即可直接加入' : '一键复制好友邀请链接'}
                </button>

                <p className="text-[11px] text-[#8d96a6] text-center">
                  好友在手机或电脑浏览器中打开链接即可自动接入本房间，请保持此页面开启。
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <label className="block space-y-1.5">
              <span className="text-xs text-[#9ea6b4]">输入好友的 6 位房间号</span>
              <input
                type="text"
                maxLength={6}
                value={joinInput}
                onChange={(e) => setJoinInput(normalizeRoomCode(e.target.value))}
                placeholder="例如：K8P4M2"
                className="w-full px-4 py-3 rounded-lg bg-[#0f1217] border border-white/12 font-mono-num text-xl tracking-[0.22em] text-center text-[#f3efe6] uppercase placeholder:text-[#4e5666] placeholder:tracking-normal focus:outline-none focus:border-[#d4a853]"
              />
            </label>

            <p className="text-[11px] text-[#8d96a6] text-center">
              加入后将自动同步房主设定的新手辅助、倒计时与台呢规则。
            </p>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={joinInput.length !== 6 || status === 'joining'}
                onClick={() => onJoinRoom(joinInput)}
                className="flex-1 py-2.5 rounded-lg bg-[#d4a853] hover:bg-[#e1b866] disabled:opacity-45 text-[#111317] text-sm font-semibold transition-colors cursor-pointer"
              >
                {status === 'joining' ? '正在连接房主...' : '加入房间开战'}
              </button>
              {status === 'joining' && (
                <button
                  type="button"
                  onClick={onCancelConnect}
                  className="px-3.5 py-2.5 rounded-lg bg-[#1d222d] hover:bg-[#272e3c] text-xs font-medium text-[#f3efe6] transition-colors cursor-pointer whitespace-nowrap"
                >
                  取消
                </button>
              )}
            </div>

            {status === 'joining' && statusDetail && (
              <p className="text-xs text-[#d4a853] text-center">{statusDetail}</p>
            )}
          </div>
        )}

        {errorText && (
          <div className="px-3.5 py-2.5 rounded-lg bg-[#2a171a] border border-[#ef4444]/35 text-xs text-[#fecaca]">
            {errorText}
          </div>
        )}
      </div>
    </ModalShell>
  );
};

/* -------------------------------------------------------------------------- */
/* Settings Modal                                                             */
/* -------------------------------------------------------------------------- */

export const SettingsModal: React.FC<{
  settings: GameSettings;
  isOnline: boolean;
  isOnlineGuest: boolean;
  onUpdate: (patch: Partial<GameSettings>) => void;
  onClose: () => void;
}> = ({ settings, isOnline, isOnlineGuest, onUpdate, onClose }) => {
  return (
    <ModalShell
      title="对局与辅助设置"
      subtitle={
        isOnline
          ? isOnlineGuest
            ? '联机房间规则由房主统一设定 · 本地可调节音效'
            : '你是联机房主 · 规则修改将实时同步生效于双方'
          : '实时生效 · 自由调整桌面风格、辅助线与练习模式'
      }
      onClose={onClose}
    >
      <div className="space-y-5">
        {isOnline && (
          <div
            className={`px-3.5 py-2.5 rounded-lg text-xs border ${
              isOnlineGuest
                ? 'bg-[#1a1f29] border-white/10 text-[#b5becd]'
                : 'bg-[#1f1b13] border-[#d4a853]/35 text-[#f3dfb0]'
            }`}
          >
            {isOnlineGuest
              ? '联机模式下，新手辅助线、击球倒计时和台呢配色由房主统一控制，确保双方规则一致。'
              : '作为房主，你调整的新手辅助线、击球倒计时和台呢配色会立刻同步给对手。'}
          </div>
        )}

        {/* Cloth Theme */}
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-[#c2c9d6]">
            <Sliders className="w-3.5 h-3.5 text-[#d4a853]" />
            台呢配色
          </div>
          <div className="grid grid-cols-3 gap-2">
            {(Object.keys(CLOTH_PALETTES) as ClothTheme[]).map((key) => {
              const pal = CLOTH_PALETTES[key];
              const active = settings.clothTheme === key;
              return (
                <button
                  key={key}
                  type="button"
                  disabled={isOnlineGuest}
                  onClick={() => onUpdate({ clothTheme: key })}
                  className={`flex items-center gap-2 px-3 py-2.5 rounded-lg border text-xs font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                    active
                      ? 'bg-[#1f2430] border-[#d4a853] text-[#f3efe6]'
                      : 'bg-[#101319] border-white/8 text-[#9ea6b4] hover:text-[#f3efe6]'
                  }`}
                >
                  <span
                    className="w-3.5 h-3.5 rounded-full border border-white/25 shrink-0"
                    style={{ backgroundColor: pal.swatch }}
                  />
                  <span className="truncate">{pal.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Toggles */}
        <div className="space-y-3 pt-2 border-t border-white/8">
          <label
            className={`flex items-center justify-between gap-4 ${
              isOnlineGuest ? 'opacity-55 cursor-not-allowed' : 'cursor-pointer'
            }`}
          >
            <div>
              <div className="text-sm font-medium text-[#f3efe6]">新手辅助模式</div>
              <div className="text-xs text-[#8d96a6]">关闭仅保留白球与目标球连线；开启后显示击球后路线、分离角线与碰库预测</div>
            </div>
            <input
              type="checkbox"
              disabled={isOnlineGuest}
              checked={settings.beginnerMode}
              onChange={(e) => onUpdate({ beginnerMode: e.target.checked })}
              className="w-4 h-4 accent-[#d4a853] cursor-pointer disabled:cursor-not-allowed"
            />
          </label>

          {!isOnline && (
            <label className="flex items-center justify-between gap-4 cursor-pointer">
              <div>
                <div className="text-sm font-medium text-[#f3efe6]">自由练习模式</div>
                <div className="text-xs text-[#8d96a6]">不判犯规、可随时拖拽摆放白球练习走位</div>
              </div>
              <input
                type="checkbox"
                checked={settings.practiceMode}
                onChange={(e) => onUpdate({ practiceMode: e.target.checked })}
                className="w-4 h-4 accent-[#d4a853] cursor-pointer"
              />
            </label>
          )}

          <label className="flex items-center justify-between gap-4 cursor-pointer">
            <div>
              <div className="text-sm font-medium text-[#f3efe6]">开启合成音效</div>
              <div className="text-xs text-[#8d96a6]">浏览器原生 Web Audio 撞球、碰库与落袋声（本地独立生效）</div>
            </div>
            <input
              type="checkbox"
              checked={!settings.muted}
              onChange={(e) => onUpdate({ muted: !e.target.checked })}
              className="w-4 h-4 accent-[#d4a853] cursor-pointer"
            />
          </label>
        </div>

        {/* Shot Clock */}
        <div className="space-y-2 pt-2 border-t border-white/8">
          <div className="flex items-center gap-1.5 text-xs font-medium text-[#c2c9d6]">
            <Settings className="w-3.5 h-3.5 text-[#d4a853]" />
            击球倒计时
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[
              { label: '关闭', value: 0 },
              { label: '30 秒', value: 30 },
              { label: '45 秒', value: 45 },
            ].map((opt) => (
              <button
                key={opt.value}
                type="button"
                disabled={isOnlineGuest}
                onClick={() => onUpdate({ shotClockSeconds: opt.value })}
                className={`py-2 rounded-lg border text-xs font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                  settings.shotClockSeconds === opt.value
                    ? 'bg-[#1f2430] border-[#d4a853] text-[#f3efe6]'
                    : 'bg-[#101319] border-white/8 text-[#9ea6b4] hover:text-[#f3efe6]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </ModalShell>
  );
};

/* -------------------------------------------------------------------------- */
/* Rules Quick-Reference Modal                                                */
/* -------------------------------------------------------------------------- */

export const RulesModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  return (
    <ModalShell
      title="中式八球（中八）规则与操控指南"
      subtitle="标准中式八球紧凑圆弧袋口与轮换开球赛制"
      onClose={onClose}
      maxWidth="max-w-xl"
    >
      <div className="space-y-5 text-xs leading-relaxed text-[#c6cdd9]">
        <section className="space-y-1.5">
          <h3 className="text-sm font-semibold text-[#f3efe6] flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-[#d4a853]" />
            1. 中八球台、轮换开球与分花色
          </h3>
          <p>
            采用<strong className="text-[#f3efe6]">中式八球圆弧紧口袋口</strong>与开球区半圆 D 区标线，准度要求更高。多局对战（同屏、人机、联机）均采用<strong className="text-[#f3efe6]">双方严格轮换开球</strong>。开球需至少进一球或有至少 4 颗目标球碰库；开球后桌面保持<strong className="text-[#f3efe6]">未分花色</strong>，随后首位合法击进目标球的玩家确定归属：<strong className="text-[#f3efe6]">全色球 (1-7 号)</strong> 或 <strong className="text-[#f3efe6]">花色球 (9-15 号)</strong>。
          </p>
        </section>

        <section className="space-y-1.5 pt-3 border-t border-white/8">
          <h3 className="text-sm font-semibold text-[#f3efe6]">2. 犯规与自由球 (Ball-in-Hand)</h3>
          <ul className="list-disc pl-4 space-y-1">
            <li>白球落袋（洗袋）、空杆未碰任何球，或未先碰到己方花色目标球，均判犯规。</li>
            <li>撞击目标球后，若未进球且桌面无任何球碰库，同样判犯规。</li>
            <li>一方犯规后，对手获得<strong className="text-[#34d399]">全场自由球</strong>，可在桌面任意合法空白位置拖拽摆放白球（绿圈可放置，红圈重叠不可放）。</li>
          </ul>
        </section>

        <section className="space-y-1.5 pt-3 border-t border-white/8">
          <h3 className="text-sm font-semibold text-[#f3efe6]">3. 黑 8 胜负判定</h3>
          <ul className="list-disc pl-4 space-y-1">
            <li>清完己方全部 7 颗目标球后，合法将<strong className="text-[#f3efe6]">黑 8</strong> 打入袋中即获胜。</li>
            <li>己方球未清完时提前误打黑 8 进袋，或击打黑 8 时白球落袋/犯规，直接判负。</li>
            <li><strong className="text-[#f3efe6]">中八开球进黑 8：</strong>若开球合法进黑 8 且未犯规，黑 8 复位至置球点并继续击球；若开球进黑 8 同时白球洗袋或犯规，直接判负。</li>
          </ul>
        </section>

        <section className="space-y-1.5 pt-3 border-t border-white/8">
          <h3 className="text-sm font-semibold text-[#f3efe6]">4. 操控、加塞与联机规则</h3>
          <ul className="list-disc pl-4 space-y-1">
            <li><strong className="text-[#f3efe6]">瞄准与蓄力：</strong>台面拖动调整方向，下拉侧边力度杆或直接回拉球杆蓄力击球，右键或归零取消。</li>
            <li><strong className="text-[#f3efe6]">加塞微调：</strong>拖动右侧白球红点控制高杆跟进、低杆缩杆与左右塞反弹角度。</li>
            <li><strong className="text-[#f3efe6]">联机房间规则：</strong>在线对战时，新手辅助线、倒计时与台呢由房主统一设定并同步生效；自己练球或本地对战可随时自由调整。</li>
          </ul>
        </section>
      </div>
    </ModalShell>
  );
};

/* -------------------------------------------------------------------------- */
/* Game Over Summary Modal                                                    */
/* -------------------------------------------------------------------------- */

export const GameOverModal: React.FC<{
  winner: PlayerIndex;
  winReason: string;
  players: [PlayerInfo, PlayerInfo];
  nextBreakerName: string;
  nextRackNumber: number;
  isOnline: boolean;
  rematchPending: boolean;
  opponentRequestedRematch: boolean;
  onRematch: () => void;
  onOpenLobby: () => void;
}> = ({
  winner,
  winReason,
  players,
  nextBreakerName,
  nextRackNumber,
  isOnline,
  rematchPending,
  opponentRequestedRematch,
  onRematch,
  onOpenLobby,
}) => {
  const winPlayer = players[winner];

  return (
    <ModalShell
      title={`${winPlayer.name} 赢得本局！`}
      subtitle={winReason}
      canClose={false}
      maxWidth="max-w-lg"
    >
      <div className="space-y-5">
        <div className="flex items-center gap-3 px-4 py-3.5 rounded-xl bg-[#1a1f29] border border-[#d4a853]/35">
          <div className="w-10 h-10 rounded-xl bg-[#d4a853]/15 flex items-center justify-center shrink-0">
            <Trophy className="w-5 h-5 text-[#d4a853]" />
          </div>
          <div>
            <div className="text-sm font-semibold text-[#f3efe6]">{winPlayer.name} 获胜</div>
            <div className="text-xs text-[#9ea6b4] mt-0.5">{winReason}</div>
          </div>
        </div>

        {/* Clean Match Stats Table */}
        <div className="rounded-xl bg-[#101319] border border-white/8 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-white/8 text-[#8d96a6]">
                <th className="text-left font-medium px-4 py-2.5">统计项</th>
                <th className="text-right font-medium px-4 py-2.5 text-[#f3efe6]">{players[0].name}</th>
                <th className="text-right font-medium px-4 py-2.5 text-[#f3efe6]">{players[1].name}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/6 tabular-nums">
              <tr>
                <td className="px-4 py-2.5 text-[#9ea6b4]">合法进球数</td>
                <td className="px-4 py-2.5 text-right font-mono-num font-semibold text-[#f3efe6]">
                  {players[0].stats.potted}
                </td>
                <td className="px-4 py-2.5 text-right font-mono-num font-semibold text-[#f3efe6]">
                  {players[1].stats.potted}
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2.5 text-[#9ea6b4]">最长连进</td>
                <td className="px-4 py-2.5 text-right font-mono-num font-semibold text-[#d4a853]">
                  {players[0].stats.maxStreak}
                </td>
                <td className="px-4 py-2.5 text-right font-mono-num font-semibold text-[#d4a853]">
                  {players[1].stats.maxStreak}
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2.5 text-[#9ea6b4]">总击球次数</td>
                <td className="px-4 py-2.5 text-right font-mono-num text-[#d1d6df]">
                  {players[0].stats.shots}
                </td>
                <td className="px-4 py-2.5 text-right font-mono-num text-[#d1d6df]">
                  {players[1].stats.shots}
                </td>
              </tr>
              <tr>
                <td className="px-4 py-2.5 text-[#9ea6b4]">犯规次数</td>
                <td className="px-4 py-2.5 text-right font-mono-num text-[#fca5a5]">
                  {players[0].stats.fouls}
                </td>
                <td className="px-4 py-2.5 text-right font-mono-num text-[#fca5a5]">
                  {players[1].stats.fouls}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 pt-1">
          <div className="text-xs text-[#9ea6b4]">
            第 <span className="font-mono-num text-[#f3efe6]">{nextRackNumber}</span> 局轮换开球：
            <span className="font-semibold text-[#d4a853]">{nextBreakerName}</span>
          </div>
          <div className="flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onOpenLobby}
              className="px-4 py-2.5 rounded-lg bg-[#1d222d] hover:bg-[#272e3c] text-xs font-medium text-[#f3efe6] transition-colors cursor-pointer"
            >
              切换模式
            </button>
            <button
              type="button"
              disabled={isOnline && rematchPending}
              onClick={onRematch}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-[#d4a853] hover:bg-[#e1b866] disabled:opacity-60 text-[#111317] text-sm font-semibold transition-colors cursor-pointer"
            >
              <RefreshCw className="w-4 h-4" />
              {isOnline
                ? opponentRequestedRematch
                  ? '接受再来一局'
                  : rematchPending
                    ? '等待对手确认...'
                    : '再来一局'
                : '再来一局'}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
};
