"""Deep analysis for Sangam Mix Lab.

Listens to one song properly, once, and writes <song>.sangam.json for the web app:
  * Demucs (htdemucs) stems -> vocal / drum / bass / other loudness every 50 ms
  * Beat This! (CPJKU, ISMIR 2024) beat + downbeat probabilities -> constant-tempo grid
  * vocal lines (when someone is actually singing / rapping), song sections with labels,
    harmonic chroma per bar, and a waveform envelope for drawing.

Usage:
  python3 deep_analyse.py song.m4a [--spotify-bpm 60] [--key 10A] [--stems DIR] [--out DIR]

No audio is stored in the output, only measurements.
"""
import argparse, base64, json, math, os, subprocess, sys, tempfile
import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfiltfilt

SR = 44100
STEM_HZ = 20          # stem loudness frames per second
ENV_HZ = 40           # drawing envelope frames per second
STEMS = ["vocals", "drums", "bass", "other"]


def log(*a):
    print("[sangam]", *a, file=sys.stderr, flush=True)


def load_audio(path):
    """Any format ffmpeg can read -> float32 stereo at 44.1 kHz."""
    if path.lower().endswith(".wav"):
        x, sr = sf.read(path, dtype="float32", always_2d=True)
        if sr == SR:
            return x
    with tempfile.TemporaryDirectory() as td:
        wav = os.path.join(td, "a.wav")
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", path, "-ar", str(SR), "-ac", "2", wav], check=True)
        x, _ = sf.read(wav, dtype="float32", always_2d=True)
    return x


def get_stems(path, mix, stem_dir):
    """Reuse stems from stem_dir/<name>/*.wav if present, else run Demucs."""
    name = os.path.splitext(os.path.basename(path))[0]
    cand = [os.path.join(stem_dir, "htdemucs", name), os.path.join(stem_dir, name)] if stem_dir else []
    for d in cand:
        if all(os.path.exists(os.path.join(d, s + ".wav")) for s in STEMS):
            log("using stems in", d)
            return {s: sf.read(os.path.join(d, s + ".wav"), dtype="float32", always_2d=True)[0] for s in STEMS}
    log("separating stems with Demucs (takes a while on CPU)…")
    import torch
    from demucs.pretrained import get_model
    from demucs.apply import apply_model
    model = get_model("htdemucs"); model.eval()
    dev = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
    wav = torch.tensor(mix.T)[None]
    ref = wav.mean(1)
    wav = (wav - ref.mean()) / (ref.std() + 1e-8)
    try:
        with torch.no_grad():
            out = apply_model(model, wav.to(dev), shifts=1, split=True, overlap=0.25, progress=True)[0]
    except Exception as e:  # some torch builds miss an op on Apple's GPU: fall back to CPU
        log(f"{dev} failed ({e.__class__.__name__}); using CPU")
        with torch.no_grad():
            out = apply_model(model.cpu(), wav, shifts=1, split=True, overlap=0.25, progress=True)[0]
    out = out * (ref.std() + 1e-8) + ref.mean()
    res = {s: out[model.sources.index(s)].cpu().numpy().T.astype(np.float32) for s in STEMS}
    if stem_dir:
        d = os.path.join(stem_dir, "htdemucs", name); os.makedirs(d, exist_ok=True)
        for s, v in res.items():
            sf.write(os.path.join(d, s + ".wav"), v, SR)
    return res


