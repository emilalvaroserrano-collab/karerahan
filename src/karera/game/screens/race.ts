// Race screen: starting gates, pack run with panning panorama, live standings HUD,
// photo finish, arrival panel, result dialog.
import {
  BetCell,
  FONT_DIGI,
  FONT_IMPACT,
  FONT_MOTOR,
  HOUSE_TAKE,
  MIN_LOAD,
  TRAPS,
  fmtMoney,
} from "../constants";
import { Game, Screen } from "../engine";

import { drawCentered, drawStateHalf, text } from "../ui";
import { DLG_CX, drawPanelBox, drawDim } from "./dialogs";
import { HORSE_A_FRAMES, THUMB_FRAME } from "../horseFrames";
import { BetScreen } from "./bet";
import { MenuScreen } from "./menu";
import { WaitScreen } from "./wait";
import { mulberry32, raceClock } from "../schedule";
import { feed } from "../feed";
import { Auth } from "../auth";
import { TRACK_SHIFT } from "../trackShift";
import { gallopPose } from "../gallopIk";

export const HUD_COL_X = [184, 309, 433, 557, 683, 808, 931, 1053];
const HUD_BADGE_Y = 808;
const HUD_NAME_Y = 758;

const CAGE_W = [292, 271, 254, 235, 214, 189, 162, 131, 95];
const GATE_OPEN_T = 0.9;
/** Screen x the pack is anchored to (leaves track ahead, like the original). */
const PACK_X = 500;
/** Pixels of screen separation per unit of race progress. */
const SPREAD = 2600;

/** Race gallop uses the 12-pose _a cycle (3 cols x 4 rows sheet): unlike the
 *  3-pose _b sheet — whose front legs stay reaching forward in every pose —
 *  it swings the forelegs through the full running range (reach → land →
 *  support → push → fold → swing). Poses play in sheet order. The grid was
 *  verified pixel-identical across all 8 horses, but we still look up each
 *  horse's own sheet. */
const A_CYCLE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
/** Uniform scale for every pose (avg cell ~278px → ~300px on screen), so no
 *  pose ever pops in size; feet stay pinned to yBase. */
const A_SCALE = 1.08;

type CamId = "rail" | "chase" | "head" | "tight";
const CAM_CYCLE: CamId[] = ["rail", "chase", "head", "tight"];
const CAM_NAME: Record<CamId, string> = {
  rail: "SIDE",
  chase: "BEHIND",
  head: "HEAD ON",
  tight: "LEADER",
};

interface Dust {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  /** 0..1 picks a lighter or darker dirt tone. */
  shade: number;
}

interface Horse {
  trap: number; // 0..7
  lane: number; // 0..7 (0 = back)
  T: number; // finish time
  /** mid-race jostle: amplitude (progress units), cycles per race, phase */
  wobAmp: number;
  wobK: number;
  wobPhase: number;
  /** gallop stride phase 0..1 (wraps) + strides per second */
  stride: number;
  strideFreq: number;
  /** stride cycle value last frame (detects push-off crossing for dust) */
  prevCyc: number;
  prog: number;
}

// Tighter depth stack than before: the old 400..638 spread stacked the pack
// into a vertical totem pole because horizontal separation (~180-290px) was
// smaller than the vertical spread (238px). Feet now span 98px; size 0.82..1.10.
const LANE_Y = [468, 482, 496, 510, 524, 538, 552, 566];
const LANE_S = [0.82, 0.86, 0.9, 0.94, 0.98, 1.02, 1.06, 1.1];

export class RaceScreen implements Screen {
  private t = 0;
  private horses: Horse[] = [];
  private order: number[] = [];
  private cam = 0;
  /** Track frame position. Keeps scrolling after the finish so the field never runs in place. */
  private ground = 0;
  private gatesGone = 0; // 0..1 exit animation
  private flash = 0;
  private slowmo = 1;
  private slowT = 0;
  private finished = false;
  private arrivalT = 0; // time since all finished
  private dialogAt = 0;
  private payout = 0;
  private frameTick = 0;
  private gatesOpened = false;
  private paidOut = false;
  /** Kicked-up track dust (spawned at hind-hoof push-off). */
  private dust: Dust[] = [];
  /** Locked pool numbers (house take already credited at lock). */
  private poolTotal = 0;
  /** Final WIN multiple from this race's actual stakes only. */
  private div = 0;
  /** Broadcast HUD: frozen winning clock + smoothed speed readout. */
  private winClock = 0;
  private prevProg = 0;
  private dispSpeed = 58;
  private snapped = false;
  /** Gate-open and photo-finish kick. Decays to 0. */
  private shake = 0;
  /** Smoothed last-quarter crowd level so the cheer does not restart. */
  private cheer = 0;
  private camId: CamId = "rail";
  private camHold = 6;
  private camManual = 0;
  /** Per-trap progress gain last frame, used to stretch a horse that's moving up. */
  private gain = [0, 0, 0, 0, 0, 0, 0, 0];
  private lastProg = [0, 0, 0, 0, 0, 0, 0, 0];
  /** Current badge x per trap; glides toward its rank slot (trap i starts reversed). */
  private trapX: number[] = [...HUD_COL_X].reverse();

