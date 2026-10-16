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
  private noise: AudioBuffer | null = null;
  private cheerGain: GainNode | null = null;
  private cheerSrc: AudioBufferSourceNode | null = null;
  private cheerLevel = -1;
  private raceLive = false;
  private gallopOn = false;
  private gallopTimer: ReturnType<typeof setTimeout> | null = null;
  private beat = 0;
  private strideHz = 2.45;

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
    this.beat = 0;
    this.pumpGallop();
  }

  private pumpGallop(): void {
    if (!this.gallopOn || this.muted || !this.raceLive) return;
    const accents = [1, 0.62, 0.88, 0.5];
    this.hoof(accents[this.beat % 4]);
    this.beat++;
    const step = 1000 / this.strideHz / 4;
    this.gallopTimer = setTimeout(() => this.pumpGallop(), step);
  }

  private stopGallop(): void {
    this.gallopOn = false;
    if (this.gallopTimer != null) {
      clearTimeout(this.gallopTimer);
      this.gallopTimer = null;
    }
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

  /** One hoof strike. `strength` is 0..1; the hit stays quiet. */
  hoof(strength: number): void {
    const ctx = this.ctx();
    if (!ctx || strength <= 0.01) return;
    if (!this.noise) {
      const len = Math.floor(ctx.sampleRate * 0.05);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      this.noise = buf;
    }
    const t = ctx.currentTime;
    const vol = Math.min(0.42, 0.22 + strength * 0.22);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 420;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.055);
    src.connect(filter);
    filter.connect(g);
    g.connect(ctx.destination);
    src.start(t);
    src.stop(t + 0.06);
    const osc = ctx.createOscillator();
    const og = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(96, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.05);
    og.gain.setValueAtTime(vol * 0.65, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    osc.connect(og);
    og.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.05);
  }

  /** Rising crowd bed for the last quarter. `level` is 0..1. */
  setCheer(level: number): void {
    if (this.muted || level <= 0.02) {
      this.stopCheer();
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
        v = v * 0.97 + (Math.random() * 2 - 1) * 0.03;
        data[i] = v * 6;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = 900;
      filter.Q.value = 0.55;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(filter);
      filter.connect(g);
      g.connect(ctx.destination);
      src.start();
      this.cheerSrc = src;
      this.cheerGain = g;
    }
    this.cheerGain.gain.value = Math.min(0.14, level * 0.14);
  }

  private stopCheer(): void {
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
