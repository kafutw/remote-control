#!/usr/bin/env python3
"""雪山隧道車道選擇：抓高公局 VD（車輛偵測器）分車道車速。

目前只有 --probe：印出資料來源的格式與 CORS 標頭，給寫解析邏輯時對照。
"""
import gzip
import io
import sys
import urllib.request
import xml.etree.ElementTree as ET

BASE = "https://tisvcloud.freeway.gov.tw/history/motc20/"
ORIGIN = "https://kafutw.github.io"


def fetch(url):
    req = urllib.request.Request(url, headers={"Origin": ORIGIN, "User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        body = r.read()
        headers = dict(r.headers)
    if body[:2] == b"\x1f\x8b":
        body = gzip.decompress(body)
    return body, headers


def strip_ns(root):
    for el in root.iter():
        if "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]
    return root


def show(el, limit=3000):
    s = ET.tostring(el, encoding="unicode")
    print(s[:limit])


def probe():
    for name in ["VD.xml", "VD.xml.gz", "VDLive.xml", "VDLive.xml.gz", "Section.xml",
                 "LiveTraffic.xml", "SectionLink.xml"]:
        url = BASE + name
        try:
            body, h = fetch(url)
            print(f"✓ {name}: {len(body)} bytes, type={h.get('Content-Type')}, "
                  f"ACAO={h.get('Access-Control-Allow-Origin')}, cache={h.get('Cache-Control')}, "
                  f"last-mod={h.get('Last-Modified')}")
        except Exception as e:
            print(f"✗ {name}: {e}")
    for url in ["https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/Live/VD/Freeway?$top=1&$format=JSON"]:
        try:
            body, h = fetch(url)
            print(f"✓ TDX: {body[:300]!r} ACAO={h.get('Access-Control-Allow-Origin')}")
        except Exception as e:
            print(f"✗ TDX: {e}")

    print("\n===== VD.xml：國5 的 VD =====")
    vd = strip_ns(ET.fromstring(fetch(BASE + "VD.xml")[0]))
    print("root:", vd.tag, [c.tag for c in vd][:8])
    n5 = []
    for v in vd.iter("VD"):
        text = ET.tostring(v, encoding="unicode")
        if "國道5號" in text or "-N5-" in (v.findtext("VDID") or ""):
            n5.append(v)
    print("國5 VD 數量:", len(n5))
    if n5:
        show(n5[0])
    for v in n5:
        print(v.findtext("VDID"), "|", v.findtext("RoadDirection"), "|", v.findtext("LocationMile"),
              "|", v.findtext("RoadSection/Start"), "→", v.findtext("RoadSection/End"),
              "| lanes:", [ (l.findtext("LaneID"), l.findtext("LaneType")) for l in v.iter("Lane")],
              "| links:", [l.findtext("LinkID") for l in v.iter("DetectionLink")][:3],
              "| bidir", v.findtext("BiDirectional"))
    ids = {v.findtext("VDID") for v in n5}

    print("\n===== VDLive.xml：國5 =====")
    live = strip_ns(ET.fromstring(fetch(BASE + "VDLive.xml")[0]))
    print("root:", live.tag, [c.tag for c in live][:8])
    for child in live:
        if child.tag not in ("VDLives",):
            print(child.tag, "=", (child.text or "").strip()[:80])
    shown = 0
    for v in live.iter("VDLive"):
        vid = v.findtext("VDID")
        if vid not in ids:
            continue
        if shown < 2:
            show(v)
            shown += 1
        lanes = []
        for ln in v.iter("Lane"):
            vols = [(x.findtext("VehicleType"), x.findtext("Volume"), x.findtext("Speed")) for x in ln.iter("Vehicle")]
            lanes.append((ln.findtext("LaneID"), ln.findtext("LaneType"), ln.findtext("Speed"), ln.findtext("Occupancy"), vols))
        print(vid, v.findtext("Status"), v.findtext("DataCollectTime"), lanes)

    print("\n===== Section.xml：國5 =====")
    sec = strip_ns(ET.fromstring(fetch(BASE + "Section.xml")[0]))
    secs = [s for s in sec.iter("Section") if "國道5號" in ET.tostring(s, encoding="unicode")]
    if secs:
        show(secs[0])
    for s in secs:
        print(s.findtext("SectionID"), s.findtext("SectionName"), s.findtext("RoadDirection"),
              s.findtext("SectionMile/StartKM"), s.findtext("SectionMile/EndKM"), s.findtext("SectionLength"))
    sids = {s.findtext("SectionID") for s in secs}

    print("\n===== LiveTraffic.xml：國5 =====")
    lt = strip_ns(ET.fromstring(fetch(BASE + "LiveTraffic.xml")[0]))
    shown = 0
    for t in lt.iter("LiveTraffic"):
        if t.findtext("SectionID") in sids:
            if shown < 1:
                show(t)
                shown += 1
            print(t.findtext("SectionID"), t.findtext("TravelTime"), t.findtext("TravelSpeed"),
                  t.findtext("CongestionLevel"), t.findtext("DataCollectTime"))


if __name__ == "__main__":
    if "--probe" in sys.argv:
        probe()
    else:
        print(__doc__)
