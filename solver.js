// مَسار — route order solver (TSP with fixed start, optional return to start)
// M: square cost matrix, index 0 = start point, 1..n = stops.
// Returns an array of stop indices (1..n) in the best order found.
(function (root) {
  function routeCost(M, r, roundtrip) {
    if (!r.length) return 0;
    let c = M[0][r[0]];
    for (let i = 0; i < r.length - 1; i++) c += M[r[i]][r[i + 1]];
    if (roundtrip) c += M[r[r.length - 1]][0];
    return c;
  }

  // Tiny seeded random so results are stable for the same input.
  function rng(seed) {
    let s = seed >>> 0 || 1;
    return function () {
      s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  function nearestNeighbor(M, n, rand, noise) {
    const left = new Set();
    for (let i = 1; i <= n; i++) left.add(i);
    const r = [];
    let cur = 0;
    while (left.size) {
      let best = -1, bestC = Infinity;
      for (const j of left) {
        const c = M[cur][j] * (1 + (noise ? rand() * noise : 0));
        if (c < bestC) { bestC = c; best = j; }
      }
      r.push(best); left.delete(best); cur = best;
    }
    return r;
  }

  function localSearch(M, r, roundtrip) {
    let best = routeCost(M, r, roundtrip);
    const n = r.length;
    let improved = true, guard = 0;
    while (improved && guard++ < 200) {
      improved = false;
      // 2-opt: reverse segment i..j
      for (let i = 0; i < n - 1; i++) {
        for (let j = i + 1; j < n; j++) {
          const t = r.slice(0, i).concat(r.slice(i, j + 1).reverse(), r.slice(j + 1));
          const c = routeCost(M, t, roundtrip);
          if (c < best - 1e-9) { r = t; best = c; improved = true; }
        }
      }
      // Or-opt: move a segment of 1..3 stops elsewhere
      for (let len = 1; len <= 3; len++) {
        for (let i = 0; i + len <= n; i++) {
          const seg = r.slice(i, i + len);
          const rest = r.slice(0, i).concat(r.slice(i + len));
          for (let k = 0; k <= rest.length; k++) {
            if (k === i) continue;
            for (const s of [seg, seg.slice().reverse()]) {
              const t = rest.slice(0, k).concat(s, rest.slice(k));
              const c = routeCost(M, t, roundtrip);
              if (c < best - 1e-9) { r = t; best = c; improved = true; break; }
            }
            if (improved) break;
          }
          if (improved) break;
        }
        if (improved) break;
      }
    }
    return { r, cost: best };
  }

  function permute(arr, fn) {
    const a = arr.slice(), c = new Array(a.length).fill(0);
    fn(a.slice());
    let i = 0;
    while (i < a.length) {
      if (c[i] < i) {
        const k = i % 2 ? c[i] : 0;
        [a[k], a[i]] = [a[i], a[k]];
        fn(a.slice()); c[i]++; i = 0;
      } else { c[i] = 0; i++; }
    }
  }

  function solve(M, roundtrip) {
    const n = M.length - 1;
    if (n <= 0) return [];
    if (n <= 8) { // exact for small rounds
      let best = null, bestC = Infinity;
      const base = []; for (let i = 1; i <= n; i++) base.push(i);
      permute(base, function (p) {
        const c = routeCost(M, p, roundtrip);
        if (c < bestC) { bestC = c; best = p; }
      });
      return best;
    }
    const rand = rng(12345 + n);
    let best = null, bestC = Infinity;
    const restarts = n > 25 ? 24 : 40;
    for (let k = 0; k < restarts; k++) {
      const start = nearestNeighbor(M, n, rand, k === 0 ? 0 : 0.6);
      const res = localSearch(M, start, roundtrip);
      if (res.cost < bestC) { bestC = res.cost; best = res.r; }
    }
    return best;
  }

  const api = { solve, routeCost };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MasarSolver = api;
})(this);
