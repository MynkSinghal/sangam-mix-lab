/* Sangam Mix Lab: analyse any two songs in the browser and plan a Spotify Mix transition.
   Everything runs locally; audio never leaves the device. */
"use strict";
const OPT = window.SANGAM_OPTIONS;
const DEMO = window.SANGAM_DEMO || null;
const $ = (s, r = document) => r.querySelector(s);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const fmt = (t) => { if (!isFinite(t)) return "–"; const s = Math.max(0, t); const m = Math.floor(s / 60); return `${m}:${(s - 60 * m).toFixed(1).padStart(4, "0")}`; };
const EASE = { linear: x => x, smoothstep: x => x * x * (3 - 2 * x), equal_power: x => Math.sin(x * Math.PI / 2), step: x => (x >= 1 ? 1 : 0) };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round(p / 100 * (s.length - 1))))]; };

/* =====================================================================
   1. Analysis
   ===================================================================== */
const AN_SR = 11025, HOP = 110, FPS = AN_SR / HOP;

async function renderBands(buffer) {
  const len = Math.ceil(buffer.duration * AN_SR);
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const c = new OAC(4, len, AN_SR);
  const src = c.createBufferSource(); src.buffer = buffer;
  const mono = c.createGain(); mono.channelCount = 1; mono.channelCountMode = "explicit"; mono.channelInterpretation = "speakers";
  src.connect(mono);
  const merger = c.createChannelMerger(4);
  const bq = (type, f) => { const b = c.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = Math.SQRT1_2; return b; };
  const route = (nodes, ch) => { let p = mono; nodes.forEach(n => { p.connect(n); p = n; }); p.connect(merger, 0, ch); };
  route([], 0);
  route([bq("lowpass", 200), bq("lowpass", 200)], 1);
  route([bq("highpass", 200), bq("highpass", 200), bq("lowpass", 2500), bq("lowpass", 2500)], 2);
  route([bq("highpass", 2500), bq("highpass", 2500)], 3);
  merger.connect(c.destination);
  src.start();
  const out = await c.startRendering();
  return [0, 1, 2, 3].map(i => out.getChannelData(i));
}

function frameStats(sig) {
  const n = Math.floor(sig.length / HOP), rms = new Float32Array(n), peak = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, p = 0; const o = i * HOP;
    for (let k = 0; k < HOP; k++) { const v = sig[o + k]; s += v * v; const a = v < 0 ? -v : v; if (a > p) p = a; }
    rms[i] = Math.sqrt(s / HOP); peak[i] = p;
  }
  return { rms, peak };
}
function posDiffLog(rms, gain = 100) {
  const n = rms.length, d = new Float32Array(n); let prev = Math.log1p(gain * rms[0]);
  for (let i = 1; i < n; i++) { const c = Math.log1p(gain * rms[i]); d[i] = Math.max(0, c - prev); prev = c; }
  return d;
}
function smoothDetrend(x, win) {
  const n = x.length, out = new Float32Array(n), cs = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + x[i];
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - win), b = Math.min(n, i + win + 1); out[i] = Math.max(0, x[i] - (cs[b] - cs[a]) / (b - a)); }
  return out;
}
// Spectral flux (log-magnitude, positive differences) at the analysis frame rate.
function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}
function spectralFlux(sig, nFrames) {
  const N = 1024, half = N / 2, win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const re = new Float64Array(N), im = new Float64Array(N), prev = new Float32Array(half), out = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const c = f * HOP + HOP / 2 - N / 2;
    for (let i = 0; i < N; i++) { const k = c + i; re[i] = (k >= 0 && k < sig.length ? sig[k] : 0) * win[i]; im[i] = 0; }
    fftInPlace(re, im);
    let s = 0;
    for (let b = 1; b < half; b++) { const m = Math.log1p(100 * Math.hypot(re[b], im[b])); const d = m - prev[b]; if (d > 0) s += d; prev[b] = m; }
    out[f] = f ? s : 0;
  }
  return out;
}
const interp = (arr, f) => { if (f < 0 || f >= arr.length - 1) return 0; const i = f | 0, r = f - i; return arr[i] * (1 - r) + arr[i + 1] * r; };

function estimateTempo(od, spBpm) {
  const n = od.length, mean = od.reduce((a, b) => a + b, 0) / n;
  const x = Float32Array.from(od, v => v - mean);
  const ac = (lag) => { const l0 = Math.floor(lag), r = lag - l0; let s0 = 0, s1 = 0; for (let i = 0; i + l0 + 1 < n; i++) { s0 += x[i] * x[i + l0]; s1 += x[i] * x[i + l0 + 1]; } return (s0 * (1 - r) + s1 * r) / (n - l0); };
  let best = null;
  if (spBpm) {
    for (const k of [0.5, 1, 2]) {
      const bpm = spBpm * k; if (bpm < 55 || bpm > 190) continue;
      const lag = 60 * FPS / bpm; let bl = lag, bv = -1e9;
      for (let d = -0.03; d <= 0.03; d += 0.003) { const v = ac(lag * (1 + d)); if (v > bv) { bv = v; bl = lag * (1 + d); } }
      if (!best || bv > best.v) best = { v: bv, lag: bl };
    }
  }
  if (!best) {
    for (let lag = 60 * FPS / 185; lag <= 60 * FPS / 58; lag += 0.25) {
      const bpm = 60 * FPS / lag, prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.8, 2));
      const v = ac(lag) * prior; if (!best || v > best.v) best = { v, lag };
    }
  }
  return 60 / (best.lag / FPS); // bpm
}

function fitGrid(od, bpm) {
  const p0 = 60 / bpm, dur = od.length / FPS;
  let best = { s: -1, p: p0, ph: 0 };
  for (let k = -25; k <= 25; k++) {
    const p = p0 * (1 + k * 0.0004);
    for (let ph = 0; ph < p; ph += 0.005) {
      let s = 0, m = 0;
      for (let t = ph; t < dur; t += p) { s += interp(od, t * FPS); m++; }
      s /= m; if (s > best.s) best = { s, p, ph };
    }
  }
  return best;
}

async function analyseTrack(buffer, name, spBpm, key, onStep = () => {}) {
  onStep("Splitting bass, mids and highs…");
  const [full, low, mid, high] = await renderBands(buffer);
  onStep("Finding the beat…");
  const F = frameStats(full), Lo = frameStats(low), Mi = frameStats(mid), Hi = frameStats(high);
  // Band-energy onsets (10 ms frames) give tighter beat timing than an FFT flux with a long window.
  const dF = posDiffLog(F.rms), dL = posDiffLog(Lo.rms), dM = posDiffLog(Mi.rms), dH = posDiffLog(Hi.rms);
  const odRaw = new Float32Array(F.rms.length);
  for (let i = 0; i < odRaw.length; i++) odRaw[i] = 0.4 * dF[i] + 1.0 * dL[i] + 0.6 * dM[i] + 0.8 * dH[i];
  const od = smoothDetrend(odRaw, Math.round(0.5 * FPS));
  const lowOd = smoothDetrend(dL, Math.round(0.5 * FPS));
  const highOd = smoothDetrend(dH, Math.round(0.5 * FPS));
  const bpm = estimateTempo(od, spBpm);
  const grid = fitGrid(od, bpm);
  const T = { name, duration: buffer.duration, spKey: key || "", od, lowOd, highOd };
  T.env = makeEnv(F, Lo, Mi, Hi);
  T.raw = { F, Lo, Mi, Hi };
  T.beat = grid.p; T.bpmDet = 60 / grid.p; T.phase = grid.ph;
  T.spBpm = spBpm || defaultSpotifyBpm(T.bpmDet);
  onStep("Mapping bars and sections…");
  buildBars(T);
  return T;
}
function defaultSpotifyBpm(b) { let x = b; while (x > 150) x /= 2; while (x < 70) x *= 2; return Math.round(x); }

function makeEnv(F, Lo, Mi, Hi) {
  // peak envelopes at 50 Hz for drawing, normalised per track
  const step = 2, n = Math.floor(F.peak.length / step);
  const pick = (a) => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = Math.max(a[i * step], a[i * step + 1]); return o; };
  const lo = pick(Lo.peak), mi = pick(Mi.peak), hi = pick(Hi.peak), fu = pick(F.peak);
  const norm = (a) => { const m = pct(a, 99.5) || 1; return Float32Array.from(a, v => Math.min(1, v / m)); };
  return { hz: FPS / step, low: norm(lo), mid: norm(mi), high: norm(hi), full: norm(fu) };
}

function buildBars(T) {
  const { F, Lo, Mi, Hi } = T.raw;
  const sp = 60 / T.spBpm;
  const nb = Math.max(1, Math.round(4 * sp / T.beat));
  T.beatsPerBar = nb; T.bar_s = nb * T.beat;
  const dur = T.duration;
  // downbeat: which beat inside a bar carries the strongest low-end hits
  let bestOff = 0, bestS = -1;
  for (let off = 0; off < nb; off++) {
    let s = 0, m = 0;
    for (let t = T.phase + off * T.beat; t < dur; t += T.bar_s) { s += interp(T.lowOd, t * FPS) + 0.3 * interp(T.od, t * FPS); m++; }
    s /= Math.max(1, m); if (s > bestS) { bestS = s; bestOff = off; }
  }
  let bar0 = T.phase + bestOff * T.beat;
  while (bar0 - T.bar_s >= -0.05) bar0 -= T.bar_s;
  T.bar0 = Math.max(0, bar0);
  const t0 = []; for (let t = T.bar0; t < dur - 0.25 * T.bar_s; t += T.bar_s) t0.push(t);
  T.n_bars = t0.length;
  const db = (arr, a, b) => { let s = 0, m = 0; for (let i = a; i < b && i < arr.length; i++) { s += arr[i] * arr[i]; m++; } return 10 * Math.log10(s / Math.max(1, m) + 1e-12); };
  const odMean = (arr, a, b) => { let s = 0, m = 0; for (let i = a; i < b && i < arr.length; i++) { s += arr[i]; m++; } return s / Math.max(1, m); };
  const raw = { e: [], lo: [], mi: [], hi: [], dr: [] };
  t0.forEach((t, i) => {
    const a = Math.floor(t * FPS), b = Math.floor(Math.min(dur, t + T.bar_s) * FPS);
    raw.e.push(db(F.rms, a, b)); raw.lo.push(db(Lo.rms, a, b)); raw.mi.push(db(Mi.rms, a, b)); raw.hi.push(db(Hi.rms, a, b));
    raw.dr.push(odMean(T.lowOd, a, b) + odMean(T.highOd, a, b)); // kicks + hats, not vocals
  });
  const act = (v) => { const p90 = pct(v, 90); return v.map(x => clamp((x - (p90 - 18)) / 12, 0, 1)); };
  const e5 = pct(raw.e, 5), e95 = pct(raw.e, 95);
  const drMax = pct(raw.dr, 90) || 1;
  T.bars = {
    t0, energy: raw.e.map(x => clamp((x - e5) / (e95 - e5 + 1e-9), 0, 1)),
    bass: act(raw.lo), mids: act(raw.mi), high: act(raw.hi),
    drums: raw.dr.map(x => clamp(x / drMax, 0, 1)),
  };
  // silence-aware: bars below -45 dB of the loudest bar count as empty
  const eMax = Math.max(...raw.e);
  raw.e.forEach((x, i) => { if (x < eMax - 45) { T.bars.energy[i] = 0; T.bars.bass[i] = 0; T.bars.mids[i] = 0; T.bars.high[i] = 0; T.bars.drums[i] = 0; } });
  // sound start / end (frames above -40 dB of max)
  const thr = Math.max(...F.rms) * Math.pow(10, -24 / 20);
  let s0 = 0; while (s0 < F.rms.length && F.rms[s0] < thr) s0++;
  let s1 = F.rms.length - 1; while (s1 > 0 && F.rms[s1] < thr) s1--;
  T.soundStart = s0 / FPS; T.soundEnd = (s1 + 1) / FPS;
  T.sections = segment(T);
  T.drop = findDrop(T);
}

