/**
 * Fairway Log / App_GolfScore — Google Sheets receiver + reader.
 *
 * SETUP:
 * 1. Open (or create) the Google Sheet you want shots logged to.
 * 2. Extensions > Apps Script.
 * 3. Delete any starter code, paste this whole file in.
 * 4. Click Deploy > New deployment > select type "Web app".
 *      - Execute as: Me
 *      - Who has access: Anyone
 * 5. Click Deploy, authorize when prompted, then copy the "Web app URL".
 * 6. Paste that URL into the app's Settings screen ("Apps Script Web App URL").
 *
 * If you're UPDATING an existing deployment, editing this code isn't enough —
 * go to Deploy > Manage deployments > pencil icon > New version > Deploy.
 * The URL stays the same.
 *
 * This creates a sheet tab called "GolfLog" automatically if it doesn't exist,
 * with one row per shot / green marker / putts entry. doPost() writes new rows;
 * doGet() returns all rows as JSON for the dashboard to read.
 */

const SHEET_NAME = "GolfLog";
// "Round ID" is appended at the END on purpose — if you already had data logged
// under an older version of this script (10 columns, no Round ID), appending a
// new column at the end keeps every existing column position unchanged.
const HEADERS = ["Timestamp", "Course", "Hole", "Type", "Club", "Lat", "Lon", "Accuracy (m)", "Putts", "Entry ID", "Round ID", "Player", "Strokes", "Par"];
const ENTRY_ID_COL = HEADERS.indexOf("Entry ID") + 1; // 1-based

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    return sheet;
  }
  // Self-heal: an older deployment may have created fewer columns. Extend the
  // header row so new columns (like Round ID) line up correctly; this never
  // touches existing data rows or column order.
  if (sheet.getLastColumn() < HEADERS.length) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const rows = body.rows || [];
    const sheet = getSheet_();

    // Map existing Entry ID -> sheet row number, so a re-synced correction
    // updates that row in place instead of being silently skipped. Guard the
    // 0-row case — a brand-new sheet with only headers would otherwise throw,
    // since Apps Script requires numRows >= 1 on getRange.
    const lastRow = sheet.getLastRow();
    const idToRow = {};
    if (lastRow > 1) {
      const ids = sheet.getRange(2, ENTRY_ID_COL, lastRow - 1, 1).getValues();
      ids.forEach((row, i) => { if (row[0]) idToRow[row[0]] = i + 2; }); // +2: 1-based rows + header row
    }

    const toAppend = [];
    let updated = 0;
    rows.forEach(r => {
      const rowValues = [
        r.timestamp ? new Date(r.timestamp) : new Date(),
        r.course || "",
        r.hole != null ? r.hole : "",
        r.type || "",
        r.club || "",
        r.lat != null ? r.lat : "",
        r.lon != null ? r.lon : "",
        r.accuracy_m != null ? r.accuracy_m : "",
        r.putts != null ? r.putts : "",
        r.id || "",
        r.roundId || "",
        r.player || "",
        r.strokes != null && r.strokes !== "" ? r.strokes : "",
        r.par != null && r.par !== "" ? r.par : ""
      ];
      if (idToRow[r.id]) {
        sheet.getRange(idToRow[r.id], 1, 1, HEADERS.length).setValues([rowValues]);
        updated++;
      } else {
        toAppend.push(rowValues);
      }
    });

    if (toAppend.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, toAppend.length, HEADERS.length).setValues(toAppend);
    }

    return jsonOut_({ status: "ok", written: toAppend.length, updated: updated });
  } catch (err) {
    return jsonOut_({ status: "error", message: err.message });
  }
}

/**
 * Returns every logged row as JSON, keyed by header name — this is what the
 * dashboard fetches. GET https://.../exec (no params needed).
 */
function doGet(e) {
  try {
    const sheet = getSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return jsonOut_({ status: "ok", rows: [] });

    const values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
    const rows = values.map(r => {
      const obj = {};
      HEADERS.forEach((h, i) => {
        obj[h] = r[i] instanceof Date ? r[i].toISOString() : r[i];
      });
      return obj;
    });
    return jsonOut_({ status: "ok", rows: rows });
  } catch (err) {
    return jsonOut_({ status: "error", message: err.message });
  }
}
