/* =====================================================================
   2b. Deep analysis: stems + Beat This! grid, and the measured planner
   A .sangam.json (made by analysis/deep_analyse.py) holds loudness of the
   vocal / drum / bass / other stems every 50 ms, vocal lines, a sample-
   accurate beat grid, sections and harmony per bar. No audio.
   ===================================================================== */
const DEEP_LIB = (window.SANGAM_DEEP || []).slice();
const STEM_KEYS = ["vocals", "drums", "bass", "other"];
const SEC_MAP = { intro: "intro", outro: "outro", hook: "chorus", verse: "verse", breakdown: "break", instrumental: "break" };

function b64u8(s) { const bin = atob(s), a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
function u8db(s) { const u = b64u8(s), o = new Float32Array(u.length); for (let i = 0; i < u.length; i++) o[i] = u[i] / 2.5 - 90; return o; }
function u8unit(s) { const u = b64u8(s), o = new Float32Array(u.length); for (let i = 0; i < u.length; i++) o[i] = u[i] / 255; return o; }

function trackFromDeep(J, spBpm, key) {
  const D = { hz: J.stems.hz, mbeat: J.grid.beat, mbar0: J.grid.downbeat, lines: J.vocal.lines, blocks: J.vocal.blocks, sections: J.sections, landmarks: J.landmarks, fit: J.grid.fit };
  STEM_KEYS.concat("mix").forEach(k => { D[k] = u8db(J.stems[k]); });
  D.n = Math.min(...STEM_KEYS.map(k => D[k].length));
  D.mbars = J.bars.t0; D.boundary = J.bars.boundary;
  const ch = b64u8(J.bars.chroma); D.chroma = [];
  for (let i = 0; i < D.mbars.length; i++) { const v = Array.from(ch.slice(i * 12, i * 12 + 12), x => x / 255); const nn = Math.hypot(...v) || 1; D.chroma.push(v.map(x => x / nn)); }
  D.ref = {}; STEM_KEYS.forEach(k => { D.ref[k] = pct(D[k], 95); }); D.ref.vocals = J.vocal.ref_db;
  D.pow = {}; STEM_KEYS.forEach(k => { const a = D[k], p = new Float32Array(a.length); for (let i = 0; i < a.length; i++) p[i] = Math.pow(10, a[i] / 10); D.pow[k] = p; });
  D.tot = new Float32Array(D.n); for (let i = 0; i < D.n; i++) { let e = 0; STEM_KEYS.forEach(k => { e += D.pow[k][i]; }); D.tot[i] = 10 * Math.log10(e + 1e-12); }
  // frames inside a sung / rapped line (breath-split lines from the analyser)
  D.vact = new Uint8Array(D.n); D.lines.forEach(([a, b]) => { for (let i = Math.max(0, Math.floor(a * D.hz)); i < Math.min(D.n, Math.ceil(b * D.hz)); i++) D.vact[i] = 1; });
  // phrase lines: every section start, then every 4 musical bars (strong) / 2 bars (weak) inside it
  const mb = 4 * D.mbeat; D.strong = []; D.weak = [];
  J.sections.forEach(s => { for (let t = s.t0, k = 0; t < s.t1 - 0.1; t += mb, k++) (k % 4 === 0 ? D.strong : (k % 2 === 0 ? D.weak : [])).push(t); });
  // beat stops: musical bars where drums and 808/bass vanish while the vocal carries on
  D.stops = [];
  for (let i = 1; i + 1 < D.mbars.length; i++) {
    const a = Math.floor(D.mbars[i] * D.hz), b = Math.floor(D.mbars[i + 1] * D.hz);
    const med = (arr) => { const s = Array.from(arr.slice(a, b)).sort((x, y) => x - y); return s[s.length >> 1]; };
    const beatAt = (k) => { if (k < 0 || k + 1 >= D.mbars.length) return false; const a2 = Math.floor(D.mbars[k] * D.hz), b2 = Math.floor(D.mbars[k + 1] * D.hz); let s = 0; for (let q = a2; q < b2; q++) s += Math.pow(10, D.bass[q] / 10) + Math.pow(10, D.drums[q] / 10); return 10 * Math.log10(s / Math.max(1, b2 - a2)) > Math.max(D.ref.bass, D.ref.drums) - 12; };
    if (med(D.drums) < D.ref.drums - 25 && med(D.bass) < D.ref.bass - 25 && med(D.vocals) > D.ref.vocals - 12 && beatAt(i - 1) && (beatAt(i + 1) || beatAt(i + 2))) D.stops.push([D.mbars[i], D.mbars[i + 1]]);
  }
  const T = { name: J.name, duration: J.duration, spKey: key || (J.spotify && J.spotify.key) || "", deep: D, deepJ: J };
  T.env = { hz: J.env.hz, full: u8unit(J.env.full), low: u8unit(J.env.low), mid: u8unit(J.env.mid), high: u8unit(J.env.high) };
  T.soundStart = J.sound.start; T.soundEnd = J.sound.end;
  T.bpmDet = J.grid.bpm;
  T.spBpm = spBpm || (J.spotify && J.spotify.bpm) || defaultSpotifyBpm(J.grid.bpm);
  deepBars(T);
  return T;
}

// Spotify's bars come from Spotify's BPM; they sit on the real downbeats from Beat This!
function deepBars(T) {
  const D = T.deep, mb = D.mbeat, ps = 60 / T.spBpm, dur = T.duration;
  const r = Math.pow(2, Math.round(Math.log2(ps / mb)));
  T.beat = mb; T.beatsPerBar = Math.max(1, Math.round(4 * r)); T.bar_s = T.beatsPerBar * mb;
  const mPer = T.beatsPerBar / 4;
  let first = D.mbar0;
  if (mPer >= 2) { // a Spotify bar spans several real bars: line its starts up with the section changes
    const n = Math.round(mPer); let best = 0, bs = -1;
    for (let j = 0; j < n; j++) { let s = 0; for (let i = j; i < D.boundary.length; i += n) s += D.boundary[i]; if (s > bs + 1e-9) { bs = s; best = j; } }
    first = D.mbars[best];
  }
  while (first - T.bar_s > -1e-6) first -= T.bar_s;
  if (first < -0.05) first += T.bar_s;
  T.bar0 = Math.max(0, first); T.phase = T.bar0;
  const t0 = []; for (let t = T.bar0; t < dur - 0.25 * T.bar_s; t += T.bar_s) t0.push(t);
  T.n_bars = t0.length;
  const hz = D.hz;
  const dbMean = (arr, a, b) => { let s = 0, m = 0; for (let i = a; i < b && i < arr.length; i++) { s += Math.pow(10, arr[i] / 10); m++; } return 10 * Math.log10(s / Math.max(1, m) + 1e-12); };
  const raw = { e: [], lo: [], mi: [], dr: [], hi: [], vo: [] };
  t0.forEach(t => {
    const a = Math.floor(t * hz), b = Math.floor(Math.min(dur, t + T.bar_s) * hz);
    raw.e.push(dbMean(D.tot, a, b)); raw.lo.push(dbMean(D.bass, a, b)); raw.dr.push(dbMean(D.drums, a, b));
    raw.mi.push(Math.max(dbMean(D.vocals, a, b), dbMean(D.other, a, b)));
    let v = 0, m = 0; for (let i = a; i < b && i < D.vact.length; i++) { v += D.vact[i]; m++; } raw.vo.push(v / Math.max(1, m));
    const ea = Math.floor(t * T.env.hz), eb = Math.floor((t + T.bar_s) * T.env.hz); let h = 0, hm = 0; for (let i = ea; i < eb && i < T.env.high.length; i++) { h += T.env.high[i]; hm++; } raw.hi.push(h / Math.max(1, hm));
  });
  const act = (v) => { const p90 = pct(v, 90); return v.map(x => clamp((x - (p90 - 18)) / 12, 0, 1)); };
  const e5 = pct(raw.e, 5), e95 = pct(raw.e, 95), hmax = pct(raw.hi, 95) || 1;
  T.bars = { t0, energy: raw.e.map(x => clamp((x - e5) / (e95 - e5 + 1e-9), 0, 1)), bass: act(raw.lo), mids: act(raw.mi), drums: act(raw.dr), high: raw.hi.map(x => clamp(x / hmax, 0, 1)), vocals: raw.vo };
  const barOf = t => clamp(Math.round((t - T.bar0) / T.bar_s) + 1, 1, T.n_bars);
  T.sections = D.sections.map(s => ({ bar0: barOf(s.t0), bar1: Math.max(barOf(s.t0), barOf(s.t1) - 1), t0: s.t0, t1: s.t1, label: SEC_MAP[s.label] || "verse", name: s.label, energy: 0, mids: s.vocals, drums: 0, bass: 0 }));
  const di = D.landmarks.drums_in; T.drop = di != null && di > 1 ? barOf(di) : null;
}

/* ---- match a loaded audio file to a bundled / added analysis by its loudness fingerprint ---- */
function loudnessPrint(buffer, hz = 20) {
  const sr = buffer.sampleRate, ch = buffer.numberOfChannels, n = buffer.length, hop = Math.round(sr / hz), w = Math.round(0.1 * sr);
  const data = []; for (let c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
  const frames = Math.floor(n / hop) + 1, out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const a = Math.max(0, f * hop - (w >> 1)), b = Math.min(n, f * hop + (w >> 1)); let s = 0;
    for (let i = a; i < b; i += 2) { let v = 0; for (let c = 0; c < ch; c++) v += data[c][i]; v /= ch; s += v * v; }
    out[f] = 10 * Math.log10(s / Math.max(1, (b - a) / 2) + 1e-12);
  }
  return out;
}
function matchDeep(buffer) {
  const cands = DEEP_LIB.filter(J => Math.abs(J.duration - buffer.duration) < 1.0);
  if (!cands.length) return null;
  const fp = loudnessPrint(buffer);
  let best = null, bc = 0;
  cands.forEach(J => {
    const ref = u8db(J.stems.mix), n = Math.min(ref.length, fp.length) - 8;
    for (let off = -4; off <= 4; off++) {
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, m = 0;
      for (let i = 8; i < n; i += 2) { const x = Math.max(-70, ref[i]), y = Math.max(-70, fp[i + off] ?? -70); sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; m++; }
      const c = (sxy - sx * sy / m) / Math.sqrt((sxx - sx * sx / m) * (syy - sy * sy / m) + 1e-9);
      if (c > bc) { bc = c; best = J; }
    }
  });
  return bc > 0.9 ? best : null;
}

/* ---- the measured planner ---- */
const DEEP_SEEN = m => Object.keys(OPT[OPTKEY[m]]).filter(k => OPT[OPTKEY[m]][k].seen !== false);
const BAND_HZ = { low: 70, mid: 900, high: 6000 };

class DeepPair extends Pair {
  constructor(A, B) {
    super(A, B);
    this.deep = true; this.gcache = new Map(); this.acache = new Map();
    const CA = A.deep.chroma, CB = B.deep.chroma;
    this.cos = CA.map(a => CB.map(b => a.reduce((s, v, k) => s + v * b[k], 0)));
  }
  mbarIdx(T, t) { const D = T.deep; return clamp(Math.floor((t - D.mbars[0]) / (4 * D.mbeat)), 0, D.chroma.length - 1); }
  // per-frame gain (in dB and power) that each stem of each song gets from the volume, EQ and filter curves
  gains(s, L, N) {
    const key = `${MENUS.map(m => s[m]).join("|")}|${L}|${N}`;
    if (this.gcache.has(key)) return this.gcache.get(key);
    const ln = lanes(s, L), P = OPT.params, out = { A: {}, B: {} };
    ["A", "B"].forEach(lane => STEM_KEYS.forEach(k => { out[lane][k] = new Float32Array(N); out[lane][k + "P"] = new Float32Array(N); out[lane].vol = new Float32Array(N); }));
    for (let k = 0; k < N; k++) {
      const u = (k + 0.5) / N;
      ["A", "B"].forEach(lane => {
        const vol = lane === "A" ? ln.volA(u) : ln.volB(u), f = lane === "A" ? ln.fltA(u) : ln.fltB(u);
        const hp = f > 0 ? 10 * Math.pow(P.filter.hpf_max_hz / 10, f) : 0, lp = f < 0 ? 20000 * Math.pow(P.filter.lpf_min_hz / 20000, -f) : 1e9;
        const band = (b) => { const fr = BAND_HZ[b]; const hm = hp ? 1 / Math.sqrt(1 + Math.pow(hp / fr, 4)) : 1, lm = 1 / Math.sqrt(1 + Math.pow(fr / lp, 4)); return ln.eq(lane, b)(u) * hm * lm; };
        const lo = band("low"), mi = band("mid"), hi = band("high");
        const amp = { vocals: 0.8 * mi + 0.2 * hi, bass: lo, drums: 0.55 * lo + 0.45 * hi, other: 0.2 * lo + 0.55 * mi + 0.25 * hi };
        out[lane].vol[k] = vol;
        STEM_KEYS.forEach(st => { const a = vol * amp[st]; out[lane][st][k] = 20 * Math.log10(a + 1e-6); out[lane][st + "P"][k] = a * a; });
      });
    }
    if (this.gcache.size > 4000) this.gcache.clear();
    this.gcache.set(key, out); return out;
  }
  alignAt(T, t) {
    const D = T.deep, near = arr => arr.some(x => Math.abs(x - t) < 0.09);
    return near(D.strong) ? 1 : near(D.weak) ? 0.5 : 0;
  }
  // everything about a window position that doesn't depend on the menu settings (cached)
  align(p) {
    const key = `${p.a_start}|${p.b_start}|${p.L}`;
    let C = this.acache.get(key); if (C) return C;
    const A = this.A, B = this.B, DA = A.deep, DB = B.deep, hz = DA.hz;
    const tm = this.timing(p), N = Math.max(8, Math.round(tm.W * hz)), dt = tm.W / N;
    const I = new Int32Array(N), J = new Int32Array(N), cosv = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const tA = tm.aT0 + (k + 0.5) * dt, tB = tm.bT0 + (k + 0.5) * dt * this.rate;
      I[k] = Math.min(DA.n - 1, Math.max(0, Math.floor(tA * hz))); J[k] = Math.min(DB.n - 1, Math.max(0, Math.floor(tB * hz)));
      cosv[k] = this.cos[this.mbarIdx(A, tA)][this.mbarIdx(B, tB)];
    }
    const med = (D, t0, t1) => { const a = clamp(Math.floor(t0 * hz), 0, D.n - 1), b = clamp(Math.floor(t1 * hz), a + 1, D.n); const s = Array.from(D.tot.slice(a, b)).sort((x, y) => x - y); return s[s.length >> 1]; };
    const ph = { a0: this.alignAt(A, tm.aT0), a1: this.alignAt(A, tm.aT1), b0: this.alignAt(B, tm.bT0), b1: this.alignAt(B, tm.bT1) };
    const vsum = (D, t0, t1) => D.lines.reduce((s, [a, b]) => s + Math.max(0, Math.min(b, t1) - Math.max(a, t0)), 0);
    const aLine = DA.lines.filter(([a, b]) => b <= tm.aT0 + 0.3 * tm.W).pop(), bLine = DB.lines.find(([a]) => a >= tm.bT0 + 0.5 * tm.W * this.rate);
    const aGap = aLine ? tm.aT0 - aLine[1] : null, bGap = bLine ? bLine[0] - tm.bT1 : null;
    const bQuiet = !bLine || vsum(DB, tm.bT0, bLine[0]) < 0.4;
    C = { tm, N, dt, I, J, cosv, refA: med(DA, tm.aT0 - 4, tm.aT0), refB: med(DB, tm.bT1, tm.bT1 + 4), ph, phrase: (ph.a0 + ph.b0) * 0.35 + (ph.a1 + ph.b1) * 0.15,
      lostAVoc: vsum(DA, tm.aT1, A.duration), skipBVoc: vsum(DB, 0, tm.bT0), lostA: Math.max(0, A.soundEnd - tm.aT1), skipB: Math.max(0, tm.bT0 - B.soundStart),
      aLine, bLine, aGap, bGap, bQuiet, handover: (bQuiet && bGap != null && bGap > -0.6 && bGap < 2.5 ? 1 : 0) + (aGap != null && aGap > -0.6 && aGap < 2.5 ? 0.5 : 0) };
    if (this.acache.size > 20000) this.acache.clear();
    this.acache.set(key, C); return C;
  }
  evaluate(p) {
    const A = this.A, B = this.B, DA = A.deep, DB = B.deep, hz = DA.hz;
    const C = this.align(p), { tm, N, dt, I, J, cosv } = C, G = this.gains(p.settings, p.L, N);
    // audible = within 18 dB (vocals) / 10-12 dB (bass, drums, melody) of that stem's normal level in its own song
    const TA = { v: DA.ref.vocals - 18, b: DA.ref.bass - 10, d: DA.ref.drums - 12, o: DA.ref.other - 12 };
    const TB = { v: DB.ref.vocals - 18, b: DB.ref.bass - 10, d: DB.ref.drums - 12, o: DB.ref.other - 12 };
    const gAv = G.A.vocals, gBv = G.B.vocals, gAb = G.A.bass, gBb = G.B.bass, gAd = G.A.drums, gBd = G.B.drums, gAo = G.A.other, gBo = G.B.other;
    const pA = DA.pow, pB = DB.pow, qA = G.A, qB = G.B;
    let voc = 0, bass = 0, drums = 0, hw = 0, hc = 0, hclash = 0, firstK = -1;
    const lv = new Float32Array(N), audA = new Uint8Array(N), audB = new Uint8Array(N);
    for (let k = 0; k < N; k++) {
      const i = I[k], j = J[k];
      const va = DA.vocals[i] + gAv[k] - TA.v, vb = DB.vocals[j] + gBv[k] - TB.v;
      if (va > 0) audA[k] = 1; if (vb > 0) audB[k] = 1;
      if (va > 0 && vb > 0) { voc += dt * Math.min(1, Math.min(va, vb) / 10); if (firstK < 0) firstK = k; }
      const ba = DA.bass[i] + gAb[k] - TA.b, bb = DB.bass[j] + gBb[k] - TB.b;
      if (ba > 0 && bb > 0) bass += dt * Math.min(1, Math.min(ba, bb) / 6);
      const da = DA.drums[i] + gAd[k] - TA.d, db = DB.drums[j] + gBd[k] - TB.d;
      if (da > 0 && db > 0) drums += dt * Math.min(1, Math.min(da, db) / 6);
      const oa = Math.max(DA.other[i] + gAo[k] - TA.o, ba), ob = Math.max(DB.other[j] + gBo[k] - TB.o, bb);
      if (oa > 0 && ob > 0) { const w = dt * Math.min(1, Math.min(oa, ob) / 8), c = cosv[k]; hw += w; hc += w * c; if (c < 0.78) hclash += w * Math.min(1, (0.78 - c) / 0.3); }
      lv[k] = pA.vocals[i] * qA.vocalsP[k] + pA.drums[i] * qA.drumsP[k] + pA.bass[i] * qA.bassP[k] + pA.other[i] * qA.otherP[k]
            + pB.vocals[j] * qB.vocalsP[k] + pB.drums[j] * qB.drumsP[k] + pB.bass[j] * qB.bassP[k] + pB.other[j] * qB.otherP[k];
    }
    const firstOverlap = firstK >= 0 ? [tm.aT0 + (firstK + 0.5) * dt, tm.bT0 + (firstK + 0.5) * dt * this.rate] : null;
    // effect tail of A (echo / reverb keep sounding after the window) over B's vocal
    const fx = OPT.effects[p.settings.effect]; let tailVoc = 0;
    if (fx && fx.type && fx.tail === "out") {
      const iA = Math.min(DA.n - 1, Math.floor((tm.aT1 - 0.15) * hz)), wet = 20 * Math.log10(((OPT.params[fx.type] || {}).wet_max) || 0.5);
      const decay = fx.type === "reverb" ? 15 : -20 * Math.log10((OPT.params[fx.type] || {}).feedback || 0.5) / ((fx.beats || 0.5) * A.bar_s / 4); // dB per second
      for (let t = 0; t < 2.5; t += 1 / hz) {
        const j = Math.min(DB.n - 1, Math.floor((tm.bT1 + t) * hz));
        const va = DA.vocals[iA] + wet - decay * t - TA.v, vb = DB.vocals[j] - TB.v;
        if (va > 0 && vb > 0) tailVoc += Math.min(1, Math.min(va, vb) / 8) / hz;
      }
    }
    // loudness through the window vs. just before (A) and just after (B), 1 s smoothing
    const sw = Math.max(1, Math.round(hz)); let mn = 1e9, mx = -1e9, run = 0;
    for (let k = 0; k < N; k++) { run += lv[k]; if (k >= sw) run -= lv[k - sw]; if (k >= sw - 1) { const d = 10 * Math.log10(run / sw + 1e-12); if (d < mn) mn = d; if (d > mx) mx = d; } }
    if (mn > 1e8) { mn = mx = 10 * Math.log10(run / N + 1e-12); }
    const dip = Math.max(0, Math.min(C.refA, C.refB) - mn), bump = Math.max(0, mx - Math.max(C.refA, C.refB) - 3);
    // a vocal line cut mid-word: its song's gain falls fast (or the window ends) while the line keeps going
    const lineGoesOn = (D, t, dur) => { let s = 0, m = 0; for (let x = t; x < t + dur; x += 1 / hz) { const i = Math.floor(x * hz); if (i >= 0 && i < D.n) { s += D.vact[i]; m++; } } return m ? s / m > 0.7 : false; };
    const wq = Math.max(1, Math.round(0.3 * hz));
    let chopA = null, chopB = null;
    for (let k = 1; k < N && chopA == null; k++) if (audA[k - 1] && !audA[k] && G.A.vol[Math.max(0, k - wq)] > 4 * Math.max(1e-3, G.A.vol[k]) && lineGoesOn(DA, tm.aT0 + k * dt, 0.4)) chopA = tm.aT0 + k * dt;
    if (chopA == null && audA[N - 1] && G.A.vol[N - 1] > 0.05 && lineGoesOn(DA, tm.aT1, 0.4)) chopA = tm.aT1;
    // B's voice surfaces while its line is already running: a cut-in mid-word is worse than a fade-in
    let chopBFast = false;
    for (let k = 0; k < N && chopB == null; k++) {
      if (!(audB[k] && (k === 0 || !audB[k - 1]))) continue;
      const tB = tm.bT0 + k * dt * this.rate;
      const line = DB.lines.find(([la, lb]) => la <= tB && lb >= tB);
      if (!line) continue;
      if (DB.strong.concat(DB.weak).some(x => tB - x >= -0.1 && tB - x <= 0.4)) continue; // surfaces right on B's phrase line: a normal entry
      const fast = k === 0 || G.B.vol[Math.min(N - 1, k + wq)] > 4 * Math.max(1e-3, G.B.vol[Math.max(0, k - 1)]);
      if (tB - line[0] < (fast ? 0.5 : 1.5)) continue; // only the first word is soft: fine
      chopB = tB; chopBFast = fast;
    }
    const masked = chopA != null && fx && fx.type && fx.tail === "out" && chopA > tm.aT0 + 0.6 * tm.W;
    const tempoRisk = this.tempoGapPct > 3 ? drums : 0, unver = usesUnverified(p.settings);
    const m = { voc: voc + 0.7 * tailVoc, tailVoc, bass, drums, harm: hw > 0.75 ? hc / hw : null, hclash, dip, bump, refA: C.refA, refB: C.refB, ph: C.ph, phrase: C.phrase,
      chopA: masked ? null : chopA, chopMasked: masked ? chopA : null, chopB, chopBFast, lostAVoc: C.lostAVoc, skipBVoc: C.skipBVoc, lostA: C.lostA, skipB: C.skipB,
      aLine: C.aLine, bLine: C.bLine, aGap: C.aGap, bGap: C.bGap, bQuiet: C.bQuiet, handover: C.handover, firstOverlap };
    const cost = 2.5 * m.voc + 1.5 * bass + 0.6 * tempoRisk + 1.6 * hclash + 0.5 * Math.max(0, dip - 2) + 0.4 * bump + 4 * (1 - m.phrase)
      + (m.chopA != null ? 3 : 0) + (masked ? 0.8 : 0) + (chopB != null ? (chopBFast ? 2.5 : 0.3) : 0) + 0.08 * m.lostAVoc + 0.06 * m.skipBVoc + 0.012 * m.lostA + 0.006 * m.skipB
      - 0.8 * m.handover + (unver ? 2 : 0) + (this.key && this.key.kind === "clash" ? 0.3 * p.L : 0);
    const pass = m.voc <= 1.0 && bass <= 1.0 && m.chopA == null && !(chopB != null && chopBFast) && Math.min(m.ph.a0, m.ph.b0) >= 0.5 && dip <= 6;
    const score = 100 * Math.exp(-Math.max(0, cost) / 14);
    return { score, cost, pass, deep: true, m, terms: { vocal_clash: m.voc > 1 ? 1 : 0 }, bonus: {}, drag: m.lostA + m.skipB, preset: presetOf(p.settings) };
  }
  better(x, y) { return (x.pass !== y.pass) ? x.pass : x.cost < y.cost; }
  search() {
    const A = this.A, B = this.B, vols = DEEP_SEEN("volume"), eqs = DEEP_SEEN("eq");
    const lengths = [2, 4, 8].filter(L => (this.beatmatch || L <= 4) && L * A.bar_s <= 40);
    const base = { filter: "none", effect: "none", loop: "none" }, perAlign = [], spots = [];
    for (const L of lengths) for (let a = 1; a + L - 1 <= A.n_bars; a++) {
      const aT0 = A.bars.t0[a - 1], aT1 = aT0 + L * A.bar_s;
      if (aT1 < 0.45 * A.duration || aT0 > A.soundEnd - 1) continue;
      for (let b = 1; b + L - 1 <= B.n_bars; b++) {
        const bT0 = B.bars.t0[b - 1]; if (bT0 > Math.max(32, 0.3 * B.duration)) break;
        spots.push({ a_start: a, b_start: b, L });
      }
    }
    // windows that don't start on a phrase line in both songs can't pass, so only search them if nothing else exists
    let todo = spots.filter(p => { const ph = this.align(p).ph; return Math.min(ph.a0, ph.b0) >= 0.5; });
    if (todo.length < 30) todo = spots;
    for (const sp of todo) {
      let best = null;
      for (const v of vols) for (const q of eqs) { const p = { ...sp, settings: { volume: v, eq: q, ...base } }; p.eval = this.evaluate(p); if (!best || this.better(p.eval, best.eval)) best = p; }
      perAlign.push(best);
    }
    perAlign.sort((x, y) => (x.eval.pass !== y.eval.pass ? (x.eval.pass ? -1 : 1) : x.eval.cost - y.eval.cost));
    const seeds = perAlign.slice(0, 40);
    const all = Object.fromEntries(MENUS.map(m => [m, DEEP_SEEN(m)]));
    const refined = seeds.map(seed => {
      let cur = { ...seed, settings: { ...seed.settings } };
      for (let pass = 0; pass < 2; pass++) for (const m of ["filter", "effect", "volume", "eq"]) for (const opt of all[m]) {
        if (opt === cur.settings[m]) continue;
        const t = { ...cur, settings: { ...cur.settings, [m]: opt } }; t.eval = this.evaluate(t);
        if (this.better(t.eval, cur.eval) && (t.eval.pass !== cur.eval.pass || t.eval.cost < cur.eval.cost - 0.05)) cur = t;
      }
      return cur;
    });
    // one-tap presets on the same spots
    const presets = SEEN_PRESETS.map(k => Object.fromEntries(MENUS.map(m => [m, OPT.presets[k][m]])));
    const presetRes = [];
    seeds.forEach(seed => presets.forEach(s => { const p = { a_start: seed.a_start, b_start: seed.b_start, L: seed.L, settings: { ...s } }; p.eval = this.evaluate(p); presetRes.push(p); }));
    const sortP = arr => arr.sort((x, y) => (x.eval.pass !== y.eval.pass ? (x.eval.pass ? -1 : 1) : x.eval.cost - y.eval.cost));
    return { refined: sortP(refined), presetRes: sortP(presetRes), perAlign };
  }
  pickPlans() {
    const { refined: R, presetRes: PR, perAlign } = this.search();
    const plans = [], A = this.A;
    const keyOf = p => `${p.a_start}|${p.b_start}|${p.L}|${MENUS.map(m => p.settings[m]).join(",")}`;
    const add = (p, title, tag) => { if (!p) return; const key = keyOf(p); if (plans.some(q => q.key === key)) return; plans.push({ ...p, settings: { ...p.settings }, title, tag, key }); };
    const best = R[0]; add(best, "Best measured transition", "best");
    const bestPreset = PR[0];
    if (bestPreset) add(bestPreset, `One-tap preset: ${OPT.presets[presetOf(bestPreset.settings)].label}`, "preset");
    const far = p => { const t = this.timing(p), tb = this.timing(best); return Math.abs(t.aT0 - tb.aT0) >= 8 || Math.abs(t.bT0 - tb.bT0) >= 8; };
    add(R.find(p => far(p)), "Another good spot", "alt");
    const kept = R.find(p => p.eval.m.lostAVoc < 0.5 && !plans.some(q => q.key === keyOf(p)));
    if (best.eval.m.lostAVoc >= 0.5) add(kept, "Plays all of A's vocals", "keep");
    add(R.find(p => p.L === 8 && !plans.some(q => q.key === keyOf(p))), "Long blend (8 bars)", "blend");
    add(R.find(p => (p.L === 2 || p.settings.volume === "centre_cut") && !plans.some(q => q.key === keyOf(p))), "Quick switch", "slam");
    return plans.slice(0, 6);
  }
}

