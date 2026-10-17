// Betting window: 8 horse cards, quick ₱10 / ₱20 taps, and a custom amount
// that only reveals Confirm Bet when the load balance can cover it.
import {
  CURRENCY,
  FONT_DIGI,
  FONT_IMPACT,
  FONT_MOTOR,
  MAX_BET,
  MIN_BET,
  MIN_LOAD,
  HOUSE_TAKE,
  TRAPS,
  fmtMoney,
} from "../constants";
import { Game, Screen } from "../engine";
import { HORSE_A_FRAMES, THUMB_FRAME } from "../horseFrames";
import { text } from "../ui";
import { renderMsgDialog } from "./dialogs";
import { MenuScreen } from "./menu";
import { RaceScreen } from "./race";
import { raceClock } from "../schedule";
import { feed } from "../feed";

const QUICK = [10, 20];

type Card = { trap: number; x: number; y: number; w: number; h: number };

function cards(): Card[] {
  const out: Card[] = [];
  for (let i = 0; i < 8; i++) {
    const col = i < 4 ? 0 : 1;
    const row = i % 4;
    out.push({ trap: col === 0 ? row : row + 4, x: 28 + col * 612, y: 118 + row * 132, w: 592, h: 122 });
  }
  return out;
}

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export class BetScreen implements Screen {
  private warn: string | null = null;
  private selected = -1;
  private lock = 0;
  private locking = false;
  private onConfirm: (() => void) | null = null;
  private onAmount: (() => void) | null = null;
  private pulse = 0;
  private shownTotal = [0, 0, 0, 0, 0, 0, 0, 0];

  constructor(private game: Game) {}

  enter(): void {
    this.game.sound.musicMode = "bet";
    this.game.sound.soundtrack(true);
    this.game.sound.announcer();
    this.warn = null;
    this.selected = -1;
    this.lock = 0;
    this.locking = false;
    this.ensureBar();
    el("bet-bar")?.classList.remove("hidden");
    const amt = el<HTMLInputElement>("bet-amt");
    if (amt) amt.value = "";
    this.onAmount = () => this.refreshBar();
    this.onConfirm = () => this.confirmCustom();
    amt?.addEventListener("input", this.onAmount);
    el("bet-confirm")?.addEventListener("click", this.onConfirm);
    this.refreshBar();
    if (this.game.state.phone) feed.join(this.game.state.phone, this.game.state.raceNumber);
  }

  exit(): void {
    this.game.sound.soundtrack(false);
    this.game.sound.stopAnnouncer();
    el("bet-bar")?.classList.add("hidden");
    if (this.onAmount) el("bet-amt")?.removeEventListener("input", this.onAmount);
    if (this.onConfirm) el("bet-confirm")?.removeEventListener("click", this.onConfirm);
    this.onAmount = null;
    this.onConfirm = null;
  }

  update(dt: number): void {
    const g = this.game;
    const step = Number.isFinite(dt) ? dt : 0.016;
    this.pulse = Math.max(0, this.pulse - step * 2.4);
    for (let i = 0; i < 8; i++) {
      const target = feed.total(i);
      const cur = this.shownTotal[i];
      const next = cur + (target - cur) * Math.min(1, step * 7);
      this.shownTotal[i] = Math.abs(target - next) < 0.05 ? target : next;
    }
    if (g.state.money < MIN_LOAD && g.state.totalBet <= 0) {
      g.show(new MenuScreen(g));
      return;
    }
    const clock = raceClock();
    if (clock.raceNumber !== g.state.raceNumber) {
      g.show(new MenuScreen(g));
      return;
    }
    this.locking = clock.phase === "betting";
    this.lock = clock.countdown;
    if (clock.phase === "racing") g.show(new RaceScreen(g));
  }

  private ensureBar(): void {
    if (el("bet-bar")) return;
    const bar = document.createElement("div");
    bar.id = "bet-bar";
    bar.className = "betbar hidden";
    bar.innerHTML = `
      <div class="betbar-top">
        <span id="bet-horse">Tap a horse</span>
        <span id="bet-bal"></span>
      </div>
      <div class="betbar-row">
        <input id="bet-amt" inputmode="decimal" placeholder="Custom amount" autocomplete="off" />
        <button id="bet-confirm" type="button" class="hidden">CONFIRM BET</button>
      </div>
      <div id="bet-err" class="err"></div>`;
    document.body.appendChild(bar);
  }

  private refreshBar(): void {
    const g = this.game;
    const horse = el("bet-horse");
    const bal = el("bet-bal");
    const err = el("bet-err");
    const btn = el("bet-confirm");
    const amtEl = el<HTMLInputElement>("bet-amt");
    if (horse) horse.textContent = this.selected >= 0 ? TRAPS[this.selected].name : "Tap a horse";
    if (bal) bal.textContent = `LOAD ${CURRENCY}${g.state.money.toFixed(2)}`;
    const raw = amtEl?.value.trim() ?? "";
    const amt = Number(raw);
    const ok =
      this.selected >= 0 &&
      raw !== "" &&
      Number.isFinite(amt) &&
      amt >= MIN_BET &&
      amt <= MAX_BET &&
      amt <= g.state.money + 1e-9;
    btn?.classList.toggle("hidden", !ok);
    if (err) {
      if (!raw || ok) err.textContent = "";
      else if (this.selected < 0) err.textContent = "Tap a horse first.";
      else if (!Number.isFinite(amt) || amt < MIN_BET) err.textContent = `Minimum is ${CURRENCY}${MIN_BET}.`;
      else if (amt > MAX_BET) err.textContent = `Maximum is ${CURRENCY}${MAX_BET}.`;
      else err.textContent = "Not enough load.";
    }
  }

  private confirmCustom(): void {
    const raw = el<HTMLInputElement>("bet-amt")?.value.trim() ?? "";
    const amt = Number(raw);
    if (this.selected < 0) return;
    if (!this.place(this.selected, amt)) return;
    const input = el<HTMLInputElement>("bet-amt");
    if (input) input.value = "";
    this.refreshBar();
  }

  /** Deduct `amount` from the signed-in load and record a win bet on `trap`. */
  /** Multiple from money actually on the board this race, not the odds table. */
  private liveMultiple(trap: number): number {
    const g = this.game;
    const stakes = Array.from({ length: 8 }, (_, i) => Math.max(feed.total(i), g.state.cellAmount("win", i)));
    const total = stakes.reduce((s, n) => s + n, 0);
    const on = stakes[trap];
    if (on <= 0 || total <= 0) return 0;
    return Math.round(((total * (1 - HOUSE_TAKE)) / on) * 100) / 100;
  }

  private place(trap: number, amount: number): boolean {
    const g = this.game;
    const amt = Math.round(amount * 100) / 100;
    if (this.selected < 0) this.selected = trap;
    if (!Number.isFinite(amt) || amt < MIN_BET) {
      this.warn = `Minimum bet is ${CURRENCY}${MIN_BET}.`;
      return false;
    }
    if (amt > MAX_BET || g.state.cellAmount("win", trap) + amt > MAX_BET) {
      this.warn = `Maximum bet on one horse is ${CURRENCY}${MAX_BET}.`;
      return false;
    }
    if (amt > g.state.money + 1e-9) {
      this.warn = "Not enough load.";
      return false;
    }
    const ok = g.state.stake("win", trap, amt);
    if (!ok) {
      this.warn = "Not enough load.";
      return false;
    }
    g.net.placeBet("win", trap, -1, amt);
    feed.post(g.state.raceNumber, trap, TRAPS[trap].name, amt);
    g.sound.chip();
    this.selected = trap;
    this.pulse = 1;
    this.refreshBar();
    return true;
  }

  private corners(ctx: CanvasRenderingContext2D): void {
    const g = this.game;
    const B = g.buttons;
    const mk = (x: number, kind: "fs" | "au" | "x") => {
      const b = {
        x, y: 18, w: 48, h: 48,
        onTap: () => {
          g.sound.click();
          if (kind === "fs") g.fullscreen(!document.fullscreenElement);
          else if (kind === "au") {
            g.sound.setMuted(!g.sound.muted);
            g.state.muted = g.sound.muted;
          } else g.show(new MenuScreen(g));
        },
      };
      B.add(b);
      ctx.fillStyle = "rgba(6,15,36,0.72)";
      ctx.fillRect(b.x, b.y, b.w, b.h);
      const label = kind === "fs" ? "FS" : kind === "au" ? (g.sound.muted ? "OFF" : "ON") : "X";
      text(ctx, label, b.x + 24, b.y + 24, { font: FONT_IMPACT, size: 18, color: "#ffffff" });
    };
    mk(1088, "fs");
    mk(1144, "au");
    mk(1200, "x");
  }

  private drawCard(ctx: CanvasRenderingContext2D, card: Card): void {
    const g = this.game;
    const A = g.assets;
    const trap = card.trap;
    const on = this.selected === trap;
    const pop = on ? 1 + this.pulse * 0.02 : 1;
    const staked = g.state.cellAmount("win", trap);
    ctx.save();
    ctx.translate(card.x + card.w / 2, card.y + card.h / 2);
    ctx.scale(pop, pop);
    ctx.translate(-(card.x + card.w / 2), -(card.y + card.h / 2));
    ctx.fillStyle = on ? "rgba(242,194,0,0.18)" : "rgba(6,16,40,0.78)";
    ctx.strokeStyle = on ? "#ffe14d" : "#2b4d86";
    ctx.lineWidth = on ? 2 + this.pulse * 4 : 2;
    if (on && this.pulse > 0) {
      ctx.shadowColor = "#ffe14d";
      ctx.shadowBlur = 16 * this.pulse;
    }
    ctx.beginPath();
    ctx.roundRect(card.x, card.y, card.w, card.h, 12);
    ctx.fill();
    ctx.stroke();

    const hs = A.img(`horse_${trap + 1}_a`);
    const [fx, fy, fw, fh] = HORSE_A_FRAMES[trap + 1][THUMB_FRAME];
    const th = 78;
    const tw = (th / fh) * fw;
    ctx.drawImage(hs, fx, fy, fw, fh, card.x + 8, card.y + 8, tw, th);
    const sx = (trap % 4) * 72;
    const sy = Math.floor(trap / 4) * 72;
    ctx.drawImage(A.img("bibs"), sx, sy, 72, 72, card.x + 12, card.y + 78, 32, 32);
    text(ctx, `${trap + 1}  ${TRAPS[trap].name}`, card.x + 150, card.y + 36, {
      font: FONT_MOTOR, size: 18, color: "#ffffff", align: "left",
    });
    const price = this.liveMultiple(trap);
    text(ctx, price > 0 ? `PAYS x${price.toFixed(2)}` : "PAYS —", card.x + 150, card.y + 64, {
      font: FONT_DIGI, size: 18, color: "#9fd0ff", align: "left",
    });
    text(ctx, staked > 0 ? `YOU ${fmtMoney(staked)}` : "NO BET", card.x + 150, card.y + 92, {
      font: FONT_IMPACT, size: 18, color: staked > 0 ? "#ffe14d" : "#6d88b0", align: "left",
    });
    text(ctx, `TOTAL ${fmtMoney(this.shownTotal[trap])}`, card.x + card.w - 100, card.y + 108, {
      font: FONT_DIGI, size: 15, color: "#ffffff",
    });

    QUICK.forEach((v, i) => {
      const bx = card.x + card.w - 196 + i * 94;
      const by = card.y + 32;
      const can = g.state.money + 1e-9 >= v && staked + v <= MAX_BET;
      const b = { x: bx, y: by, w: 86, h: 58, onTap: () => { if (!this.place(trap, v)) return; } };
      g.buttons.add(b);
      ctx.fillStyle = can ? "#f2c200" : "#3a4258";
      ctx.beginPath();
      ctx.roundRect(bx, by, 86, 58, 8);
      ctx.fill();
      text(ctx, String(v), bx + 43, by + 30, {
        font: FONT_IMPACT, size: 26, color: can ? "#1a1a1a" : "#9aa4b8",
      });
    });

    g.buttons.add({
      x: card.x, y: card.y, w: card.w - 200, h: card.h,
      onTap: () => {
        g.sound.click();
        this.selected = trap;
        this.pulse = 1;
        this.refreshBar();
      },
    });
    ctx.restore();
  }

  render(ctx: CanvasRenderingContext2D): void {
    const g = this.game;
    const A = g.assets;
    ctx.drawImage(A.img("bg_bet_panel"), 0, 0, 1280, 876);
    ctx.fillStyle = "rgba(2,8,23,0.35)";
    ctx.fillRect(0, 0, 1280, 876);

    g.buttons.clear();
    text(ctx, "BETTING WINDOW", 36, 42, { font: FONT_IMPACT, size: 36, color: "#ffffff", align: "left" });
    text(ctx, `LOAD ${fmtMoney(g.state.money)}`, 36, 78, {
      font: FONT_DIGI, size: 26, color: "#ffe14d", align: "left",
    });
    if (this.locking) {
      const s = Math.max(0, Math.ceil(this.lock));
      const label = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      text(ctx, `RACE ${g.state.raceNumber}  IN ${label}   ONLINE ${feed.online}`, 760, 48, {
        font: FONT_DIGI, size: 22, color: "#ffe14d",
      });
      text(ctx, "BET OR JUST WATCH", 700, 78, {
        font: FONT_MOTOR, size: 16, color: "#9fd0ff",
      });
    } else {
      text(ctx, "RACE STARTING", 700, 58, { font: FONT_DIGI, size: 26, color: "#ffe14d" });
    }

    const clear = {
      x: 900, y: 28, w: 160, h: 40,
      onTap: () => {
        if (g.state.totalBet <= 0) return;
        g.sound.click();
        g.state.clearBets();
        g.net.clearBets();
        feed.clear(g.state.raceNumber);
        this.locking = false;
        this.lock = 0;
        this.refreshBar();
      },
    };
    g.buttons.add(clear);
    ctx.fillStyle = "#14284d";
    ctx.beginPath();
    ctx.roundRect(clear.x, clear.y, clear.w, clear.h, 8);
    ctx.fill();
    text(ctx, "CLEAR BET", clear.x + 80, clear.y + 20, { font: FONT_IMPACT, size: 20, color: "#ffffff" });

    for (const card of cards()) this.drawCard(ctx, card);
    this.corners(ctx);
    this.refreshBar();

    if (this.warn) {
      const w = this.warn;
      renderMsgDialog(ctx, g, g.buttons, w, () => { this.warn = null; });
    }
  }

  pointerDown(): void {}
  pointerUp(): void {}
}
