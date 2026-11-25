import Peer, { type DataConnection } from 'peerjs';
import type { PeerConnectionStatus, PeerMessage } from './types';
import { WssRelayClient } from './wssRelay';

const PEER_PREFIX = 'cueclub8-';
const RELAY_PREFIX = 'cueclub8/v1/room/';
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
  }
  return code;
}

export function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

export function getRoomCodeFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const code = params.get('room');
  if (!code) return null;
  const cleaned = normalizeRoomCode(code);
  return cleaned.length === 6 ? cleaned : null;
}

export function buildShareLink(roomCode: string): string {
  if (typeof window === 'undefined') return '';
  const url = new URL(window.location.href);
  url.searchParams.set('room', roomCode);
  return url.toString();
}

export function clearRoomCodeFromUrl(): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (url.searchParams.has('room')) {
    url.searchParams.delete('room');
    window.history.replaceState({}, '', url.toString());
  }
}

export interface PeerManagerCallbacks {
  onStatusChange: (status: PeerConnectionStatus, detailText?: string) => void;
  onRoomCodeChange?: (code: string) => void;
  onMessage: (msg: PeerMessage) => void;
  onConnected: (isHost: boolean) => void;
  onDisconnected: () => void;
}

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.qq.com:3478' },
    { urls: 'stun:stun.miwifi.com:3478' },
  ],
  iceCandidatePoolSize: 4,
};

type RelayEnvelope =
  | { kind: 'join_req'; from: string }
  | { kind: 'join_ack'; from: string }
  | { kind: 'bye'; from: string }
  | { kind: 'ping'; from: string }
  | { kind: 'app'; from: string; payload: PeerMessage };

const WEBRTC_GRACE_MS = 2600; // If WebRTC P2P hasn't opened in 2.6s (VPN/NAT), auto-switch to WSS TLS relay!
const TOTAL_JOIN_TIMEOUT_MS = 16000;

export class PeerRoomManager {
  private peer: Peer | null = null;
  private conn: DataConnection | null = null;
  private relay: WssRelayClient | null = null;
  private activeTransport: 'none' | 'webrtc' | 'relay' = 'none';

  private isHost = false;
  private roomCode = '';
  private sessionId = '';
  private remoteSessionId = '';
  private callbacks: PeerManagerCallbacks;

  private joinTimer: number | null = null;
  private fallbackTimer: number | null = null;
  private handshakeTimer: number | null = null;
  private relayJoinRetryTimer: number | null = null;
  private relayHeartbeatTimer: number | null = null;
  private lastRelayActivity = 0;

  constructor(callbacks: PeerManagerCallbacks) {
    this.callbacks = callbacks;
  }

  public getRoomCode(): string {
    return this.roomCode;
  }

  public getIsHost(): boolean {
    return this.isHost;
  }

  public getTransport(): 'none' | 'webrtc' | 'relay' {
    return this.activeTransport;
  }

  public isConnected(): boolean {
    if (this.activeTransport === 'webrtc') {
      return Boolean(this.conn && this.conn.open);
    }
    if (this.activeTransport === 'relay') {
      return Boolean(this.relay && this.relay.isReady());
    }
    return false;
  }

  private getInboundTopic(): string {
    return `${RELAY_PREFIX}${this.roomCode}/${this.isHost ? 'to-host' : 'to-guest'}`;
  }

  private getOutboundTopic(): string {
    return `${RELAY_PREFIX}${this.roomCode}/${this.isHost ? 'to-guest' : 'to-host'}`;
  }