  constructor(private game: Game, startAt = 0) {
    const rnd = mulberry32((this.game.state.raceNumber || 1) * 9973 + 99);
    const prev = Math.random;
    Math.random = rnd;
    try {
      this.decideRace();
    } finally {
      Math.random = prev;
    }
    // Lock the pool from this player's bets on the shared race.
    const stakes = this.actualStakes();
    const total = stakes.reduce((s, n) => s + n, 0);
    this.poolTotal = total;
    const onWinner = stakes[this.order[0]] ?? 0;
    this.div = onWinner > 0 ? Math.round(((total * (1 - HOUSE_TAKE)) / onWinner) * 100) / 100 : 0;
    if (startAt > 0.2) {
      this.t = startAt;
      if (startAt > GATE_OPEN_T) {
        this.gatesGone = 1;
        this.gatesOpened = true;
      }
    }
  }

  private playerBets(): BetCell[] {
    if (this.game.state.bets.length) return this.game.state.bets;
    return (this.game.net.state?.bets ?? [])
      .filter((b) => b.phone === this.game.net.phone)
      .map((b) => ({ kind: b.kind as BetCell["kind"], a: b.a, b: b.b, amount: b.amount }));
  }

  // ---------- race setup ----------

  /** Real win stakes on this race. The odds table is not part of the pool. */
  private actualStakes(): number[] {
    const local = new Array(8).fill(0);
    for (const b of this.playerBets()) {
      if (b.kind === "win" && b.a >= 0 && b.a < 8) local[b.a] += b.amount;
    }
    return local.map((n, i) => Math.max(n, feed.total(i)));
  }

  private decideRace(): void {
    const st = this.game.state;
    const n = 8;
    const stakes = this.actualStakes();
    // The host keeps the money. The horse with the least real money on it
    // wins, so a payout — when there is one — never exceeds this race's bets.
    let winner = 0;
    for (let i = 1; i < n; i++) {
      const less = stakes[i] < stakes[winner] - 0.001;
      const tie = Math.abs(stakes[i] - stakes[winner]) <= 0.001 && st.strength[i] > st.strength[winner];
      if (less || tie) winner = i;
    }
    const rest = Array.from({ length: n }, (_, i) => i)
      .filter((i) => i !== winner)
      .sort((a, b) => st.strength[b] + Math.random() * 0.5 - (st.strength[a] + Math.random() * 0.5));
    this.order = [winner, ...rest];
    // Long race: winner crosses at ~38-46s, pack trails to ~52s
    // (double the original ~19-26s window).
    const T0 = 38 + Math.random() * 8;
    const times = new Array<number>(n);
    // The whole field finishes in a blanket. Gaps are only a few tenths,
    // so the decided winner still hits the line first.
    this.order.forEach((trap, place) => {
      const gap = place === 0 ? 0 : 0.22 * place + Math.random() * 0.1;
      times[trap] = T0 + gap;
    });
    this.horses = Array.from({ length: n }, (_, trap) => ({
      trap,
      lane: trap % 8,
      T: times[trap],
      // Every horse surges. The fight dies in the last tenth, then the
      // real order runs to the line.
      wobAmp: 0.026 + Math.random() * 0.016,
      wobK: 2 + (trap % 2),
      wobPhase: Math.random() * Math.PI * 2,
      // Gallop cadence ~2.3-2.8 strides/s at full speed, faster horses
      // stride slightly quicker. Phase desynced per horse so the pack
      // doesn't gallop in lockstep.
      stride: Math.random(),
      strideFreq: 2.3 + Math.random() * 0.35 + st.strength[trap] * 0.25,
      prevCyc: 0,
      prog: 0,
    }));
    // Shuffle depth lanes so size isn't locked to trap number (trap 0 was
    // always the small back horse, trap 7 always the big front horse).
    const lanes = [0, 1, 2, 3, 4, 5, 6, 7];
    for (let i = lanes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [lanes[i], lanes[j]] = [lanes[j], lanes[i]];
    }
    this.horses.forEach((h, i) => {
      h.lane = lanes[i];
    });
  }

  private progress(h: Horse, t: number): number {
    const u = t / h.T;
    if (u <= 0) return 0;
    // Run a little past the line. The camera follows, so the dirt keeps
    // moving instead of the horses galloping on a frozen background.
    if (u >= 1) return Math.min(1.12, u);
    // Full fight until the last tenth, then it shuts off so the finish order holds.
    const env = Math.sin(Math.PI * Math.min(1, u / 0.9));
    return u + h.wobAmp * Math.sin(2 * Math.PI * h.wobK * u + h.wobPhase) * env;
  }

  private ranking(): number[] {
    // Current running order: sort by progress desc (ties → trap).
    return [...this.horses]
      .sort((a, b) => b.prog - a.prog || a.trap - b.trap)
      .map((h) => h.trap);
  }

