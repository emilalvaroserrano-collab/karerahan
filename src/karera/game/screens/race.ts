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
  WIN_OCCURRENCE,
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
import { TRACK_SHIFT } from "../trackShift";

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
/** Portion of each pose hold spent crossfading into the next pose. */
const A_BLEND = 0.3;

interface Dust {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
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
  /** Final WIN dividend for this race's winner (stake × dividend). */
  private div = 0;
  /** Local fixed-odds bets pay the posted price instead of the server pool. */
  private useOdds = false;
  /** Broadcast HUD: frozen winning clock + smoothed speed readout. */
  private winClock = 0;
  private prevProg = 0;
  private dispSpeed = 58;
  private snapped = false;
  /** Gate-open and photo-finish kick. Decays to 0. */
  private shake = 0;
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
    const mine = this.playerBets();
    const total = mine.reduce((s, b) => s + b.amount, 0);
    this.poolTotal = total;
    const winBets = mine.filter((b) => b.kind === "win");
    const winTotal = winBets.reduce((s, b) => s + b.amount, 0);
    this.div = winTotal > 0 ? (total * (1 - HOUSE_TAKE)) / winTotal : 0;
    this.useOdds = this.game.state.bets.length > 0;
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

  private decideRace(): void {
    const st = this.game.state;
    const n = 8;
    // Winner: 40% a player-backed horse (stake-weighted), else strength-weighted.
    const backed = new Map<number, number>();
    const source = st.bets.length
      ? st.bets
      : (this.game.net.state?.bets ?? []);
    for (const b of source) {
      if (b.kind === "forecast") {
        backed.set(b.a, (backed.get(b.a) ?? 0) + b.amount * 0.6);
        backed.set(b.b, (backed.get(b.b) ?? 0) + b.amount * 0.4);
      } else {
        backed.set(b.a, (backed.get(b.a) ?? 0) + b.amount);
      }
    }
    const wPick = (weights: number[]): number => {
      let s = weights.reduce((a, b) => a + b, 0);
      let r = Math.random() * s;
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i];
        if (r <= 0) return i;
      }
      return weights.length - 1;
    };
    let winner: number;
    const backedTraps = [...backed.entries()].filter(([, v]) => v > 0);
    if (backedTraps.length > 0 && Math.random() < WIN_OCCURRENCE) {
      winner = wPick(backedTraps.map(([, v]) => v));
      winner = backedTraps[winner][0];
    } else {
      winner = wPick(st.strength.map((s) => 0.15 + s));
    }
    // Remaining places by strength + noise.
    const rest = Array.from({ length: n }, (_, i) => i)
      .filter((i) => i !== winner)
      .sort((a, b) => st.strength[b] + Math.random() * 0.5 - (st.strength[a] + Math.random() * 0.5));
    this.order = [winner, ...rest];
    // Long race: winner crosses at ~38-46s, pack trails to ~52s
    // (double the original ~19-26s window).
    const T0 = 38 + Math.random() * 8;
    const times = new Array<number>(n);
    this.order.forEach((trap, place) => {
      times[trap] = T0 + (place === 0 ? 0 : 0.36 + place * 0.64 + Math.random() * 0.7);
    });
    this.horses = Array.from({ length: n }, (_, trap) => ({
      trap,
      lane: trap % 8,
      T: times[trap],
      // Small jostle: ±0.008..0.016 progress (≈20-40px on screen), 1-2
      // surges per race. Derivative stays well below base speed (1/T),
      // so motion is always forward but close horses can swap places.
      wobAmp: 0.008 + Math.random() * 0.008,
      wobK: 1 + Math.floor(Math.random() * 2),
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
    // Let winners run ~12% past the line while the arrival panel slides in;
    // the camera stays pinned at 1 so they pull ahead instead of freezing.
    if (u >= 1) return Math.min(1.12, u);
    // Mid-race jostle, zero at start/finish so exact start grid and exact
    // finish order/times are preserved.
    const env = Math.sin(Math.PI * u);
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
    this.game.sound.beginRace();
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
      const marks: [number, number][] = h.lane >= 5
        ? [[0.02, 0.5], [0.28, 1], [0.52, 0.45], [0.78, 0.85]]
        : [[0.28, 0.3]];
      if (runT > 0.15 && h.prog < 1.05) {
        for (const [mark, accent] of marks) {
          const hit = (prev < mark && cyc >= mark)
            || (mark < 0.1 && prev > 0.85 && cyc < 0.2);
          if (!hit) continue;
          const near = 0.35 + 0.65 * (h.lane / 7);
          this.game.sound.hoof(accent * near * gait * 0.55);
        }
      }
      const crossed = prev < 0.33 && cyc >= 0.33;
      if (crossed && this.t > GATE_OPEN_T && this.dust.length < 80) {
        const s = LANE_S[h.lane];
        const px = PACK_X + (h.prog - this.cam) * SPREAD;
        this.dust.push({
          x: px - 88 * s,
          y: LANE_Y[h.lane] + 2,
          vx: -140 - Math.random() * 80,
          vy: -8 - Math.random() * 10,
          life: 0,
          maxLife: 0.55 + Math.random() * 0.3,
          size: (7 + Math.random() * 6) * s,
        });
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

    const leader = Math.max(...this.horses.map((h) => h.prog));
    // Broadcast speed readout: leader pace smoothed (typical gallop reads
    // high-50s; burst/slow-mo swing it either way).
    if (!this.finished) {
      const vel = sdt > 0.0001 ? (leader - this.prevProg) / sdt : 0;
      const target = Math.max(42, Math.min(78, 52 + vel * 260));
      this.dispSpeed += (target - this.dispSpeed) * Math.min(1, dt * 3);
    }
    this.prevProg = leader;
    // Camera tracks the capped leader (finish line pins at 1) with a tighter
    // time constant than before so the pack doesn't swim around center.
    const leaderCapped = Math.min(1, leader);
    if (!this.snapped) {
      this.cam = leaderCapped;
      this.snapped = true;
    } else {
      this.cam += (leaderCapped - this.cam) * Math.min(1, dt * 2.2);
    }

    if (this.t > GATE_OPEN_T) {
      this.gatesGone = Math.min(1, this.gatesGone + dt / 2.0);
      if (!this.gatesOpened) {
        this.gatesOpened = true;
        this.shake = Math.max(this.shake, 1);
      }
    }
    const rush = this.finished
      ? Math.max(0, 1 - this.arrivalT / 2.2)
      : Math.max(0, Math.min(1, (leader - 0.72) / 0.28));
    this.game.sound.setCheer(rush);

    // Photo finish on first crosser: brief slow-mo like the original, then
    // release. Race still lands in the ~38-52s window.
    if (!this.finished && leader >= 1) {
      this.finished = true;
      this.flash = 1;
      this.shake = Math.max(this.shake, 1.15);
      this.winClock = Math.max(0, this.t - GATE_OPEN_T);
      this.game.sound.photo();
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
    const st = this.game.state;
    const o = this.order;
    const myBets = this.playerBets();
    let pay = 0;
    const each = (fn: (b: BetCell) => number) => {
      for (const b of myBets) pay += fn(b);
    };
    each((b) => {
      const odds = st.odds;
      if (b.kind === "win") {
        if (b.a !== o[0]) return 0;
        const price = this.useOdds ? st.odds.win[b.a] : this.div;
        return b.amount * price;
      }
      if (b.kind === "place") return b.a === o[0] || b.a === o[1] ? b.amount * odds.place[b.a] : 0;
      if (b.kind === "show") return b.a === o[0] || b.a === o[1] || b.a === o[2] ? b.amount * odds.show[b.a] : 0;
      return b.a === o[0] && b.b === o[1] ? b.amount * odds.forecast[b.a][b.b] : 0;
    });
    return Math.round(pay * 100) / 100;
  }

  /** "POOL ₱1,000 • PAYS x1.80" transparency line for the result dialog. */
  private poolLine(): string {
    if (this.useOdds) {
      const price = this.game.state.odds.win[this.order[0]] ?? 0;
      return `WINNER PAYS x${price.toFixed(2)}`;
    }
    return `POOL ${fmtMoney(this.poolTotal)} • PAYS x${this.div.toFixed(2)}`;
  }

  // ---------- drawing ----------

  private badge(ctx: CanvasRenderingContext2D, trap: number, cx: number, cy: number, size: number): void {
    const sx = (trap % 4) * 72;
    const sy = Math.floor(trap / 4) * 72;
    ctx.drawImage(this.game.assets.img("bibs"), sx, sy, 72, 72, cx - size / 2, cy - size / 2, size, size);
  }

  private drawTrack(ctx: CanvasRenderingContext2D): void {
    // Slide from each bg_track frame into the next one, so the dirt scrolls.
    const pos = Math.max(0, Math.min(186.999, this.cam * 187));
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
      const b = this.game.assets.trackFrame(i + 1);
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
    for (const d of this.dust) {
      const k = d.life / d.maxLife;
      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.globalAlpha = 0.38 * (1 - k);
      ctx.fillStyle = "#c4a27a";
      ctx.scale(2.4 + k * 3.2, 0.38);
      ctx.beginPath();
      ctx.arc(0, 0, d.size * (0.7 + 0.5 * k), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    const order = [...this.horses].sort((a, b) => a.lane - b.lane);
    for (const h of order) {
      const sheet = HORSE_A_FRAMES[h.trap + 1];
      const cyc = ((h.stride % 1) + 1) % 1;
      const f = cyc * A_CYCLE.length;
      const fi = Math.min(A_CYCLE.length - 1, Math.floor(f));
      const i0 = A_CYCLE[fi];
      const i1 = A_CYCLE[(fi + 1) % A_CYCLE.length];
      const frac = f - Math.floor(f);
      const blend = Math.max(0, Math.min(1, (frac - (1 - A_BLEND)) / A_BLEND));
      const s = 0.55 + (LANE_S[h.lane] - 0.55) * ease;
      const yBase = LANE_Y[h.lane];
      const k = A_SCALE * s;
      const ph = 2 * Math.PI * cyc;
      const bob = Math.sin(ph + 0.9) * 2.0 * s;
      const px = PACK_X + (h.prog - this.cam) * SPREAD;
      const stallX = 8 + (7 - h.trap) * 28 + 100;
      const x = stallX + (px - stallX) * ease;
      if (x < -450 || x > 1550) continue;
      const stretch = 1 + Math.min(0.07, Math.max(0, this.gain[h.trap] * 90));
      const [ax, ay, aw, ah] = sheet[i0];
      const dw0 = aw * k * stretch;
      const dh0 = ah * k;
      const hx = x + (stretch - 1) * dw0 * 0.22;
      const blur = h.lane <= 1 ? "blur(1.15px)" : h.lane === 2 ? "blur(0.45px)" : "none";
      ctx.save();
      ctx.filter = blur;
      ctx.fillStyle = `rgba(40, 24, 10, ${0.18 + h.lane * 0.035})`;
      ctx.beginPath();
      ctx.ellipse(hx, yBase + 2, dw0 * 0.28, 5 + h.lane * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.18;
      ctx.drawImage(
        A.img(`horse_${h.trap + 1}_a`),
        ax, ay, aw, ah, hx - 12 * s - dw0 / 2, yBase - dh0 + bob, dw0, dh0,
      );
      ctx.globalAlpha = 1;
      ctx.drawImage(
        A.img(`horse_${h.trap + 1}_a`),
        ax, ay, aw, ah, hx - dw0 / 2, yBase - dh0 + bob, dw0, dh0,
      );
      if (blend > 0) {
        const [bx, by, bw, bh] = sheet[i1];
        const dw1 = bw * k * stretch;
        const dh1 = bh * k;
        ctx.globalAlpha = blend;
        ctx.drawImage(
          A.img(`horse_${h.trap + 1}_a`),
          bx, by, bw, bh, hx - dw1 / 2, yBase - dh1 + bob, dw1, dh1,
        );
      }
      ctx.filter = "none";
      ctx.restore();
    }
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
    const betted = this.playerBets().length > 0;
    const win = betted && this.payout > 0;
    drawDim(ctx);
    drawPanelBox(ctx, g, win ? "win" : "lose");
    if (win) {
      text(ctx, "You Win", DLG_CX, 266, { font: FONT_IMPACT, size: 49, color: "#ffe14d" });
      this.order.slice(0, 3).forEach((trap, i) => {
        this.badge(ctx, trap, 660, 340 + i * 62, 52);
      });
      text(ctx, `WIN: ${fmtMoney(this.payout)}`, 640, 545, {
        font: FONT_IMPACT, size: 34, color: "#ffffff",
      });
      text(ctx, this.poolLine(), 640, 578, {
        font: FONT_MOTOR, size: 17, color: "#ffe14d",
      });
    } else if (betted) {
      text(ctx, "You Loose!", DLG_CX, 250, { font: FONT_IMPACT, size: 46, color: "#ffffff" });
      text(ctx, "Your luck might be on the next race!", DLG_CX, 292, {
        font: FONT_MOTOR, size: 16, color: "#ffd0d0",
      });
      this.order.slice(0, 3).forEach((trap, i) => {
        this.badge(ctx, trap, [498, 631, 760][i], 400, 62);
      });
    } else {
      text(ctx, "RACE OVER", DLG_CX, 266, { font: FONT_IMPACT, size: 44, color: "#ffffff" });
      this.order.slice(0, 3).forEach((trap, i) => {
        this.badge(ctx, trap, [498, 631, 760][i], 407, 62);
      });
    }
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
    const bob = Math.sin(this.t * 13.5) * 2.2 * run;
    const mag = this.shake * 7;
    ctx.save();
    ctx.translate(Math.sin(this.t * 53) * mag, bob + Math.cos(this.t * 41) * mag * 0.55);
    this.drawTrack(ctx);
    const shade = 0.04 + 0.1 * (0.5 + 0.5 * Math.sin(this.cam * 21));
    ctx.fillStyle = `rgba(6, 14, 8, ${shade})`;
    ctx.fillRect(0, 0, 1280, 470);
    this.drawGates(ctx);
    this.drawHorses(ctx);
    ctx.restore();
    this.drawHUD(ctx);
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
