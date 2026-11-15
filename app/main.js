// Nova Heads (cyber) - Electron main process.
// Transparent, click-through, always-on-top window + Discord local RPC (StreamKit app id,
// same trick as trigg/Discover, so no developer app / secret). Token shared with ../token.json.
const { app, BrowserWindow, globalShortcut, screen, ipcMain, Tray, Menu, nativeImage, nativeTheme,
        desktopCapturer, session, shell } = require("electron");
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
                   real_glass: false, autostart: false, accent_override: null, people: {} };
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
  for (const p of state.people.values()) {
    if (cfg.hide_self && p.id === state.me) continue;
    const pc = cfg.people[(p.username || "").toLowerCase()] || cfg.people[p.id] || {};
    const custom = customHead([p.username, p.id, pc.image]);
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
  return { channel: state.channel, people, status: state.status };
}

function push() {
  if (pushQueued) return;
  pushQueued = true;
  setImmediate(() => { pushQueued = false; const v = view();
    for (const w of [win, panel]) if (w && !w.isDestroyed()) w.webContents.send("state", v); });
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

// ------------------------------------------------------------------ window
app.commandLine.appendSwitch("disable-renderer-backgrounding");
const TEST = SHOT || argv.includes("--burst");
if (TEST) app.setPath("userData", path.join(require("os").tmpdir(), "nova-heads-test"));   // don't fight the live copy
else if (!app.requestSingleInstanceLock()) app.quit();
else app.on("second-instance", () => app.isReady() && openPanel());   // launching again (e.g. desktop shortcut) = open the panel

let panel = null, tray = null;

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
function pickDisplay() {
  const all = screen.getAllDisplays();
  return all.find((d) => String(d.id) === String(cfg.display))
      || (cfg.display_hint && all.find((d) => hintOf(d) === cfg.display_hint))
      || screen.getPrimaryDisplay();
}
function hudSize(d) {
  const sc = cfg.scale || 1;
  return { W: Math.round(400 * sc), H: Math.round(Math.min(d.height * 0.66, 660 * sc)) };
}
function placeOverlay() {
  const disp = pickDisplay(), d = disp.bounds, { W, H } = hudSize(d);
  if (cfg.pos_x == null || cfg.pos_y == null) {          // migrate the old side + height settings
    cfg.pos_x = cfg.anchor === "right" ? 1 : 0;
    cfg.pos_y = clamp01((Math.round(d.height * (cfg.top ?? 0.33)) - 40) / Math.max(1, d.height - H));
  }
  const fx = clamp01(cfg.pos_x), fy = clamp01(cfg.pos_y);
  const x = Math.round(d.x + fx * (d.width - W)), y = Math.round(d.y + fy * (d.height - H));
  cfg.anchor = fx > 0.55 ? "right" : "left";              // heads hug the nearest edge, names point inward
  cfg._valign = fy > 0.6 ? "bottom" : "top";              // near the bottom the list grows upward
  if (win) win.setBounds({ x, y, width: W, height: H });
  cfg._display = String(disp.id);
  cfg._win = { x: x - d.x, y: y - d.y };
  cfg._screen = { w: d.width, h: d.height };
  cfg._hud = { w: W, h: H };
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
  cfg._displays = displays();
  for (const w of [win, panel]) if (w && !w.isDestroyed()) w.webContents.send("config", { ...cfg, demo: DEMO });
}

function applyGlass() {
  if (!win) return;
  win.setContentProtection(!!cfg.real_glass);    // the HUD must not see itself in the capture
}

function openPanel() {
  if (panel && !panel.isDestroyed()) { panel.show(); panel.focus(); return; }
  nativeTheme.themeSource = "dark";
  panel = new BrowserWindow({
    width: 1080, height: 680, minWidth: 900, minHeight: 560, frame: false, show: false, title: "Nova Heads",
    backgroundMaterial: "acrylic", backgroundColor: "#00000000", icon: path.join(__dirname, "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  panel.loadFile(path.join(__dirname, "panel.html"));
  panel.webContents.once("did-finish-load", () => {
    sendConfig(); push(); panel.show();
    const pg = arg("--page"); if (pg) panel.webContents.executeJavaScript(`document.querySelector('nav [data-p="${pg}"]').click()`);
  });
  panel.on("closed", () => { panel = null; });
}

function makeTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ width: 16, height: 16 }));
    tray.setToolTip("Nova Heads");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "Open control panel", click: openPanel },
      { label: "Show / hide HUD", click: () => (win.isVisible() ? win.hide() : win.showInactive()) },
      { type: "separator" },
      { label: "Quit Nova Heads", click: () => app.quit() },
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

  ipcMain.on("ready", () => { sendConfig(); push(); });
  ipcMain.on("setMany", (_e, obj) => {
    for (const [k, v] of Object.entries(obj || {})) if (["pos_x", "pos_y"].includes(k)) cfg[k] = clamp01(v);
    placeOverlay(); saveCfg(); sendConfig(); push();
  });
  ipcMain.on("identify", identify);
  const replace = () => { placeOverlay(); sendConfig(); push(); };
  screen.on("display-added", replace); screen.on("display-removed", replace); screen.on("display-metrics-changed", replace);
  ipcMain.on("set", (_e, { key, value }) => {
    cfg[key] = value;
    if (key === "display") { const d = screen.getAllDisplays().find((x) => String(x.id) === String(value)); if (d) cfg.display_hint = hintOf(d); }
    if (["pos_x", "pos_y", "scale", "display"].includes(key)) placeOverlay();
    if (key === "real_glass") applyGlass();
    if (key === "autostart" && !TEST) app.setLoginItemSettings({ openAtLogin: !!value, args: [] });
    saveCfg();
    sendConfig();
    push();
  });
  ipcMain.on("openHeads", () => { fs.mkdirSync(HEADS, { recursive: true }); shell.openPath(HEADS); });
  ipcMain.on("win", (_e, what) => { if (!panel) return; what === "min" ? panel.minimize() : panel.close(); });

  globalShortcut.register("Control+Alt+H", () => (win.isVisible() ? win.hide() : win.showInactive()));
  globalShortcut.register("Control+Alt+J", openPanel);
  globalShortcut.register("Control+Alt+Shift+H", () => app.quit());
  if (!TEST) setTimeout(() => { sendConfig(); }, 500);
  if (!TEST) { makeTray(); if (FIRST_RUN || argv.includes("--panel")) openPanel(); saveCfg(); }
  if (argv.includes("--panel") && TEST) openPanel();

  if (DEMO) demo(); else new RPC().start();

  const target = () => (argv.includes("--shoot-panel") && panel ? panel : win);
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
  if (TEST) log("overlay bounds " + JSON.stringify(win.getBounds()) + " on display " + cfg._display + " anchor " + cfg.anchor + " valign " + cfg._valign + " displays " + JSON.stringify(displays().map((d) => [d.id, d.x, d.w])));
  if (SECONDS) setTimeout(() => app.quit(), SECONDS * 1000);
});

app.on("window-all-closed", () => {});   // keep running in the tray when the panel closes
app.on("will-quit", () => globalShortcut.unregisterAll());
