#!/usr/bin/env python3
"""Seed a fully-populated Plane project from a JSON manifest.

Idempotent: safe to re-run. Issues are upserted via PUT keyed on
external_id + external_source; labels/modules/cycles tolerate duplicate
responses (409-with-id, or 400 MODULE_NAME_ALREADY_EXISTS) and every
created/resolved id is cached in a state file next to the manifest so a
mid-run failure resumes cleanly.

Usage:
  seed-plane-project.py MANIFEST.json [--dry-run | --verify-only | --delete-project]
"""
import argparse
import json
import os
import re
import sys
import time
from datetime import date
from pathlib import Path

import requests

ENV_FILE = Path("/home/deployer/underwings/.env")
MIN_INTERVAL = 1.1  # seconds between requests; key limit is 60/minute


def get_env(name, default=None):
    if os.environ.get(name):
        return os.environ[name]
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line.startswith(f"{name}="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return default


# --- markdown -> Plane-safe HTML (h3/p/ul/li/strong/code survive nh3) ------

def _inline(s):
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    return s


def md_to_html(md):
    out = []
    for block in re.split(r"\n\s*\n", md.strip()):
        lines = [l.rstrip() for l in block.split("\n") if l.strip()]
        if not lines:
            continue
        if lines[0].startswith("### "):
            out.append(f"<h3>{_inline(lines[0][4:])}</h3>")
            lines = lines[1:]
        if not lines:
            continue
        if all(l.lstrip().startswith("- ") for l in lines):
            items = "".join(f"<li>{_inline(l.lstrip()[2:])}</li>" for l in lines)
            out.append(f"<ul>{items}</ul>")
        else:
            out.append(f"<p>{_inline(' '.join(lines))}</p>")
    return "".join(out)


# --- API client ------------------------------------------------------------

class Plane:
    def __init__(self, base, slug, token):
        self.api = f"{base.rstrip('/')}/api/v1/workspaces/{slug}"
        self.s = requests.Session()
        self.s.headers.update({"X-API-Key": token, "Content-Type": "application/json"})
        self._last = 0.0
        self.calls = 0

    def req(self, method, path, body=None, ok_codes=(200, 201, 204)):
        url = self.api + path
        for attempt in range(4):
            wait = MIN_INTERVAL - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            self.calls += 1
            r = self.s.request(method, url, json=body, timeout=60)
            if r.status_code == 429:
                delay = float(r.headers.get("Retry-After", 20))
                print(f"    429 rate-limited, sleeping {delay}s")
                time.sleep(delay)
                continue
            if r.status_code >= 500 and attempt == 0:
                print(f"    {r.status_code} server error, retrying once in 5s")
                time.sleep(5)
                continue
            return r
        raise RuntimeError(f"{method} {path}: gave up after retries")

    def jget(self, path):
        r = self.req("GET", path)
        if r.status_code != 200:
            raise RuntimeError(f"GET {path} -> {r.status_code}: {r.text[:300]}")
        return r.json()

    def results(self, path):
        data = self.jget(path)
        return data["results"] if isinstance(data, dict) and "results" in data else data


# --- state file ------------------------------------------------------------

class State:
    def __init__(self, path):
        self.path = Path(path)
        self.data = {"project_id": None, "labels": {}, "modules": {}, "cycles": {},
                     "issues": {}, "attached_modules": {}, "attached_cycles": {},
                     "members_added": []}
        if self.path.exists():
            self.data.update(json.loads(self.path.read_text()))
        # migrate legacy attach bookkeeping to the issue->cycle map
        if "cycle_of" not in self.data:
            self.data["cycle_of"] = {}
            for ckey, keys in self.data.get("attached_cycles", {}).items():
                for k in keys:
                    self.data["cycle_of"][k] = ckey

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.data, indent=2))


# --- helpers ---------------------------------------------------------------

def member_ids(rows):
    """Normalize any member-list response shape into a set of user UUIDs."""
    ids = set()
    for row in rows:
        if isinstance(row, str):
            ids.add(row)
        elif isinstance(row, dict):
            m = row.get("member")
            if isinstance(m, str):
                ids.add(m)
            elif isinstance(m, dict) and m.get("id"):
                ids.add(m["id"])
            elif row.get("id") and (row.get("email") or row.get("role") is not None):
                ids.add(row["id"])
    return ids


