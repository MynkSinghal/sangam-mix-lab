# Sangam Mix Lab

Plan Spotify Mix transitions for any two songs, measured from the songs themselves.

## Two levels of analysis

**Deep (measured).** A song with a `.sangam.json` from [`analysis/deep_analyse.py`](analysis/README.md) has AI-separated
vocal / drum / bass / melody stems, a Beat This! beat grid, breath-split vocal lines, sections and harmony per bar.
The planner then tries every window position, length (2/4/8 bars), preset and verified menu option and *measures* each one:

- seconds where both songs' **voices** are audible at once (including an echo/reverb tail)
- seconds of **two basslines** at once, and doubled drums when tempos differ
- whether a **line gets cut mid-word**, or the next song cuts in mid-line
- whether the window starts and ends on a **phrase line** in both songs
- **loudness** dip/bump through the switch, **harmonic match** of what overlaps
- how much of each song's **vocals get skipped**, and whether the next song's vocals start right as the window ends

Candidates that break a rule (voices or basslines overlapping > 1 s, a cut line, off-phrase start, a > 6 dB dip) rank below
ones that don't. Every reason shown on the page is one of these measurements.

Songs are recognised automatically by loudness fingerprint, so you load the audio as usual; built-in analyses live in `src/deep/`.

**Quick (estimate).** Any other song gets the older in-browser analysis (frequency bands, no stems). It's labelled as an estimate.

Audio never leaves the device; the JSON files hold measurements only.

## Develop

```bash
python3 build.py            # writes dist/index.html (full page) and dist/artifact.html
cp dist/index.html index.html
```

- `src/deep.js` deep-analysis loader, Spotify bar grid, measured planner, explanations
- `src/app.js` quick analysis, curves, rendering, UI (deep.js is inserted at `/*DEEP*/`)
- `src/shell.html` markup and styles
- `src/deep/*.sangam.json` built-in analyses
- `src/spotify_mix_options.json` model of Spotify's Mix menus (`seen: false` = inferred from the name; the planner only uses verified options)
- `analysis/` the Python analyser
