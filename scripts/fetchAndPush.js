// scripts/fetchAndPush.js

require('dotenv').config();
console.log('→ DISTRIBUTE_USER:', process.env.DISTRIBUTE_USER);
console.log('→ DISTRIBUTE_PASS:', process.env.DISTRIBUTE_PASS);
console.log('→ KEY FILE:', process.env.GOOGLE_APPLICATION_CREDENTIALS);

const { chromium } = require('playwright');
const { parse } = require('csv-parse/sync');
const { google } = require('googleapis');   // ← only one google import
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

  // 3. Inject date range
  const fromText = fmt(start), toText = fmt(end);
  await page.evaluate(({ from, to }) => {
    const el = document.querySelector('.reportrange-text');
    if (el) el.innerText = `Report dates: ${from} - ${to}`;
  }, { from: fromText, to: toText });

  // 4. Enqueue CSV
  await page.getByRole('tabpanel').getByRole('button', { name: 'Download' }).click();
  await page.waitForTimeout(2000);

  // 5. Download from History
  const [ download ] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('row').filter({ hasText: '.csv' }).first().getByRole('button').click()
  ]);

  // 6. Read CSV text
  const buffer = await download.createReadStream().then(stream => {
    const chunks = [];
    return new Promise((resolve, reject) => {
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
  const csvText = buffer.toString('utf8');

  // 7. Debug dump
  const debugDir = path.resolve(__dirname, '..', 'debug');
  if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir);
  fs.writeFileSync(path.join(debugDir, `${rangeKey}.raw.csv`), csvText, 'utf8');
  console.log(`→ [debug] Wrote raw CSV to debug/${rangeKey}.raw.csv`);

  await browser.close();
  return csvText;
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
  console.log('→ Raw data appended.');
}

function aggregateByBuyer(csvText) {
  const lines = csvText.split('\n');
  const idx = lines.findIndex(l => l.startsWith('"Request Date and Time"'));
  const dataCsv = lines.slice(idx).join('\n');
  const records = parse(dataCsv, { columns: true, skip_empty_lines: true });

  const totals = {};
  for (const row of records) {
    const buyer = row['User Name'];
    const qty   = parseInt(row['Order QTY'], 10) || 0;
    totals[buyer] = (totals[buyer] || 0) + qty;
  }
  return Object.entries(totals).map(([buyer, total]) => ({ buyer, total }));
}

(async () => {
  const rangeKey = process.argv[2] || 'Today';
  console.log(`🚀 Running for range: ${rangeKey}`);

  try {
    const csvText = await downloadReportCsv(rangeKey);
    const summary = aggregateByBuyer(csvText);
    await pushRawData(summary, rangeKey);
    console.log('🎉 Done.');
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
})();
