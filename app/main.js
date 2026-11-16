// Nova Heads (cyber) - Electron main process.
// Transparent, click-through, always-on-top window + Discord local RPC (StreamKit app id,
// same trick as trigg/Discover, so no developer app / secret). Token shared with ../token.json.
const { app, BrowserWindow, globalShortcut, screen, ipcMain, Tray, Menu, nativeImage, nativeTheme,
        desktopCapturer, session, shell, dialog } = require("electron");
const net = require("net");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const TOKEN_FILE = path.join(ROOT, "token.json");
const LOG_FILE = path.join(ROOT, "nova_heads.log");
const HEADS = path.join(ROOT, "heads");
const STREAMKIT_ID = "207646673902501888";
const CHANNEL_EVENTS = ["VOICE_STATE_CREATE", "VOICE_STATE_UPDATE", "VOICE_STATE_DELETE", "SPEAKING_START", "SPEAKING_STOP"];

const argv = process.argv.slice(1);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DEMO = argv.includes("--demo");
const SHOT = arg("--shot"), SHOT_AT = parseFloat(arg("--shot-at", "3")), SECONDS = parseFloat(arg("--seconds", "0"));

const CONFIG_FILE = path.join(ROOT, "config.json");
const DEFAULTS = { theme: "cyber", palette: "default", anchor: "left", top: 0.33, margin: 14, scale: 1, idle_opacity: 0.8,
                   hide_self: false, only_speaking: false, show_header: true, show_names: true, fx: "auto", particles: true, sfx: true, sfx_volume: 0.5,
                   compact: false, toasts: true, stream: false, stream_anchor: "left", hide_from_capture: false, profiles: {}, custom_slice: 30,
                   real_glass: false, autostart: false, accent_override: null, people: {},
                   music_show: true, music_style: "match", music_scale: 1, music_autohide: true, music_accent: "art", music_opacity: 1,
                   music_display: null, music_display_hint: null, music_x: null, music_y: null, music_hide_capture: false };
const FIRST_RUN = !fs.existsSync(CONFIG_FILE);
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");   // HUD sounds play without a click
let cfg = { ...DEFAULTS };
try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) }; } catch {}
function saveCfg() {
  if (TEST) return;
  const out = {}; for (const [k, v] of Object.entries(cfg)) if (!k.startsWith("_")) out[k] = v;
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(out, null, 2)); } catch (e) { log("config save failed: " + e.message); }
}
cfg.people = Object.fromEntries(Object.entries(cfg.people || {}).map(([k, v]) => [k.toLowerCase(), v]));

