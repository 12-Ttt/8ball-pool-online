// Pure Web Audio API procedural sound synthesizer for billiards

class SoundEngine {
  private ctx: AudioContext | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;
  private lastBallClackTime = 0;
  private lastRailThudTime = 0;

  private ensureContext(): AudioContext | null {
    if (this.muted) return null;
    if (typeof window === 'undefined') return null;

    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();
    }

    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    if (!this.noiseBuffer && this.ctx) {
      const sampleRate = this.ctx.sampleRate;
      const length = Math.floor(sampleRate * 0.25);
      const buffer = this.ctx.createBuffer(1, length, sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      this.noiseBuffer = buffer;
    }

    return this.ctx;
  }

  public unlock(): void {
    this.ensureContext();
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
  }

  public isMuted(): boolean {
    return this.muted;
  }

  /** Crisp cue tip strike on cue ball */
  public playCueStrike(power: number): void {
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

  /** Muffled rubber cushion thud */
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

  /** Subtle low double tone on foul */
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

  /** Warm victory chord */
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
