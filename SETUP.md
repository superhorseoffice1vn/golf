# Fairway Log — Setup Guide

Two parts: (1) connect Google Sheets, (2) put the app on your phone. Takes about 10 minutes total.

## Part 1 — Google Sheets receiver

1. Create a new Google Sheet (or open the one you want data in).
2. Menu: **Extensions > Apps Script**.
3. Delete the placeholder code, paste in the full contents of `apps-script.gs` (included in this folder).
4. Click **Deploy > New deployment**.
5. Click the gear icon next to "Select type" and choose **Web app**.
6. Set:
   - Execute as: **Me**
   - Who has access: **Anyone**
7. Click **Deploy**. Google will ask you to authorize — approve it (it's your own script, on your own sheet).
8. Copy the **Web app URL** it gives you (looks like `https://script.google.com/macros/s/AKfycb.../exec`). You'll paste this into the app in Part 2.
9. You'll see a new tab called **GolfLog** appear in your sheet the first time you log a shot — no need to create it yourself.

If you ever edit the script later, you must **Deploy > Manage deployments > edit (pencil) > New version** for changes to take effect — just saving the script isn't enough.

## Part 2 — Host and install the app

The app needs to live at a real URL (not just files on your phone) for GPS/install prompts to work reliably. Free and easiest: **GitHub Pages**.

1. Create a free GitHub account if you don't have one: github.com
2. Create a new repository (e.g. `fairway-log`), public.
3. Upload every file in this folder **keeping the same folder structure** (`index.html`, `manifest.json`, `sw.js`, and the `css/`, `js/`, `icons/` folders) — you can drag-and-drop them on the repo's "Add file > Upload files" page. Do **not** upload `apps-script.gs` or `SETUP.md`, those aren't part of the app.
4. In the repo: **Settings > Pages**. Under "Branch", pick `main` and folder `/ (root)`, then Save.
5. GitHub gives you a URL like `https://yourname.github.io/fairway-log/` — wait a minute or two for it to go live.

## Part 3 — Install on your phone

1. Open the GitHub Pages URL from Part 2 in **Safari** (iPhone) or **Chrome** (Android).
2. iPhone: tap the Share icon > **Add to Home Screen**.
   Android: tap the ⋮ menu > **Install app** (or **Add to Home screen**).
3. Open the app from your home screen icon — it now runs full-screen, like a normal app.
4. Go to **Settings** tab in the app, paste the Apps Script Web App URL from Part 1, tap **Save**.
5. Still in Settings, add your clubs to **Your bag** (Driver, 3 Wood, 5 Iron, etc — whatever you carry).
6. Grant location permission when prompted the first time you log a shot.

You're set. Start a round from the **Round** tab.

## How data flows

- Everything is saved to your phone first (works with zero signal).
- Whenever you have a connection, it pushes anything unsynced to your Sheet automatically (checks roughly every 15 seconds, plus instantly whenever you come back online).
- The sync status pill top-right shows **Synced**, **N pending**, or **Offline**.
- You can also force a push from Settings > **Sync now**.
- Nothing is ever deleted locally after syncing — your phone keeps the full history too.

## Updating an existing deployment

If you already deployed the Apps Script and are updating the code (e.g. a bug fix), pasting new
code into the editor and saving is **not enough** — the live URL keeps serving the old version
until you publish a new one:

1. In the Apps Script editor: **Deploy > Manage deployments**.
2. Click the pencil (edit) icon on your existing deployment.
3. Under "Version", choose **New version**.
4. Click **Deploy**.

The Web app URL stays the same — you don't need to update it in the app.

## Notes / limitations

- Distance-per-club is calculated as the GPS distance from where you hit a shot to where you hit (or marked) the next one — so tag **On green** when your approach lands, or the last full-swing shot into each green won't get a distance.
- GPS accuracy on phones is typically 3–15m outdoors — fine for club-distance averages, not survey-grade.
- If you ever want to reset all data, that's a browser-storage clear on the app's site — ask me and I'll add a one-tap "export & reset" if useful.
