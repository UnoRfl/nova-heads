// Now-playing card engine. mountMusic(root) -> { setConfig(cfg), render(state) }. Used live (music.html) and for panel previews.
const NP_PAL = { aurora: "#5EEAD4", sunset: "#FF8A5B", ocean: "#38BDF8", candy: "#FF9ECF", toxic: "#B6FF3B", blood: "#FF3B4E", ice: "#BFE9FF", gold: "#F5C451" };
const NP_ART_OK = new Set(["cyber", "glass", "flow", "holo", "anime", "custom"]);   // themes whose accent may follow the album art
const NP_THEMES = ["cyber", "glass", "soft", "flow", "synth", "terminal", "mono", "holo", "comic", "sakura", "ember",
                   "ink", "noir", "oni", "anime", "pop", "pixel", "custom", "y2k"];
const NP_FX = { cyber: "glitch", glass: "soft", soft: "pop", flow: "soft", synth: "glitch", terminal: "glitch", mono: "wipe", holo: "flip",
  comic: "glitch", sakura: "drift", ember: "rise", ink: "brush", noir: "film", oni: "slash", anime: "zoom", pop: "pop", pixel: "pixel",
  custom: "pop", y2k: "pixel" };
const NP_FX_ALL = ["glitch", "soft", "pop", "wipe", "flip", "drift", "rise", "brush", "film", "slash", "zoom", "pixel"];
function npFx(cfg) { const f = cfg.music_fx || cfg.fx || "auto"; return f === "auto" ? NP_FX[npTheme(cfg)] || "glitch" : f; }
function npTheme(cfg) { const s = cfg.music_style || "match"; return s === "match" ? (cfg.theme || "cyber") : (NP_THEMES.includes(s) ? s : "cyber"); }