function log(m) {
  const line = new Date().toTimeString().slice(0, 8) + " " + m;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

// ------------------------------------------------------------------ state
const state = { channel: null, me: null, people: new Map(), status: "starting" };
let win = null, pushQueued = false;

function customHead(keys) {
  for (const k of keys) {
    if (!k) continue;
    for (const ext of [".png", ".gif", ".webp", ".jpg", ".jpeg"]) {
      const p = path.join(HEADS, k.toLowerCase() + ext);
      if (fs.existsSync(p)) return "file:///" + p.replace(/\\/g, "/");
    }
  }
  return null;
}

function view() {
  const people = [];
  const roster = [];
  for (const p of state.people.values()) {
    const pc = cfg.people[(p.username || "").toLowerCase()] || cfg.people[p.id] || {};
    const custom = customHead([p.username, p.id, pc.image]);
    roster.push({ id: p.id, user: p.username || p.id, name: p.name || p.username || "?", avatar: custom || p.avatarUrl, custom: !!custom });
    if (cfg.hide_self && p.id === state.me) continue;
    if (pc.hidden) continue;
    const base = custom && custom.replace(/\.[a-z0-9]+$/i, "");
    const talk = custom ? customHead([path.basename(base) + "_talk"]) : null;
    people.push({
      id: p.id, name: pc.name || p.name || p.username || "?", me: p.id === state.me,
      avatar: custom || p.avatarUrl, avatarTalk: talk, mute: p.mute, deaf: p.deaf, speaking: p.speaking,
      accent: pc.accent || null,
      // one status word drives the colour: deaf > servermute > selfmute > localmute > you-talk > talk > idle
      st: p.deaf ? "deaf" : p.serverMute ? "servermute" : p.selfMute ? "selfmute" : p.localMute ? "localmute"
          : p.speaking ? (p.id === state.me ? "youtalk" : "talk") : "idle",
    });
  }
  return { channel: state.channel, people, roster, status: state.status };
}

function push() {
  if (pushQueued) return;
  pushQueued = true;
  setImmediate(() => { pushQueued = false; trackTalk(); const v = view();
    for (const w of [win, panel]) if (w && !w.isDestroyed()) w.webContents.send("state", v);
    sse("state", v); });
}

function applyVoiceState(vs) {
  const u = vs.user || {};
  let p = state.people.get(u.id);
  if (!p) { p = { id: u.id, speaking: false }; state.people.set(u.id, p); }
  p.username = u.username || p.username;
  p.name = vs.nick || u.global_name || u.username || p.name;
  p.avatarUrl = u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128`
                         : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(u.id) >> 22n) % 6n)}.png`;
  const s = vs.voice_state || {};
  p.selfMute = !!s.self_mute;
  p.serverMute = !!(s.mute || s.suppress);
  p.localMute = !!vs.mute;                 // muted by you, locally
  p.deaf = !!(s.deaf || s.self_deaf);
  p.mute = p.selfMute || p.serverMute || p.localMute;
}

// ------------------------------------------------------------------ discord rpc
class RPC {
  constructor() { this.sock = null; this.buf = Buffer.alloc(0); this.sub = null; this.pending = new Map(); }

  start() { this.connect(0); }

  connect(i) {
    if (i > 9) { state.status = "waiting for Discord"; push(); return setTimeout(() => this.connect(0), 5000); }
    const s = net.createConnection(`\\\\?\\pipe\\discord-ipc-${i}`);
    s.once("error", () => this.connect(i + 1));
    s.once("connect", () => {
      s.removeAllListeners("error");
      this.sock = s; this.buf = Buffer.alloc(0);
      s.on("data", (d) => this.onData(d));
      s.on("close", () => this.closed("pipe closed"));
      s.on("error", (e) => this.closed(e.message));
      this.send(0, { v: 1, client_id: STREAMKIT_ID });
    });
  }

  closed(why) {
    if (!this.sock) return;
    this.sock = null; this.sub = null;
    state.people.clear(); state.channel = null; state.status = "reconnecting"; push();
    log("rpc: " + why);
    setTimeout(() => this.connect(0), 5000);
  }

  send(op, obj) {
    const data = Buffer.from(JSON.stringify(obj));
    const h = Buffer.alloc(8); h.writeUInt32LE(op, 0); h.writeUInt32LE(data.length, 4);
    this.sock && this.sock.write(Buffer.concat([h, data]));
  }

  cmd(cmd, args = {}, evt) {
    const nonce = crypto.randomUUID();
    const p = { cmd, args, nonce }; if (evt) p.evt = evt;
    this.send(1, p);
    return new Promise((res, rej) => this.pending.set(nonce, { res, rej }));
  }

  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 8) {
      const op = this.buf.readUInt32LE(0), n = this.buf.readUInt32LE(4);
      if (this.buf.length < 8 + n) break;
      const msg = JSON.parse(this.buf.subarray(8, 8 + n).toString());
      this.buf = this.buf.subarray(8 + n);
      if (op === 2) { this.closed(msg.message || "closed by Discord"); return; }
      this.handle(msg).catch((e) => log("rpc error: " + e.message));
    }
  }

  async handle(m) {
    if (m.nonce && this.pending.has(m.nonce)) {
      const p = this.pending.get(m.nonce); this.pending.delete(m.nonce);
      m.evt === "ERROR" ? p.rej(new Error(m.data && m.data.message)) : p.res(m.data);
      return;
    }
    const d = m.data || {};
    switch (m.evt) {
      case "READY": return this.login();
      case "VOICE_CHANNEL_SELECT":
        if (d.channel_id) this.setChannel(await this.cmd("GET_CHANNEL", { channel_id: d.channel_id }));
        else this.setChannel(null);
        return;
      case "VOICE_STATE_CREATE": case "VOICE_STATE_UPDATE": applyVoiceState(d); return push();
      case "VOICE_STATE_DELETE":
        state.people.delete(d.user.id); push();
        if (d.user.id === state.me) this.setChannel(await this.cmd("GET_SELECTED_VOICE_CHANNEL"));
        return;
      case "SPEAKING_START": case "SPEAKING_STOP": {
        const p = state.people.get(String(d.user_id));
        if (p) { p.speaking = m.evt === "SPEAKING_START"; push(); }
      }
    }
  }

  async token(fresh) {
    if (!fresh) { try { return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")).access_token; } catch {} }
    state.status = "click Authorize in Discord"; push();
    log("Discord may show an Authorize box - click Authorize (only needed once).");
    const { code } = await this.cmd("AUTHORIZE", { client_id: STREAMKIT_ID, scopes: ["rpc"], prompt: "none" });
    const r = await fetch("https://streamkit.discord.com/overlay/token", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
    const j = await r.json();
    if (!j.access_token) throw new Error("no token from StreamKit");
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ access_token: j.access_token }));
    return j.access_token;
  }

  async login() {
    let auth;
    try { auth = await this.cmd("AUTHENTICATE", { access_token: await this.token(false) }); }
    catch { auth = await this.cmd("AUTHENTICATE", { access_token: await this.token(true) }); }
    state.me = auth.user.id; state.status = "connected";
    log("connected as " + auth.user.username);
    await this.cmd("SUBSCRIBE", {}, "VOICE_CHANNEL_SELECT");
    this.setChannel(await this.cmd("GET_SELECTED_VOICE_CHANNEL"));
  }

  setChannel(ch) {
    if (this.sub) for (const e of CHANNEL_EVENTS) this.cmd("UNSUBSCRIBE", { channel_id: this.sub }, e).catch(() => {});
    this.sub = null;
    state.people.clear();
    state.channel = ch && ch.id ? ch.name : null;
    if (ch && ch.id) {
      for (const vs of ch.voice_states || []) applyVoiceState(vs);
      this.sub = ch.id;
      for (const e of CHANNEL_EVENTS) this.cmd("SUBSCRIBE", { channel_id: ch.id }, e).catch((x) => log("sub " + e + ": " + x.message));
      log(`voice channel: ${ch.name} (${(ch.voice_states || []).length} people)`);
    }
    push();
  }
}