  /** Slot 7 (right, "1st") is the leader; slot 0 (left, "8th") is last. */
  private slotOf(rank: number[], trap: number): number {
    return 7 - rank.indexOf(trap);
  }

  enter(): void {
    const phone = this.game.state.phone;
    if (phone) feed.join(phone, this.game.state.raceNumber);
    // Start horn once. Hoofbeats loop for the whole race and do not include it.
    this.game.sound.musicMode = "race";
    this.game.sound.soundtrack(false);
    this.game.sound.stopAnnouncer();
    this.game.sound.beginRace(this.game.state.raceNumber, this.t < 1);
  }
  exit(): void {
    // Out of the race: cut the bed; the next screen owns the audio again.
    this.game.sound.endRace();
    this.game.sound.musicMode = "bgm";
  }

  update(dt: number): void {
    const sdt = dt * this.slowmo;
    this.t += sdt;
    const runT = Math.max(0, this.t - GATE_OPEN_T);
    // No BGM during the race. Hoofbeats stay looping; the start horn does not replay.
    this.game.sound.enforceRaceSilence();

    for (const h of this.horses) {
      h.prog = this.progress(h, runT);
      // Stride advances with race time (slows during photo-finish slow-mo),
      // so legs and body bob stay in sync. Ramp up over the first ~3s out
      // of the gates (burst → full gallop) and ease off past the line.
      let gait = 1;
      if (runT < 3) gait = 0.62 + 0.38 * Math.max(0, runT / 3);
      else if (h.prog >= 1.02) gait = 0.72;
      const prev = ((h.stride % 1) + 1) % 1;
      h.stride += sdt * h.strideFreq * gait;
      const cyc = ((h.stride % 1) + 1) % 1;
      h.prevCyc = prev;
      this.gain[h.trap] = h.prog - this.lastProg[h.trap];
      this.lastProg[h.trap] = h.prog;
      const landed = (mark: number) => prev < mark && cyc >= mark;
      if ((landed(0.34) || landed(0.74)) && this.t > GATE_OPEN_T && this.dust.length < 160) {
        const s = LANE_S[h.lane];
        const px = PACK_X + (h.prog - this.cam) * SPREAD;
        const y = LANE_Y[h.lane] + 2;
        const fore = cyc < 0.5;
        const n = fore ? 4 : 2;
        for (let i = 0; i < n; i++) {
          this.dust.push({
            x: px - (fore ? 36 : 78) * s - i * 10 * s + (Math.random() - 0.5) * 10,
            y: y + (Math.random() - 0.3) * 5,
            vx: -70 - Math.random() * (fore ? 160 : 90),
            vy: -4 - Math.random() * (fore ? 22 : 10),
            life: 0,
            maxLife: (fore ? 0.42 : 0.26) + Math.random() * 0.3,
            size: ((fore ? 5 : 3) + Math.random() * 7) * s,
            shade: Math.random(),
          });
        }
      }
    }
    // Age dust (real dt so slow-mo doesn't freeze the air).
    for (let i = this.dust.length - 1; i >= 0; i--) {
      const d = this.dust[i];
      d.life += dt;
      if (d.life >= d.maxLife) {
        this.dust.splice(i, 1);
        continue;
      }
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.vy += 60 * dt; // settle back to the track
      d.vx *= 1 - 1.1 * dt;
    }
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 1.35);
    // Keep the legacy tick advancing for any external readers.
    this.frameTick += sdt;

    const front = this.horses.reduce((a, h) => (h.prog > a.prog ? h : a));
    const leader = front.prog;
    // Broadcast speed readout: leader pace smoothed (typical gallop reads
    // high-50s; burst/slow-mo swing it either way).
    if (!this.finished) {
      const vel = sdt > 0.0001 ? (leader - this.prevProg) / sdt : 0;
      const target = Math.max(42, Math.min(78, 52 + vel * 260));
      this.dispSpeed += (target - this.dispSpeed) * Math.min(1, dt * 3);
    }
    this.prevProg = leader;
    // Follow the leader through the run past the line. The old cap at 1
    // froze the background while the horses were still galloping.
    const lead = Math.min(1.12, leader);
    if (!this.snapped) {
      this.cam = lead;
      this.ground = (lead / 1.12) * 186;
      this.snapped = true;
    } else {
      this.cam += (lead - this.cam) * Math.min(1, dt * 2.2);
      const target = (this.cam / 1.12) * 186;
      if (target > this.ground) this.ground = target;
      if (this.dialogAt === 0 && target >= 185) this.ground += sdt * 16;
    }

