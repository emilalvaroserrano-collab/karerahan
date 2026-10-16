// Mute-aware sound effects. Audio starts muted like the original
// (audio_enable_on_startup: false).
import { Assets, SoundName } from "./assets";

export class Sound {
  muted = true;
  /**
   * Which screen family is showing: "bgm" (menu), "bet" (BGM + announcer),
   * or "race" (crowd bed only). Honored by resume().
   */
  musicMode: "bgm" | "bet" | "race" = "bgm";

  constructor(private assets: Assets) {}

  private el(name: SoundName): HTMLAudioElement | undefined {
    return this.assets.sounds.get(name);
  }

  play(name: SoundName): void {
    if (this.muted) return;
    const a = this.el(name);
    if (!a) return;
    try {
      a.muted = false;
      a.currentTime = 0;
      void a.play();
    } catch {
      /* autoplay policy */
    }
  }

  click(): void {
    this.play("click.mp3");
  }

  chip(): void {
    this.play("chip.mp3");
  }

  private hornRace = -1;

  /**
   * Opens race audio. The gate horn plays once per race number, and only
   * when this viewer is there for the start. Taps later in the race must
   * not start it again.
   */
  beginRace(raceNumber: number, fromStart: boolean): void {
    this.musicMode = "race";
    this.raceLive = true;
    if (this.hornRace !== raceNumber) {
      this.hornRace = raceNumber;
      this.stopHorn();
      if (fromStart && !this.muted) this.playHornNow();
    }
    this.setGallop(true, this.strideHz);
  }

  endRace(): void {
    this.raceLive = false;
    this.stopHorn();
    this.stopGallop();
    this.stopCheer();
  }

  /** Gate clip. Caller already decided this race has not had its horn. */
  private playHornNow(): void {
    const a = this.el("start_race.mp3");
    if (!a) return;
    try {
      a.loop = false;
      a.volume = 1;
      a.muted = false;
      a.currentTime = 0;
      void a.play();
    } catch {
      /* autoplay policy */
    }
  }

  private stopHorn(): void {
    const a = this.el("start_race.mp3");
    if (!a) return;
    try {
      a.loop = false;
      if (!a.paused) a.pause();
    } catch {
      /* ignore */
    }
  }

  /** One-shot announcer voice-over for the race intro. */
  announcer(): void {
    if (this.muted) return;
    const a = this.el("race_intro.mp3");
    if (!a) return;
    try {
      a.loop = false;
      a.volume = 1;
      a.muted = false;
      a.currentTime = 0;
      void a.play();
    } catch {
      /* autoplay policy */
    }
  }

  stopAnnouncer(): void {
    const a = this.el("race_intro.mp3");
    if (a && !a.paused) {
      try {
        a.pause();
      } catch {
        /* ignore */
      }
    }
  }

  /** Single entry point for the mute button: silences everything when
   *  muting, and restarts only what belongs to the current screen when
   *  unmuting (so unmuting mid-race brings back the crowd bed, never BGM). */
  setMuted(m: boolean): void {
    this.muted = m;
    if (m) {
      this.soundtrack(false);
      this.stopHorn();
      this.stopAnnouncer();
      this.stopGallop();
      this.stopCheer();
    } else {
      this.resume();
    }
  }

  /** Re-assert whatever should be audible now (call on user taps). */
  resume(): void {
    if (this.muted) return;
    if (this.musicMode === "race") {
      // A tap may be the gesture that unlocks audio. Never replay the horn.
      const ctx = this.ctx();
      if (ctx?.state === "suspended") void ctx.resume();
      if (this.raceLive) this.setGallop(true, this.strideHz);
      return;
    }
    this.soundtrack(true);
    if (this.musicMode !== "bet") return;
    // Heal a never-started betting announcer (its enter() play may have
    // predated the first user gesture). Never restarts mid/late playback.
    const a = this.el("race_intro.mp3");
    if (a && a.paused && !a.ended && a.currentTime < 1) {
      try {
        a.loop = false;
        a.volume = 1;
        a.muted = false;
        void a.play();
      } catch {
        /* autoplay policy */
      }
    }
  }

  /** Hard guarantee: BGM can never overlap the race bed. Cheap; the race
   *  screen calls it every frame. */
  enforceRaceSilence(): void {
    const a = this.el("soundtrack.mp3");
    if (a && !a.paused) {
      try {
        a.pause();
      } catch {
        /* ignore */
      }
    }
  }

  photo(): void {
    this.play("photo.mp3");
  }

  private actx: AudioContext | null = null;
  private cheerGain: GainNode | null = null;
  private cheerSrc: AudioBufferSourceNode | null = null;
  private cheerLevel = -1;
  private raceLive = false;
  private gallopOn = false;
  private gallopTimer: ReturnType<typeof setTimeout> | null = null;
  private strideHz = 2.35;
  private nextStride = 0;
  private hoofBuf: AudioBuffer | null = null;

  /** Keep the gallop running for the whole race, then stop it when the field is done. */
  setGallop(on: boolean, hz: number): void {
    if (hz > 0) this.strideHz = Math.max(1.8, Math.min(3.1, hz));
    if (!on || !this.raceLive || this.muted) {
      this.stopGallop();
      return;
    }
    if (this.gallopOn) return;
    if (!this.ctx()) return;
    this.gallopOn = true;
    this.nextStride = 0;
    this.pumpGallop();
  }

