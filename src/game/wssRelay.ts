/**
 * Zero-dependency browser MQTT 3.1.1 over WebSocket (WSS) client.
 * Used as an automatic pure-frontend TLS relay fallback whenever WebRTC P2P ICE
 * is blocked by VPNs, proxies, or symmetric NATs.
 */

const BROKER_URLS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
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
  onReady: () => void;
  onMessage: (topic: string, payload: string) => void;
  onError: (reason: string) => void;
}

export class WssRelayClient {
  private ws: WebSocket | null = null;
  private clientId: string;
  private subscribeTopic: string;
  private callbacks: WssRelayCallbacks;
  private brokerIndex = 0;
  private ready = false;
  private destroyed = false;
  private pingTimer: number | null = null;
  private connectTimer: number | null = null;
  private rxBuf = new Uint8Array(0);

  constructor(subscribeTopic: string, callbacks: WssRelayCallbacks) {
    this.clientId = `cue8_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
    this.subscribeTopic = subscribeTopic;
    this.callbacks = callbacks;
    this.tryConnectBroker(0);
  }

  public isReady(): boolean {
    return this.ready && this.ws?.readyState === WebSocket.OPEN;
  }

  private clearTimers(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private tryConnectBroker(idx: number): void {
    if (this.destroyed) return;
    if (idx >= BROKER_URLS.length) {
      this.callbacks.onError('所有公共中继通道暂时不可用');
      return;
    }

    this.brokerIndex = idx;
    this.ready = false;
    this.rxBuf = new Uint8Array(0);
    this.clearTimers();

    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
        this.ws.close();
      } catch {
        // noop
      }
      this.ws = null;
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(BROKER_URLS[idx], 'mqtt');
      ws.binaryType = 'arraybuffer';
    } catch {
      this.tryConnectBroker(idx + 1);
      return;
    }
    this.ws = ws;

    this.connectTimer = window.setTimeout(() => {
      if (!this.ready && !this.destroyed && this.ws === ws) {
        this.tryConnectBroker(this.brokerIndex + 1);
      }
    }, 4500);

    ws.onopen = () => {
      if (this.destroyed || this.ws !== ws) return;
      ws.send(buildConnectPacket(this.clientId));
    };

    ws.onmessage = (ev) => {
      if (this.destroyed || this.ws !== ws) return;
      if (!(ev.data instanceof ArrayBuffer)) return;
      const incoming = new Uint8Array(ev.data);
      this.appendAndParse(incoming);
    };

    ws.onerror = () => {
      if (this.destroyed || this.ws !== ws) return;
      if (!this.ready) {
        this.tryConnectBroker(this.brokerIndex + 1);
      }
    };

    ws.onclose = () => {
      if (this.destroyed || this.ws !== ws) return;
      this.clearTimers();
      if (!this.ready) {
        this.tryConnectBroker(this.brokerIndex + 1);
      } else {
        this.ready = false;
      }
    };
  }

  private appendAndParse(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.rxBuf.length + chunk.length);
    merged.set(this.rxBuf, 0);
    merged.set(chunk, this.rxBuf.length);
    this.rxBuf = merged;

    while (this.rxBuf.length >= 2) {
      const header = this.rxBuf[0];
      let multiplier = 1;
      let remLen = 0;
      let idx = 1;
      let hasFullVarInt = false;

      while (idx < this.rxBuf.length && idx <= 4) {
        const byte = this.rxBuf[idx++];
        remLen += (byte & 0x7f) * multiplier;
        if ((byte & 0x80) === 0) {
          hasFullVarInt = true;
          break;
        }
        multiplier *= 128;
      }

      if (!hasFullVarInt) return;
      const totalLen = idx + remLen;
      if (this.rxBuf.length < totalLen) return;

      const body = this.rxBuf.subarray(idx, totalLen);
      this.rxBuf = this.rxBuf.subarray(totalLen);
      this.handlePacket(header, body);
    }
  }

  private handlePacket(header: number, body: Uint8Array): void {
    const packetType = header & 0xf0;

    // CONNACK (0x20)
    if (packetType === 0x20) {
      if (body.length >= 2 && body[1] === 0x00 && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(buildSubscribePacket(1, this.subscribeTopic));
      } else {
        this.tryConnectBroker(this.brokerIndex + 1);
      }
      return;
    }

    // SUBACK (0x90)
    if (packetType === 0x90) {
      if (!this.ready) {
        this.ready = true;
        if (this.connectTimer !== null) {
          window.clearTimeout(this.connectTimer);
          this.connectTimer = null;
        }
        this.pingTimer = window.setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(new Uint8Array([0xc0, 0x00])); // PINGREQ
          }
        }, 18000);
        this.callbacks.onReady();
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
      this.callbacks.onMessage(topic, payload);
    }
  }

  public publish(topic: string, payloadStr: string): boolean {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(buildPublishPacket(topic, payloadStr));
      return true;
    } catch {
      return false;
    }
  }

  public destroy(): void {
    this.destroyed = true;
    this.ready = false;
    this.clearTimers();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        if (ws.readyState === WebSocket.OPEN) {
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
}