function segment(T) {
  const B = T.bars, n = T.n_bars;
  const keys = ["energy", "bass", "mids", "high", "drums"];
  const X = []; for (let i = 0; i < n; i++) X.push(keys.map(k => B[k][i]));
  const mu = keys.map((_, j) => X.reduce((s, r) => s + r[j], 0) / n);
  const sd = keys.map((_, j) => Math.sqrt(X.reduce((s, r) => s + (r[j] - mu[j]) ** 2, 0) / n) + 1e-6);
  const Z = X.map(r => r.map((v, j) => (v - mu[j]) / sd[j]));
  const D = (i, j) => Math.sqrt(Z[i].reduce((s, v, k) => s + (v - Z[j][k]) ** 2, 0));
  const all = []; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) all.push(D(i, j));
  const med = pct(all, 50) || 1;
  const S = (i, j) => Math.exp(-D(i, j) / med);
  const k = 4, nov = new Array(n).fill(0);
  for (let i = k; i < n - k; i++) {
    let s = 0;
    for (let a = i - k; a < i + k; a++) for (let b = i - k; b < i + k; b++) s += ((a < i) === (b < i) ? 1 : -1) * S(a, b);
    nov[i] = Math.max(0, s);
  }
  const thr = pct(nov.filter(v => v > 0), 60) || 0;
  const cand = []; for (let i = 2; i < n - 2; i++) if (nov[i] >= nov[i - 1] && nov[i] >= nov[i + 1] && nov[i] > thr) cand.push(i);
  cand.sort((a, b) => nov[b] - nov[a]);
  const bounds = [0]; cand.forEach(c => { if (bounds.every(b => Math.abs(c - b) >= 4)) bounds.push(c); });
  bounds.sort((a, b) => a - b); bounds.push(n);
  const secs = [];
  for (let s = 0; s + 1 < bounds.length; s++) {
    const a = bounds[s], b = bounds[s + 1]; if (b <= a) continue;
    const avg = (key) => { let x = 0; for (let i = a; i < b; i++) x += B[key][i]; return x / (b - a); };
    secs.push({ bar0: a + 1, bar1: b, t0: B.t0[a], t1: b < n ? B.t0[b] : T.duration, energy: avg("energy"), mids: avg("mids"), drums: avg("drums"), bass: avg("bass") });
  }
  const en = secs.map(s => s.energy), med2 = pct(en, 50), p66 = pct(en, 66), p33 = pct(en, 33);
  secs.forEach((s, j) => {
    if (j === 0 && (s.energy < med2 || s.drums < 0.4)) s.label = "intro";
    else if (j === secs.length - 1 && (s.energy < med2 || s.drums < 0.4)) s.label = "outro";
    else if (s.energy >= p66 && s.mids > 0.5) s.label = "chorus";
    else if (s.energy <= p33 || s.drums < 0.35) s.label = "break";
    else s.label = "verse";
  });
  return secs;
}
function findDrop(T) {
  const e = T.bars.energy, d = T.bars.drums;
  for (let i = 2; i < Math.min(18, T.n_bars); i++) { if (e[i] - (e[i - 1] + e[i - 2]) / 2 > 0.12 && d[i] > 0.5 && d[i] - (d[i - 1] + d[i - 2]) / 2 > 0.3) return i + 1; }
  return null;
}

/* =====================================================================
   2. Curves, scoring and search
   ===================================================================== */
function resolveU(u, L) { if (typeof u === "string") { if (u.startsWith("end-")) return 1 - parseFloat(u.slice(4)) / L; if (u.startsWith("start+")) return parseFloat(u.slice(6)) / L; } return +u; }
function curveAt(points, u, L, def) {
  if (!points || !points.length) return def;
  const pts = points.map(p => [resolveU(p[0], L), +p[1], p[2] || "linear"]);
  if (u <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) { const [u0, v0] = pts[i - 1], [u1, v1, e] = pts[i]; if (u <= u1) { if (u1 <= u0) return v1; return v0 + (v1 - v0) * EASE[e]((u - u0) / (u1 - u0)); } }
  return pts[pts.length - 1][1];
}
function lanes(s, L) {
  const vol = OPT.volume[s.volume], eq = OPT.eq[s.eq], fl = OPT.filter[s.filter], fx = OPT.effects[s.effect];
  return {
    volA: u => curveAt(vol.A, u, L, 1), volB: u => curveAt(vol.B, u, L, 1),
    eq: (lane, band) => u => curveAt((eq[lane] || {})[band], u, L, 1),
    fltA: u => curveAt(fl.A, u, L, 0), fltB: u => curveAt(fl.B, u, L, 0),
    fx: u => curveAt(fx.wet, u, L, 0), fxDef: fx,
  };
}
const MENUS = ["volume", "eq", "filter", "effect", "loop"];
const OPTKEY = { volume: "volume", eq: "eq", filter: "filter", effect: "effects", loop: "loop" };
const SEEN_PRESETS = Object.entries(OPT.presets).filter(([k, p]) => p.seen && p.volume).map(([k]) => k);
const FAMILY = { fade: "fade", rise: "rise", blend: "blend", wave: "blend", melt: "blend", slam: "slam", dissolve: "tail", afterglow: "tail" };
function presetOf(s) { for (const k of SEEN_PRESETS) { const p = OPT.presets[k]; if (MENUS.every(m => p[m] === s[m])) return k; } return null; }
function nearestPreset(s) { let best = SEEN_PRESETS[0], bd = 9; SEEN_PRESETS.forEach(k => { const p = OPT.presets[k]; const d = MENUS.filter(m => p[m] !== s[m]).length; if (d < bd) { bd = d; best = k; } }); return best; }
const usesUnverified = s => MENUS.some(m => OPT[OPTKEY[m]][s[m]] && OPT[OPTKEY[m]][s[m]].seen === false);

const W = { mud: 0.20, vocal_clash: 0.20, phrase_misalign: 0.12, section_fit: 0.10, tempo_risk: 0.10, key_risk: 0.08, loud_bump: 0.06, energy_hole: 0.06, arc_fit: 0.08, skip_end: 0.08, skip_intro: 0.03 };
const MAX_RAW = 1 + 0.16; // 1 + sum of bonus weights, so scores spread over 0-100 instead of piling up at 100
const V = { drop_landing: 0.08, similarity: 0.04, effect_fit: 0.04 };
const SEC_A = { outro: 0, break: 0.1, intro: 0.6, verse: 0.4, chorus: 0.9 };
const SEC_B = { intro: 0, break: 0.3, verse: 0.4, chorus: 0.5, outro: 0.9 };

function camelotDist(a, b) {
  const p = k => { const m = /^(1[0-2]|[1-9])([AB])$/i.exec((k || "").trim()); return m ? [+m[1], m[2].toUpperCase()] : null; };
  const x = p(a), y = p(b); if (!x || !y) return null;
  const dn = ((y[0] - x[0]) % 12 + 12) % 12, cw = Math.min(dn, 12 - dn);
  if (x[0] === y[0] && x[1] === y[1]) return { kind: "same", risk: 0 };
  if (x[0] === y[0]) return { kind: "relative", risk: 0.1 };
  if (x[1] === y[1] && cw === 1) return { kind: "neighbour", risk: 0.1 };
  if (x[1] === y[1] && dn === 2) return { kind: "boost", risk: 0.3 };
  return { kind: "clash", risk: 1 };
}

