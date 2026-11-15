#!/usr/bin/env python3
"""Build the CoinPosh progress dashboard datasets from the repo.

Usage: gen.py <repo> <out_dir> <phase> <detail>
"""
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

repo, out, phase, detail = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3], sys.argv[4]
out.mkdir(parents=True, exist_ok=True)
plan = repo / "docs" / "plan"
now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sh(*cmd):
    return subprocess.run(cmd, cwd=repo, capture_output=True, text=True, check=True).stdout.strip()


roadmap = (plan / "04-ROADMAP.md").read_text()
status_md = (plan / "STATUS.md").read_text()
polish_path = plan / "POLISH.md"
polish_md = polish_path.read_text() if polish_path.exists() else ""

states = {}
for m in re.finditer(r"^\|\s*([TH]-\d+\.\d+)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|", status_md, re.M):
    states[m.group(1)] = m.group(2) or "todo"

tasks = []
milestone, milestone_name = None, None
lines = roadmap.splitlines()
for i, line in enumerate(lines):
    mh = re.match(r"^## (M\d+): ([^(]+?)\s*(\(.*)?$", line)
    if mh:
        milestone, milestone_name = mh.group(1), mh.group(2).strip()
        continue
    th = re.match(r"^### ([TH]-\d+\.\d+) · (.+)$", line)
    if not th or not milestone:
        continue
    tid, rest = th.group(1), th.group(2)
    title = rest.split(" — ")[0].strip()
    if tid.startswith("H-"):
        title = re.sub(r"^Human:\s*", "", title)
    block = rest + "\n" + "\n".join(lines[i + 1:i + 6])
    agent = re.search(r"\*\*agent:\*\*\s*([\w-]+)", block)
    deps = re.search(r"\*\*deps:\*\*\s*([^\n—]+)", block)
    raw = states.get(tid, "todo")
    state = raw.split("(")[0].strip()
    tasks.append({
        "id": tid,
        "title": title,
        "milestone": milestone,
        "milestone_name": milestone_name,
        "kind": "human" if tid.startswith("H-") else "agent",
        "agent": agent.group(1) if agent else ("you" if tid.startswith("H-") else ""),
        "deps": deps.group(1).strip() if deps else "none",
        "state": state,
        "reason": raw[len(state):].strip(" ()"),
    })

done_ids = {t["id"] for t in tasks if t["state"] == "done"}
for t in tasks:
    if t["state"] == "todo":
        dep_ids = re.findall(r"[TH]-\d+\.\d+", t["deps"])
        span = re.search(r"([TH])-(\d+)\.(\d+)\s*…\s*[TH]-\d+\.(\d+)", t["deps"])
        if span:
            p, ms, lo, hi = span.group(1), span.group(2), int(span.group(3)), int(span.group(4))
            dep_ids += [f"{p}-{ms}.{n:02d}" for n in range(lo, hi + 1)]
        t["ready"] = all(d in done_ids for d in dep_ids)
    else:
        t["ready"] = False
    if t["state"] == "done":
        t["group"] = "done"
    elif t["state"] == "blocked" or (t["kind"] == "human" and t["ready"]):
        t["group"] = "blocked"
    elif t["state"] in ("in_progress", "review"):
        t["group"] = "active"
    else:
        t["group"] = "ready" if t["ready"] else "waiting"

waves = []
for m in re.finditer(r"^- wave (\d+) · (\S+) · ([^·]+) · (.+)$", status_md, re.M):
    rej = re.search(r"(\d+) rejected", m.group(4))
    waves.append({
        "wave": int(m.group(1)),
        "date": m.group(2),
        "tasks": m.group(3).strip(),
        "task_count": len(re.findall(r"[TP]-[\d.]+", m.group(3))),
        "rejected": int(rej.group(1)) if rej else 0,
        "result": m.group(4).strip(),
    })

polish = []
for m in re.finditer(r"^- \[(\w+)\] (P-\d+) · (.+?) · agent: ([\w-]+)", polish_md, re.M):
    polish.append({"id": m.group(2), "title": re.sub(r"\s*\(raised by.*?\)", "", m.group(3)), "status": m.group(1), "agent": m.group(4)})