  /**
   * A real gallop is four hoofbeats then a short suspension, not a steady tick.
   * Two extra layers sit just behind the lead horse so the pack is in it too.
   */
  private pumpGallop(): void {
    if (!this.gallopOn || this.muted || !this.raceLive) return;
    const ctx = this.ctx();
    if (!ctx) return;
    if (!this.hoofBuf) this.hoofBuf = this.buildHoof(ctx);
    const now = ctx.currentTime;
    if (this.nextStride < now + 0.02) this.nextStride = now + 0.04;
    const stride = 1 / this.strideHz;
    const beats = [
      { at: 0, gain: 0.82, rate: 0.88 },
      { at: 0.15, gain: 0.66, rate: 1.02 },
      { at: 0.36, gain: 1, rate: 0.94 },
      { at: 0.52, gain: 0.74, rate: 1.08 },
    ];
    const pack = [
      { delay: 0, vol: 1 },
      { delay: 0.05, vol: 0.5 },
      { delay: 0.1, vol: 0.28 },
    ];
    for (const layer of pack) {
      for (const b of beats) {
        this.playHoof(ctx, this.nextStride + layer.delay + b.at * stride, b.gain * layer.vol, b.rate);
      }
    }
    this.nextStride += stride;
    const wait = Math.max(30, (this.nextStride - ctx.currentTime - 0.08) * 1000);
    this.gallopTimer = setTimeout(() => this.pumpGallop(), wait);
  }

  private stopGallop(): void {
    this.gallopOn = false;
    this.nextStride = 0;
    if (this.gallopTimer != null) {
      clearTimeout(this.gallopTimer);
      this.gallopTimer = null;
    }
  }

  /** Dirt hoof: a short click, a low body thud, and a little grit. No beep. */
  private buildHoof(ctx: AudioContext): AudioBuffer {
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * 0.16);
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    let low = 0;
    let mid = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const n = Math.random() * 2 - 1;
      low += (n - low) * 0.045;
      mid += (n - mid) * 0.16;
      const click = t < 0.0035 ? n * (1 - t / 0.0035) : 0;
      d[i] = low * Math.exp(-t * 22) * 1.6
        + (mid - low) * Math.exp(-t * 48) * 0.42
        + click * 0.55;
    }
    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
    const norm = peak > 0 ? 0.9 / peak : 1;
    for (let i = 0; i < len; i++) d[i] *= norm;
    return buf;
  }

  private playHoof(ctx: AudioContext, time: number, gain: number, rate: number): void {
    if (!this.hoofBuf || gain <= 0.01) return;
    const src = ctx.createBufferSource();
    src.buffer = this.hoofBuf;
    src.playbackRate.value = rate * (0.96 + Math.random() * 0.08);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1400;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(0.5, gain * 0.48), time);
    src.connect(filter);
    filter.connect(g);
    g.connect(ctx.destination);
    src.start(time);
  }

  /** Quiet context for the gallop and the late-race cheer. Never the start horn. */
  private ctx(): AudioContext | null {
    if (this.muted) return null;
    const AC = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    if (!this.actx) this.actx = new AC();
    if (this.actx.state === "suspended") void this.actx.resume();
    return this.actx;
  }

  /** One hoof strike kept for any direct call. The race uses the gallop pattern. */
  hoof(strength: number): void {
    const ctx = this.ctx();
    if (!ctx || strength <= 0.01) return;
    if (!this.hoofBuf) this.hoofBuf = this.buildHoof(ctx);
    this.playHoof(ctx, ctx.currentTime, strength, 1);
  }

  /** Crowd bed for the last quarter. Fades on the same source so it does not restart. */
  setCheer(level: number): void {
    const next = this.muted ? 0 : Math.max(0, Math.min(1, level));
    if (Math.abs(next - this.cheerLevel) < 0.04 && (next > 0.02) === (this.cheerGain != null)) return;
    this.cheerLevel = next;
    if (this.muted || next <= 0.02) {
      if (!this.cheerGain) return;
      const ctx = this.actx;
      if (!ctx) return;
      const now = ctx.currentTime;
      this.cheerGain.gain.cancelScheduledValues(now);
      this.cheerGain.gain.linearRampToValueAtTime(0.0001, now + 0.45);
      return;
    }
    const ctx = this.ctx();
    if (!ctx) return;
    if (!this.cheerGain) {
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      let v = 0;
      for (let i = 0; i < len; i++) {
        v = v * 0.98 + (Math.random() * 2 - 1) * 0.02;
        data[i] = v * 4;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 780;
      filter.Q.value = 0.5;
      const g = ctx.createGain();
      g.gain.value = 0.0001;
      src.connect(filter);
      filter.connect(g);
      g.connect(ctx.destination);
      src.start();
      this.cheerSrc = src;
      this.cheerGain = g;
    }
    const now = ctx.currentTime;
    this.cheerGain.gain.cancelScheduledValues(now);
    this.cheerGain.gain.linearRampToValueAtTime(Math.min(0.11, next * 0.11), now + 0.35);
  }

  private stopCheer(): void {
    this.cheerLevel = -1;
    if (this.cheerSrc) {
      try { this.cheerSrc.stop(); } catch { /* already stopped */ }
    }
    this.cheerSrc = null;
    this.cheerGain = null;
  }

  soundtrack(on: boolean): void {
    const a = this.el("soundtrack.mp3");
    if (!a) return;
    try {
      a.loop = true;
      a.muted = this.muted || !on;
      if (on && !this.muted && a.paused) void a.play();
      if (!on && !a.paused) a.pause();
    } catch {
      /* ignore */
    }
  }
}