class Pair {
  constructor(A, B) {
    this.A = A; this.B = B;
    this.rate = B.bar_s / A.bar_s;
    this.beatmatch = Math.abs(this.rate - 1) <= 0.08;
    if (!this.beatmatch) this.rate = 1;
    this.tempoGapPct = Math.abs(Math.log((60 / A.beat) / (60 / B.beat) * Math.pow(2, Math.round(Math.log2((60 / B.beat) / (60 / A.beat)))))) * 100;
    this.tempoGapPct = Math.abs((A.bar_s / B.bar_s) - 1) * 100;
    this.key = camelotDist(A.spKey, B.spKey);
    this.labA = this.labels(A); this.labB = this.labels(B);
    this.phrA = this.phraseStarts(A); this.phrB = this.phraseStarts(B);
  }
  labels(T) { const lab = new Array(T.n_bars).fill("verse"); T.sections.forEach(s => { for (let b = s.bar0; b <= s.bar1; b++) lab[b - 1] = s.label; }); return lab; }
  phraseStarts(T) { const st = []; T.sections.forEach(s => { for (let x = s.bar0; x <= s.bar1; x += 4) st.push(x); }); return st; }
  timing(p) {
    const A = this.A, B = this.B;
    const aT0 = A.bar0 + (p.a_start - 1) * A.bar_s, Wd = p.L * A.bar_s, bT0 = B.bar0 + (p.b_start - 1) * B.bar_s;
    return { aT0, aT1: aT0 + Wd, bT0, bT1: bT0 + Wd * this.rate, W: Wd };
  }
  evaluate(p) {
    const { A, B } = this, s = p.settings, L = p.L, pa = Math.round(p.a_start), pb = Math.round(p.b_start), n = 16 * L, ln = lanes(s, L);
    const preset = presetOf(s);
    const series = (T, key, b0) => { const v = T.bars[key], out = new Float64Array(n); for (let k = 0; k < n; k++) { const idx = b0 - 1 + (k + 0.5) / n * L; out[k] = v[clamp(Math.floor(idx), 0, v.length - 1)] || 0; } return out; };
    const vA = series(A, "mids", pa), vB = series(B, "mids", pb);
    const bA = series(A, "bass", pa), bB = series(B, "bass", pb);
    const eA = series(A, "energy", pa), eB = series(B, "energy", pb);
    const t = {};
    let mud = 0, vc = 0, both = 0, maxTot = -1, minEff = 9, key = 0;
    const tailOut = ln.fxDef && ln.fxDef.tail === "out" ? 1 : 0;
    const kr = this.key ? this.key.risk : 0;
    for (let k = 0; k < n; k++) {
      const u = (k + 0.5) / n, gA = ln.volA(u), gB = ln.volB(u), wet = ln.fx(u);
      const fa = ln.fltA(u), fb = ln.fltB(u);
      const band = f => { const hp = clamp(f, 0, 1), lp = clamp(-f, 0, 1); return [1 - hp, 1 - 0.6 * lp - 0.3 * hp * hp]; };
      const [faL, faM] = band(fa), [fbL, fbM] = band(fb);
      const lowA = gA * ln.eq("A", "low")(u) * faL, lowB = gB * ln.eq("B", "low")(u) * fbL;
      const midA = gA * ln.eq("A", "mid")(u) * faM * (1 - 0.5 * wet), midB = gB * ln.eq("B", "mid")(u) * fbM;
      mud += Math.min(bA[k] * lowA, bB[k] * lowB);
      vc += (vA[k] * midA) * (vB[k] * midB);
      if (gA > 0.3 && gB > 0.3) both++;
      const tot = gA * eA[k] + gB * eB[k]; maxTot = Math.max(maxTot, tot); minEff = Math.min(minEff, tot + 0.25 * wet * tailOut);
      key += Math.min(midA, midB);
    }
    t.mud = mud / n * 2; t.vocal_clash = vc / n * 1.5;
    const pd = (st, bar) => st.reduce((m, x) => Math.min(m, Math.abs(bar - x)), 99);
    t.phrase_misalign = Math.min(1, (pd(this.phrA, pa) + 0.5 * pd(this.phrA, pa + L) + pd(this.phrB, pb) + 0.5 * pd(this.phrB, pb + L)) / 4);
    let sa = 0, sb = 0; for (let k = 0; k < L; k++) { sa += SEC_A[this.labA[clamp(pa - 1 + k, 0, A.n_bars - 1)]] ?? 0.5; sb += SEC_B[this.labB[clamp(pb - 1 + k, 0, B.n_bars - 1)]] ?? 0.5; }
    sa /= L; sb /= L; if (preset === "slam" || s.volume === "centre_cut") sb *= 0.3;
    t.section_fit = (sa + sb) / 2;
    t.tempo_risk = Math.min(1, this.tempoGapPct / 10 * (both / n) * L / 8);
    t.key_risk = kr * key / n;
    t.loud_bump = clamp(maxTot - 1.15, 0, 1);
    const preA = A.bars.energy[Math.max(0, pa - 2)], postB = B.bars.energy[Math.min(B.n_bars - 1, pb - 1 + L)];
    t.energy_hole = Math.max(0, 0.6 * Math.min(preA, Math.max(postB, 0.4)) - minEff) / 0.6;
    let eout = 0; for (let k = 0; k < L; k++) eout += A.bars.energy[clamp(pa - 1 + k, 0, A.n_bars - 1)]; eout /= L;
    t.arc_fit = Math.min(1, Math.abs(postB - eout));
    const tm = this.timing(p);
    const skipEnd = Math.max(0, A.soundEnd - tm.aT1), skipIntro = Math.max(0, tm.bT0 - B.soundStart);
    const drag = skipEnd + skipIntro;
    t.skip_end = Math.min(1, skipEnd / 60);     // cutting the outgoing song early loses its ending
    t.skip_intro = Math.min(1, skipIntro / 60); // skipping into the next song is common, so it costs less
    const bon = {};
    const endBar = (preset === "slam" || s.volume === "centre_cut") ? pb + L / 2 : pb + L;
    bon.drop_landing = B.drop ? 1 - Math.min(1, Math.abs(B.drop - endBar) / 2) : 0;
    let sim = 0; const ks = ["energy", "bass", "mids", "high", "drums"];
    for (let k = 0; k < L; k++) ks.forEach(key2 => { sim += 1 - Math.abs((A.bars[key2][clamp(pa - 1 + k, 0, A.n_bars - 1)] || 0) - (B.bars[key2][clamp(pb - 1 + k, 0, B.n_bars - 1)] || 0)); });
    bon.similarity = sim / (L * ks.length);
    bon.effect_fit = (s.effect !== "none" && (t.energy_hole > 0.1 || kr >= 1 || this.tempoGapPct > 10)) ? 1 : 0;
    let sc = 1; for (const k in W) sc -= W[k] * t[k]; for (const k in V) sc += V[k] * bon[k];
    return { score: 100 * clamp(sc / MAX_RAW, 0, 1), terms: t, bonus: bon, drag, preset };
  }
  search(lengths = [2, 4, 8]) {
    const { A, B } = this;
    const presetSet = SEEN_PRESETS.map(k => { const p = OPT.presets[k]; return Object.fromEntries(MENUS.map(m => [m, p[m]])); });
    const res = [];
    const aLastBar = A.n_bars;
    for (const L of lengths) {
      if (!this.beatmatch && L > 4) continue;
      if (this.tempoGapPct > 10 && L > 4) continue;
      for (let a = 1; a + L - 1 <= aLastBar; a++) {
        const tEnd = A.bars.t0[a - 1] + L * A.bar_s;
        if (tEnd < A.soundEnd - 48 || A.bars.t0[a - 1] > A.soundEnd) continue;
        for (let b = 1; b <= Math.min(16, B.n_bars - L); b++) {
          for (const s of presetSet) {
            const p = { a_start: a, b_start: b, L, settings: { ...s } };
            p.eval = this.evaluate(p); res.push(p);
          }
        }
      }
    }
    res.sort((x, y) => y.eval.score - x.eval.score);
    // refine the strongest alignments with every menu option (custom transitions)
    const seenAlign = new Set(), seeds = [];
    for (const p of res) { const k = `${p.a_start}|${p.b_start}|${p.L}`; if (!seenAlign.has(k)) { seenAlign.add(k); seeds.push(p); } if (seeds.length >= 10) break; }
    const custom = seeds.map(seed => {
      let cur = { ...seed, settings: { ...seed.settings } };
      for (let pass = 0; pass < 2; pass++) for (const m of MENUS) {
        for (const opt of Object.keys(OPT[OPTKEY[m]])) {
          if (opt === cur.settings[m]) continue;
          const tryP = { ...cur, settings: { ...cur.settings, [m]: opt } }; tryP.eval = this.evaluate(tryP);
          if (tryP.eval.score > cur.eval.score + 0.05) cur = tryP;
        }
      }
      return cur;
    });
    return { presetResults: res, custom };
  }
  pickPlans() {
    const { presetResults: R, custom } = this.search();
    const plans = [];
    const add = (p, title, tag) => { if (!p) return; const key = `${p.a_start}|${p.b_start}|${p.L}|${MENUS.map(m => p.settings[m]).join(",")}`; if (plans.some(q => q.key === key)) return; plans.push({ ...p, settings: { ...p.settings }, title, tag, key }); };
    const bestCustom = [...custom].sort((x, y) => y.eval.score - x.eval.score)[0];
    const bestPreset = R[0];
    if (bestCustom && bestCustom.eval.score > bestPreset.eval.score + 0.3) add(bestCustom, "Best overall (custom settings)", "best");
    add(bestPreset, `Best preset: ${OPT.presets[presetOf(bestPreset.settings)].label}`, plans.length ? "preset" : "best");
    const fams = [["slam", "Hard cut"], ["rise", "Build-up"], ["blend", "Long blend"], ["tail", "Echo or reverb tail"], ["fade", "Simple fade"]];
    fams.forEach(([f, label]) => { const p = R.find(r => FAMILY[presetOf(r.settings)] === f && r !== bestPreset); if (p) add(p, `${label}: ${OPT.presets[presetOf(p.settings)].label}`, f); });
    const safe = R.find(r => r.eval.drag <= 4.5); if (safe) add(safe, `No repositioning: ${OPT.presets[presetOf(safe.settings)].label}`, "safe");
    return plans;
  }
}

/*DEEP*/

/* =====================================================================
   3. Audio rendering
   ===================================================================== */