    if (this.t > GATE_OPEN_T) {
      this.gatesGone = Math.min(1, this.gatesGone + dt / 2.0);
      if (!this.gatesOpened) {
        this.gatesOpened = true;
        this.shake = Math.max(this.shake, 1);
      }
    }
    const running = runT > 0.2 && this.horses.some((h) => h.prog < 1.02);
    this.game.sound.setGallop(running, front.strideFreq);
    if (this.finished || leader >= 1) this.game.sound.lead(-1);
    else if (runT > 1.5) this.game.sound.lead(front.trap);
    const targetCheer = this.finished
      ? Math.max(0, 1 - Math.max(0, this.arrivalT - 0.6) / 2.4)
      : leader >= 0.75 ? Math.min(1, (leader - 0.75) / 0.25) : 0;
    this.cheer += (targetCheer - this.cheer) * Math.min(1, dt * 1.6);
    this.game.sound.setCheer(this.cheer);
    if (this.finished || leader >= 0.88) this.camId = "tight";
    else if (this.camManual > 0) this.camManual = Math.max(0, this.camManual - dt);
    else if (this.t < GATE_OPEN_T + 2.4) this.camId = "rail";
    else {
      this.camHold -= dt;
      if (this.camHold <= 0) {
        const i = CAM_CYCLE.indexOf(this.camId);
        this.camId = CAM_CYCLE[(i + 1) % CAM_CYCLE.length];
        this.camHold = 8;
      }
    }