// ------------------------------------------------------------------ demo
function demo() {
  // [name, selfMute, serverMute, localMute, deaf]
  const cast = [["Nova", 0, 0, 0, 0], ["Pixel", 0, 0, 0, 0], ["Echo", 1, 0, 0, 0], ["Orbit", 0, 0, 0, 0],
                ["You", 0, 0, 0, 0], ["Static", 0, 0, 0, 1], ["Vector", 0, 1, 0, 0], ["Glitch", 0, 0, 1, 0]];
  const mk = (i) => { const [n, sm, svm, lm, df] = cast[i];
    return { id: "d" + i, username: n, name: n, avatarUrl: null, selfMute: !!sm, serverMute: !!svm, localMute: !!lm,
             deaf: !!df, mute: !!(sm || svm || lm), speaking: false }; };
  state.channel = "Gaming"; state.me = "d4"; state.status = "connected";
  cast.forEach((_, i) => state.people.set("d" + i, mk(i)));
  let k = 0;
  setInterval(() => {
    k++;
    for (const p of state.people.values()) if (!p.mute && !p.deaf) p.speaking = Math.random() < 0.33;
    if (k % 12 === 6) state.people.delete("d1");          // someone glitches out...
    if (k % 12 === 10) { state.people.delete("d1"); const m = new Map(); for (const [id, p] of state.people) { m.set(id, p); if (id === "d0") m.set("d1", mk(1)); } state.people = m; }   // ...and back in
    push();
  }, 700);
  push();
}


// ------------------------------------------------------------------ v2.3: game profiles, stream source, stats, art
const http = require("http");
const { execFile } = require("child_process");
const CUSTOM = path.join(ROOT, "custom");
const THEME_IDS = ["cyber", "glass", "soft", "flow", "synth", "terminal", "mono", "holo", "comic", "sakura", "ember",
                   "ink", "noir", "oni", "anime", "pop", "pixel", "custom"];
const THEME_NAMES = { glass: "GLASS CUBE", synth: "SYNTHWAVE", ink: "INK 墨", oni: "ONI 鬼", pixel: "8-BIT", custom: "MY ART" };
// keys a game profile can override (everything about the look + where it sits)
const PROFILE_KEYS = ["theme", "palette", "accent_override", "display", "display_hint", "pos_x", "pos_y", "scale", "compact",
                      "fx", "particles", "idle_opacity", "show_header", "show_names", "only_speaking"];
let activeGame = null, runningApps = [], runningKey = "";
function eff() {
  const p = activeGame && cfg.profiles && cfg.profiles[activeGame];
  return p ? { ...cfg, ...p } : cfg;
}
const SKIP_APPS = new Set(["explorer", "electron", "applicationframehost", "textinputhost", "systemsettings", "shellexperiencehost",
  "searchhost", "startmenuexperiencehost", "lockapp", "nvidia overlay", "nvcontainer", "dwm", "csrss", "svchost", "conhost", "cmd",
  "powershell", "pwsh", "windowsterminal", "openconsole", "taskmgr", "rundll32", "dllhost", "sihost", "ctfmon", "widgets",
  "phoneexperiencehost", "gamebar", "gamebarftserver", "crashpad_handler", "claude", "msedgewebview2"]);
// every 5 s: which apps are running (Get-Process: fast, includes window titles)?
// a running app with a saved profile switches the HUD to that look
const PS_LIST = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Process | ForEach-Object { $_.ProcessName + [char]9 + $_.MainWindowTitle }";
function scanApps() {
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS_LIST], { windowsHide: true, maxBuffer: 16e6 }, (err, out) => {
    try {
      if (!err) {
        const names = new Set(), apps = new Map();
        for (const line of out.split(/\r?\n/)) {
          const [raw, title] = line.split("\t"); if (!raw) continue;
          const name = raw.trim().toLowerCase(); names.add(name);
          if (title && title.trim() && !SKIP_APPS.has(name) && !apps.has(name)) apps.set(name, title.trim().slice(0, 70));
        }
        runningApps = [...apps].map(([name, title]) => ({ name, title })).sort((a, b) => a.name.localeCompare(b.name));
        const next = Object.keys(cfg.profiles || {}).find((g) => names.has(g)) || null;
        if (next !== activeGame) {
          activeGame = next; log("game profile: " + (next || "none"));
          placeOverlay(); sendConfig(); push();
          toast(next ? "PROFILE · " + next.toUpperCase() : "DEFAULT LOOK");
        } else if (JSON.stringify(runningApps) !== runningKey) { runningKey = JSON.stringify(runningApps); if (panel && !panel.isDestroyed()) sendConfig(); }
      }
    } catch (e) { log("scanApps: " + e.message); }
    setTimeout(scanApps, 5000);
  });
}

// talk-time stats for this session
const stats = { since: Date.now(), people: {} };
const talkStart = new Map();
function trackTalk() {
  const now = Date.now();
  for (const p of state.people.values()) {
    const pc = cfg.people[(p.username || "").toLowerCase()] || cfg.people[p.id] || {};
    const s = stats.people[p.id] || (stats.people[p.id] = { ms: 0, turns: 0 });
    s.name = pc.name || p.name || p.username || s.name || "?"; s.avatar = customHead([p.username, p.id]) || p.avatarUrl || s.avatar;
    const on = p.speaking && !p.mute;
    if (on && !talkStart.has(p.id)) { talkStart.set(p.id, now); s.turns++; }
    if (!on && talkStart.has(p.id)) { s.ms += now - talkStart.get(p.id); talkStart.delete(p.id); }
  }
  for (const id of [...talkStart.keys()]) if (!state.people.has(id)) { stats.people[id].ms += now - talkStart.get(id); talkStart.delete(id); }
}
function statsView() {
  const now = Date.now();
  return { since: stats.since, people: Object.entries(stats.people)
    .map(([id, s]) => ({ id, name: s.name, avatar: s.avatar, turns: s.turns, ms: s.ms + (talkStart.has(id) ? now - talkStart.get(id) : 0) }))
    .filter((p) => p.turns > 0).sort((a, b) => b.ms - a.ms) };
}