prs = json.loads(sh("gh", "pr", "list", "--state", "all", "--limit", "50", "--json", "number,title,state,mergedAt,createdAt,url"))
prs = [{"number": p["number"], "title": p["title"], "state": p["state"].lower(), "created": p["createdAt"], "merged": p["mergedAt"] or "", "url": p["url"]} for p in prs]

state_path = Path(__file__).with_name("state.json")
state = json.loads(state_path.read_text()) if state_path.exists() else {"wave_starts": {}}
current_wave = max((w["wave"] for w in waves), default=0) + 1
if phase == "running" and str(current_wave) not in state["wave_starts"]:
    state["wave_starts"][str(current_wave)] = now
state_path.write_text(json.dumps(state, indent=1))


def iso(t):
    return datetime.fromisoformat(t).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


ms_of = {t["id"]: t["milestone"] for t in tasks}
timeline = []
commits = sh("git", "log", "--all", "--reverse", "--format=%cI%x09%s").splitlines()
wave_ends = []
seen = set()
for line in commits:
    at, subject = line.split("\t", 1)
    at = iso(at)
    m = re.match(r"^Merge task/([TP]-[\d.]+)", subject)
    if m:
        key = ("merge", m.group(1))
        if key not in seen:
            seen.add(key)
            timeline.append({"at": at, "end": "", "lane": "Tasks", "kind": "merge", "id": m.group(1), "label": f"{m.group(1)} merged", "milestone": ms_of.get(m.group(1), "")})
        continue
    if subject.startswith("wave: "):
        wave_ends.append(at)
        continue
    m = re.match(r"^([TP]-[\d.]+): (.+)$", subject)
    if m:
        k = "fix" if m.group(2).startswith("address review") else "build"
        key = (k, m.group(1), m.group(2))
        if key in seen:
            continue
        seen.add(key)
        timeline.append({"at": at, "end": "", "lane": "Tasks", "kind": k, "id": m.group(1),
                         "label": f"{m.group(1)} review fixes" if k == "fix" else f"{m.group(1)} built: {m.group(2)}", "milestone": ms_of.get(m.group(1), "")})
for t in tasks:
    if t["kind"] == "human" and t["state"] == "done":
        hit = sh("git", "log", "--all", "--reverse", f"--grep={t['id']}", "--format=%cI")
        if hit:
            timeline.append({"at": iso(hit.splitlines()[0]), "end": "", "lane": "Your steps", "kind": "human", "id": t["id"], "label": f"{t['id']} {t['title']}", "milestone": t["milestone"]})
for n, start in sorted(state["wave_starts"].items(), key=lambda kv: int(kv[0])):
    i = int(n)
    end = wave_ends[i - 1] if i - 1 < len(wave_ends) else ""
    names = next((w["tasks"] for w in waves if w["wave"] == i), "")
    timeline.append({"at": start, "end": end, "lane": "Waves", "kind": "wave", "id": f"W{i}", "label": f"Wave {i}" + (f": {names}" if names else " (running)"), "milestone": ""})
for p in prs:
    timeline.append({"at": iso(p["merged"] or p["created"]), "end": "", "lane": "Pull requests", "kind": "pr_" + p["state"], "id": f"#{p['number']}", "label": f"#{p['number']} {p['title']}", "milestone": ""})
timeline.sort(key=lambda e: e["at"])

loop = [{
    "phase": phase,
    "detail": detail,
    "updated": now,
    "branch": sh("git", "rev-parse", "--abbrev-ref", "HEAD"),
    "head": sh("git", "rev-parse", "--short", "HEAD"),
    "wave": current_wave,
    "started": min(state["wave_starts"].values()) if state["wave_starts"] else now,
}]

for name, rows in {"tasks": tasks, "timeline": timeline, "waves": waves, "polish": polish, "prs": prs, "loop": loop}.items():
    (out / f"{name}.json").write_text(json.dumps(rows, indent=1, ensure_ascii=False))
print(json.dumps({"tasks": len(tasks), "done": len(done_ids), "waves": len(waves), "polish": len(polish), "prs": len(prs)}))