/* ---- words for the measured facts ---- */
function deepWhy(P, p) {
  const e = p.eval, m = e.m, tm = P.timing(p), out = [];
  const a = A_NAME(), b = B_NAME();
  out.push([m.voc > 1, m.voc < 0.25 ? `Voices never overlap: ${a} and ${b} never sing or rap at the same time${m.tailVoc > 0.05 ? " (only the echo tail touches)" : ""}.` : `Voices overlap for ${m.voc.toFixed(1)} s${m.firstOverlap ? ` (${a} at ${fmt(m.firstOverlap[0])} with ${b} at ${fmt(m.firstOverlap[1])})` : ""}.`]);
  out.push([m.bass > 1, m.bass < 0.3 ? `Only one bassline at a time.` : `Both basslines play together for ${m.bass.toFixed(1)} s.`]);
  if (m.harm != null) out.push([m.hclash > 1, m.harm >= 0.8 ? `Melodies and bass blend (${Math.round(m.harm * 100)} % harmonic match while both are audible).` : `Melodies and bass may rub (${Math.round(m.harm * 100)} % harmonic match), so keep the overlap short.`]);
  else out.push([0, `The two songs' melodies barely overlap, so harmony can't clash.`]);
  const phW = x => x === 1 ? "on a phrase line" : x === 0.5 ? "on a half-phrase" : "off the phrase";
  out.push([Math.min(m.ph.a0, m.ph.b0) < 0.5, `Window starts ${phW(m.ph.a0)} in ${a} and ${phW(m.ph.b0)} in ${b}; it ends ${phW(m.ph.a1)} / ${phW(m.ph.b1)}.`]);
  if (m.aLine && m.aGap != null && m.aGap > -0.6 && m.aGap < 6) out.push([0, `${a}'s line ends at ${fmt(m.aLine[1])}, ${m.aGap >= 0 ? `${m.aGap.toFixed(1)} s before` : `${(-m.aGap).toFixed(1)} s after`} the window opens.`]);
  if (m.bLine && m.bQuiet && m.bGap != null && m.bGap < 8) out.push([0, `${b}'s vocals come in at ${fmt(m.bLine[0])}, ${m.bGap >= 0 ? `${m.bGap.toFixed(1)} s after` : `${(-m.bGap).toFixed(1)} s before`} the window ends.`]);
  if (m.chopA != null) out.push([1, `${a}'s vocal gets cut mid-line at ${fmt(m.chopA)}.`]);
  if (m.chopMasked != null) out.push([0, `${a}'s last word at ${fmt(m.chopMasked)} is cut, but the echo/reverb tail carries it out.`]);
  if (m.chopB != null) out.push([m.chopBFast ? 1 : 0, m.chopBFast ? `${b} cuts in mid-line at ${fmt(m.chopB)}.` : `${b}'s voice rises in under the fade at ${fmt(m.chopB)}, part-way through a line.`]);
  out.push([m.dip > 6 || m.bump > 3, m.dip <= 3 && m.bump <= 1 ? `Loudness stays steady through the switch (lowest point ${m.dip.toFixed(1)} dB under the quieter song).` : m.dip > 3 ? `The mix dips ${m.dip.toFixed(1)} dB in the middle.` : `The mix gets ${m.bump.toFixed(1)} dB louder than either song.`]);
  if (m.lostA > 2) out.push([m.lostAVoc > 20, `Leaves ${fmt(m.lostA)} of ${a} unplayed${m.lostAVoc > 0.5 ? `, including ${Math.round(m.lostAVoc)} s of vocals` : " (no vocals in it)"}.`]);
  if (m.skipB > 2) out.push([m.skipBVoc > 15, `Starts ${b} ${fmt(tm.bT0)} in${m.skipBVoc > 0.5 ? `, skipping ${Math.round(m.skipBVoc)} s of its vocals` : ", skipping only the intro"}.`]);
  const kd = P.key; if (kd) out.push([kd.kind === "clash", kd.kind === "clash" ? `Spotify keys ${P.A.spKey} → ${P.B.spKey} clash.` : `Spotify keys ${P.A.spKey} → ${P.B.spKey} work together.`]);
  out.push([P.tempoGapPct > 8, `Tempos ${P.A.bpmDet.toFixed(1)} and ${P.B.bpmDet.toFixed(1)} BPM${P.tempoGapPct < 1 ? ": beats stay locked" : ` (${P.tempoGapPct.toFixed(1)} % apart)`}.`]);
  if (usesUnverified(p.settings)) out.push([1, `Uses a menu option whose exact curve isn't confirmed yet.`]);
  return out;
}
function deepMetrics(p) {
  const m = p.eval.m;
  const rows = [
    ["Voice overlap", `${m.voc.toFixed(1)} s`, m.voc <= 0.25 ? "good" : m.voc <= 1 ? "" : "bad"],
    ["Bass overlap", `${m.bass.toFixed(1)} s`, m.bass <= 0.3 ? "good" : m.bass <= 1 ? "" : "bad"],
    ["Harmony", m.harm == null ? "n/a" : `${Math.round(m.harm * 100)} %`, m.harm == null || m.harm >= 0.8 ? "good" : m.harm >= 0.65 ? "" : "bad"],
    ["Phrase fit", `${Math.round(m.phrase * 100)} %`, m.phrase >= 0.85 ? "good" : m.phrase >= 0.5 ? "" : "bad"],
    ["Loudness dip", `${m.dip.toFixed(1)} dB`, m.dip <= 3 ? "good" : m.dip <= 6 ? "" : "bad"],
    ["Cut lines", `${(m.chopA != null) + (m.chopB != null)}`, (m.chopA == null && m.chopB == null) ? "good" : "bad"],
  ];
  return rows.map(([n, v, k]) => `<div class="met ${k}"><span>${n}</span><b>${v}</b></div>`).join("");
}
