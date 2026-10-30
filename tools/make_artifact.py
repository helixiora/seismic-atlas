"""Generate the claude.ai Artifact page from webapp/index.html.

The Artifact skeleton supplies <!doctype>/<html>/<head>/<body>, only allows
scripts from a short CDN list, and wants CSS inline. Everything else (js/, data/)
is published alongside as supporting files.
"""
import os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
root = os.path.join(HERE, "..", "webapp")
if not os.path.isdir(root):  # flat layout (the GitHub repo): the site is the repo root
    root = os.path.join(HERE, "..")
out_dir = sys.argv[1]
html = open(os.path.join(root, "index.html")).read()
css = open(os.path.join(root, "css", "style.css")).read()

head = re.search(r"<head>(.*?)</head>", html, re.S).group(1)
body = re.search(r"<body>(.*?)</body>", html, re.S).group(1)
head = re.sub(r"<title>.*?</title>", "<title>Seismic Atlas</title>", head, flags=re.S)
head = re.sub(r"<meta charset[^>]*>\s*", "", head)
head = re.sub(r"<meta name=\"viewport\"[^>]*>\s*", "", head)
head = re.sub(r"<link rel=\"stylesheet\" href=\"css/style.css[^\"]*\" />", f"<style>\n{css}\n</style>", head)
head = head.replace("https://unpkg.com/three@0.160.0/", "https://cdn.jsdelivr.net/npm/three@0.160.0/")
body = re.sub(r"\?v=\d+", "", body)

os.makedirs(out_dir, exist_ok=True)
open(os.path.join(out_dir, "index.html"), "w").write(head.strip() + "\n" + body.strip() + "\n")
print("wrote", os.path.join(out_dir, "index.html"))
