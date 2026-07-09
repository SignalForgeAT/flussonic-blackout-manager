# Flussonic Blackout Manager

A lightweight, zero-dependency web application for scheduling automatic blackouts on [Flussonic Media Server](https://flussonic.com) streams. Built for broadcast engineers who need to switch streams to a blackout/placeholder input on a schedule — without touching the Flussonic admin panel manually.

> **Why this exists:** Flussonic has no built-in blackout scheduler. This tool fills that gap with a clean web UI, a reliable 30-second tick scheduler, and overnight schedule support.

---

## Features

- **Multi-channel management** — manage blackout schedules for any number of streams
- **Three schedule types:**
  - **Once** — single event with separate start date and end date (supports overnight, e.g. Jul 9 22:00 → Jul 10 01:00)
  - **Daily** — repeats every day at the same time
  - **Weekly** — repeats on selected weekdays
- **Real status reading** — reads actual active input from Flussonic API (`inputs[].stats.active`), so manual changes in the Flussonic panel are reflected immediately
- **Live log** — timestamped log of every blackout start/end action and its source (scheduled or manual)
- **Manual override** — force blackout on/off per channel at any time from the UI
- **Zero dependencies** — single `.js` file, runs on Node.js 18+ with no `npm install`
- **Persistent storage** — all data saved to a local `blackout_data.json` file, survives restarts

---

## Requirements

- Node.js 18 or newer
- Network access to your Flussonic server's HTTP API
- A Flussonic user account with API write permissions

---

## Installation

1. Copy `blackout.js` to any directory on your server:

```bash
mkdir ~/blackout
cp blackout.js ~/blackout/
cd ~/blackout
```

2. Start the app:

```bash
node blackout.js
```

3. Open your browser at `http://localhost:3000`

That's it. No `npm install`, no build step.

---

## Configuration

On first run, open **Settings** in the web UI and enter:

| Field | Description |
|-------|-------------|
| Host | Your Flussonic URL including port, e.g. `http://192.168.1.10:8080` |
| Username | Flussonic admin username |
| Password | Flussonic admin password |

Click **Test Connection** to verify before saving.

---

## How It Works

### Stream switching

Each channel has two inputs configured:
- **Original input** — the normal live source (e.g. `tshttp://192.168.1.100:8788/play/channel1`)
- **Blackout input** — the replacement source during blackout (e.g. `playlist:///path/to/blackout.txt`)

When a blackout is triggered, the app calls the Flussonic REST API (`PUT /streamer/api/v3/streams/{name}`) and reorders the inputs array so the blackout source is first. All other inputs are preserved. When the blackout ends, it restores the original input to first position.

### Scheduler

The scheduler runs every **30 seconds** and evaluates all active schedules. For `once` type schedules:

- Checks if today is the **start date** and current time ≥ start time → activate blackout
- Checks if today is the **end date** and current time ≤ end time → keep blackout active
- After end time on end date → deactivate blackout

This correctly handles overnight schedules such as `22:00 Jul 9 → 01:00 Jul 10`.

---

## Running with PM2 (recommended for production)

Install PM2 globally and configure autostart:

```bash
npm install -g pm2
pm2 start ~/blackout/blackout.js --name blackout
pm2 save
pm2 startup
```

To restart after updating the file:

```bash
pm2 restart blackout
```

---

## Adding Basic Auth (optional)

The app has no built-in authentication. If you expose it on a public IP, add HTTP Basic Auth manually at the top of `blackout.js`:

Find the line:
```js
const url = require("url");
```

Add below it:
```js
const AUTH_USER = "admin";
const AUTH_PASS = "your-password-here";
```

Then find the HTTP server handler (the `http.createServer` callback) and add before any routing:
```js
const authHeader = req.headers["authorization"] || "";
const expected = "Basic " + Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString("base64");
if (authHeader !== expected) {
  res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Blackout Manager"' });
  res.end("Unauthorized");
  return;
}
```

---

## Flussonic API Input Structure

The app expects the standard Flussonic v3 stream structure:

```json
{
  "inputs": [
    { "url": "tshttp://192.168.1.100:8788/play/channel1", "stats": { "active": true } },
    { "url": "playlist:///path/to/blackout.txt", "stats": { "active": false } }
  ]
}
```

The first input in the array is the active source. The app reorders — never deletes — inputs.

---

## Data File

All configuration and schedules are stored in `blackout_data.json` in the same directory as `blackout.js`. Back this file up to preserve your channel and schedule configuration.

---

## Tested On

- Ubuntu Server 22.04 / 24.04 LTS
- Node.js v18, v20
- Flussonic Media Server (recent versions with v3 REST API)
- Timezone: Europe/Sarajevo (CEST) — works with any timezone via Node.js system timezone

---

## License

MIT License — free to use, modify, and distribute.

---

## Contributing

Pull requests welcome. If you find a bug or have a feature request, open an issue.

---

*Built by a broadcast engineer, for broadcast engineers.*