let ctx = null, unlocked = false;
function getCtx() {
  if (!ctx) { try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch (e) {} ctx = new (window.AudioContext || window.webkitAudioContext)(); }
  return ctx;
}
function unlockAudio() {
  const c = getCtx(); try { c.resume(); } catch (e) {}
  if (!unlocked) { try { const b = c.createBuffer(1, 1, c.sampleRate), s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0); unlocked = true; } catch (e) {} }
}
["pointerdown", "touchend", "keydown", "click"].forEach(ev => document.addEventListener(ev, unlockAudio, { capture: true, passive: true }));
const decode = (c, ab) => new Promise((res, rej) => { const p = c.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); });
function automate(param, values, t0, dur, before, after) {
  const n = values.length, step = Math.max(1, Math.floor(n / 96));
  param.setValueAtTime(before, 0);
  param.setValueAtTime(values[0], t0);
  for (let i = step; i < n - 1; i += step) param.linearRampToValueAtTime(values[i], t0 + dur * i / (n - 1));
  param.linearRampToValueAtTime(values[n - 1], t0 + dur);
  if (after !== undefined) param.setValueAtTime(after, t0 + dur + 0.01);
}
const sampleCurve = (fn, n, map = v => v) => { const a = new Float32Array(n); for (let k = 0; k < n; k++) a[k] = map(fn(k / (n - 1))); return a; };
function chain(c, src, lane, ln, t0, Wd, n, safe) {
  if (safe) { const pass = c.createGain(); src.connect(pass); const vol = c.createGain(), vv = sampleCurve(lane === "A" ? ln.volA : ln.volB, n); automate(vol.gain, vv, t0, Wd, vv[0]); pass.connect(vol); return { post: pass, out: vol }; }
  const P = OPT.params, sum = c.createGain();
  const bq = (type, f) => { const b = c.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = Math.SQRT1_2; return b; };
  const bands = {
    low: [bq("lowpass", P.eq.low_xover_hz), bq("lowpass", P.eq.low_xover_hz)],
    mid: [bq("highpass", P.eq.low_xover_hz), bq("highpass", P.eq.low_xover_hz), bq("lowpass", P.eq.high_xover_hz), bq("lowpass", P.eq.high_xover_hz)],
    high: [bq("highpass", P.eq.high_xover_hz), bq("highpass", P.eq.high_xover_hz)],
  };
  for (const [band, nodes] of Object.entries(bands)) {
    let prev = src; nodes.forEach(nd => { prev.connect(nd); prev = nd; });
    const gn = c.createGain(); prev.connect(gn); gn.connect(sum);
    const vals = sampleCurve(ln.eq(lane, band), n); automate(gn.gain, vals, t0, Wd, vals[0]);
  }
  const hp = c.createBiquadFilter(); hp.type = "highpass"; hp.Q.value = 0.9;
  const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 0.9;
  const fl = lane === "A" ? ln.fltA : ln.fltB;
  const hpV = sampleCurve(fl, n, f => 10 * Math.pow(P.filter.hpf_max_hz / 10, Math.max(0, f)));
  const lpV = sampleCurve(fl, n, f => 20000 * Math.pow(P.filter.lpf_min_hz / 20000, Math.max(0, -f)));
  automate(hp.frequency, hpV, t0, Wd, hpV[0]); automate(lp.frequency, lpV, t0, Wd, lpV[0]);
  sum.connect(hp); hp.connect(lp);
  const vol = c.createGain(), vv = sampleCurve(lane === "A" ? ln.volA : ln.volB, n);
  automate(vol.gain, vv, t0, Wd, vv[0]); lp.connect(vol);
  return { post: lp, out: vol };
}
function makeImpulse(c, seconds) {
  const len = Math.floor(c.sampleRate * seconds), ir = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-6.9 * i / len); }
  return ir;
}
function attachFx(c, from, ln, t0, Wd, master, beatA) {
  const fx = ln.fxDef, P = OPT.params; if (!fx || !fx.type) return;
  const send = c.createGain(); from.connect(send);
  const wetMax = (P[fx.type] || {}).wet_max ?? 0.5;
  automate(send.gain, sampleCurve(ln.fx, 128, v => v * wetMax), t0, Wd, 0, 0);
  const ret = c.createGain(); ret.gain.value = 1;
  if (fx.type === "reverb") { const conv = c.createConvolver(); conv.buffer = makeImpulse(c, P.reverb.tail_s); send.connect(conv); conv.connect(ret); }
  else { const d = c.createDelay(4); d.delayTime.value = (fx.beats || 0.5) * beatA; const fb = c.createGain(); fb.gain.value = (P[fx.type] || {}).feedback ?? 0.5; send.connect(d); d.connect(fb); fb.connect(d); d.connect(ret); }
  if (fx.tail === "cut") { ret.gain.setValueAtTime(1, 0); ret.gain.setValueAtTime(1, t0 + Wd - 0.02); ret.gain.linearRampToValueAtTime(0, t0 + Wd); }
  ret.connect(master);
}
async function renderTransition(pair, plan, bufA, bufB, lead, safe = false) {
  const c0 = getCtx(), sr = c0.sampleRate, A = pair.A;
  const tm = pair.timing(plan), s = plan.settings, ln = lanes(s, plan.L);
  const pre = lead, post = 8, tail = 3, total = pre + tm.W + post + tail;
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const c = new OAC(2, Math.ceil(total * sr), sr);
  const n = Math.max(128, plan.L * 64);
  const master = c.createGain(); master.gain.value = 0.8;
  const lim = c.createDynamicsCompressor(); lim.threshold.value = -6; lim.knee.value = 6; lim.ratio.value = 12; lim.attack.value = 0.003; lim.release.value = 0.15;
  master.connect(lim); lim.connect(c.destination);
  const beatA = A.bar_s / 4;
  const srcA = c.createBufferSource(); srcA.buffer = bufA;
  const chA = chain(c, srcA, "A", ln, pre, tm.W, n, safe); chA.out.connect(master);
  srcA.start(Math.max(0, pre - tm.aT0), Math.max(0, tm.aT0 - pre));
  const loopDef = OPT.loop[s.loop];
  if (loopDef && loopDef.beats) {
    srcA.stop(pre);
    const lp = c.createBufferSource(); lp.buffer = bufA; lp.loop = true; lp.loopStart = tm.aT0; lp.loopEnd = tm.aT0 + loopDef.beats * beatA;
    const chL = chain(c, lp, "A", ln, pre, tm.W, n, safe); chL.out.connect(master);
    lp.start(pre, tm.aT0); lp.stop(pre + tm.W + 0.02);
    attachFx(c, chL.post, ln, pre, tm.W, master, beatA);
  } else { srcA.stop(pre + tm.W + 0.05); attachFx(c, chA.post, ln, pre, tm.W, master, beatA); }
  const srcB = c.createBufferSource(); srcB.buffer = bufB; srcB.playbackRate.value = pair.rate;
  const chB = chain(c, srcB, "B", ln, pre, tm.W, n, safe); chB.out.connect(master);
  const bOff0 = tm.bT0 - pre * pair.rate;
  if (bOff0 >= 0) srcB.start(0, bOff0); else srcB.start(-bOff0 / pair.rate, 0);
  const out = await c.startRendering();
  let peak = 0; for (let ch = 0; ch < 2; ch++) { const d = out.getChannelData(ch); for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; } }
  if (peak < 1e-4 && !safe) return renderTransition(pair, plan, bufA, bufB, lead, true); // this browser rendered silence: retry with volume curves only
  const g = peak > 0 ? 0.891 / peak : 1; for (let ch = 0; ch < 2; ch++) { const d = out.getChannelData(ch); for (let i = 0; i < d.length; i++) d[i] *= g; }
  return { buffer: out, pre, W: tm.W, tm };
}
function wavBlob(buf) {
  const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate, out = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); out.setUint32(4, 36 + len * ch * 2, true); w(8, "WAVE"); w(12, "fmt "); out.setUint32(16, 16, true); out.setUint16(20, 1, true);
  out.setUint16(22, ch, true); out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
  w(36, "data"); out.setUint32(40, len * ch * 2, true);
  const data = []; for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  let o = 44; for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) { const v = clamp(data[c][i], -1, 1); out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2; }
  return new Blob([out], { type: "audio/wav" });
}

/* =====================================================================
   4. App state
   ===================================================================== */
const state = {
  slots: { A: { file: null, buffer: null, track: null, spBpm: "", key: "" }, B: { file: null, buffer: null, track: null, spBpm: "", key: "" } },
  pair: null, plans: [], cur: null, edit: null, demo: false, playing: null, raf: null, playheadT: null,
};

function trackFromDemo(d) {
  const T = { ...d };
  T.env = { hz: d.env.hz, low: Float32Array.from(d.env.low), mid: Float32Array.from(d.env.mid), high: Float32Array.from(d.env.high), full: Float32Array.from(d.env.full) };
  return T;
}
function exportTrack(T) { // compact, no audio: used to build the bundled example
  const r3 = a => Array.from(a, v => Math.round(v * 1000) / 1000);
  return { name: T.name, duration: T.duration, spKey: T.spKey, spBpm: T.spBpm, beat: T.beat, bpmDet: T.bpmDet, phase: T.phase, beatsPerBar: T.beatsPerBar, bar_s: T.bar_s, bar0: T.bar0, n_bars: T.n_bars,
    bars: Object.fromEntries(Object.entries(T.bars).map(([k, v]) => [k, r3(v)])), soundStart: T.soundStart, soundEnd: T.soundEnd, sections: T.sections, drop: T.drop,
    env: { hz: T.env.hz, low: r3(T.env.low), mid: r3(T.env.mid), high: r3(T.env.high), full: r3(T.env.full) } };
}
window.__sangamExport = () => ({ A: exportTrack(state.slots.A.track), B: exportTrack(state.slots.B.track) });

function setStatus(t) { $("#status").textContent = t; }
function toast(t) { $("#toast").textContent = t; }

async function addAnalyses(files) {
  let n = 0;
  for (const f of files) {
    try { const J = JSON.parse(await f.text()); if (J && J.schema === "sangam-analysis/1") { const i = DEEP_LIB.findIndex(x => x.name === J.name && Math.abs(x.duration - J.duration) < 0.5); if (i >= 0) DEEP_LIB[i] = J; else DEEP_LIB.push(J); n++; } } catch (e) {}
  }
  if (!n) { setStatus("That isn't a Sangam analysis file (.sangam.json)."); return 0; }
  let hit = 0;
  ["A", "B"].forEach(k => { const sl = state.slots[k]; if (sl.buffer && !sl.deepJ) { const J = matchDeep(sl.buffer); if (J) { sl.deepJ = J; sl.track = null; hit++; } } });
  setStatus(`Added ${n} analysis file${n > 1 ? "s" : ""}${hit ? `, matched ${hit} loaded song${hit > 1 ? "s" : ""}` : ". Now load the songs they belong to"}.`);
  if (hit) await analyseLoaded();
  return n;
}
async function handleFiles(list, target) {
  const jsons = [...list].filter(f => /\.json$/i.test(f.name));
  if (jsons.length) await addAnalyses(jsons);
  const files = [...list].filter(f => !/\.json$/i.test(f.name) && /audio|m4a|mp3|wav|aac|flac|ogg/i.test(f.type + f.name));
  if (!files.length) { if (!jsons.length) setStatus("Those don't look like audio files. Pick .m4a or .mp3 songs."); return; }
  const c = getCtx();
  const targets = target ? [target] : (files.length >= 2 ? ["A", "B"] : [!state.slots.A.buffer || state.demo ? "A" : "B"]);
  if (state.demo) exitDemo();
  for (let i = 0; i < Math.min(files.length, targets.length); i++) {
    const slot = state.slots[targets[i]], f = files[i];
    setStatus(`Reading ${f.name}…`);
    try { slot.buffer = await decode(c, await f.arrayBuffer()); slot.file = f; slot.track = null; slot.deepJ = matchDeep(slot.buffer); }
    catch (e) { setStatus(`Couldn't read ${f.name}. Try an .m4a or .mp3 file.`); return; }
  }
  renderSlots();
  await analyseLoaded();
}
function exitDemo() {
  state.demo = false; $("#demoNote").hidden = true;
  const blank = () => ({ file: null, buffer: null, track: null, deepJ: null, spBpm: "", key: "" });
  state.slots = { A: blank(), B: blank() }; state.pair = null; state.plans = []; state.cur = state.edit = null;
  $("#plans").innerHTML = ""; renderSlots();
}
function cleanName(f) { return f ? f.name.replace(/\.[^.]+$/, "").replace(/^[0-9a-f]{6,}-/i, "").replace(/_/g, " ") : ""; }

async function analyseLoaded() {
  const keys = ["A", "B"].filter(k => state.slots[k].buffer);
  for (const k of keys) {
    const s = state.slots[k];
    if (!s.track) {
      const bpm = parseFloat(s.spBpm) || null;
      if (s.deepJ) {
        const sp = s.deepJ.spotify || {};
        if (!s.key && sp.key) s.key = sp.key;
        if (!bpm && sp.bpm) s.typedBpm = true;
        s.track = trackFromDeep(s.deepJ, bpm, s.key);
      } else s.track = await analyseTrack(s.buffer, cleanName(s.file), bpm, s.key, (t) => setStatus(`${cleanName(s.file)}: ${t}`));
      if (!s.spBpm) s.spBpm = String(s.track.spBpm);
    }
  }
  renderSlots();
  if (state.slots.A.track && state.slots.B.track) {
    const deep = state.slots.A.track.deep && state.slots.B.track.deep;
    setStatus(deep ? "Measuring every window position, length, preset and menu option against the stems…" : "Searching every preset, setting, length and position…"); await new Promise(r => setTimeout(r, 30)); buildPair();
    const missing = ["A", "B"].filter(k => !state.slots[k].typedBpm);
    const quick = ["A", "B"].filter(k => !state.slots[k].track.deep).map(k => k === "A" ? "the first song" : "the next song");
    setStatus((missing.length ? "Done. Check each Spotify BPM box matches what Spotify shows (we guessed); the bars depend on it." : "Done. Pick a transition and press Play.")
      + (quick.length ? ` No deep analysis for ${quick.join(" or ")}, so this is a quick estimate; add its .sangam.json for a measured plan.` : ""));
  }
  else setStatus("Now add the next song.");
}
function buildPair() {
  const A = state.slots.A.track, B = state.slots.B.track;
  A.spKey = state.slots.A.key; B.spKey = state.slots.B.key;
  state.pair = (A.deep && B.deep) ? new DeepPair(A, B) : new Pair(A, B);
  state.plans = state.pair.pickPlans();
  selectPlan(state.plans[0].key);
  renderAll();
}
function reBar(k) {
  const s = state.slots[k]; if (!s.track) return;
  const bpm = parseFloat(s.spBpm); if (!bpm) return;
  s.track.spBpm = bpm; s.track.spKey = s.key;
  if (s.track.deep) { deepBars(s.track); return; }
  if (s.track.raw) { // re-fit the beat grid using Spotify's tempo as the hint, then rebuild bars
    const g = fitGrid(s.track.od, estimateTempo(s.track.od, bpm));
    s.track.beat = g.p; s.track.bpmDet = 60 / g.p; s.track.phase = g.ph;
    buildBars(s.track);
  }
}

