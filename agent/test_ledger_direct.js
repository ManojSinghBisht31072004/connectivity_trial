#!/usr/bin/env node
/**
 * test-ledger-direct.js
 * ---------------------------------------------------------------------------
 * Standalone test: sends ONE ledger-create request straight to TallyPrime's
 * local HTTP-XML gateway, with no cloud server, no queue, no agent polling
 * involved. This isolates whether Tally itself will accept the XML.
 *
 * USAGE
 * -----
 *   node test-ledger-direct.js
 *
 * Edit the CONFIG block below to match your setup before running.
 * ---------------------------------------------------------------------------
 */

const http = require('http');

// ------------------------------- CONFIG -------------------------------
const TALLY_HOST = '127.0.0.1';
const TALLY_PORT = 9000;

// This MUST exactly match the company name as loaded in Tally right now.
const COMPANY_NAME = 'Bhrama Enterprises';

const LEDGER_NAME = 'Demo Customer From SaaS';
const PARENT_GROUP = 'Sundry Debtors'; // must already exist in Tally
// ------------------------------------------------------------------------

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildLedgerXml(companyName, ledgerName, parent) {
  return `<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${xmlEscape(companyName)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="${xmlEscape(ledgerName)}" ACTION="Create">
            <NAME>${xmlEscape(ledgerName)}</NAME>
            <PARENT>${xmlEscape(parent)}</PARENT>
          </LEDGER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`;
}

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

async function main() {
  const xml = buildLedgerXml(COMPANY_NAME, LEDGER_NAME, PARENT_GROUP);

  console.log('--- XML being sent to Tally ---');
  console.log(xml);
  console.log('--------------------------------\n');

  try {
    const { status, body } = await postToTally(TALLY_HOST, TALLY_PORT, xml);
    console.log(`HTTP status: ${status}`);
    console.log('--- Raw response from Tally ---');
    console.log(body);
    console.log('--------------------------------');

    if (body.includes('<LINEERROR>')) {
      console.log('\n❌ Tally rejected the request. Read <LINEERROR> above for the reason.');
      console.log('   Common causes: company name mismatch, or PARENT_GROUP does not exist.');
    } else if (/<CREATED>\s*1\s*<\/CREATED>/.test(body) || /<ALTERED>\s*1\s*<\/ALTERED>/.test(body)) {
      console.log('\n✅ Success! Ledger was created (or already existed and was left alone).');
      console.log('   Check Tally: Gateway of Tally > Chart of Accounts > Ledgers.');
    } else {
      console.log('\n⚠️  No clear success/error markers found. Inspect the raw response above.');
    }
  } catch (err) {
    console.error('❌ Could not reach Tally:', err.message);
    console.error('   Check: TallyPrime is open, the company is loaded, and the');
    console.error(`   HTTP-XML server is enabled on port ${TALLY_PORT}.`);
  }
}

main();