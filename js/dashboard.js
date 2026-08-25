// dashboard.js — standalone: reads live from Google Sheets (via the same
// Apps Script Web App the phone app writes to). No local round data used.

(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const AUTH_KEY = "fl_authed";
  const APP_PASSWORD = "shsh";
  const SETTINGS_KEY = "fl_settings"; // same key the phone app uses — shares config automatically
  const DEFAULT_SHEETS_URL = "https://script.google.com/macros/s/AKfycbzDu5QNAKlVtM8BGY6pw97XzBQ6sjwvZyB3o9MVY8N3sKtFD9koD-4eC3h3mCWLw3Em-A/exec";

  let allRows = [];         // every normalized row from the sheet, all players
  let rounds = [];          // grouped rounds for the SELECTED player only, most recent first
  let selectedRoundKey = null;
  let selectedPlayer = null;
  let selectedMapHole = "all";
  let shotMapInstance = null;
  let shotMapLayer = null;

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast._h);
    toast._h = setTimeout(() => t.classList.remove("show"), 2200);
  }

  // ---------------- Settings (shared with phone app) ----------------
  function getSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY));
      if (s && s.sheetsUrl) return s;
    } catch (e) { /* fall through */ }
    return { sheetsUrl: DEFAULT_SHEETS_URL };
  }
  function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

  // ---------------- Login ----------------
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
      input.value = ""; input.focus();
    }
  }
  $("#btnLogin").addEventListener("click", attemptLogin);
  $("#loginPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") attemptLogin(); });

  function enterApp() {
    $("#loginScreen").style.display = "none";
    $("#appRoot").style.display = "";
    init();
  }

  // ---------------- Club categorization (mirrors main app) ----------------
  function clubCategory(name) {
    const n = (name || "").toLowerCase();
    if (n.includes("putter")) return "putter";
    if (n.includes("wedge")) return "wedge";
    if (n.includes("iron")) return "iron";
    if (n.includes("wood") || n.includes("driver") || n.includes("hybrid")) return "wood";
    return "other";
  }

  // ---------------- Geo + stats math ----------------
  const EARTH_R_M = 6371000;
  function haversine(a, b) {
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const lat1 = toRad(a.lat);
    const lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_R_M * Math.asin(Math.sqrt(h));
  }
  const toYards = (m) => m * 1.09361;

  function normalizeRows(raw) {
    return raw.map(r => ({
      timestamp: r["Timestamp"] ? new Date(r["Timestamp"]) : null,
      course: r["Course"] || "",
      hole: r["Hole"] !== "" && r["Hole"] != null ? Number(r["Hole"]) : null,
      type: r["Type"] || "",
      club: r["Club"] || "",
      lat: r["Lat"] !== "" && r["Lat"] != null ? Number(r["Lat"]) : null,
      lon: r["Lon"] !== "" && r["Lon"] != null ? Number(r["Lon"]) : null,
      accuracy: r["Accuracy (m)"] !== "" && r["Accuracy (m)"] != null ? Number(r["Accuracy (m)"]) : null,
      putts: r["Putts"] !== "" && r["Putts"] != null ? Number(r["Putts"]) : null,
      entryId: r["Entry ID"] || "",
      roundId: r["Round ID"] || "",
      player: r["Player"] || "Unknown"
    })).filter(r => r.timestamp instanceof Date && !isNaN(r.timestamp));
  }

  // Same-origin as the main app, so this device's active player (if any) is a
  // sensible default filter — no need to make the person pick every time.
  function getLocalActivePlayerName() {
    try {
      const activeId = JSON.parse(localStorage.getItem("fl_active_player"));
      const players = JSON.parse(localStorage.getItem("fl_players")) || [];
      const p = players.find(pl => pl.id === activeId);
      return p ? p.name : null;
    } catch (e) { return null; }
  }

  // Group rows into rounds. Prefer explicit Round ID (new data); rows synced
  // before Round ID existed fall back to grouping by course + calendar day.
  function groupRounds(rows) {
    const map = {};
    rows.forEach(r => {
      const dayKey = r.timestamp.toISOString().slice(0, 10);
      const key = r.roundId ? ("id:" + r.roundId) : ("day:" + r.course + "|" + dayKey);
      if (!map[key]) map[key] = { key, course: r.course, date: r.timestamp, rows: [] };
      map[key].rows.push(r);
      if (r.timestamp < map[key].date) map[key].date = r.timestamp;
      if (!map[key].course && r.course) map[key].course = r.course;
    });
    const list = Object.values(map);
    list.forEach(rd => rd.rows.sort((a, b) => a.timestamp - b.timestamp));
    list.sort((a, b) => b.date - a.date);
    return list;
  }

  // Stats for ONE round's rows only — never pass mixed-round rows in here,
  // since hole numbers repeat across rounds and would merge incorrectly.
  function computeRoundStats(rows) {
    const holesSet = [...new Set(rows.map(r => r.hole).filter(h => h != null))].sort((a, b) => a - b);
    const perHole = {};
    const clubRaw = {}; // club -> [yards]

    holesSet.forEach(h => {
      const holeRows = rows.filter(r => r.hole === h).sort((a, b) => a.timestamp - b.timestamp);
      const shots = holeRows.filter(r => r.type === "Shot").length;
      const puttsRow = holeRows.find(r => r.type === "Putts");
      const putts = puttsRow ? (puttsRow.putts || 0) : 0;
      perHole[h] = { shots, putts, strokes: shots + putts };

      const posRows = holeRows.filter(r => (r.type === "Shot" || r.type === "Green") && r.lat != null && r.lon != null);
      for (let i = 0; i < posRows.length - 1; i++) {
        const cur = posRows[i], next = posRows[i + 1];
        if (cur.type !== "Shot" || !cur.club) continue;
        if ((cur.accuracy || 0) > 25 || (next.accuracy || 0) > 25) continue;
        const dMeters = haversine(cur, next);
        if (dMeters >= 2000) continue; // sanity cap, filters bad fixes
        if (!clubRaw[cur.club]) clubRaw[cur.club] = [];
        clubRaw[cur.club].push(toYards(dMeters));
      }
    });

    const totalStrokes = Object.values(perHole).reduce((s, h) => s + h.strokes, 0);
    const totalPutts = Object.values(perHole).reduce((s, h) => s + h.putts, 0);

    const clubDistances = {};
    Object.keys(clubRaw).forEach(c => {
      const arr = clubRaw[c].slice().sort((a, b) => a - b);
      const sum = arr.reduce((a, b) => a + b, 0);
      clubDistances[c] = { count: arr.length, avg: sum / arr.length, min: arr[0], max: arr[arr.length - 1], raw: arr };
    });

    return { holesSet, perHole, totalStrokes, totalPutts, holesPlayed: holesSet.length, clubDistances };
  }

  // ---------------- Shot map ----------------
  const HOLE_COLORS = ["#F2A93C", "#6E9BC7", "#D9784F", "#4C8B52", "#C77DFF", "#5FD4C7", "#E85D75", "#8FBF5A"];

  function ensureMap() {
    if (shotMapInstance) return shotMapInstance;
    shotMapInstance = L.map("shotMap", { zoomControl: true, attributionControl: true });
    L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      attribution: "Imagery &copy; Esri",
      maxZoom: 20
    }).addTo(shotMapInstance);
    shotMapLayer = L.layerGroup().addTo(shotMapInstance);
    return shotMapInstance;
  }

  function renderMapHoleChips(rd) {
    const chipRow = $("#mapHoleChips");
    chipRow.innerHTML = "";
    const holes = [...new Set(rd.rows.map(r => r.hole).filter(h => h != null))].sort((a, b) => a - b);

    const allChip = document.createElement("button");
    allChip.className = "round-chip" + (selectedMapHole === "all" ? " active" : "");
    allChip.textContent = "All holes";
    allChip.addEventListener("click", () => { selectedMapHole = "all"; renderMapHoleChips(rd); updateShotMap(rd); });
    chipRow.appendChild(allChip);

    holes.forEach(h => {
      const chip = document.createElement("button");
      chip.className = "round-chip" + (selectedMapHole === h ? " active" : "");
      chip.textContent = "Hole " + h;
      chip.addEventListener("click", () => { selectedMapHole = h; renderMapHoleChips(rd); updateShotMap(rd); });
      chipRow.appendChild(chip);
    });
  }

  function updateShotMap(rd) {
    const points = rd.rows.filter(r =>
      r.lat != null && r.lon != null && (r.type === "Shot" || r.type === "Green") &&
      (selectedMapHole === "all" ? true : r.hole === selectedMapHole)
    );
    renderShotMap(points, selectedMapHole === "all");
  }

  function renderShotMap(points, colorByHole) {
    const box = $("#shotMap");
    const empty = $("#shotMapEmpty");
    if (!points.length) {
      box.style.display = "none";
      empty.style.display = "";
      return;
    }
    box.style.display = "";
    empty.style.display = "none";

    const map = ensureMap();
    setTimeout(() => map.invalidateSize(), 50); // in case the container was hidden when the map was created
    shotMapLayer.clearLayers();

    const byHole = {};
    points.forEach(p => { (byHole[p.hole] = byHole[p.hole] || []).push(p); });

    let holeIdx = 0;
    const allLatLngs = [];

    Object.keys(byHole).sort((a, b) => a - b).forEach(holeNum => {
      const holePts = byHole[holeNum];
      const lineColor = colorByHole ? HOLE_COLORS[holeIdx % HOLE_COLORS.length] : "#F1F5EE";
      holeIdx++;

      const latlngs = holePts.map(p => [p.lat, p.lon]);
      allLatLngs.push(...latlngs);
      if (latlngs.length > 1) {
        L.polyline(latlngs, { color: lineColor, weight: 3, opacity: 0.85, dashArray: "6 5" }).addTo(shotMapLayer);
      }

      holePts.forEach((p, i) => {
        const isGreen = p.type === "Green";
        const cat = isGreen ? "putter" : clubCategory(p.club);
        const label = isGreen ? "⛳" : String(i + 1);
        const icon = L.divIcon({
          className: "",
          html: `<div style="background:var(--cat-${cat}); width:26px; height:26px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#0B0F0E; font-weight:800; font-size:12px; border:2px solid #0F1611; box-shadow:0 1px 5px rgba(0,0,0,0.5); font-family:sans-serif;">${label}</div>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13]
        });

        let nextInfo = "";
        if (!isGreen && p.club && i < holePts.length - 1) {
          const yards = Math.round(toYards(haversine(p, holePts[i + 1])));
          nextInfo = `<br>${yards}y to next`;
        }
        const popup = `<b>Hole ${holeNum}</b><br>${isGreen ? "On green" : p.club}${nextInfo}<br><span style="color:var(--ink-dim)">±${p.accuracy}m accuracy</span>`;

        L.marker([p.lat, p.lon], { icon }).addTo(shotMapLayer).bindPopup(popup);
      });
    });

    map.fitBounds(allLatLngs, { padding: [30, 30], maxZoom: 19 });
  }

  // ---------------- Rendering ----------------
  function renderPlayerChips(players) {
    const row = $("#playerChipRow");
    row.innerHTML = "";
    players.forEach(name => {
      const chip = document.createElement("button");
      chip.className = "round-chip" + (name === selectedPlayer ? " active" : "");
      chip.textContent = name;
      chip.addEventListener("click", () => { selectedPlayer = name; applyPlayerFilter(); });
      row.appendChild(chip);
    });
  }

  function applyPlayerFilter() {
    const players = [...new Set(allRows.map(r => r.player))].sort();
    renderPlayerChips(players);

    rounds = groupRounds(allRows.filter(r => r.player === selectedPlayer));

    if (rounds.length === 0) {
      $("#dashContent").style.display = "none";
      $("#dashError").style.display = "";
      $("#dashErrorMsg").textContent = selectedPlayer + " hasn't logged any rounds yet.";
      return;
    }
    $("#dashContent").style.display = "";
    $("#dashError").style.display = "none";
    renderRoundChips();
    selectRound(rounds[0].key);
    renderAllTime();
  }


  function renderRoundChips() {
    const row = $("#roundChipRow");
    row.innerHTML = "";
    rounds.forEach(rd => {
      const chip = document.createElement("button");
      chip.className = "round-chip" + (rd.key === selectedRoundKey ? " active" : "");
      chip.textContent = (rd.course || "Round") + " · " + rd.date.toLocaleDateString();
      chip.addEventListener("click", () => selectRound(rd.key));
      row.appendChild(chip);
    });
  }

  function renderClubDist(sel, dist) {
    const el = $(sel);
    const clubs = Object.keys(dist).sort((a, b) => dist[b].avg - dist[a].avg);
    if (clubs.length === 0) {
      el.innerHTML = '<div class="empty">No shots logged with GPS.</div>';
      return;
    }
    const maxAvg = Math.max(...clubs.map(c => dist[c].avg));
    el.innerHTML = clubs.map(c => {
      const d = dist[c];
      const cat = clubCategory(c);
      const pct = Math.max(6, Math.round((d.avg / maxAvg) * 100));
      return `<div class="dist-row">
        <div class="dist-bar" style="width:${pct}%; background:var(--cat-${cat})"></div>
        <div class="dist-row-content">
          <span class="name"><span class="dot" style="background:var(--cat-${cat})"></span>${c}</span>
          <span><span class="avg">${Math.round(d.avg)}y</span><span class="range">${Math.round(d.min)}–${Math.round(d.max)} · n=${d.count}</span></span>
        </div>
      </div>`;
    }).join("");
  }

  function renderHoleTable(stats) {
    const rows = stats.holesSet.map(h => {
      const ph = stats.perHole[h];
      return `<tr><td>${h}</td><td>${ph.strokes}</td><td>${ph.putts}</td></tr>`;
    }).join("");
    $("#rdHoleTable").innerHTML = `
      <tr><th>Hole</th><th>Strokes</th><th>Putts</th></tr>
      ${rows || '<tr><td colspan="3" class="empty">No holes logged.</td></tr>'}
      ${stats.holesSet.length ? `<tr class="tot"><td>Total</td><td>${stats.totalStrokes}</td><td>${stats.totalPutts}</td></tr>` : ""}
    `;
  }

  function selectRound(key) {
    selectedRoundKey = key;
    renderRoundChips();
    const rd = rounds.find(r => r.key === key);
    if (!rd) return;

    $("#rdCourse").textContent = rd.course || "Round";
    $("#rdDate").textContent = rd.date.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });

    const stats = computeRoundStats(rd.rows);
    $("#rdStrokes").textContent = stats.totalStrokes;
    $("#rdPutts").textContent = stats.totalPutts;
    $("#rdHoles").textContent = stats.holesPlayed;
    $("#rdPuttsHole").textContent = stats.holesPlayed ? (stats.totalPutts / stats.holesPlayed).toFixed(1) : "0.0";

    renderHoleTable(stats);
    renderClubDist("#rdClubDist", stats.clubDistances);

    selectedMapHole = "all";
    renderMapHoleChips(rd);
    updateShotMap(rd);
  }

  function renderAllTime() {
    const roundStats = rounds.map(rd => ({ rd, stats: computeRoundStats(rd.rows) }));
    const totalStrokes = roundStats.reduce((s, x) => s + x.stats.totalStrokes, 0);
    const totalPutts = roundStats.reduce((s, x) => s + x.stats.totalPutts, 0);
    const totalHoles = roundStats.reduce((s, x) => s + x.stats.holesPlayed, 0);

    $("#atRounds").textContent = rounds.length;
    $("#atStrokes").textContent = totalStrokes;
    $("#atPutts").textContent = totalPutts;
    $("#atPuttsHole").textContent = totalHoles ? (totalPutts / totalHoles).toFixed(1) : "0.0";

    // Trend: last 10 rounds, oldest-to-newest left to right
    const last10 = roundStats.slice(0, 10).slice().reverse();
    const strokesList = last10.map(x => x.stats.totalStrokes).filter(s => s > 0);
    const maxStrokes = Math.max(...strokesList, 1);
    const minStrokes = Math.min(...strokesList.length ? strokesList : [0]);
    const chart = $("#trendChart"); chart.innerHTML = "";
    const labels = $("#trendLabels"); labels.innerHTML = "";
    last10.forEach(x => {
      const s = x.stats.totalStrokes;
      const pct = s ? Math.max(8, Math.round((s / maxStrokes) * 100)) : 3;
      const isBest = s > 0 && s === minStrokes;
      const bar = document.createElement("div");
      bar.className = "trend-bar";
      bar.innerHTML = `<div class="fill${isBest ? " best" : ""}" style="height:${pct}%" title="${s} strokes"></div>`;
      chart.appendChild(bar);
      const lbl = document.createElement("span");
      lbl.textContent = x.rd.date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      labels.appendChild(lbl);
    });

    // Aggregate club distances across ALL rounds (concat raw yards, not average-of-averages)
    const allRaw = {};
    roundStats.forEach(x => {
      Object.keys(x.stats.clubDistances).forEach(c => {
        if (!allRaw[c]) allRaw[c] = [];
        allRaw[c] = allRaw[c].concat(x.stats.clubDistances[c].raw);
      });
    });
    const atDist = {};
    Object.keys(allRaw).forEach(c => {
      const arr = allRaw[c].slice().sort((a, b) => a - b);
      const sum = arr.reduce((a, b) => a + b, 0);
      atDist[c] = { count: arr.length, avg: sum / arr.length, min: arr[0], max: arr[arr.length - 1] };
    });
    renderClubDist("#atClubDist", atDist);

    // Rounds list
    const listEl = $("#atRoundsList");
    listEl.innerHTML = roundStats.map(x => `
      <div class="club-stat-row" data-key="${x.rd.key}" style="cursor:pointer;">
        <span class="name">${x.rd.course || "Round"}<br><span class="range">${x.rd.date.toLocaleDateString()}</span></span>
        <span><span class="avg">${x.stats.totalStrokes}</span><span class="range">${x.stats.totalPutts} putts</span></span>
      </div>
    `).join("") || '<div class="empty">No rounds yet.</div>';
    $$("#atRoundsList .club-stat-row").forEach(row => {
      row.addEventListener("click", () => { switchTab("round"); selectRound(row.dataset.key); });
    });
  }

  function switchTab(tab) {
    $$(".dash-tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
    $("#tab-round").style.display = tab === "round" ? "" : "none";
    $("#tab-alltime").style.display = tab === "alltime" ? "" : "none";
    if (tab === "round" && shotMapInstance) setTimeout(() => shotMapInstance.invalidateSize(), 50);
  }
  $$(".dash-tabs button").forEach(btn => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));

  // ---------------- Load flow ----------------
  function showUrlSetup() {
    $("#urlSetup").style.display = "";
    $("#dashContent").style.display = "none";
    $("#dashLoading").style.display = "none";
    $("#dashError").style.display = "none";
    $("#sheetsUrlInput").value = "";
  }

  $("#btnSaveUrl").addEventListener("click", () => {
    const url = $("#sheetsUrlInput").value.trim();
    if (!url) { toast("Enter the Apps Script URL"); return; }
    saveSettings({ ...getSettings(), sheetsUrl: url });
    loadData(url);
  });
  $("#btnRefresh").addEventListener("click", () => loadData(getSettings().sheetsUrl));
  $("#btnRetry").addEventListener("click", () => loadData(getSettings().sheetsUrl));

  async function loadData(url) {
    if (!url) { showUrlSetup(); return; }
    $("#urlSetup").style.display = "none";
    $("#dashContent").style.display = "none";
    $("#dashError").style.display = "none";
    $("#dashLoading").style.display = "";
    $("#syncPill").className = "sync-pill dot pending";
    $("#syncPill").textContent = "Loading";

    try {
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (data.status !== "ok") throw new Error(data.message || "Server error");

      allRows = normalizeRows(data.rows || []);
      $("#dashLoading").style.display = "none";

      const players = [...new Set(allRows.map(r => r.player))].sort();
      if (players.length === 0) {
        $("#dashError").style.display = "";
        $("#dashErrorMsg").textContent = "No rounds logged yet — play a round in the app first, then refresh here.";
        $("#syncPill").className = "sync-pill dot synced";
        $("#syncPill").textContent = "No data";
        return;
      }

      const localDefault = getLocalActivePlayerName();
      if (!selectedPlayer || !players.includes(selectedPlayer)) {
        selectedPlayer = (localDefault && players.includes(localDefault)) ? localDefault : players[0];
      }

      $("#lastUpdated").textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      $("#syncPill").className = "sync-pill dot synced";
      $("#syncPill").textContent = "Live";

      applyPlayerFilter();
    } catch (err) {
      $("#dashLoading").style.display = "none";
      $("#dashError").style.display = "";
      $("#dashErrorMsg").textContent = "Couldn't load data: " + err.message;
      $("#syncPill").className = "sync-pill dot offline";
      $("#syncPill").textContent = "Error";
    }
  }

  function init() {
    const settings = getSettings();
    loadData(settings.sheetsUrl);
  }

  if (localStorage.getItem(AUTH_KEY) === "true") {
    enterApp();
  } else {
    $("#loginPassword").focus();
  }
})();
