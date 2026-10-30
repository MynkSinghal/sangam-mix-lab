# Sangam Mix Lab

Plan Spotify Mix transitions for any two songs. Load the song that's ending and the next one (MP3/M4A/WAV); the page:

- finds the beat grid, Spotify-length bars (from the BPM Spotify shows), sections, sound start/end and the next song's drum entry;
- searches every preset, menu option (Volume, EQ, Filter, Effects, Looping), length (2/4/8 bars) and position;
- shows the best transitions in a replica of Spotify's editor (overview strips with the window bracket, 3-band waveforms, bar ticks, lane arrows) with an audio preview rendered in the browser;
- gives step-by-step instructions to recreate it in Spotify.

Everything runs locally in the browser. Audio never leaves the device.

## Develop

```bash
python3 build.py            # writes dist/index.html (full page) and dist/artifact.html
cp dist/index.html index.html
```

- `src/app.js` analysis, scoring, search, rendering, UI
- `src/shell.html` markup and styles
- `src/spotify_mix_options.json` model of Spotify's Mix menus (curves traced from editor screenshots; `seen: false` = inferred from the name)
- `src/demo.json` bundled example analysis (no audio)
