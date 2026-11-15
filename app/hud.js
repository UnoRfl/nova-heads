// Nova Heads HUD engine - shared by the overlay (index.html) and the settings panel previews.
// createHud(rootEl) -> { render(state), setConfig(cfg) }
(function () {
  const MIC_OFF = '<svg viewBox="0 0 24 24"><path d="M9 9v3a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.8"/><path d="M19 11a7 7 0 0 1-11.9 5M5 11a7 7 0 0 0 .4 2.3M12 18v3"/><path d="M3 3l18 18"/></svg>';
  const DEAF = '<svg viewBox="0 0 24 24"><path d="M4 15v-3a8 8 0 0 1 13.6-5.7M20 12v3"/><path d="M4 15h3v5H4zM17 15h3v5h-3z"/><path d="M3 3l18 18"/></svg>';
  const TAGS = { selfmute: "MUTED", servermute: "SRV MUTE", localmute: "LOCAL", deaf: "DEAF" };
  const TICK = 1000 / 12, rnd = (a, b) => a + Math.random() * (b - a);

  function initials(name, id) {
    let h = 0; for (const ch of id + name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const hue = h % 360;
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>
      <stop offset='0' stop-color='hsl(${hue},55%,52%)'/><stop offset='1' stop-color='hsl(${(hue + 50) % 360},60%,28%)'/></linearGradient></defs>
      <rect width='64' height='64' fill='url(#g)'/><text x='32' y='41' font-family='Segoe UI' font-weight='600' font-size='26'
      fill='rgba(255,255,255,.95)' text-anchor='middle'>${(name[0] || "?").toUpperCase()}</text></svg>`;
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }

  function makeRow(p) {
    const li = document.createElement("li");
    li.className = "row pre";
    li.innerHTML = `<div class="av"><div class="frame"><img alt=""></div><div class="scan"></div>
        <i class="br tl"></i><i class="br tr"></i><i class="br bl"></i><i class="br brr"></i><div class="st"></div></div>
      <div class="plate"><i class="htp"></i><span class="idx"></span><span class="name"></span><span class="you"></span><span class="tag"></span>
        <span class="wave"><i></i><i></i><i></i><i></i><i></i></span></div>`;
    li.querySelector("img").onerror = function () { this.onerror = null; this.src = initials(p.name, p.id); };
    return li;
  }

  // Spider-Verse glitch: 12 fps "on twos", RGB misprint, sliced ghost bands, halftone flashes.
  function glitch(el, mode, done) {
    if (el._glitch) { clearInterval(el._glitch); el.querySelectorAll(":scope > .ghost").forEach((g) => g.remove()); }
    const ticks = mode === "in" ? 8 : mode === "out" ? 6 : 3;
    const vis = mode === "in" ? [0, .55, 0, .9, .35, 1, .75, 1] : mode === "out" ? [1, .4, .9, .15, .6, 0] : [1, .7, 1];
    const ghosts = [];
    for (let i = 0; i < (mode === "blip" ? 1 : 3); i++) {
      const g = el.cloneNode(true);
      g.classList.remove("pre", "gone", "ht", "ht2", ...[...g.classList].filter((c) => /-(in|out)$/.test(c)));
      g.classList.add("ghost", ["gm", "gc", "gw"][i % 3]);
      g.querySelectorAll(".pt").forEach((x) => x.remove());
      ghosts.push(g);
    }
    ghosts.forEach((g) => el.appendChild(g));
    el.classList.remove("pre");
    let t = 0;
    const step = () => {
      if (t >= ticks) {
        clearInterval(el._glitch); el._glitch = null;
        ghosts.forEach((g) => g.remove());
        el.classList.remove("ht", "ht2");
        el.style.transform = el.style.filter = "";
        el.style.opacity = mode === "out" ? "0" : "";
        done && done();
        return;
      }
      const k = vis[t] ?? 1, n = rnd(1.5, 4.5) * (mode === "blip" ? .6 : 1);
      el.style.opacity = String(k * (el.classList.contains("talk") ? 1 : .8));
      el.style.transform = `translateX(${rnd(-3, 3).toFixed(1)}px)`;
      el.style.filter = `drop-shadow(${-n}px 0 0 rgba(255,47,179,.85)) drop-shadow(${n}px 0 0 rgba(77,243,255,.85))`;
      ghosts.forEach((g) => {
        const top = rnd(0, 78), h = rnd(10, 34);
        g.style.clipPath = `inset(${top}% 0 ${Math.max(0, 100 - top - h)}% 0)`;
        g.style.transform = `translateX(${rnd(-16, 16).toFixed(1)}px)`;
        g.style.visibility = Math.random() < (mode === "blip" ? .9 : .8) ? "visible" : "hidden";
      });
      el.classList.toggle("ht", t % 3 === 1);
      el.classList.toggle("ht2", t % 3 === 2 && mode !== "blip");
      t++;
    };
    step();
    el._glitch = setInterval(step, TICK);
  }

  // CSS-driven join/leave. Each style's signature lives in hud.css as .row.<name>-in / .row.<name>-out
  const FX_CSS = new Set(["soft", "brush", "slash", "pop", "pixel", "film", "zoom", "wipe", "drift", "rise", "flip"]);
  function soft(el, mode, done, name = "soft") {
    el.classList.remove("pre", ...[...el.classList].filter((c) => /-(in|out)$/.test(c)));
    void el.offsetWidth;
    el.classList.add(name + (mode === "out" ? "-out" : "-in"));
    setTimeout(() => {
      el.classList.remove(name + "-in");
      if (mode === "out") el.style.opacity = "0";
      done && done();
    }, mode === "out" ? 380 : 620);
  }


  // ---------------------------------------------------------------- sound: every style has its own synthesized set
  // (WebAudio, no sound files). join / leave / blip (mute change). Plays in the overlay only.
  const SFX = (() => {
    let ac = null, out = null;
    const ctx = () => {
      if (!ac) { ac = new AudioContext(); out = ac.createGain(); out.connect(ac.destination); }
      if (ac.state === "suspended") ac.resume();
      return ac;
    };
    const env = (g, t, a, d, peak) => { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a);
                                        g.gain.exponentialRampToValueAtTime(0.0001, t + d); };
    function tone(t, { f = 440, f2 = null, d = .15, type = "sine", g = .3, a = .005, det = 0, lp = null, lp2 = null }) {
      const o = ac.createOscillator(), v = ac.createGain();
      o.type = type; o.frequency.setValueAtTime(f, t); o.detune.value = det;
      if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + d * .9);
      let n = o;
      if (lp) { const fl = ac.createBiquadFilter(); fl.type = "lowpass"; fl.frequency.setValueAtTime(lp, t);
                if (lp2) fl.frequency.exponentialRampToValueAtTime(lp2, t + d); o.connect(fl); n = fl; }
      n.connect(v); v.connect(out); env(v, t, a, d, g);
      o.start(t); o.stop(t + d + .05);
    }
    let nbuf = null;
    function noise(t, { d = .2, g = .3, type = "bandpass", f = 1000, f2 = null, q = 1, a = .005 }) {
      if (!nbuf) { nbuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate); const c = nbuf.getChannelData(0); for (let i = 0; i < c.length; i++) c[i] = Math.random() * 2 - 1; }
      const s = ac.createBufferSource(), fl = ac.createBiquadFilter(), v = ac.createGain();
      s.buffer = nbuf; fl.type = type; fl.Q.value = q; fl.frequency.setValueAtTime(f, t);
      if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + d);
      s.connect(fl); fl.connect(v); v.connect(out); env(v, t, a, d, g);
      s.start(t, Math.random() * .5); s.stop(t + d + .05);
    }
    const seq = (t, fs, step, o) => fs.forEach((f, i) => tone(t + i * step, { ...o, f }));
    const R = {
      cyber: { join: (t) => { tone(t, { f: 660, f2: 1320, d: .09, type: "square", g: .07 }); tone(t + .08, { f: 1760, d: .09, type: "square", g: .05 }); },
               leave: (t) => tone(t, { f: 1320, f2: 300, d: .18, type: "square", g: .06 }),
               blip: (t) => tone(t, { f: 990, d: .05, type: "square", g: .05 }) },
      glass: { join: (t) => { tone(t, { f: 1568, d: .7, g: .2, a: .002 }); tone(t, { f: 2349, d: .45, g: .08, a: .002 }); tone(t + .06, { f: 3136, d: .35, g: .04 }); },
               leave: (t) => { tone(t, { f: 1046, d: .55, g: .18, a: .002 }); tone(t + .05, { f: 784, d: .5, g: .1 }); },
               blip: (t) => tone(t, { f: 2093, d: .25, g: .08, a: .002 }) },
      soft: { join: (t) => { tone(t, { f: 523, d: .28, g: .22, a: .01 }); tone(t + .09, { f: 659, d: .32, g: .2, a: .01 }); },
              leave: (t) => { tone(t, { f: 659, d: .25, g: .2, a: .01 }); tone(t + .09, { f: 523, d: .3, g: .18, a: .01 }); },
              blip: (t) => tone(t, { f: 587, d: .15, g: .12, a: .01 }) },
      flow: { join: (t) => seq(t, [392, 523, 659, 784, 1046], .045, { d: .4, type: "triangle", g: .1, a: .01 }),
              leave: (t) => seq(t, [1046, 784, 659, 523], .045, { d: .35, type: "triangle", g: .09, a: .01 }),
              blip: (t) => tone(t, { f: 784, d: .2, type: "triangle", g: .1 }) },
      synth: { join: (t) => [220, 277, 330, 440].forEach((f) => tone(t, { f, d: .55, type: "sawtooth", g: .05, lp: 300, lp2: 4000, a: .02, det: 6 })),
               leave: (t) => [220, 262, 330].forEach((f) => tone(t, { f, d: .5, type: "sawtooth", g: .05, lp: 4000, lp2: 200, det: -6 })),
               blip: (t) => tone(t, { f: 440, d: .15, type: "sawtooth", g: .05, lp: 1800 }) },
      terminal: { join: (t) => { tone(t, { f: 1200, d: .04, type: "square", g: .06, a: .001 }); tone(t + .07, { f: 1200, d: .04, type: "square", g: .06, a: .001 }); tone(t + .14, { f: 1600, d: .06, type: "square", g: .06, a: .001 }); },
                  leave: (t) => tone(t, { f: 400, d: .14, type: "square", g: .06, a: .001 }),
                  blip: (t) => tone(t, { f: 800, d: .03, type: "square", g: .05, a: .001 }) },
      mono: { join: (t) => { noise(t, { d: .02, g: .2, type: "highpass", f: 3000, a: .001 }); tone(t + .01, { f: 880, d: .1, g: .14, a: .002 }); },
              leave: (t) => { noise(t, { d: .02, g: .18, type: "highpass", f: 3000, a: .001 }); tone(t + .01, { f: 440, d: .1, g: .14, a: .002 }); },
              blip: (t) => noise(t, { d: .015, g: .35, type: "highpass", f: 4000, a: .001 }) },
      holo: { join: (t) => [1046, 1318, 1567, 2093, 2637].forEach((f, i) => tone(t + i * .03, { f, d: .55, g: .045, det: (i % 2 ? 9 : -9), a: .01 })),
              leave: (t) => [2093, 1567, 1318, 1046].forEach((f, i) => tone(t + i * .03, { f, d: .45, g: .045, det: 7, a: .01 })),
              blip: (t) => tone(t, { f: 1760, d: .25, g: .05, det: 12 }) },
      comic: { join: (t) => { noise(t, { d: .16, g: .45, type: "lowpass", f: 1400, a: .002 }); tone(t, { f: 200, f2: 60, d: .2, g: .35, a: .002 }); },
               leave: (t) => noise(t, { d: .3, g: .7, type: "bandpass", f: 400, f2: 3500, q: 1.5, a: .03 }),
               blip: (t) => tone(t, { f: 300, f2: 120, d: .1, g: .2 }) },
      sakura: { join: (t) => { tone(t, { f: 784, d: .45, type: "triangle", g: .18, a: .002 }); tone(t + .11, { f: 1175, d: .5, type: "triangle", g: .14, a: .002 }); },
                leave: (t) => { tone(t, { f: 1175, d: .4, type: "triangle", g: .14, a: .002 }); tone(t + .11, { f: 880, d: .5, type: "triangle", g: .12, a: .002 }); },
                blip: (t) => tone(t, { f: 1046, d: .3, type: "triangle", g: .1, a: .002 }) },
      ember: { join: (t) => { for (let i = 0; i < 6; i++) noise(t + Math.random() * .3, { d: .012, g: .3, type: "highpass", f: 2500, a: .001 });
                              noise(t, { d: .45, g: .12, type: "lowpass", f: 300, f2: 1200, a: .08 }); tone(t, { f: 110, d: .45, g: .12, a: .05 }); },
               leave: (t) => noise(t, { d: .45, g: .45, type: "lowpass", f: 1200, f2: 200, a: .02 }),
               blip: (t) => noise(t, { d: .02, g: .3, type: "highpass", f: 2500, a: .001 }) },
      ink: { join: (t) => { noise(t, { d: .3, g: .32, type: "bandpass", f: 500, f2: 2600, q: 2.2, a: .04 }); tone(t + .26, { f: 720, d: .07, g: .16, a: .001 }); },
             leave: (t) => noise(t, { d: .28, g: .3, type: "bandpass", f: 2600, f2: 500, q: 2.2, a: .03 }),
             blip: (t) => tone(t, { f: 720, d: .06, g: .14, a: .001 }) },
      noir: { join: (t) => { [0, .07, .14].forEach((k) => noise(t + k, { d: .02, g: .11, type: "highpass", f: 1500, a: .001 }));
                             tone(t + .05, { f: 196, d: .6, type: "triangle", g: .14, lp: 700, a: .04 }); tone(t + .05, { f: 233, d: .6, type: "triangle", g: .08, lp: 700, a: .04 }); },
              leave: (t) => { noise(t, { d: .02, g: .11, type: "highpass", f: 1500, a: .001 }); tone(t, { f: 147, d: .5, type: "triangle", g: .14, lp: 500, a: .03 }); },
              blip: (t) => noise(t, { d: .02, g: .11, type: "highpass", f: 1500, a: .001 }) },
      oni: { join: (t) => { tone(t, { f: 130, f2: 52, d: .4, g: .55, a: .002 }); noise(t, { d: .1, g: .25, type: "lowpass", f: 350, a: .002 });
                            noise(t + .08, { d: .4, g: .12, type: "bandpass", f: 6500, q: 9, a: .005 }); tone(t + .08, { f: 3150, d: .45, g: .03 }); tone(t + .08, { f: 4210, d: .4, g: .025 }); },
             leave: (t) => { tone(t, { f: 110, f2: 45, d: .45, g: .5, a: .002 }); noise(t, { d: .12, g: .22, type: "lowpass", f: 300, a: .002 }); },
             blip: (t) => tone(t, { f: 160, f2: 70, d: .2, g: .35, a: .002 }) },
      anime: { join: (t) => { seq(t, [1318, 1760, 2093, 2637, 3136], .035, { d: .2, g: .07, a: .002 }); noise(t, { d: .3, g: .04, type: "highpass", f: 8000 }); },
               leave: (t) => seq(t, [2637, 2093, 1568, 1175], .04, { d: .18, g: .07, a: .002 }),
               blip: (t) => tone(t, { f: 2637, d: .12, g: .06, a: .002 }) },
      pop: { join: (t) => { tone(t, { f: 280, f2: 950, d: .1, g: .3, a: .002 }); tone(t + .1, { f: 1400, d: .08, g: .08, a: .002 }); },
             leave: (t) => tone(t, { f: 900, f2: 220, d: .12, g: .28, a: .002 }),
             blip: (t) => tone(t, { f: 500, f2: 800, d: .06, g: .2, a: .002 }) },
      pixel: { join: (t) => { tone(t, { f: 988, d: .07, type: "square", g: .06, a: .001 }); tone(t + .07, { f: 1319, d: .25, type: "square", g: .06, a: .001 }); },
               leave: (t) => seq(t, [784, 659, 523, 392, 262], .055, { d: .06, type: "square", g: .06, a: .001 }),
               blip: (t) => tone(t, { f: 660, d: .05, type: "square", g: .05, a: .001 }) },
    };
    const last = {};
    return {
      play(theme, kind, vol = .5) {
        const now = performance.now();
        if (now - (last[kind] || 0) < 140) return;      // one sound per burst of joins/leaves
        last[kind] = now;
        try {
          ctx(); out.gain.value = Math.max(0, Math.min(1, vol)) * 1.2;
          const r = R[theme] || R.cyber;
          (r[kind] || r.blip)(ac.currentTime + .01);
        } catch (e) { /* audio not available */ }
      },
    };
  })();
  window.nhSfx = SFX;

  // pixelate filter for the 8-bit style (CSS filter:url(#nh-px))
  function ensureDefs() {
    if (document.getElementById("nh-defs")) return;
    const d = document.createElement("div");
    d.id = "nh-defs"; d.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    d.innerHTML = `<svg width="0" height="0"><filter id="nh-px" x="0" y="0" width="1" height="1"><feFlood x="2" y="2" height="1" width="1"/>
      <feComposite width="4" height="4"/><feTile result="a"/><feComposite in="SourceGraphic" in2="a" operator="in"/>
      <feMorphology operator="dilate" radius="2"/></filter></svg>`;
    document.body.appendChild(d);
  }

  // one particle (petal / ember / spark / heart / star / ink / dust / bit)
  function spawn(root, host, kind, o = {}) {
    const p = document.createElement("i");
    p.className = "pt " + kind;
    if (kind === "petal") p.style.backgroundImage = `url(petals/p${1 + Math.floor(Math.random() * 8)}.png)`;   // real petal sprites
    if (kind === "heart") p.textContent = Math.random() < .75 ? "♥" : "✦";
    if (kind === "star") p.textContent = Math.random() < .6 ? "✦" : "✧";
    p.style.setProperty("--sz", rnd(.6, 1.35).toFixed(2));
    const right = root.classList.contains("right"), k = o.spread || 1;
    const dir = o.any ? (Math.random() < .5 ? -1 : 1) : (right ? -1 : 1);
    p.style.setProperty("--dx", dir * rnd(14, 60) * k + "px");
    p.style.setProperty("--dy", rnd(-30, o.any ? 26 : 10) * k + "px");
    p.style.setProperty("--rot", rnd(120, 420) + "deg");
    if (right) { p.style.left = "auto"; p.style.right = "calc(var(--av) / 2)"; }
    p.style.top = o.top != null ? o.top + "px" : rnd(20, 70) + "%";
    if (o.acc) p.style.setProperty("--acc", o.acc);
    host.appendChild(p);
    setTimeout(() => p.remove(), 2000);
  }

  window.createHud = function (root, opts = {}) {
    ensureDefs();
    root.classList.add("hud", "empty");
    root.innerHTML = `<div class="hdr"><span class="pip"></span><span class="lb">VOICE</span><span class="rule"></span><span class="ch"></span><span class="n"></span></div><ul class="list"></ul>`;
    const $list = root.querySelector(".list"), $hdr = root.querySelector(".hdr");
    const rows = new Map();
    let cfg = {}, last = null;

    const fxMode = () => {
      const pick = cfg.fx && cfg.fx !== "auto" ? cfg.fx : getComputedStyle(root).getPropertyValue("--fx").trim() || "glitch";
      return pick;
    };
    const theme = () => cfg.theme || "cyber";
    const particleKind = () => cfg.particles === false ? "" : getComputedStyle(root).getPropertyValue("--particles").trim();
    const sound = (kind) => { if (opts.sound && cfg.sfx !== false) SFX.play(theme(), kind, cfg.sfx_volume ?? .5); };
    // a burst of the style's particles from the avatar when someone joins / leaves
    const burst = (el, mode) => {
      const kind = particleKind();
      if (!kind || kind === "none" || !el.isConnected) return;
      const top = el.offsetTop + el.offsetHeight / 2, acc = getComputedStyle(el).getPropertyValue("--acc");
      for (let i = 0; i < (mode === "out" ? 12 : 6); i++) spawn(root, root, kind, { any: true, spread: 1.25, top, acc });
    };
    const animate = (el, mode, done) => {
      if (mode !== "blip") burst(el, mode);
      sound(mode === "in" ? "join" : mode === "out" ? "leave" : "blip");
      const m = fxMode();
      if (m === "none") { el.classList.remove("pre"); if (mode === "out") el.style.opacity = "0"; done && done(); return; }
      if (mode === "blip" && m !== "glitch") return;
      if (m === "glitch") glitch(el, mode, done); else soft(el, mode, done, FX_CSS.has(m) ? m : "soft");
    };

    // particles for talking rows (petals / embers / sparks), if the theme has them
    setInterval(() => {
      if (cfg.particles === false) return;
      const kind = getComputedStyle(root).getPropertyValue("--particles").trim();
      if (!kind || kind === "none") return;
      for (const r of rows.values()) {
        if (!r.el.classList.contains("talk")) continue;
        spawn(root, r.el, kind);
      }
    }, 260);

    function render(s) {
      last = s;
      const people = s.people || [];
      const live = new Set(people.map((p) => p.id));
      let batch = 0;
      for (const [id, r] of rows) {   // leavers first, so they keep their slot while they animate out
        if (!live.has(id)) {
          r.el.classList.add("leaving");
          rows.delete(id);
          animate(r.el, "out", () => { r.el.classList.add("gone"); setTimeout(() => r.el.remove(), 320); });
        }
      }
      people.forEach((p, i) => {
        let r = rows.get(p.id);
        if (!r) { r = { el: makeRow(p), src: null, st: p.st, fresh: true }; rows.set(p.id, r); }
        const el = r.el;
        const want = [...$list.children].filter((c) => !c.classList.contains("leaving"))[i];
        if (want !== el) $list.insertBefore(el, want || null);
        const talking = p.speaking && !p.mute;
        el.classList.toggle("talk", talking);
        el.classList.toggle("muted", !!(p.mute || p.deaf));
        el.classList.toggle("lit", p.st !== "idle");
        el.dataset.st = p.st;
        if (!r.fresh && r.st !== p.st && /mute|deaf/.test(r.st + p.st)) animate(el, "blip");
        r.st = p.st;
        el.querySelector(".tag").textContent = TAGS[p.st] || "";
        el.style.display = cfg.only_speaking && !talking ? "none" : "";
        if (p.accent) el.style.setProperty("--talk", p.accent);
        const src = (talking && p.avatarTalk) || p.avatar || initials(p.name, p.id);
        if (src !== r.src) { el.querySelector("img").src = src; r.src = src; }
        el.querySelector(".idx").textContent = String(i + 1).padStart(2, "0");
        el.querySelector(".name").textContent = p.name;
        el.querySelector(".you").textContent = p.me ? "YOU" : "";
        el.querySelector(".st").innerHTML = p.deaf ? DEAF : p.mute ? MIC_OFF : "";
        el.querySelector(".plate").style.display = cfg.show_names === false ? "none" : "";
        if (r.fresh) { r.fresh = false; setTimeout(() => animate(el, "in"), 90 * (batch++)); }
      });
      root.querySelector(".ch").textContent = s.channel || "";
      root.querySelector(".n").textContent = people.length ? String(people.length).padStart(2, "0") : "";
      $hdr.style.display = cfg.show_header === false ? "none" : "";
      root.classList.toggle("empty", !s.channel || !people.length);
    }

    function setConfig(c) {
      cfg = c || {};
      root.dataset.theme = cfg.theme || "cyber";
      if (cfg.palette && cfg.palette !== "default") root.dataset.palette = cfg.palette; else delete root.dataset.palette;
      root.style.removeProperty("--c");
      if (cfg.accent_override) root.style.setProperty("--c", cfg.accent_override);
      root.classList.toggle("right", cfg.anchor === "right");
      root.style.transform = !opts.noScale && cfg.scale && cfg.scale !== 1 ? `scale(${cfg.scale})` : "";
      root.style.setProperty("--idle-op", cfg.idle_opacity ?? .8);
      if (last) render(last);
    }

    return { render, setConfig, replay() { for (const r of rows.values()) animate(r.el, "in"); },
             leaveAll() { for (const r of rows.values()) animate(r.el, "out", () => { r.el.style.opacity = ""; animate(r.el, "in"); }); } };
  };

  // generic demo cast for previews (no real names)
  window.demoCast = function () {
    const cast = [["Nova", "idle"], ["Pixel", "idle"], ["Echo", "selfmute"], ["Orbit", "idle"], ["You", "idle", true], ["Static", "deaf"]];
    return cast.map(([n, st, me], i) => ({ id: "demo" + i, name: n, me: !!me, st, mute: /mute/.test(st), deaf: st === "deaf",
                                           speaking: false, avatar: null }));
  };
  window.demoTick = function (people) {
    for (const p of people) {
      if (p.mute || p.deaf) continue;
      p.speaking = Math.random() < 0.38;
      p.st = p.speaking ? (p.me ? "youtalk" : "talk") : "idle";
    }
    return people;
  };
})();
