// Main menu: bg, logo, play, info/fullscreen/audio corners, credits dialog.
import { CURRENCY, FONT_MOTOR, MIN_LOAD } from "../constants";
import { Game, Screen } from "../engine";
import { Auth } from "../auth";
import { raceClock } from "../schedule";
import { drawCentered, drawStateHalf, text } from "../ui";
import { renderCreditsDialog } from "./dialogs";
import { AdminPanel } from "./admin";
import { BetScreen } from "./bet";
import { WaitScreen } from "./wait";
import { LoginScreen } from "./login";

export class MenuScreen implements Screen {
  private showCredits = false;
  private gateMsg: string | null = null;

  constructor(private game: Game) {}

  enter(): void {
    // Menu stays quiet: BGM + narration belong to the betting phase.
    this.game.sound.musicMode = "bgm";
    this.game.sound.soundtrack(false);
  }

  exit(): void {
    this.game.sound.soundtrack(false);
  }

  update(): void {}

  private topButtons(ctx: CanvasRenderingContext2D): void {
    const g = this.game;
    const B = g.buttons;
    const info = { x: 17, y: 55, w: 55, h: 56, onTap: () => { g.sound.click(); this.showCredits = true; } };
    B.add(info);
    const fs = { x: 89, y: 55, w: 55, h: 56, onTap: () => this.toggleFullscreen() };
    B.add(fs);
    const au = { x: 1208, y: 55, w: 55, h: 56, onTap: () => this.toggleAudio() };
    B.add(au);

    const draw = (b: typeof info, kind: "info" | "fs" | "au") => {
      const s = B.isPressed(b) ? 0.92 : 1;
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(s, s);
      ctx.translate(-cx, -cy);
      if (kind === "info") ctx.drawImage(g.assets.img("but_credits"), b.x, b.y, b.w, b.h);
      else if (kind === "fs") drawStateHalf(ctx, g.assets, "but_fullscreen", document.fullscreenElement ? 1 : 0, b.x, b.y);
      else drawStateHalf(ctx, g.assets, "audio_icon", g.sound.muted ? 1 : 0, b.x, b.y);
      ctx.restore();
    };
    draw(info, "info");
    draw(fs, "fs");
    draw(au, "au");
  }

  private toggleFullscreen(): void {
    this.game.sound.click();
    this.game.fullscreen(!document.fullscreenElement);
  }

  private toggleAudio(): void {
    this.game.sound.click();
    this.game.sound.setMuted(!this.game.sound.muted);
    this.game.state.muted = this.game.sound.muted;
  }

  render(ctx: CanvasRenderingContext2D): void {
    const g = this.game;
    const A = g.assets;
    ctx.drawImage(A.img("bg_menu"), 0, 0, 1280, 876);
    drawCentered(ctx, A.img("logo_menu"), 640, 86, 754, 116);

    // Logged-in wallet line.
    const me = g.state.phone ? Auth.getUser(g.state.phone) : undefined;
    if (me) {
      text(ctx, `${me.phone}  •  ${CURRENCY}${me.balance.toFixed(2)}`, 640, 178, {
        font: FONT_MOTOR, size: 22, color: "#ffe14d",
        stroke: "#000000", strokeWidth: 4,
      });
    }

    g.buttons.clear();
    const play = {
      x: 586, y: 692, w: 107, h: 108,
      onTap: () => {
        g.sound.click();
        g.state.loadWallet();
        if (g.state.money < MIN_LOAD) {
          this.gateMsg = `NEED ${CURRENCY}${MIN_LOAD} TO ENTER THE TRACK`;
          return;
        }
        this.gateMsg = null;
        const clock = raceClock();
        if (clock.phase === "racing") {
          g.show(new WaitScreen(g));
          return;
        }
        g.state.newRace(clock.raceNumber);
        g.show(new BetScreen(g));
      },
    };
    g.buttons.add(play);
    const ps = g.buttons.isPressed(play) ? 0.92 : 1;
    drawCentered(ctx, A.img("but_play"), 640, 746, 107 * ps, 108 * ps);
    if (this.gateMsg) {
      text(ctx, this.gateMsg, 640, 640, {
        font: FONT_MOTOR, size: 22, color: "#ff7b7b",
        stroke: "#000000", strokeWidth: 4,
      });
    }

    this.topButtons(ctx);
    this.accountButtons(ctx, me?.role === "admin");

    if (this.showCredits) {
      renderCreditsDialog(ctx, g, g.buttons, () => {
        this.showCredits = false;
      });
    }
  }

  /** LOGOUT pill (bottom-left) + ADMIN pill (bottom-right, admins only). */
  private accountButtons(ctx: CanvasRenderingContext2D, isAdmin: boolean): void {
    const g = this.game;
    const pill = (
      x: number, label: string, onTap: () => void,
    ) => {
      const b = { x, y: 792, w: 150, h: 52, onTap };
      g.buttons.add(b);
      const s = g.buttons.isPressed(b) ? 0.94 : 1;
      ctx.save();
      ctx.translate(x + 75, 818);
      ctx.scale(s, s);
      ctx.translate(-(x + 75), -818);
      ctx.fillStyle = "rgba(4, 12, 30, 0.85)";
      ctx.strokeStyle = "#2b4d86";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(x, 792, 150, 52, 10);
      ctx.fill();
      ctx.stroke();
      text(ctx, label, x + 75, 819, { font: FONT_MOTOR, size: 20, color: "#9fd0ff" });
      ctx.restore();
    };
    pill(17, "LOGOUT", () => {
      g.sound.click();
      g.state.clearBets();
      g.state.phone = null;
      Auth.clearSession();
      g.show(new LoginScreen(g));
    });
    if (isAdmin) {
      pill(1113, "ADMIN", () => {
        g.sound.click();
        AdminPanel.open(g);
      });
    }
  }

  pointerDown(): void {}
  pointerUp(): void {}
}
