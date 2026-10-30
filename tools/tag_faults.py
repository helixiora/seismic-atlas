"""Tag the GEM segments that make up the North / East Anatolian Fault trunks.

faults.json comes from the GEM Global Active Faults export filtered to dextral
strike-slip faults in Anatolia (unnamed). NAF = high slip-rate dextral trunk;
EAF = the dextral chain from Karliova SW towards Maras/Antakya (picked by
position). Everything else stays a secondary fault.
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(HERE, "..", "webapp")
if not os.path.isdir(SITE):  # flat layout (the GitHub repo): the site is the repo root
    SITE = os.path.join(HERE, "..")
path = os.path.join(SITE, "data", "turkey", "faults.json")
faults = json.load(open(path))
EAF_BOX = (37.3, 41.9, 37.2, 39.2)  # lon0, lon1, lat0, lat1 (centroid test)
for s in faults:
    lons = [p[0] for p in s["coords"]]
    lats = [p[1] for p in s["coords"]]
    clon, clat = sum(lons) / len(lons), sum(lats) / len(lats)
    rate = s["rate"] or 0
    if rate >= 10:
        s["system"] = "NAF"
    elif EAF_BOX[0] <= clon <= EAF_BOX[1] and EAF_BOX[2] <= clat <= EAF_BOX[3] and "Dextral" in s["slip_type"] and clat < 39.25 and not (clon > 40.2 and clat > 39.0):
        s["system"] = "EAF"
    else:
        s["system"] = "other"
json.dump(faults, open(path, "w"))
print({k: sum(1 for s in faults if s["system"] == k) for k in ("NAF", "EAF", "other")})
