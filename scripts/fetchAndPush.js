// scripts/fetchAndPush.js

require('dotenv').config();
const { chromium } = require('playwright');
const { parse } = require('csv-parse/sync');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const VALID_KEYS = ['Today','Yesterday','This month','This year','Last month'];

function computeRange(rangeKey) {
  const today = new Date();
  let start, end;
  switch (rangeKey) {
    case 'Today':
      start = end = today;
      break;
    case 'Yesterday':
      start = end = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
      break;
    case 'This month':
      start = new Date(today.getFullYear(), today.getMonth(), 1);
      end = today;
      break;
    case 'Last month':
      start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      end = new Date(today.getFullYear(), today.getMonth(), 0);
      break;
    case 'This year':
      start = new Date(today.getFullYear(), 0, 1);
      end = today;
      break;
    default:
      start = end = today;
  }
  return [start, end];
}

function fmt(d) {
  return d.toISOString().slice(0,10).replace(/-/g,'/');
}

async function downloadReportCsv(rangeKey) {
  if (!VALID_KEYS.includes(rangeKey)) throw new Error('Invalid range');
  const [start, end] = computeRange(rangeKey);
  
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // 1. Log in
  await page.goto('https://distribteportal.com/auth/login');
  await page.getByRole('textbox', { name: 'Email' }).fill(process.env.DISTRIBUTE_USER);
  await page.getByRole('textbox', { name: 'Password' }).fill(process.env.DISTRIBUTE_PASS);
  await Promise.all([
    page.getByRole('button', { name: 'Sign in' }).click(),
    page.waitForSelector('a:has-text("Reports")', { timeout: 30000 })
  ]);

  // 2. Navigate to Reports → Custom Report
  await page.getByRole('link', { name: 'Reports' }).click();
  await page.getByRole('tab', { name: 'Custom Report' }).first().click();

  // 3. Inject date range text
  const fromText = fmt(start);
  const toText = fmt(end);
  await page.evaluate(({ from, to }) => {
    const el = document.querySelector('.reportrange-text');
    if (el) el.innerText = `Report dates: ${from} - ${to}`;
  }, { from: fromText, to: toText });

  // 4. Click Download to enqueue
  await page.getByRole('tabpanel').getByRole('button', { name: 'Download' }).click();
  await page.waitForTimeout(2000);

  // 5. Download the CSV from history
  const [ download ] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('row').filter({ hasText: '.csv' }).first().getByRole('button').click()
  ]);

  const buffer = await download.createReadStream().then(stream => {
    const chunks = [];
    return new Promise((resolve, reject) => {
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
  await browser.close();
  return buffer.toString('utf8');
}

async function pushRawData(data, rangeKey) {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const rows = [
    [`${rangeKey} (${new Date().toLocaleDateString()})`],
    ['Buyer','Tickets Purchased'],
    ...data.map(r => [r.buyer, r.total]),
    []
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: 'RawData!A:C',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows }
  });
}

function aggregateByBuyer(csvText) {
  const lines = csvText.split('\n');
  const idx = lines.findIndex(l => l.startsWith('"Request Date and Time"'));
  const dataCsv = lines.slice(idx).join('\n');
  const records = parse(dataCsv, { columns: true, skip_empty_lines: true });

  const totals = {};
  for (const row of records) {
    const buyer = row['User Name'];
    const qty = parseInt(row['Order QTY'], 10) || 0;
    totals[buyer] = (totals[buyer] || 0) + qty;
  }
  return Object.entries(totals).map(([b,t]) => ({ buyer: b, total: t }));
}

(async () => {
  const rangeKey = process.argv[2] || 'Today';
  console.log(`🚀 Running for range: ${rangeKey}`);

  try {
    const csvText = await downloadReportCsv(rangeKey);
    const summary = aggregateByBuyer(csvText);
    await pushRawData(summary, rangeKey);
    console.log('✅ Raw data appended.');
  } catch (e) {
    console.error('❌', e);
    process.exit(1);
  }
})();


// scripts/buildSummary.js

// This file goes in the same "scripts/" folder alongside fetchAndPush.js

require('dotenv').config();
const { google } = require('googleapis');
const path = require('path');

async function buildSummary() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.SHEET_ID;

  // 1. Fetch RawData
  const raw = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'RawData!A2:C'
  });
  const rows = raw.data.values || [];

  // 2. Parse into structure { dateRange: { buyer: total, ... }, ... }
  const dataMap = {};
  let currentRange = null;
  for (const row of rows) {
    if (row.length === 1 && row[0]) {
      currentRange = row[0];
      dataMap[currentRange] = {};
    } else if (row.length === 2 && currentRange) {
      const [buyer, qty] = row;
      if (buyer !== 'Buyer') {
        dataMap[currentRange][buyer] = parseInt(qty,10) || 0;
      }
    }
  }

  // 3. Get unique buyers and dateRanges
  const dateRanges = Object.keys(dataMap);
  const buyers = Array.from(
    new Set([].concat(...dateRanges.map(dr => Object.keys(dataMap[dr]))))
  );

  // 4. Build summary array: header + rows
  const header = ['Buyer', ...dateRanges];
  const table = [header];
  for (const buyer of buyers) {
    const row = [buyer];
    for (const dr of dateRanges) {
      row.push(dataMap[dr][buyer] || 0);
    }
    table.push(row);
  }

  // 5. Write to Summary tab
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Summary!A1',
    valueInputOption: 'RAW',
    requestBody: { values: table }
  });

  console.log('✅ Summary tab updated.');
}

buildSummary().catch(e => {
  console.error('❌', e);
  process.exit(1);
});
