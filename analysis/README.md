# Deep analysis (run once per song)

`deep_analyse.py` listens to a song properly and writes `<song>.sangam.json` for the web app:

- **Demucs (htdemucs)** separates vocals, drums, bass and the rest; their loudness is stored every 50 ms.
- **Beat This!** (CPJKU, ISMIR 2024) gives beat and downbeat probabilities; a straight-line fit through
  them gives a constant-tempo grid accurate to a few milliseconds.
- Vocal lines (split at breaths), sections, beat stops, harmony (chroma) per bar and a waveform envelope.

No audio is stored in the JSON, only measurements (~70–100 KB per song).

## Setup on a Mac (M1 is fine)

```bash
brew install ffmpeg python@3.12
python3 -m pip install -r analysis/requirements.txt
```

First run downloads the Demucs (~80 MB) and Beat This! (~80 MB) model weights.

## Use

```bash
python3 analysis/deep_analyse.py ~/Music/song.m4a --spotify-bpm 60 --key 10A --out ~/Desktop/sangam
```

`--spotify-bpm` / `--key` are what Spotify shows in Mix mode (optional; you can also type them on the page).
Takes about 1–3 minutes per song (stems are cached in `--out/stems`, so re-runs take ~30 s).

Then on the page: load the song as usual and press **Add analysis files** (or drop the `.sangam.json` with the song).
The page recognises the song by its loudness fingerprint and switches from the quick estimate to the measured planner.

To build a song into the site for everyone, copy its JSON into `src/deep/` and run `python3 build.py`.
