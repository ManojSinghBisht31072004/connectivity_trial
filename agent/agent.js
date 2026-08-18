#!/usr/bin/env node
/**
 * agent.js
 * ---------------------------------------------------------------------------
 * No-UI desktop agent. Runs on the accountant's PC, next to TallyPrime.
 *
 * What it does, in order, forever:
 *   1. Polls your cloud backend: "any pending invoice for my API key?"
 *   2. If yes, converts the invoice JSON into Tally's XML voucher format.
 *   3. POSTs that XML to TallyPrime's local HTTP-XML gateway (localhost:9000).
 *   4. Tells the cloud backend whether it succeeded or failed.
 *   5. Waits, repeats.
 *
 * It never needs to be reachable from the internet — it only makes OUTBOUND
 * requests (to your cloud backend, and to Tally on localhost). That's what
 * lets it get through firewalls/NAT without any port forwarding.
 *
 * CONFIGURATION
 * -------------
 * Put a config.json file next to this script (or next to the compiled .exe):
 *   {
 *     "cloudApiUrl": "https://your-app.onrender.com",
 *     "apiKey": "ca_firm_secure_token_abc123",
 *     "tallyHost": "127.0.0.1",
 *     "tallyPort": 9000,
 *     "pollIntervalSeconds": 10
 *   }
 *
 * Environment variables override config.json if set:
 *   CLOUD_API_URL, API_KEY, TALLY_HOST, TALLY_PORT, POLL_INTERVAL_SECONDS
 *
 * USAGE
 * -----
 *   node agent.js                 # run continuously (this is what you'll
 *                                  # normally do / what the compiled .exe does)
 *   node agent.js --test          # just check that Tally is reachable, then exit
 *   node agent.js --once          # do a single poll cycle, then exit (for testing)
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ------------------------------- Configuration -------------------------------

function loadConfig() {
  // When compiled with `pkg`, __dirname points inside the virtual snapshot,
  // so we look for config.json next to the actual executable/script on disk.
  const baseDir = process.pkg ? path.dirname(process.execPath) : __dirname;
  const configPath = path.join(baseDir, 'config.json');

  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      console.error(`Could not parse config.json: ${err.message}`);
      process.exit(1);
    }
  }

  const config = {
    cloudApiUrl: process.env.CLOUD_API_URL || fileConfig.cloudApiUrl,
    apiKey: process.env.API_KEY || fileConfig.apiKey,
    tallyHost: process.env.TALLY_HOST || fileConfig.tallyHost || '127.0.0.1',
    tallyPort: Number(process.env.TALLY_PORT || fileConfig.tallyPort || 9000),
    pollIntervalSeconds: Number(
      process.env.POLL_INTERVAL_SECONDS || fileConfig.pollIntervalSeconds || 10
    ),
  };

  if (!config.cloudApiUrl || !config.apiKey) {
    console.error('Missing configuration. Create a config.json next to this file:');
    console.error(
      JSON.stringify(
        {
          cloudApiUrl: 'https://your-app.onrender.com',
          apiKey: 'ca_firm_secure_token_abc123',
          tallyHost: '127.0.0.1',
          tallyPort: 9000,
          pollIntervalSeconds: 10,
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  return config;
}

// --------------------------- XML ESCAPE / HELPERS --------------------------

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toTallyDate(isoDate) {
  return String(isoDate).replace(/-/g, '');
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function isIntraState(companyGstin, partyGstin) {
  if (!companyGstin || !partyGstin) return true;
  return companyGstin.slice(0, 2) === partyGstin.slice(0, 2);
}

// ----------------------- VOUCHER XML BUILDERS (per type) -------------------

function buildLedgerEntry(ledgerName, amount, isDeemedPositive, billAlloc) {
  const billXml = billAlloc
    ? `
        <BILLALLOCATIONS.LIST>
          <NAME>${xmlEscape(billAlloc)}</NAME>
          <BILLTYPE>Agst Ref</BILLTYPE>
          <AMOUNT>${amount.toFixed(2)}</AMOUNT>
        </BILLALLOCATIONS.LIST>`
    : '';
  return `
      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>${xmlEscape(ledgerName)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>${isDeemedPositive ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
        <AMOUNT>${amount.toFixed(2)}</AMOUNT>${billXml}
      </ALLLEDGERENTRIES.LIST>`;
}

function buildTradeVoucherEntries(inv) {
  const taxable = Number(inv.taxableAmount);
  const rate = Number(inv.taxRatePercent) / 100;
  const intra = isIntraState(inv.companyGstin, inv.partyGstin);

  let taxLines = [];
  let totalTax = 0;

  if (intra) {
    const half = round2((taxable * rate) / 2);
    totalTax = half * 2;
    taxLines.push(
      buildLedgerEntry(inv.ledgers.cgst, -half, true),
      buildLedgerEntry(inv.ledgers.sgst, -half, true)
    );
  } else {
    const igst = round2(taxable * rate);
    totalTax = igst;
    taxLines.push(buildLedgerEntry(inv.ledgers.igst, -igst, true));
  }

  const totalAmount = round2(taxable + totalTax);
  const isPurchase = inv.voucherType === 'Purchase';

  const partyEntry = buildLedgerEntry(
    inv.partyLedgerName,
    isPurchase ? totalAmount : -totalAmount,
    !isPurchase
  );
  const expenseOrIncome = buildLedgerEntry(
    inv.ledgers.purchaseOrSales,
    isPurchase ? -taxable : taxable,
    isPurchase
  );

  return [partyEntry, expenseOrIncome, ...taxLines].join('');
}

function buildCashVoucherEntries(inv) {
  const amount = round2(Number(inv.taxableAmount));
  const isReceipt = inv.voucherType === 'Receipt';

  const bankEntry = buildLedgerEntry(inv.ledgers.bank, isReceipt ? amount : -amount, isReceipt);
  const partyEntry = buildLedgerEntry(
    inv.partyLedgerName,
    isReceipt ? -amount : amount,
    !isReceipt,
    inv.billAllocationRef
  );

  return [bankEntry, partyEntry].join('');
}

// Builds one <TALLYMESSAGE> that creates a ledger, if it doesn't already
// exist. Tally's "Create" action is safe to send even if the ledger already
// exists — Tally just leaves the existing one alone rather than erroring,
// as long as nothing else in the request conflicts with it.
function buildLedgerCreateMessage(name, parent) {
  return `
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="${xmlEscape(name)}" ACTION="Create">
            <NAME>${xmlEscape(name)}</NAME>
            <PARENT>${xmlEscape(parent)}</PARENT>
          </LEDGER>
        </TALLYMESSAGE>`;
}

// inv.autoCreateLedgers is optional: an array like
//   [{ "name": "Mahavir Electricals", "parent": "Sundry Creditors" }, ...]
// Each one becomes its own <TALLYMESSAGE>, sent in the SAME request as the
// voucher — Tally processes them in order, so the ledgers exist by the time
// the voucher message runs.
function buildAutoCreateLedgerMessages(inv) {
  const list = Array.isArray(inv.autoCreateLedgers) ? inv.autoCreateLedgers : [];
  return list
    .filter((l) => l && l.name && l.parent)
    .map((l) => buildLedgerCreateMessage(l.name, l.parent))
    .join('');
}

function buildVoucherXml(inv) {
  const entries = ['Purchase', 'Sales'].includes(inv.voucherType)
    ? buildTradeVoucherEntries(inv)
    : buildCashVoucherEntries(inv);

  const ledgerMessages = buildAutoCreateLedgerMessages(inv);

  return `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${xmlEscape(inv.companyName)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>${ledgerMessages}
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="${xmlEscape(inv.voucherType)}" ACTION="Create" OBJVIEW="Accounting Voucher View">
            <DATE>${toTallyDate(inv.date)}</DATE>
            <VOUCHERTYPENAME>${xmlEscape(inv.voucherType)}</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${xmlEscape(inv.invoiceNumber || '')}</VOUCHERNUMBER>
            <REFERENCE>${xmlEscape(inv.invoiceNumber || '')}</REFERENCE>
            <PARTYLEDGERNAME>${xmlEscape(inv.partyLedgerName)}</PARTYLEDGERNAME>
            <NARRATION>${xmlEscape(inv.narration || '')}</NARRATION>${entries}
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

function buildPingXml() {
  return `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Export Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <EXPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>List of Companies</REPORTNAME>
      </REQUESTDESC>
    </EXPORTDATA>
  </BODY>
</ENVELOPE>`;
}

// ------------------------------ LOCAL: POST TO TALLY -------------------------

// Tally's XML gateway is an old-style server; the plain 'http' module talks
// to it more reliably than modern fetch() implementations.
function postToTally(host, port, xmlBody) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host,
        port,
        method: 'POST',
        path: '/',
        headers: {
          'Content-Type': 'text/xml',
          'Content-Length': Buffer.byteLength(xmlBody),
          Connection: 'close',
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('Request to Tally timed out after 15s')));
    req.on('error', (err) => reject(new Error(`${err.message} (${err.code || 'unknown'})`)));
    req.write(xmlBody);
    req.end();
  });
}

function parseTallyResponse(xmlText) {
  const created = /<CREATED>(\d+)<\/CREATED>/.exec(xmlText);
  const altered = /<ALTERED>(\d+)<\/ALTERED>/.exec(xmlText);
  const errors = /<ERRORS>(\d+)<\/ERRORS>/.exec(xmlText);
  const lineError = /<LINEERROR>(.*?)<\/LINEERROR>/.exec(xmlText);

  const errorCount = errors ? parseInt(errors[1], 10) : 0;
  const createdCount = created ? parseInt(created[1], 10) : 0;
  const alteredCount = altered ? parseInt(altered[1], 10) : 0;

  return {
    success: errorCount === 0 && (createdCount > 0 || alteredCount > 0),
    created: createdCount,
    altered: alteredCount,
    errorCount,
    lineError: lineError ? lineError[1] : null,
    raw: xmlText,
  };
}

// ------------------------------ CLOUD: HTTP CLIENT ----------------------------

// Small fetch-free HTTPS/HTTP JSON client, so this has zero npm dependencies
// at runtime (important once it's compiled into a single .exe).
function requestJson(urlStr, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;

    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
        timeout: 15000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            // leave parsed as null; caller can inspect raw status
          }
          resolve({ status: res.statusCode, json: parsed, raw: data });
        });
      }
    );

    req.on('timeout', () => req.destroy(new Error('Cloud request timed out after 15s')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ----------------------------------- MAIN LOOP --------------------------------

async function testConnection(config) {
  console.log(`Testing connection to TallyPrime at http://${config.tallyHost}:${config.tallyPort} ...`);
  try {
    const { status, body } = await postToTally(config.tallyHost, config.tallyPort, buildPingXml());
    if (status === 200 && body.includes('<COMPANY')) {
      console.log('✅ Connected. Tally responded with a company list.');
    } else if (status === 200) {
      console.log('✅ Tally responded (HTTP 200) but no <COMPANY> tag found. First 300 chars:');
      console.log(body.slice(0, 300));
    } else {
      console.log(`❌ Tally responded with HTTP ${status}. Is the XML server enabled on this port?`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('❌ Could not reach Tally:', err.message);
    console.error('   Check: TallyPrime is open, the company is loaded, and');
    console.error(`   F1 > Settings > Connectivity has the ODBC/HTTP server enabled on port ${config.tallyPort}.`);
    process.exitCode = 1;
  }
}

async function pollOnce(config) {
  const authHeaders = { Authorization: `Bearer ${config.apiKey}` };

  const fetchRes = await requestJson(`${config.cloudApiUrl}/api/sync/fetch`, {
    method: 'GET',
    headers: authHeaders,
  });

  if (fetchRes.status !== 200 || !fetchRes.json) {
    console.log(`⚠️  Cloud fetch failed (HTTP ${fetchRes.status}). Will retry next cycle.`);
    return;
  }

  if (!fetchRes.json.hasPendingJob) {
    console.log('No pending invoices.');
    return;
  }

  const { jobId, invoice } = fetchRes.json;
  console.log(`📦 Job ${jobId} found — ${invoice.voucherType} for "${invoice.partyLedgerName}". Building XML...`);

  let xml;
  try {
    xml = buildVoucherXml(invoice);
  } catch (err) {
    console.error(`❌ Could not build voucher XML: ${err.message}`);
    await requestJson(`${config.cloudApiUrl}/api/sync/acknowledge`, {
      method: 'POST',
      headers: authHeaders,
      body: { jobId, status: 'failed', detail: `XML build error: ${err.message}` },
    });
    return;
  }

  let tallyResult;
  try {
    const { status, body } = await postToTally(config.tallyHost, config.tallyPort, xml);
    if (status !== 200) {
      throw new Error(`Tally returned HTTP ${status}`);
    }
    tallyResult = parseTallyResponse(body);
  } catch (err) {
    console.error(`❌ Local Tally push failed: ${err.message}`);
    await requestJson(`${config.cloudApiUrl}/api/sync/acknowledge`, {
      method: 'POST',
      headers: authHeaders,
      body: { jobId, status: 'failed', detail: err.message },
    });
    return;
  }

  if (tallyResult.success) {
    console.log(`✅ Tally accepted the voucher (created: ${tallyResult.created}, altered: ${tallyResult.altered}).`);
    await requestJson(`${config.cloudApiUrl}/api/sync/acknowledge`, {
      method: 'POST',
      headers: authHeaders,
      body: { jobId, status: 'completed' },
    });
  } else {
    console.error(`❌ Tally rejected the voucher (errors: ${tallyResult.errorCount}). ${tallyResult.lineError || ''}`);
    await requestJson(`${config.cloudApiUrl}/api/sync/acknowledge`, {
      method: 'POST',
      headers: authHeaders,
      body: { jobId, status: 'failed', detail: tallyResult.lineError || 'Tally rejected the voucher' },
    });
  }
}

async function main() {
  const config = loadConfig();
  const args = process.argv.slice(2);

  if (args.includes('--test')) {
    await testConnection(config);
    return;
  }

  if (args.includes('--once')) {
    await pollOnce(config);
    return;
  }

  console.log('🚀 Tally Bridge Agent starting.');
  console.log(`   Cloud: ${config.cloudApiUrl}`);
  console.log(`   Tally: http://${config.tallyHost}:${config.tallyPort}`);
  console.log(`   Poll interval: ${config.pollIntervalSeconds}s`);
  console.log('   Press Ctrl+C to stop.\n');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await pollOnce(config);
    } catch (err) {
      console.error(`⚠️  Unexpected error this cycle: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, config.pollIntervalSeconds * 1000));
  }
}

main();