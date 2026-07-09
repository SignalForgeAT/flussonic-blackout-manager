#!/usr/bin/env node
/**
 * Flussonic Blackout Manager
 * Pokreni: node blackout.js
 * Otvori:  http://localhost:3000
 *
 * Zavisnosti: samo Node.js 18+ (nema npm install)
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");

// ─── BAZA (JSON fajl) ───────────────────────────────────────────
const DB_FILE = path.join(__dirname, "blackout_data.json");

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const init = {
      settings: {
        host: "http://your-flussonic-host:8080",
        username: "admin",
        password: ""
      },
      channels: [],
      schedules: [],
      logs: []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2));
    return init;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function nextId(arr) {
  return arr.length === 0 ? 1 : Math.max(...arr.map(x => x.id)) + 1;
}

// ─── FLUSSONIC API ───────────────────────────────────────────────
function basicAuth(user, pass) {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const lib = options.protocol === "https:" ? https : http;
    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseUrl(rawUrl) {
  try { return new URL(rawUrl); } catch { return null; }
}

async function flussonicGet(cfg, streamName) {
  const u = parseUrl(`${cfg.host}/streamer/api/v3/streams/${streamName}`);
  if (!u) return { ok: false, message: "Neispravan host URL" };
  try {
    const res = await httpRequest({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname,
      method: "GET",
      headers: { Authorization: basicAuth(cfg.username, cfg.password) }
    });
    if (res.status === 200) return { ok: true, data: JSON.parse(res.body) };
    return { ok: false, message: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

async function flussonicPut(cfg, streamName, inputs) {
  const u = parseUrl(`${cfg.host}/streamer/api/v3/streams/${streamName}`);
  if (!u) return { ok: false, message: "Neispravan host URL" };
  const body = JSON.stringify({ inputs });
  try {
    const res = await httpRequest({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname,
      method: "PUT",
      headers: {
        Authorization: basicAuth(cfg.username, cfg.password),
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, body);
    if (res.status === 200 || res.status === 204) return { ok: true };
    return { ok: false, message: `HTTP ${res.status}: ${res.body}` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

async function setStreamInput(cfg, streamName, inputUrl) {
  // 1. Dohvati trenutne inpute
  const get = await flussonicGet(cfg, streamName);
  if (!get.ok) return { ok: false, message: get.message };

  const existingInputs = get.data?.config_on_disk?.inputs || [];

  // 2. Postavi željeni input na prvo mjesto
  const targetExists = existingInputs.some(i => i.url === inputUrl);
  let newInputs;
  if (targetExists) {
    newInputs = [{ url: inputUrl }, ...existingInputs.filter(i => i.url !== inputUrl)];
  } else {
    newInputs = [{ url: inputUrl }, ...existingInputs];
  }

  // 3. Pošalji PUT
  const put = await flussonicPut(cfg, streamName, newInputs);
  if (put.ok) {
    return { ok: true, message: `Prebačeno na: ${inputUrl} (${newInputs.length} inputa sačuvano)` };
  }
  return { ok: false, message: put.message };
}

// Čita stvarni aktivni input iz Flussonica i upoređuje sa blackout inputom
async function getRealStatus(cfg, streamName, blackoutInput) {
  try {
    const get = await flussonicGet(cfg, streamName);
    if (!get.ok) return null;
    // Inputi su na top levelu, active status je unutar stats objekta svakog inputa
    const inputs = get.data?.inputs || [];
    const activeInput = inputs.find(i => i.stats?.active === true);
    if (!activeInput) return null;
    const activeUrl = activeInput.url || "";
    return activeUrl === blackoutInput ? "blackout" : "normal";
  } catch {
    return null;
  }
}

async function testConnection(cfg) {
  const u = parseUrl(`${cfg.host}/streamer/api/v3/config`);
  if (!u) return { ok: false, message: "Neispravan host URL" };
  try {
    const res = await httpRequest({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname,
      method: "GET",
      headers: { Authorization: basicAuth(cfg.username, cfg.password) }
    });
    if (res.status === 200) return { ok: true, message: "Konekcija uspješna" };
    return { ok: false, message: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// ─── SCHEDULER ──────────────────────────────────────────────────
function getCurrentTime() {
  const n = new Date();
  return `${String(n.getHours()).padStart(2,"0")}:${String(n.getMinutes()).padStart(2,"0")}`;
}

// Lokalni datum (ne UTC!) — važno za prelaz ponoći
function getLocalDateStr(date) {
  const d = date || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getTodayDate() {
  return getLocalDateStr(new Date());
}

// Datum od juče (za prelaz ponoći — period koji je počeo jučer)
function getYesterdayDate() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return getLocalDateStr(d);
}

function getTodayWeekday() {
  const d = new Date().getDay();
  return d === 0 ? 7 : d;
}

function getYesterdayWeekday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const wd = d.getDay();
  return wd === 0 ? 7 : wd;
}

function isInWindow(start, end, current) {
  if (start <= end) return current >= start && current <= end;
  return current >= start || current <= end;
}

function scheduleAppliesNow(s) {
  if (!s.active) return false;
  const today = getTodayDate();
  const yesterday = getYesterdayDate();
  const time = getCurrentTime();
  const weekday = getTodayWeekday();
  const yesterdayWeekday = getYesterdayWeekday();

  // Za prelaz ponoći (start > end, npr. 23:00-08:00):
  // period koji je počeo jučer a još traje danas ujutro
  const isOvernight = s.startTime > s.endTime;

  let dateMatch = false;
  if (s.dateType === "once") {
    if (s.endDate && s.endDate !== s.date) {
      // Eksplicitni endDate: aktivan ako je (danas===date I time>=startTime) ILI (danas===endDate I time<=endTime)
      if (today === s.date && time >= s.startTime) dateMatch = true;
      if (today === s.endDate && time <= s.endTime) dateMatch = true;
    } else {
      // Nema endDate ili je isti dan — stara logika
      if (s.date === today) dateMatch = true;
      // Ako je overnight i trenutno je "rano jutro" — provjeri i jučerašnji datum
      if (!dateMatch && isOvernight && s.date === yesterday && time <= s.endTime) dateMatch = true;
    }
  } else if (s.dateType === "daily") {
    dateMatch = true;
  } else if (s.dateType === "weekly") {
    try {
      const days = JSON.parse(s.weekdays || "[]");
      if (days.includes(weekday)) dateMatch = true;
      // Overnight: period koji je počeo jučer
      if (!dateMatch && isOvernight && days.includes(yesterdayWeekday) && time <= s.endTime) dateMatch = true;
    } catch {}
  }

  // Za once sa eksplicitnim endDate: vremenski uvjet je već uključen u dateMatch provjeri
  if (s.dateType === "once" && s.endDate && s.endDate !== s.date) {
    return dateMatch;
  }
  return dateMatch && isInWindow(s.startTime, s.endTime, time);
}

async function schedulerTick() {
  const db = loadDB();
  const cfg = db.settings;

  for (const ch of db.channels) {
    if (ch.manualOverride) continue;

    const activeSchedule = db.schedules.find(s => s.channelId === ch.id && scheduleAppliesNow(s));
    const shouldBlackout = !!activeSchedule;
    const isBlackout = ch.status === "blackout";

    if (shouldBlackout && !isBlackout) {
      console.log(`[SCHEDULER] BLACKOUT START: ${ch.name}`);
      const result = await setStreamInput(cfg, ch.streamName, ch.blackoutInput);
      ch.status = "blackout";
      db.logs.unshift({
        id: nextId(db.logs),
        channelId: ch.id,
        channelName: ch.name,
        action: "blackout_start",
        source: "schedule",
        message: result.ok ? `Blackout aktiviran: ${activeSchedule.description}` : `Greška: ${result.message}`,
        timestamp: new Date().toISOString()
      });
      if (db.logs.length > 200) db.logs = db.logs.slice(0, 200);
      saveDB(db);

    } else if (!shouldBlackout && isBlackout) {
      console.log(`[SCHEDULER] BLACKOUT END: ${ch.name}`);
      const result = await setStreamInput(cfg, ch.streamName, ch.originalInput);
      ch.status = "normal";
      db.logs.unshift({
        id: nextId(db.logs),
        channelId: ch.id,
        channelName: ch.name,
        action: "blackout_end",
        source: "schedule",
        message: result.ok ? "Originalni stream restauriran" : `Greška: ${result.message}`,
        timestamp: new Date().toISOString()
      });
      if (db.logs.length > 200) db.logs = db.logs.slice(0, 200);
      saveDB(db);
    }
  }
}

setInterval(schedulerTick, 30000);
schedulerTick();

// ─── HTML UI ─────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="bs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Blackout Manager</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#0f1117;color:#e2e8f0;display:flex;min-height:100vh}
  .sidebar{width:200px;background:#161b27;border-right:1px solid #1e2535;padding:16px;flex-shrink:0;display:flex;flex-direction:column}
  .logo{display:flex;align-items:center;gap:10px;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid #1e2535}
  .logo-icon{width:32px;height:32px;background:#0ea5e9;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:16px}
  .logo-text{font-size:13px;font-weight:700;color:#fff}
  .logo-sub{font-size:11px;color:#64748b}
  nav a{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:6px;color:#94a3b8;text-decoration:none;font-size:13px;margin-bottom:4px;cursor:pointer;border:none;background:none;width:100%}
  nav a:hover{background:#1e2535;color:#e2e8f0}
  nav a.active{background:#0ea5e9/15;color:#0ea5e9;background:rgba(14,165,233,0.15)}
  .version{margin-top:auto;font-size:11px;color:#475569;padding-top:12px;border-top:1px solid #1e2535}
  .main{flex:1;padding:24px;overflow-y:auto}
  .page{display:none}.page.active{display:block}
  h1{font-size:18px;font-weight:600;margin-bottom:4px}
  .subtitle{font-size:13px;color:#64748b;margin-bottom:20px}
  .btn{padding:7px 14px;border-radius:6px;border:none;cursor:pointer;font-size:13px;font-weight:500;display:inline-flex;align-items:center;gap:6px;transition:opacity .15s}
  .btn:hover{opacity:.85}
  .btn-primary{background:#0ea5e9;color:#fff}
  .btn-outline{background:transparent;border:1px solid #1e2535;color:#94a3b8}
  .btn-outline:hover{color:#e2e8f0;border-color:#334155}
  .btn-red{background:transparent;border:1px solid #7f1d1d;color:#f87171}
  .btn-red:hover{background:rgba(239,68,68,0.1)}
  .btn-green{background:transparent;border:1px solid #14532d;color:#4ade80}
  .btn-green:hover{background:rgba(74,222,128,0.1)}
  .btn-danger{background:transparent;border:1px solid #374151;color:#6b7280;padding:5px 8px}
  .btn-danger:hover{color:#f87171;border-color:#7f1d1d}
  .btn-icon{background:transparent;border:1px solid #1e2535;color:#64748b;padding:5px 8px;border-radius:5px;cursor:pointer;font-size:12px}
  .btn-icon:hover{color:#e2e8f0;border-color:#334155}
  .header-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:gap:8px}
  .header-actions{display:flex;gap:8px}
  .card{background:#161b27;border:1px solid #1e2535;border-radius:10px;padding:16px;margin-bottom:12px}
  .card.blackout{border-color:rgba(239,68,68,0.4);background:rgba(239,68,68,0.04)}
  .channel-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
  .channel-title{display:flex;align-items:center;gap:8px}
  .dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
  .dot-green{background:#22c55e}
  .dot-red{background:#ef4444;animation:pulse 1.5s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
  .ch-name{font-size:15px;font-weight:600}
  .ch-stream{font-size:11px;color:#475569;font-family:monospace}
  .badges{display:flex;gap:6px}
  .badge{padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500}
  .badge-live{background:rgba(34,197,94,0.1);color:#4ade80;border:1px solid rgba(34,197,94,0.3)}
  .badge-blackout{background:rgba(239,68,68,0.1);color:#f87171;border:1px solid rgba(239,68,68,0.3)}
  .badge-manual{background:rgba(234,179,8,0.1);color:#fbbf24;border:1px solid rgba(234,179,8,0.3)}
  .badge-blue{background:rgba(14,165,233,0.1);color:#38bdf8;border:1px solid rgba(14,165,233,0.2)}
  .input-row{display:flex;align-items:center;gap:6px;margin-bottom:4px}
  .input-url{font-size:11px;color:#64748b;font-family:monospace;word-break:break-all}
  .icon-ok{color:#22c55e;font-size:11px}
  .icon-err{color:#ef4444;font-size:11px}
  .ch-actions{display:flex;align-items:center;gap:6px;margin-top:12px;padding-top:10px;border-top:1px solid #1e2535}
  .empty{text-align:center;padding:60px 20px;color:#475569}
  .empty-icon{font-size:40px;margin-bottom:12px}
  .modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:100;align-items:center;justify-content:center}
  .modal-overlay.open{display:flex}
  .modal{background:#161b27;border:1px solid #1e2535;border-radius:12px;padding:24px;width:100%;max-width:460px;max-height:90vh;overflow-y:auto}
  .modal h2{font-size:16px;font-weight:600;margin-bottom:16px}
  .form-group{margin-bottom:14px}
  .form-group label{display:block;font-size:12px;color:#94a3b8;margin-bottom:6px;font-weight:500}
  .form-group input,.form-group select{width:100%;background:#0f1117;border:1px solid #1e2535;border-radius:6px;padding:8px 10px;color:#e2e8f0;font-size:13px;outline:none}
  .form-group input:focus,.form-group select:focus{border-color:#0ea5e9}
  .form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .modal-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
  .weekdays{display:flex;gap:6px;flex-wrap:wrap}
  .wd-btn{padding:5px 10px;border-radius:5px;border:1px solid #1e2535;background:transparent;color:#64748b;cursor:pointer;font-size:12px;font-weight:500}
  .wd-btn.selected{background:#0ea5e9;border-color:#0ea5e9;color:#fff}
  .schedule-row{display:flex;align-items:center;gap:12px;padding:12px 14px;background:#161b27;border:1px solid #1e2535;border-radius:8px;margin-bottom:8px}
  .toggle{position:relative;width:36px;height:20px;flex-shrink:0}
  .toggle input{opacity:0;width:0;height:0}
  .slider{position:absolute;inset:0;background:#374151;border-radius:10px;cursor:pointer;transition:.3s}
  .slider:before{content:"";position:absolute;width:14px;height:14px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.3s}
  input:checked+.slider{background:#0ea5e9}
  input:checked+.slider:before{transform:translateX(16px)}
  .sched-info{flex:1;min-width:0}
  .sched-desc{font-size:13px;font-weight:500}
  .sched-meta{font-size:11px;color:#64748b;margin-top:2px}
  .log-row{display:flex;align-items:flex-start;gap:12px;padding:10px 14px;background:#161b27;border:1px solid #1e2535;border-radius:8px;margin-bottom:6px}
  .log-icon{font-size:14px;margin-top:1px;flex-shrink:0}
  .log-info{flex:1}
  .log-action{font-size:13px;font-weight:600}
  .log-msg{font-size:11px;color:#64748b;margin-top:2px}
  .log-time{font-size:11px;color:#475569;flex-shrink:0}
  .action-red{color:#f87171}
  .action-green{color:#4ade80}
  .action-yellow{color:#fbbf24}
  .settings-card{background:#161b27;border:1px solid #1e2535;border-radius:10px;padding:20px;max-width:480px;margin-bottom:16px}
  .settings-card h3{font-size:14px;font-weight:600;margin-bottom:4px}
  .settings-card p{font-size:12px;color:#64748b;margin-bottom:16px}
  .test-result{display:flex;align-items:center;gap:8px;padding:10px 12px;border-radius:6px;font-size:13px;margin-top:12px}
  .test-ok{background:rgba(34,197,94,0.1);color:#4ade80;border:1px solid rgba(34,197,94,0.3)}
  .test-err{background:rgba(239,68,68,0.1);color:#f87171;border:1px solid rgba(239,68,68,0.3)}
  .group-title{font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin:16px 0 8px}
  .toast{position:fixed;bottom:20px;right:20px;padding:10px 16px;border-radius:8px;font-size:13px;font-weight:500;z-index:999;opacity:0;transition:opacity .3s;pointer-events:none}
  .toast.show{opacity:1}
  .toast-ok{background:#14532d;color:#4ade80;border:1px solid rgba(74,222,128,.3)}
  .toast-err{background:#7f1d1d;color:#f87171;border:1px solid rgba(248,113,113,.3)}
</style>
</head>
<body>

<div class="sidebar">
  <div class="logo">
    <div class="logo-icon">📡</div>
    <div><div class="logo-text">Blackout</div><div class="logo-sub">Manager</div></div>
  </div>
  <nav>
    <a onclick="showPage('channels')" id="nav-channels" class="active">📺 Kanali</a>
    <a onclick="showPage('schedule')" id="nav-schedule">📅 Raspored</a>
    <a onclick="showPage('logs')" id="nav-logs">📋 Logovi</a>
    <a onclick="showPage('settings')" id="nav-settings">⚙️ Podešavanja</a>
  </nav>
  <div class="version">v1.0 · Flussonic Blackout</div>
</div>

<div class="main">

  <!-- KANALI -->
  <div class="page active" id="page-channels">
    <div class="header-row">
      <div><h1>Kanali</h1><div class="subtitle" id="ch-subtitle">Učitavanje...</div></div>
      <div class="header-actions">
        <button class="btn btn-outline" onclick="loadChannels()">↻ Osvježi</button>
        <button class="btn btn-primary" onclick="openChannelModal()">+ Dodaj kanal</button>
      </div>
    </div>
    <div id="channels-list"></div>
  </div>

  <!-- RASPORED -->
  <div class="page" id="page-schedule">
    <div class="header-row">
      <div><h1>Raspored</h1><div class="subtitle" id="sched-subtitle">Učitavanje...</div></div>
      <button class="btn btn-primary" onclick="openScheduleModal()">+ Dodaj termin</button>
    </div>
    <div id="schedule-list"></div>
  </div>

  <!-- LOGOVI -->
  <div class="page" id="page-logs">
    <div class="header-row">
      <div><h1>Logovi</h1><div class="subtitle">Historija blackout akcija</div></div>
      <button class="btn btn-outline" onclick="loadLogs()">↻ Osvježi</button>
    </div>
    <div id="logs-list"></div>
  </div>

  <!-- PODEŠAVANJA -->
  <div class="page" id="page-settings">
    <h1>Podešavanja</h1>
    <div class="subtitle">Konfiguracija Flussonic servera</div>
    <div class="settings-card">
      <h3>Flussonic API</h3>
      <p>Podaci za konekciju sa Flussonic admin sučeljem</p>
      <div class="form-group">
        <label>Host (URL + port)</label>
        <input id="s-host" placeholder="http://your-flussonic-host:8080">
      </div>
      <div class="form-group">
        <label>Korisničko ime</label>
        <input id="s-user" placeholder="admin">
      </div>
      <div class="form-group">
        <label>Lozinka</label>
        <input id="s-pass" type="password" placeholder="Ostavi prazno da zadržiš trenutnu">
      </div>
      <div id="test-result" style="display:none"></div>
      <div style="display:flex;gap:8px;margin-top:8px">
        <button class="btn btn-outline" onclick="testConn()">🔌 Testiraj konekciju</button>
        <button class="btn btn-primary" onclick="saveSettings()">💾 Sačuvaj</button>
      </div>
    </div>
    <div class="settings-card">
      <h3>O aplikaciji</h3>
      <p>Scheduler provjerava raspored svakih 30 sekundi.<br>Podaci se čuvaju lokalno u blackout_data.json.</p>
    </div>
  </div>

</div>

<!-- MODAL: Kanal -->
<div class="modal-overlay" id="modal-channel">
  <div class="modal">
    <h2 id="modal-ch-title">Dodaj kanal</h2>
    <input type="hidden" id="ch-edit-id">
    <div class="form-group"><label>Naziv kanala</label><input id="ch-name" placeholder="npr. Channel1"></div>
    <div class="form-group"><label>Flussonic stream name (tačno kao u panelu)</label><input id="ch-stream" placeholder="channel1"></div>
    <div class="form-group"><label>Original input</label><input id="ch-orig" placeholder="tshttp://192.168.1.100:8788/play/channel1"></div>
    <div class="form-group"><label>Blackout input</label><input id="ch-blackout" placeholder="playlist:///path/to/blackout.txt"></div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal('modal-channel')">Odustani</button>
      <button class="btn btn-primary" onclick="saveChannel()">Sačuvaj</button>
    </div>
  </div>
</div>

<!-- MODAL: Raspored -->
<div class="modal-overlay" id="modal-schedule">
  <div class="modal">
    <h2 id="modal-sched-title">Dodaj termin</h2>
    <input type="hidden" id="sched-edit-id">
    <div class="form-group">
      <label>Kanal</label>
      <select id="sched-channel"></select>
    </div>
    <div class="form-group"><label>Opis (opcionalno)</label><input id="sched-desc" placeholder="npr. UEFA Final blackout"></div>
    <div class="form-group">
      <label>Tip ponavljanja</label>
      <select id="sched-type" onchange="onSchedTypeChange()">
        <option value="once">Jednom (određeni datum)</option>
        <option value="daily">Svaki dan</option>
        <option value="weekly">Sedmično</option>
      </select>
    </div>
    <div class="form-group" id="sched-date-group">
      <label>Datum početka</label>
      <input type="date" id="sched-date">
    </div>
    <div class="form-group" id="sched-enddate-group" style="display:none">
      <label>Datum kraja</label>
      <input type="date" id="sched-enddate">
    </div>
    <div class="form-group" id="sched-weekdays-group" style="display:none">
      <label>Dani u sedmici</label>
      <div class="weekdays">
        <button class="wd-btn" data-day="1" onclick="toggleWd(this)">Pon</button>
        <button class="wd-btn" data-day="2" onclick="toggleWd(this)">Uto</button>
        <button class="wd-btn" data-day="3" onclick="toggleWd(this)">Sri</button>
        <button class="wd-btn" data-day="4" onclick="toggleWd(this)">Čet</button>
        <button class="wd-btn" data-day="5" onclick="toggleWd(this)">Pet</button>
        <button class="wd-btn" data-day="6" onclick="toggleWd(this)">Sub</button>
        <button class="wd-btn" data-day="7" onclick="toggleWd(this)">Ned</button>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group"><label>Početak</label><input type="time" id="sched-start" value="20:00"></div>
      <div class="form-group"><label>Kraj</label><input type="time" id="sched-end" value="22:00"></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-outline" onclick="closeModal('modal-schedule')">Odustani</button>
      <button class="btn btn-primary" onclick="saveSchedule()">Sačuvaj</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
let channels = [], schedules = [], logs = [];

// ── Navigacija ──
function showPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  document.getElementById('nav-' + page).classList.add('active');
  if (page === 'channels') loadChannels();
  if (page === 'schedule') loadSchedule();
  if (page === 'logs') loadLogs();
  if (page === 'settings') loadSettings();
}

// ── Toast ──
function toast(msg, ok = true) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (ok ? 'toast-ok' : 'toast-err');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ── API helper ──
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 204) return {};
  return res.json();
}

// ── KANALI ──
async function loadChannels() {
  channels = await api('GET', '/api/channels');
  const list = document.getElementById('channels-list');
  const sub = document.getElementById('ch-subtitle');
  const blackoutCount = channels.filter(c => c.status === 'blackout').length;
  sub.textContent = channels.length + ' kanal' + (channels.length !== 1 ? 'a' : '') +
    (blackoutCount > 0 ? ' · ' + blackoutCount + ' u blackoutu' : '');
  sub.style.color = blackoutCount > 0 ? '#f87171' : '#64748b';

  if (channels.length === 0) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">📺</div><p>Nema dodanih kanala</p><br><button class="btn btn-primary" onclick="openChannelModal()">+ Dodaj prvi kanal</button></div>';
    return;
  }

  list.innerHTML = channels.map(ch => {
    const isBlackout = ch.status === 'blackout';
    return \`<div class="card \${isBlackout ? 'blackout' : ''}">
      <div class="channel-header">
        <div class="channel-title">
          <div class="dot \${isBlackout ? 'dot-red' : 'dot-green'}"></div>
          <div>
            <div class="ch-name">\${ch.name}</div>
            <div class="ch-stream">\${ch.streamName}</div>
          </div>
        </div>
        <div class="badges">
          \${isBlackout ? '<span class="badge badge-blackout">BLACKOUT</span>' : '<span class="badge badge-live">LIVE</span>'}
          \${ch.manualOverride ? '<span class="badge badge-manual">MANUAL</span>' : ''}
        </div>
      </div>
      <div class="input-row"><span class="icon-ok">✓</span><span class="input-url">\${ch.originalInput}</span></div>
      <div class="input-row"><span class="icon-err">●</span><span class="input-url">\${ch.blackoutInput}</span></div>
      <div class="ch-actions">
        \${isBlackout
          ? \`<button class="btn btn-green" onclick="blackoutOff(\${ch.id})">▶ Vrati live</button>\`
          : \`<button class="btn btn-red" onclick="blackoutOn(\${ch.id})">⏹ Blackout</button>\`
        }
        <button class="btn-icon" onclick="openChannelModal(\${ch.id})">✏️</button>
        <button class="btn-icon" onclick="deleteChannel(\${ch.id})" style="margin-left:auto">🗑️</button>
      </div>
    </div>\`;
  }).join('');
}

function openChannelModal(id) {
  document.getElementById('ch-edit-id').value = id || '';
  document.getElementById('modal-ch-title').textContent = id ? 'Uredi kanal' : 'Dodaj kanal';
  if (id) {
    const ch = channels.find(c => c.id === id);
    document.getElementById('ch-name').value = ch.name;
    document.getElementById('ch-stream').value = ch.streamName;
    document.getElementById('ch-orig').value = ch.originalInput;
    document.getElementById('ch-blackout').value = ch.blackoutInput;
  } else {
    ['ch-name','ch-stream','ch-orig','ch-blackout'].forEach(id => document.getElementById(id).value = '');
  }
  document.getElementById('modal-channel').classList.add('open');
}

async function saveChannel() {
  const id = document.getElementById('ch-edit-id').value;
  const data = {
    name: document.getElementById('ch-name').value.trim(),
    streamName: document.getElementById('ch-stream').value.trim(),
    originalInput: document.getElementById('ch-orig').value.trim(),
    blackoutInput: document.getElementById('ch-blackout').value.trim()
  };
  if (!data.name || !data.streamName || !data.originalInput || !data.blackoutInput) {
    toast('Sva polja su obavezna', false); return;
  }
  if (id) {
    await api('PUT', '/api/channels/' + id, data);
    toast('Kanal ažuriran');
  } else {
    await api('POST', '/api/channels', data);
    toast('Kanal dodan');
  }
  closeModal('modal-channel');
  loadChannels();
}

async function deleteChannel(id) {
  const ch = channels.find(c => c.id === id);
  if (!confirm('Obriši kanal "' + ch.name + '"?')) return;
  await api('DELETE', '/api/channels/' + id);
  toast('Kanal obrisan');
  loadChannels();
}

async function blackoutOn(id) {
  const r = await api('POST', '/api/channels/' + id + '/blackout/on');
  toast(r.ok ? 'Blackout aktiviran' : 'Greška: ' + r.message, r.ok);
  loadChannels();
}

async function blackoutOff(id) {
  const r = await api('POST', '/api/channels/' + id + '/blackout/off');
  toast(r.ok ? 'Stream restauriran' : 'Greška: ' + r.message, r.ok);
  loadChannels();
}

// ── RASPORED ──
async function loadSchedule() {
  schedules = await api('GET', '/api/schedules');
  channels = await api('GET', '/api/channels');
  const list = document.getElementById('schedule-list');
  document.getElementById('sched-subtitle').textContent = schedules.length + ' unos' + (schedules.length !== 1 ? 'a' : '');

  if (schedules.length === 0) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">📅</div><p>Nema rasporeda. Dodaj prvi termin.</p></div>';
    return;
  }

  const grouped = channels.map(ch => ({
    ch, items: schedules.filter(s => s.channelId === ch.id)
  })).filter(g => g.items.length > 0);

  list.innerHTML = grouped.map(({ ch, items }) =>
    \`<div class="group-title">\${ch.name}</div>\` +
    items.map(s => {
      let dateLabel;
      if (s.dateType === 'daily') {
        dateLabel = 'Svaki dan';
      } else if (s.dateType === 'once') {
        const fmt = d => d ? d.slice(8,10) + '.' + d.slice(5,7) : '';
        if (s.endDate && s.endDate !== s.date) {
          dateLabel = fmt(s.date) + ' \u2192 ' + fmt(s.endDate);
        } else {
          dateLabel = s.date || '';
        }
      } else {
        dateLabel = 'Sed: ' + (JSON.parse(s.weekdays || '[]').map(d => ['','Pon','Uto','Sri','Čet','Pet','Sub','Ned'][d]).join(', '));
      }
      return \`<div class="schedule-row">
        <label class="toggle"><input type="checkbox" \${s.active ? 'checked' : ''} onchange="toggleSchedule(\${s.id}, this.checked)"><span class="slider"></span></label>
        <div class="sched-info">
          <div class="sched-desc">\${s.description || 'Bez opisa'}</div>
          <div class="sched-meta">\${dateLabel} &nbsp;⏰ \${s.startTime} – \${s.endTime}</div>
        </div>
        <span class="badge badge-blue">\${s.dateType === 'once' ? 'Jednom' : s.dateType === 'daily' ? 'Dnevno' : 'Sedmično'}</span>
        <button class="btn-icon" onclick="openScheduleModal(\${s.id})">✏️</button>
        <button class="btn-icon" onclick="deleteSchedule(\${s.id})">🗑️</button>
      </div>\`;
    }).join('')
  ).join('');
}

async function toggleSchedule(id, active) {
  await api('PUT', '/api/schedules/' + id, { active });
  loadSchedule();
}

async function deleteSchedule(id) {
  if (!confirm('Obriši ovaj termin?')) return;
  await api('DELETE', '/api/schedules/' + id);
  toast('Raspored obrisan');
  loadSchedule();
}

function openScheduleModal(id) {
  const sel = document.getElementById('sched-channel');
  sel.innerHTML = channels.map(c => \`<option value="\${c.id}">\${c.name}</option>\`).join('');
  document.getElementById('sched-edit-id').value = id || '';
  document.getElementById('modal-sched-title').textContent = id ? 'Uredi termin' : 'Dodaj termin';

  document.querySelectorAll('.wd-btn').forEach(b => b.classList.remove('selected'));

  if (id) {
    const s = schedules.find(x => x.id === id);
    sel.value = s.channelId;
    document.getElementById('sched-desc').value = s.description;
    document.getElementById('sched-type').value = s.dateType;
    document.getElementById('sched-date').value = s.date || '';
    document.getElementById('sched-enddate').value = s.endDate || '';
    document.getElementById('sched-start').value = s.startTime;
    document.getElementById('sched-end').value = s.endTime;
    try {
      JSON.parse(s.weekdays || '[]').forEach(d => {
        const btn = document.querySelector('.wd-btn[data-day="' + d + '"]');
        if (btn) btn.classList.add('selected');
      });
    } catch {}
  } else {
    document.getElementById('sched-desc').value = '';
    document.getElementById('sched-type').value = 'once';
    document.getElementById('sched-date').value = '';
    document.getElementById('sched-enddate').value = '';
    document.getElementById('sched-start').value = '20:00';
    document.getElementById('sched-end').value = '22:00';
  }
  onSchedTypeChange();
  document.getElementById('modal-schedule').classList.add('open');
}

function onSchedTypeChange() {
  const type = document.getElementById('sched-type').value;
  document.getElementById('sched-date-group').style.display = type === 'once' ? '' : 'none';
  document.getElementById('sched-enddate-group').style.display = type === 'once' ? '' : 'none';
  document.getElementById('sched-weekdays-group').style.display = type === 'weekly' ? '' : 'none';
}

function toggleWd(btn) { btn.classList.toggle('selected'); }

async function saveSchedule() {
  const id = document.getElementById('sched-edit-id').value;
  const type = document.getElementById('sched-type').value;
  const weekdays = JSON.stringify(
    Array.from(document.querySelectorAll('.wd-btn.selected')).map(b => Number(b.dataset.day))
  );
  const endDateVal = type === 'once' ? document.getElementById('sched-enddate').value : null;
  const data = {
    channelId: Number(document.getElementById('sched-channel').value),
    description: document.getElementById('sched-desc').value.trim(),
    dateType: type,
    date: type === 'once' ? document.getElementById('sched-date').value : null,
    endDate: endDateVal || null,
    weekdays: type === 'weekly' ? weekdays : null,
    startTime: document.getElementById('sched-start').value,
    endTime: document.getElementById('sched-end').value,
    active: true
  };
  if (!data.startTime || !data.endTime) { toast('Unesi vremena', false); return; }
  if (type === 'once' && !data.date) { toast('Unesi datum početka', false); return; }
  if (type === 'once' && !data.endDate) { toast('Unesi datum kraja', false); return; }
  if (type === 'weekly' && JSON.parse(weekdays).length === 0) { toast('Odaberi dan', false); return; }
  if (id) { await api('PUT', '/api/schedules/' + id, data); toast('Raspored ažuriran'); }
  else { await api('POST', '/api/schedules', data); toast('Raspored dodan'); }
  closeModal('modal-schedule');
  loadSchedule();
}

// ── LOGOVI ──
async function loadLogs() {
  logs = await api('GET', '/api/logs');
  const list = document.getElementById('logs-list');
  if (logs.length === 0) {
    list.innerHTML = '<div class="empty"><div class="empty-icon">📋</div><p>Nema zabilježenih akcija</p></div>';
    return;
  }
  const icons = { blackout_start: ['⏹','action-red'], blackout_end: ['▶','action-green'], manual_on: ['⏹','action-yellow'], manual_off: ['▶','action-green'] };
  const labels = { blackout_start: 'Blackout START', blackout_end: 'Blackout KRAJ', manual_on: 'Ručno ON', manual_off: 'Ručno OFF' };
  list.innerHTML = logs.map(l => {
    const [icon, cls] = icons[l.action] || ['●',''];
    const ts = new Date(l.timestamp).toLocaleString('bs-BA');
    return \`<div class="log-row">
      <div class="log-icon \${cls}">\${icon}</div>
      <div class="log-info">
        <div class="log-action \${cls}">\${labels[l.action] || l.action} <span class="badge badge-blue" style="margin-left:4px">\${l.channelName}</span> <span class="badge" style="background:rgba(100,116,139,.1);color:#94a3b8;border:1px solid #1e2535">\${l.source === 'manual' ? 'Ručno' : 'Raspored'}</span></div>
        \${l.message ? \`<div class="log-msg">\${l.message}</div>\` : ''}
      </div>
      <div class="log-time">\${ts}</div>
    </div>\`;
  }).join('');
}

// ── PODEŠAVANJA ──
async function loadSettings() {
  const s = await api('GET', '/api/settings');
  document.getElementById('s-host').value = s.host || '';
  document.getElementById('s-user').value = s.username || '';
  document.getElementById('s-pass').value = '';
}

async function saveSettings() {
  const data = {
    host: document.getElementById('s-host').value.trim(),
    username: document.getElementById('s-user').value.trim(),
    password: document.getElementById('s-pass').value
  };
  await api('PUT', '/api/settings', data);
  toast('Podešavanja sačuvana');
}

async function testConn() {
  const el = document.getElementById('test-result');
  el.style.display = 'none';
  const r = await api('POST', '/api/settings/test');
  el.style.display = 'flex';
  el.className = 'test-result ' + (r.ok ? 'test-ok' : 'test-err');
  el.textContent = (r.ok ? '✓ ' : '✗ ') + r.message;
}

// ── MODAL ──
function closeModal(id) { document.getElementById(id).classList.remove('open'); }
document.querySelectorAll('.modal-overlay').forEach(m => {
  m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); });
});

// ── INIT ──
loadChannels();
setInterval(loadChannels, 15000);
</script>
</body>
</html>`;

// ─── HTTP SERVER ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // Čitanje body-ja
  async function readBody() {
    return new Promise((resolve) => {
      let body = "";
      req.on("data", chunk => body += chunk);
      req.on("end", () => {
        try { resolve(JSON.parse(body)); } catch { resolve({}); }
      });
    });
  }

  function json(data, status = 200) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  function noContent() {
    res.writeHead(204);
    res.end();
  }

  // ── ROUTES ──
  try {
    // Serve HTML
    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HTML);
      return;
    }

    // Settings
    if (pathname === "/api/settings" && req.method === "GET") {
      const db = loadDB();
      return json({ host: db.settings.host, username: db.settings.username, password: db.settings.password ? "••••••••" : "" });
    }

    if (pathname === "/api/settings" && req.method === "PUT") {
      const body = await readBody();
      const db = loadDB();
      db.settings.host = body.host || db.settings.host;
      db.settings.username = body.username || db.settings.username;
      if (body.password) db.settings.password = body.password;
      saveDB(db);
      return json({ ok: true });
    }

    if (pathname === "/api/settings/test" && req.method === "POST") {
      const db = loadDB();
      const result = await testConnection(db.settings);
      return json(result);
    }

    // Channels — čita stvarni status iz Flussonica
    if (pathname === "/api/channels" && req.method === "GET") {
      const db = loadDB();
      const cfg = db.settings;
      // Ažuriraj status svakog kanala iz Flussonica (paralelno)
      const updated = await Promise.all(db.channels.map(async (ch) => {
        if (ch.manualOverride) return ch; // manual override — ne mijenjaj
        const realStatus = await getRealStatus(cfg, ch.streamName, ch.blackoutInput);
        if (realStatus !== null && realStatus !== ch.status) {
          ch.status = realStatus;
        }
        return ch;
      }));
      db.channels = updated;
      saveDB(db);
      return json(updated);
    }

    if (pathname === "/api/channels" && req.method === "POST") {
      const body = await readBody();
      const db = loadDB();
      const ch = { id: nextId(db.channels), ...body, status: "normal", manualOverride: false };
      db.channels.push(ch);
      saveDB(db);
      return json(ch, 201);
    }

    const chMatch = pathname.match(/^\/api\/channels\/(\d+)$/);
    if (chMatch) {
      const id = Number(chMatch[1]);
      if (req.method === "PUT") {
        const body = await readBody();
        const db = loadDB();
        const idx = db.channels.findIndex(c => c.id === id);
        if (idx === -1) return json({ error: "Not found" }, 404);
        db.channels[idx] = { ...db.channels[idx], ...body };
        saveDB(db);
        return json(db.channels[idx]);
      }
      if (req.method === "DELETE") {
        const db = loadDB();
        db.channels = db.channels.filter(c => c.id !== id);
        saveDB(db);
        return noContent();
      }
    }

    // Blackout ON/OFF
    const blackoutOn = pathname.match(/^\/api\/channels\/(\d+)\/blackout\/on$/);
    if (blackoutOn && req.method === "POST") {
      const id = Number(blackoutOn[1]);
      const db = loadDB();
      const ch = db.channels.find(c => c.id === id);
      if (!ch) return json({ error: "Not found" }, 404);
      const result = await setStreamInput(db.settings, ch.streamName, ch.blackoutInput);
      ch.status = "blackout";
      ch.manualOverride = true;
      db.logs.unshift({ id: nextId(db.logs), channelId: id, channelName: ch.name, action: "manual_on", source: "manual", message: result.ok ? "Ručni blackout aktiviran" : `Greška: ${result.message}`, timestamp: new Date().toISOString() });
      if (db.logs.length > 200) db.logs = db.logs.slice(0, 200);
      saveDB(db);
      return json(result);
    }

    const blackoutOff = pathname.match(/^\/api\/channels\/(\d+)\/blackout\/off$/);
    if (blackoutOff && req.method === "POST") {
      const id = Number(blackoutOff[1]);
      const db = loadDB();
      const ch = db.channels.find(c => c.id === id);
      if (!ch) return json({ error: "Not found" }, 404);
      const result = await setStreamInput(db.settings, ch.streamName, ch.originalInput);
      ch.status = "normal";
      ch.manualOverride = false;
      db.logs.unshift({ id: nextId(db.logs), channelId: id, channelName: ch.name, action: "manual_off", source: "manual", message: result.ok ? "Stream restauriran" : `Greška: ${result.message}`, timestamp: new Date().toISOString() });
      if (db.logs.length > 200) db.logs = db.logs.slice(0, 200);
      saveDB(db);
      return json(result);
    }

    // Schedules
    if (pathname === "/api/schedules" && req.method === "GET") {
      return json(loadDB().schedules);
    }

    if (pathname === "/api/schedules" && req.method === "POST") {
      const body = await readBody();
      const db = loadDB();
      const s = { id: nextId(db.schedules), ...body };
      db.schedules.push(s);
      saveDB(db);
      return json(s, 201);
    }

    const schedMatch = pathname.match(/^\/api\/schedules\/(\d+)$/);
    if (schedMatch) {
      const id = Number(schedMatch[1]);
      if (req.method === "PUT") {
        const body = await readBody();
        const db = loadDB();
        const idx = db.schedules.findIndex(s => s.id === id);
        if (idx === -1) return json({ error: "Not found" }, 404);
        db.schedules[idx] = { ...db.schedules[idx], ...body };
        saveDB(db);
        return json(db.schedules[idx]);
      }
      if (req.method === "DELETE") {
        const db = loadDB();
        db.schedules = db.schedules.filter(s => s.id !== id);
        saveDB(db);
        return noContent();
      }
    }

    // Logs
    if (pathname === "/api/logs" && req.method === "GET") {
      return json(loadDB().logs.slice(0, 100));
    }

    res.writeHead(404);
    res.end("Not found");

  } catch (e) {
    console.error(e);
    res.writeHead(500);
    res.end("Server error: " + e.message);
  }
});

server.listen(PORT, () => {
  console.log("════════════════════════════════════════");
  console.log("  Flussonic Blackout Manager pokrenuta");
  console.log(`  Otvori: http://localhost:${PORT}`);
  console.log("════════════════════════════════════════");
  console.log("[SCHEDULER] Pokrenut — provjera svakih 30s");
});