function mountMusic(NP, opts = {}) {
  const q = (s) => NP.querySelector(s);
  const PLAY = "M4 2l10 6-10 6z", PAUSE = "M4 2h3v12H4zM9 2h3v12H9z";
  let cur = null, lastId = null, cfg = {}, artAcc = null, shown = false, fxT = 0, lastW = "", lastT = "";
  // enter / exit effect, then (for exit) stay hidden
  function play(dir, after) {
    const f = npFx(cfg);
    NP.classList.remove("fx-in", "fx-out", ...NP_FX_ALL.map((x) => "f-" + x));
    clearTimeout(fxT);
    if (f === "none") { after && after(); return; }
    void NP.offsetWidth;
    NP.classList.add(dir === "in" ? "fx-in" : "fx-out", "f-" + f);
    if (opts.live && cfg.sfx !== false && window.nhSfx) try { window.nhSfx.play(npTheme(cfg), dir === "in" ? "join" : "leave", (cfg.sfx_volume ?? .5) * .8); } catch {}
    fxT = setTimeout(() => { NP.classList.remove("fx-in", "fx-out", "f-" + f); after && after(); }, dir === "in" ? 950 : 460);
  }
  function setShown(v) {
    if (v === shown) return; shown = v;
    if (v) { if (opts.live && window.nova.musicVisible) window.nova.musicVisible(true); NP.classList.remove("hidden"); play("in"); setTimeout(fit, 80); }
    else play("out", () => { if (!shown) { NP.classList.add("hidden"); if (opts.live && window.nova.musicVisible) window.nova.musicVisible(false); } });
  }
  if (opts.live) {
    NP.querySelectorAll("[data-c]").forEach((b) => b.onclick = () => window.nova.music(b.dataset.c));
    // the window ignores the mouse except over the buttons + progress bar (mouse moves are forwarded so we can tell)
    let mm = 0; document.addEventListener("mousemove", () => { if (cfg.debug_mouse && window.nova.dbg && mm++ % 20 === 0) window.nova.dbg("move"); });
    for (const el of NP.querySelectorAll(".ctl, .prog")) {
      el.addEventListener("mouseenter", () => window.nova.musicClickable && window.nova.musicClickable(true));
      el.addEventListener("mouseleave", () => window.nova.musicClickable && window.nova.musicClickable(false));
    }
    q(".prog").onclick = (e) => { if (!cur || !cur.dur) return; const r = q(".prog").getBoundingClientRect();
      window.nova.music("seek", (e.clientX - r.left) / r.width * cur.dur); };
  }
  const fmt = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  const probe = new Image(); probe.crossOrigin = "anonymous";
  probe.onload = () => { try {
    const c = document.createElement("canvas"); c.width = c.height = 24; const x = c.getContext("2d"); x.drawImage(probe, 0, 0, 24, 24);
    const d = x.getImageData(0, 0, 24, 24).data; let best = null, bs = -1;
    for (let i = 0; i < d.length; i += 4) { const r = d[i], g = d[i + 1], b = d[i + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sc = (mx ? (mx - mn) / mx : 0) * (mx / 255) * (mx > 60 ? 1 : .2); if (sc > bs) { bs = sc; best = [r, g, b]; } }
    if (best && bs > .18) { const k = 255 / Math.max(...best); artAcc = `rgb(${best.map((v) => Math.min(255, Math.round(v * k * .95 + 20))).join(",")})`; }
    else artAcc = null;
    accent();
  } catch { artAcc = null; } };
  function accent() {
    const th = npTheme(cfg);
    let c = "";
    if (cfg.music_accent === "hud") c = cfg.accent_override || ((cfg.music_style || "match") === "match" && NP_PAL[cfg.palette]) || "";
    else if (artAcc && NP_ART_OK.has(th)) c = artAcc;
    else if ((cfg.music_style || "match") === "match" && NP_PAL[cfg.palette] && NP_ART_OK.has(th)) c = NP_PAL[cfg.palette];
    if (c) NP.style.setProperty("--c", c); else NP.style.removeProperty("--c");
  }
  // long title / artist line: measure and turn on the slow ping-pong slide if it doesn't fit
  function fit() {
    requestAnimationFrame(() => {
      for (const sel of [".ttl", ".art2"]) {
        const box = q(sel), sp = q(sel + " span"); if (!box || !sp) continue;
        box.classList.remove("scroll");
        const over = sp.scrollWidth - box.clientWidth;
        if (box.clientWidth > 0 && over > 2) {
          box.classList.add("scroll");
          box.style.setProperty("--w", -(over + 10) + "px");
          box.style.setProperty("--d", Math.max(4, (over + 10) / 18) + "s");   // ~18px a second: slow and readable
        }
      }
    });
  }
  if (document.fonts) document.fonts.ready.then(fit);
  function setConfig(c) { const th0 = NP.dataset.theme; cfg = c || {}; NP.dataset.theme = npTheme(cfg); if (th0 !== NP.dataset.theme) setTimeout(fit, 60); if (cfg.music_test) NP.style.transition = "none"; accent(); }
  function render(s) {
    cur = s;
    const off = !s.ok || s.idle;
    NP.classList.toggle("off", !!off);
    if (opts.live) setShown(!(off && cfg.music_autohide !== false)); else NP.classList.remove("hidden");
    q(".msg").textContent = !s.ok ? (s.msg === "not connected" ? "SPOTIFY NOT CONNECTED" : "SPOTIFY · " + String(s.msg).toUpperCase()) : "NOTHING PLAYING";
    q(".err").style.display = s.err ? "block" : "none"; q(".err").textContent = s.err || "";
    if (off) return;
    NP.classList.toggle("paused", !s.playing);
    q(".top span").textContent = s.playing ? "NOW PLAYING" : "PAUSED";
    q(".dev").textContent = s.device ? "▸ " + s.device : "";
    q(".pp path").setAttribute("d", s.playing ? PAUSE : PLAY);
    q('[data-c="shuffle"]').style.color = s.shuffle ? "var(--c)" : "";
    if (s.id !== lastId) {
      if (lastId && opts.live) { const k = npFx(cfg) === "glitch" ? "swapfx" : "swap"; NP.classList.remove("swap", "swapfx"); void NP.offsetWidth; NP.classList.add(k); }
      lastId = s.id;
      q(".ttl span").textContent = s.title; q(".art2 span").textContent = s.artist + (s.album ? "  ·  " + s.album : "");
      const u = s.art ? `url("${s.art}")` : "none"; q(".art").style.backgroundImage = u; q(".bg").style.backgroundImage = u;
      if (s.art && opts.live) probe.src = s.art;
      fit();
    }
    tick();
  }
  function tick() {
    if (cur && cur.ok && !cur.idle && cur.dur) {
      const pos = Math.min(cur.dur, cur.pos + (cur.playing ? Date.now() - cur.at : 0));
      const w = (pos / cur.dur * 100).toFixed(1) + "%", t = fmt(pos) + " / " + fmt(cur.dur);
      if (w !== lastW) { lastW = w; q(".prog i").style.width = w; }
      if (t !== lastT) { lastT = t; q(".tm").textContent = t; }
    }
  }
  if (opts.live) setInterval(() => { if (shown && cur && cur.playing) tick(); }, 1000);
  return { setConfig, render, tick, replay: () => play("in") };
}

// the card's markup, for previews
function npMarkup() {
  return `<div class="bg"></div><div class="deco"></div><div class="artw"><div class="art"></div><div class="scan"></div></div>
  <div class="info"><div class="top"><div class="eq"><i></i><i></i><i></i><i></i></div><span>NOW PLAYING</span><span class="dev"></span></div>
  <div class="ttl"><span></span></div><div class="art2"><span></span></div><div class="row"><div class="prog"><i></i></div><span class="tm"></span></div>
  <div class="row ctlrow"><div class="ctl"><button data-c="shuffle"><svg viewBox="0 0 16 16"><path d="M11 2l3 2.5L11 7V5.3c-1.6.1-2.6 1-3.6 2.4l-.6.8.6.8c1 1.4 2 2.3 3.6 2.4V10l3 2.5L11 15v-1.8c-2.4-.1-3.8-1.4-5-3.1-1.2 1.7-2.6 3-5 3.1V11.6c1.6-.1 2.6-1 3.6-2.4l.6-.8-.6-.8C3.6 6.2 2.6 5.3 1 5.2V3.6c2.4.1 3.8 1.4 5 3.1C7.2 5 8.6 3.7 11 3.6z"/></svg></button><button data-c="previous"><svg viewBox="0 0 16 16"><path d="M3 2h2v12H3zM14 2v12L6 8z"/></svg></button><button class="pp"><svg viewBox="0 0 16 16"><path d="M4 2h3v12H4zM9 2h3v12H9z"/></svg></button><button data-c="next"><svg viewBox="0 0 16 16"><path d="M11 2h2v12h-2zM2 2v12l8-6z"/></svg></button></div></div></div>
  <div class="msg"></div><div class="err"></div>`;
}

if (document.getElementById("np") && window.nova && window.nova.onMusic) {
  const card = mountMusic(document.getElementById("np"), { live: true });
  window.nova.onConfig((c) => { card.setConfig(c); document.body.style.setProperty("--s", c.music_scale || 1);
    document.body.style.opacity = c.music_opacity ?? 1; });
  window.nova.onMusic((s) => card.render(s));
  window.nova.ready();
}
