// Shared mutable game state + per-race odds generation.
import {
  BetCell,
  CHIP_VALUES,
  MAX_BET,
  MIN_BET,
  Odds,
  TRAPS,
  fmtOdds,
} from "./constants";
import { mulberry32 } from "./schedule";
import { Auth } from "./auth";
import { Pool } from "./parimutuel";

export { fmtOdds };

export class GameState {
  /** Shared race everyone is on. 0 until they enter the track. */
  raceNumber = 0;
  phone: string | null = null;
  private _money = 0;
  bets: BetCell[] = [];
  selectedChip = 0; // index into CHIP_VALUES
  betPage: 0 | 1 = 0;
  odds: Odds = freshOdds();
  /** per-horse strength 0..1 (higher = faster), regenerated per race */
  strength: number[] = [];
  /** live pari-mutuel WIN pool (crowd + this player's stakes) */
  pool: Pool = new Pool([]);
  muted = true;
  /** last chip index used per cell, for the chip icon */
  cellChip = new Map<string, number>();

  constructor() {
    this.newRace();
  }

  /** Wallet balance. Every write persists to the logged-in user's account. */
  get money(): number {
    return this._money;
  }
  set money(v: number) {
    const next = Math.max(0, Math.round(v * 100) / 100);
    const delta = Math.round((next - this._money) * 100) / 100;
    this._money = next;
    if (this.phone && delta !== 0) Auth.pushDelta(this.phone, delta);
  }

  /** Pull the live wallet. Never invents a starting balance. */
  loadWallet(): void {
    if (!this.phone) return;
    const u = Auth.getUser(this.phone);
    if (u && Auth.pending() === 0) this._money = Math.round(u.balance * 100) / 100;
    Auth.watch(this.phone, (b) => {
      if (Auth.pending() !== 0) return;
      this._money = Math.max(0, Math.round(b * 100) / 100);
    });
    void Auth.refresh();
  }

  get chipValue(): number {
    return CHIP_VALUES[this.selectedChip];
  }

  get totalBet(): number {
    return this.bets.reduce((s, b) => s + b.amount, 0);
  }

  cellAmount(kind: BetCell["kind"], a: number, b = -1): number {
    let s = 0;
    for (const c of this.bets) {
      if (c.kind === kind && c.a === a && (kind !== "forecast" || c.b === b)) s += c.amount;
    }
    return s;
  }

  /** Place an exact stake if the wallet covers it. Deducts the load balance. */
  stake(kind: BetCell["kind"], a: number, amount: number, b = -1): boolean {
    const v = Math.round(amount * 100) / 100;
    if (!Number.isFinite(v) || v < MIN_BET) return false;
    if (this.money < v) return false;
    if (this.cellAmount(kind, a, b) + v > MAX_BET) return false;
    const ex = this.bets.find((c) => c.kind === kind && c.a === a && (kind !== "forecast" || c.b === b));
    if (ex) ex.amount += v;
    else this.bets.push({ kind, a, b, amount: v });
    this.money -= v;
    if (kind === "win") this.pool.addPlayer(a, v);
    return true;
  }

  /** Attempt to add the selected chip to a cell. Returns false when blocked. */
  addBet(kind: BetCell["kind"], a: number, b = -1): boolean {
    const v = this.chipValue;
    if (this.money < v) return false;
    if (this.cellAmount(kind, a, b) + v > MAX_BET) return false;
    const ex = this.bets.find((c) => c.kind === kind && c.a === a && (kind !== "forecast" || c.b === b));
    if (ex) ex.amount += v;
    else this.bets.push({ kind, a, b, amount: v });
    this.cellChip.set(`${kind}:${a}:${b}`, this.selectedChip);
    this.money -= v;
    // WIN stakes join the pari-mutuel pool (crowd + player).
    if (kind === "win") this.pool.addPlayer(a, v);
    return true;
  }

  cellChipIdx(kind: BetCell["kind"], a: number, b = -1): number {
    return this.cellChip.get(`${kind}:${a}:${b}`) ?? 0;
  }

  clearBets(): void {
    for (const c of this.bets) this.money += c.amount;
    this.bets = [];
    this.cellChip.clear();
    this.pool.resetPlayer();
  }

  canStart(): boolean {
    return this.totalBet >= MIN_BET;
  }

  /** Reset bets/odds/pool for the shared race number. */
  newRace(raceNumber = this.raceNumber): void {
    this.raceNumber = raceNumber;
    const rnd = mulberry32((raceNumber || 1) * 9973 + 1);
    this.bets = [];
    this.cellChip.clear();
    this.betPage = 0;
    this.selectedChip = 0;
    this.strength = Array.from({ length: 8 }, () => rnd());
    this.odds = freshOdds(this.strength, rnd);
    this.pool = new Pool(this.strength);
  }

  trapName(i: number): string {
    return TRAPS[i].name;
  }
}

/** Generate odds correlated with strength: strong horses pay little. */
export function freshOdds(strength?: number[], rnd: () => number = Math.random): Odds {
  const s = strength ?? Array.from({ length: 8 }, () => rnd());
  const jit = () => 0.92 + rnd() * 0.16;
  const win = s.map((v) => Math.max(1.05, (1.15 + Math.pow(1 - v, 1.6) * 15.5) * jit()));
  const place = s.map((v) => Math.max(1.0, (1.05 + Math.pow(1 - v, 1.4) * 6.2) * jit()));
  const show = s.map((v) => Math.max(1.0, (1.02 + Math.pow(1 - v, 1.3) * 2.9) * jit()));
  const forecast: number[][] = [];
  for (let a = 0; a < 8; a++) {
    forecast[a] = [];
    for (let b = 0; b < 8; b++) {
      if (a === b) {
        forecast[a][b] = -1;
        continue;
      }
      const v = Math.max(4, win[a] * (1.6 + win[b] * 0.55) * (0.85 + Math.random() * 0.3));
      forecast[a][b] = Math.round(v * 4) / 4;
    }
  }
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    win: win.map(r2),
    place: place.map(r2),
    show: show.map(r2),
    forecast,
  };
}
