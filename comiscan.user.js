// ==UserScript==
// @name         ComiScan
// @name:ja      ComiScan（コミケ参加者スキャナ）
// @description  Scan your X following page for artists announcing Comiket participation
// @description:ja フォロー一覧をスキャンして、コミケ参加を告知しているアーティストを探します
// @namespace    comiscan
// @version      2.0
// @match        https://x.com/*
// @match        https://twitter.com/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @inject-into  page
// @author       ponc☆2
// @license      WTFPL
// ==/UserScript==

(() => {
  "use strict";

  const DEFAULT_EVENT = 109; // Comiket number used until you change it in the panel
  const SCROLL_SPEED = 5000; // px per second of smooth scrolling (lower if X rate-limits you)
  const STALL_SECONDS = 10;  // stop after this long with no new accounts

  // =========================================================================
  // Matching
  // =========================================================================

  // Dash variants that never appear inside ordinary Japanese words. The
  // long-vowel mark ー is only accepted as a separator inside SPACE_RE, since
  // normalizing it globally would break words like コミックマーケット.
  const DASHES = /[‐‑‒–—―−﹣]/g;

  const SPACE_RE = new RegExp(
    String.raw`(?:(?<![A-Za-z])(?<hall_en>East|West|South)\s*|(?<hall>[東西南])\s*)` +
      String.raw`(?:\d{1,2}\s*(?:ホール)?\s*)?` + //     optional hall number: 東7 / 東7ホール
      String.raw`(?<block>[ぁ-ゖァ-ヺ]|[A-Za-z]{1,2})` + // block: あ / ア / A / (en) Ki
      String.raw`\s*[-ー]?\s*` +
      String.raw`(?<num>\d{1,2})(?!\d)` +
      String.raw`(?<side>[abAB]{1,2}(?![A-Za-z]))?`,
    "gi",
  );

  const DAY_RE =
    /(?<!\d)(?<n>[1-4])\s*日目|(?<wd>[月火水木金土日])曜日?|\((?<wd2>[月火水木金土日])\)|\bDay\s*(?<n2>[1-4])\b/gi;

  const EVENT_RE = /(?<![A-Za-z0-9])(?:C|CM|コミケ|コミックマーケット|comiket)\s*(?<num>\d{3})(?!\d)/gi;

  const SEASON_RE = /(?<season>冬|夏)コミ/g;

  const NEGATIVE_KW = ["落選", "不参加", "お休み", "欠席", "参加しません", "見送り"];
  const TAG_KW = { 一般参加: "一般参加", 委託: "委託", 新刊: "新刊", 当選: "当選" };
  const HALL_EN = { east: "東", west: "西", south: "南" };
  const FIELDS = ["name", "location", "description"];
  const STATUS_ORDER = ["confirmed", "likely", "announced", "not-attending", "stale"];

  // NFKC: full-width ＡＢ１２ → AB12, half-width ｱ → ア, （ → (, － → -
  const normalize = (text) => (text || "").normalize("NFKC").replace(DASHES, "-");

  const dayLabel = (g) => (g.n || g.n2 ? `${g.n || g.n2}日目` : `${g.wd || g.wd2}曜`);

  function nearestDay(days, pos) {
    let best = null;
    let bestDist = Infinity;
    for (const d of days) {
      const dist = Math.min(Math.abs(d.index + d[0].length - pos), Math.abs(d.index - pos));
      if (dist < bestDist) [best, bestDist] = [d, dist];
    }
    return best ? dayLabel(best.groups) : "";
  }

  function parseField(text, field) {
    const norm = normalize(text);
    const days = [...norm.matchAll(DAY_RE)];
    const spaces = [...norm.matchAll(SPACE_RE)].map((m) => {
      const g = m.groups;
      const hall = g.hall || HALL_EN[g.hall_en.toLowerCase()];
      let block = g.block;
      // East halls use uppercase letter blocks, South halls lowercase (南a〜t)
      if (block.length === 1 && /[A-Za-z]/.test(block)) {
        block = hall === "南" ? block.toLowerCase() : block.toUpperCase();
      }
      const num = parseInt(g.num, 10);
      const side = (g.side || "").toLowerCase();
      return {
        hall, block, num, side, field,
        day: nearestDay(days, m.index),
        label: `${hall}${block}-${String(num).padStart(2, "0")}${side}`,
      };
    });
    const events = new Set([...norm.matchAll(EVENT_RE)].map((m) => Number(m.groups.num)));
    const seasons = new Set([...norm.matchAll(SEASON_RE)].map((m) => m.groups.season));
    return { norm, days, spaces, events, seasons };
  }

  const spaceKey = (s) => [s.day || "~", s.hall, s.block, s.num, s.side];

  function cmpKeys(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] === b[i]) continue;
      if (a[i] === undefined) return -1;
      if (b[i] === undefined) return 1;
      return a[i] < b[i] ? -1 : 1;
    }
    return 0;
  }

  function classify(user, target) {
    const targetSeason = target % 2 ? "冬" : "夏"; // recent Comikets: odd = winter
    const spaces = [];
    const staleSpaces = [];
    const events = new Set();
    let targetHit = false;
    let negative = false;
    let day = "";
    const tags = [];
    const matched = [];

    for (const fname of FIELDS) {
      const f = parseField(user[fname], fname);
      const fieldTarget = f.events.has(target) || f.seasons.has(targetSeason);
      const fieldOther = [...f.events].some((e) => e !== target);
      targetHit ||= fieldTarget;
      f.events.forEach((e) => events.add(e));
      // A space in a field that only mentions some *other* Comiket is leftover info.
      if (fieldOther && !fieldTarget) staleSpaces.push(...f.spaces);
      else spaces.push(...f.spaces);
      if (fieldTarget && !day && f.days.length) day = dayLabel(f.days[0].groups);
      if (fieldTarget || f.spaces.length) {
        if (NEGATIVE_KW.some((k) => f.norm.includes(k))) negative = true;
        for (const [k, v] of Object.entries(TAG_KW)) if (f.norm.includes(k) && !tags.includes(v)) tags.push(v);
      }
      if (f.spaces.length || f.events.size || fieldTarget) matched.push(fname);
    }

    if (!spaces.length && !staleSpaces.length && !targetHit && !events.size) return null;

    let status;
    if (negative && targetHit) status = "not-attending";
    else if (spaces.length && targetHit) status = "confirmed";
    else if (spaces.length) status = "likely"; //      space listed, but no event number next to it
    else if (targetHit) status = "announced"; //       mentions C109 but no space yet
    else status = "stale"; //                          only older/other Comiket info

    return {
      screen_name: user.screen_name || "",
      name: user.name || "",
      status,
      spaces: (spaces.length ? spaces : staleSpaces).sort((a, b) => cmpKeys(spaceKey(a), spaceKey(b))),
      events: [...events].sort(),
      tags,
      day,
      matched,
    };
  }

  // =========================================================================
  // Collecting
  // =========================================================================

  const EVENT_KEY = "comiketScan.event";
  let event = loadEvent();

  function loadEvent() {
    try {
      return Number(localStorage.getItem(EVENT_KEY)) || DEFAULT_EVENT;
    } catch {
      return DEFAULT_EVENT;
    }
  }

  function setEvent(n) {
    event = n;
    try { localStorage.setItem(EVENT_KEY, String(n)); } catch {}
    render();
  }

  const users = new Map(); // lowercase handle -> {screen_name, name, location, description, src}

  // 1) X's own API responses for the following timeline: full profile incl. location.
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url ?? String(args[0]);
      if (isTarget(url)) res.clone().json().then(ingest).catch(() => {});
    } catch {}
    return res;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__comiketScanUrl = String(url);
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (isTarget(this.__comiketScanUrl)) {
      this.addEventListener("load", () => {
        try {
          if (this.responseType === "json") ingest(this.response);
          else if (this.responseType === "" || this.responseType === "text") ingest(JSON.parse(this.responseText));
        } catch {}
      });
    }
    return origSend.apply(this, args);
  };

  function isTarget(url) {
    return !!url && /following/i.test(url) && !/\.(js|css|png|jpe?g|webp|svg)(\?|$)/i.test(url);
  }

  // Walk the whole response and pick out every User object, so this keeps
  // working when X reshuffles the GraphQL envelope around them.
  function ingest(json) {
    const before = users.size;
    (function walk(node) {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (node.__typename === "User" && node.rest_id) return addApiUser(node);
      for (const k in node) walk(node[k]);
    })(json);
    if (users.size !== before) scheduleRender();
  }

  function addApiUser(u) {
    const L = u.legacy || {};
    const C = u.core || {};
    const screen_name = C.screen_name ?? L.screen_name;
    if (!screen_name) return;
    const loc = u.location;
    users.set(screen_name.toLowerCase(), {
      screen_name,
      name: C.name ?? L.name ?? "",
      location: (loc && typeof loc === "object" ? loc.location : loc) ?? L.location ?? "",
      description: expandUrls(u.profile_bio?.description ?? L.description ?? "", L.entities?.description?.urls),
      src: "api",
    });
  }

  function expandUrls(text, urls) {
    for (const u of urls || []) if (u.url && u.expanded_url) text = text.split(u.url).join(u.expanded_url);
    return text;
  }

  // 2) Fallback: the rendered user cells (no location, but works if the hook misses).
  function textOf(el) {
    if (!el) return "";
    const c = el.cloneNode(true);
    c.querySelectorAll("img[alt]").forEach((i) => i.replaceWith(i.alt)); // keep emoji
    return c.textContent.trim();
  }

  function collectDom() {
    let added = 0;
    document.querySelectorAll('[data-testid="UserCell"]').forEach((cell) => {
      let handle = "";
      let name = "";
      for (const a of cell.querySelectorAll('a[role="link"][href^="/"]')) {
        const h = a.getAttribute("href");
        if (!/^\/[A-Za-z0-9_]+$/.test(h)) continue;
        const txt = textOf(a);
        if (!handle) handle = h.slice(1);
        if (txt && !txt.startsWith("@") && !name) name = txt;
      }
      if (!handle || users.has(handle.toLowerCase())) return;
      const bio = textOf(cell.querySelector('[data-testid="UserDescription"]'));
      users.set(handle.toLowerCase(), { screen_name: handle, name, location: "", description: bio, src: "dom" });
      added++;
    });
    return added;
  }

  // =========================================================================
  // Results
  // =========================================================================

  const SHOWN = ["confirmed", "likely", "announced", "not-attending"];
  const STATUS_LABEL = { confirmed: "", likely: "no C# yet", announced: "no space yet", "not-attending": "落選/不参加" };
  const STATUS_COLOR = { confirmed: "#00ba7c", likely: "#1d9bf0", announced: "#ffd400", "not-attending": "#f4212e" };

  function analyze() {
    const rows = [];
    for (const u of users.values()) {
      const h = classify(u, event);
      if (!h || !SHOWN.includes(h.status)) continue;
      const days = [...new Set(h.spaces.map((s) => s.day || h.day).filter(Boolean))];
      rows.push({
        status: h.status,
        handle: h.screen_name,
        name: h.name,
        space: h.spaces.map((s) => s.label).join(" / "),
        day: days.join(" / ") || h.day,
        tags: h.tags.join(" "),
        src: [...new Set(h.spaces.length ? h.spaces.map((s) => s.field) : h.matched)].join(","),
        key: h.spaces[0] ? spaceKey(h.spaces[0]) : [h.day || "~", "~"],
      });
    }
    rows.sort((a, b) => cmpKeys(
      [SHOWN.indexOf(a.status), ...a.key, a.handle.toLowerCase()],
      [SHOWN.indexOf(b.status), ...b.key, b.handle.toLowerCase()],
    ));
    return rows;
  }

  const csvEsc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  function toCSV(rows) {
    return ["status,handle,name,space,day,tags,found_in,url",
      ...rows.map((r) => [r.status, r.handle, r.name, r.space, r.day, r.tags, r.src, `https://x.com/${r.handle}`]
        .map(csvEsc).join(",")),
    ].join("\n");
  }

  function download() {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + toCSV(lastRows)], { type: "text/csv;charset=utf-8" }));
    a.download = `c${event}_artists.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function copyCsv(btn) {
    try {
      await navigator.clipboard.writeText(toCSV(lastRows));
      flash(btn, "Copied ✓");
    } catch {
      flash(btn, "Copy failed");
    }
  }

  function flash(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => (btn.textContent = old), 1200);
  }

  // =========================================================================
  // UI (createElement only: x.com enforces Trusted Types, so no innerHTML)
  // =========================================================================

  let panel, statusEl, listEl, running = false, lastRows = [], renderQueued = false;

  function el(tag, css, ...children) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    e.append(...children);
    return e;
  }

  function button(label, onClick) {
    const b = el("button",
      "font:inherit;padding:3px 10px;margin-right:4px;border-radius:999px;cursor:pointer;" +
      "border:1px solid #536471;background:transparent;color:#fff", label);
    b.onclick = () => onClick(b);
    return b;
  }

  function eventInput() {
    const input = el("input",
      "width:3.2em;font:inherit;font-weight:bold;color:#fff;background:transparent;" +
      "border:none;border-bottom:1px dashed #8899a6;padding:0;text-align:center");
    input.type = "text";
    input.inputMode = "numeric";
    input.maxLength = 3;
    input.value = event;
    input.title = "Comiket number to scan for";
    input.oninput = () => {
      const n = Number(input.value);
      if (/^\d{3}$/.test(input.value) && n !== event) setEvent(n);
    };
    input.onblur = () => { input.value = event; };
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") input.blur(); };
    return input;
  }

  function buildPanel() {
    statusEl = el("div", "margin:6px 0;color:#8899a6", "Idle");
    listEl = el("div");
    panel = el("div",
      "position:fixed;top:12px;right:12px;z-index:99999;width:380px;max-height:80vh;" +
      "overflow:auto;background:#15202b;color:#fff;border:1px solid #38444d;border-radius:12px;" +
      "padding:12px;font:13px/1.4 sans-serif;box-shadow:0 4px 20px #0008",
      el("div", "font-weight:bold;margin-bottom:6px", "C", eventInput(), " ComiScan"),
      button("Scan", run),
      button("Stop", () => { running = false; }),
      button("Copy CSV", copyCsv),
      button("Download CSV", download),
      statusEl,
      listEl,
    );
    document.body.append(panel);
    render();
  }

  function scheduleRender() {
    if (renderQueued || !panel?.isConnected) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function render() {
    if (!panel) return;
    lastRows = analyze();
    statusEl.textContent =
      `${running ? "Scanning… " : users.size ? "Done. " : ""}${users.size} accounts seen, ${lastRows.length} matches`;
    listEl.replaceChildren();
    for (const r of lastRows) {
      const a = el("a", "color:#1d9bf0;text-decoration:none", `@${r.handle}`);
      a.href = `https://x.com/${r.handle}`;
      a.target = "_blank";
      const artist = el("div", "", el("span", `color:${STATUS_COLOR[r.status]}`, "● "),
        el("b", "", `${r.name} `), a);
      const where = el("div", "color:#c4cfd6;padding-left:1.1em",
        `${r.day ? "[" + r.day + "] " : ""}`,
        r.space || "(no space yet)",
        STATUS_LABEL[r.status] ? el("span", "color:#8899a6", ` · ${STATUS_LABEL[r.status]}`) : "",
        r.tags ? el("span", "color:#8899a6", ` · ${r.tags}`) : "");
      listEl.append(el("div", "padding:3px 0;border-top:1px solid #263340", artist, where));
    }
  }

  async function run() {
    if (running) return;
    running = true;
    let lastSize = users.size;
    let prev = performance.now();
    let lastNew = prev;
    let lastCollect = 0;
    let lastRender = 0;

    await new Promise((resolve) => {
      function frame(now) {
        if (!running) return resolve();
        // rAF pauses in background tabs; don't count that pause as a stall
        if (now - prev > 1000) lastNew += now - prev;
        const dt = Math.min(now - prev, 100);
        prev = now;
        window.scrollBy({ top: (SCROLL_SPEED * dt) / 1000, behavior: "instant" });

        // the user list is virtualized, so read cells often enough to see each one
        if (now - lastCollect > 150) { collectDom(); lastCollect = now; }
        if (users.size > lastSize) { lastSize = users.size; lastNew = now; }
        if (now - lastRender > 500) { render(); lastRender = now; }
        if (now - lastNew > STALL_SECONDS * 1000) return resolve();
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    });

    collectDom();
    running = false;
    render();
  }

  // X is a SPA: show the panel only on /<user>/following
  setInterval(() => {
    if (!document.body) return;
    const onFollowing = /^\/[^/]+\/following\/?$/.test(location.pathname);
    if (onFollowing && !panel?.isConnected) buildPanel();
    if (!onFollowing && panel?.isConnected) { running = false; panel.remove(); }
  }, 1000);

  if (typeof module === "object") module.exports = { classify };
})();