def rms_db(x, hz, win_s=0.1):
    """Short-term RMS in dBFS of a mono signal, hz frames per second, centred windows."""
    hop = SR // hz
    n = len(x) // hop + 1
    w = int(win_s * SR)
    c = np.concatenate([[0.0], np.cumsum(x.astype(np.float64) ** 2)])
    centres = np.arange(n) * hop
    a = np.clip(centres - w // 2, 0, len(x)); b = np.clip(centres + w // 2, 0, len(x))
    e = (c[b] - c[a]) / np.maximum(1, b - a)
    return 10 * np.log10(e + 1e-12)


def peak_env(x, hz):
    hop = SR // hz
    n = len(x) // hop
    return np.abs(x[: n * hop]).reshape(n, hop).max(1)


def b64u8(a):
    return base64.b64encode(np.asarray(a, dtype=np.uint8).tobytes()).decode()


def db_to_u8(db):  # -90..+12 dBFS -> 0..255 (0.4 dB steps)
    return np.clip(np.round((np.asarray(db) + 90) * 2.5), 0, 255)


# ---------------------------------------------------------------- beat grid
def beat_frames(mono):
    from beat_this.inference import Audio2Frames
    a2f = Audio2Frames(checkpoint_path="final0", device="cpu")
    b, d = a2f(mono, SR)
    sig = lambda z: 1 / (1 + np.exp(-z.cpu().numpy().astype(np.float64)))
    return sig(b), sig(d)  # 50 fps


def interp(arr, t, fps=50.0):
    i = t * fps
    i0 = np.clip(np.floor(i).astype(int), 0, len(arr) - 2)
    f = np.clip(i - i0, 0, 1)
    return arr[i0] * (1 - f) + arr[i0 + 1] * f


def peaks(p, thr=0.4, min_gap=4):
    idx = [i for i in range(1, len(p) - 1) if p[i] >= thr and p[i] >= p[i - 1] and p[i] > p[i + 1]]
    out = []
    for i in idx:
        if out and i - out[-1] < min_gap:
            if p[i] > p[out[-1]]:
                out[-1] = i
        else:
            out.append(i)
    return np.array(out) / 50.0


def fit_grid(pb, pd, dur, hint_bpm=None):
    """Constant-tempo beat grid at the finest musical beat level Beat This marks.
    Beat This sometimes marks every beat and sometimes every other beat (half-time feel);
    folding every gap onto the finest level and fitting a straight line through the beat
    times gives a period accurate to well under a millisecond."""
    bt = peaks(pb)
    ibi = np.diff(bt)
    ibi = ibi[(ibi > 0.2) & (ibi < 2.5)]
    # finest level with real support (>= 15% of gaps)
    hist_lv = sorted(ibi)
    p = None
    for q in np.arange(0.28, 0.80, 0.005):
        if np.mean(np.abs(ibi - q) < 0.03) >= 0.15:
            near = ibi[np.abs(ibi - q) < 0.03]
            p = float(np.median(near)); break
    if p is None:
        p = float(np.median(ibi)) if len(ibi) else 0.5
        while p > 0.8: p /= 2
    for _ in range(3):
        n = np.maximum(1, np.round(ibi / p)); est = ibi / n
        ok = np.abs(est - p) < 0.05 * p
        p = float(np.median(est[ok])) if ok.any() else p
    # least-squares line t = ph + k p through the detected beats
    # beat index counted gap by gap, so a slightly-off starting period cannot wrap around
    k = np.concatenate([[0], np.cumsum(np.maximum(1, np.round(np.diff(bt) / p)))])
    ph = bt[0]
    for it in range(4):
        if it:
            k = np.round((bt - ph) / p)
        res = bt - (ph + k * p)
        if it == 0:
            A0 = np.vstack([np.ones(len(bt)), k]).T
            ph, p = np.linalg.lstsq(A0, bt, rcond=None)[0]
            res = bt - (ph + k * p)
        inl = np.abs(res) < 0.06
        if inl.sum() > 8:
            A = np.vstack([np.ones(inl.sum()), k[inl]]).T
            ph, p = np.linalg.lstsq(A, bt[inl], rcond=None)[0]
    grid = (ph % p) + np.arange(int(dur / p) + 1) * p
    grid = grid[grid < dur]
    sc = [float(interp(pd, grid[k::4]).mean()) for k in range(4)]
    k = int(np.argmax(sc))
    fit = float(np.mean([np.min(np.abs(grid - t)) < 0.05 for t in bt])) if len(bt) else 0.0
    drift = []
    for w0 in np.arange(0, dur - 30, 15):
        sel = grid[(grid >= w0) & (grid < w0 + 30)]
        if len(sel) < 8:
            continue
        offs = np.linspace(-0.08, 0.08, 33)
        drift.append(offs[int(np.argmax([interp(pb, sel + o).mean() for o in offs]))])
    return dict(period=float(p), t_db=float(grid[k]), downbeat_strength=sc, fit=fit,
                drift_ms=float(1000 * (np.max(np.abs(drift)) if drift else 0)), model_beats=len(bt))


# ---------------------------------------------------------------- vocals
def vocal_activity(vdb, hz):
    """Frames where the vocal stem is clearly present (not bleed), split at breaths.
    Rap vocals never fall silent between bars, so a frame only counts as 'in a line'
    when it is within 14 dB of the loudest vocal in the surrounding second."""
    from scipy.ndimage import maximum_filter1d
    ref = np.percentile(vdb, 95)
    on_thr, off_thr = max(ref - 15, -48), max(ref - 21, -54)
    lmax = maximum_filter1d(vdb, size=int(2 * hz) + 1)
    act = np.zeros(len(vdb), bool)
    on = False
    for i, v in enumerate(vdb):
        rel = lmax[i] - 14
        on = (v > max(on_thr, rel)) if not on else (v > max(off_thr, rel - 3))
        act[i] = on
    def spans(mask, merge_gap, min_len):
        sp = []
        i = 0
        while i < len(mask):
            if mask[i]:
                j = i
                while j < len(mask) and mask[j]:
                    j += 1
                sp.append([i / hz, j / hz]); i = j
            else:
                i += 1
        out = []
        for s in sp:
            if out and s[0] - out[-1][1] <= merge_gap:
                out[-1][1] = s[1]
            else:
                out.append(s)
        return [s for s in out if s[1] - s[0] >= min_len]
    lines = spans(act, 0.12, 0.2)         # individual lines / phrases (breaths split them)
    blocks = spans(act, 2.2, 1.0)         # longer vocal passages
    return act, lines, blocks, float(ref)


# ---------------------------------------------------------------- sections
def bar_features(stem_db, act, hz, bars_t, dur, harm, mono):
    import librosa
    nb = len(bars_t)
    edges = list(bars_t) + [dur]
    F = {s: [] for s in STEMS}; F["voc"] = []
    for i in range(nb):
        a, b = int(edges[i] * hz), max(int(edges[i] * hz) + 1, int(edges[i + 1] * hz))
        for s in STEMS:
            F[s].append(float(10 * np.log10(np.mean(10 ** (stem_db[s][a:b] / 10)) + 1e-12)))
        F["voc"].append(float(act[a:b].mean()) if b > a else 0.0)
    # harmonic chroma per bar (other + bass stems), and vocal timbre (MFCC) per bar
    hop = 2048
    ch = librosa.feature.chroma_stft(y=harm, sr=SR, hop_length=hop, n_fft=8192)
    mf = librosa.feature.mfcc(y=mono, sr=SR, hop_length=hop, n_mfcc=13)
    fr = lambda t: int(t * SR / hop)
    chroma, mfcc = [], []
    for i in range(nb):
        a, b = fr(edges[i]), max(fr(edges[i]) + 1, fr(edges[i + 1]))
        c = ch[:, a:b].mean(1); chroma.append(c / (c.max() + 1e-9))
        mfcc.append(mf[:, a:b].mean(1))
    return F, np.array(chroma), np.array(mfcc)


def segment(F, chroma, mfcc, bars_t, dur, nov_k=4):
    """Section boundaries (in musical bars) from stem presence + timbre/harmony novelty."""
    nb = len(bars_t)
    pres = np.array([F["voc"], F["drums"], F["bass"], F["other"]]).T
    z = (pres - pres.mean(0)) / (pres.std(0) + 1e-6)
    zm = (mfcc - mfcc.mean(0)) / (mfcc.std(0) + 1e-6)
    X = np.hstack([z * 1.5, zm * 0.5, chroma * 1.0])
    D = np.sqrt(((X[:, None, :] - X[None, :, :]) ** 2).sum(-1))
    S = np.exp(-D / (np.median(D) + 1e-9))
    nov = np.zeros(nb)
    k = nov_k
    sign = np.ones((2 * k, 2 * k)); sign[:k, k:] = -1; sign[k:, :k] = -1
    for i in range(k, nb - k + 1):
        nov[i] = max(0, (S[i - k:i + k, i - k:i + k] * sign).sum())
    nov = nov / (nov.max() + 1e-9)
    # presence-change boundaries (drums / vocals / bass switch on or off for >= 2 bars)
    on = pres > (pres.max(0) - 15)
    pc = np.zeros(nb)
    for i in range(1, nb - 1):
        for j in range(on.shape[1]):
            if on[i, j] != on[i - 1, j] and on[i, j] == on[min(nb - 1, i + 1), j]:
                pc[i] += [1.0, 0.8, 0.6, 0.4][j]
    strength = np.clip(nov + 0.5 * pc, 0, None)
    cand = [i for i in range(2, nb - 1) if strength[i] >= strength[i - 1] and strength[i] >= strength[i + 1] and strength[i] > 0.35]
    cand.sort(key=lambda i: -strength[i])
    bounds = [0]
    for c in cand:
        if all(abs(c - b) >= 4 for b in bounds):
            bounds.append(c)
    bounds = sorted(bounds) + [nb]
    # prefer boundaries on 4-bar phrase positions relative to the first strong boundary
    return bounds, strength, S


def label_sections(bounds, F, S, bars_t, dur, lines):
    nb = len(bars_t)
    loud = np.array([10 * np.log10(sum(10 ** (F[s][i] / 10) for s in STEMS)) for i in range(nb)])
    secs = []
    for a, b in zip(bounds[:-1], bounds[1:]):
        if b <= a:
            continue
        v = float(np.mean(F["voc"][a:b])); bs = float(np.mean(F["bass"][a:b]))
        d = float(10 * np.log10(np.mean([10 ** (F["drums"][i] / 10) + 10 ** (F["bass"][i] / 10) for i in range(a, b)])))  # the beat: drums + 808/bass
        secs.append(dict(b0=a, b1=b, t0=float(bars_t[a]), t1=float(bars_t[b]) if b < nb else float(dur),
                         vocals=v, drums_db=d, bass_db=bs, loud_db=float(np.mean(loud[a:b]))))
    dmax = max(s["drums_db"] for s in secs); lmax = max(s["loud_db"] for s in secs)
    # repetition: best diagonal similarity with any other section
    for i, s in enumerate(secs):
        L = s["b1"] - s["b0"]; best = 0
        for j, o in enumerate(secs):
            if j == i:
                continue
            Lo = o["b1"] - o["b0"]; m = min(L, Lo)
            if m < 2:
                continue
            for off in range(0, max(1, Lo - m + 1)):
                diag = np.mean([S[s["b0"] + q, o["b0"] + off + q] for q in range(m)])
                best = max(best, diag)
        s["rep"] = float(best)
    reps = sorted(s["rep"] for s in secs)
    rep_hi = max(0.6, reps[int(0.75 * (len(reps) - 1))]) if reps else 1
    for i, s in enumerate(secs):
        drums_on = s["drums_db"] > dmax - 10
        quiet = s["loud_db"] < lmax - 6
        if i == 0 and (not drums_on or s["vocals"] < 0.25):
            s["label"] = "intro"
        elif i == len(secs) - 1 and (not drums_on or s["vocals"] < 0.25 or quiet):
            s["label"] = "outro"
        elif not drums_on:
            s["label"] = "breakdown"
        elif s["vocals"] < 0.2:
            s["label"] = "instrumental"
        elif s["rep"] >= rep_hi and s["loud_db"] >= lmax - 3:
            s["label"] = "hook"
        else:
            s["label"] = "verse"
    return secs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--spotify-bpm", type=float, default=None)
    ap.add_argument("--key", default="")
    ap.add_argument("--name", default=None)
    ap.add_argument("--stems", default=None, help="folder to read/write stems (default: next to output)")
    ap.add_argument("--out", default=".")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    name = a.name or os.path.splitext(os.path.basename(a.audio))[0]
    mix = load_audio(a.audio)
    dur = len(mix) / SR
    mono = mix.mean(1)
    log(name, f"{dur:.1f}s")
    stems = get_stems(a.audio, mix, a.stems or os.path.join(a.out, "stems"))
    n = min(len(mix), *(len(v) for v in stems.values()))
    stems = {s: v[:n].mean(1) for s, v in stems.items()}

    log("beat tracking (Beat This!)…")
    pb, pd = beat_frames(mono)
    G = fit_grid(pb, pd, dur, a.spotify_bpm)
    per = G["period"]
    log(f"beat {60/per:.2f} BPM, grid fit {G['fit']:.2f}, drift {G['drift_ms']:.0f} ms")
    # musical bars (4 beats) from the first downbeat
    t_db = G["t_db"]
    while t_db - 4 * per >= -0.02:
        t_db -= 4 * per
    t_db = max(0.0, t_db)
    bars_t = np.arange(t_db, dur - per, 4 * per)

    stem_db = {s: rms_db(stems[s], STEM_HZ) for s in STEMS}
    act, lines, blocks, vref = vocal_activity(stem_db["vocals"], STEM_HZ)
    harm = stems["other"] + stems["bass"]
    F, chroma, mfcc = bar_features(stem_db, act, STEM_HZ, bars_t, dur, harm, mono)
    bounds, strength, S = segment(F, chroma, mfcc, bars_t, dur)
    secs = label_sections(bounds, F, S, bars_t, dur, lines)

    # landmarks
    mix_db = rms_db(mono, STEM_HZ)
    thr = mix_db.max() - 24
    above = np.where(mix_db > thr)[0]
    sound_start, sound_end = float(above[0] / STEM_HZ), float((above[-1] + 1) / STEM_HZ)
    ddb = stem_db["drums"]; dref = np.percentile(ddb, 95)
    d_on = np.convolve((ddb > dref - 15).astype(float), np.ones(STEM_HZ) / STEM_HZ, "same") > 0.6
    drums_in = float(np.argmax(d_on) / STEM_HZ) if d_on.any() else None
    # drawing envelope (mixture bands, like Spotify's coloured waveform)
    sos_l = butter(4, 200, "lowpass", fs=SR, output="sos"); sos_h = butter(4, 2500, "highpass", fs=SR, output="sos")
    sos_m = butter(2, [200, 2500], "bandpass", fs=SR, output="sos")
    env = {}
    for k, sig in [("full", mono), ("low", sosfiltfilt(sos_l, mono)), ("mid", sosfiltfilt(sos_m, mono)), ("high", sosfiltfilt(sos_h, mono))]:
        e = peak_env(sig, ENV_HZ); env[k] = b64u8(np.clip(255 * e / (np.percentile(e, 99.5) + 1e-9), 0, 255))

    out = {
        "schema": "sangam-analysis/1",
        "name": name, "duration": dur,
        "spotify": {"bpm": a.spotify_bpm, "key": a.key},
        "grid": {"beat": per, "bpm": 60 / per, "downbeat": t_db, "fit": G["fit"], "drift_ms": G["drift_ms"],
                 "downbeat_strength": G["downbeat_strength"]},
        "sound": {"start": sound_start, "end": sound_end},
        "stems": {"hz": STEM_HZ, "enc": "u8 = (dBFS+90)*2.5", **{s: b64u8(db_to_u8(stem_db[s])) for s in STEMS},
                  "mix": b64u8(db_to_u8(mix_db))},
        "vocal": {"ref_db": vref, "lines": [[round(x, 2), round(y, 2)] for x, y in lines],
                  "blocks": [[round(x, 2), round(y, 2)] for x, y in blocks]},
        "bars": {"t0": [round(float(t), 3) for t in bars_t], "boundary": [round(float(x), 3) for x in strength],
                 "chroma": b64u8(np.round(255 * np.clip(chroma, 0, 1)).ravel())},
        "sections": [{k: (round(v, 3) if isinstance(v, float) else v) for k, v in s.items()} for s in secs],
        "landmarks": {"first_vocal": lines[0][0] if lines else None, "last_vocal": lines[-1][1] if lines else None,
                      "drums_in": drums_in},
        "env": {"hz": ENV_HZ, **env},
    }
    path = os.path.join(a.out, name + ".sangam.json")
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    log("wrote", path, f"{os.path.getsize(path)//1024} KB")
    for s in secs:
        m = lambda t: f"{int(t//60)}:{t%60:04.1f}"
        log(f"  {m(s['t0'])}–{m(s['t1'])}  {s['label']:<12} vocals {s['vocals']:.2f}  rep {s['rep']:.2f}")


if __name__ == "__main__":
    main()