// OBS browser source: a tiny local-only web server (127.0.0.1) serving a transparent copy of the HUD + live updates
let server = null;
const clients = new Set();
const streamPort = () => (TEST ? 7378 : cfg.stream_port || 7377);
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2",
               ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml" };
function sse(evt, data) {
  if (!clients.size) return;
  const msg = `event: ${evt}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}
function streamCfg() { return { ...eff(), anchor: cfg.stream_anchor || "left", _valign: "top", sfx: false, people: undefined, profiles: undefined }; }
function startStream() {
  if (server) return;
  server = http.createServer((req, res) => {
    let u; try { u = new URL(req.url, "http://localhost"); } catch { res.writeHead(400); return res.end(); }
    if (u.pathname === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      clients.add(res); req.on("close", () => clients.delete(res));
      res.write(`event: config\ndata: ${JSON.stringify(streamCfg())}\n\n`);
      res.write(`event: state\ndata: ${JSON.stringify(view())}\n\n`);
      return;
    }
    let file = null;
    const rel = decodeURIComponent(u.pathname);
    if (rel === "/" || rel === "/stream") file = path.join(__dirname, "stream.html");
    else if (rel.startsWith("/heads/")) file = path.join(HEADS, path.basename(rel));
    else if (rel.startsWith("/custom/")) file = path.join(CUSTOM, path.basename(rel));
    else if (/^\/(hud\.js|hud\.css|themes\.css|fonts\/[\w.-]+|petals\/[\w.-]+)$/.test(rel)) file = path.join(__dirname, rel);
    const ext = file ? path.extname(file).toLowerCase() : "";
    if (!file || !MIME[ext]) { res.writeHead(404); return res.end("not found"); }
    fs.readFile(file, (e, buf) => {
      if (e) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "Content-Type": MIME[ext], "Cache-Control": "no-cache" }); res.end(buf);
    });
  });
  server.on("error", (e) => { log("stream server: " + e.message); server = null; });
  server.listen(streamPort(), "127.0.0.1", () => log("OBS browser source at http://127.0.0.1:" + streamPort() + "/"));
}
function stopStream() {
  if (!server) return;
  for (const c of clients) c.end();
  clients.clear(); server.close(); server = null;
}

function toast(text) {
  if (win && !win.isDestroyed()) win.webContents.send("toast", text);
  sse("toast", text);
}

// one place that changes a setting (writes into the active game profile when the key belongs to the look)
function setKey(key, value) {
  const prof = activeGame && cfg.profiles && cfg.profiles[activeGame];
  const tgt = prof && PROFILE_KEYS.includes(key) ? prof : cfg;
  tgt[key] = value;
  if (key === "display") { const d = screen.getAllDisplays().find((x) => String(x.id) === String(value)); if (d) tgt.display_hint = hintOf(d); }
  if (["pos_x", "pos_y", "scale", "display"].includes(key)) placeOverlay();
  if (key === "real_glass" || key === "hide_from_capture") applyGlass();
  if (key === "stream") value ? startStream() : stopStream();
  if (key === "music_show") toggleMusic(!!value);
  if (key === "music_display") { const d = screen.getAllDisplays().find((x) => String(x.id) === String(value)); if (d) cfg.music_display_hint = hintOf(d); }
  if (["music_scale", "music_display", "music_x", "music_y"].includes(key)) placeMusic();
  if (key === "music_hide_capture" && musicWin && !musicWin.isDestroyed()) musicWin.setContentProtection(!!value);
  if (key === "autostart" && !TEST) app.setLoginItemSettings({ openAtLogin: !!value, args: [] });
  saveCfg(); sendConfig(); push();
}
function cycleTheme(dir) {
  const ids = THEME_IDS.filter((t) => t !== "custom" || cfg.custom_frame || cfg.custom_plate);
  const i = Math.max(0, ids.indexOf(eff().theme || "cyber"));
  const t = ids[(i + dir + ids.length) % ids.length];
  setKey("theme", t);
  toast("STYLE · " + (THEME_NAMES[t] || t.toUpperCase()));
}
const safeKey = (k) => String(k || "").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 40);
const IMG_EXT = [".png", ".gif", ".webp", ".jpg", ".jpeg"];

// ------------------------------------------------------------------ window
app.commandLine.appendSwitch("disable-renderer-backgrounding");
const TEST = SHOT || argv.includes("--burst");
if (TEST) app.setPath("userData", path.join(require("os").tmpdir(), "nova-heads-test"));   // don't fight the live copy
else if (!app.requestSingleInstanceLock()) app.quit();
else app.on("second-instance", () => app.isReady() && openPanel());   // launching again (e.g. desktop shortcut) = open the panel

let panel = null, tray = null, musicWin = null;

// ---------------------------------------------------------------- spotify now-playing widget
const spotify = require("./spotify")({ root: ROOT, log, demo: DEMO, onState: (s) => {
  for (const w of [musicWin, panel]) if (w && !w.isDestroyed()) w.webContents.send("music", s);
} });
const MW = 420, MH = 164;   // widget card 392x136 + 14px margin each side
function musicSize() { const k = cfg.music_scale || 1; return { width: Math.round(MW * k), height: Math.round(MH * k) }; }
function musicFast() { spotify.setFast(!!((musicWin && !musicWin.isDestroyed() && musicWin.isVisible()) || (panel && !panel.isDestroyed()))); }
// placement works like the HUD: a screen + x/y fractions. The widget and the HUD never overlap: if they would,
// the widget is pushed to the nearest free spot beside the HUD (panel drag does the same live).
const GAP = 6;
const hit = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
function pickMusicDisplay() {
  const all = screen.getAllDisplays();
  return all.find((d) => String(d.id) === String(cfg.music_display))
      || (cfg.music_display_hint && all.find((d) => hintOf(d) === cfg.music_display_hint))
      || pickDisplay();
}
function unhit(r, h, d) {
  if (!hit(r, h)) return r;
  const cl = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  const opts = [
    { x: r.x, y: h.y - r.height - GAP }, { x: r.x, y: h.y + h.height + GAP },
    { x: h.x - r.width - GAP, y: r.y }, { x: h.x + h.width + GAP, y: r.y },
  ].map((o) => ({ x: cl(o.x, d.x, d.x + d.width - r.width), y: cl(o.y, d.y, d.y + d.height - r.height), width: r.width, height: r.height }))
   .filter((o) => !hit(o, h))
   .sort((a, b) => Math.hypot(a.x - r.x, a.y - r.y) - Math.hypot(b.x - r.x, b.y - r.y));
  return opts[0] || r;
}
let placingMusic = false, hudContent = undefined, hudRectT = 0;
// the HUD's visible part in screen px (null = nothing shown); falls back to its whole window
function hudBlock() {
  if (!win || win.isDestroyed() || !win.isVisible()) return null;
  const b = win.getBounds();
  if (hudContent === undefined) return b;
  if (!hudContent) return null;
  const pad = 4;
  return { x: b.x + hudContent.x - pad, y: b.y + hudContent.y - pad, width: hudContent.w + pad * 2, height: hudContent.h + pad * 2 };
}
const CARD_PAD = 14;   // music.html body padding around the card
function cardH() { return eff().music_style === "y2k" ? 136 : 116; }
function musicRect() {
  const sz = musicSize(), disp = pickMusicDisplay(), d = disp.workArea;   // work area: never on top of the taskbar
  if (cfg.music_x == null || cfg.music_y == null) {
    if (cfg.music_bounds) {      // migrate the old absolute position
      const md = screen.getDisplayMatching({ x: cfg.music_bounds.x, y: cfg.music_bounds.y, width: sz.width, height: sz.height }).bounds;
      cfg.music_x = clamp01((cfg.music_bounds.x - md.x) / Math.max(1, md.width - sz.width));
      cfg.music_y = clamp01((cfg.music_bounds.y - md.y) / Math.max(1, md.height - sz.height));
      delete cfg.music_bounds;
    } else { cfg.music_x = 1; cfg.music_y = 1; }
  }
  let r = { x: Math.round(d.x + clamp01(cfg.music_x) * (d.width - sz.width)), y: Math.round(d.y + clamp01(cfg.music_y) * (d.height - sz.height)), ...sz };
  const hb = hudBlock();
  if (hb && String(pickDisplay().id) === String(disp.id)) {
    // collide the CARD (not the transparent window margin) with the visible HUD, a few px apart
    const k = cfg.music_scale || 1, m = Math.round(CARD_PAD * k);
    const card = { x: r.x + m, y: r.y + m, width: r.width - 2 * m, height: Math.round(cardH() * k) };
    const area = { x: d.x, y: d.y, width: d.width, height: d.height };
    const moved = unhit(card, hb, area);
    r = { ...r, x: moved.x - m, y: moved.y - m };
  }
  D._music = { display: String(disp.id), x: r.x - disp.bounds.x, y: r.y - disp.bounds.y, w: r.width, h: r.height };
  return r;
}
function placeMusic() {
  const r = musicRect();
  if (musicWin && !musicWin.isDestroyed()) { placingMusic = true; musicWin.setBounds(r); setTimeout(() => { placingMusic = false; }, 120); }
  return r;
}
function openMusic() {
  if (musicWin && !musicWin.isDestroyed()) { musicWin.showInactive(); musicFast(); return; }
  musicWin = new BrowserWindow({ ...musicRect(), transparent: true, frame: false, resizable: false, skipTaskbar: true,
    hasShadow: false, show: false, focusable: false, backgroundColor: "#00000000",
    webPreferences: { preload: path.join(__dirname, "preload.js"), backgroundThrottling: false } });
  musicWin.setAlwaysOnTop(true, "screen-saver");   // same layer as the voice HUD (stays over borderless games)
  musicWin.setContentProtection(!!cfg.music_hide_capture);
  // click-through like the HUD, EXCEPT the play/skip buttons + progress bar: mouse moves are forwarded so the card
  // can say "pointer is over a button" and become clickable just there
  musicWin.setIgnoreMouseEvents(true, { forward: true });
  musicWin.loadFile(path.join(__dirname, "music.html"));
  musicWin.webContents.once("did-finish-load", () => { sendConfig(); musicWin.webContents.send("music", spotify.state()); if (!SHOT || argv.includes("--show-test")) musicWin.showInactive(); musicFast(); });
  // dragged by hand on the desktop: store screen + fractions, then bump it off the HUD if it landed on it
  musicWin.on("moved", () => {
    if (placingMusic) return;
    const b = musicWin.getBounds(), disp = screen.getDisplayMatching(b), d = disp.workArea;
    cfg.music_display = String(disp.id); cfg.music_display_hint = hintOf(disp);
    cfg.music_x = clamp01((b.x - d.x) / Math.max(1, d.width - b.width));
    cfg.music_y = clamp01((b.y - d.y) / Math.max(1, d.height - b.height));
    placeMusic(); saveCfg(); sendConfig();
  });
  musicWin.on("closed", () => { musicWin = null; musicFast(); });
}
function toggleMusic(force) {
  const on = force ?? !(musicWin && !musicWin.isDestroyed() && musicWin.isVisible());
  if (on) openMusic(); else if (musicWin && !musicWin.isDestroyed()) musicWin.hide();
  musicFast();
}

// ---------------------------------------------------------------- monitors + placement
// cfg.display = Electron display id (+ display_hint = "x,y,w,h" in case ids change after a reboot / replug)
// cfg.pos_x / pos_y = 0..1 position of the HUD window inside that monitor (0,0 top-left .. 1,1 bottom-right)
const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
const hintOf = (d) => [d.bounds.x, d.bounds.y, d.bounds.width, d.bounds.height].join(",");
function displays() {
  const prim = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().slice().sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
    .map((d, i) => ({ id: String(d.id), n: i + 1, primary: d.id === prim, x: d.bounds.x, y: d.bounds.y,
                      w: d.bounds.width, h: d.bounds.height, label: d.label || "" }));
}
function pickDisplay(E = eff()) {
  const all = screen.getAllDisplays();
  return all.find((d) => String(d.id) === String(E.display))
      || (E.display_hint && all.find((d) => hintOf(d) === E.display_hint))
      || screen.getPrimaryDisplay();
}
function hudSize(d, E = eff()) {
  const sc = E.scale || 1;
  return { W: Math.round(400 * sc), H: Math.round(Math.min(d.height * 0.66, 660 * sc)) };
}
const D = {};   // derived placement facts, sent along with the config
function placeOverlay() {
  if (cfg.pos_x == null || cfg.pos_y == null) {          // migrate the old side + height settings
    const d0 = pickDisplay(cfg).bounds, { H: H0 } = hudSize(d0, cfg);
    cfg.pos_x = cfg.anchor === "right" ? 1 : 0;
    cfg.pos_y = clamp01((Math.round(d0.height * (cfg.top ?? 0.33)) - 40) / Math.max(1, d0.height - H0));
  }
  const E = eff(), disp = pickDisplay(E), d = disp.bounds, { W, H } = hudSize(d, E);
  const fx = clamp01(E.pos_x), fy = clamp01(E.pos_y);
  const x = Math.round(d.x + fx * (d.width - W)), y = Math.round(d.y + fy * (d.height - H));
  Object.assign(D, {
    anchor: fx > 0.55 ? "right" : "left",               // heads hug the nearest edge, names point inward
    _valign: fy > 0.6 ? "bottom" : "top",               // near the bottom the list grows upward
    _display: String(disp.id), _win: { x: x - d.x, y: y - d.y }, _screen: { w: d.width, h: d.height }, _hud: { w: W, h: H },
  });
  if (win) win.setBounds({ x, y, width: W, height: H });
  if (typeof placeMusic === "function" && musicWin) placeMusic(); else if (typeof musicRect === "function") try { musicRect(); } catch {}
  return { x, y, width: W, height: H };
}

// big number on every monitor for a couple of seconds, so you know which is which
function identify() {
  for (const d of displays()) {
    const w = new BrowserWindow({ x: Math.round(d.x + d.w / 2 - 130), y: Math.round(d.y + d.h / 2 - 130), width: 260, height: 260,
      frame: false, transparent: true, skipTaskbar: true, focusable: false, resizable: false, show: false, backgroundColor: "#00000000" });
    w.setIgnoreMouseEvents(true);
    w.setAlwaysOnTop(true, "screen-saver");
    const html = `<body style="margin:0;height:100vh;display:grid;place-items:center;background:transparent;overflow:hidden">
      <div style="width:200px;height:200px;display:grid;place-items:center;border:3px solid #4DF3FF;background:rgba(8,10,16,.82);
      font:700 120px/1 Segoe UI,sans-serif;color:#4DF3FF;text-shadow:0 0 24px rgba(77,243,255,.6)">${d.n}</div></body>`;
    w.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    w.once("ready-to-show", () => w.showInactive());
    setTimeout(() => { if (!w.isDestroyed()) w.close(); }, 2200);
  }
}