  private clearTimers(): void {
    if (this.joinTimer !== null) {
      window.clearTimeout(this.joinTimer);
      this.joinTimer = null;
    }
    if (this.fallbackTimer !== null) {
      window.clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.handshakeTimer !== null) {
      window.clearInterval(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    if (this.relayJoinRetryTimer !== null) {
      window.clearInterval(this.relayJoinRetryTimer);
      this.relayJoinRetryTimer = null;
    }
    if (this.relayHeartbeatTimer !== null) {
      window.clearInterval(this.relayHeartbeatTimer);
      this.relayHeartbeatTimer = null;
    }
  }

  public stopHandshakeRetry(): void {
    if (this.handshakeTimer !== null) {
      window.clearInterval(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  /** Periodic hello retries on guest until host sends start_game */
  public startGuestHandshakeRetry(getHelloPayload: () => PeerMessage): void {
    this.stopHandshakeRetry();
    let attempts = 0;
    this.send(getHelloPayload());
    this.handshakeTimer = window.setInterval(() => {
      attempts += 1;
      if (!this.isConnected() || attempts >= 6) {
        this.stopHandshakeRetry();
        return;
      }
      this.send(getHelloPayload());
    }, 900);
  }

  /** Host creates a room with BOTH PeerJS P2P and automatic WSS TLS relay standby */
  public createRoom(preferredCode?: string): string {
    this.destroy();
    this.isHost = true;
    this.roomCode = preferredCode ? normalizeRoomCode(preferredCode) : generateRoomCode();
    this.sessionId = `h_${Math.random().toString(36).slice(2, 10)}`;
    this.callbacks.onRoomCodeChange?.(this.roomCode);
    this.callbacks.onStatusChange('creating', '正在创建房间通道...');

    let announcedWaiting = false;
    const markWaiting = () => {
      if (announcedWaiting || this.activeTransport !== 'none') return;
      announcedWaiting = true;
      if (this.joinTimer !== null) {
        window.clearTimeout(this.joinTimer);
        this.joinTimer = null;
      }
      this.callbacks.onStatusChange('waiting', '房间已就绪，等待好友加入...');
    };

    // 1. Start WSS TLS Relay standby (ensures connection works even under VPN / Clash / Symmetric NAT)
    this.startRelayChannel(() => {
      markWaiting();
    });

    // 2. Start PeerJS WebRTC direct P2P listener
    const peerId = `${PEER_PREFIX}${this.roomCode}`;
    const peer = new Peer(peerId, {
      debug: 0,
      config: ICE_CONFIG,
      pingInterval: 5000,
    });
    this.peer = peer;

    this.joinTimer = window.setTimeout(() => {
      if (!announcedWaiting && this.activeTransport === 'none') {
        this.destroy();
        this.callbacks.onStatusChange('error', '房间创建超时，请检查网络连接后重试');
      }
    }, TOTAL_JOIN_TIMEOUT_MS);

    peer.on('open', () => {
      if (this.peer !== peer) return;
      markWaiting();
    });

    peer.on('connection', (incoming) => {
      if (this.peer !== peer) return;
      if (this.activeTransport !== 'none') {
        incoming.close();
        return;
      }
      this.callbacks.onStatusChange('waiting', '好友正在接入，建立直连通道...');
      this.attachWebRtcConnection(incoming);
    });

    peer.on('error', (err) => {
      if (this.peer !== peer) return;
      if (err.type === 'unavailable-id' && !announcedWaiting) {
        const fresh = generateRoomCode();
        this.createRoom(fresh);
        return;
      }
      // If PeerJS signaling errors while WSS Relay is ready, stay online silently via relay!
      if (!announcedWaiting && !this.relay?.isReady()) {
        this.clearTimers();
        this.callbacks.onStatusChange('error', this.formatPeerError(err.type));
      }
    });

    return this.roomCode;
  }

  /** Guest joins room: tries WebRTC P2P first, seamlessly falls back to WSS TLS relay after 3.2s */
  public joinRoom(code: string): void {
    const cleaned = normalizeRoomCode(code);
    if (cleaned.length !== 6) {
      this.callbacks.onStatusChange('error', '请输入完整的 6 位房间号');
      return;
    }

    this.destroy();
    this.isHost = false;
    this.roomCode = cleaned;
    this.sessionId = `g_${Math.random().toString(36).slice(2, 10)}`;
    this.callbacks.onRoomCodeChange?.(cleaned);
    this.callbacks.onStatusChange('joining', '正在寻找房主并建立连接...');

    let relayFallbackTriggered = false;

    const triggerRelayFallback = () => {
      if (relayFallbackTriggered || this.activeTransport !== 'none') return;
      relayFallbackTriggered = true;
      this.callbacks.onStatusChange('joining', '直连受限，自动切换加密中继通道...');

      const sendJoinReq = () => {
        if (this.activeTransport !== 'none') return;
        this.publishRelay({ kind: 'join_req', from: this.sessionId });
      };

      if (this.relay?.isReady()) {
        sendJoinReq();
      }
      this.relayJoinRetryTimer = window.setInterval(() => {
        if (this.activeTransport !== 'none') {
          if (this.relayJoinRetryTimer !== null) {
            window.clearInterval(this.relayJoinRetryTimer);
            this.relayJoinRetryTimer = null;
          }
          return;
        }
        sendJoinReq();
      }, 1200);
    };

    // 1. Pre-warm WSS TLS relay socket immediately so fallback is instantaneous
    this.startRelayChannel(() => {
      if (relayFallbackTriggered && this.activeTransport === 'none') {
        this.publishRelay({ kind: 'join_req', from: this.sessionId });
      }
    });

    // 2. Attempt direct PeerJS WebRTC P2P first
    const peer = new Peer({
      debug: 0,
      config: ICE_CONFIG,
      pingInterval: 5000,
    });
    this.peer = peer;

    peer.on('open', () => {
      if (this.peer !== peer || this.activeTransport !== 'none') return;
      const targetId = `${PEER_PREFIX}${cleaned}`;
      const conn = peer.connect(targetId, {
        reliable: true,
        serialization: 'json',
      });
      this.attachWebRtcConnection(conn);
    });

    peer.on('error', () => {
      if (this.peer !== peer || this.activeTransport !== 'none') return;
      // Immediately switch to WSS relay instead of failing!
      triggerRelayFallback();
    });

    // 3. If WebRTC doesn't open within 3.2s (e.g. VPN / Clash / Symmetric NAT), auto-fallback to WSS relay!
    this.fallbackTimer = window.setTimeout(() => {
      if (this.activeTransport === 'none') {
        triggerRelayFallback();
      }
    }, WEBRTC_GRACE_MS);

    // 4. Overall hard timeout (16s) if room genuinely does not exist or host closed page
    this.joinTimer = window.setTimeout(() => {
      if (this.activeTransport === 'none') {
        this.destroy();
        this.callbacks.onStatusChange(
          'error',
          '连接房主超时：请确认 6 位房间号无误，且房主仍保持房间页面开启',
        );
      }
    }, TOTAL_JOIN_TIMEOUT_MS);
  }

  private startRelayChannel(onReady: () => void): void {
    const relay = new WssRelayClient(this.getInboundTopic(), {
      onReady: () => {
        if (this.relay !== relay) return;
        onReady();
      },
      onMessage: (_topic, payload) => {
        if (this.relay !== relay) return;
        this.handleRelayPayload(payload);
      },
      onError: () => {
        // PeerJS may still succeed even if relay fails
      },
    });
    this.relay = relay;
  }

  private publishRelay(env: RelayEnvelope): void {
    if (!this.relay) return;
    this.relay.publish(this.getOutboundTopic(), JSON.stringify(env));
  }

  private handleRelayPayload(raw: string): void {
    let env: RelayEnvelope;
    try {
      env = JSON.parse(raw) as RelayEnvelope;
    } catch {
      return;
    }
    if (!env || typeof env !== 'object' || env.from === this.sessionId) return;

    this.lastRelayActivity = Date.now();

    // Host receives guest relay join request -> lock relay transport & ack!
    if (env.kind === 'join_req' && this.isHost) {
      if (this.activeTransport === 'none' || (this.activeTransport === 'relay' && this.remoteSessionId === env.from)) {
        const isFirstLock = this.activeTransport === 'none';
        this.remoteSessionId = env.from;
        this.publishRelay({ kind: 'join_ack', from: this.sessionId });
        if (isFirstLock) {
          this.lockTransport('relay');
        }
      }
      return;
    }

    // Guest receives host relay ack -> lock relay transport!
    if (env.kind === 'join_ack' && !this.isHost) {
      if (this.activeTransport === 'none') {
        this.remoteSessionId = env.from;
        this.lockTransport('relay');
      }
      return;
    }

    if (this.activeTransport !== 'relay') return;

    if (env.kind === 'bye') {
      this.clearTimers();
      this.activeTransport = 'none';
      this.callbacks.onStatusChange('disconnected', '对手已离开房间');
      this.callbacks.onDisconnected();
      return;
    }

    if (env.kind === 'ping') {
      return;
    }

    if (env.kind === 'app' && env.payload) {
      this.callbacks.onMessage(env.payload);
    }
  }

  private attachWebRtcConnection(conn: DataConnection): void {
    this.conn = conn;

    const handleOpen = () => {
      if (this.conn !== conn || this.activeTransport !== 'none') return;
      this.lockTransport('webrtc');
    };

    conn.on('open', handleOpen);
    if (conn.open) {
      handleOpen();
    }

    conn.on('data', (raw) => {
      if (this.activeTransport !== 'webrtc' || this.conn !== conn) return;
      if (raw && typeof raw === 'object' && 'type' in raw) {
        this.callbacks.onMessage(raw as PeerMessage);
      }
    });

    conn.on('close', () => {
      if (this.activeTransport !== 'webrtc' || this.conn !== conn) return;
      this.clearTimers();
      this.activeTransport = 'none';
      this.conn = null;
      // Keep Host room open for guest rejoin over either WebRTC or WSS relay
      if (this.isHost && this.roomCode && !this.relay) {
        this.startRelayChannel(() => {
          // Relay standby re-armed for rejoin
        });
      }
      this.callbacks.onStatusChange('disconnected', '对手已离开房间（输入原房号可重连）');
      this.callbacks.onDisconnected();
    });

    conn.on('error', () => {
      if (this.activeTransport === 'webrtc' && this.conn === conn) {
        this.clearTimers();
        this.activeTransport = 'none';
        this.callbacks.onStatusChange('error', '点对点数据传输中断，请重试');
      }
    });
  }

  private lockTransport(mode: 'webrtc' | 'relay'): void {
    if (this.activeTransport !== 'none') return;
    this.activeTransport = mode;

    if (this.joinTimer !== null) {
      window.clearTimeout(this.joinTimer);
      this.joinTimer = null;
    }
    if (this.fallbackTimer !== null) {
      window.clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.relayJoinRetryTimer !== null) {
      window.clearInterval(this.relayJoinRetryTimer);
      this.relayJoinRetryTimer = null;
    }

    if (mode === 'webrtc') {
      // Direct WebRTC succeeded — close unused relay socket
      if (this.relay) {
        this.relay.destroy();
        this.relay = null;
      }
    } else {
      // WSS Relay succeeded — close unused PeerJS instance and start lightweight heartbeat
      if (this.conn) {
        try {
          this.conn.close();
        } catch {
          // noop
        }
        this.conn = null;
      }
      if (this.peer) {
        try {
          this.peer.destroy();
        } catch {
          // noop
        }
        this.peer = null;
      }

      this.lastRelayActivity = Date.now();
      this.relayHeartbeatTimer = window.setInterval(() => {
        if (this.activeTransport !== 'relay') return;
        this.publishRelay({ kind: 'ping', from: this.sessionId });
        if (Date.now() - this.lastRelayActivity > 18000) {
          this.clearTimers();
          this.activeTransport = 'none';
          this.callbacks.onStatusChange('disconnected', '对手连接已超时断开');
          this.callbacks.onDisconnected();
        }
      }, 4500);
    }

    this.callbacks.onStatusChange('connected');
    this.callbacks.onConnected(this.isHost);
  }

  public send(msg: PeerMessage): void {
    if (this.activeTransport === 'webrtc' && this.conn && this.conn.open) {
      try {
        this.conn.send(msg);
      } catch {
        // noop
      }
      return;
    }

    if (this.activeTransport === 'relay' && this.relay?.isReady()) {
      this.publishRelay({ kind: 'app', from: this.sessionId, payload: msg });
    }
  }

  public destroy(): void {
    if (this.activeTransport === 'relay' && this.relay?.isReady()) {
      this.publishRelay({ kind: 'bye', from: this.sessionId });
    }
    this.clearTimers();
    this.activeTransport = 'none';
    this.remoteSessionId = '';

    if (this.conn) {
      const c = this.conn;
      this.conn = null;
      try {
        c.close();
      } catch {
        // noop
      }
    }
    if (this.peer) {
      const p = this.peer;
      this.peer = null;
      try {
        p.destroy();
      } catch {
        // noop
      }
    }
    if (this.relay) {
      const r = this.relay;
      this.relay = null;
      r.destroy();
    }
  }

  private formatPeerError(type: string): string {
    switch (type) {
      case 'peer-unavailable':
        return '未找到该房间，请确认 6 位房间号是否正确且房主仍停留在房间内';
      case 'network':
        return '网络连接异常，无法连接信令服务';
      case 'server-error':
        return '信令服务器暂时不可用，请稍后重试';
      case 'browser-incompatible':
        return '当前浏览器不支持联机通信';
      default:
        return '联机连接失败，请检查网络后重试';
    }
  }
}
