// Procedural Web Audio API billiard acoustics + funny colloquial Chinese
// voice-actor callout engine ONLY for break-and-pot (开球有下) & streaks (2+ 连杆).

type VoiceClipId =
  | 'break_pot'
  | 'streak_2'
  | 'streak_3'
  | 'streak_4'
  | 'streak_5'
  | 'streak_6';

const VOICE_CACHE_QUERY = 'v=2';

const VOICE_FALLBACK_TEXT: Record<VoiceClipId, string> = {
  break_pot: '哎哟喂，开球有下！今天这手气，稳了！',
  streak_2: '两杆连进！哎哟，有点东西啊你小子！',
  streak_3: '三连杆啦！这手感烫手啊，对面赶紧擦擦汗！',
  streak_4: '四连杆！对面别站着了，搬个小板凳慢慢看吧！',
  streak_5: '五连杆！离谱！你往袋口偷偷装吸铁石了吧！',
  streak_6: '天呐彻底杀疯了！快叫老板结账，这台子归你了！',
};

// Gently pre-warm only the 2 most common callouts on unlock; higher streaks load on-demand
const PRELOAD_ORDER: VoiceClipId[] = ['break_pot', 'streak_2'];

class SoundEngine {
  private ctx: AudioContext | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private voiceBusInput: GainNode | null = null;
  private muted = false;

  // Acoustic rate limiters
  private lastBallClackTime = 0;
  private lastRailThudTime = 0;

  // Decoded studio voice-actor WAV cache & playback state
  private voiceBuffers = new Map<VoiceClipId, AudioBuffer>();
  private voiceFetching = new Map<VoiceClipId, Promise<AudioBuffer | null>>();
  private voiceApiAvailable = true;
  private voiceRateLimitUntilMs = 0;
  private preloadStarted = false;

  private activeVoiceSource: AudioBufferSourceNode | null = null;
  private activeVoiceGain: GainNode | null = null;
  private activeVoicePriority = 0;
  private activeVoiceEndTime = 0;

  private ensureContext(): AudioContext | null {
    if (this.muted) return null;
    if (typeof window === 'undefined') return null;

    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();
      this.setupVoiceMasteringBus(this.ctx);
    }

    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    if (!this.noiseBuffer && this.ctx) {
      const sampleRate = this.ctx.sampleRate;
      const length = Math.floor(sampleRate * 0.28);
      const buffer = this.ctx.createBuffer(1, length, sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      this.noiseBuffer = buffer;
    }

    return this.ctx;
  }

  /** Build warm cinematic mastering chain (EQ + subtle hall reverb + compressor) for voice clips */
  private setupVoiceMasteringBus(ctx: AudioContext): void {
    const input = ctx.createGain();
    input.gain.value = 1.15;

    // Warm chest resonance low-shelf
    const lowShelf = ctx.createBiquadFilter();
    lowShelf.type = 'lowshelf';
    lowShelf.frequency.value = 165;
    lowShelf.gain.value = 2.4;

    // Crisp vocal presence peak
    const presence = ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 2850;
    presence.Q.value = 1.1;
    presence.gain.value = 3.2;

    // Dynamics compressor for authoritative punch
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.knee.value = 12;
    compressor.ratio.value = 3.5;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.14;

    // Dry path
    const dryGain = ctx.createGain();
    dryGain.gain.value = 0.94;

    // Subtle epic hall reverb impulse (0.58s warm decay)
    const sampleRate = ctx.sampleRate;
    const irLen = Math.floor(sampleRate * 0.58);
    const irBuffer = ctx.createBuffer(2, irLen, sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = irBuffer.getChannelData(ch);
      for (let i = 0; i < irLen; i++) {
        const t = i / irLen;
        const env = Math.pow(1 - t, 2.8);
        data[i] = (Math.random() * 2 - 1) * env * 0.5;
      }
    }
    const convolver = ctx.createConvolver();
    convolver.buffer = irBuffer;

    const wetFilter = ctx.createBiquadFilter();
    wetFilter.type = 'lowpass';
    wetFilter.frequency.value = 2200;

    const wetGain = ctx.createGain();
    wetGain.gain.value = 0.18;

    input.connect(lowShelf);
    lowShelf.connect(presence);
    presence.connect(compressor);

    compressor.connect(dryGain);
    dryGain.connect(ctx.destination);

    compressor.connect(convolver);
    convolver.connect(wetFilter);
    wetFilter.connect(wetGain);
    wetGain.connect(ctx.destination);

    this.voiceBusInput = input;
  }