def resolve_cycle(issue, cycles):
    """Pick the cycle whose window contains the issue's target_date."""
    if issue.get("cycle"):
        return issue["cycle"]
    td = issue.get("target_date")
    if not td:
        return None
    d = date.fromisoformat(td)
    for c in cycles:
        if date.fromisoformat(c["start_date"]) <= d <= date.fromisoformat(c["end_date"]):
            return c["key"]
    return None


def validate(man):
    errs = []
    keys = [i["key"] for i in man["issues"]]
    if len(keys) != len(set(keys)):
        errs.append("duplicate issue keys")
    label_keys = {l["key"] for l in man["labels"]}
    module_keys = {m["key"] for m in man["modules"]}
    for i in man["issues"]:
        for l in i.get("labels", []):
            if l not in label_keys:
                errs.append(f"{i['key']}: unknown label {l}")
        if i.get("module") and i["module"] not in module_keys:
            errs.append(f"{i['key']}: unknown module {i['module']}")
        if i.get("priority") not in ("urgent", "high", "medium", "low", "none"):
            errs.append(f"{i['key']}: bad priority {i.get('priority')}")
        if not i.get("description_md") and not i.get("description_html"):
            errs.append(f"{i['key']}: no description")
        if i.get("start_date") and i.get("target_date") and i["start_date"] > i["target_date"]:
            errs.append(f"{i['key']}: start_date > target_date")
        if not resolve_cycle(i, man.get("cycles", [])):
            errs.append(f"{i['key']}: no cycle covers target_date {i.get('target_date')}")
        md_to_html(i.get("description_md", "x"))  # raises on catastrophic input
    for m in man["modules"]:
        if m["start_date"] > m["target_date"]:
            errs.append(f"module {m['key']}: start > target")
    return errs


# --- main flows ------------------------------------------------------------

