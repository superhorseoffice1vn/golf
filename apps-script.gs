/**
 * Fairway Log — Google Sheets receiver.
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
 * This creates a sheet tab called "GolfLog" automatically if it doesn't exist,
 * with one row per shot / green marker / putts entry.
 */

const SHEET_NAME = "GolfLog";
const HEADERS = ["Timestamp", "Course", "Hole", "Type", "Club", "Lat", "Lon", "Accuracy (m)", "Putts", "Entry ID"];

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const rows = body.rows || [];
    const sheet = getSheet_();

    // Skip any Entry ID already present, so a retried sync never double-writes.
    const existingIds = new Set(
      sheet.getRange(2, 10, Math.max(sheet.getLastRow() - 1, 0), 1).getValues().flat().filter(String)
    );

    const toWrite = [];
    rows.forEach(r => {
      if (existingIds.has(r.id)) return;
      toWrite.push([
        r.timestamp ? new Date(r.timestamp) : new Date(),
        r.course || "",
        r.hole != null ? r.hole : "",
        r.type || "",
        r.club || "",
        r.lat != null ? r.lat : "",
        r.lon != null ? r.lon : "",
        r.accuracy_m != null ? r.accuracy_m : "",
        r.putts != null ? r.putts : "",
        r.id || ""
      ]);
    });

    if (toWrite.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, toWrite.length, HEADERS.length).setValues(toWrite);
    }

    return ContentService.createTextOutput(JSON.stringify({ status: "ok", written: toWrite.length }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ status: "ok", message: "Fairway Log receiver is live." }))
    .setMimeType(ContentService.MimeType.JSON);
}