  public unlock(): void {
    this.ensureContext();
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        window.speechSynthesis.getVoices();
      } catch {
        // noop
      }
    }
    if (!this.preloadStarted && !this.muted) {
      this.preloadStarted = true;
      void this.preloadVoicePack();
    }
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      this.stopActiveVoice();
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        try {
          window.speechSynthesis.cancel();
        } catch {
          // noop
        }
      }
    } else if (!this.preloadStarted) {
      this.preloadStarted = true;
      void this.preloadVoicePack();
    }
  }

  public isMuted(): boolean {
    return this.muted;
  }

  /** Fetch & decode a single studio voice-actor WAV from /api/voice/:clipId */
  private async fetchVoiceBuffer(clipId: VoiceClipId): Promise<AudioBuffer | null> {
    if (!this.voiceApiAvailable || typeof fetch === 'undefined') return null;

    const cached = this.voiceBuffers.get(clipId);
    if (cached) return cached;

    if (Date.now() < this.voiceRateLimitUntilMs) return null;

    const existing = this.voiceFetching.get(clipId);
    if (existing) return existing;

    const task = (async () => {
      try {
        const res = await fetch(`/api/voice/${clipId}?${VOICE_CACHE_QUERY}`);
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('Retry-After')) || 35;
          this.voiceRateLimitUntilMs = Date.now() + retryAfter * 1000;
          return null;
        }
        if (!res.ok) {
          // On static-only hosts (404) or missing key (503), stop hammering endpoint
          if (res.status === 404 || res.status === 503) {
            this.voiceApiAvailable = false;
          }
          return null;
        }
        const contentType = res.headers.get('content-type') ?? '';
        if (!contentType.includes('audio')) {
          this.voiceApiAvailable = false;
          return null;
        }
        const arrayBuf = await res.arrayBuffer();
        const ctx = this.ensureContext();
        if (!ctx) return null;
        const decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
        this.voiceBuffers.set(clipId, decoded);
        return decoded;
      } catch {
        return null;
      } finally {
        this.voiceFetching.delete(clipId);
      }
    })();

    this.voiceFetching.set(clipId, task);
    return task;
  }

  /** Quietly pre-warm the 3 flagship voice clips one-by-one with gentle pacing */
  private async preloadVoicePack(): Promise<void> {
    for (const clipId of PRELOAD_ORDER) {
      if (!this.voiceApiAvailable || this.muted) return;
      if (Date.now() < this.voiceRateLimitUntilMs) return;
      await this.fetchVoiceBuffer(clipId);
      await new Promise((resolve) => window.setTimeout(resolve, 600));
    }
  }

  private stopActiveVoice(): void {
    if (this.activeVoiceSource && this.activeVoiceGain && this.ctx) {
      try {
        const now = this.ctx.currentTime;
        this.activeVoiceGain.gain.cancelScheduledValues(now);
        this.activeVoiceGain.gain.setValueAtTime(
          Math.max(0.001, this.activeVoiceGain.gain.value),
          now,
        );
        this.activeVoiceGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.025);
        this.activeVoiceSource.stop(now + 0.03);
      } catch {
        // noop
      }
    }
    this.activeVoiceSource = null;
    this.activeVoiceGain = null;
    this.activeVoicePriority = 0;
    this.activeVoiceEndTime = 0;
  }

  /** Fallback deep browser TTS only if /api/voice/:clipId is unavailable (e.g. static-only hosting) */
  private speakFallbackTTS(text: string, delayMs: number): void {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.setTimeout(() => {
      if (this.muted) return;
      try {
        const synth = window.speechSynthesis;
        synth.cancel();
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = 'zh-CN';
        utter.rate = 0.94;
        utter.pitch = 0.78;
        utter.volume = 1.0;
        const voices = synth.getVoices();
        const zhVoices = voices.filter((v) => v.lang.toLowerCase().startsWith('zh'));
        const preferred =
          zhVoices.find((v) =>
            /yunjian|yunyang|yunxi|kangkang|danny|li-mu|sinji|male|男/i.test(v.name),
          ) ??
          zhVoices.find((v) => /google 普通话|tingting|xiaoxiao/i.test(v.name)) ??
          zhVoices.find((v) => v.lang.toLowerCase().includes('cn')) ??
          zhVoices[0];
        if (preferred) utter.voice = preferred;
        synth.speak(utter);
      } catch {
        // noop
      }
    }, delayMs);
  }

  /**
   * Play a studio-mastered Three Kingdoms voice-actor clip with priority management.
   * Higher-priority callouts (streaks / pots / win) cleanly fade out lower-priority ones
   * (strike / rail), while lower-priority cues never interrupt an active announcement.
   */
  private playVoiceClip(clipId: VoiceClipId, priority: number, delayMs = 0): void {
    if (this.muted) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const nowMs = performance.now();
    // Do not interrupt a currently playing equal-or-higher priority voice line
    if (nowMs < this.activeVoiceEndTime && priority < this.activeVoicePriority) {
      return;
    }

    const playDecoded = (buf: AudioBuffer) => {
      if (this.muted || !this.ctx || !this.voiceBusInput) return;
      const curNowMs = performance.now();
      if (curNowMs < this.activeVoiceEndTime && priority < this.activeVoicePriority) {
        return;
      }

      this.stopActiveVoice();
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        try {
          window.speechSynthesis.cancel();
        } catch {
          // noop
        }
      }

      const startAt = this.ctx.currentTime + Math.max(0, delayMs) / 1000;
      const src = this.ctx.createBufferSource();
      src.buffer = buf;

      const g = this.ctx.createGain();
      g.gain.setValueAtTime(1.0, startAt);

      src.connect(g);
      g.connect(this.voiceBusInput);
      src.start(startAt);

      this.activeVoiceSource = src;
      this.activeVoiceGain = g;
      this.activeVoicePriority = priority;
      this.activeVoiceEndTime = curNowMs + delayMs + buf.duration * 1000;

      src.onended = () => {
        if (this.activeVoiceSource === src) {
          this.activeVoiceSource = null;
          this.activeVoiceGain = null;
          this.activeVoicePriority = 0;
          this.activeVoiceEndTime = 0;
        }
      };
    };

    const cached = this.voiceBuffers.get(clipId);
    if (cached) {
      playDecoded(cached);
      return;
    }

    if (!this.voiceApiAvailable) {
      if (priority >= 3) {
        this.speakFallbackTTS(VOICE_FALLBACK_TEXT[clipId], delayMs);
      }
      return;
    }

    // On-demand fetch for first-ever trigger if preload hasn't reached this clip yet
    const requestedAt = performance.now();
    void this.fetchVoiceBuffer(clipId).then((buf) => {
      if (buf && performance.now() - requestedAt < 2600) {
        playDecoded(buf);
      } else if (!buf && priority >= 3) {
        this.speakFallbackTTS(VOICE_FALLBACK_TEXT[clipId], 40);
      }
    });
  }

  /** Crisp cue tip strike on cue ball (pure acoustics, no voice callout) */
  public playCueStrike(power: number, _isBreak = false): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const intensity = Math.max(0.15, Math.min(1, power));

    // Leather tip thwack (low-mid sine sweep)
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(280 + intensity * 190, now);
    osc.frequency.exponentialRampToValueAtTime(95, now + 0.045);

    oscGain.gain.setValueAtTime(0.0001, now);
    oscGain.gain.linearRampToValueAtTime(0.32 * intensity, now + 0.002);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.055);

    osc.connect(oscGain);
    oscGain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.06);

    // Subtle chalk crisp transient
    if (this.noiseBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(1900 + intensity * 900, now);
      filter.Q.setValueAtTime(2.8, now);

      const nGain = ctx.createGain();
      nGain.gain.setValueAtTime(0.24 * intensity, now);
      nGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.032);

      src.connect(filter);
      filter.connect(nGain);
      nGain.connect(ctx.destination);
      src.start(now);
      src.stop(now + 0.038);
    }
  }

  /** Authentic phenolic resin ball-to-ball clack */
  public playBallCollision(impactSpeed: number): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    // Rate-limit dense break clusters slightly to avoid harsh distortion
    if (now - this.lastBallClackTime < 0.012) return;
    this.lastBallClackTime = now;

    const norm = Math.min(1, Math.max(0.04, impactSpeed / 900));
    const gainLevel = Math.pow(norm, 0.78) * 0.45;
    if (gainLevel < 0.012) return;

    // Primary phenolic click harmonics
    const pitchJitter = 0.96 + Math.random() * 0.08;
    const baseFreq = (2450 + norm * 650) * pitchJitter;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const g = ctx.createGain();

    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(baseFreq, now);
    osc1.frequency.exponentialRampToValueAtTime(baseFreq * 0.68, now + 0.018);

    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(baseFreq * 1.62, now);
    osc2.frequency.exponentialRampToValueAtTime(baseFreq * 1.15, now + 0.014);

    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(gainLevel, now + 0.0012);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.026);

    osc1.connect(g);
    osc2.connect(g);
    g.connect(ctx.destination);

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + 0.03);
    osc2.stop(now + 0.03);

    // Sharp broadband contact impulse
    if (this.noiseBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;

      const hp = ctx.createBiquadFilter();
      hp.type = 'bandpass';
      hp.frequency.setValueAtTime(3400 * pitchJitter, now);
      hp.Q.setValueAtTime(1.6, now);

      const nGain = ctx.createGain();
      nGain.gain.setValueAtTime(gainLevel * 0.65, now);
      nGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.015);

      src.connect(hp);
      hp.connect(nGain);
      nGain.connect(ctx.destination);
      src.start(now);
      src.stop(now + 0.02);
    }
  }

  /** Muffled rubber cushion thud + dramatic Three Kingdoms voice on heavy rail rebound */
  public playRailHit(impactSpeed: number): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    if (now - this.lastRailThudTime < 0.025) return;
    this.lastRailThudTime = now;

    const norm = Math.min(1, Math.max(0.05, impactSpeed / 700));
    const gainLevel = Math.pow(norm, 0.85) * 0.34;
    if (gainLevel < 0.01) return;

    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const g = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(145 + norm * 55, now);
    osc.frequency.exponentialRampToValueAtTime(58, now + 0.075);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(320, now);

    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(gainLevel, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.085);

    osc.connect(filter);
    filter.connect(g);
    g.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.09);
  }

  /** Satisfying pocket leather cup drop */
  public playPocketDrop(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    // Double muffled drop rattle
    [0, 0.075].forEach((offset, idx) => {
      const t = now + offset;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      const startF = idx === 0 ? 190 : 140;
      osc.frequency.setValueAtTime(startF, t);
      osc.frequency.exponentialRampToValueAtTime(62, t + 0.09);

      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(idx === 0 ? 0.24 : 0.16, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);

      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.12);
    });

    if (this.noiseBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(650, now);

      const nGain = ctx.createGain();
      nGain.gain.setValueAtTime(0.14, now);
      nGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);

      src.connect(lp);
      lp.connect(nGain);
      nGain.connect(ctx.destination);
      src.start(now);
      src.stop(now + 0.14);
    }
  }

  /** Break-and-pot celebration ("开球有下"): drum + guzheng flourish + funny voice callout */
  public playBreakPotCallout(): {
    clipId: VoiceClipId;
    badge: string;
    title: string;
    speech: string;
    subtitle: string;
  } {
    const line = {
      clipId: 'break_pot' as VoiceClipId,
      badge: '开球有下',
      title: '开球有下 · 手气稳了',
      speech: VOICE_FALLBACK_TEXT.break_pot,
      subtitle: '开门见喜',
    };
    if (this.muted) return line;

    const ctx = this.ensureContext();
    if (ctx) {
      const now = ctx.currentTime;
      this.triggerWarDrum(ctx, now, 0.36);
      this.triggerGuzhengFlourish(ctx, now + 0.03, [293.66, 392.0, 440.0, 587.33]);
    }
    this.playVoiceClip('break_pot', 3, 70);
    return line;
  }

  /** Subtle low double tone on foul (pure acoustics, no voice callout) */
  public playFoul(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    [220, 175].forEach((freq, i) => {
      const t = now + i * 0.11;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.14, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.18);
    });
  }

  /** Celebratory ascending victory chord (pure acoustics) */
  public playWin(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      const t = now + i * 0.085;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.15, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.45);
    });
  }

  /** Pick funny colloquial Chinese billiard-hall streak title & clip ID */
  public pickStreakLine(streakCount: number): {
    clipId: VoiceClipId;
    badge: string;
    title: string;
    speech: string;
    subtitle: string;
  } {
    if (streakCount <= 2) {
      return {
        clipId: 'streak_2',
        badge: '二连杆',
        title: '两杆连进 · 有点东西',
        speech: VOICE_FALLBACK_TEXT.streak_2,
        subtitle: '有点东西',
      };
    }
    if (streakCount === 3) {
      return {
        clipId: 'streak_3',
        badge: '三连杆',
        title: '三连杆 · 手感烫手了',
        speech: VOICE_FALLBACK_TEXT.streak_3,
        subtitle: '手感烫手',
      };
    }
    if (streakCount === 4) {
      return {
        clipId: 'streak_4',
        badge: '四连杆',
        title: '四连杆 · 搬板凳看表演',
        speech: VOICE_FALLBACK_TEXT.streak_4,
        subtitle: '搬板凳看戏',
      };
    }
    if (streakCount === 5) {
      return {
        clipId: 'streak_5',
        badge: '五连杆',
        title: '五连杆 · 袋口装磁铁了',
        speech: VOICE_FALLBACK_TEXT.streak_5,
        subtitle: '装吸铁石了',
      };
    }
    return {
      clipId: 'streak_6',
      badge: '杀疯了',
      title: '彻底杀疯 · 叫老板结账',
      speech: VOICE_FALLBACK_TEXT.streak_6,
      subtitle: '彻底杀疯',
    };
  }

  /** Synthesize a single deep Chinese war drum (堂鼓/战鼓) strike */
  private triggerWarDrum(ctx: AudioContext, startTime: number, gainPeak: number): void {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(142, startTime);
    osc.frequency.exponentialRampToValueAtTime(48, startTime + 0.16);
    osc.frequency.exponentialRampToValueAtTime(38, startTime + 0.36);

    g.gain.setValueAtTime(0.0001, startTime);
    g.gain.linearRampToValueAtTime(gainPeak, startTime + 0.006);
    g.gain.exponentialRampToValueAtTime(gainPeak * 0.35, startTime + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.42);

    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + 0.45);

    const body2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    body2.type = 'triangle';
    body2.frequency.setValueAtTime(215, startTime);
    body2.frequency.exponentialRampToValueAtTime(86, startTime + 0.09);
    g2.gain.setValueAtTime(0.0001, startTime);
    g2.gain.linearRampToValueAtTime(gainPeak * 0.42, startTime + 0.004);
    g2.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.14);
    body2.connect(g2);
    g2.connect(ctx.destination);
    body2.start(startTime);
    body2.stop(startTime + 0.16);

    if (this.noiseBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(460, startTime);
      bp.Q.setValueAtTime(1.1, startTime);
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(gainPeak * 0.55, startTime);
      ng.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.048);
      src.connect(bp);
      bp.connect(ng);
      ng.connect(ctx.destination);
      src.start(startTime);
      src.stop(startTime + 0.055);
    }
  }

  /** Synthesize metallic blade unsheathe slash (刀剑出鞘「锵！」) */
  private triggerSwordSlash(ctx: AudioContext, startTime: number, intensity: number): void {
    if (this.noiseBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(2100, startTime);
      bp.frequency.exponentialRampToValueAtTime(6400, startTime + 0.18);
      bp.Q.setValueAtTime(4.5, startTime);

      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, startTime);
      ng.gain.linearRampToValueAtTime(0.16 * intensity, startTime + 0.025);
      ng.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.24);

      src.connect(bp);
      bp.connect(ng);
      ng.connect(ctx.destination);
      src.start(startTime);
      src.stop(startTime + 0.25);
    }

    [2960, 4420].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.985, startTime + 0.34);
      g.gain.setValueAtTime(0.0001, startTime);
      g.gain.linearRampToValueAtTime((i === 0 ? 0.055 : 0.032) * intensity, startTime + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.36);
      osc.connect(g);
      g.connect(ctx.destination);
      osc.start(startTime);
      osc.stop(startTime + 0.38);
    });
  }

  /** Synthesize resonant bronze gong / battle chime wash (古风铜锣余韵) */
  private triggerBronzeGong(
    ctx: AudioContext,
    startTime: number,
    fundamental: number,
    gainPeak: number,
  ): void {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1550, startTime);
    lp.frequency.exponentialRampToValueAtTime(380, startTime + 1.05);
    lp.connect(ctx.destination);

    const partials: Array<[number, number]> = [
      [1.0, 0.55],
      [1.51, 0.32],
      [2.03, 0.2],
      [2.76, 0.12],
    ];
    partials.forEach(([ratio, weight]) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(fundamental * ratio, startTime);
      g.gain.setValueAtTime(0.0001, startTime);
      g.gain.linearRampToValueAtTime(gainPeak * weight, startTime + 0.025);
      g.gain.exponentialRampToValueAtTime(0.0001, startTime + 1.15);
      osc.connect(g);
      g.connect(lp);
      osc.start(startTime);
      osc.stop(startTime + 1.2);
    });
  }

  /** Synthesize warm Chinese pentatonic guzheng pluck glissando (古筝五声音阶扫弦) */
  private triggerGuzhengFlourish(ctx: AudioContext, startTime: number, notes: number[]): void {
    notes.forEach((freq, i) => {
      const t = startTime + i * 0.034;
      const osc = ctx.createOscillator();
      const harm = ctx.createOscillator();
      const lp = ctx.createBiquadFilter();
      const g = ctx.createGain();

      osc.type = 'triangle';
      harm.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      harm.frequency.setValueAtTime(freq * 2, t);

      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(3200, t);
      lp.frequency.exponentialRampToValueAtTime(900, t + 0.38);

      const isLast = i === notes.length - 1;
      const peak = isLast ? 0.13 : 0.085;
      const dur = isLast ? 0.52 : 0.28;

      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      osc.connect(lp);
      harm.connect(lp);
      lp.connect(g);
      g.connect(ctx.destination);

      osc.start(t);
      harm.start(t);
      osc.stop(t + dur + 0.03);
      harm.stop(t + dur + 0.03);
    });
  }

  /** Epic Three Kingdoms Kill (三国杀) war-drum + blade + gong + guzheng + studio voice-actor roar */
  public playStreakCallout(streakCount: number): {
    clipId: VoiceClipId;
    badge: string;
    title: string;
    speech: string;
    subtitle: string;
  } {
    const line = this.pickStreakLine(streakCount);
    if (this.muted) return line;

    const ctx = this.ensureContext();
    if (ctx) {
      const now = ctx.currentTime;
      const tier = Math.min(4, Math.max(0, streakCount - 2));

      if (tier === 0) {
        // 二连击 · 卧龙出山
        this.triggerWarDrum(ctx, now, 0.44);
        this.triggerSwordSlash(ctx, now + 0.03, 0.95);
        this.triggerBronzeGong(ctx, now + 0.02, 146.83, 0.17);
        this.triggerGuzhengFlourish(ctx, now + 0.04, [293.66, 329.63, 440.0, 587.33]);
      } else if (tier === 1) {
        // 三连击 · 一战成名
        this.triggerWarDrum(ctx, now, 0.35);
        this.triggerWarDrum(ctx, now + 0.11, 0.46);
        this.triggerSwordSlash(ctx, now + 0.11, 1.05);
        this.triggerBronzeGong(ctx, now + 0.12, 164.81, 0.19);
        this.triggerGuzhengFlourish(ctx, now + 0.12, [329.63, 392.0, 440.0, 587.33, 659.25]);
      } else {
        // 四连击及以上 (举世皆惊 / 天下无敌 / 癫狂屠戮)
        this.triggerWarDrum(ctx, now, 0.3);
        this.triggerWarDrum(ctx, now + 0.085, 0.36);
        this.triggerWarDrum(ctx, now + 0.17, 0.5);
        this.triggerSwordSlash(ctx, now + 0.16, 1.2);
        this.triggerBronzeGong(ctx, now + 0.17, 130.81, 0.23);
        this.triggerGuzhengFlourish(ctx, now + 0.17, [
          293.66, 329.63, 440.0, 493.88, 587.33, 783.99,
        ]);
      }
    }

    const voiceDelayMs = streakCount >= 4 ? 190 : streakCount === 3 ? 130 : 80;
    this.playVoiceClip(line.clipId, 4, voiceDelayMs);
    return line;
  }

  /** Subtle shot-clock warning tick */
  public playTick(): void {
    const ctx = this.ensureContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.07, now + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.04);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.045);
  }
}

export const soundEngine = new SoundEngine();
