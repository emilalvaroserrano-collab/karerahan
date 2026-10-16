// Shared constants: design space, config, trap data. Layout numbers were measured
// from the original at 1440x900 (scale 1.125) and converted to 1280x876 space.

export const DESIGN_W = 1280;
export const DESIGN_H = 876;

export const FONT_IMPACT = "impactregular";
export const FONT_DIGI = "ds-digitalbold";
export const FONT_MOTOR = "motorwerkregular";

export const MIN_BET = 1;
export const MAX_BET = 100;
/** Minimum load required to stay in the race-track portal. */
export const MIN_LOAD = 10;
export const START_MONEY = 100;
export const CHIP_VALUES = [1, 5, 10, 25, 50, 100];
export const WIN_OCCURRENCE = 0.4; // chance a player-backed horse is forced to win
/** Bangka cut taken off the top of every locked WIN pool (never loses). */
export const HOUSE_TAKE = 0.1;
/** Seconds the betting window stays open before a race auto-starts. */
export const BET_WINDOW_S = 60;
/** Peso sign used across wallet/pool/payout readouts. */
export const CURRENCY = "₱";

export interface TrapInfo {
  name: string;
  /** saddlecloth/badge color */
  color: string;
  /** number glyph color on the badge */
  numColor: string;
}

export const TRAPS: TrapInfo[] = [
  { name: "CAGAYAN KICK", color: "#d31f26", numColor: "#ffffff" },
  { name: "BICOL TIGIDIG", color: "#e8e8e8", numColor: "#1a1a1a" },
  { name: "CEBU GALOPO", color: "#1f5fd3", numColor: "#ffffff" },
  { name: "DAVAO DAGAN", color: "#f2c200", numColor: "#1a1a1a" },
  { name: "BAGUIO TAKBO", color: "#1d9e48", numColor: "#ffffff" },
  { name: "ABRA KIDLAT", color: "#151515", numColor: "#f2c200" },
  { name: "BOHOL SIKAD", color: "#ef7d7d", numColor: "#1a1a1a" },
  { name: "ILOCOS KARERA", color: "#ef7d1a", numColor: "#1a1a1a" },
];

export type BetKind = "win" | "place" | "show" | "forecast";

export interface BetCell {
  kind: BetKind;
  /** trap index 0..7 (for forecast: winner pick) */
  a: number;
  /** forecast only: runner-up pick */
  b: number;
  amount: number;
}

export interface Odds {
  win: number[];
  place: number[];
  show: number[];
  /** forecast[a][b], -1 when a === b */
  forecast: number[][];
}

export interface RaceResult {
  /** trap indices in finish order, first = winner */
  order: number[];
  payout: number;
}

export function fmtOdds(v: number): string {
  const r = Math.round(v * 100) / 100;
  return String(r);
}

export function fmtMoney(v: number): string {
  return `${CURRENCY}${v.toFixed(2)}`;
}
