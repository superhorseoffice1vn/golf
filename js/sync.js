// sync.js — local data (DB) is always the source of truth. This module's
// only job is to push whatever is unsynced to the Apps Script endpoint
// whenever we plausibly have a connection, and mark it synced on success.
// Nothing here ever deletes or blocks on network — logging always works offline.

const Sync = (() => {
  let inFlight = false;
  let timer = null;
  const listeners = [];

  function onStatusChange(fn) { listeners.push(fn); }
  function emit(status) { listeners.forEach(fn => fn(status)); }

  function currentStatus() {
    if (!navigator.onLine) return "offline";
    return DB.unsyncedCount() > 0 ? "pending" : "synced";
  }

  function courseFor(roundId) {
    const r = DB.getRound(roundId);
    return r ? r.course : "";
  }

  async function attempt() {
    const settings = DB.getSettings();
    if (!settings.sheetsUrl) { emit(currentStatus()); return; }
    if (!navigator.onLine) { emit("offline"); return; }
    if (inFlight) return;

    const entries = DB.unsyncedEntries();
    const holes = DB.unsyncedHoles();
    if (entries.length === 0 && holes.length === 0) { emit("synced"); return; }

    inFlight = true;
    emit("pending");

    const rows = [];
    entries.forEach(e => {
      rows.push({
        kind: "entry",
        id: e.id,
        timestamp: e.timestamp,
        course: courseFor(e.roundId),
        hole: e.hole,
        type: e.type,           // "Shot" or "Green"
        club: e.club || "",
        lat: e.lat,
        lon: e.lon,
        accuracy_m: e.accuracy
      });
    });
    holes.forEach(h => {
      rows.push({
        kind: "hole",
        id: h.id,
        timestamp: h.timestamp,
        course: courseFor(h.roundId),
        hole: h.hole,
        type: "Putts",
        putts: h.putts
      });
    });

    try {
      const res = await fetch(settings.sheetsUrl, {
        method: "POST",
        // text/plain avoids a CORS preflight; Apps Script reads the raw body itself.
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({ rows })
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (data.status !== "ok") throw new Error(data.message || "sync rejected");

      DB.markEntriesSynced(entries.map(e => e.id));
      DB.markHolesSynced(holes.map(h => h.id));
      emit(currentStatus());
    } catch (err) {
      console.warn("Sync failed, will retry:", err.message);
      emit(navigator.onLine ? "pending" : "offline");
    } finally {
      inFlight = false;
    }
  }

  function start() {
    window.addEventListener("online", attempt);
    window.addEventListener("offline", () => emit("offline"));
    // Gentle background retry — safe even with no signal, just a no-op then.
    timer = setInterval(attempt, 15000);
    attempt();
  }

  return { start, attempt, onStatusChange, currentStatus };
})();
