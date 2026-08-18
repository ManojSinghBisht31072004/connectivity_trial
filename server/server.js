/**
 * server.js
 * ---------------------------------------------------------------------------
 * Cloud queue for the SaaS -> Desktop Agent -> TallyPrime bridge.
 *
 * This is the piece you deploy on Render. It does NOT talk to Tally directly
 * (it can't — Tally only listens on localhost on the accountant's PC). It just
 * holds invoices in a queue until the desktop agent (running on the
 * accountant's machine) comes and picks them up.
 *
 * ENDPOINTS
 * ---------
 * POST /api/invoices
 *   Upload a new invoice JSON to the queue. Call this from your SaaS backend
 *   (or directly, for testing) whenever an invoice is approved.
 *   Header:  Authorization: Bearer <CLIENT_API_KEY>
 *   Body:    the invoice JSON (same shape as sample_invoice.json)
 *
 * GET /api/sync/fetch
 *   The desktop agent polls this every few seconds.
 *   Header:  Authorization: Bearer <CLIENT_API_KEY>
 *   Returns: { hasPendingJob: true, jobId, invoice } or { hasPendingJob: false }
 *
 * POST /api/sync/acknowledge
 *   The desktop agent calls this after it has pushed the invoice into Tally.
 *   Header: Authorization: Bearer <CLIENT_API_KEY>
 *   Body:   { jobId, status: "completed" | "failed", detail? }
 *
 * GET /api/jobs
 *   Simple status view so you can see what's pending/completed for a key.
 *   Header:  Authorization: Bearer <CLIENT_API_KEY>
 *
 * GET /health
 *   Plain liveness check for Render.
 *
 * AUTH
 * ----
 * Very simple shared-secret model to start: each client (accounting firm) is
 * issued one API key. Set valid keys via the CLIENT_API_KEYS env var as a
 * comma-separated list, e.g.:
 *   CLIENT_API_KEYS=ca_firm_secure_token_abc123,another_firms_key_xyz789
 *
 * STORAGE
 * -------
 * In-memory array, for simplicity. This is fine to get the connectivity
 * working end-to-end, but Render's free/standard instances can restart and
 * wipe memory, and multiple instances won't share the queue. Once this works,
 * swap the `jobs` array for a real table (Postgres/SQLite) — the four
 * functions at the bottom (addJob/getNextPendingJob/markJobStatus/listJobs)
 * are the only places that would need to change.
 * ---------------------------------------------------------------------------
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));

// Serves public/index.html (the paste-JSON sync console) at "/",
// and public/downloads/tally-bridge-agent.zip at "/downloads/...".
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const VALID_KEYS = (process.env.CLIENT_API_KEYS || 'dev_test_key_change_me')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

// ----------------------------- In-memory queue ------------------------------

/** @type {Array<{id:string, apiKey:string, invoice:object, status:string, createdAt:string, updatedAt:string, detail:string|null}>} */
const jobs = [];

function addJob(apiKey, invoice) {
  const job = {
    id: crypto.randomUUID(),
    apiKey,
    invoice,
    status: 'pending', // pending -> processing -> completed | failed
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    detail: null,
  };
  jobs.push(job);
  return job;
}

function getNextPendingJob(apiKey) {
  return jobs.find((j) => j.apiKey === apiKey && j.status === 'pending') || null;
}

function markJobStatus(apiKey, jobId, status, detail) {
  const job = jobs.find((j) => j.apiKey === apiKey && j.id === jobId);
  if (!job) return null;
  job.status = status;
  job.detail = detail || null;
  job.updatedAt = new Date().toISOString();
  return job;
}

function listJobs(apiKey) {
  return jobs.filter((j) => j.apiKey === apiKey);
}

// -------------------------------- Auth middleware ---------------------------

function requireApiKey(req, res, next) {
  const header = req.headers.authorization || '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (!key || !VALID_KEYS.includes(key)) {
    return res.status(401).json({ error: 'Missing or invalid API key' });
  }
  req.apiKey = key;
  next();
}

// ----------------------------------- Routes ----------------------------------

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// SaaS UI (or a quick curl/Postman test) uploads an invoice here.
app.post('/api/invoices', requireApiKey, (req, res) => {
  const invoice = req.body;

  const validTypes = ['Purchase', 'Sales', 'Receipt', 'Payment'];
  if (!invoice || !validTypes.includes(invoice.voucherType)) {
    return res.status(400).json({
      error: `Invalid invoice payload. "voucherType" must be one of: ${validTypes.join(', ')}`,
    });
  }
  if (!invoice.companyName || !invoice.partyLedgerName || !invoice.date) {
    return res.status(400).json({
      error: 'Invoice must include at least companyName, partyLedgerName, and date',
    });
  }

  const job = addJob(req.apiKey, invoice);
  res.status(201).json({ ok: true, jobId: job.id, status: job.status });
});

// Desktop agent polls this.
app.get('/api/sync/fetch', requireApiKey, (req, res) => {
  const job = getNextPendingJob(req.apiKey);

  if (!job) {
    return res.json({ hasPendingJob: false });
  }

  job.status = 'processing';
  job.updatedAt = new Date().toISOString();

  res.json({
    hasPendingJob: true,
    jobId: job.id,
    invoice: job.invoice,
  });
});

// Desktop agent reports back here.
app.post('/api/sync/acknowledge', requireApiKey, (req, res) => {
  const { jobId, status, detail } = req.body || {};

  if (!jobId || !['completed', 'failed'].includes(status)) {
    return res.status(400).json({ error: 'Body must include jobId and status ("completed" or "failed")' });
  }

  const job = markJobStatus(req.apiKey, jobId, status, detail);
  if (!job) {
    return res.status(404).json({ error: 'Job not found for this API key' });
  }

  res.json({ ok: true, jobId: job.id, status: job.status });
});

// Handy status view while you're testing.
app.get('/api/jobs', requireApiKey, (req, res) => {
  res.json({ jobs: listJobs(req.apiKey) });
});

app.listen(PORT, () => {
  console.log(`Tally bridge cloud queue listening on port ${PORT}`);
  console.log(`Valid client API keys loaded: ${VALID_KEYS.length}`);
});