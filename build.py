"""Assemble dist/index.html (single file) from src/. Usage: python3 build.py [--no-demo]"""
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
shell = open(f"{here}/src/shell.html").read()
opts = open(f"{here}/src/spotify_mix_options.json").read()
demo_path = f"{here}/src/demo.json"
demo = open(demo_path).read() if (os.path.exists(demo_path) and "--no-demo" not in sys.argv) else "null"
app = open(f"{here}/src/app.js").read().replace("/*DEEP*/", open(f"{here}/src/deep.js").read())
import glob
lib = [json.load(open(f)) for f in sorted(glob.glob(f"{here}/src/deep/*.sangam.json"))]
deeplib = json.dumps(lib, separators=(",", ":"))
body = shell.replace("/*OPTIONS*/null", json.dumps(json.loads(opts), separators=(",", ":"))).replace("/*DEMO*/null", demo).replace("/*DEEPLIB*/[]", deeplib).replace("/*APP*/", app)
os.makedirs(f"{here}/dist", exist_ok=True)
# artifact version: body only (the host wraps it). Vercel version: full document.
open(f"{here}/dist/artifact.html", "w").write(body)
head_end = body.index("</style>") + len("</style>")
full = ("<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n"
        + body[:head_end] + "\n</head>\n<body>\n" + body[head_end:] + "\n</body>\n</html>\n")
open(f"{here}/dist/index.html", "w").write(full)
print("built", len(full) // 1024, "KB")