    // Photo finish on first crosser: brief slow-mo like the original, then
    // release. Race still lands in the ~38-52s window.
    if (!this.finished && leader >= 1) {
      this.finished = true;
      this.flash = 1;
      this.shake = Math.max(this.shake, 1.15);
      this.winClock = Math.max(0, this.t - GATE_OPEN_T);
      this.game.sound.photo();
      this.game.sound.finishLine();
      this.slowmo = 0.5;
      this.slowT = 1.1;
    }
    if (this.slowT > 0) {
      this.slowT -= dt;
      if (this.slowT <= 0) this.slowmo = 1;
    }
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 3);

    const allDone = this.horses.every((h) => h.prog >= 1);
    if (allDone) {
      this.slowmo = 1;
      this.arrivalT += dt;
      if (this.arrivalT > 0.1 && this.payout === 0 && !this.paidOut) {
        this.paidOut = true;
        this.payout = this.computePayout();
        this.game.state.money += this.payout;
        const staked = this.playerBets()
          .filter((b) => b.kind === "win")
          .reduce((s, b) => s + b.amount, 0);
        const kept = Math.round((staked - this.payout) * 100) / 100;
        if (kept > 0) Auth.creditHouse(kept);
        this.game.net.clearBets();
      }
      if (this.arrivalT > 1.4 && this.dialogAt < 0.4) this.dialogAt += dt;
    }

    // Per-trap badge positions glide to their rank slot (leader rightmost).
    const rank = this.finished && allDone ? this.order : this.ranking();
    for (const h of this.horses) {
      const tx = HUD_COL_X[this.slotOf(rank, h.trap)];
      this.trapX[h.trap] += (tx - this.trapX[h.trap]) * Math.min(1, dt * 5);
    }
  }

  private computePayout(): number {
    const o = this.order;
    const myBets = this.playerBets();
    // Covering every horse for the same stake cannot pay.
    if (this.sameStakeOnEveryHorse(myBets)) return 0;
    // Multiple comes only from money bet on this race, never the odds matrix.
    let pay = 0;
    for (const b of myBets) {
      if (b.kind !== "win" || b.a !== o[0]) continue;
      pay += b.amount * this.div;
    }
    const staked = myBets.filter((b) => b.kind === "win").reduce((s, b) => s + b.amount, 0);
    const cap = Math.round(staked * (1 - HOUSE_TAKE) * 100) / 100;
    return Math.min(cap, Math.round(pay * 100) / 100);
  }

  /** True when this player put the same win stake on all 8 horses. */
  private sameStakeOnEveryHorse(bets: BetCell[]): boolean {
    const stake = new Array(8).fill(0);
    for (const b of bets) {
      if (b.kind === "win" && b.a >= 0 && b.a < 8) stake[b.a] += b.amount;
    }
    if (stake.some((n) => n <= 0)) return false;
    const first = Math.round(stake[0] * 100);
    return stake.every((n) => Math.round(n * 100) === first);
  }

  // ---------- drawing ----------

  private badge(ctx: CanvasRenderingContext2D, trap: number, cx: number, cy: number, size: number): void {
    const sx = (trap % 4) * 72;
    const sy = Math.floor(trap / 4) * 72;
    ctx.drawImage(this.game.assets.img("bibs"), sx, sy, 72, 72, cx - size / 2, cy - size / 2, size, size);
  }

  private drawTrack(ctx: CanvasRenderingContext2D): void {
    // Slide from each bg_track frame into the next one, so the dirt scrolls.
    const span = 186;
    let pos = this.ground;
    if (pos > span) {
      const from = 150;
      const len = span - from;
      pos = from + ((pos - span) % len);
    }
    pos = Math.max(0, Math.min(span - 0.001, pos));
    const i = Math.floor(pos);
    const frac = pos - i;
    const a = this.game.assets.trackFrame(i);
    if (!a.complete || a.naturalWidth < 8) {
      ctx.fillStyle = "#6a4428";
      ctx.fillRect(0, 0, 1280, 876);
      return;
    }
    const step = (TRACK_SHIFT[i] ?? 64) * (1280 / a.naturalWidth);
    ctx.drawImage(a, -frac * step, 0, 1280, 876);
    if (frac > 0.001) {
      const b = this.game.assets.trackFrame(Math.min(span, i + 1));
      if (b.complete && b.naturalWidth > 8) ctx.drawImage(b, (1 - frac) * step, 0, 1280, 876);
    }
  }

  private drawGates(ctx: CanvasRenderingContext2D): void {
    if (this.gatesGone >= 1) return;
    const A = this.game.assets;
    const off = this.gatesGone * 800;
    const baseY = 470; // bottom alignment
    for (let i = 0; i < 9; i++) {
      const w = CAGE_W[i];
      const img = A.img(`cage_${i}`);
      const h = (w / img.naturalWidth) * img.naturalHeight;
      const x = 8 + i * 28 - off;
      const y = baseY - h;
      // Horse inside (trap 8-i ... trap mapping: stall 0 = trap 7? leftmost = trap 8)
      const trap = 7 - i;
      if (trap >= 0 && this.t < GATE_OPEN_T) {
        const hs = A.img(`horse_${trap + 1}_a`);
        const [fx, fy, fw, fh] = HORSE_A_FRAMES[trap + 1][THUMB_FRAME];
        const dw = w * 0.5;
        const dh = (dw / fw) * fh;
        ctx.drawImage(hs, fx, fy, fw, fh, x + w * 0.2, y + h * 0.3, dw, dh);
      }
      ctx.drawImage(img, x, y, w, h);
      const door = A.img(`gate_${i}`);
      const dw = w * 0.95;
      const dh = (dw / door.naturalWidth) * door.naturalHeight;
      const open = this.t > GATE_OPEN_T ? Math.min(1, (this.t - GATE_OPEN_T) / 0.55) : 0;
      ctx.save();
      ctx.translate(x + w * 0.14, y + h * 0.7);
      ctx.rotate(-open * 1.2);
      ctx.globalAlpha = 1 - open * 0.9;
      ctx.drawImage(door, -dw * 0.08, -dh * 0.9, dw, dh);
      ctx.restore();
      // Number above, shrinking with perspective so the row reads 8..1
      // instead of collapsing into one blob.
      if (trap >= 0) {
        const ns = Math.max(14, 36 * (w / 292));
        const sx = (trap % 4) * 72;
        const sy = Math.floor(trap / 4) * 72;
        ctx.drawImage(A.img("bibs"), sx, sy, 72, 72, x + w / 2 - ns / 2, y - ns - 8, ns, ns);
      }
    }
  }

  private drawHorses(ctx: CanvasRenderingContext2D): void {
    if (this.t < GATE_OPEN_T) return;
    const A = this.game.assets;
    const emerge = Math.min(1, (this.t - GATE_OPEN_T) / 0.7);
    const ease = 1 - Math.pow(1 - emerge, 2);
    const leader = Math.max(...this.horses.map((h) => h.prog));
    const showDust = this.camId === "rail" || this.camId === "tight";
    if (showDust) {
      for (const d of this.dust) {
        const k = d.life / d.maxLife;
        const fade = Math.max(0, 1 - k);
        const alpha = 0.55 * fade;
        const rgb = d.shade > 0.62 ? "214,176,122" : d.shade > 0.3 ? "176,132,86" : "120,84,52";
        ctx.save();
        ctx.translate(d.x, d.y);
        ctx.scale(3.1 + k * 4.4, 0.42 + k * 0.5);
        const r = d.size * (0.85 + 0.7 * k);
        const g = ctx.createRadialGradient(0, 0, r * 0.08, 0, 0, r);
        g.addColorStop(0, `rgba(${rgb},${alpha})`);
        g.addColorStop(0.55, `rgba(${rgb},${alpha * 0.45})`);
        g.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
    const order = this.camId === "head"
      ? [...this.horses].sort((a, b) => a.prog - b.prog)
      : this.camId === "chase"
        ? [...this.horses].sort((a, b) => b.prog - a.prog)
        : [...this.horses].sort((a, b) => a.lane - b.lane);
    for (const h of order) {
      const sheet = HORSE_A_FRAMES[h.trap + 1];
      const cyc = ((h.stride % 1) + 1) % 1;
      const f = cyc * A_CYCLE.length;
      const fi = Math.min(A_CYCLE.length - 1, Math.floor(f));
      const i0 = A_CYCLE[fi];
      const i1 = A_CYCLE[(fi + 1) % A_CYCLE.length];
      const frac = f - Math.floor(f);
      const s = 0.55 + (LANE_S[h.lane] - 0.55) * ease;
      // Equal-power fade keeps the horse solid while the pose moves
      // through. A few pixels of travel makes the blend read as a stride,
      // not a dissolve. Hooves stay on the dirt — the art already leaves the ground.
      const outA = Math.cos(frac * Math.PI * 0.5);
      const inA = Math.sin(frac * Math.PI * 0.5);
      const ik = gallopPose(cyc);
      const bob = -ik.lift * s;
      const pitch = ik.pitch;
      const spot = this.placeHorse(h, ease, leader);
      if (!spot) continue;
      const hx = spot.x;
      const travel = 4.5 * s;
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.filter = spot.blur;
      ctx.fillStyle = `rgba(40, 24, 10, ${spot.k > 0.9 ? 0.3 : 0.18})`;
      ctx.beginPath();
      ctx.ellipse(hx, spot.y + 3, 44 * spot.k * (1 - Math.max(0, ik.lift) * 0.012), 4.2 + spot.k * 1.4, 0, 0, Math.PI * 2);
      ctx.fill();
      const paint = (alpha: number, frame: number, dx: number) => {
        if (alpha <= 0.01) return;
        const [fx, fy, fw, fh] = sheet[frame];
        const dw = fw * spot.k;
        const dh = fh * spot.k;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(hx + dx, spot.y + bob);
        ctx.rotate(spot.flip ? -pitch : pitch);
        ctx.scale(spot.flip ? -1 : 1, 1);
        ctx.drawImage(A.img(`horse_${h.trap + 1}_a`), fx, fy, fw, fh, -dw / 2, -dh, dw, dh);
        ctx.restore();
      };
      paint(outA, i0, -travel * frac);
      paint(inA, i1, travel * (1 - frac));
      ctx.restore();
    }
  }

  /** Side, chase-from-behind, head-on, or a tight leader lens. */
  private placeHorse(
    h: Horse,
    ease: number,
    leader: number,
  ): { x: number; y: number; k: number; flip: boolean; blur: string } | null {
    const s = 0.55 + (LANE_S[h.lane] - 0.55) * ease;
    const k0 = A_SCALE * s;
    const px = PACK_X + (h.prog - this.cam) * SPREAD;
    const stallX = 8 + (7 - h.trap) * 28 + 100;
    const x = stallX + (px - stallX) * ease;
    if (this.camId === "rail" || this.camId === "tight") {
      if (x < -450 || x > 1550) return null;
      const blur = "none";
      return { x, y: LANE_Y[h.lane], k: k0, flip: false, blur };
    }
    const gap = Math.max(0, leader - h.prog);
    const lane = h.lane - 3.5;
    if (this.camId === "head") {
      const depth = Math.min(1, gap * 7);
      return {
        x: 760 + (h.prog - leader) * 820 + lane * (64 - depth * 18),
        y: 590 - depth * 150,
        k: (1.12 - depth * 0.5) * (0.72 + 0.28 * ease),
        flip: false,
        blur: depth > 0.62 ? "blur(1.1px)" : "none",
      };
    }
    const depth = Math.min(1, gap * 6.5);
    return {
      x: 900 - depth * 70 + lane * 30,
      y: 455 + depth * 125,
      k: (0.58 + depth * 0.62) * (0.78 + 0.22 * ease),
      flip: false,
      blur: depth < 0.18 ? "blur(0.7px)" : "none",
    };
  }

  private drawHUD(ctx: CanvasRenderingContext2D): void {
    const A = this.game.assets;
    ctx.drawImage(A.img("rank_panel"), 0, 700, 1280, 176);
    const rank = this.finished && this.arrivalT > 0.1 ? this.order : this.ranking();
    for (let trap = 0; trap < 8; trap++) {
      const slot = this.slotOf(rank, trap);
      const x = this.trapX[trap];
      const settled = Math.abs(x - HUD_COL_X[slot]) < 2 ? 1 : 0.35;
      ctx.save();
      ctx.globalAlpha = settled;
      text(ctx, TRAPS[trap].name, x - 18, HUD_NAME_Y, {
        font: FONT_MOTOR, size: 15, color: "#ffffff", align: "center",
      });
      // underline
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x - 48, HUD_NAME_Y + 11, 60, 2);
      ctx.restore();
      this.badge(ctx, trap, x, HUD_BADGE_Y, 56);
    }
    // Progress fill
    const leader = Math.max(...this.horses.map((h) => h.prog));
    const fw = 980 * Math.min(1, leader);
    if (fw > 4) {
      const fill = A.img("fill_bar");
      ctx.drawImage(fill, 0, 0, fill.naturalWidth, fill.naturalHeight, 150, 858, fw, 8);
    }
  }

  /** Broadcast HUD: live position chip (top-left), race timer counting up
   *  and freezing at the winning time (top-center), speed readout (right).
   *  Mirrors the reference video's overlay. */
  private drawRaceHUD(ctx: CanvasRenderingContext2D): void {
    // Position of the player's most-backed horse (winner pick on forecast,
    // leader when no bets placed).
    let follow = this.ranking()[0];
    let best = -1;
    for (const b of this.game.state.bets) {
      if (b.amount > best) {
        best = b.amount;
        follow = b.a;
      }
    }
    const rank = this.finished && this.arrivalT > 0.1 ? this.order : this.ranking();
    const place = rank.indexOf(follow);
    const ord = place === 0 ? "1ST" : place === 1 ? "2ND" : place === 2 ? "3RD" : `${place + 1}TH`;

    ctx.save();
    // Position chip.
    ctx.fillStyle = "rgba(4, 12, 30, 0.72)";
    ctx.strokeStyle = "#2b4d86";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(17, 12, 190, 46, 10);
    ctx.fill();
    ctx.stroke();
    text(ctx, `YOU • ${ord}`, 112, 36, {
      font: FONT_MOTOR, size: 22, color: "#ffe14d", stroke: "#000000", strokeWidth: 3,
    });
    // Timer pill (freezes at the winning clock).
    const t = this.finished ? this.winClock : Math.max(0, this.t - GATE_OPEN_T);
    const mm = Math.floor(t / 60);
    const ss = (t % 60).toFixed(2).padStart(5, "0");
    ctx.fillStyle = "rgba(4, 12, 30, 0.72)";
    ctx.strokeStyle = "#2b4d86";
    ctx.beginPath();
    ctx.roundRect(544, 12, 192, 46, 10);
    ctx.fill();
    ctx.stroke();
    text(ctx, `${mm}:${ss}`, 640, 36, {
      font: FONT_DIGI, size: 30, color: "#ffffff",
    });
    // Speed readout.
    text(ctx, String(Math.round(this.dispSpeed)), 1215, 646, {
      font: FONT_DIGI, size: 36, color: "#ffffff", stroke: "#000000", strokeWidth: 4,
    });
    text(ctx, "KM/H", 1215, 674, {
      font: FONT_MOTOR, size: 14, color: "#9fd0ff", stroke: "#000000", strokeWidth: 3,
    });
    ctx.restore();
  }

  private drawCamButton(ctx: CanvasRenderingContext2D): void {
    const g = this.game;
    const b = {
      x: 752, y: 12, w: 230, h: 46,
      onTap: () => {
        g.sound.click();
        const i = CAM_CYCLE.indexOf(this.camId);
        this.camId = CAM_CYCLE[(i + 1) % CAM_CYCLE.length];
        this.camManual = 10;
        this.camHold = 8;
      },
    };
    g.buttons.add(b);
    ctx.save();
    ctx.fillStyle = "rgba(4, 12, 30, 0.78)";
    ctx.strokeStyle = "#f2c200";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(b.x, b.y, b.w, b.h, 10);
    ctx.fill();
    ctx.stroke();
    text(ctx, `CAM  ${CAM_NAME[this.camId]}`, b.x + b.w / 2, b.y + 24, {
      font: FONT_MOTOR, size: 18, color: "#ffe14d",
    });
    ctx.restore();
  }

  private drawCorners(ctx: CanvasRenderingContext2D): void {
    const g = this.game;
    const B = g.buttons;
    const mk = (x: number, kind: "fs" | "au" | "x") => {
      const b = {
        x, y: 14, w: 55, h: 56,
        onTap: () => {
          if (kind === "fs") {
            g.sound.click();
            g.fullscreen(!document.fullscreenElement);
          } else if (kind === "au") {
            g.sound.click();
            g.sound.setMuted(!g.sound.muted);
            g.state.muted = g.sound.muted;
          } else {
            g.sound.click();
            this.leaveTrack();
          }
        },
      };
      B.add(b);
      const s = B.isPressed(b) ? 0.92 : 1;
      const cx = b.x + 27.5;
      const cy = b.y + 28;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(s, s);
      ctx.translate(-cx, -cy);
      if (kind === "fs") drawStateHalf(ctx, g.assets, "but_fullscreen", document.fullscreenElement ? 1 : 0, b.x, b.y);
      else if (kind === "au") drawStateHalf(ctx, g.assets, "audio_icon", g.sound.muted ? 1 : 0, b.x, b.y);
      else ctx.drawImage(g.assets.img("but_exit"), b.x, b.y, b.w, b.h);
      ctx.restore();
    };
    mk(1113, "fs");
    mk(1169, "au");
    mk(1225, "x");
  }

  private drawArrival(ctx: CanvasRenderingContext2D): void {
    if (this.arrivalT <= 0.1) return;
    const A = this.game.assets;
    const slide = Math.min(1, this.arrivalT / 0.5);
    const x = 1280 + (1060 - 1280) * (1 - Math.pow(1 - slide, 3));
    ctx.drawImage(A.img("panel_arrival"), x, 250, 183, 274);
    this.order.forEach((trap, i) => {
      const y = 250 + 20 + i * 30;
      this.badge(ctx, trap, x + 24, y, 28);
      text(ctx, TRAPS[trap].name, x + 44, y, {
        font: FONT_MOTOR, size: 15, color: "#ffffff", align: "left",
      });
    });
  }

  private drawResult(ctx: CanvasRenderingContext2D): void {
    if (this.dialogAt <= 0.3) return;
    const g = this.game;
    const bets = this.playerBets();
    const betted = bets.length > 0;
    const win = betted && this.payout > 0;
    const picked = new Set(bets.map((b) => b.a));
    drawDim(ctx);
    drawPanelBox(ctx, g, win ? "win" : "lose");
    if (win) {
      text(ctx, "You Win", DLG_CX, 248, { font: FONT_IMPACT, size: 36, color: "#ffe14d" });
      text(ctx, `WIN ${fmtMoney(this.payout)}`, DLG_CX, 278, {
        font: FONT_MOTOR, size: 16, color: "#ffffff",
      });
    } else if (betted) {
      text(ctx, "You Loose!", DLG_CX, 248, { font: FONT_IMPACT, size: 34, color: "#ffffff" });
      text(ctx, "Your luck might be on the next race!", DLG_CX, 276, {
        font: FONT_MOTOR, size: 14, color: "#ffd0d0",
      });
    } else {
      text(ctx, "RACE RESULTS", DLG_CX, 258, { font: FONT_IMPACT, size: 32, color: "#ffffff" });
    }
    const place = ["1ST", "2ND", "3RD", "4TH", "5TH", "6TH", "7TH", "8TH"];
    this.order.forEach((trap, i) => {
      const col = i < 4 ? 0 : 1;
      const row = i % 4;
      const x = 438 + col * 236;
      const y = 328 + row * 48;
      this.badge(ctx, trap, x, y, 34);
      text(ctx, place[i], x + 24, y - 8, {
        font: FONT_MOTOR, size: 12, color: i === 0 ? "#ffe14d" : "#9fd0ff", align: "left",
      });
      text(ctx, TRAPS[trap].name, x + 24, y + 10, {
        font: FONT_MOTOR, size: 13, color: picked.has(trap) ? "#ffe14d" : "#ffffff", align: "left",
      });
    });
    const skip = {
      x: 796, y: 514, w: 76, h: 76,
      onTap: () => {
        g.sound.click();
        this.nextRace();
      },
    };
    g.buttons.add(skip);
    const s = g.buttons.isPressed(skip) ? 0.92 : 1;
    drawCentered(ctx, g.assets.img("but_skip"), 834, 552, 76 * s, 76 * s);
  }

  private leaveTrack(): void {
    const g = this.game;
    if (!this.paidOut) g.state.clearBets();
    g.state.loadWallet();
    if (g.state.money < MIN_LOAD) {
      g.show(new MenuScreen(g));
      return;
    }
    const clock = raceClock();
    if (clock.phase === "betting") {
      g.state.newRace(clock.raceNumber);
      g.show(new BetScreen(g));
      return;
    }
    g.show(new WaitScreen(g));
  }

  private nextRace(): void {
    this.leaveTrack();
  }

  render(ctx: CanvasRenderingContext2D): void {
    const g = this.game;
    g.buttons.clear();
    const run = this.t > GATE_OPEN_T && !this.finished ? 1 : 0.25;
    const leadH = this.horses.reduce((a, h) => (h.prog > a.prog ? h : a));
    const leadCyc = ((leadH.stride % 1) + 1) % 1;
    const bob = Math.sin(leadCyc * Math.PI) * 1.4 * run;
    const mag = this.shake * 7;
    ctx.save();
    ctx.translate(Math.sin(this.t * 53) * mag, bob + Math.cos(this.t * 41) * mag * 0.55);
    if (this.camId === "tight") {
      ctx.translate(640, 460);
      ctx.scale(1.42, 1.42);
      ctx.translate(-560, -470);
    } else if (this.camId === "chase") {
      ctx.translate(640, 500);
      ctx.scale(1.06, 1.06);
      ctx.translate(-700, -500);
    }
    this.drawTrack(ctx);
    const shade = 0.04 + 0.1 * (0.5 + 0.5 * Math.sin(this.cam * 21));
    ctx.fillStyle = `rgba(6, 14, 8, ${shade})`;
    ctx.fillRect(0, 0, 1280, 470);
    this.drawGates(ctx);
    this.drawHorses(ctx);
    if (this.camId === "head" || this.camId === "chase") {
      const lens = ctx.createRadialGradient(640, 430, 160, 640, 430, 780);
      lens.addColorStop(0, "rgba(0,0,0,0)");
      lens.addColorStop(1, "rgba(0,0,0,0.42)");
      ctx.fillStyle = lens;
      ctx.fillRect(0, 0, 1280, 876);
    }
    ctx.restore();
    this.drawHUD(ctx);
    this.drawCamButton(ctx);
    this.drawCorners(ctx);
    this.drawRaceHUD(ctx);
    this.drawArrival(ctx);
    if (this.flash > 0) this.drawWinFlash(ctx);
    this.drawResult(ctx);
  }

  /** A burst on the winner only, not a whiteout of the whole track. */
  private drawWinFlash(ctx: CanvasRenderingContext2D): void {
    const w = this.horses.find((h) => h.trap === this.order[0]);
    if (!w) return;
    const px = PACK_X + (Math.min(1, w.prog) - this.cam) * SPREAD;
    const y = LANE_Y[w.lane] - 70;
    const a = Math.min(1, this.flash);
    const glow = ctx.createRadialGradient(px, y, 8, px, y, 170);
    glow.addColorStop(0, `rgba(255,255,255,${a})`);
    glow.addColorStop(1, "rgba(255,255,255,0)");
    ctx.save();
    ctx.fillStyle = glow;
    ctx.fillRect(px - 180, y - 180, 360, 360);
    ctx.restore();
  }

  pointerDown(): void {}
  pointerUp(): void {}
}
