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

  // A club like a 7-iron gets hit both full-swing (approach shots) and as a
  // partial pitch/chip around the green — averaging both together produces a
  // meaningless blended number. Split on every proportional gap large enough
  // to mark a real change in shot type — not just the single biggest one,
  // since a versatile club (a wedge hit anywhere from a 20y pitch to a full
  // 125y shot) can have more than two natural distance groups. Whichever
  // cluster ends up with the longest shots is "full swing"; everything
  // shorter gets merged into one "short shots" bucket for display.
  const FULL_SWING_GAP_RATIO = 1.6;
  // Below this, it's not a real shot — GPS jitter or a mis-tap while
  // standing still, not an actual swing.
  const MIN_SHOT_YARDS = 3;
  function splitFullSwing(yards) {
    const arr = yards.slice().sort((a, b) => a - b);
    if (arr.length < 2) return { full: arr, short: [] };
    const splitPoints = [];
    for (let i = 0; i < arr.length - 1; i++) {
      if (arr[i + 1] / arr[i] >= FULL_SWING_GAP_RATIO) splitPoints.push(i);
    }
    if (splitPoints.length === 0) return { full: arr, short: [] };
    const clusters = [];
    let start = 0;
    splitPoints.forEach(idx => { clusters.push(arr.slice(start, idx + 1)); start = idx + 1; });
    clusters.push(arr.slice(start));
    const full = clusters[clusters.length - 1];
    const short = clusters.slice(0, -1).flat();
    return { full, short };
  }
  function summarize(arr) {
    if (!arr.length) return null;
    const sum = arr.reduce((a, b) => a + b, 0);
    return { count: arr.length, avg: sum / arr.length, min: arr[0], max: arr[arr.length - 1] };
  }

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
      strokes: r["Strokes"] !== "" && r["Strokes"] != null ? Number(r["Strokes"]) : null,
      par: r["Par"] !== "" && r["Par"] != null ? Number(r["Par"]) : null,
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
      // Prefer the explicit strokes override (penalty strokes, a missed
      // tee-shot log, etc.) when it was set; fall back to shots+putts.
      const strokes = (puttsRow && puttsRow.strokes != null) ? puttsRow.strokes : shots + putts;
      const par = puttsRow && puttsRow.par != null ? puttsRow.par : null;
      perHole[h] = { shots, putts, strokes, par };

      const posRows = holeRows.filter(r => (r.type === "Shot" || r.type === "Green") && r.lat != null && r.lon != null);
      for (let i = 0; i < posRows.length - 1; i++) {
        const cur = posRows[i], next = posRows[i + 1];
        if (cur.type !== "Shot" || !cur.club) continue;
        if ((cur.accuracy || 0) > 25 || (next.accuracy || 0) > 25) continue;
        const dMeters = haversine(cur, next);
        if (dMeters >= 2000) continue; // sanity cap, filters bad fixes
        const yards = toYards(dMeters);
        if (yards < MIN_SHOT_YARDS) continue; // noise/mis-tap, not a real shot
        if (!clubRaw[cur.club]) clubRaw[cur.club] = [];
        clubRaw[cur.club].push(yards);
      }

      // GIR (green in regulation): reached the green in (par - 2) shots or
      // fewer. Needs a Green marker logged for this hole to know when the
      // green was actually reached; can't be determined otherwise.
      let girHit = null, girClub = null;
      if (par != null && par - 2 >= 1) {
        const greenIdx = posRows.findIndex(r => r.type === "Green");
        if (greenIdx > 0) {
          const shotsToGreen = posRows.slice(0, greenIdx).filter(r => r.type === "Shot").length;
          girHit = shotsToGreen > 0 && shotsToGreen <= (par - 2);
          if (girHit) {
            const lastShot = posRows.slice(0, greenIdx).reverse().find(r => r.type === "Shot");
            girClub = lastShot ? lastShot.club : null;
          }
        }
      }
      perHole[h].girHit = girHit;
      perHole[h].girClub = girClub;
    });

    const totalStrokes = Object.values(perHole).reduce((s, h) => s + h.strokes, 0);
    const totalPutts = Object.values(perHole).reduce((s, h) => s + h.putts, 0);
    // vs Par — only counts holes where Par is actually known.
    const parHoles = Object.values(perHole).filter(h => h.par != null);
    const totalPar = parHoles.reduce((s, h) => s + h.par, 0);
    const strokesWithPar = parHoles.reduce((s, h) => s + h.strokes, 0);
    const scoreVsPar = parHoles.length > 0 ? strokesWithPar - totalPar : null;

    const clubDistances = {};
    Object.keys(clubRaw).forEach(c => {
      const yards = clubRaw[c];
      const { full, short } = splitFullSwing(yards);
      clubDistances[c] = { raw: yards, full: summarize(full), short: summarize(short) };
    });

    return { holesSet, perHole, totalStrokes, totalPutts, holesPlayed: holesSet.length, totalPar, scoreVsPar, clubDistances };
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
      chip.textContent = (rd.course || "Round") + " · " + rd.date.toLocaleDateString() + " " + rd.date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      chip.addEventListener("click", () => selectRound(rd.key));
      row.appendChild(chip);
    });
  }

  function renderClubDist(sel, dist) {
    const el = $(sel);
    const clubs = Object.keys(dist).sort((a, b) => {
      const av = dist[a].full ? dist[a].full.avg : dist[a].short.avg;
      const bv = dist[b].full ? dist[b].full.avg : dist[b].short.avg;
      return bv - av;
    });
    if (clubs.length === 0) {
      el.innerHTML = '<div class="empty">No shots logged with GPS.</div>';
      return;
    }
    const maxAvg = Math.max(...clubs.map(c => (dist[c].full || dist[c].short).avg));
    el.innerHTML = clubs.map(c => {
      const d = dist[c];
      const main = d.full || d.short;
      const mainLabel = d.full ? "" : " (short shots only)";
      const cat = clubCategory(c);
      const pct = Math.max(6, Math.round((main.avg / maxAvg) * 100));
      let html = `<div class="dist-row">
        <div class="dist-bar" style="width:${pct}%; background:var(--cat-${cat})"></div>
        <div class="dist-row-content">
          <span class="name"><span class="dot" style="background:var(--cat-${cat})"></span>${c}${mainLabel}</span>
          <span><span class="avg">${Math.round(main.avg)}y</span><span class="range">${Math.round(main.min)}–${Math.round(main.max)} · n=${main.count}</span></span>
        </div>
      </div>`;
      if (d.full && d.short) {
        html += `<div class="dist-row" style="padding-top:0; opacity:0.7;">
          <div class="dist-row-content">
            <span class="name" style="font-weight:400; font-size:12px; padding-left:16px;">↳ Short shots</span>
            <span><span class="range">${Math.round(d.short.avg)}y avg · n=${d.short.count}</span></span>
          </div>
        </div>`;
      }
      return html;
    }).join("");
  }

  function formatVsPar(n) {
    if (n == null) return "—";
    if (n === 0) return "E";
    return n > 0 ? "+" + n : String(n);
  }

  function scoreCellHtml(ph) {
    const dot = ph.girHit ? '<span class="sc-gir-dot" title="Green in regulation"></span>' : "";
    if (ph.par == null) return `<span class="sc-score-cell">${ph.strokes}${dot}</span>`;
    const diff = ph.strokes - ph.par;
    let cls = "";
    if (diff <= -2) cls = "sc-eagle";
    else if (diff === -1) cls = "sc-birdie";
    else if (diff === 1) cls = "sc-bogey";
    else if (diff >= 2) cls = "sc-double";
    return `<span class="sc-score-cell ${cls}">${ph.strokes}${dot}</span>`;
  }

  function renderScorecard(stats) {
    const holes = stats.holesSet;
    const holeHeader = holes.map(h => `<th>${h}</th>`).join("");
    const parRow = holes.map(h => `<td>${stats.perHole[h].par != null ? stats.perHole[h].par : "—"}</td>`).join("");
    const scoreRow = holes.map(h => `<td>${scoreCellHtml(stats.perHole[h])}</td>`).join("");
    const puttsRow = holes.map(h => `<td>${stats.perHole[h].putts}</td>`).join("");

    $("#scorecardTable").innerHTML = holes.length ? `
      <tr><th>Hole</th>${holeHeader}<th class="out-col">Out</th></tr>
      <tr><th>Par</th>${parRow}<td class="out-col">${stats.totalPar || "—"}</td></tr>
      <tr><th>Score</th>${scoreRow}<td class="out-col">${stats.totalStrokes}</td></tr>
      <tr><th>Putts</th>${puttsRow}<td class="out-col">${stats.totalPutts}</td></tr>
    ` : "";

    const girHoles = holes.filter(h => stats.perHole[h].girHit);
    const girList = $("#girClubList");
    if (girHoles.length === 0) {
      girList.innerHTML = '<div class="empty">No greens hit in regulation this round \u2014 or no Green marker was logged to detect it.</div>';
    } else {
      girList.innerHTML = girHoles.map(h => {
        const ph = stats.perHole[h];
        return `<div class="club-stat-row">
          <span class="name">Hole ${h} <span class="range">(Par ${ph.par})</span></span>
          <span class="avg">${ph.girClub || "—"}</span>
        </div>`;
      }).join("");
    }
  }

  function selectRound(key) {
    selectedRoundKey = key;
    renderRoundChips();
    const rd = rounds.find(r => r.key === key);
    if (!rd) return;

    $("#rdCourse").textContent = rd.course || "Round";
    $("#rdDate").textContent = rd.date.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" }) + " · " + rd.date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    const stats = computeRoundStats(rd.rows);
    $("#rdStrokes").textContent = stats.totalStrokes;
    $("#rdPutts").textContent = stats.totalPutts;
    $("#rdHoles").textContent = stats.holesPlayed;
    $("#rdVsPar").textContent = formatVsPar(stats.scoreVsPar);

    renderScorecard(stats);
    renderClubDist("#rdClubDist", stats.clubDistances);

    selectedMapHole = "all";
    renderMapHoleChips(rd);
    updateShotMap(rd);
  }

  // Aggregates GIR club data across every round, grouped by course then
  // hole — so it stays meaningful once more than one course is in the data,
  // rather than mixing different courses' holes together.
  function renderGirAllTime(roundStats) {
    const byCourseHole = {}; // "course|hole" -> { course, hole, par, clubs: {club: count} }
    roundStats.forEach(x => {
      const course = x.rd.course || "Round";
      x.stats.holesSet.forEach(h => {
        const ph = x.stats.perHole[h];
        if (!ph.girHit) return;
        const key = course + "|" + h;
        if (!byCourseHole[key]) byCourseHole[key] = { course, hole: h, par: ph.par, clubs: {} };
        const club = ph.girClub || "Unknown";
        byCourseHole[key].clubs[club] = (byCourseHole[key].clubs[club] || 0) + 1;
      });
    });

    const el = $("#atGirClubList");
    const entries = Object.values(byCourseHole);
    if (entries.length === 0) {
      el.innerHTML = '<div class="empty">No greens hit in regulation yet.</div>';
      return;
    }
    const byCourse = {};
    entries.forEach(e => { (byCourse[e.course] = byCourse[e.course] || []).push(e); });

    el.innerHTML = Object.keys(byCourse).map(course => {
      const holes = byCourse[course].sort((a, b) => a.hole - b.hole);
      const rows = holes.map(h => {
        const clubText = Object.entries(h.clubs)
          .sort((a, b) => b[1] - a[1])
          .map(([club, count]) => count > 1 ? `${club} (×${count})` : club)
          .join(", ");
        return `<div class="club-stat-row">
          <span class="name">Hole ${h.hole} <span class="range">(Par ${h.par})</span></span>
          <span class="avg" style="font-size:13px;">${clubText}</span>
        </div>`;
      }).join("");
      return `<div style="margin-bottom:14px;">
        <div class="field-label" style="margin-bottom:6px;">${course}</div>
        ${rows}
      </div>`;
    }).join("");
  }

  let selectedTrendClub = null;

  function renderClubTrend(roundStats) {
    // Which clubs have full-swing data in at least one round, oldest-to-newest.
    const chronological = roundStats.slice().reverse();
    const clubsWithData = {}; // club -> count of rounds with data
    chronological.forEach(x => {
      Object.keys(x.stats.clubDistances).forEach(c => {
        if (x.stats.clubDistances[c].full) clubsWithData[c] = (clubsWithData[c] || 0) + 1;
      });
    });
    const clubs = Object.keys(clubsWithData).sort((a, b) => clubsWithData[b] - clubsWithData[a]);

    const chipRow = $("#clubTrendChips");
    if (clubs.length === 0) {
      chipRow.innerHTML = "";
      $("#clubTrendChart").innerHTML = '<div class="empty" style="padding:20px 0;">No club distance data yet.</div>';
      $("#clubTrendLabels").innerHTML = "";
      return;
    }
    if (!selectedTrendClub || !clubs.includes(selectedTrendClub)) selectedTrendClub = clubs[0];

    chipRow.innerHTML = "";
    clubs.forEach(c => {
      const chip = document.createElement("button");
      chip.className = "round-chip" + (c === selectedTrendClub ? " active" : "");
      chip.textContent = c;
      chip.addEventListener("click", () => { selectedTrendClub = c; renderClubTrend(roundStats); });
      chipRow.appendChild(chip);
    });

    const points = chronological
      .map(x => ({ date: x.rd.date, avg: x.stats.clubDistances[selectedTrendClub]?.full?.avg }))
      .filter(p => p.avg != null)
      .slice(-10); // last 10 rounds with data for this club

    const chart = $("#clubTrendChart"); chart.innerHTML = "";
    const labels = $("#clubTrendLabels"); labels.innerHTML = "";
    const maxAvg = Math.max(...points.map(p => p.avg), 1);
    const cat = clubCategory(selectedTrendClub);
    points.forEach(p => {
      const pct = Math.max(8, Math.round((p.avg / maxAvg) * 100));
      const bar = document.createElement("div");
      bar.className = "trend-bar";
      bar.innerHTML = `<div class="fill" style="height:${pct}%; background:var(--cat-${cat})" title="${Math.round(p.avg)}y"></div>`;
      chart.appendChild(bar);
      const lbl = document.createElement("span");
      lbl.textContent = p.date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      labels.appendChild(lbl);
    });
  }

  function renderAllTime() {
    const roundStats = rounds.map(rd => ({ rd, stats: computeRoundStats(rd.rows) }));
    const totalStrokes = roundStats.reduce((s, x) => s + x.stats.totalStrokes, 0);
    const totalPutts = roundStats.reduce((s, x) => s + x.stats.totalPutts, 0);
    const parRounds = roundStats.filter(x => x.stats.scoreVsPar != null);
    const allVsPar = parRounds.length ? parRounds.reduce((s, x) => s + x.stats.scoreVsPar, 0) : null;

    $("#atRounds").textContent = rounds.length;
    $("#atStrokes").textContent = totalStrokes;
    $("#atPutts").textContent = totalPutts;
    $("#atVsPar").textContent = formatVsPar(allVsPar);

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

    // vs-Par trend — centered zero line, bars extend up (over par, red) or
    // down (under par, green). Only rounds with known Par data are shown.
    const vsParRounds = last10.filter(x => x.stats.scoreVsPar != null);
    const vpChart = $("#vsParTrendChart");
    vpChart.innerHTML = '<div class="trend-zero-line"></div>';
    const vpLabels = $("#vsParTrendLabels"); vpLabels.innerHTML = "";
    if (vsParRounds.length === 0) {
      vpChart.innerHTML += '<div class="empty" style="padding:20px 0;">No Par data yet.</div>';
    } else {
      const maxAbs = Math.max(...vsParRounds.map(x => Math.abs(x.stats.scoreVsPar)), 1);
      vsParRounds.forEach(x => {
        const v = x.stats.scoreVsPar;
        const pct = Math.max(6, Math.round((Math.abs(v) / maxAbs) * 48)); // half-height max (centered)
        const bar = document.createElement("div");
        bar.className = "trend-bar-centered";
        const cls = v === 0 ? "even" : (v > 0 ? "over" : "under");
        bar.innerHTML = `<div class="fill ${cls}" style="height:${pct}%" title="${formatVsPar(v)}"></div>`;
        vpChart.appendChild(bar);
        const lbl = document.createElement("span");
        lbl.textContent = x.rd.date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
        vpLabels.appendChild(lbl);
      });
    }

    renderClubTrend(roundStats);

    // Aggregate club distances across ALL rounds (concat raw yards, then
    // re-cluster on the combined set — more data can reveal a full/short
    // split that wasn't visible within any single round).
    const allRaw = {};
    roundStats.forEach(x => {
      Object.keys(x.stats.clubDistances).forEach(c => {
        if (!allRaw[c]) allRaw[c] = [];
        allRaw[c] = allRaw[c].concat(x.stats.clubDistances[c].raw);
      });
    });
    const atDist = {};
    Object.keys(allRaw).forEach(c => {
      const { full, short } = splitFullSwing(allRaw[c]);
      atDist[c] = { full: summarize(full), short: summarize(short) };
    });
    renderClubDist("#atClubDist", atDist);
    renderGirAllTime(roundStats);

    // Rounds list
    const listEl = $("#atRoundsList");
    listEl.innerHTML = roundStats.map(x => `
      <div class="club-stat-row" data-key="${x.rd.key}" style="cursor:pointer;">
        <span class="name">${x.rd.course || "Round"}<br><span class="range">${x.rd.date.toLocaleDateString()} ${x.rd.date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></span>
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
