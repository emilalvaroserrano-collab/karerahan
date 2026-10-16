// Lobby when the single shared race is already running.
// The player waits here for the next betting window, or watches.
import { CURRENCY, FONT_DIGI, FONT_IMPACT, FONT_MOTOR, MIN_LOAD } from "../constants";
import { Game, Screen } from "../engine";
import { raceClock } from "../schedule";
import { text } from "../ui";
import { BetScreen } from "./bet";
import { MenuScreen } from "./menu";
import { RaceScreen } from "./race";
import { feed } from "../feed";

export class WaitScreen implements Screen {
  constructor(private game: Game) {}

  enter(): void {
    this.game.sound.musicMode = "bgm";
    this.game.sound.soundtrack(false);
    const phone = this.game.state.phone;
    if (phone) feed.join(phone, raceClock().raceNumber);
  }
  exit(): void {}

  update(): void {
    const g = this.game;
    if (g.state.money < MIN_LOAD) {
      g.show(new MenuScreen(g));
      return;
    }
    const clock = raceClock();
    if (clock.phase === "betting") {
      g.state.newRace(clock.raceNumber);
      g.show(new BetScreen(g));
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    const g = this.game;
    const clock = raceClock();
    ctx.drawImage(g.assets.img("bg_bet_panel"), 0, 0, 1280, 876);
    ctx.fillStyle = "rgba(2,8,23,0.55)";
    ctx.fillRect(0, 0, 1280, 876);

    g.buttons.clear();
    text(ctx, "RACE IN PROGRESS", 640, 280, { font: FONT_IMPACT, size: 54, color: "#ffffff" });
    text(ctx, `RACE ${clock.raceNumber}   ·   ONLINE ${feed.online}`, 640, 340, { font: FONT_DIGI, size: 28, color: "#9fd0ff" });
    const s = Math.max(0, Math.ceil(clock.nextIn));
    const label = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    text(ctx, `NEXT RACE IN ${label}`, 640, 400, { font: FONT_DIGI, size: 36, color: "#ffe14d" });
    text(ctx, "You can watch, or wait to bet on the next one.", 640, 460, {
      font: FONT_MOTOR, size: 22, color: "#ffffff",
    });
    text(ctx, `LOAD ${CURRENCY}${g.state.money.toFixed(2)}`, 640, 510, {
      font: FONT_DIGI, size: 24, color: "#ffe14d",
    });

    const watch = {
      x: 490, y: 560, w: 300, h: 64,
      onTap: () => {
        g.sound.click();
        g.show(new RaceScreen(g, clock.raceT));
      },
    };
    g.buttons.add(watch);
    ctx.fillStyle = "#f2c200";
    ctx.beginPath();
    ctx.roundRect(watch.x, watch.y, watch.w, watch.h, 10);
    ctx.fill();
    text(ctx, "WATCH", 640, 592, { font: FONT_IMPACT, size: 28, color: "#1a1a1a" });

    const back = {
      x: 540, y: 650, w: 200, h: 48,
      onTap: () => {
        g.sound.click();
        g.show(new MenuScreen(g));
      },
    };
    g.buttons.add(back);
    text(ctx, "LEAVE", 640, 674, { font: FONT_MOTOR, size: 20, color: "#9fd0ff" });
  }

  pointerDown(): void {}
  pointerUp(): void {}
}
