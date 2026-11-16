// Spotify for Nova Heads: now-playing + controls + your playlists, over the Web API.
// Token = ../spotify_token.json (PKCE login from the panel: your own Spotify developer app's Client ID, no secret). Never publish it.
const fs = require("fs"), path = require("path"), http = require("http"), crypto = require("crypto");
const REDIRECT = "http://127.0.0.1:8888/callback";
const SCOPES = "user-read-currently-playing user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative";

const API = "https://api.spotify.com/v1";
module.exports = function createSpotify({ root, log, onState, demo }) {
  const TOKEN_FILE = path.join(root, "spotify_token.json");
  let tok = null, last = { ok: false, msg: "starting" }, timer = null, fast = false, lists = [], listsAt = 0;

  async function token() {
    if (!tok) tok = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    if (Date.now() / 1000 > tok.expires_at) {
      const r = await fetch("https://accounts.spotify.com/api/token", { method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: tok.client_id }) });
      if (!r.ok) throw new Error("login expired (" + r.status + ")");
      const n = await r.json();
      tok = { ...tok, ...n, expires_at: Date.now() / 1000 + n.expires_in - 60 };
      fs.writeFileSync(TOKEN_FILE, JSON.stringify(tok, null, 1));   // refresh tokens rotate: keep the new one
    }
    return tok.access_token;
  }
  async function api(method, p, body) {
    const r = await fetch(API + p, { method, headers: { Authorization: "Bearer " + await token(),
      ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 204 || r.status === 202) return null;
    const t = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${(t.match(/"message"\s*:\s*"([^"]+)/) || [])[1] || ""}`.trim());
    try { return t ? JSON.parse(t) : null; } catch { return null; }   // some player calls answer 200 with a plain-text id
  }

  const DEMO = [
    { id: "d1", title: "Binhi", artist: "Arthur Nery", album: "Letters Never Sent", dur: 228000 },
    { id: "d2", title: "Saturn", artist: "SZA", album: "SOS Deluxe: Lana", dur: 186000 },
  ];
  let di = 0, d0 = Date.now() - 64000;
  async function poll() {
    let s;
    if (demo) {
      const t = DEMO[di % 2];
      s = { ok: true, playing: true, ...t, art: "demo-art.jpg", pos: (Date.now() - d0) % t.dur, device: "Demo PC", shuffle: false };
    } else if (!fs.existsSync(TOKEN_FILE)) {
      s = { ok: false, msg: "not connected" };
    } else {
      try {
        const p = await api("GET", "/me/player?additional_types=episode");
        if (!p || !p.item) s = { ok: true, idle: true, device: p && p.device && p.device.name };
        else {
          const it = p.item;
          s = { ok: true, playing: p.is_playing, id: it.id, uri: it.uri, title: it.name,
                artist: (it.artists || []).map((a) => a.name).join(", ") || (it.show && it.show.name) || "",
                album: (it.album && it.album.name) || "", dur: it.duration_ms, pos: p.progress_ms,
                art: ((it.album || it).images || [])[0]?.url || null, device: p.device && p.device.name,
                shuffle: p.shuffle_state, repeat: p.repeat_state, context: p.context && p.context.uri };
        }
      } catch (e) { s = { ok: false, msg: String(e.message || e) }; }
    }
    last = { ...s, at: Date.now() };
    onState(last);
  }
  function loop() { clearTimeout(timer); timer = setTimeout(async () => { await poll(); loop(); }, fast ? 1500 : 5000); }

  async function playlists(force) {
    if (demo || !fs.existsSync(TOKEN_FILE)) return [];
    if (!force && lists.length && Date.now() - listsAt < 60000) return lists;
    const me = await api("GET", "/me"); const out = [];
    let url = "/me/playlists?limit=50";
    while (url) {
      const pg = await api("GET", url);
      for (const p of pg.items) out.push({ uri: p.uri, name: p.name, mine: p.owner.id === me.id,
        img: (p.images || [])[0]?.url || null, count: (p.items || p.tracks || {}).total });
      url = pg.next ? pg.next.replace(API, "") : null;
    }
    lists = out; listsAt = Date.now(); return out;
  }

  async function control(what, arg) {
    if (demo) { if (what === "next" || what === "previous") { di++; d0 = Date.now(); } return poll(); }
    try {
      if (what === "toggle") await api("PUT", "/me/player/" + (last.playing ? "pause" : "play"));
      else if (what === "next" || what === "previous") await api("POST", "/me/player/" + what);
      else if (what === "seek") await api("PUT", "/me/player/seek?position_ms=" + Math.round(arg));
      else if (what === "shuffle") await api("PUT", "/me/player/shuffle?state=" + !last.shuffle);
      else if (what === "playlist") await api("PUT", "/me/player/play", { context_uri: arg });
    } catch (e) {
      log("spotify " + what + " failed: " + e.message);
      onState({ ...last, err: /NO_ACTIVE_DEVICE|404/.test(e.message) ? "open Spotify on this PC first" : e.message, at: Date.now() });
    }
    setTimeout(poll, 400);
  }

  // one-time login: opens Spotify's consent page, catches the redirect on 127.0.0.1:8888, swaps the code for a token
  function connect(clientId, openUrl) {
    clientId = String(clientId || "").trim();
    if (!/^[0-9a-f]{32}$/i.test(clientId)) return Promise.reject(new Error("that doesn't look like a Client ID (32 letters/numbers)"));
    const verifier = crypto.randomBytes(64).toString("base64url").slice(0, 96);
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    const state = crypto.randomBytes(12).toString("hex");
    return new Promise((resolve, reject) => {
      const srv = http.createServer(async (req, res) => {
        const u = new URL(req.url, REDIRECT);
        if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
        const ok = u.searchParams.get("state") === state && u.searchParams.get("code");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<body style="background:#0b0e16;color:#4DF3FF;font:20px monospace;display:grid;place-items:center;height:90vh">${ok ? "Spotify connected ✦ you can close this tab" : "login failed"}</body>`);
        srv.close(); clearTimeout(to);
        if (!ok) return reject(new Error(u.searchParams.get("error") || "login failed"));
        try {
          const r = await fetch("https://accounts.spotify.com/api/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "authorization_code", code: u.searchParams.get("code"), redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }) });
          if (!r.ok) throw new Error("token exchange " + r.status);
          const n = await r.json();
          tok = { ...n, client_id: clientId, expires_at: Date.now() / 1000 + n.expires_in - 60 };
          fs.writeFileSync(TOKEN_FILE, JSON.stringify(tok, null, 1));
          lists = []; poll(); resolve(true);
        } catch (e) { reject(e); }
      });
      const to = setTimeout(() => { srv.close(); reject(new Error("timed out")); }, 5 * 60 * 1000);
      srv.on("error", (e) => reject(new Error("port 8888 busy: " + e.message)));
      srv.listen(8888, "127.0.0.1", () => openUrl("https://accounts.spotify.com/authorize?" + new URLSearchParams({
        client_id: clientId, response_type: "code", redirect_uri: REDIRECT, scope: SCOPES, code_challenge_method: "S256", code_challenge: challenge, state })));
    });
  }
  function logout() { tok = null; lists = []; try { fs.unlinkSync(TOKEN_FILE); } catch {} poll(); }

  return {
    connect, logout,
    start() { poll(); loop(); },
    setFast(v) { if (fast !== !!v) { fast = !!v; loop(); if (fast) poll(); } },
    state: () => last, control, playlists, connected: () => demo || fs.existsSync(TOKEN_FILE),
  };
};
