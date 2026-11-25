/**
 * Zero-dependency browser MQTT 3.1.1 over WebSocket (WSS) multi-broker relay client.
 *
 * Connects to multiple public WSS brokers IN PARALLEL (including standard port 443)
 * so Host and Guest never get stranded on different brokers and always meet on the
 * fastest reachable shared broker. Also auto-reconnects if mobile browsers suspend
 * background tabs (e.g., while sharing an invite link in WeChat/QQ).
 */

const BROKER_URLS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://mqtt.eclipseprojects.io:443/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
];

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeVarInt(value: number): number[] {
  const bytes: number[] = [];
  let x = value;
  do {
    let b = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) b |= 0x80;
    bytes.push(b);
  } while (x > 0);
  return bytes;
}

function encodeMqttString(str: string): Uint8Array {
  const utf8 = textEncoder.encode(str);
  const out = new Uint8Array(2 + utf8.length);
  out[0] = (utf8.length >> 8) & 0xff;
  out[1] = utf8.length & 0xff;
  out.set(utf8, 2);
  return out;
}

function buildPacket(headerByte: number, bodyChunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let bodyLen = 0;
  for (const c of bodyChunks) bodyLen += c.length;
  const remLen = encodeVarInt(bodyLen);
  const packet = new Uint8Array(new ArrayBuffer(1 + remLen.length + bodyLen));
  packet[0] = headerByte;
  packet.set(remLen, 1);
  let offset = 1 + remLen.length;
  for (const c of bodyChunks) {
    packet.set(c, offset);
    offset += c.length;
  }
  return packet;
}

function buildConnectPacket(clientId: string): Uint8Array<ArrayBuffer> {
  const varHeader = new Uint8Array([
    0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, // "MQTT"
    0x04, // MQTT 3.1.1
    0x02, // Clean Session
    0x00, 0x1e, // Keep Alive = 30s
  ]);
  const clientIdBytes = encodeMqttString(clientId);
  return buildPacket(0x10, [varHeader, clientIdBytes]);
}

function buildSubscribePacket(packetId: number, topic: string): Uint8Array<ArrayBuffer> {
  const idBytes = new Uint8Array([(packetId >> 8) & 0xff, packetId & 0xff]);
  const topicBytes = encodeMqttString(topic);
  const qos = new Uint8Array([0x00]);
  return buildPacket(0x82, [idBytes, topicBytes, qos]);
}

function buildPublishPacket(topic: string, payloadStr: string): Uint8Array<ArrayBuffer> {
  const topicBytes = encodeMqttString(topic);
  const payloadBytes = textEncoder.encode(payloadStr);
  return buildPacket(0x30, [topicBytes, payloadBytes]);
}

export interface WssRelayCallbacks {
  onReady: (brokerIdx: number, readyCount: number) => void;
  onMessage: (topic: string, payload: string, brokerIdx: number) => void;
  onError: (reason: string) => void;
}

interface BrokerSlot {
  idx: number;
  url: string;
  clientId: string;
  ws: WebSocket | null;
  ready: boolean;
  rxBuf: Uint8Array;
  pingTimer: number | null;
  connectTimer: number | null;
  reconnectTimer: number | null;
  retryCount: number;
}

export class WssRelayClient {
  private slots: BrokerSlot[] = [];
  private subscribeTopic: string;
  private callbacks: WssRelayCallbacks;
  private lockedBrokerIdx: number | null = null;
  private destroyed = false;
  private anyReadyNotified = false;

