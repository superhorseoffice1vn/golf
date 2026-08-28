// app.js — screens, GPS capture flow, and rendering. DB is the source of
// truth; this file just reflects it into the UI and reacts to taps.

(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  let pendingShot = null; // {lat, lon, accuracy, timestamp} awaiting club choice
  const skippedTeeShotHoles = new Set(); // "roundId:hole" — unlocks On Green when the tee shot was missed
  const strokesTouchedHoles = new Set(); // "roundId:hole" — user manually overrode Strokes, stop auto-syncing to Putts
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
  let selectedStartCourse = null; // built-in course name, or "Other"

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
    if (!selectedStartCourse) {
      const builtIns = DB.getBuiltInCourses();
      selectedStartCourse = builtIns.length ? builtIns[0] : "Other";
    }
    renderStartCourseChips();
  }

  function renderStartCourseChips() {
    const row = $("#startCourseChips");
    row.innerHTML = "";
    const options = [...DB.getBuiltInCourses(), "Other"];
    options.forEach(name => {
      const chip = document.createElement("button");
      chip.className = "round-chip" + (name === selectedStartCourse ? " active" : "");
      chip.textContent = name;
      chip.addEventListener("click", () => {
        selectedStartCourse = name;
        renderStartCourseChips();
        $("#customCourseBlock").style.display = name === "Other" ? "" : "none";
      });
      row.appendChild(chip);
    });
    $("#customCourseBlock").style.display = selectedStartCourse === "Other" ? "" : "none";
  }

  $("#btnContinueRound").addEventListener("click", () => showScreen("round"));

  $("#btnStartRound").addEventListener("click", () => {
    const course = selectedStartCourse === "Other" ? $("#courseInput").value.trim() : selectedStartCourse;
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
    $("#greenDistValue").textContent = "— yds";
    $("#greenDistSuggestion").textContent = "";
    $("#holeNum").textContent = round.currentHole;

    const isBuiltIn = DB.isBuiltInCourse(round.course);
    const builtInHole = isBuiltIn ? DB.getBuiltInHoleData(round.course, round.currentHole) : null;
    const parBadge = $("#parBadge");
    if (builtInHole) {
      parBadge.style.display = "";
      parBadge.textContent = "Par " + builtInHole.par;
    } else {
      parBadge.style.display = "none";
    }

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
    const wasAlreadyVisible = puttsBlock.style.display !== "none";
    if (hasGreen) {
      puttsBlock.style.display = "";
      const existing = DB.getHoleSummary(round.id, round.currentHole);

      // Par: locked badge for built-in courses (handled above); editable
      // stepper only for custom courses, since there's no fixed source for it.
      const parStepperControl = $("#parStepperControl");
      const parStepperLabel = $("#parStepperLabel");
      if (isBuiltIn) {
        parStepperControl.style.display = "none";
        parStepperLabel.style.display = "none";
      } else {
        parStepperControl.style.display = "";
        parStepperLabel.style.display = "";
        if (!wasAlreadyVisible) $("#parCount").textContent = existing && existing.par != null ? existing.par : 4;
      }

      // Only (re)initialize Putts/Strokes the moment this block first appears
      // for this hole visit — if it's already showing, leave whatever's
      // there alone, so logging another shot mid-edit can't wipe your taps.
      if (!wasAlreadyVisible) {
        $("#puttsCount").textContent = existing ? existing.putts : 0;
        $("#strokesCount").textContent = existing && existing.strokes != null
          ? existing.strokes
          : shotCount + (existing ? existing.putts : 0);
      }
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
    const maxHole = DB.getHoleCountForCourse(round.course);
    round.currentHole = Math.min(maxHole, round.currentHole + 1);
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

  // Par stepper — only shown/used for custom ("Other") courses, since
  // built-in courses have a fixed Par pulled from the course database.
  function getParInput() { return parseInt($("#parCount").textContent, 10) || 4; }
  $("#parMinus").addEventListener("click", () => { $("#parCount").textContent = Math.max(3, getParInput() - 1); });
  $("#parPlus").addEventListener("click", () => { $("#parCount").textContent = Math.min(6, getParInput() + 1); });

  // Strokes stepper — defaults to shots+putts and STAYS in sync with Putts
  // as you tap it, unless you manually adjust Strokes yourself (penalty
  // stroke, missed tee-shot log, etc.) — at that point it stops following
  // Putts for this hole, since we can no longer tell what your override
  // should track. Re-syncs automatically again once you move to a new hole.
  function getStrokes() { return parseInt($("#strokesCount").textContent, 10) || 0; }
  function currentHoleKey() {
    const round = activeRound();
    return round ? round.id + ":" + round.currentHole : null;
  }
  $("#strokesMinus").addEventListener("click", () => {
    $("#strokesCount").textContent = Math.max(0, getStrokes() - 1);
    const key = currentHoleKey(); if (key) strokesTouchedHoles.add(key);
  });
  $("#strokesPlus").addEventListener("click", () => {
    $("#strokesCount").textContent = Math.min(20, getStrokes() + 1);
    const key = currentHoleKey(); if (key) strokesTouchedHoles.add(key);
  });

  // Putts stepper
  function getPutts() { return parseInt($("#puttsCount").textContent, 10) || 0; }
  function syncStrokesToPutts(delta) {
    const key = currentHoleKey();
    if (key && strokesTouchedHoles.has(key)) return; // user has taken manual control this hole
    $("#strokesCount").textContent = Math.max(0, getStrokes() + delta);
  }
  $("#puttsMinus").addEventListener("click", () => { $("#puttsCount").textContent = Math.max(0, getPutts() - 1); syncStrokesToPutts(-1); });
  $("#puttsPlus").addEventListener("click", () => { $("#puttsCount").textContent = Math.min(20, getPutts() + 1); syncStrokesToPutts(1); });

  $("#btnFinishHole").addEventListener("click", () => {
    const round = activeRound(); if (!round) return;
    const putts = getPutts();
    const strokes = getStrokes();
    // Resolve Par: built-in courses always use their fixed value regardless
    // of what the (hidden) stepper shows; custom courses use the manual entry.
    const builtInHole = DB.getBuiltInHoleData(round.course, round.currentHole);
    const par = builtInHole ? builtInHole.par : getParInput();
    const existing = DB.getHoleSummary(round.id, round.currentHole);
    DB.saveHoleSummary({
      id: existing ? existing.id : DB.uid(),
      roundId: round.id, hole: round.currentHole, putts, strokes, par,
      timestamp: Date.now(), synced: false
    });
    Sync.attempt();
    const maxHole = DB.getHoleCountForCourse(round.course);
    if (round.currentHole >= maxHole) {
      toast("Hole " + maxHole + " logged — tap End Round when ready");
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
  function formatVsPar(n) {
    if (n == null) return "—";
    if (n === 0) return "E";
    return n > 0 ? "+" + n : String(n);
  }

  function renderStats() {
    const summary = Stats.allTimeSummary();
    $("#kpiRounds").textContent = summary.rounds;
    $("#kpiStrokes").textContent = summary.totalStrokes;
    $("#kpiPutts").textContent = summary.totalPutts;
    $("#kpiPuttsHole").textContent = summary.puttsPerHole.toFixed(1);
    $("#kpiVsPar").textContent = formatVsPar(summary.scoreVsPar);

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
        const vsPar = s.scoreVsPar != null ? " (" + formatVsPar(s.scoreVsPar) + ")" : "";
        const editBtn = r.ended
          ? `<button class="edit-round-btn" data-round-id="${r.id}" title="Edit this round" style="background:none; border:none; color:var(--ink-dim); font-size:16px; padding:6px 4px 6px 12px;">✏️</button>`
          : "";
        return `<div class="club-stat-row" style="align-items:center;">
          <span class="name">${r.course}<br><span class="range">${new Date(r.date).toLocaleDateString()} ${new Date(r.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></span>
          <span style="display:flex; align-items:center;">
            <span style="text-align:right;"><span class="avg">${s.totalStrokes}${vsPar}</span><span class="range">${s.totalPutts} putts</span></span>
            ${editBtn}
          </span>
        </div>`;
      }).join("");
      $$(".edit-round-btn").forEach(btn => {
        btn.addEventListener("click", () => reopenRoundForEdit(btn.dataset.roundId));
      });
    }
  }

  async function reopenRoundForEdit(roundId) {
    const round = DB.getRound(roundId);
    if (!round) return;
    const activeId = DB.getActiveRoundId();
    if (activeId && activeId !== roundId) {
      const other = DB.getRound(activeId);
      if (other && !other.ended) {
        const ok = await appConfirm(`You have "${other.course}" in progress. Reopening this round for editing will replace it as your active round — you can come back to "${other.course}" afterward. Continue?`);
        if (!ok) return;
      }
    }
    round.ended = false;
    DB.saveRound(round);
    DB.setActiveRoundId(round.id);
    toast("Reopened — use the hole stepper to find the hole, correct it, then End Round again");
    showScreen("round");
  }

  // ---------------- Settings ----------------
  function renderSettings() {
    $("#settingsCurrentPlayer").textContent = DB.getActivePlayerName() || "—";
    const settings = DB.getSettings();
    $("#sheetsUrlInput").value = settings.sheetsUrl || "";
    $("#unsyncedCount").textContent = DB.unsyncedCount();
    renderSyncError(Sync.lastError());
    renderBag();
    renderGreenSettings();
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

  // ---------------- Green Locations (shared across players, keyed by course) ----------------
  function currentGreenCourseName() {
    // Prefer whatever's typed; fall back to the most recent CUSTOM round's
    // course (built-ins have nothing to edit here, so don't default to one).
    const typed = $("#greenCourseInput").value.trim();
    if (typed) return typed;
    const rounds = DB.getRounds().slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    const lastCustom = rounds.find(r => !DB.isBuiltInCourse(r.course));
    return lastCustom ? lastCustom.course : "";
  }

  function renderGreenSettings() {
    const input = $("#greenCourseInput");
    if (!input.value.trim()) input.value = currentGreenCourseName();
    renderBuiltInCoursesList();
    renderGreenHoleList();
  }

  function renderBuiltInCoursesList() {
    const container = $("#builtInCoursesList");
    const courses = DB.getBuiltInCourses();
    if (courses.length === 0) {
      container.innerHTML = '<div class="empty">None yet.</div>';
      return;
    }
    container.innerHTML = courses.map(name => {
      const holeCount = DB.getHoleCountForCourse(name);
      let rows = "";
      for (let h = 1; h <= holeCount; h++) {
        const d = DB.getBuiltInHoleData(name, h);
        rows += `<tr><td>${h}</td><td>${d ? d.par : "—"}</td><td>${d ? d.lat.toFixed(5) + ", " + d.lon.toFixed(5) : "—"}</td></tr>`;
      }
      return `<div class="stat-card">
        <div class="title">${name} — 🔒 built-in (locked)</div>
        <table class="hole-table"><tr><th>Hole</th><th>Par</th><th>Green Coordinates</th></tr>${rows}</table>
      </div>`;
    }).join("");
  }

  function renderGreenHoleList() {
    const course = currentGreenCourseName();
    const editor = $("#customGreenEditor");
    const lockedNotice = $("#builtInLockedNotice");

    if (course && DB.isBuiltInCourse(course)) {
      editor.style.display = "none";
      lockedNotice.style.display = "";
      return;
    }
    editor.style.display = "";
    lockedNotice.style.display = "none";

    const greens = DB.getCourseGreens(course);
    const list = $("#greenHoleList");
    list.innerHTML = "";
    const holeCount = DB.getHoleCountForCourse(course); // 18 default for unlisted/custom
    for (let h = 1; h <= holeCount; h++) {
      const g = greens[h];
      const row = document.createElement("div");
      row.className = "bag-item";
      const status = g ? `Set (${g.lat.toFixed(5)}, ${g.lon.toFixed(5)})` : "Not set";
      row.innerHTML = `<span>Hole ${h} — <span style="color:${g ? "var(--fairway)" : "var(--ink-dim)"}">${status}</span></span>`;
      const btnWrap = document.createElement("span");
      const captureBtn = document.createElement("button");
      captureBtn.textContent = "📍";
      captureBtn.title = "Capture — stand at this green";
      captureBtn.style.marginRight = g ? "10px" : "0";
      captureBtn.addEventListener("click", () => captureGreenForHole(course, h));
      btnWrap.appendChild(captureBtn);
      if (g) {
        const clearBtn = document.createElement("button");
        clearBtn.textContent = "✕";
        clearBtn.addEventListener("click", () => {
          DB.clearGreenForHole(course, h);
          renderGreenHoleList();
        });
        btnWrap.appendChild(clearBtn);
      }
      row.appendChild(btnWrap);
      list.appendChild(row);
    }
  }

  async function captureGreenForHole(course, hole) {
    toast("Locking GPS for hole " + hole + "…");
    try {
      const loc = await captureLocation({});
      DB.setGreenForHole(course, hole, { lat: loc.lat, lon: loc.lon });
      toast("Hole " + hole + " green saved (±" + loc.accuracy + "m)");
      renderGreenHoleList();
    } catch (err) {
      toast("GPS failed: " + (err.message || "check location permission"));
    }
  }

  $("#greenCourseInput").addEventListener("change", renderGreenHoleList);

  $("#btnImportGreens").addEventListener("click", () => {
    const course = currentGreenCourseName();
    if (DB.isBuiltInCourse(course)) {
      toast(course + " is built-in and locked — can't import over it");
      return;
    }
    const text = $("#greenPasteInput").value;
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    let imported = 0;
    lines.forEach(line => {
      const m = line.match(/^(\d{1,2})\s*[:,]\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*$/);
      if (!m) return;
      const hole = parseInt(m[1], 10);
      const lat = parseFloat(m[2]);
      const lon = parseFloat(m[3]);
      if (hole < 1 || hole > 18 || isNaN(lat) || isNaN(lon)) return;
      DB.setGreenForHole(course, hole, { lat, lon });
      imported++;
    });
    if (imported === 0) {
      toast("No valid lines found — use \"hole: lat, lon\" per line");
    } else {
      toast("Imported " + imported + " green location" + (imported === 1 ? "" : "s"));
      $("#greenPasteInput").value = "";
      renderGreenHoleList();
    }
  });

  function suggestClubForDistance(targetYards) {
    const dist = Stats.clubDistances();
    let best = null, bestDiff = Infinity;
    Object.keys(dist).forEach(club => {
      const bucket = dist[club].full;
      if (!bucket) return; // only suggest from full-swing data, not short-game clusters
      const diff = Math.abs(bucket.avg - targetYards);
      if (diff < bestDiff) { bestDiff = diff; best = { club, avg: bucket.avg }; }
    });
    return best;
  }

  $("#btnCheckGreenDist").addEventListener("click", async () => {
    const round = activeRound(); if (!round) return;
    const green = DB.getGreenForHole(round.course, round.currentHole);
    if (!green) {
      toast("No green saved for hole " + round.currentHole + " — set it up in Settings");
      return;
    }
    const valueEl = $("#greenDistValue");
    const suggestionEl = $("#greenDistSuggestion");
    const original = valueEl.textContent;
    valueEl.textContent = "Locking…";
    suggestionEl.textContent = "";
    try {
      const loc = await captureLocation({
        onSample: (sample, best) => { valueEl.textContent = "±" + best.accuracy + "m…"; }
      });
      const meters = Stats.haversine({ lat: loc.lat, lon: loc.lon }, green);
      const yards = Math.round(Stats.metersToYards(meters));
      valueEl.textContent = yards + " yds";
      const suggestion = suggestClubForDistance(yards);
      if (suggestion) {
        const cat = clubCategory(suggestion.club);
        suggestionEl.innerHTML = `Suggested: <span style="color:var(--cat-${cat}); font-weight:700;">${suggestion.club}</span> (avg ${Math.round(suggestion.avg)}y)`;
      } else {
        suggestionEl.textContent = "Not enough club data yet for a suggestion";
      }
    } catch (err) {
      valueEl.textContent = original;
      toast("GPS failed: " + (err.message || "check location permission"));
    }
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
