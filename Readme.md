# SaaS → TallyPrime Bridge

Three pieces, tested end-to-end locally:

```
[ Browser page (server/public) ] --paste JSON, click Sync--> [ server/  (Render) ] <--poll-- [ agent/  (accountant's PC) ] --XML--> [ TallyPrime :9000 ]
                                                                       |
                                                          [ /downloads/tally-bridge-agent.zip ]
```

- **`server/`** — deploy this on Render. It's both the cloud queue (API) and
  the frontend (a single static page at `/`) in one Express app.
  - `server/public/index.html` — the no-frills frontend: a textarea to paste
    invoice JSON, a **Sync** button that posts it to the queue, and a
    **Download Tally Bridge Agent** link.
  - `server/public/downloads/tally-bridge-agent.zip` — the agent, pre-zipped,
    served as a static file. Rebuild it if you change `agent/agent.js` (see
    "Rebuilding the agent zip" below).
- **`agent/`** — no-UI console app. Runs on the accountant's PC, next to
  TallyPrime. It polls `server/` every few seconds and, when there's a
  pending invoice, converts it to Tally XML and posts it to
  `http://127.0.0.1:9000`.

All three were smoke-tested together in this session (real server, real
agent, fake Tally standing in for the real thing): paste JSON in the browser
→ click Sync → agent picks it up → XML pushed → acknowledged → status flips
to `completed`.

---

## What to do right now, in order

1. **Copy this whole `tally-bridge` folder into a new VS Code project.**
2. **Push it to GitHub** (commands in step "1. Push to GitHub" below).
3. **Deploy `server/` on Render** (step 2 below) — this gives you one live
   URL that serves both the API *and* the frontend page.
4. **Open that Render URL in a browser.** You'll see the paste-JSON page.
   Put your `CLIENT_API_KEYS` value into the "API Key" box, and click
   **Sync** — this queues the sample invoice that's pre-filled in the
   textarea. Nothing lands in Tally yet, because no agent is running.
5. **Click "Download Tally Bridge Agent"** on that same page → unzip it
   anywhere on the machine that has TallyPrime installed. Inside is
   `TallyBridgeAgent.exe` — a compiled Windows executable, no Node.js
   install needed on that machine.
6. **In TallyPrime:** load your company, then `F1 → Settings →
   Connectivity`, and enable the TCP/IP server on port `9000` (matches
   `agent/config.example.json`'s default).
7. **In the unzipped folder:** rename `config.example.json` →
   `config.json`, fill in `cloudApiUrl` (your Render URL) and `apiKey`
   (must match one of the `CLIENT_API_KEYS` values). Then **double-click
   `TallyBridgeAgent.exe`** — a console window opens and stays open; leave
   it running. (Windows SmartScreen may warn since it isn't code-signed —
   click "More info" → "Run anyway".)
8. **Go back to the browser page, paste/edit an invoice, click Sync again.**
   Within ~10 seconds the running agent should pick it up and you'll see
   `✅ Tally accepted the voucher` in its terminal, and the voucher should
   appear in Tally's Day Book.

That's the whole loop working. Everything after this (compiling to a
double-clickable `.exe`, moving the queue to a real database, adding
per-client accounts) is a refinement on top of a connection that already
works.

---

## 1. Push to GitHub

```bash
cd tally-bridge
git init
git add .
git commit -m "Initial SaaS-to-Tally bridge"
git branch -M main
git remote add origin https://github.com/<you>/tally-bridge.git
git push -u origin main
```

## 2. Deploy `server/` on Render

