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
      g.classList.remove("pre", "gone", "ht", "ht2", "soft-in", "soft-out");
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

  function soft(el, mode, done) {
    el.classList.remove("pre", "soft-in", "soft-out");
    void el.offsetWidth;
    el.classList.add(mode === "out" ? "soft-out" : "soft-in");
    setTimeout(() => {
      el.classList.remove("soft-in");
      if (mode === "out") el.style.opacity = "0";
      done && done();
    }, mode === "out" ? 340 : 520);
  }

  window.createHud = function (root, opts = {}) {
    root.classList.add("hud", "empty");
    root.innerHTML = `<div class="hdr"><span class="pip"></span><span>VOICE</span><span class="rule"></span><span class="ch"></span><span class="n"></span></div><ul class="list"></ul>`;
    const $list = root.querySelector(".list"), $hdr = root.querySelector(".hdr");
    const rows = new Map();
    let cfg = {}, last = null;

    const fxMode = () => {
      const pick = cfg.fx && cfg.fx !== "auto" ? cfg.fx : getComputedStyle(root).getPropertyValue("--fx").trim() || "glitch";
      return pick;
    };
    const animate = (el, mode, done) => {
      const m = fxMode();
      if (m === "none") { el.classList.remove("pre"); if (mode === "out") el.style.opacity = "0"; done && done(); return; }
      if (mode === "blip" && m !== "glitch") return;
      (m === "glitch" ? glitch : soft)(el, mode, done);
    };

    // particles for talking rows (petals / embers / sparks), if the theme has them
    setInterval(() => {
      if (cfg.particles === false) return;
      const kind = getComputedStyle(root).getPropertyValue("--particles").trim();
      if (!kind || kind === "none") return;
      for (const r of rows.values()) {
        if (!r.el.classList.contains("talk")) continue;
        const p = document.createElement("i");
        p.className = "pt " + kind;
        if (kind === "petal") p.style.backgroundImage = `url(petals/p${1 + Math.floor(Math.random() * 8)}.png)`;   // real petal sprites
        const right = root.classList.contains("right");
        p.style.setProperty("--dx", (right ? -1 : 1) * rnd(14, 60) + "px");
        p.style.setProperty("--dy", rnd(-30, 10) + "px");
        p.style.setProperty("--rot", rnd(120, 420) + "deg");
        if (right) { p.style.left = "auto"; p.style.right = "calc(var(--av) / 2)"; }
        p.style.top = rnd(20, 70) + "%";
        r.el.appendChild(p);
        setTimeout(() => p.remove(), 2000);
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

    return { render, setConfig, replay() { for (const r of rows.values()) animate(r.el, "in"); } };
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
