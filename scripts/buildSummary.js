// scripts/buildSummary.js

require('dotenv').config();
const { google } = require('googleapis');
const path = require('path');

async function buildSummary() {
  // 1. Authenticate
  const auth = new google.auth.GoogleAuth({
    keyFile: path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.SHEET_ID;

  // 2. Fetch all raw data rows
  const raw = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: 'RawData!A:C'
  });
  const rows = raw.data.values || [];

  // 3. Build dataMap { dateRange: { buyer: total } }
  const dataMap = {};
  let currentRange = null;
  for (const row of rows) {
    if (row.length === 1 && row[0]) {
      currentRange = row[0];
      dataMap[currentRange] = {};
    } else if (row.length >= 2 && currentRange) {
      const [buyer, qty] = row;
      if (buyer !== 'Buyer') {
        dataMap[currentRange][buyer] = parseInt(qty, 10) || 0;
      }
    }
  }

  // 4. Filter out any dateRanges with all-zero totals
  const dateRanges = Object.entries(dataMap)
    .filter(([, buyers]) => Object.values(buyers).some(v => v > 0))
    .map(([dr]) => dr);

  // 5. Collect unique buyers across only those valid dateRanges
  const buyers = Array.from(
    new Set(dateRanges.flatMap(dr => Object.keys(dataMap[dr])))
  );

  // 6. Build the summary table
  const header = ['Buyer', ...dateRanges];
  const table = [header];
  for (const buyer of buyers) {
    const row = [buyer];
    for (const dr of dateRanges) {
      row.push(dataMap[dr][buyer] || 0);
    }
    table.push(row);
  }

  // 7. Write to the Summary tab
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Summary!A1',
    valueInputOption: 'RAW',
    requestBody: { values: table }
  });

  console.log('✅ Summary tab updated with', dateRanges.length, 'columns.');
}

buildSummary().catch(err => {
  console.error('❌ Failed to build summary:', err);
  process.exit(1);
});
