import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import "../karera/style.css";

export const Route = createFileRoute("/")({ component: Home });

const SHELL = `
<canvas id="game"></canvas>
<div id="stage-ui">
<div data-orientation="landscape" class="orientation-msg-container">
  <p class="orientation-msg-text">Please rotate your device</p>
</div>
<div id="auth-overlay" class="overlay hidden">
  <div class="card">
    <h1>KARERA LOGIN</h1>
    <p class="sub">Phone number and password</p>
    <input id="lo-phone" inputmode="tel" maxlength="11" placeholder="09XXXXXXXXX" autocomplete="username" />
    <input id="lo-pass" type="password" placeholder="Password" autocomplete="current-password" />
    <div id="lo-err" class="err"></div>
    <button id="lo-btn" type="button">ENTER PADDOCK</button>
  </div>
</div>
<div id="bet-bar" class="betbar hidden">
  <div class="betbar-top">
    <span id="bet-horse">Tap a horse</span>
    <span id="bet-bal"></span>
  </div>
  <div class="betbar-row">
    <input id="bet-amt" inputmode="decimal" placeholder="Custom amount" autocomplete="off" />
    <button id="bet-confirm" type="button" class="hidden">CONFIRM BET</button>
  </div>
  <div id="bet-err" class="err"></div>
</div>
<div id="admin-overlay" class="overlay hidden">
  <div class="card wide">
    <h1>ADMIN</h1>
    <div id="ad-house" class="house"></div>
    <div class="formrow">
      <input id="ad-phone" inputmode="tel" maxlength="11" placeholder="09XXXXXXXXX" />
      <input id="ad-pass" type="text" maxlength="32" placeholder="Password (4+)" />
      <input id="ad-bal" inputmode="decimal" placeholder="load" />
      <button id="ad-create" type="button">CREATE</button>
    </div>
    <div id="ad-err" class="err"></div>
    <table class="users">
      <thead>
        <tr><th>PHONE</th><th>ROLE</th><th>BALANCE</th><th>LOAD</th></tr>
      </thead>
      <tbody id="ad-users"></tbody>
    </table>
    <button id="ad-close" class="ghost" type="button">CLOSE</button>
  </div>
</div>
</div>`;

function Home() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || host.dataset.booted === "1") return;
    host.dataset.booted = "1";
    host.innerHTML = SHELL;
    void import("../karera/main").then((mod) => mod.startGame());
  }, []);

  return <div ref={hostRef} id="karera-root" />;
}