function sendConfig() {
  const out = { ...eff(), ...D, _displays: displays(), _game: activeGame, _running: runningApps, _stream_port: streamPort(),
                _stream_on: !!server, demo: DEMO };
  for (const w of [win, panel, musicWin]) if (w && !w.isDestroyed()) w.webContents.send("config", out);
  sse("config", streamCfg());
}

function applyGlass() {
  if (!win) return;
  win.setContentProtection(!!cfg.real_glass || !!cfg.hide_from_capture);    // the HUD must not see itself in the capture
}

function openPanel() {
  if (panel && !panel.isDestroyed()) { panel.show(); panel.focus(); return; }
  nativeTheme.themeSource = "dark";
  panel = new BrowserWindow({
    width: 1080, height: 680, minWidth: 900, minHeight: 560, frame: false, show: false, title: "Nova StreamHub",
    backgroundMaterial: "acrylic", backgroundColor: "#00000000", icon: path.join(__dirname, "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  panel.loadFile(path.join(__dirname, "panel.html"));
  panel.webContents.once("did-finish-load", () => {
    sendConfig(); push(); panel.show();
    const pg = arg("--page"); if (pg) panel.webContents.executeJavaScript(`document.querySelector('nav [data-p="${pg}"]').click()`);
  });
  panel.on("closed", () => { panel = null; musicFast(); });
  musicFast();
}

function makeTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ width: 16, height: 16 }));
    tray.setToolTip("Nova StreamHub");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Open control panel", click: openPanel },
      { label: "Show / hide HUD", click: () => (win.isVisible() ? win.hide() : win.showInactive()) },
      { label: "Show / hide now playing", click: () => toggleMusic() },
      { type: "separator" },
      { label: "Quit Nova StreamHub", click: () => app.quit() },
    ]));
    tray.on("click", openPanel);
  } catch (e) { log("tray failed: " + e.message); }
}

