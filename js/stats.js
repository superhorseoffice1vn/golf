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
      const arr = byClub[club].map(metersToYards).sort((a, b) => a - b);
      const sum = arr.reduce((a, b) => a + b, 0);
      out[club] = {
        count: arr.length,
        avg: sum / arr.length,
        min: arr[0],
        max: arr[arr.length - 1],
        median: arr[Math.floor(arr.length / 2)]
      };
    });
    return out;
  }

  function roundSummary(roundId) {
    const entries = DB.entriesForRound(roundId);
    const holeNums = [...new Set(entries.map(e => e.hole))];
    const holeSummaries = DB.holesForRound(roundId);
    const totalPutts = holeSummaries.reduce((s, h) => s + (h.putts || 0), 0);
    const totalShots = entries.filter(e => e.type === "Shot").length;
    const clubCounts = {};
    entries.forEach(e => {
      if (e.type === "Shot" && e.club) clubCounts[e.club] = (clubCounts[e.club] || 0) + 1;
    });
    return {
      holesPlayed: holeNums.length,
      totalStrokes: totalShots + totalPutts,
      totalShots,
      totalPutts,
      puttsPerHole: holeSummaries.length ? totalPutts / holeSummaries.length : 0,
      clubCounts
    };
  }

  function allTimeSummary() {
    const rounds = DB.getRounds();
    let strokes = 0, putts = 0, shots = 0, holes = 0;
    rounds.forEach(r => {
      const s = roundSummary(r.id);
      strokes += s.totalStrokes; putts += s.totalPutts; shots += s.totalShots; holes += s.holesPlayed;
    });
    return {
      rounds: rounds.length,
      totalStrokes: strokes,
      totalPutts: putts,
      totalShots: shots,
      puttsPerHole: holes ? putts / holes : 0
    };
  }

  return { haversine, metersToYards, clubDistances, roundSummary, allTimeSummary };
})();