1. In Render: **New +** → **Web Service** → connect your GitHub repo.
2. Set **Root Directory** to `server`.
3. Build command: `npm install`. Start command: `npm start`.
4. Add an environment variable:
   - `CLIENT_API_KEYS` = a comma-separated list of secret keys, one per
     client firm, e.g. `ca_firm_secure_token_abc123,another_clients_key`.
   - (`render.yaml` is included if you prefer Render's Blueprint deploy.)
5. Deploy. You'll get a URL like `https://tally-bridge-server.onrender.com`.
6. Check it's alive: `curl https://tally-bridge-server.onrender.com/health`.

**Note on storage:** the queue is currently in-memory (see comments at the
top of `server/server.js`). That's fine for proving connectivity, but a free
Render instance can restart and lose the queue, and won't scale past one
instance. Once you've confirmed the flow works, swap the four functions
(`addJob`, `getNextPendingJob`, `markJobStatus`, `listJobs`) for a real table
— e.g. Render's managed Postgres — without touching any route logic.

## 3. Upload an invoice (this is what your SaaS backend will do on "Approve")

```bash
curl -X POST https://tally-bridge-server.onrender.com/api/invoices \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ca_firm_secure_token_abc123" \
  -d @sample_invoice.json
```

## 4. Set up the agent on the accountant's PC

1. Make sure **TallyPrime** is open with the company loaded, and the
   HTTP/XML server is enabled: `F1 (Help) → Settings → Connectivity` → set
   **TCP/IP port for Tally.NET / ODBC** to `9000` (or whatever you configure
   below).
2. Copy `agent/config.example.json` to `agent/config.json` and fill in your
   Render URL and the client's API key:
   ```json
   {
     "cloudApiUrl": "https://tally-bridge-server.onrender.com",
     "apiKey": "ca_firm_secure_token_abc123",
     "tallyHost": "127.0.0.1",
     "tallyPort": 9000,
     "pollIntervalSeconds": 10
   }
   ```
3. Install and test:
   ```bash
   cd agent
   npm install        # no runtime deps, this just installs pkg for step 5
   node agent.js --test     # confirms it can reach Tally
   node agent.js --once     # does a single poll/push cycle, useful for debugging
   node agent.js            # runs forever, polling every pollIntervalSeconds
   ```
   You should see `📦 Job found` → `✅ Tally accepted the voucher` in the
   console, and the invoice should appear in Tally's Day Book.

## 5. Rebuilding the `.exe` after you change `agent/agent.js`

The download button serves a static zip, so if you edit the agent code you
need to recompile and re-zip it:

```bash
cd agent
npm install                    # installs pkg (dev dependency)
npx pkg agent.js --targets node18-win-x64 --output dist/TallyBridgeAgent.exe

mkdir -p exe-package
cp dist/TallyBridgeAgent.exe config.example.json exe-package/
# copy/keep SETUP.md in exe-package/ too (already written for the exe version)

cd exe-package
zip -r ../../server/public/downloads/TallyBridgeAgent.zip TallyBridgeAgent.exe config.example.json SETUP.md
```

Commit and push — Render redeploys and the download link serves the new
build. This was already done once for you: the zip currently in
`server/public/downloads/` contains a working, tested `TallyBridgeAgent.exe`
(verified as a real Windows PE executable in this session).

Note: `pkg` bundles a full Node.js runtime into the executable, so it's
~35–40MB — that's expected, not a bug.

## API reference (server)

| Method | Path                    | Called by         | Purpose                                  |
|--------|--------------------------|--------------------|-------------------------------------------|
| POST   | `/api/invoices`          | Your SaaS backend  | Queue a new invoice                       |
| GET    | `/api/sync/fetch`        | Agent (polls)      | "Any pending invoice for my key?"         |
| POST   | `/api/sync/acknowledge`  | Agent              | Report success/failure back to the cloud  |
| GET    | `/api/jobs`               | You (debugging)    | See pending/completed jobs for a key      |
| GET    | `/health`                 | Render / you       | Liveness check                            |
| GET    | `/`                        | Browser            | The paste-JSON Sync page                  |
| GET    | `/downloads/TallyBridgeAgent.zip` | Browser      | Agent download (contains the .exe)        |

All API endpoints except `/health` require `Authorization: Bearer <apiKey>`.
The frontend page and the download link have no auth — the API key is typed
into the page itself and only sent when you click Sync.

//Working perfectly for Ledger creation.