// Ad-hoc render check (dev + built output, desktop + mobile): confirms the
// canvas paints real content and the console is clean. Temporary.
import { chromium } from "playwright";

const targets = [
  { name: "dev", url: "http://127.0.0.1:8080/" },
  { name: "built", url: "http://127.0.0.1:8081/" },
];

const browser = await chromium.launch({ executablePath: process.env.PW_CHROME });
let bad = 0;

for (const t of targets) {
  for (const vp of [
    { name: "desktop", width: 1280, height: 876 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport: vp });
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("requestfailed", (r) =>
      errors.push(`requestfailed: ${r.url().slice(0, 90)} ${r.failure()?.errorText ?? ""}`),
    );

    await page.goto(t.url, { waitUntil: "load" });
    await page.locator("#intro-skip").click({ timeout: 8000 }).catch(() => {});
    await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 }).catch(() => {});
    await page
      .waitForFunction(() => window.__game?.assets?.progress >= 1, null, { timeout: 90000 })
      .catch(() => {});
    await page.waitForTimeout(2500);

    const report = await page.evaluate(() => {
      const g = window.__game;
      const c = g?.canvas;
      if (!c) return { ok: false, why: "no canvas" };
      const off = document.createElement("canvas");
      off.width = c.width;
      off.height = c.height;
      off.getContext("2d").drawImage(c, 0, 0);
      const d = off.getContext("2d").getImageData(0, 0, off.width, off.height).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4 * 97) {
        seen.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`);
      }
      return {
        ok: seen.size > 12,
        distinctColors: seen.size,
        canvas: `${c.width}x${c.height}`,
        scrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth,
      };
    });

    const overflow = report.scrollW > report.innerW + 1;
    const pass = report.ok && !overflow && errors.length === 0;
    if (!pass) bad++;
    console.log(
      `${pass ? "PASS" : "FAIL"} ${t.name}/${vp.name}`,
      JSON.stringify({ ...report, horizontalOverflow: overflow, errors: errors.slice(0, 5) }),
    );
    await page.close();
  }
}

await browser.close();
console.log(bad === 0 ? "ALL PASS" : `${bad} FAILURES`);
process.exit(bad === 0 ? 0 : 1);
