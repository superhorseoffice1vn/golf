// app.js — screens, GPS capture flow, and rendering. DB is the source of
// truth; this file just reflects it into the UI and reacts to taps.

(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  let pendingShot = null; // {lat, lon, accuracy, timestamp} awaiting club choice
  const skippedTeeShotHoles = new Set(); // "roundId:hole" — unlocks On Green when the tee shot was missed
  let pendingPlayerId = null;
  let initialPickerFlow = false;

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

  // In-app replacement for window.confirm() — browsers can silently suppress
  // native confirm() after a few popups ("prevent this page from creating
  // additional dialogs"), which makes buttons relying on it look broken.
  // This dialog is just our own DOM, so it can never be blocked that way.
  function appConfirm(message) {
    return new Promise((resolve) => {
      $("#confirmMessage").textContent = message;
      $("#confirmOverlay").style.display = "flex";
      const cleanup = (result) => {
        $("#confirmOverlay").style.display = "none";
        okBtn.removeEventListener("click", onOk);
        cancelBtn.removeEventListener("click", onCancel);
        resolve(result);
      };
      const okBtn = $("#confirmOk");
      const cancelBtn = $("#confirmCancel");
      const onOk = () => cleanup(true);
      const onCancel = () => cleanup(false);
      okBtn.addEventListener("click", onOk);
      cancelBtn.addEventListener("click", onCancel);
    });
  }

  function ordinal(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // ---------------- Geolocation ----------------
  // A single getCurrentPosition() call often returns the FIRST fix the chip
  // produces, which can be noisy (cold start, tree cover, cart canopy).
  // Instead: watch for up to 8s, keep the best (lowest-error) sample seen,
  // and resolve early the moment we get a genuinely tight fix.
  const GOOD_ACCURACY_M = 6;
  const MAX_WAIT_MS = 8000;
  const WARN_ACCURACY_M = 20;

  function captureLocation({ onAcquiring, onSample } = {}) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error("No GPS on this device/browser")); return; }
      if (onAcquiring) onAcquiring();

      let best = null;
      let watchId = null;
      let settled = false;
      let timer = null;

      const finish = (result, err) => {
        if (settled) return;
        settled = true;
        if (watchId !== null) navigator.geolocation.clearWatch(watchId);
        clearTimeout(timer);
        if (err) reject(err); else resolve(result);
      };

      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const sample = {
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            accuracy: Math.round(pos.coords.accuracy),
            timestamp: Date.now()
          };
          if (!best || sample.accuracy < best.accuracy) best = sample;
          if (onSample) onSample(sample, best);
          if (best.accuracy <= GOOD_ACCURACY_M) finish(best);
        },
        (err) => { if (!best) finish(null, err); }, // keep waiting if we already have a fix and just get a hiccup
        { enableHighAccuracy: true, maximumAge: 0, timeout: MAX_WAIT_MS }
      );

      timer = setTimeout(() => {
        if (best) finish(best);
        else finish(null, new Error("No GPS fix — check location permission and try in open sky"));
      }, MAX_WAIT_MS);
    });
  }

  function accuracyClass(m) {
    if (m <= GOOD_ACCURACY_M) return "acc-good";
    if (m <= WARN_ACCURACY_M) return "acc-ok";
    return "acc-poor";
  }

  // ---------------- Club categorization ----------------
  const CATEGORY_ORDER = ["wood", "iron", "wedge", "putter", "other"];
  const CATEGORY_LABEL = {
    wood: "Driver, Woods & Hybrids",
    iron: "Irons",
    wedge: "Wedges",
    putter: "Putter",
    other: "Other"
  };
  const CATEGORY_ICON = { wood: "◆", iron: "▮", wedge: "◐", putter: "●", other: "•" };

  function clubCategory(name) {
    const n = name.toLowerCase();
    if (n.includes("putter")) return "putter";
    if (n.includes("wedge")) return "wedge";
    if (n.includes("iron")) return "iron";
    if (n.includes("wood") || n.includes("driver") || n.includes("hybrid")) return "wood";
    return "other";
  }

  // ---------------- Home ----------------
  function renderHome() {
    const playerName = DB.getActivePlayerName();
    $("#homePlayerLine").textContent = playerName ? "Playing as " + playerName : "";
    const activeId = DB.getActiveRoundId();
    const round = activeId ? DB.getRound(activeId) : null;
    const block = $("#continueBlock");
    if (round && !round.ended) {
      block.style.display = "";
      $("#continueCourse").textContent = round.course + " — hole " + round.currentHole;
    } else {
      block.style.display = "none";
    }
    $("#courseInput").value = "Mukdahan Golf Club";
  }

  $("#btnContinueRound").addEventListener("click", () => showScreen("round"));

  $("#btnStartRound").addEventListener("click", () => {
    const course = $("#courseInput").value.trim();
    if (!course) { toast("Enter a course name"); return; }
    if (DB.getBag().length === 0) { toast("Add clubs in Settings first"); showScreen("settings"); return; }
    const round = {
      id: DB.uid(),
      course,
      playerName: DB.getActivePlayerName(),
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

    $("#roundCourseChip").textContent = round.course + " · " + new Date(round.date).toLocaleDateString() + " " + new Date(round.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    $("#holeNum").textContent = round.currentHole;

    const entries = DB.entriesForHole(round.id, round.currentHole);
    const log = $("#shotLog");
    log.innerHTML = "";
    entries.forEach((e, i) => {
      const row = document.createElement("div");
      row.className = "shot-row" + (e.type === "Green" ? " green" : "");
      const time = new Date(e.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      row.innerHTML = `<span class="club-tag">${e.type === "Green" ? "📍 On green" : (i + 1) + ". " + e.club}</span><span class="meta">${time} · <span class="${accuracyClass(e.accuracy)}">±${e.accuracy}m</span></span>`;
      log.appendChild(row);
    });

    const hasGreen = entries.some(e => e.type === "Green");
    const shotCount = entries.filter(e => e.type === "Shot").length;
    const skipKey = round.id + ":" + round.currentHole;
    const teeShotReady = shotCount > 0 || skippedTeeShotHoles.has(skipKey);

    const greenBtn = $("#btnOnGreen");
    const skipLink = $("#btnSkipTeeShot");
    if (teeShotReady) {
      greenBtn.style.display = "";
      skipLink.style.display = "none";
      greenBtn.textContent = hasGreen ? "Green marked ✓ (tap to re-mark)" : "On green — mark spot";
    } else {
      // First action of every hole must be a tee shot — hide the green marker
      // until one's logged, so it can't be tapped out of order by accident.
      greenBtn.style.display = "none";
      skipLink.style.display = "";
    }

    $("#btnLogShot .cta").textContent = "Log " + ordinal(shotCount + 1) + " Shot";

    const puttsBlock = $("#puttsBlock");
    if (hasGreen) {
      puttsBlock.style.display = "";
      const existing = DB.getHoleSummary(round.id, round.currentHole);
      $("#puttsCount").textContent = existing ? existing.putts : 0;
      // Strokes defaults to shots+putts, but only when not already explicitly
      // saved for this hole — once set, it's independent of further edits.
      $("#strokesCount").textContent = existing && existing.strokes != null
        ? existing.strokes
        : shotCount + (existing ? existing.putts : 0);
    } else {
      puttsBlock.style.display = "none";
    }

    $("#captureHint").textContent = "Stand at your ball, then tap";
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
      const loc = await captureLocation({
        onSample: (sample, best) => { $("#captureHint").textContent = "Locking GPS… ±" + best.accuracy + "m"; }
      });
      pendingShot = loc;
      btn.classList.remove("acquiring");
      if (loc.accuracy > WARN_ACCURACY_M) toast("Low GPS accuracy: ±" + loc.accuracy + "m — try open sky next time");
      openClubPicker();
    } catch (err) {
      btn.classList.remove("acquiring");
      $("#captureHint").textContent = "Stand at your ball, then tap";
      toast("GPS failed: " + (err.message || "check location permission"));
    }
  });

  $("#btnSkipTeeShot").addEventListener("click", () => {
    const round = activeRound(); if (!round) return;
    skippedTeeShotHoles.add(round.id + ":" + round.currentHole);
    toast("OK — adjust Strokes below to include the shot you missed");
    renderRound();
  });

  $("#btnOnGreen").addEventListener("click", async () => {
    const round = activeRound(); if (!round) return;
    const btn = $("#btnOnGreen");
    const original = btn.textContent;
    try {
      const loc = await captureLocation({
        onSample: (sample, best) => { btn.textContent = "Locking GPS… ±" + best.accuracy + "m"; }
      });
      const entry = {
        id: DB.uid(), roundId: round.id, hole: round.currentHole, seq: Date.now(),
        type: "Green", club: null, lat: loc.lat, lon: loc.lon, accuracy: loc.accuracy,
        timestamp: loc.timestamp, synced: false
      };
      DB.addEntry(entry);
      Sync.attempt();
      if (loc.accuracy > WARN_ACCURACY_M) toast("Low GPS accuracy: ±" + loc.accuracy + "m — try open sky next time");
      renderRound();
    } catch (err) {
      toast("GPS failed: " + (err.message || "check location permission"));
      btn.textContent = original;
    }
  });

  // Strokes stepper — defaults to shots+putts but is independently editable,
  // so penalty strokes, miscounts, or a missed tee-shot log can be corrected
  // without touching the underlying GPS shot data used for club distances.
  function getStrokes() { return parseInt($("#strokesCount").textContent, 10) || 0; }
  $("#strokesMinus").addEventListener("click", () => { $("#strokesCount").textContent = Math.max(0, getStrokes() - 1); });
  $("#strokesPlus").addEventListener("click", () => { $("#strokesCount").textContent = Math.min(20, getStrokes() + 1); });

  // Putts stepper
  function getPutts() { return parseInt($("#puttsCount").textContent, 10) || 0; }
  $("#puttsMinus").addEventListener("click", () => { $("#puttsCount").textContent = Math.max(0, getPutts() - 1); });
  $("#puttsPlus").addEventListener("click", () => { $("#puttsCount").textContent = Math.min(20, getPutts() + 1); });

  $("#btnFinishHole").addEventListener("click", () => {
    const round = activeRound(); if (!round) return;
    const putts = getPutts();
    const strokes = getStrokes();
    const existing = DB.getHoleSummary(round.id, round.currentHole);
    DB.saveHoleSummary({
      id: existing ? existing.id : DB.uid(),
      roundId: round.id, hole: round.currentHole, putts, strokes,
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

  $("#btnEndRound").addEventListener("click", async () => {
    const round = activeRound(); if (!round) return;
    const ok = await appConfirm("End this round? You can still view it in Stats.");
    if (!ok) return;
    round.ended = true;
    DB.saveRound(round);
    DB.setActiveRoundId(null);
    showScreen("home");
  });

  // ---------------- Club picker ----------------
  function openClubPicker() {
    const container = $("#clubGroups");
    container.innerHTML = "";

    const bag = DB.getBag();
    const byCat = {};
    bag.forEach(club => {
      const cat = clubCategory(club);
      if (!byCat[cat]) byCat[cat] = [];
      byCat[cat].push(club);
    });

    CATEGORY_ORDER.forEach(cat => {
      const clubs = byCat[cat];
      if (!clubs || clubs.length === 0) return;

      const section = document.createElement("div");
      section.className = "club-section";

      const title = document.createElement("div");
      title.className = "club-section-title";
      title.innerHTML = `<span class="swatch" style="background:var(--cat-${cat})"></span>${CATEGORY_LABEL[cat]}`;
      section.appendChild(title);

      const grid = document.createElement("div");
      grid.className = "club-grid";
      clubs.forEach(club => {
        const b = document.createElement("button");
        b.className = "cat-" + cat;
        b.innerHTML = `<span class="club-icon">${CATEGORY_ICON[cat]}</span><span>${club}</span>`;
        b.addEventListener("click", () => chooseClub(club));
        grid.appendChild(b);
      });
      section.appendChild(grid);
      container.appendChild(section);
    });

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
    // Sort by full-swing avg where available, else by short-shot avg
    const clubs = Object.keys(dist).sort((a, b) => {
      const av = dist[a].full ? dist[a].full.avg : dist[a].short.avg;
      const bv = dist[b].full ? dist[b].full.avg : dist[b].short.avg;
      return bv - av;
    });
    if (clubs.length === 0) {
      list.innerHTML = '<div class="empty">Log a few shots to see distances here.</div>';
    } else {
      list.innerHTML = clubs.map(c => {
        const d = dist[c];
        const main = d.full || d.short; // if no clean full-swing cluster, show what we have
        const mainLabel = d.full ? "" : " (short shots only)";
        let html = `<div class="club-stat-row">
          <span class="name">${c}${mainLabel}</span>
          <span><span class="avg">${Math.round(main.avg)}y</span><span class="range">${Math.round(main.min)}–${Math.round(main.max)} · n=${main.count}</span></span>
        </div>`;
        if (d.full && d.short) {
          html += `<div class="club-stat-row" style="padding-top:0; opacity:0.75;">
            <span class="name" style="font-weight:400; font-size:12px; padding-left:10px;">↳ Short shots</span>
            <span><span class="range">${Math.round(d.short.avg)}y avg · n=${d.short.count}</span></span>
          </div>`;
        }
        return html;
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
          <span class="name">${r.course}<br><span class="range">${new Date(r.date).toLocaleDateString()} ${new Date(r.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></span>
          <span><span class="avg">${s.totalStrokes}</span><span class="range">${s.totalPutts} putts</span></span>
        </div>`;
      }).join("");
    }
  }

  // ---------------- Settings ----------------
  function renderSettings() {
    $("#settingsCurrentPlayer").textContent = DB.getActivePlayerName() || "—";
    const settings = DB.getSettings();
    $("#sheetsUrlInput").value = settings.sheetsUrl || "";
    $("#unsyncedCount").textContent = DB.unsyncedCount();
    renderSyncError(Sync.lastError());
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
      const cat = clubCategory(club);
      row.innerHTML = `<span><span class="club-icon" style="color:var(--cat-${cat}); margin-right:8px;">${CATEGORY_ICON[cat]}</span>${club}</span>`;
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

  $("#btnResetBag").addEventListener("click", async () => {
    const ok = await appConfirm("Reset your bag to the standard club set? This removes any custom clubs you've added.");
    if (!ok) return;
    DB.setBag(DB.getDefaultBag());
    renderBag();
    toast("Bag reset to standard set");
  });

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
  function updatePill(status, errMsg) {
    const pill = $("#syncPill");
    pill.className = "sync-pill dot " + status;
    if (status === "synced") pill.textContent = "Synced";
    else if (status === "pending") pill.textContent = DB.unsyncedCount() + " pending";
    else pill.textContent = "Offline";
    pill.title = errMsg || "";
    if ($("#screen-settings").classList.contains("active")) {
      $("#unsyncedCount").textContent = DB.unsyncedCount();
      renderSyncError(errMsg);
    }
  }
  function renderSyncError(errMsg) {
    const el = $("#syncError");
    if (!el) return;
    if (errMsg && navigator.onLine) {
      el.style.display = "";
      el.textContent = "Last sync error: " + errMsg;
    } else {
      el.style.display = "none";
    }
  }
  Sync.onStatusChange(updatePill);

  // ---------------- Player picker ----------------
  function openPlayerPicker(cancelable) {
    renderPlayerPickerList();
    $("#pinPromptArea").style.display = "none";
    $("#playerPickerBody").style.display = "";
    $("#addPlayerForm").style.display = "none";
    $("#btnPickerCancel").style.display = cancelable ? "" : "none";
    $("#playerPicker").style.display = "flex";
  }
  function closePlayerPicker() { $("#playerPicker").style.display = "none"; }

  function renderPlayerPickerList() {
    const list = $("#playerList");
    list.innerHTML = "";
    const players = DB.getPlayers();
    players.forEach(p => {
      const row = document.createElement("div");
      row.className = "row";
      const btn = document.createElement("button");
      btn.className = "btn block";
      btn.textContent = p.name + (p.pin ? " 🔒" : "");
      btn.addEventListener("click", () => attemptSelectPlayer(p.id));
      row.appendChild(btn);
      if (players.length > 1) {
        const del = document.createElement("button");
        del.className = "btn danger-ghost";
        del.style.width = "auto";
        del.textContent = "✕";
        del.addEventListener("click", (e) => { e.stopPropagation(); deletePlayer(p.id); });
        row.appendChild(del);
      }
      list.appendChild(row);
    });
  }

  async function deletePlayer(id) {
    const p = DB.getPlayer(id);
    const ok = await appConfirm(`Remove ${p ? p.name : "this"}'s profile from this device? Their data stays stored but won't be reachable unless re-added.`);
    if (!ok) return;
    DB.removePlayer(id);
    if (DB.getActivePlayerId() === id) DB.setActivePlayerId(null);
    renderPlayerPickerList();
    if (!DB.getActivePlayerId()) $("#btnPickerCancel").style.display = "none";
  }

  function attemptSelectPlayer(id) {
    const p = DB.getPlayer(id);
    if (!p) return;
    if (!p.pin) { finalizeSelectPlayer(id); return; }
    pendingPlayerId = id;
    $("#pinPromptName").textContent = "Enter PIN for " + p.name;
    $("#pinInput").value = "";
    $("#pinError").classList.remove("show");
    $("#playerPickerBody").style.display = "none";
    $("#pinPromptArea").style.display = "";
    $("#pinInput").focus();
  }

  function confirmPin() {
    const p = DB.getPlayer(pendingPlayerId);
    if (!p) return;
    if ($("#pinInput").value === p.pin) {
      finalizeSelectPlayer(p.id);
    } else {
      $("#pinError").classList.add("show");
      $("#pinInput").value = "";
      $("#pinInput").focus();
    }
  }
  $("#btnPinConfirm").addEventListener("click", confirmPin);
  $("#pinInput").addEventListener("keydown", (e) => { if (e.key === "Enter") confirmPin(); });
  $("#btnPinCancel").addEventListener("click", () => {
    $("#pinPromptArea").style.display = "none";
    $("#playerPickerBody").style.display = "";
  });
  $("#btnPickerCancel").addEventListener("click", () => closePlayerPicker());

  $("#btnAddPlayerToggle").addEventListener("click", () => {
    const f = $("#addPlayerForm");
    f.style.display = f.style.display === "none" ? "" : "none";
  });
  $("#btnAddPlayerConfirm").addEventListener("click", () => {
    const name = $("#newPlayerName").value.trim();
    const pin = $("#newPlayerPin").value.trim();
    if (!name) { toast("Enter a name"); return; }
    if (pin && !/^\d{4}$/.test(pin)) { toast("PIN must be 4 digits, or leave it blank"); return; }
    const player = DB.addPlayer(name, pin);
    $("#newPlayerName").value = ""; $("#newPlayerPin").value = "";
    $("#addPlayerForm").style.display = "none";
    finalizeSelectPlayer(player.id);
  });

  function finalizeSelectPlayer(id) {
    DB.setActivePlayerId(id);
    closePlayerPicker();
    if (initialPickerFlow) {
      initialPickerFlow = false;
      $("#appRoot").style.display = "";
      boot();
    } else {
      pendingShot = null;
      toast("Switched to " + DB.getActivePlayerName());
      showScreen("home");
    }
  }

  $("#btnSwitchPlayer").addEventListener("click", () => { openPlayerPicker(true); });

  // ---------------- Login ----------------
  const AUTH_KEY = "fl_authed";
  const APP_PASSWORD = "shsh";

  function attemptLogin() {
    const input = $("#loginPassword");
    if (input.value === APP_PASSWORD) {
      localStorage.setItem(AUTH_KEY, "true");
      $("#loginError").classList.remove("show");
      enterApp();
    } else {
      $("#loginError").classList.add("show");
      input.classList.add("shake");
      setTimeout(() => input.classList.remove("shake"), 350);
      input.value = "";
      input.focus();
    }
  }
  $("#btnLogin").addEventListener("click", attemptLogin);
  $("#loginPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") attemptLogin(); });

  $("#btnLockApp").addEventListener("click", async () => {
    const ok = await appConfirm("Lock the app? You'll need the password to get back in.");
    if (!ok) return;
    localStorage.removeItem(AUTH_KEY);
    location.reload();
  });

  function enterApp() {
    $("#loginScreen").style.display = "none";
    if (!DB.getActivePlayerId()) {
      initialPickerFlow = true;
      openPlayerPicker(false);
    } else {
      $("#appRoot").style.display = "";
      boot();
    }
  }

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

  if (localStorage.getItem(AUTH_KEY) === "true") {
    enterApp();
  } else {
    $("#loginPassword").focus();
  }
})();
