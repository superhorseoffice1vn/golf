// app.js — screens, GPS capture flow, and rendering. DB is the source of
// truth; this file just reflects it into the UI and reacts to taps.

(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  let pendingShot = null; // {lat, lon, accuracy, timestamp} awaiting club choice

  // ---------------- Screen nav ----------------
  function showScreen(name) {
    $$(".screen").forEach(s => s.classList.remove("active"));
    const el = $("#screen-" + name);
    if (el) el.classList.add("active");
    $$(".bottom-nav button").forEach(b => b.classList.toggle("active", b.dataset.screen === name));
    if (name === "stats") renderStats();
    if (name === "settings") renderSettings();
    if (name === "home") renderHome();
    if (name === "round") renderRound();
  }

  $$(".bottom-nav button").forEach(btn => {
    btn.addEventListener("click", () => showScreen(btn.dataset.screen));
  });

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._h);
    toast._h = setTimeout(() => t.classList.remove("show"), 2200);
  }

  // ---------------- Geolocation ----------------
  function captureLocation({ onAcquiring } = {}) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error("No GPS on this device/browser")); return; }
      if (onAcquiring) onAcquiring();
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy),
          timestamp: Date.now()
        }),
        (err) => reject(err),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    });
  }

  // ---------------- Home ----------------
  function renderHome() {
    const activeId = DB.getActiveRoundId();
    const round = activeId ? DB.getRound(activeId) : null;
    const block = $("#continueBlock");
    if (round && !round.ended) {
      block.style.display = "";
      $("#continueCourse").textContent = round.course + " — hole " + round.currentHole;
    } else {
      block.style.display = "none";
    }
    $("#courseInput").value = "";
  }

  $("#btnContinueRound").addEventListener("click", () => showScreen("round"));

  $("#btnStartRound").addEventListener("click", () => {
    const course = $("#courseInput").value.trim();
    if (!course) { toast("Enter a course name"); return; }
    if (DB.getBag().length === 0) { toast("Add clubs in Settings first"); showScreen("settings"); return; }
    const round = {
      id: DB.uid(),
      course,
      date: new Date().toISOString(),
      currentHole: 1,
      ended: false
    };
    DB.saveRound(round);
    DB.setActiveRoundId(round.id);
    showScreen("round");
  });

  // ---------------- Round screen ----------------
  function activeRound() {
    const id = DB.getActiveRoundId();
    return id ? DB.getRound(id) : null;
  }

  function renderRound() {
    const round = activeRound();
    if (!round) { showScreen("home"); return; }

    $("#roundCourseChip").textContent = round.course + " · " + new Date(round.date).toLocaleDateString();
    $("#holeNum").textContent = round.currentHole;

    const entries = DB.entriesForHole(round.id, round.currentHole);
    const log = $("#shotLog");
    log.innerHTML = "";
    entries.forEach((e, i) => {
      const row = document.createElement("div");
      row.className = "shot-row" + (e.type === "Green" ? " green" : "");
      const time = new Date(e.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      row.innerHTML = `<span class="club-tag">${e.type === "Green" ? "📍 On green" : (i + 1) + ". " + e.club}</span><span class="meta">${time} · ±${e.accuracy}m</span>`;
      log.appendChild(row);
    });

    const hasGreen = entries.some(e => e.type === "Green");
    const greenBtn = $("#btnOnGreen");
    greenBtn.textContent = hasGreen ? "Green marked ✓ (tap to re-mark)" : "On green — mark spot";

    const puttsBlock = $("#puttsBlock");
    if (hasGreen) {
      puttsBlock.style.display = "";
      const existing = DB.getHoleSummary(round.id, round.currentHole);
      $("#puttsCount").textContent = existing ? existing.putts : 0;
    } else {
      puttsBlock.style.display = "none";
    }

    $("#captureHint").textContent = "Tap for GPS + club";
  }

  $("#holeMinus").addEventListener("click", () => {
    const round = activeRound(); if (!round) return;
    round.currentHole = Math.max(1, round.currentHole - 1);
    DB.saveRound(round); renderRound();
  });
  $("#holePlus").addEventListener("click", () => {
    const round = activeRound(); if (!round) return;
    round.currentHole = Math.min(18, round.currentHole + 1);
    DB.saveRound(round); renderRound();
  });

  $("#btnLogShot").addEventListener("click", async () => {
    const round = activeRound(); if (!round) return;
    if (DB.getBag().length === 0) { toast("Add clubs in Settings first"); showScreen("settings"); return; }
    const btn = $("#btnLogShot");
    btn.classList.add("acquiring");
    $("#captureHint").textContent = "Locking GPS…";
    try {
      const loc = await captureLocation();
      pendingShot = loc;
      btn.classList.remove("acquiring");
      openClubPicker();
    } catch (err) {
      btn.classList.remove("acquiring");
      $("#captureHint").textContent = "Tap for GPS + club";
      toast("GPS failed: " + (err.message || "check location permission"));
    }
  });

  $("#btnOnGreen").addEventListener("click", async () => {
    const round = activeRound(); if (!round) return;
    const btn = $("#btnOnGreen");
    const original = btn.textContent;
    btn.textContent = "Locking GPS…";
    try {
      const loc = await captureLocation();
      const entry = {
        id: DB.uid(), roundId: round.id, hole: round.currentHole, seq: Date.now(),
        type: "Green", club: null, lat: loc.lat, lon: loc.lon, accuracy: loc.accuracy,
        timestamp: loc.timestamp, synced: false
      };
      DB.addEntry(entry);
      Sync.attempt();
      renderRound();
    } catch (err) {
      toast("GPS failed: " + (err.message || "check location permission"));
      btn.textContent = original;
    }
  });

  // Putts stepper
  function getPutts() { return parseInt($("#puttsCount").textContent, 10) || 0; }
  $("#puttsMinus").addEventListener("click", () => { $("#puttsCount").textContent = Math.max(0, getPutts() - 1); });
  $("#puttsPlus").addEventListener("click", () => { $("#puttsCount").textContent = Math.min(20, getPutts() + 1); });

  $("#btnFinishHole").addEventListener("click", () => {
    const round = activeRound(); if (!round) return;
    const putts = getPutts();
    const existing = DB.getHoleSummary(round.id, round.currentHole);
    DB.saveHoleSummary({
      id: existing ? existing.id : DB.uid(),
      roundId: round.id, hole: round.currentHole, putts,
      timestamp: Date.now(), synced: false
    });
    Sync.attempt();
    if (round.currentHole >= 18) {
      toast("Hole 18 logged — tap End Round when ready");
    } else {
      round.currentHole += 1;
      DB.saveRound(round);
    }
    renderRound();
  });

  $("#btnEndRound").addEventListener("click", () => {
    const round = activeRound(); if (!round) return;
    if (!confirm("End this round? You can still view it in Stats.")) return;
    round.ended = true;
    DB.saveRound(round);
    DB.setActiveRoundId(null);
    showScreen("home");
  });

  // ---------------- Club picker ----------------
  function openClubPicker() {
    const grid = $("#clubGrid");
    grid.innerHTML = "";
    DB.getBag().forEach(club => {
      const b = document.createElement("button");
      b.textContent = club;
      b.addEventListener("click", () => chooseClub(club));
      grid.appendChild(b);
    });
    showScreen("club");
    // showScreen doesn't know "club" for nav highlighting — fine, it's a sub-screen.
    $$(".screen").forEach(s => s.classList.remove("active"));
    $("#screen-club").classList.add("active");
  }

  function chooseClub(club) {
    const round = activeRound();
    if (!round || !pendingShot) { showScreen("round"); return; }
    const entry = {
      id: DB.uid(), roundId: round.id, hole: round.currentHole, seq: Date.now(),
      type: "Shot", club, lat: pendingShot.lat, lon: pendingShot.lon,
      accuracy: pendingShot.accuracy, timestamp: pendingShot.timestamp, synced: false
    };
    DB.addEntry(entry);
    Sync.attempt();
    pendingShot = null;
    showScreen("round");
  }

  $("#btnCancelClub").addEventListener("click", () => {
    pendingShot = null;
    showScreen("round");
  });

  // ---------------- Stats ----------------
  function renderStats() {
    const summary = Stats.allTimeSummary();
    $("#kpiRounds").textContent = summary.rounds;
    $("#kpiStrokes").textContent = summary.totalStrokes;
    $("#kpiPutts").textContent = summary.totalPutts;
    $("#kpiPuttsHole").textContent = summary.puttsPerHole.toFixed(1);

    const dist = Stats.clubDistances();
    const list = $("#clubStatsList");
    const clubs = Object.keys(dist).sort((a, b) => dist[b].avg - dist[a].avg);
    if (clubs.length === 0) {
      list.innerHTML = '<div class="empty">Log a few shots to see distances here.</div>';
    } else {
      list.innerHTML = clubs.map(c => {
        const d = dist[c];
        return `<div class="club-stat-row">
          <span class="name">${c}</span>
          <span><span class="avg">${Math.round(d.avg)}y</span><span class="range">${Math.round(d.min)}–${Math.round(d.max)} · n=${d.count}</span></span>
        </div>`;
      }).join("");
    }

    const rounds = DB.getRounds().slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    const roundsList = $("#roundsList");
    if (rounds.length === 0) {
      roundsList.innerHTML = '<div class="empty">No rounds yet.</div>';
    } else {
      roundsList.innerHTML = rounds.map(r => {
        const s = Stats.roundSummary(r.id);
        return `<div class="club-stat-row">
          <span class="name">${r.course}<br><span class="range">${new Date(r.date).toLocaleDateString()}</span></span>
          <span><span class="avg">${s.totalStrokes}</span><span class="range">${s.totalPutts} putts</span></span>
        </div>`;
      }).join("");
    }
  }

  // ---------------- Settings ----------------
  function renderSettings() {
    const settings = DB.getSettings();
    $("#sheetsUrlInput").value = settings.sheetsUrl || "";
    $("#unsyncedCount").textContent = DB.unsyncedCount();
    renderBag();
  }

  function renderBag() {
    const bag = DB.getBag();
    const list = $("#bagList");
    if (bag.length === 0) {
      list.innerHTML = '<div class="empty">No clubs yet — add your bag below.</div>';
      return;
    }
    list.innerHTML = "";
    bag.forEach((club, i) => {
      const row = document.createElement("div");
      row.className = "bag-item";
      row.innerHTML = `<span>${club}</span>`;
      const del = document.createElement("button");
      del.textContent = "✕";
      del.addEventListener("click", () => {
        const newBag = DB.getBag(); newBag.splice(i, 1); DB.setBag(newBag); renderBag();
      });
      row.appendChild(del);
      list.appendChild(row);
    });
  }

  $("#btnAddClub").addEventListener("click", () => {
    const input = $("#newClubInput");
    const val = input.value.trim();
    if (!val) return;
    const bag = DB.getBag();
    bag.push(val);
    DB.setBag(bag);
    input.value = "";
    renderBag();
  });
  $("#newClubInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btnAddClub").click(); });

  $("#btnSaveUrl").addEventListener("click", () => {
    const url = $("#sheetsUrlInput").value.trim();
    DB.setSettings({ ...DB.getSettings(), sheetsUrl: url });
    toast("Saved");
    Sync.attempt();
  });

  $("#btnSyncNow").addEventListener("click", () => {
    Sync.attempt();
    toast(navigator.onLine ? "Syncing…" : "No connection — will retry automatically");
  });

  // ---------------- Sync status pill ----------------
  function updatePill(status) {
    const pill = $("#syncPill");
    pill.className = "sync-pill dot " + status;
    if (status === "synced") pill.textContent = "Synced";
    else if (status === "pending") pill.textContent = DB.unsyncedCount() + " pending";
    else pill.textContent = "Offline";
    if ($("#screen-settings").classList.contains("active")) $("#unsyncedCount").textContent = DB.unsyncedCount();
  }
  Sync.onStatusChange(updatePill);

  // ---------------- Boot ----------------
  function boot() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(err => console.warn("SW register failed", err));
    }
    Sync.start();
    const activeId = DB.getActiveRoundId();
    const round = activeId ? DB.getRound(activeId) : null;
    showScreen(round && !round.ended ? "round" : "home");
  }
  boot();
})();
