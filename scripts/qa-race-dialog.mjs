// QA helper: render the race result dialog states straight from the game code
// (no live race needed) and capture the canvas. Not part of the app build.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = new URL("../screenshots/qa/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME });
const page = await browser.newPage({ viewport: { width: 1280, height: 876 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto("http://127.0.0.1:8080/", { waitUntil: "load" });
await page.waitForFunction(() => !!window.__game, null, { timeout: 60000 });
// Drop the intro video and freeze the game loop so the frame we draw is the
// frame that gets captured.
await page.locator("#intro-skip").click({ timeout: 10000 }).catch(() => {});
await page.waitForTimeout(600);
await page.evaluate(() => window.__game.stop());
await page.evaluate(() => {
  for (const id of ["auth-overlay", "bet-bar", "admin-overlay", "intro-overlay"]) {
    document.getElementById(id)?.remove();
  }
});
await page.waitForFunction(() => window.__game.assets.progress >= 1, null, { timeout: 120000 });
await page.waitForTimeout(500);

const cases = ["nobets", "lose", "win"];
for (const mode of cases) {
  await page.evaluate(async (mode) => {
    const g = window.__game;
    const { RaceScreen } = await import("/src/karera/game/screens/race.ts");
    g.state.phone = "09123456789";
    g.state.money = 1000;
    g.state.bets = [];
    const s = new RaceScreen(g, 60);
    const winner = s.order[0];
    if (mode === "win") {
      g.state.bets = [{ kind: "win", a: winner, b: 0, amount: 100 }];
      s.payout = 61.25;
      s.poolTotal = 340.5;
    } else if (mode === "lose") {
      const loser = s.order[3];
      g.state.bets = [{ kind: "win", a: loser, b: 0, amount: 100 }];
      s.payout = 0;
      s.poolTotal = 340.5;
    }
    s.dialogAt = 1;
    s.arrivalT = 1;
    s.finished = true;
    g.sound.muted = true;
    const k = g.canvas.width / 1280;
    g.ctx.setTransform(k, 0, 0, k, 0, 0);
    g.ctx.fillStyle = "#000";
    g.ctx.fillRect(0, 0, 1280, 876);
    s.render(g.ctx);
  }, mode);
  await page.waitForTimeout(200);
  await page.locator("#game").screenshot({ path: `${OUT}real-${mode}.png` });
  console.log("captured", mode);
}

await browser.close();