def seed(p, man, st):
    src = man["external_source"]

    print("1. Resolving workspace members")
    email_to_id = {}
    for row in p.results("/members/"):
        cand = row.get("member") if isinstance(row.get("member"), dict) else row
        if isinstance(cand, dict) and cand.get("email") and cand.get("id"):
            email_to_id[cand["email"].lower()] = cand["id"]
    print(f"   {len(email_to_id)} members: {sorted(email_to_id)}")

    def uid(email):
        e = email.lower()
        if e not in email_to_id:
            raise RuntimeError(f"no workspace member with email {email}")
        return email_to_id[e]

    print("2. Ensuring project")
    if not st.data["project_id"]:
        ident = man["project"]["identifier"].upper()
        for proj in p.results("/projects/"):
            if proj.get("identifier", "").upper() == ident:
                st.data["project_id"] = proj["id"]
                print(f"   found existing project {proj['id']}")
                break
    if not st.data["project_id"]:
        body = dict(man["project"])
        body["cycle_view"] = True
        body["module_view"] = True
        r = p.req("POST", "/projects/", body)
        if r.status_code not in (200, 201):
            raise RuntimeError(f"project create -> {r.status_code}: {r.text[:400]}")
        st.data["project_id"] = r.json()["id"]
        print(f"   created project {st.data['project_id']}")
    st.save()
    pid = st.data["project_id"]
    pp = f"/projects/{pid}"
    r = p.req("PATCH", f"{pp}/", {"description": man["project"].get("description", "")})
    if r.status_code != 200:
        print(f"   WARN project description PATCH -> {r.status_code}")

    print("3. Ensuring project members")
    current = member_ids(p.results(f"{pp}/members/"))
    for m in man.get("members", []):
        m_id = uid(m["email"])
        if m_id in current or m_id in st.data["members_added"]:
            print(f"   {m['email']} already a member")
            continue
        r = p.req("POST", f"{pp}/members/", {"member": m_id, "role": m.get("role", 15)})
        if r.status_code not in (200, 201, 409):
            raise RuntimeError(f"add member {m['email']} -> {r.status_code}: {r.text[:300]}")
        st.data["members_added"].append(m_id)
        st.save()
        print(f"   added {m['email']} role {m.get('role', 15)}")

    print("4. Resolving states")
    states = {s["name"]: s["id"] for s in p.results(f"{pp}/states/")}
    print(f"   {sorted(states)}")

    print("4b. Pruning issues removed from manifest")
    want_keys = {i["key"] for i in man["issues"]}
    for key in [k for k in list(st.data["issues"]) if k not in want_keys]:
        r = p.req("DELETE", f"{pp}/issues/{st.data['issues'][key]}/")
        if r.status_code not in (200, 204, 404):
            raise RuntimeError(f"issue {key} DELETE -> {r.status_code}: {r.text[:300]}")
        del st.data["issues"][key]
        st.data["cycle_of"].pop(key, None)
        for lst in st.data["attached_modules"].values():
            if key in lst:
                lst.remove(key)
        st.save()
        print(f"   deleted {key}")

    print("5. Ensuring labels")
    for l in man["labels"]:
        if l["key"] in st.data["labels"]:
            continue
        body = {"name": l["name"], "color": l.get("color", "#5e6ad2"),
                "external_id": l["key"], "external_source": src}
        r = p.req("POST", f"{pp}/labels/", body)
        if r.status_code in (200, 201):
            st.data["labels"][l["key"]] = r.json()["id"]
        elif r.status_code == 409 and r.json().get("id"):
            st.data["labels"][l["key"]] = r.json()["id"]
        else:
            raise RuntimeError(f"label {l['name']} -> {r.status_code}: {r.text[:300]}")
        st.save()
    print(f"   {len(st.data['labels'])} labels ready")

    print("6. Ensuring modules")
    for m in man["modules"]:
        body = {"name": m["name"], "start_date": m["start_date"],
                "target_date": m["target_date"],
                "external_id": m["key"], "external_source": src}
        if m.get("lead"):
            body["lead"] = uid(m["lead"])
        if m.get("members"):
            body["members"] = [uid(e) for e in m["members"]]
        if m["key"] in st.data["modules"]:
            r = p.req("PATCH", f"{pp}/modules/{st.data['modules'][m['key']]}/", body)
            if r.status_code != 200:
                raise RuntimeError(f"module {m['name']} PATCH -> {r.status_code}: {r.text[:300]}")
            continue
        r = p.req("POST", f"{pp}/modules/", body)
        j = {}
        try:
            j = r.json()
        except ValueError:
            pass
        if r.status_code in (200, 201):
            st.data["modules"][m["key"]] = j["id"]
        elif r.status_code in (400, 409) and j.get("id"):
            st.data["modules"][m["key"]] = j["id"]
        else:
            raise RuntimeError(f"module {m['name']} -> {r.status_code}: {r.text[:300]}")
        st.save()
    print(f"   {len(st.data['modules'])} modules ready")

    print("7. Ensuring cycles")
    want_cycles = {c["key"] for c in man.get("cycles", [])}
    for ckey in [k for k in list(st.data["cycles"]) if k not in want_cycles]:
        r = p.req("DELETE", f"{pp}/cycles/{st.data['cycles'][ckey]}/")
        if r.status_code not in (200, 204, 404):
            raise RuntimeError(f"cycle {ckey} DELETE -> {r.status_code}: {r.text[:300]}")
        del st.data["cycles"][ckey]
        for ikey in [k for k, v in st.data["cycle_of"].items() if v == ckey]:
            del st.data["cycle_of"][ikey]
        st.save()
        print(f"   deleted cycle {ckey}")
    for c in man.get("cycles", []):
        body = {"name": c["name"], "start_date": c["start_date"],
                "end_date": c["end_date"], "project_id": pid,
                "external_id": c["key"], "external_source": src}
        if c["key"] in st.data["cycles"]:
            r = p.req("PATCH", f"{pp}/cycles/{st.data['cycles'][c['key']]}/", body)
            if r.status_code != 200:
                raise RuntimeError(f"cycle {c['name']} PATCH -> {r.status_code}: {r.text[:300]}")
            continue
        r = p.req("POST", f"{pp}/cycles/", body)
        j = {}
        try:
            j = r.json()
        except ValueError:
            pass
        if r.status_code in (200, 201):
            st.data["cycles"][c["key"]] = j["id"]
        elif r.status_code in (400, 409) and j.get("id"):
            st.data["cycles"][c["key"]] = j["id"]
        else:
            raise RuntimeError(f"cycle {c['name']} -> {r.status_code}: {r.text[:300]}")
        st.save()
    print(f"   {len(st.data['cycles'])} cycles ready")

    print("8. Upserting issues")
    for i in man["issues"]:
        body = {
            "name": i["name"],
            "description_html": i.get("description_html") or md_to_html(i["description_md"]),
            "priority": i.get("priority", "none"),
            "assignees": [uid(e) for e in i.get("assignees", [])],
            "labels": [st.data["labels"][l] for l in i.get("labels", [])],
            "external_id": i["key"],
            "external_source": src,
        }
        if i.get("state") and i["state"] in states:
            body["state"] = states[i["state"]]
        if i.get("start_date"):
            body["start_date"] = i["start_date"]
        if i.get("target_date"):
            body["target_date"] = i["target_date"]
        # Collection endpoint only routes GET/POST in this build (the view's
        # PUT upsert is not wired into urls). POST returns 409-with-id on a
        # duplicate external_id; PATCH the detail endpoint to propagate edits.
        known = st.data["issues"].get(i["key"])
        if known:
            r = p.req("PATCH", f"{pp}/issues/{known}/", body)
            if r.status_code != 200:
                raise RuntimeError(f"issue {i['key']} PATCH -> {r.status_code}: {r.text[:400]}")
            print(f"   {i['key']} updated")
            continue
        r = p.req("POST", f"{pp}/issues/", body)
        if r.status_code in (200, 201):
            st.data["issues"][i["key"]] = r.json()["id"]
        elif r.status_code == 409 and r.json().get("id"):
            iid = r.json()["id"]
            st.data["issues"][i["key"]] = iid
            r2 = p.req("PATCH", f"{pp}/issues/{iid}/", body)
            if r2.status_code != 200:
                raise RuntimeError(f"issue {i['key']} PATCH -> {r2.status_code}: {r2.text[:400]}")
        else:
            raise RuntimeError(f"issue {i['key']} -> {r.status_code}: {r.text[:400]}")
        st.save()
        print(f"   {i['key']} {r.status_code}")

    print("9. Attaching issues to modules")
    for m in man["modules"]:
        done = set(st.data["attached_modules"].get(m["key"], []))
        todo = [i["key"] for i in man["issues"] if i.get("module") == m["key"]
                and i["key"] not in done]
        if not todo:
            continue
        ids = [st.data["issues"][k] for k in todo]
        r = p.req("POST", f"{pp}/modules/{st.data['modules'][m['key']]}/module-issues/",
                  {"issues": ids})
        if r.status_code not in (200, 201, 204):
            raise RuntimeError(f"module-attach {m['key']} -> {r.status_code}: {r.text[:300]}")
        st.data["attached_modules"][m["key"]] = sorted(done | set(todo))
        st.save()
        print(f"   {m['key']}: +{len(todo)}")

    print("10. Attaching issues to cycles (cycle POST moves issues between cycles)")
    for c in man.get("cycles", []):
        todo = [i["key"] for i in man["issues"]
                if resolve_cycle(i, man["cycles"]) == c["key"]
                and st.data["cycle_of"].get(i["key"]) != c["key"]]
        if not todo:
            continue
        ids = [st.data["issues"][k] for k in todo]
        r = p.req("POST", f"{pp}/cycles/{st.data['cycles'][c['key']]}/cycle-issues/",
                  {"issues": ids})
        if r.status_code not in (200, 201, 204):
            raise RuntimeError(f"cycle-attach {c['key']} -> {r.status_code}: {r.text[:300]}")
        for k in todo:
            st.data["cycle_of"][k] = c["key"]
        st.save()
        print(f"   {c['key']}: +{len(todo)}")

    print(f"\nSeeding complete ({p.calls} API calls).")