app.whenReady().then(() => {
  win = new BrowserWindow({
    ...placeOverlay(), transparent: true, frame: false, resizable: false, movable: false,
    skipTaskbar: true, focusable: false, hasShadow: false, show: false, backgroundColor: "#00000000",
    webPreferences: { preload: path.join(__dirname, "preload.js"), backgroundThrottling: false },
  });
  placeOverlay();
  win.setAlwaysOnTop(true, "screen-saver");
  win.setIgnoreMouseEvents(true);
  applyGlass();
  // real-glass mode: hand the overlay a capture of the primary screen, no picker
  session.defaultSession.setDisplayMediaRequestHandler((req, cb) => {
    desktopCapturer.getSources({ types: ["screen"] }).then((src) => {
      const on = pickDisplay().id;          // capture the monitor the HUD is on
      cb({ video: src.find((s) => String(s.display_id) === String(on)) || src[0] });
    }).catch(() => cb({}));
  });
  win.loadFile(path.join(__dirname, "index.html"));
  win.webContents.once("did-finish-load", () => { sendConfig(); win.showInactive(); push(); });

  ipcMain.on("ready", (e) => { sendConfig(); push(); e.sender.send("music", spotify.state()); });
  ipcMain.on("music", (_e, { cmd, arg }) => spotify.control(cmd, arg));
  ipcMain.handle("spotifyConnect", (_e, id) => spotify.connect(id, (u) => shell.openExternal(u)).then(() => ({ ok: true })).catch((e) => ({ ok: false, msg: e.message })));
  ipcMain.on("spotifyLogout", () => spotify.logout());
  // the card asks to be hidden while nothing plays (zero cost) and shown again when music starts
  ipcMain.on("musicClickable", (_e, v) => { if (TEST || argv.includes("--debug-mouse")) log("musicClickable " + v); if (musicWin && !musicWin.isDestroyed()) musicWin.setIgnoreMouseEvents(!v, { forward: true }); });
  ipcMain.on("dbg", (_e, m) => log("dbg " + m));
  ipcMain.on("musicVisible", (_e, v) => {
    if (!musicWin || musicWin.isDestroyed() || SHOT) return;
    if (v) { if (!musicWin.isVisible()) musicWin.showInactive(); } else if (musicWin.isVisible()) musicWin.hide();
    musicFast();
  });
  ipcMain.on("hudRect", (_e, r) => {
    hudContent = r;
    const b = win && !win.isDestroyed() ? win.getBounds() : null, dd = pickDisplay().bounds;
    D._hudc = r && b ? { x: b.x - dd.x + r.x, y: b.y - dd.y + r.y, w: r.w, h: r.h } : null;
    clearTimeout(hudRectT); hudRectT = setTimeout(() => { placeMusic(); sendConfig(); }, 80);
  });
  ipcMain.handle("playlists", (_e, force) => spotify.playlists(force).catch((err) => { log("playlists: " + err.message); return []; }));
  ipcMain.on("setMany", (_e, obj) => {
    const prof = activeGame && cfg.profiles && cfg.profiles[activeGame], tgt = prof || cfg;
    for (const [k, v] of Object.entries(obj || {})) {
      if (["pos_x", "pos_y"].includes(k)) tgt[k] = clamp01(v);
      if (["music_x", "music_y"].includes(k) && Number.isFinite(+v) && v !== null) cfg[k] = clamp01(v);
    }
    placeOverlay(); placeMusic(); saveCfg(); sendConfig(); push();
  });
  // per-person looks (saved by username)
  ipcMain.on("person", (_e, { key, patch }) => {
    const k = String(key || "").toLowerCase(); if (!k) return;
    const next = { ...(cfg.people[k] || {}), ...(patch || {}) };
    for (const [a, b] of Object.entries(next)) if (b === null || b === "" || b === false) delete next[a];
    if (Object.keys(next).length) cfg.people[k] = next; else delete cfg.people[k];
    saveCfg(); sendConfig(); push();
  });
  ipcMain.handle("pickHead", async (_e, key) => {
    const k = safeKey(key); if (!k) return false;
    const r = await dialog.showOpenDialog(panel, { title: "Pick a head image for " + k, properties: ["openFile"],
      filters: [{ name: "Images", extensions: ["png", "gif", "webp", "jpg", "jpeg"] }] });
    if (r.canceled || !r.filePaths[0]) return false;
    fs.mkdirSync(HEADS, { recursive: true });
    for (const e of IMG_EXT) try { fs.unlinkSync(path.join(HEADS, k + e)); } catch {}
    fs.copyFileSync(r.filePaths[0], path.join(HEADS, k + path.extname(r.filePaths[0]).toLowerCase()));
    push(); sendConfig(); return true;
  });
  ipcMain.on("clearHead", (_e, key) => {
    const k = safeKey(key); if (!k) return;
    for (const e of IMG_EXT) try { fs.unlinkSync(path.join(HEADS, k + e)); } catch {}
    push(); sendConfig();
  });
  // MY ART style: your own frame + plate images, copied into NovaHeads/custom
  ipcMain.handle("pickArt", async (_e, kind) => {
    if (!["frame", "plate"].includes(kind)) return false;
    const r = await dialog.showOpenDialog(panel, { title: kind === "frame" ? "Pick an avatar frame (transparent PNG)" : "Pick a name plate image",
      properties: ["openFile"], filters: [{ name: "Images", extensions: ["png", "webp", "gif", "jpg", "jpeg"] }] });
    if (r.canceled || !r.filePaths[0]) return false;
    fs.mkdirSync(CUSTOM, { recursive: true });
    for (const f of fs.readdirSync(CUSTOM)) if (f.startsWith(kind + "-")) try { fs.unlinkSync(path.join(CUSTOM, f)); } catch {}
    const dst = path.join(CUSTOM, `${kind}-${Date.now()}${path.extname(r.filePaths[0]).toLowerCase()}`);
    fs.copyFileSync(r.filePaths[0], dst);
    cfg["custom_" + kind] = "file:///" + dst.replace(/\\/g, "/");
    if ((eff().theme || "cyber") !== "custom") setKey("theme", "custom"); else { saveCfg(); sendConfig(); }
    return true;
  });
  ipcMain.on("clearArt", () => {
    try { for (const f of fs.readdirSync(CUSTOM)) fs.unlinkSync(path.join(CUSTOM, f)); } catch {}
    cfg.custom_frame = cfg.custom_plate = null; saveCfg(); sendConfig();
  });
  // game profiles
  ipcMain.on("profileSave", (_e, name) => {
    const g = String(name || "").toLowerCase().replace(/\.exe$/, "").trim(); if (!g) return;
    const E = eff(), snap = {};
    for (const k of PROFILE_KEYS) if (E[k] !== undefined) snap[k] = E[k];
    cfg.profiles = cfg.profiles || {}; cfg.profiles[g] = snap;
    saveCfg(); log("saved game profile " + g);
    if (runningApps.some((a) => a.name === g)) { activeGame = g; placeOverlay(); push(); }
    sendConfig();
  });
  ipcMain.on("profileDelete", (_e, name) => {
    if (!cfg.profiles || !cfg.profiles[name]) return;
    delete cfg.profiles[name];
    if (activeGame === name) { activeGame = null; placeOverlay(); push(); }
    saveCfg(); sendConfig();
  });
  ipcMain.on("statsReset", () => { stats.since = Date.now(); stats.people = {}; talkStart.clear(); trackTalk(); });
  ipcMain.on("identify", identify);
  const replace = () => { placeOverlay(); sendConfig(); push(); };
  screen.on("display-added", replace); screen.on("display-removed", replace); screen.on("display-metrics-changed", replace);
  ipcMain.on("set", (_e, { key, value }) => setKey(key, value));
  ipcMain.on("openHeads", () => { fs.mkdirSync(HEADS, { recursive: true }); shell.openPath(HEADS); });
  ipcMain.on("win", (_e, what) => { if (!panel) return; what === "min" ? panel.minimize() : panel.close(); });

  globalShortcut.register("Control+Alt+H", () => (win.isVisible() ? win.hide() : win.showInactive()));
  globalShortcut.register("Control+Alt+J", openPanel);
  globalShortcut.register("Control+Alt+M", () => toggleMusic());
  globalShortcut.register("Control+Alt+Shift+H", () => app.quit());
  globalShortcut.register("Control+Alt+Right", () => cycleTheme(1));
  globalShortcut.register("Control+Alt+Left", () => cycleTheme(-1));
  if (!TEST) setTimeout(() => { sendConfig(); }, 500);
  if (!TEST) { makeTray(); if (FIRST_RUN || argv.includes("--panel")) openPanel(); saveCfg(); }
  if (argv.includes("--panel") && TEST) openPanel();

  if (DEMO) demo(); else new RPC().start();
  spotify.start();
  if (eff().music_show !== false && !argv.includes("--no-music")) openMusic();
  scanApps();
  if (cfg.stream || argv.includes("--stream")) startStream();
  setInterval(() => { if (panel && !panel.isDestroyed()) panel.webContents.send("stats", statsView()); }, 1000);

  const target = () => (argv.includes("--shoot-panel") && panel ? panel : argv.includes("--shoot-music") && musicWin ? musicWin : win);
  if (SHOT) setTimeout(async () => {
    const img = await target().webContents.capturePage();
    fs.writeFileSync(SHOT, img.toPNG());
    log("shot saved " + SHOT);
    if (!SECONDS) app.quit();
  }, SHOT_AT * 1000);
  // --burst "DIR|t1,t2,..." : save a frame at each time (for checking animations)
  const BURST = arg("--burst");
  if (BURST) {
    const [dir, times] = BURST.split("|");
    times.split(",").map(Number).forEach((t) => setTimeout(async () => {
      const img = await target().webContents.capturePage();
      fs.writeFileSync(path.join(dir, `b_${t.toFixed(2)}.png`), img.toPNG());
    }, t * 1000));
  }
  // --cfg key=value,key=value : override config for a test run (not saved)
  const OV = arg("--cfg");
  if (OV) { for (const kv of OV.split(",")) { const [k, v] = kv.split("="); cfg[k] = v === "true" ? true : v === "false" ? false : isNaN(+v) ? v : +v; } placeOverlay(); sendConfig(); }
  if (TEST) log("overlay bounds " + JSON.stringify(win.getBounds()) + " on display " + D._display + " anchor " + D.anchor + " valign " + D._valign + " displays " + JSON.stringify(displays().map((d) => [d.id, d.x, d.w])));
  if (SECONDS) setTimeout(() => app.quit(), SECONDS * 1000);
});

app.on("window-all-closed", () => {});   // keep running in the tray when the panel closes
app.on("will-quit", () => globalShortcut.unregisterAll());