  constructor(subscribeTopic: string, callbacks: WssRelayCallbacks) {
    this.subscribeTopic = subscribeTopic;
    this.callbacks = callbacks;

    const baseId = `cue8_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
    this.slots = BROKER_URLS.map((url, idx) => ({
      idx,
      url,
      clientId: `${baseId}_${idx}`,
      ws: null,
      ready: false,
      rxBuf: new Uint8Array(0),
      pingTimer: null,
      connectTimer: null,
      reconnectTimer: null,
      retryCount: 0,
    }));

    // Connect all public brokers in parallel so Host & Guest always share at least one fast path
    for (const slot of this.slots) {
      this.connectSlot(slot);
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityOrOnline);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleVisibilityOrOnline);
    }
  }

  private handleVisibilityOrOnline = (): void => {
    if (this.destroyed) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

    for (const slot of this.slots) {
      if (!this.isSlotWanted(slot.idx)) continue;
      if (!slot.ws || slot.ws.readyState === WebSocket.CLOSED || slot.ws.readyState === WebSocket.CLOSING) {
        slot.retryCount = 0;
        this.connectSlot(slot);
      }
    }
  };

  private isSlotWanted(idx: number): boolean {
    if (this.destroyed) return false;
    return this.lockedBrokerIdx === null || this.lockedBrokerIdx === idx;
  }

  public getReadyCount(): number {
    let count = 0;
    for (const slot of this.slots) {
      if (this.isSlotWanted(slot.idx) && slot.ready && slot.ws?.readyState === WebSocket.OPEN) {
        count += 1;
      }
    }
    return count;
  }

  public isReady(): boolean {
    if (this.lockedBrokerIdx !== null) {
      const s = this.slots[this.lockedBrokerIdx];
      return Boolean(s && s.ready && s.ws?.readyState === WebSocket.OPEN);
    }
    return this.getReadyCount() > 0;
  }

  /** Lock onto the single broker that succeeded in Host<->Guest handshake and close standby sockets */
  public lockBroker(brokerIdx: number): void {
    if (this.destroyed || brokerIdx < 0 || brokerIdx >= this.slots.length) return;
    this.lockedBrokerIdx = brokerIdx;
    for (const slot of this.slots) {
      if (slot.idx !== brokerIdx) {
        this.closeSlot(slot, false);
      }
    }
  }

  /** Re-open all standby brokers (used by Host when Guest leaves so rejoin works on any broker) */
  public unlockAllBrokers(): void {
    if (this.destroyed) return;
    this.lockedBrokerIdx = null;
    for (const slot of this.slots) {
      if (!slot.ws || slot.ws.readyState === WebSocket.CLOSED || slot.ws.readyState === WebSocket.CLOSING) {
        slot.retryCount = 0;
        this.connectSlot(slot);
      }
    }
  }

  private clearSlotTimers(slot: BrokerSlot): void {
    if (slot.pingTimer !== null) {
      window.clearInterval(slot.pingTimer);
      slot.pingTimer = null;
    }
    if (slot.connectTimer !== null) {
      window.clearTimeout(slot.connectTimer);
      slot.connectTimer = null;
    }
    if (slot.reconnectTimer !== null) {
      window.clearTimeout(slot.reconnectTimer);
      slot.reconnectTimer = null;
    }
  }

  private closeSlot(slot: BrokerSlot, sendDisconnect: boolean): void {
    this.clearSlotTimers(slot);
    slot.ready = false;
    slot.rxBuf = new Uint8Array(0);
    if (slot.ws) {
      const ws = slot.ws;
      slot.ws = null;
      try {
        if (sendDisconnect && ws.readyState === WebSocket.OPEN) {
          ws.send(new Uint8Array([0xe0, 0x00])); // DISCONNECT
        }
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
      } catch {
        // noop
      }
    }
  }

  private scheduleReconnect(slot: BrokerSlot): void {
    if (!this.isSlotWanted(slot.idx)) return;
    if (slot.reconnectTimer !== null) return;
    slot.retryCount += 1;
    // Fast first retry (1.4s), gentle backoff up to 6s so we never hammer public brokers
    const delayMs = Math.min(6000, 1400 * Math.min(slot.retryCount, 4));
    slot.reconnectTimer = window.setTimeout(() => {
      slot.reconnectTimer = null;
      if (this.isSlotWanted(slot.idx)) {
        this.connectSlot(slot);
      }
    }, delayMs);
  }

  private connectSlot(slot: BrokerSlot): void {
    if (!this.isSlotWanted(slot.idx)) return;
    this.closeSlot(slot, false);

    let ws: WebSocket;
    try {
      ws = new WebSocket(slot.url, 'mqtt');
      ws.binaryType = 'arraybuffer';
    } catch {
      this.scheduleReconnect(slot);
      return;
    }
    slot.ws = ws;

    slot.connectTimer = window.setTimeout(() => {
      if (!slot.ready && slot.ws === ws && this.isSlotWanted(slot.idx)) {
        this.closeSlot(slot, false);
        this.scheduleReconnect(slot);
      }
    }, 6500);

    ws.onopen = () => {
      if (!this.isSlotWanted(slot.idx) || slot.ws !== ws) return;
      try {
        ws.send(buildConnectPacket(slot.clientId));
      } catch {
        this.closeSlot(slot, false);
        this.scheduleReconnect(slot);
      }
    };

    ws.onmessage = (ev) => {
      if (!this.isSlotWanted(slot.idx) || slot.ws !== ws) return;
      if (!(ev.data instanceof ArrayBuffer)) return;
      this.appendAndParse(slot, new Uint8Array(ev.data));
    };

    ws.onerror = () => {
      if (slot.ws !== ws) return;
      // onclose will follow and trigger reconnect
    };

    ws.onclose = () => {
      if (slot.ws !== ws) return;
      slot.ws = null;
      slot.ready = false;
      this.clearSlotTimers(slot);
      if (this.isSlotWanted(slot.idx)) {
        this.scheduleReconnect(slot);
      }
    };
  }

  private appendAndParse(slot: BrokerSlot, chunk: Uint8Array): void {
    const merged = new Uint8Array(slot.rxBuf.length + chunk.length);
    merged.set(slot.rxBuf, 0);
    merged.set(chunk, slot.rxBuf.length);
    slot.rxBuf = merged;

    while (slot.rxBuf.length >= 2) {
      const header = slot.rxBuf[0];
      let multiplier = 1;
      let remLen = 0;
      let idx = 1;
      let hasFullVarInt = false;

      while (idx < slot.rxBuf.length && idx <= 4) {
        const byte = slot.rxBuf[idx++];
        remLen += (byte & 0x7f) * multiplier;
        if ((byte & 0x80) === 0) {
          hasFullVarInt = true;
          break;
        }
        multiplier *= 128;
      }

      if (!hasFullVarInt) return;
      const totalLen = idx + remLen;
      if (slot.rxBuf.length < totalLen) return;

      const body = slot.rxBuf.subarray(idx, totalLen);
      slot.rxBuf = slot.rxBuf.subarray(totalLen);
      this.handlePacket(slot, header, body);
    }
  }

  private handlePacket(slot: BrokerSlot, header: number, body: Uint8Array): void {
    const packetType = header & 0xf0;

    // CONNACK (0x20)
    if (packetType === 0x20) {
      if (body.length >= 2 && body[1] === 0x00 && slot.ws?.readyState === WebSocket.OPEN) {
        slot.ws.send(buildSubscribePacket(1, this.subscribeTopic));
      } else {
        this.closeSlot(slot, false);
        this.scheduleReconnect(slot);
      }
      return;
    }

    // SUBACK (0x90)
    if (packetType === 0x90) {
      if (!slot.ready) {
        slot.ready = true;
        slot.retryCount = 0;
        if (slot.connectTimer !== null) {
          window.clearTimeout(slot.connectTimer);
          slot.connectTimer = null;
        }
        slot.pingTimer = window.setInterval(() => {
          if (slot.ws?.readyState === WebSocket.OPEN) {
            try {
              slot.ws.send(new Uint8Array([0xc0, 0x00])); // PINGREQ
            } catch {
              // noop
            }
          }
        }, 16000);
        this.anyReadyNotified = true;
        this.callbacks.onReady(slot.idx, this.getReadyCount());
      }
      return;
    }

    // PUBLISH (0x30)
    if (packetType === 0x30) {
      if (body.length < 2) return;
      const topicLen = (body[0] << 8) | body[1];
      let pos = 2 + topicLen;
      if (pos > body.length) return;
      const topic = textDecoder.decode(body.subarray(2, pos));
      const qos = (header >> 1) & 0x03;
      if (qos > 0) pos += 2;
      if (pos > body.length) return;
      const payload = textDecoder.decode(body.subarray(pos));
      this.callbacks.onMessage(topic, payload, slot.idx);
    }
  }

  public publish(topic: string, payloadStr: string, preferredBrokerIdx?: number): boolean {
    if (this.destroyed) return false;
    const packet = buildPublishPacket(topic, payloadStr);

    // Send on specific broker if explicitly requested or already locked
    const targetIdx = preferredBrokerIdx ?? this.lockedBrokerIdx;
    if (targetIdx !== null && targetIdx !== undefined) {
      const slot = this.slots[targetIdx];
      if (!slot || !slot.ready || slot.ws?.readyState !== WebSocket.OPEN) return false;
      try {
        slot.ws.send(packet);
        return true;
      } catch {
        return false;
      }
    }

    // During pre-lock handshake, fan out to all ready brokers so Host & Guest meet on the fastest shared one
    let sentCount = 0;
    for (const slot of this.slots) {
      if (slot.ready && slot.ws?.readyState === WebSocket.OPEN) {
        try {
          slot.ws.send(packet);
          sentCount += 1;
        } catch {
          // noop
        }
      }
    }
    return sentCount > 0;
  }

  public hasEverConnected(): boolean {
    return this.anyReadyNotified;
  }

  public destroy(): void {
    this.destroyed = true;
    this.lockedBrokerIdx = null;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityOrOnline);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleVisibilityOrOnline);
    }
    for (const slot of this.slots) {
      this.closeSlot(slot, true);
    }
    this.slots = [];
  }
}