/* ---------- slots UI ---------- */
function renderSlots() {
  ["A", "B"].forEach(k => {
    const s = state.slots[k], el = $(`#slot${k}`);
    const T = s.track;
    el.querySelector(".fname").textContent = T ? T.name : (s.file ? cleanName(s.file) : (k === "A" ? "Song playing now" : "Next song"));
    el.querySelector(".finfo").textContent = T ? `${fmt(T.duration)} · we hear ${T.bpmDet.toFixed(1)} BPM · bar ${T.bar_s.toFixed(2)} s` : (s.buffer ? "analysing…" : "no file yet");
    el.classList.toggle("ok", !!T);
    const bd = el.querySelector(".badge"); bd.hidden = !T; bd.className = "badge" + (T && T.deep ? " deep" : "");
    bd.textContent = T && T.deep ? `Deep analysis · stems + beat grid${s.buffer ? "" : " · load the song to hear it"}` : "Quick estimate · no stems";
    const bi = el.querySelector(".bpm"), ki = el.querySelector(".key");
    if (document.activeElement !== bi) bi.value = s.spBpm; if (document.activeElement !== ki) ki.value = s.key;
  });
}

/* =====================================================================
   5. Plan list, editor replica, settings
   ===================================================================== */
function selectPlan(key) {
  stopAudio();
  state.cur = state.plans.find(p => p.key === key) || state.plans[0];
  state.edit = { ...state.cur, settings: { ...state.cur.settings } };
  renderAll();
}
function updateEdit() { state.edit.eval = state.pair.evaluate(state.edit); stopAudio(); renderAll(false); }

function renderPlans() {
  const host = $("#plans");
  host.innerHTML = state.plans.map(p => {
    const tm = state.pair.timing(p), e = p.eval, pk = presetOf(p.settings);
    const tags = [];
    if (p.tag === "best") tags.push(`<span class="tag best">Best</span>`);
    if (e.deep) {
      if (e.pass) tags.push(`<span class="tag pass">Passes every check</span>`);
      if (e.m.chopA != null || (e.m.chopB != null && e.m.chopBFast)) tags.push(`<span class="tag bad">Cuts a line</span>`);
      if (e.m.skipBVoc > 15 || e.m.lostAVoc > 20) tags.push(`<span class="tag warn">Skips vocals</span>`);
    }
    if (!pk) tags.push(`<span class="tag custom">Custom menus</span>`);
    if (usesUnverified(p.settings)) tags.push(`<span class="tag warn">Unverified option</span>`);
    if (e.terms.vocal_clash > 0.3) tags.push(`<span class="tag bad">Voices overlap</span>`);
    return `<button class="plan" data-key="${p.key}" aria-pressed="${state.cur && state.cur.key === p.key}">
      <span class="ptop"><span class="pname">${p.title}</span><span class="pscore">${e.score.toFixed(1)}</span></span>
      <span class="pmeta">${p.L} bars · ${A_NAME()} ${fmt(tm.aT0)} → ${B_NAME()} ${fmt(tm.bT0)}</span>
      ${e.deep ? `<span class="psub">${pk ? OPT.presets[pk].label + " preset" : "Custom menus"} · voices ${e.m.voc.toFixed(1)} s · bass ${e.m.bass.toFixed(1)} s · dip ${e.m.dip.toFixed(1)} dB</span>` : ""}
      ${tags.length ? `<span class="tags">${tags.join("")}</span>` : ""}</button>`;
  }).join("");
  host.querySelectorAll(".plan").forEach(b => b.addEventListener("click", () => selectPlan(b.dataset.key)));
}
const A_NAME = () => state.pair ? shortName(state.pair.A.name) : "A";
const B_NAME = () => state.pair ? shortName(state.pair.B.name) : "B";
function shortName(n) { const s = n.replace(/\s*[([].*?[)\]]\s*/g, " ").replace(/^.*? - /, "").replace(/\s+(feat|ft)\.?\s.*$/i, "").trim(); return s.length > 22 ? s.slice(0, 21) + "…" : s; }

function renderPresetsRow() {
  const s = state.edit.settings, cur = presetOf(s);
  const chips = Object.entries(OPT.presets).map(([k, p]) => {
    const ok = p.seen && p.volume;
    return `<button class="pchip" data-p="${k}" ${ok ? "" : "disabled title=\"Not decoded yet\""} aria-pressed="${cur === k}">${p.label}</button>`;
  }).join("");
  $("#presetRow").innerHTML = chips;
  $("#presetRow").querySelectorAll(".pchip:not([disabled])").forEach(b => b.addEventListener("click", () => {
    const p = OPT.presets[b.dataset.p]; if (b.dataset.p === "auto") return;
    MENUS.forEach(m => state.edit.settings[m] = p[m]); updateEdit();
  }));
}
const MENU_LABEL = { volume: "Volume", eq: "EQ", filter: "Filter", effect: "Effects", loop: "Looping" };
const MENU_COL = { volume: "var(--vol)", eq: "var(--eq)", filter: "var(--flt)", effect: "var(--fx)", loop: "var(--loop)" };
function renderMenus() {
  const host = $("#menus"), s = state.edit.settings;
  if (!host.dataset.built) {
    host.innerHTML = MENUS.map(m => `<label class="mrow" for="m-${m}"><i style="background:${MENU_COL[m]}"></i><span>${MENU_LABEL[m]}</span>
      <select id="m-${m}">${Object.entries(OPT[OPTKEY[m]]).map(([k, o]) => `<option value="${k}">${o.label}${o.seen === false ? " · unverified" : ""}</option>`).join("")}</select></label>`).join("")
      + `<div class="mrow len"><i style="background:var(--good)"></i><span>Length</span><div class="seg" id="lenSeg">${[2, 4, 8].map(L => `<button data-l="${L}">${L} bars</button>`).join("")}</div></div>`;
    MENUS.forEach(m => $(`#m-${m}`).addEventListener("change", e => { state.edit.settings[m] = e.target.value; updateEdit(); }));
    host.querySelectorAll("#lenSeg button").forEach(b => b.addEventListener("click", () => { state.edit.L = +b.dataset.l; clampEdit(); updateEdit(); }));
    host.dataset.built = "1";
  }
  MENUS.forEach(m => { $(`#m-${m}`).value = s[m]; });
  host.querySelectorAll("#lenSeg button").forEach(b => b.setAttribute("aria-pressed", String(+b.dataset.l === state.edit.L)));
}
function clampEdit() {
  const { A, B } = state.pair, e = state.edit;
  e.a_start = clamp(e.a_start, 1, A.n_bars - e.L + 1); e.b_start = clamp(e.b_start, 1, B.n_bars - e.L);
}
function nudge(lane, dir) { // dir: +1 = window later in that song
  if (lane === "A") state.edit.a_start += dir; else state.edit.b_start += dir;
  clampEdit(); updateEdit();
}

