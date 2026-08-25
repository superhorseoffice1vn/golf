// db.js — everything lives in localStorage on the device. This is the
// source of truth; Google Sheets is just a mirror we push to when online.
//
// Multi-player: bag / rounds / entries / holes / active-round are all scoped
// to whichever player is currently active on THIS device (fl_active_player).
// Settings (Sheets URL) and the player roster itself are shared/global —
// there's one destination Sheet for everyone. PIN checks are a soft local
// gate to stop shots getting logged under the wrong name, same spirit as the
// app password — not real security.

const DB = (() => {
  const DEFAULT_SHEETS_URL = "https://script.google.com/macros/s/AKfycbzDu5QNAKlVtM8BGY6pw97XzBQ6sjwvZyB3o9MVY8N3sKtFD9koD-4eC3h3mCWLw3Em-A/exec";
  const DEFAULT_BAG = [
    "Driver", "3 Wood", "5 Wood", "7 Wood", "3 Hybrid",
    "4 Iron", "5 Iron", "6 Iron", "7 Iron", "8 Iron", "9 Iron",
    "Pitching Wedge", "53 Wedge", "56 Wedge", "60 Wedge", "Putter"
  ];

  // Global (not per-player) keys
  const GKEYS = {
    settings: "fl_settings",
    players: "fl_players",
    activePlayer: "fl_active_player"
  };
  // Per-player key bases — actual key is base + "_" + playerId
  const PKEY_BASES = ["fl_bag", "fl_rounds", "fl_entries", "fl_holes", "fl_active_round"];

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

  // ---- One-time migration: if this device already had single-user data
  // from before player profiles existed, move it under an auto-created
  // "Me" profile so nothing is lost. Runs once, guarded by fl_players existing.
  function migrateLegacyIfNeeded() {
    const existingPlayers = read(GKEYS.players, null);
    if (existingPlayers !== null) return; // already set up

    const hadLegacyData = PKEY_BASES.some(base => localStorage.getItem(base) !== null);
    const newId = uid();
    const player = { id: newId, name: hadLegacyData ? "Me" : "Player 1", pin: "" };
    write(GKEYS.players, [player]);
    write(GKEYS.activePlayer, newId);

    if (hadLegacyData) {
      PKEY_BASES.forEach(base => {
        const val = localStorage.getItem(base);
        if (val !== null) {
          localStorage.setItem(base + "_" + newId, val);
          localStorage.removeItem(base);
        }
      });
    }
  }
  migrateLegacyIfNeeded();

  function pkey(base) {
    const pid = read(GKEYS.activePlayer, null);
    return base + "_" + (pid || "none");
  }

  return {
    uid,

    // ---- Players (local roster on this device) ----
    getPlayers() { return read(GKEYS.players, []); },
    addPlayer(name, pin) {
      const players = this.getPlayers();
      const player = { id: uid(), name: name.trim(), pin: (pin || "").trim() };
      players.push(player);
      write(GKEYS.players, players);
      return player;
    },
    removePlayer(id) {
      write(GKEYS.players, this.getPlayers().filter(p => p.id !== id));
    },
    getPlayer(id) { return this.getPlayers().find(p => p.id === id) || null; },
    getActivePlayerId() { return read(GKEYS.activePlayer, null); },
    getActivePlayer() {
      const id = this.getActivePlayerId();
      return id ? this.getPlayer(id) : null;
    },
    getActivePlayerName() {
      const p = this.getActivePlayer();
      return p ? p.name : "";
    },
    setActivePlayerId(id) { write(GKEYS.activePlayer, id); },

    // ---- Bag (custom club list) — per active player ----
    // First run for a player: seed with a standard set.
    getBag() {
      const key = pkey("fl_bag");
      const stored = read(key, null);
      if (stored === null) { write(key, DEFAULT_BAG); return DEFAULT_BAG.slice(); }
      return stored;
    },
    setBag(list) { write(pkey("fl_bag"), list); },
    getDefaultBag() { return DEFAULT_BAG.slice(); },

    // ---- Settings (Apps Script URL) — shared/global, one Sheet for everyone ----
    getSettings() {
      const stored = read(GKEYS.settings, null);
      if (stored === null) { const s = { sheetsUrl: DEFAULT_SHEETS_URL }; write(GKEYS.settings, s); return s; }
      return stored;
    },
    setSettings(s) { write(GKEYS.settings, s); },

    // ---- Rounds — per active player ----
    getRounds() { return read(pkey("fl_rounds"), []); },
    saveRound(round) {
      const rounds = this.getRounds();
      const idx = rounds.findIndex(r => r.id === round.id);
      if (idx >= 0) rounds[idx] = round; else rounds.push(round);
      write(pkey("fl_rounds"), rounds);
    },
    getRound(id) { return this.getRounds().find(r => r.id === id) || null; },

    getActiveRoundId() { return read(pkey("fl_active_round"), null); },
    setActiveRoundId(id) { write(pkey("fl_active_round"), id); },

    // ---- Entries (shots + green markers) — per active player ----
    getEntries() { return read(pkey("fl_entries"), []); },
    addEntry(entry) {
      const entries = this.getEntries();
      entries.push(entry);
      write(pkey("fl_entries"), entries);
      return entry;
    },
    updateEntry(id, patch) {
      const entries = this.getEntries();
      const idx = entries.findIndex(e => e.id === id);
      if (idx >= 0) { entries[idx] = { ...entries[idx], ...patch }; write(pkey("fl_entries"), entries); }
    },
    deleteEntry(id) {
      write(pkey("fl_entries"), this.getEntries().filter(e => e.id !== id));
    },
    entriesForRound(roundId) {
      return this.getEntries().filter(e => e.roundId === roundId).sort((a, b) => a.seq - b.seq);
    },
    entriesForHole(roundId, hole) {
      return this.entriesForRound(roundId).filter(e => e.hole === hole);
    },

    // ---- Hole summaries (putts) — per active player ----
    getHoles() { return read(pkey("fl_holes"), []); },
    saveHoleSummary(summary) {
      const holes = this.getHoles();
      const idx = holes.findIndex(h => h.roundId === summary.roundId && h.hole === summary.hole);
      if (idx >= 0) holes[idx] = { ...holes[idx], ...summary }; else holes.push(summary);
      write(pkey("fl_holes"), holes);
    },
    holesForRound(roundId) {
      return this.getHoles().filter(h => h.roundId === roundId).sort((a, b) => a.hole - b.hole);
    },
    getHoleSummary(roundId, hole) {
      return this.getHoles().find(h => h.roundId === roundId && h.hole === hole) || null;
    },

    // ---- Unsynced items across entries + holes — per active player ----
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
      if (changed) write(pkey("fl_entries"), entries);
    },
    markHolesSynced(ids) {
      const holes = this.getHoles();
      let changed = false;
      ids.forEach(id => {
        const h = holes.find(x => x.id === id);
        if (h) { h.synced = true; changed = true; }
      });
      if (changed) write(pkey("fl_holes"), holes);
    }
  };
})();