def verify(p, man, st, base, slug):
    pid = st.data["project_id"]
    if not pid:
        print("FAIL: no project_id in state file"); return 1
    pp = f"/projects/{pid}"
    fails = []

    proj = p.jget(f"{pp}/")
    print(f"Project: {proj.get('name')!r} identifier={proj.get('identifier')}")
    if "Al Kazhnah" not in proj.get("name", ""):
        fails.append("project name missing 'Al Kazhnah'")

    issues, cursor = [], None
    while True:
        path = f"{pp}/issues/?per_page=100" + (f"&cursor={cursor}" if cursor else "")
        data = p.jget(path)
        issues.extend(data.get("results", []))
        if not data.get("next_page_results"):
            break
        cursor = data.get("next_cursor")
    want = len(man["issues"])
    print(f"Issues: {len(issues)} (manifest: {want})")
    if len(issues) != want:
        fails.append(f"issue count {len(issues)} != {want}")
    unassigned = [i.get("name") for i in issues if not i.get("assignees")]
    if unassigned:
        fails.append(f"{len(unassigned)} unassigned issues, e.g. {unassigned[:3]}")

    modules = p.results(f"{pp}/modules/")
    print(f"Modules: {len(modules)} (manifest: {len(man['modules'])})")
    if len(modules) != len(man["modules"]):
        fails.append("module count mismatch")
    for m in man["modules"]:
        mi = p.jget(f"{pp}/modules/{st.data['modules'][m['key']]}/module-issues/?per_page=100")
        got = len(mi.get("results", mi if isinstance(mi, list) else []))
        want_m = len([i for i in man["issues"] if i.get("module") == m["key"]])
        status = "ok" if got == want_m else "MISMATCH"
        print(f"  {m['key']}: {got}/{want_m} {status}")
        if got != want_m:
            fails.append(f"module {m['key']} has {got} issues, want {want_m}")

    labels = p.results(f"{pp}/labels/")
    print(f"Labels: {len(labels)} (manifest: {len(man['labels'])})")
    if len(labels) < len(man["labels"]):
        fails.append("label count below manifest")

    members = member_ids(p.results(f"{pp}/members/"))
    print(f"Project members: {len(members)}")
    if len(members) < 1 + len(man.get("members", [])):
        fails.append("expected member(s) missing from project")

    spot = [k for k in ("P1.3", "P3.5", "P5.7", "P6.4", "W16") if k in st.data["issues"]] or \
        list(st.data["issues"])[:3]
    for key in spot:
        data = p.jget(f"{pp}/issues/?external_id={key}&external_source={man['external_source']}")
        item = data["results"][0] if isinstance(data, dict) and data.get("results") else data
        desc = item.get("description_html", "") or ""
        src_issue = next(i for i in man["issues"] if i["key"] == key)
        marker_ok = "Acceptance criteria" in desc
        title_ok = item.get("name") == src_issue["name"]
        print(f"  spot {key}: title={'ok' if title_ok else 'BAD'} "
              f"desc-marker={'ok' if marker_ok else 'BAD'} len={len(desc)}")
        if not marker_ok:
            fails.append(f"{key}: description missing 'Acceptance criteria' marker")
        if not title_ok:
            fails.append(f"{key}: title mismatch")

    url = f"{base}/{slug}/projects/{pid}/issues/"
    print(f"\nProject URL: {url}")
    if fails:
        print("\nVERIFY FAILED:")
        for f in fails:
            print(f"  - {f}")
        return 1
    print("VERIFY PASSED")
    return 0