/* ---------- drawing ---------- */
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
function setupCanvas(cv, h) {
  const dpr = Math.min(3, window.devicePixelRatio || 1), w = cv.clientWidth || 360;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); cv.style.height = h + "px";
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); return [g, w, h];
}
// Spotify-like 3-band waveform: blue = lows, orange = mids, white = highs
function drawBandWave(g, T, tAtX, x0, x1, yC, amp, alpha = 1) {
  const hz = T.env.hz, L = T.env.low, M = T.env.mid, H = T.env.high;
  g.globalAlpha = alpha;
  for (let x = x0; x < x1; x++) {
    const ta = tAtX(x), tb = tAtX(x + 1); if (tb < 0 || ta > T.duration) continue;
    let i0 = Math.floor(Math.min(ta, tb) * hz), i1 = Math.max(i0 + 1, Math.floor(Math.max(ta, tb) * hz));
    let l = 0, m = 0, h = 0; for (let i = Math.max(0, i0); i < Math.min(L.length, i1); i++) { if (L[i] > l) l = L[i]; if (M[i] > m) m = M[i]; if (H[i] > h) h = H[i]; }
    // Spotify draws the mids as the orange body, with blue low-end spikes poking out and a thin white high-end core
    const bl = Math.pow(l, 2.2) * amp, ml = Math.pow(m, 0.9) * amp * 0.82, hl = Math.pow(h, 1.2) * amp * 0.34;
    g.fillStyle = "#2343d8"; g.fillRect(x, yC - bl, 1, bl * 2);
    g.fillStyle = "#c7782f"; g.fillRect(x, yC - ml, 1, ml * 2);
    g.fillStyle = "#8a4f22"; g.fillRect(x, yC - ml * 0.55, 1, ml * 1.1);
    g.fillStyle = "#f3eadb"; g.fillRect(x, yC - hl, 1, hl * 2);
  }
  g.globalAlpha = 1;
}
function rr(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

function drawStrip(cv, T, w0, w1, playT) {
  const [g, w, h] = setupCanvas(cv, Math.round(Math.min(110, Math.max(64, cv.clientWidth * 0.16))));
  g.clearRect(0, 0, w, h);
  g.fillStyle = "#1e1f22"; rr(g, 0, 0, w, h, 8); g.fill();
  const hz = T.env.hz, n = T.env.full.length;
  // bottom-anchored stacked area, like Spotify's overview
  const col = [["full", "#7c7b78"], ["mid", "#7a4a22"], ["low", "#1d2a6b"]];
  col.forEach(([k, c]) => {
    const arr = T.env[k]; g.fillStyle = c; g.beginPath(); g.moveTo(0, h);
    for (let x = 0; x <= w; x++) { const a = Math.floor(x / w * n), b = Math.floor((x + 1) / w * n); let m = 0; for (let i = a; i < Math.min(n, b + 1); i++) if (arr[i] > m) m = arr[i]; g.lineTo(x, h - 4 - m * (h - 14) * (k === "low" ? 0.75 : 1)); }
    g.lineTo(w, h); g.closePath(); g.fill();
  });
  const X = t => t / T.duration * w;
  g.fillStyle = "rgba(255,255,255,0.10)"; g.fillRect(X(w0), 0, X(w1) - X(w0), h);
  g.fillStyle = "rgba(18,18,18,0.35)"; g.fillRect(0, 0, X(w0), h); g.fillRect(X(w1), 0, w - X(w1), h);
  g.fillStyle = "#ffffff"; g.fillRect(X(w0) - 1.5, 0, 3, h); g.fillRect(X(w1) - 1.5, 0, 3, h);
  if (playT != null) { g.fillStyle = "#1ed760"; g.fillRect(X(playT) - 1, 0, 2, h); }
}

let laneGeom = null;
function drawEditor() {
  const cv = $("#editor"), P = state.pair, e = state.edit; if (!P || !e) return;
  const wCss = cv.clientWidth || 360, H = Math.round(clamp(wCss * 0.84, 300, 560));
  const [g, w, h] = setupCanvas(cv, H);
  g.fillStyle = "#121212"; g.fillRect(0, 0, w, h);
  const tm = P.timing(e), ln = lanes(e.settings, e.L);
  const px0 = w * 0.149, px1 = w * 0.851, pw = px1 - px0;
  const top = h * 0.02, bot = h * 0.98, pnlH = bot - top;
  // lane geometry measured from Spotify's editor
  const aTop = top + pnlH * 0.061, aC = top + pnlH * 0.265, aBot = top + pnlH * 0.47;
  const bTop = top + pnlH * 0.53, bC = top + pnlH * 0.737, bBot = top + pnlH * 0.94;
  const tickY = (aBot + bTop) / 2;
  laneGeom = { px0, px1, aTop, aBot, bTop, bBot, w, h };
  g.fillStyle = "#282828"; rr(g, px0, top, pw, pnlH, 14); g.fill();
  const secPerPx = tm.W / pw;
  const tA = x => tm.aT0 + (x - px0) * secPerPx, tB = x => tm.bT0 + (x - px0) * secPerPx * P.rate;
  const amp = (aBot - aTop) * 0.46;
  drawBandWave(g, P.A, tA, 0, w, aC, amp);
  drawBandWave(g, P.B, tB, 0, w, bC, amp);
  g.fillStyle = "rgba(18,18,18,0.45)"; g.fillRect(0, 0, px0, h); g.fillRect(px1, 0, w - px1, h);
  // beat / bar ticks: upper row = song A, lower row = song B
  const ticks = (T, tAt, y, offs) => {
    for (let x = 0; x < w; x++) {
      const ta = tAt(x), tb = tAt(x + 1);
      const k0 = Math.ceil((ta - T.bar0) / T.beat - 1e-6), k1 = Math.floor((tb - T.bar0) / T.beat - 1e-6);
      for (let k = k0; k <= k1; k++) {
        if (k < 0) continue;
        const isBar = k % T.beatsPerBar === 0;
        const spBeat = (60 / T.spBpm), showBeat = isBar || Math.abs(((k * T.beat) / spBeat) - Math.round((k * T.beat) / spBeat)) < 0.01;
        if (!showBeat) continue;
        g.fillStyle = isBar ? "#1ed760" : "#6e6e6e";
        g.fillRect(x, y + offs - (isBar ? 7 : 5), 2, isBar ? 14 : 10);
      }
    }
  };
  ticks(P.A, tA, tickY, -9); ticks(P.B, tB, tickY, 9);
  // window edges
  g.fillStyle = "#ffffff"; g.fillRect(px0 - 1.5, top, 3, pnlH); g.fillRect(px1 - 1.5, top, 3, pnlH);
  // curves
  const N = 300, U = Array.from({ length: N + 1 }, (_, k) => k / N);
  const plot = (fn, map, color, lw = 2.6) => { g.strokeStyle = color; g.lineWidth = lw; g.lineJoin = "round"; g.beginPath(); U.forEach((u, k) => { const x = px0 + u * pw, y = map(fn(u)); k ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke(); };
  const volMap = (t0, t1) => v => t1 - v * (t1 - t0);
  const eqMap = (c, b) => v => b - v * (b - c);
  const fMap = (c, t0, t1) => f => c - f * (c - t0) * (f > 0 ? 1 : 0) - f * (t1 - c) * (f < 0 ? 1 : 0);
  const s = e.settings;
  if (s.effect !== "none") plot(ln.fx, eqMap(aC, aBot), css("--fx"));
  if (s.filter !== "none") { plot(ln.fltA, fMap(aC, aTop, aBot), css("--flt")); plot(ln.fltB, fMap(bC, bTop, bBot), css("--flt")); }
  if (s.eq === "three_band_fade") ["mid", "high"].forEach(b => { plot(ln.eq("A", b), eqMap(aC, aBot), css("--eq-pale"), 1.8); plot(ln.eq("B", b), eqMap(bC, bBot), css("--eq-pale"), 1.8); });
  if (s.eq !== "none") { plot(ln.eq("A", "low"), eqMap(aC, aBot), css("--eq")); plot(ln.eq("B", "low"), eqMap(bC, bBot), css("--eq")); }
  plot(ln.volA, volMap(aTop, aBot), css("--vol")); plot(ln.volB, volMap(bTop, bBot), css("--vol"));
  // lane arrows (move the song inside the window by one bar)
  const arrow = (x, y, dir) => { g.fillStyle = "rgba(40,40,40,0.92)"; rr(g, x - 20, y - 22, 40, 44, 12); g.fill(); g.strokeStyle = "#e8e8e8"; g.lineWidth = 2.4; g.beginPath(); g.moveTo(x + 4 * dir, y - 9); g.lineTo(x - 5 * dir, y); g.lineTo(x + 4 * dir, y + 9); g.stroke(); };
  const ax0 = Math.max(24, px0 * 0.42), ax1 = w - Math.max(24, (w - px1) * 0.42);
  arrow(ax0, aC, 1); arrow(ax1, aC, -1); arrow(ax0, bC, 1); arrow(ax1, bC, -1);
  laneGeom.arrows = [{ x: ax0, y: aC, lane: "A", dir: 1 }, { x: ax1, y: aC, lane: "A", dir: -1 }, { x: ax0, y: bC, lane: "B", dir: 1 }, { x: ax1, y: bC, lane: "B", dir: -1 }];
  // landmarks
  g.font = "600 11px 'IBM Plex Sans', system-ui"; g.textBaseline = "top";
  const mark = (t, tAt0, y0, y1, label, color) => { const x = px0 + (t - tAt0) / (secPerPx * (tAt0 === tm.bT0 ? P.rate : 1)); if (x < px0 - 2 || x > px1 + 2) return; g.strokeStyle = color; g.setLineDash([4, 4]); g.lineWidth = 1.5; g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y1); g.stroke(); g.setLineDash([]); g.fillStyle = color; g.fillText(label, Math.min(x + 4, px1 - 80), y0 + 2); };
  mark(P.A.soundEnd, tm.aT0, aTop, aBot, "sound ends", "#f2a7e6");
  // vocal lines from the separated vocal stem (Spotify doesn't show these; they explain the choice)
  const vlines = (T, t0, rate, y) => { if (!T.deep) return; g.fillStyle = "rgba(255,120,190,0.9)"; T.deep.lines.forEach(([a, b]) => { const x0 = px0 + (a - t0) / (secPerPx * rate), x1 = px0 + (b - t0) / (secPerPx * rate); if (x1 < 0 || x0 > w) return; g.fillRect(Math.max(0, x0), y, Math.min(w, x1) - Math.max(0, x0), 3); }); g.fillStyle = "rgba(255,120,190,0.95)"; g.font = "600 10px 'IBM Plex Mono', monospace"; g.textBaseline = "alphabetic"; g.fillText("vocals", 6, y - 4); };
  vlines(P.A, tm.aT0, 1, aBot - 4); vlines(P.B, tm.bT0, P.rate, bBot - 4);
  if (P.B.drop) mark(P.B.bars.t0[P.B.drop - 1], tm.bT0, bTop, bBot, "drums in", "#7fd3ff");
  // playhead
  if (state.playheadT != null) { const x = px0 + (state.playheadT - tm.aT0) / secPerPx; if (x >= 0 && x <= w) { g.fillStyle = "#1ed760"; g.fillRect(x - 2, top, 4, pnlH); } }
}
function drawStrips() {
  const P = state.pair, e = state.edit; if (!P || !e) return; const tm = P.timing(e);
  const pa = state.playing ? state.playPos : null;
  drawStrip($("#stripA"), P.A, tm.aT0, tm.aT1, pa ? pa.a : null);
  drawStrip($("#stripB"), P.B, tm.bT0, tm.bT1, pa ? pa.b : null);
  $("#stripALab").textContent = `${A_NAME()} · window ${fmt(tm.aT0)}–${fmt(tm.aT1)} (${Math.round(tm.aT0 / P.A.duration * 100)}–${Math.round(tm.aT1 / P.A.duration * 100)} % through)`;
  $("#stripBLab").textContent = `${B_NAME()} · window ${fmt(tm.bT0)}–${fmt(tm.bT1)} (${Math.round(tm.bT0 / P.B.duration * 100)}–${Math.round(tm.bT1 / P.B.duration * 100)} % through)`;
}

/* ---------- explanation and steps ---------- */
const TERM_NAMES = { mud: "Two basslines", vocal_clash: "Two vocals / melodies", phrase_misalign: "Off-phrase timing", section_fit: "Wrong song section", tempo_risk: "Tempo mismatch", key_risk: "Key clash", loud_bump: "Too loud", energy_hole: "Energy dip", arc_fit: "Energy jump", skip_end: "Cuts the ending early", skip_intro: "Skips the next intro" };
const BON_NAMES = { drop_landing: "Lands on the drums", similarity: "Similar sound", effect_fit: "Effect covers a gap" };
function renderWhy() {
  const e = state.edit.eval, P = state.pair, tm = P.timing(state.edit);
  if (e.deep) {
    $("#bars").innerHTML = deepMetrics(state.edit);
    $("#reasons").innerHTML = deepWhy(P, state.edit).map(([w, t]) => `<li class="${w ? "warn" : ""}">${t}</li>`).join("");
    $("#source").textContent = `Measured from AI-separated stems (Demucs) and a Beat This! beat grid (${Math.round(100 * Math.min(P.A.deep.fit, P.B.deep.fit))} % of detected beats on the grid). The score reflects how clean those measurements are.`;
    return;
  }
  $("#source").textContent = "";
  const rows = Object.keys(W).map(k => [TERM_NAMES[k], e.terms[k] * W[k] * 100, "bad"]).filter(r => r[1] > 0.05)
    .concat(Object.keys(V).map(k => [BON_NAMES[k], e.bonus[k] * V[k] * 100, "good"]).filter(r => r[1] > 0.05)).sort((a, b) => b[1] - a[1]);
  $("#bars").innerHTML = rows.map(([n, v, k]) => `<div class="sbar"><span>${n}</span><span class="trk"><span class="fill ${k}" style="width:${Math.min(100, v * 10)}%"></span></span><span class="v">${k === "good" ? "+" : "−"}${v.toFixed(1)}</span></div>`).join("") || `<p class="muted">No penalties.</p>`;
  const out = [];
  const kd = P.key;
  if (kd) out.push([kd.kind === "clash", kd.kind === "clash" ? `Keys ${P.A.spKey} → ${P.B.spKey} clash; keep the overlap short or use an echo/reverb tail.` : `Keys ${P.A.spKey} → ${P.B.spKey} work together (${kd.kind === "same" ? "same key" : kd.kind === "boost" ? "+2 energy boost" : "neighbours on the Camelot wheel"}).`]);
  else out.push([0, `Add both keys from Spotify (like 10A) to check harmony.`]);
  out.push([P.tempoGapPct > 8, P.beatmatch ? `Tempos are ${P.tempoGapPct.toFixed(1)} % apart${P.tempoGapPct < 1 ? ", so the beats stay locked" : ""}.` : `Tempos are ${P.tempoGapPct.toFixed(0)} % apart; this preview doesn't beat-match, so keep the cut short.`]);
  if (e.bonus.drop_landing > 0.99) out.push([0, `${B_NAME()}'s drums come in at ${fmt(P.B.bars.t0[P.B.drop - 1])}, right ${presetOf(state.edit.settings) === "slam" || state.edit.settings.volume === "centre_cut" ? "on the cut" : "as the transition ends"}.`]);
  if (e.terms.mud < 0.05) out.push([0, `Only one bassline plays at a time.`]);
  if (e.terms.vocal_clash < 0.05) out.push([0, `The two songs' vocals and melodies don't pile up.`]);
  if (e.terms.vocal_clash >= 0.3) out.push([1, `Both songs are busy in the mids inside the overlap, so voices may talk over each other.`]);
  if (e.terms.energy_hole >= 0.25) out.push([1, `The mix goes quiet in the middle before the next song picks up.`]);
  if (e.terms.loud_bump >= 0.3) out.push([1, `Both songs are loud at once; it may feel crowded.`]);
  if (usesUnverified(state.edit.settings)) out.push([1, `Uses a menu option whose exact curve isn't confirmed yet; preview it in Spotify.`]);
  out.push([1, `Quick estimate: no stems for ${!P.A.deep && !P.B.deep ? "either song" : !P.A.deep ? A_NAME() : B_NAME()}, so vocals and sections are guesses from frequency bands. Add a .sangam.json for a measured plan.`]);
  $("#reasons").innerHTML = out.map(([w, t]) => `<li class="${w ? "warn" : ""}">${t}</li>`).join("");
}
function landmarkText(P, tm, p) {
  const out = [];
  const barInWin = (T, t, t0, rate) => (t - t0) / (P.A.bar_s * rate);
  const where = (b) => Math.abs(b) < 0.15 ? "right at the left edge" : Math.abs(b - p.L) < 0.15 ? "right at the right edge" : b < 0 ? `${(+(-b).toFixed(1))} bars before the left edge` : b > p.L ? `${(+(b - p.L).toFixed(1))} bars after the right edge` : `${(+b.toFixed(1))} of the ${p.L} bars in`;
  if (P.deep && p.eval && p.eval.m) {
    const m = p.eval.m;
    if (m.aLine) { const b = barInWin(P.A, m.aLine[1], tm.aT0, 1); if (b > -2 && b < p.L + 0.5) out.push(`${A_NAME()}'s last line before the switch ends ${where(b)} (${fmt(m.aLine[1])}; the pink "vocals" strip in the top lane)`); }
    if (m.bLine && m.bQuiet) { const b = barInWin(P.B, m.bLine[0], tm.bT0, P.rate); if (b > -0.5 && b < p.L + 3) out.push(`${B_NAME()}'s vocals start ${where(b)} (${fmt(m.bLine[0])})`); }
    return out;
  }
  if (P.B.drop) { const b = barInWin(P.B, P.B.bars.t0[P.B.drop - 1], tm.bT0, P.rate); if (b >= -0.1 && b <= p.L + 0.1) out.push(`${B_NAME()}'s drums (the first big blue spikes in the bottom lane) start ${b < 0.1 ? "right at the left edge" : b > p.L - 0.1 ? "right at the right edge" : `${(+b.toFixed(1))} of the ${p.L} bars in`}`); }
  const ae = barInWin(P.A, P.A.soundEnd, tm.aT0, 1); if (ae >= 0 && ae <= p.L) out.push(`${A_NAME()}'s waveform fades out ${ae > p.L - 0.1 ? "at the right edge" : `${(+ae.toFixed(1))} bars into the window`}`);
  return out;
}
function renderSteps() {
  const P = state.pair, p = state.edit, s = p.settings, pk = presetOf(s), tm = P.timing(p);
  const base = pk || nearestPreset(s), bp = OPT.presets[base];
  const lab = (m, v) => OPT[OPTKEY[m]][v].label;
  const steps = [];
  steps.push(`In Spotify, turn on <b>Mix</b> and tap the transition between <b>${A_NAME()}</b> and <b>${B_NAME()}</b>.`);
  steps.push(`Tap the preset <b>${bp.label}</b>.`);
  const diffs = MENUS.filter(m => bp[m] !== s[m]);
  if (diffs.length) steps.push(`Then change ${diffs.map(m => `<b>${MENU_LABEL[m]}</b> to <b>${lab(m, s[m])}</b>`).join(", ")}.`);
  steps.push(`Set the length to <b>${p.L} bars</b>: the white window edges should be ${p.L} green bar ticks apart.`);
  const lm = landmarkText(P, tm, p);
  steps.push(`Use the arrows on each lane until the white brackets in the two overview strips sit where they are on this page (${A_NAME()} ${Math.round(tm.aT0 / P.A.duration * 100)} % through, ${B_NAME()} ${Math.round(tm.bT0 / P.B.duration * 100)} % through)${lm.length ? `, and check: ${lm.join("; ")}` : ""}.`);
  steps.push(`Preview in Spotify, compare with Play here, nudge by ear, then tap <b>Save</b>.`);
  $("#steps").innerHTML = steps.map(t => `<li>${t}</li>`).join("");
  $("#stamps").innerHTML = `For reference: ${A_NAME()} <span class="stamp">${fmt(tm.aT0)}–${fmt(tm.aT1)}</span> overlaps ${B_NAME()} <span class="stamp">${fmt(tm.bT0)}–${fmt(tm.bT1)}</span>.`;
}

function renderAll(full = true) {
  if (!state.pair) return;
  if (!state.edit.eval) state.edit.eval = state.pair.evaluate(state.edit);
  const e = state.edit, c = state.cur;
  const changed = c && (MENUS.some(m => e.settings[m] !== c.settings[m]) || e.L !== c.L || e.a_start !== c.a_start || e.b_start !== c.b_start);
  $("#dkick").textContent = changed ? `Your edit of: ${c.title}` : (c.tag === "best" ? "Best transition" : "Selected transition");
  $("#dtitle").textContent = `${A_NAME()} → ${B_NAME()}`;
  $("#dscore").innerHTML = `${e.eval.score.toFixed(1)}<small>/100</small>`;
  if (full) renderPlans(); else $("#plans").querySelectorAll(".plan").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.key === c.key)));
  renderPresetsRow(); renderMenus(); renderWhy(); renderSteps(); drawEditor(); drawStrips();
  schedulePrerender();
  $("#chips").innerHTML = pairChips();
  ["#play", "#playlong", "#stop"].forEach(s => $(s).disabled = !(state.slots.A.buffer && state.slots.B.buffer && !state.demo));
  $("#clock").textContent = state.demo ? "Example: load both songs to hear it" : (state.slots.A.buffer && state.slots.B.buffer ? "Ready" : "Load both songs to listen");
}
function pairChips() {
  const P = state.pair, A = P.A, B = P.B;
  const items = [
    [`${A_NAME()}: Spotify ${A.spBpm} BPM${A.spKey ? " · " + A.spKey : ""}`, ""],
    [`${B_NAME()}: Spotify ${B.spBpm} BPM${B.spKey ? " · " + B.spKey : ""}`, ""],
    [`Tempo gap ${P.tempoGapPct.toFixed(1)} %`, P.tempoGapPct < 5 ? "good" : P.tempoGapPct < 10 ? "" : "bad"],
  ];
  if (P.key) items.push([P.key.kind === "clash" ? "Keys clash" : "Keys match", P.key.kind === "clash" ? "bad" : "good"]);
  return items.map(([t, k]) => `<span class="chip ${k}">${t}</span>`).join("");
}

