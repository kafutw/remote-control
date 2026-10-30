#!/usr/bin/env python3
"""雪山隧道車道選擇：探測交通部 TDX 的國 5 VD（車輛偵測器）資料。

高公局 tisvcloud 從 GitHub runner（美國機房）連不上；TDX 連得上、免金鑰、
回 Access-Control-Allow-Origin: *，所以頁面可以直接從手機抓 TDX。
這支只用來印出格式，給寫頁面時對照。
"""
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

TDX = "https://tdx.transportdata.tw/api/basic/v2/Road/Traffic/"


def get(path, **params):
    params.setdefault("$format", "JSON")
    url = TDX + path + "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote, safe="$,'()")
    t0 = time.time()
    req = urllib.request.Request(url, headers={"Origin": "https://kafutw.github.io"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read()
            h = {k: v for k, v in r.headers.items()
                 if k.lower().startswith(("x-", "access-control", "ratelimit", "retry", "cache"))}
            print(f"\n### {url}\n    {r.status} {len(body)} bytes {time.time()-t0:.1f}s headers={h}")
            return json.loads(body)
    except urllib.error.HTTPError as e:
        print(f"\n### {url}\n    HTTP {e.code} {e.read()[:500]!r} headers={dict(e.headers)}")
    except Exception as e:
        print(f"\n### {url}\n    {e!r}")
    return None


def items(d, key):
    if isinstance(d, dict):
        return d.get(key, [])
    return d or []


def lanes_of(v):
    out = []
    for lf in v.get("LinkFlows", []):
        for ln in lf.get("Lanes", []):
            out.append((ln.get("LaneID"), ln.get("LaneType"), ln.get("Speed"), ln.get("Occupancy"),
                        [(x.get("VehicleType"), x.get("Volume"), x.get("Speed")) for x in ln.get("Vehicles", [])]))
    return out


def probe():
    vd = get("VD/Freeway", **{"$filter": "contains(VDID,'-N5-')"})
    vds = items(vd, "VDs")
    print("國5 VD 數量:", len(vds))
    if vds:
        print(json.dumps(vds[0], ensure_ascii=False)[:2500])
    for v in sorted(vds, key=lambda v: (v.get("RoadDirection") or "", v.get("VDID"))):
        print("VD", v.get("VDID"), "|", v.get("RoadDirection"), "|", v.get("LocationMile"), "|",
              v.get("PositionLat"), v.get("PositionLon"), "|", json.dumps(v.get("RoadSection"), ensure_ascii=False),
              "| type", v.get("VDType"), "| lanes", [(d.get("LinkID"), d.get("LaneNum")) for d in v.get("DetectionLinks", [])][:2])

    live = get("Live/VD/Freeway", **{"$filter": "contains(VDID,'-N5-')"})
    lives = items(live, "VDLives")
    print("國5 VDLive 數量:", len(lives), "UpdateTime", isinstance(live, dict) and live.get("UpdateTime"),
          "SrcUpdateTime", isinstance(live, dict) and live.get("SrcUpdateTime"))
    if lives:
        print(json.dumps(lives[0], ensure_ascii=False)[:3000])
    for v in sorted(lives, key=lambda v: v.get("VDID")):
        print("LIVE", v.get("VDID"), v.get("Status"), v.get("DataCollectTime"), lanes_of(v))

    sel = get("Live/VD/Freeway", **{"$filter": "contains(VDID,'-N5-')", "$select": "VDID,LinkFlows,DataCollectTime"})
    print("加 $select 後:", len(json.dumps(sel)) if sel else None)

    sec = get("Section/Freeway", **{"$filter": "contains(SectionName,'坪林') or contains(SectionName,'頭城')"})
    secs = items(sec, "Sections")
    if secs:
        print(json.dumps(secs[0], ensure_ascii=False)[:1500])
    for s in secs:
        print("SEC", s.get("SectionID"), s.get("SectionName"), s.get("RoadDirection"),
              json.dumps(s.get("SectionMile"), ensure_ascii=False), s.get("SectionLength"))
    ids = [s.get("SectionID") for s in secs]
    if ids:
        lt = get("Live/Freeway", **{"$filter": " or ".join(f"SectionID eq '{i}'" for i in ids)})
        for t in items(lt, "LiveTraffics"):
            print("LT", json.dumps(t, ensure_ascii=False))

    # 隧道內的可變資訊標誌（CMS）：高公局會在上面打慢速車的車牌
    cms = get("CMS/Freeway", **{"$filter": "contains(CMSID,'N5')"})
    cl = items(cms, "CMSs")
    print("國5 CMS 數量:", len(cl))
    if cl:
        print(json.dumps(cl[0], ensure_ascii=False)[:1500])
    for c in cl:
        print("CMS", c.get("CMSID"), c.get("RoadDirection"), c.get("LocationMile"),
              c.get("PositionLat"), c.get("PositionLon"), json.dumps(c.get("RoadSection"), ensure_ascii=False))
    cmslive = get("Live/CMS/Freeway", **{"$filter": "contains(CMSID,'N5')"})
    lv = items(cmslive, "CMSLives")
    print("國5 CMSLive 數量:", len(lv))
    for c in lv:
        print("CMSLIVE", json.dumps(c, ensure_ascii=False)[:600])


if __name__ == "__main__":
    if "--probe" in sys.argv:
        probe()
    else:
        print(__doc__)