def delete_project(p, st):
    pid = st.data["project_id"]
    if not pid:
        print("no project_id in state"); return 1
    proj = p.jget(f"/projects/{pid}/")
    typed = input(f"Type the project identifier ({proj.get('identifier')}) to DELETE: ")
    if typed.strip().upper() != proj.get("identifier", "").upper():
        print("mismatch, aborting"); return 1
    r = p.req("DELETE", f"/projects/{pid}/")
    print(f"DELETE -> {r.status_code}")
    if r.status_code in (200, 204):
        st.path.unlink(missing_ok=True)
        print("state file removed")
        return 0
    return 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--verify-only", action="store_true")
    ap.add_argument("--delete-project", action="store_true")
    args = ap.parse_args()

    man = json.loads(Path(args.manifest).read_text())
    errs = validate(man)
    if errs:
        print("MANIFEST INVALID:")
        for e in errs:
            print(f"  - {e}")
        sys.exit(1)

    n_issues = len(man["issues"])
    print(f"Manifest OK: project {man['project']['identifier']}, "
          f"{len(man['labels'])} labels, {len(man['modules'])} modules, "
          f"{len(man.get('cycles', []))} cycles, {n_issues} issues")
    if args.dry_run:
        for m in man["modules"]:
            n = len([i for i in man["issues"] if i.get("module") == m["key"]])
            print(f"  {m['key']} {m['name']}: {n} issues")
        no_mod = len([i for i in man["issues"] if not i.get("module")])
        print(f"  (no module): {no_mod} issues")
        sample = md_to_html(man["issues"][0].get("description_md", ""))
        print(f"  sample HTML ({man['issues'][0]['key']}): {sample[:200]}...")
        return

    token = get_env("PLANE_API_TOKEN")
    if not token:
        print("PLANE_API_TOKEN not found in env or .env"); sys.exit(1)
    base = get_env("PLANE_BASE_URL", "https://plan.underwings.org")
    slug = get_env("PLANE_WORKSPACE_SLUG", "underwings")
    p = Plane(base, slug, token)
    st = State(Path(args.manifest).parent / "state" /
               (Path(args.manifest).stem.replace("-manifest", "") + "-state.json"))

    if args.delete_project:
        sys.exit(delete_project(p, st))
    if args.verify_only:
        sys.exit(verify(p, man, st, base, slug))
    seed(p, man, st)
    verify(p, man, st, base, slug)


if __name__ == "__main__":
    main()