/* =====================================================================
   6. Playback
   ===================================================================== */
const audioEl = document.getElementById("preview") || new Audio(); audioEl.setAttribute("playsinline", "");
const LEAD_MAX = 20;
const pre = { key: null, r: null, url: null, busy: null, want: null };
let preTimer = null;
function planKey(e) { return [state.slots.A.file && state.slots.A.file.name, state.slots.B.file && state.slots.B.file.name, e.a_start, e.b_start, e.L, MENUS.map(m => e.settings[m]).join(","), state.pair && state.pair.rate].join("|"); }
function schedulePrerender() {
  if (!(state.slots.A.buffer && state.slots.B.buffer && !state.demo && state.pair && state.edit)) return;
  if (pre.key === planKey(state.edit) && (pre.r || pre.busy)) return;
  clearTimeout(preTimer); preTimer = setTimeout(prerender, 200);
}
async function prerender() {
  const key = planKey(state.edit);
  if (pre.key === key && (pre.r || pre.busy)) return;
  pre.key = key; pre.r = null; $("#prevNote").textContent = "Preparing the preview…";
  const job = renderTransition(state.pair, state.edit, state.slots.A.buffer, state.slots.B.buffer, LEAD_MAX);
  pre.busy = job;
  let r = null;
  try { r = await job; } catch (err) { if (pre.key === key) { pre.key = null; toast(`Couldn't render this transition: ${err && err.message ? err.message : err}`); } }
  if (pre.busy === job) pre.busy = null;
  if (!r || pre.key !== key) return;
  if (pre.url) URL.revokeObjectURL(pre.url);
  pre.url = URL.createObjectURL(wavBlob(r.buffer)); pre.r = r;
  stopAudio(); audioEl.src = pre.url; audioEl.load();
  $("#prevNote").textContent = `Preview ready: ${LEAD_MAX} s of ${A_NAME()}, the ${state.edit.L}-bar transition, then ${B_NAME()}.`;
  if (pre.want != null) { const lead = pre.want; pre.want = null; startPlayback(lead, false); }
}
function startPlayback(lead, inTap) {
  stopAudio();
  try { audioEl.currentTime = Math.max(0, LEAD_MAX - lead); } catch (e) {}
  state.playing = { kind: "el", r: pre.r };
  const pr = audioEl.play();
  if (pr && pr.catch) pr.catch(err => { state.playing = null; toast(inTap ? `The browser blocked audio (${err && err.name}). Use the player under the buttons.` : "Preview ready: tap Play again."); });
  toast(`Playing with a ${lead} s lead-in.`);
  tick();
}
function play(lead) {
  if (!(state.slots.A.buffer && state.slots.B.buffer) || state.demo) return;
  if (pre.r && pre.key === planKey(state.edit)) { startPlayback(lead, true); return; }
  pre.want = lead; toast("Preparing the preview, it starts in a moment…");
  if (!(pre.busy && pre.key === planKey(state.edit))) prerender();
}
function tick() {
  if (!state.playing) return;
  const { pre: lead0, W: Wd, tm } = state.playing.r;
  const t = audioEl.currentTime;
  const aPos = tm.aT0 + (t - lead0), bPos = tm.bT0 + (t - lead0) * state.pair.rate;
  state.playheadT = aPos; state.playPos = { a: aPos <= state.pair.A.duration ? aPos : null, b: bPos >= 0 ? bPos : null };
  const u = (t - lead0) / Wd;
  $("#clock").innerHTML = `${A_NAME()} ${aPos <= state.pair.A.duration ? fmt(aPos) : "ended"} · ${B_NAME()} ${bPos >= 0 ? fmt(bPos) : "–"}<br>${u < 0 ? `transition in ${(-u * Wd).toFixed(1)} s` : u <= 1 ? `in transition · ${(u * 100).toFixed(0)} %` : "after the transition"}`;
  drawEditor(); drawStrips();
  state.raf = requestAnimationFrame(tick);
}
function stopAudio() {
  if (state.playing) { try { audioEl.pause(); } catch (e) {} state.playing = null; }
  if (state.raf) cancelAnimationFrame(state.raf); state.raf = null; state.playheadT = null; state.playPos = null;
  if (state.pair) { drawEditor(); drawStrips(); if (!state.demo && state.slots.A.buffer && state.slots.B.buffer) $("#clock").textContent = "Ready"; }
}
audioEl.addEventListener("ended", () => stopAudio());
audioEl.addEventListener("play", () => { if (!state.playing && pre.r) { state.playing = { kind: "el", r: pre.r }; tick(); } });
audioEl.addEventListener("pause", () => { if (state.playing) { state.playing = null; if (state.raf) cancelAnimationFrame(state.raf); state.raf = null; } });
async function soundCheck() {
  const c = getCtx(); unlockAudio(); try { await c.resume(); } catch (e) {}
  const o = c.createOscillator(), g = c.createGain(); o.frequency.value = 660; g.gain.value = 0.2; o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime + 0.4);
  toast(`Sound check: you should hear a beep (audio ${c.state}). Silent? Turn the volume up; on iPhone turn off Silent mode.`);
}

