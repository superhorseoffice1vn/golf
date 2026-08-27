// stats.js — pure calculations from local data. No network involved.

const Stats = (() => {
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

  function metersToYards(m) { return m * 1.09361; }

  // A club like a 7-iron gets hit both full-swing (approach shots) and as a
  // partial pitch/chip around the green — averaging both together produces a
  // meaningless blended number. Rather than treat short shots as statistical
  // "outliers" around one mean (they're not noise, they're a genuinely
  // different shot type), split on the largest proportional gap in the
  // sorted distances: full-swing and finesse shots for the same club are
  // normally many multiples apart, while natural full-swing variance from
  // wind/lie isn't. Below that gap threshold, treat it as one cohesive group.
  const FULL_SWING_GAP_RATIO = 1.6;

  function splitFullSwing(yards) {
    const arr = yards.slice().sort((a, b) => a - b);
    if (arr.length < 2) return { full: arr, short: [] };
    let splitIdx = -1, maxRatio = 1;
    for (let i = 0; i < arr.length - 1; i++) {
      const ratio = arr[i + 1] / arr[i];
      if (ratio > maxRatio) { maxRatio = ratio; splitIdx = i; }
    }
    if (maxRatio >= FULL_SWING_GAP_RATIO) {
      return { full: arr.slice(splitIdx + 1), short: arr.slice(0, splitIdx + 1) };
    }
    return { full: arr, short: [] };
  }

  function summarize(arr) {
    if (!arr.length) return null;
    const sum = arr.reduce((a, b) => a + b, 0);
    return { count: arr.length, avg: sum / arr.length, min: arr[0], max: arr[arr.length - 1] };
  }

  // Distance for a shot = distance from that shot's location to the NEXT
  // logged point in the same hole (next shot, or the green marker).
  // The final point in a hole (green marker, or last shot if no green
  // marker was logged) has no "next point" so it contributes no distance.
  function clubDistances(roundIds = null) {
    const rounds = roundIds ? roundIds : DB.getRounds().map(r => r.id);
    const byClub = {}; // club -> [distances in meters]

    rounds.forEach(roundId => {
      const holes = [...new Set(DB.entriesForRound(roundId).map(e => e.hole))];
      holes.forEach(hole => {
        const pts = DB.entriesForHole(roundId, hole).sort((a, b) => a.seq - b.seq);
        for (let i = 0; i < pts.length - 1; i++) {
          const cur = pts[i];
          const next = pts[i + 1];
          if (cur.type !== "Shot" || !cur.club) continue;
          // Skip pairs where either endpoint had a poor fix — a bad reading
          // at either end throws the calculated distance off badly.
          if (cur.accuracy > 25 || next.accuracy > 25) continue;
          const d = haversine(cur, next);
          if (d < 2000) { // sanity cap ~2200yd, filters bad GPS fixes
            if (!byClub[cur.club]) byClub[cur.club] = [];
            byClub[cur.club].push(d);
          }
        }
      });
    });

    const out = {};
    Object.keys(byClub).forEach(club => {
      const yards = byClub[club].map(metersToYards);
      const { full, short } = splitFullSwing(yards);
      out[club] = { full: summarize(full), short: summarize(short) };
    });
    return out;
  }

  function roundSummary(roundId) {
    const entries = DB.entriesForRound(roundId);
    const holeNums = [...new Set(entries.map(e => e.hole))];
    const holeSummaries = DB.holesForRound(roundId);
    const totalPutts = holeSummaries.reduce((s, h) => s + (h.putts || 0), 0);
    const totalShots = entries.filter(e => e.type === "Shot").length;
    // Prefer each hole's explicit strokes value (may have been manually
    // corrected — penalty strokes, a missed tee-shot log, etc.) over the
    // raw shots+putts count, falling back to that count when not set.
    const totalStrokes = holeSummaries.reduce((s, h) => {
      if (h.strokes != null) return s + h.strokes;
      const shotsThisHole = entries.filter(e => e.hole === h.hole && e.type === "Shot").length;
      return s + shotsThisHole + (h.putts || 0);
    }, 0);
    // vs Par — only counts holes where Par is actually known, so it's never
    // skewed by holes missing that data (e.g. logged before Par existed).
    let totalPar = 0, strokesWithPar = 0, holesWithPar = 0;
    holeSummaries.forEach(h => {
      if (h.par == null) return;
      const shotsThisHole = entries.filter(e => e.hole === h.hole && e.type === "Shot").length;
      const strokesThisHole = h.strokes != null ? h.strokes : shotsThisHole + (h.putts || 0);
      totalPar += h.par;
      strokesWithPar += strokesThisHole;
      holesWithPar++;
    });
    const scoreVsPar = holesWithPar > 0 ? strokesWithPar - totalPar : null;
    const clubCounts = {};
    entries.forEach(e => {
      if (e.type === "Shot" && e.club) clubCounts[e.club] = (clubCounts[e.club] || 0) + 1;
    });
    return {
      holesPlayed: holeNums.length,
      totalStrokes,
      totalShots,
      totalPutts,
      puttsPerHole: holeSummaries.length ? totalPutts / holeSummaries.length : 0,
      totalPar, holesWithPar, scoreVsPar,
      clubCounts
    };
  }

  function allTimeSummary() {
    const rounds = DB.getRounds();
    let strokes = 0, putts = 0, shots = 0, holes = 0;
    let totalPar = 0, strokesWithPar = 0, holesWithPar = 0;
    rounds.forEach(r => {
      const s = roundSummary(r.id);
      strokes += s.totalStrokes; putts += s.totalPutts; shots += s.totalShots; holes += s.holesPlayed;
      totalPar += s.totalPar; holesWithPar += s.holesWithPar;
      if (s.scoreVsPar != null) strokesWithPar += s.totalPar + s.scoreVsPar; // = strokes on par-known holes
    });
    return {
      rounds: rounds.length,
      totalStrokes: strokes,
      totalPutts: putts,
      totalShots: shots,
      puttsPerHole: holes ? putts / holes : 0,
      scoreVsPar: holesWithPar > 0 ? strokesWithPar - totalPar : null
    };
  }

  return { haversine, metersToYards, clubDistances, roundSummary, allTimeSummary };
})();
