// db.js — everything lives in localStorage on the device. This is the
// source of truth; Google Sheets is just a mirror we push to when online.

const DB = (() => {
  const KEYS = {
    bag: "fl_bag",
    rounds: "fl_rounds",
    entries: "fl_entries",   // shot + green marker entries
    holes: "fl_holes",       // per-hole putts summary
    settings: "fl_settings",
    activeRound: "fl_active_round"
  };

  function read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      console.error("DB read failed", key, e);
      return fallback;
    }
  }
  function write(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  return {
    uid,

    // ---- Bag (custom club list) ----
    getBag() { return read(KEYS.bag, []); },
    setBag(list) { write(KEYS.bag, list); },

    // ---- Settings (Apps Script URL etc.) ----
    getSettings() { return read(KEYS.settings, { sheetsUrl: "" }); },
    setSettings(s) { write(KEYS.settings, s); },

    // ---- Rounds ----
    getRounds() { return read(KEYS.rounds, []); },
    saveRound(round) {
      const rounds = this.getRounds();
      const idx = rounds.findIndex(r => r.id === round.id);
      if (idx >= 0) rounds[idx] = round; else rounds.push(round);
      write(KEYS.rounds, rounds);
    },
    getRound(id) { return this.getRounds().find(r => r.id === id) || null; },

    getActiveRoundId() { return read(KEYS.activeRound, null); },
    setActiveRoundId(id) { write(KEYS.activeRound, id); },

    // ---- Entries (shots + green markers) ----
    getEntries() { return read(KEYS.entries, []); },
    addEntry(entry) {
      const entries = this.getEntries();
      entries.push(entry);
      write(KEYS.entries, entries);
      return entry;
    },
    updateEntry(id, patch) {
      const entries = this.getEntries();
      const idx = entries.findIndex(e => e.id === id);
      if (idx >= 0) { entries[idx] = { ...entries[idx], ...patch }; write(KEYS.entries, entries); }
    },
    deleteEntry(id) {
      write(KEYS.entries, this.getEntries().filter(e => e.id !== id));
    },
    entriesForRound(roundId) {
      return this.getEntries().filter(e => e.roundId === roundId).sort((a, b) => a.seq - b.seq);
    },
    entriesForHole(roundId, hole) {
      return this.entriesForRound(roundId).filter(e => e.hole === hole);
    },

    // ---- Hole summaries (putts) ----
    getHoles() { return read(KEYS.holes, []); },
    saveHoleSummary(summary) {
      const holes = this.getHoles();
      const idx = holes.findIndex(h => h.roundId === summary.roundId && h.hole === summary.hole);
      if (idx >= 0) holes[idx] = { ...holes[idx], ...summary }; else holes.push(summary);
      write(KEYS.holes, holes);
    },
    holesForRound(roundId) {
      return this.getHoles().filter(h => h.roundId === roundId).sort((a, b) => a.hole - b.hole);
    },
    getHoleSummary(roundId, hole) {
      return this.getHoles().find(h => h.roundId === roundId && h.hole === hole) || null;
    },

    // ---- Unsynced items across entries + holes ----
    unsyncedEntries() { return this.getEntries().filter(e => !e.synced); },
    unsyncedHoles() { return this.getHoles().filter(h => !h.synced); },
    unsyncedCount() { return this.unsyncedEntries().length + this.unsyncedHoles().length; },

    markEntriesSynced(ids) {
      const entries = this.getEntries();
      let changed = false;
      ids.forEach(id => {
        const e = entries.find(x => x.id === id);
        if (e) { e.synced = true; changed = true; }
      });
      if (changed) write(KEYS.entries, entries);
    },
    markHolesSynced(ids) {
      const holes = this.getHoles();
      let changed = false;
      ids.forEach(id => {
        const h = holes.find(x => x.id === id);
        if (h) { h.synced = true; changed = true; }
      });
      if (changed) write(KEYS.holes, holes);
    }
  };
})();