/* =====================================================================
   7. Wiring
   ===================================================================== */
function init() {
  ["A", "B"].forEach(k => {
    const el = $(`#slot${k}`), inp = el.querySelector("input[type=file]");
    el.querySelector(".pick").addEventListener("click", () => inp.click());
    inp.addEventListener("change", e => { if (e.target.files.length) handleFiles(e.target.files, k); e.target.value = ""; });
    const bi = el.querySelector(".bpm"), ki = el.querySelector(".key");
    bi.addEventListener("change", () => { state.slots[k].spBpm = bi.value.trim(); state.slots[k].typedBpm = !!bi.value.trim(); if (state.slots[k].track) { reBar(k); if (state.slots.A.track && state.slots.B.track) buildPair(); else renderSlots(); } });
    ki.addEventListener("change", () => { state.slots[k].key = ki.value.trim().toUpperCase(); ki.value = state.slots[k].key; if (state.pair) buildPair(); });
  });
  $("#swap").addEventListener("click", () => {
    const a = state.slots.A; state.slots.A = state.slots.B; state.slots.B = a; renderSlots();
    if (state.slots.A.track && state.slots.B.track) buildPair();
  });
  const dz = $("#loader");
  ["dragenter", "dragover"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", e => { if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });
  document.addEventListener("dragover", e => e.preventDefault());
  document.addEventListener("drop", e => { e.preventDefault(); });
  $("#play").addEventListener("click", () => play(6));
  $("#playlong").addEventListener("click", () => play(20));
  $("#stop").addEventListener("click", stopAudio);
  $("#beep").addEventListener("click", soundCheck);
  $("#reset").addEventListener("click", () => selectPlan(state.cur.key));
  // drag a lane sideways to slide that song through the window (snaps to Spotify beats on release);
  // drag or tap an overview strip to jump the window there
  const ed = $("#editor"); let drag = null, justDragged = false;
  const setLanePos = (lane, v, final) => {
    const P = state.pair, e = state.edit, T = lane === "A" ? P.A : P.B;
    const max = lane === "A" ? T.n_bars - e.L + 1 : T.n_bars - e.L;
    v = clamp(v, 1, Math.max(1, max)); if (final) v = Math.round(v * 4) / 4;
    if (lane === "A") e.a_start = v; else e.b_start = v;
    if (final) updateEdit(); else { stopAudio(); drawEditor(); drawStrips(); const tm = P.timing(e); $("#clock").textContent = `${A_NAME()} ${fmt(tm.aT0)} · ${B_NAME()} ${fmt(tm.bT0)}`; }
  };
  ed.addEventListener("pointerdown", ev => {
    if (!laneGeom || !state.edit) return;
    const r = ed.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
    if (laneGeom.arrows && laneGeom.arrows.some(a => Math.abs(a.x - x) < 26 && Math.abs(a.y - y) < 28)) return;
    const lane = (y >= laneGeom.aTop - 12 && y <= (laneGeom.aBot + laneGeom.bTop) / 2) ? "A" : (y > (laneGeom.aBot + laneGeom.bTop) / 2 && y <= laneGeom.bBot + 12) ? "B" : null;
    if (!lane) return;
    drag = { lane, x0: ev.clientX, start: lane === "A" ? state.edit.a_start : state.edit.b_start, pxPerBar: (laneGeom.px1 - laneGeom.px0) / state.edit.L, moved: false, id: ev.pointerId };
  });
  ed.addEventListener("pointermove", ev => {
    if (!drag || ev.pointerId !== drag.id) return;
    const dx = ev.clientX - drag.x0;
    if (!drag.moved && Math.abs(dx) < 6) return;
    if (!drag.moved) { drag.moved = true; try { ed.setPointerCapture(ev.pointerId); } catch (e) {} }
    ev.preventDefault();
    setLanePos(drag.lane, drag.start - dx / drag.pxPerBar, false); // drag left = later music slides into the window, like Spotify
  });
  const endDrag = ev => { if (!drag) return; const d = drag; drag = null; if (!d.moved) return; justDragged = true; setTimeout(() => { justDragged = false; }, 60); setLanePos(d.lane, d.lane === "A" ? state.edit.a_start : state.edit.b_start, true); };
  ed.addEventListener("pointerup", endDrag); ed.addEventListener("pointercancel", endDrag);
  [["#stripA", "A"], ["#stripB", "B"]].forEach(([sel, lane]) => {
    const cv = $(sel); let down = false;
    const at = ev => { const P = state.pair; if (!P || !state.edit) return null; const r = cv.getBoundingClientRect(), T = lane === "A" ? P.A : P.B; const t = clamp((ev.clientX - r.left) / r.width, 0, 1) * T.duration; return 1 + (t - T.bar0) / T.bar_s - state.edit.L / 2; };
    cv.addEventListener("pointerdown", ev => { const v = at(ev); if (v == null) return; down = true; try { cv.setPointerCapture(ev.pointerId); } catch (e) {} setLanePos(lane, v, false); });
    cv.addEventListener("pointermove", ev => { if (!down) return; const v = at(ev); if (v != null) setLanePos(lane, v, false); });
    const up = ev => { if (!down) return; down = false; setLanePos(lane, lane === "A" ? state.edit.a_start : state.edit.b_start, true); };
    cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
  });
  $("#editor").addEventListener("click", ev => {
    if (justDragged) return;
    if (!laneGeom || !laneGeom.arrows) return;
    const r = ev.currentTarget.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
    const hit = laneGeom.arrows.find(a => Math.abs(a.x - x) < 26 && Math.abs(a.y - y) < 28);
    if (hit) nudge(hit.lane, hit.dir); // "<" slides the waveform left (later music in the window), ">" slides it right
  });
  document.querySelectorAll("[data-nudge]").forEach(b => b.addEventListener("click", () => { const [lane, d] = b.dataset.nudge.split(":"); nudge(lane, +d); }));
  let rto; window.addEventListener("resize", () => { clearTimeout(rto); rto = setTimeout(() => { drawEditor(); drawStrips(); }, 120); });
  $("#addAnalysis").addEventListener("click", () => $("#analysisInput").click());
  $("#analysisInput").addEventListener("change", e => { if (e.target.files.length) addAnalyses([...e.target.files]); e.target.value = ""; });
  const examples = [["OG Lucifer - Terey Papa", "Seedhe Maut - TT"], ["The Weeknd, Playboi Carti - Timeless", "KAROL G, Judeline, rusowsky - BbY WOW"]]
    .map(([a, b]) => [DEEP_LIB.find(J => J.name === a), DEEP_LIB.find(J => J.name === b)]).filter(([a, b]) => a && b);
  if (examples.length) {
    const show = (i) => {
      const [JA, JB] = examples[i];
      state.demo = true;
      state.slots.A = { file: null, buffer: null, track: trackFromDeep(JA), deepJ: JA, spBpm: "", key: (JA.spotify || {}).key || "" };
      state.slots.B = { file: null, buffer: null, track: trackFromDeep(JB), deepJ: JB, spBpm: "", key: (JB.spotify || {}).key || "" };
      ["A", "B"].forEach(k => { const sl = state.slots[k]; sl.spBpm = String(sl.track.spBpm); sl.typedBpm = !!(sl.deepJ.spotify || {}).bpm; });
      renderSlots(); buildPair();
      const note = $("#demoNote"); note.hidden = false;
      note.innerHTML = `Example: ${shortName(JA.name)} → ${shortName(JB.name)} from the built-in deep analyses. Load those two songs to hear it (they're recognised automatically), or load any two songs. `
        + examples.map(([a, b], j) => j === i ? "" : `<button class="btn" data-ex="${j}" style="padding:6px 10px;font-size:12.5px">Show ${shortName(a.name)} → ${shortName(b.name)}</button>`).join(" ");
      note.querySelectorAll("[data-ex]").forEach(bn => bn.addEventListener("click", () => show(+bn.dataset.ex)));
      setStatus(["A", "B"].some(k => !state.slots[k].typedBpm) ? "Showing an example. Spotify's BPM for these wasn't given, so check the BPM boxes against Spotify." : "Showing an example. Load two songs to plan your own.");
    };
    show(0);
  }
  if (document.fonts) document.fonts.ready.then(() => { drawEditor(); drawStrips(); });
}
init();
