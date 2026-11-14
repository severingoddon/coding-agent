"""Central memory for Pi (pidev).

SQLite (WAL) as the single source of truth:
  memories        memories (typed, with provenance and status)
  memory_history  every change (old/new, reason, actor)
  memories_fts    full text (FTS5), kept in sync by triggers
  memory_vec      vectors (sqlite-vec, bge-m3, 1024 dims, cosine)

Search = hybrid: FTS5 + vector, fused with Reciprocal Rank Fusion.
If the embedding service is down, search falls back to FTS5 only;
missing vectors are backfilled in the background.
"""

import json
import math
import os
import re
import sqlite3
import threading
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

import sqlite_vec
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

DATA = Path(os.environ.get("DATA_DIR", "/data"))
DB_PATH = DATA / "memory.db"
BACKUP_DIR = DATA / "backups"
EMBED_URL = os.environ.get("EMBED_URL", "http://172.31.250.13:8080/v1/embeddings")
DIM = 1024
DUP_SIMILARITY = float(os.environ.get("DUP_SIMILARITY", "0.80"))
BACKUP_KEEP = 14

MemoryType = Literal["fact", "preference", "decision", "event", "howto"]
TYPES = ["fact", "preference", "decision", "event", "howto"]

# --------------------------------------------------------------------------- DB

DATA.mkdir(parents=True, exist_ok=True)
BACKUP_DIR.mkdir(parents=True, exist_ok=True)
_lock = threading.RLock()
db = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
db.row_factory = sqlite3.Row
db.enable_load_extension(True)
sqlite_vec.load(db)
db.enable_load_extension(False)

SCHEMA = f"""
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS memories (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL,
  content       TEXT NOT NULL,
  rationale     TEXT,
  tags          TEXT NOT NULL DEFAULT '[]',
  project       TEXT,
  session       TEXT,
  origin        TEXT NOT NULL DEFAULT 'agent',
  status        TEXT NOT NULL DEFAULT 'active',   -- active | superseded | deleted
  superseded_by INTEGER,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  last_used_at  TEXT,
  use_count     INTEGER NOT NULL DEFAULT 0,
  embedded      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mem_status ON memories(status, updated_at);
CREATE TABLE IF NOT EXISTS memory_history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL,
  action    TEXT NOT NULL,             -- create | update | supersede | delete
  old       TEXT,
  new       TEXT,
  reason    TEXT,
  actor     TEXT,
  project   TEXT,
  session   TEXT,
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hist_mem ON memory_history(memory_id);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content, rationale, tags,
  content='memories', content_rowid='id',
  tokenize="unicode61 remove_diacritics 2 tokenchars '_-.'"
);
CREATE TRIGGER IF NOT EXISTS mem_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, rationale, tags) VALUES (new.id, new.content, new.rationale, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS mem_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, rationale, tags) VALUES ('delete', old.id, old.content, old.rationale, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS mem_au AFTER UPDATE OF content, rationale, tags ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, rationale, tags) VALUES ('delete', old.id, old.content, old.rationale, old.tags);
  INSERT INTO memories_fts(rowid, content, rationale, tags) VALUES (new.id, new.content, new.rationale, new.tags);
END;
CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(embedding float[{DIM}] distance_metric=cosine);
"""
with _lock:
    db.executescript(SCHEMA)


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def row_to_dict(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["tags"] = json.loads(d.get("tags") or "[]")
    d.pop("embedded", None)
    return d


def snapshot(r: sqlite3.Row) -> str:
    return json.dumps({k: r[k] for k in ("type", "content", "rationale", "tags", "status")}, ensure_ascii=False)


def history(memory_id: int, action: str, old: Optional[str], new: Optional[str],
            reason: Optional[str], actor: str, project: Optional[str], session: Optional[str]) -> None:
    db.execute(
        "INSERT INTO memory_history(memory_id, action, old, new, reason, actor, project, session, at) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (memory_id, action, old, new, reason, actor, project, session, now()),
    )


# --------------------------------------------------------------------- Embeddings

_embed_ok = {"ok": False, "checked": 0.0}


def embed(text: str) -> Optional[list[float]]:
    """bge-m3 via llama.cpp (OpenAI-compatible). None if the service does not respond."""
    try:
        req = urllib.request.Request(
            EMBED_URL,
            data=json.dumps({"input": text[:8000], "model": "bge-m3"}).encode(),
            headers={"content-type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=15) as res:
            vec = json.load(res)["data"][0]["embedding"]
        norm = math.sqrt(sum(x * x for x in vec)) or 1.0
        _embed_ok.update(ok=True, checked=time.time())
        return [x / norm for x in vec]
    except Exception:
        _embed_ok.update(ok=False, checked=time.time())
        return None


def embed_text(type_: str, content: str, rationale: Optional[str], tags: list[str]) -> str:
    parts = [f"[{type_}] {content}"]
    if rationale:
        parts.append(f"Rationale: {rationale}")
    if tags:
        parts.append("Tags: " + ", ".join(tags))
    return "\n".join(parts)


def store_vector(memory_id: int, vec: Optional[list[float]]) -> None:
    db.execute("DELETE FROM memory_vec WHERE rowid = ?", (memory_id,))
    if vec is None:
        db.execute("UPDATE memories SET embedded = 0 WHERE id = ?", (memory_id,))
        return
    db.execute("INSERT INTO memory_vec(rowid, embedding) VALUES (?, ?)",
               (memory_id, sqlite_vec.serialize_float32(vec)))
    db.execute("UPDATE memories SET embedded = 1 WHERE id = ?", (memory_id,))


def vector_search(vec: list[float], k: int) -> list[tuple[int, float]]:
    rows = db.execute(
        "SELECT rowid, distance FROM memory_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance",
        (sqlite_vec.serialize_float32(vec), k),
    ).fetchall()
    return [(r[0], 1.0 - r[1]) for r in rows]  # cosine similarity


def fts_query(text: str) -> Optional[str]:
    tokens = re.findall(r"[\w\-.]+", text, flags=re.UNICODE)
    tokens = [t.strip(".-") for t in tokens if len(t.strip(".-")) > 1]
    return " OR ".join(f'"{t}"' for t in tokens[:32]) or None


def fts_search(text: str, k: int) -> list[int]:
    q = fts_query(text)
    if not q:
        return []
    try:
        rows = db.execute(
            "SELECT rowid FROM memories_fts WHERE memories_fts MATCH ? "
            "ORDER BY bm25(memories_fts, 1.0, 0.6, 0.8) LIMIT ?", (q, k)).fetchall()
    except sqlite3.OperationalError:
        return []
    return [r[0] for r in rows]


# -------------------------------------------------------------------------- API

app = FastAPI(title="pidev memory", version="1.0")


class SaveIn(BaseModel):
    content: str = Field(min_length=3, max_length=4000)
    type: MemoryType
    rationale: Optional[str] = Field(default=None, max_length=4000)
    tags: list[str] = []
    project: Optional[str] = None
    session: Optional[str] = None
    origin: Literal["agent", "user", "extracted"] = "agent"
    supersedes: list[int] = []
    force: bool = False


class UpdateIn(BaseModel):
    content: Optional[str] = Field(default=None, min_length=3, max_length=4000)
    type: Optional[MemoryType] = None
    rationale: Optional[str] = Field(default=None, max_length=4000)
    tags: Optional[list[str]] = None
    reason: str = Field(min_length=3)
    project: Optional[str] = None
    session: Optional[str] = None
    actor: str = "agent"


class SearchIn(BaseModel):
    query: str = Field(min_length=1)
    types: list[MemoryType] = []
    project: Optional[str] = None
    limit: int = Field(default=6, ge=1, le=30)
    include_inactive: bool = False


def get_row(memory_id: int) -> sqlite3.Row:
    r = db.execute("SELECT * FROM memories WHERE id = ?", (memory_id,)).fetchone()
    if not r:
        raise HTTPException(404, f"Memory #{memory_id} does not exist")
    return r


@app.get("/health")
def health():
    with _lock:
        counts = {r[0]: r[1] for r in db.execute("SELECT status, COUNT(*) FROM memories GROUP BY status")}
        pending = db.execute("SELECT COUNT(*) FROM memories WHERE embedded = 0 AND status = 'active'").fetchone()[0]
    if time.time() - _embed_ok["checked"] > 60:
        embed("health")
    return {"ok": True, "embeddings": _embed_ok["ok"], "counts": counts, "pending_embeddings": pending}


@app.post("/memories")
def save(m: SaveIn):
    tags = sorted({t.strip().lower() for t in m.tags if t.strip()})
    vec = embed(embed_text(m.type, m.content, m.rationale, tags))
    with _lock:
        # Duplicate/contradiction check: return very similar active memories instead of saving blindly
        if not m.force:
            similar = []
            exact = db.execute("SELECT id FROM memories WHERE status='active' AND content = ?", (m.content,)).fetchall()
            similar += [(r[0], 1.0) for r in exact]
            if vec is not None:
                similar += [(i, s) for i, s in vector_search(vec, 8) if s >= DUP_SIMILARITY]
            seen, out = set(), []
            for i, s in sorted(similar, key=lambda x: -x[1]):
                if i in seen or i in m.supersedes:
                    continue
                r = db.execute("SELECT * FROM memories WHERE id=? AND status='active'", (i,)).fetchone()
                if r:
                    seen.add(i)
                    out.append({**row_to_dict(r), "similarity": round(s, 3)})
            if out:
                return {"saved": False, "similar": out[:5]}

        ts = now()
        cur = db.execute(
            "INSERT INTO memories(type, content, rationale, tags, project, session, origin, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (m.type, m.content, m.rationale, json.dumps(tags, ensure_ascii=False), m.project, m.session,
             m.origin, ts, ts),
        )
        new_id = cur.lastrowid
        store_vector(new_id, vec)
        history(new_id, "create", None, snapshot(get_row(new_id)), None, m.origin, m.project, m.session)
        superseded = []
        for old_id in m.supersedes:
            r = db.execute("SELECT * FROM memories WHERE id=?", (old_id,)).fetchone()
            if not r or r["status"] != "active":
                continue
            db.execute("UPDATE memories SET status='superseded', superseded_by=?, updated_at=? WHERE id=?",
                       (new_id, ts, old_id))
            history(old_id, "supersede", snapshot(r), snapshot(get_row(old_id)), f"superseded by #{new_id}",
                    m.origin, m.project, m.session)
            superseded.append(old_id)
        return {"saved": True, "memory": row_to_dict(get_row(new_id)), "superseded": superseded,
                "embedded": vec is not None}


@app.get("/memories")
def list_memories(limit: int = 20, type: Optional[str] = None, project: Optional[str] = None,
                  status: str = "active"):
    sql, args = "SELECT * FROM memories WHERE status = ?", [status]
    if type:
        sql += " AND type = ?"; args.append(type)
    if project:
        sql += " AND project = ?"; args.append(project)
    sql += " ORDER BY updated_at DESC LIMIT ?"; args.append(min(limit, 200))
    with _lock:
        return [row_to_dict(r) for r in db.execute(sql, args)]


@app.get("/memories/{memory_id}")
def get_memory(memory_id: int):
    with _lock:
        r = get_row(memory_id)
        hist = [dict(h) for h in db.execute(
            "SELECT action, old, new, reason, actor, project, session, at FROM memory_history "
            "WHERE memory_id = ? ORDER BY id", (memory_id,))]
    return {**row_to_dict(r), "history": hist}


@app.patch("/memories/{memory_id}")
def update(memory_id: int, u: UpdateIn):
    with _lock:
        r = get_row(memory_id)
        if r["status"] == "deleted":
            raise HTTPException(409, f"Memory #{memory_id} is deleted")
    new = {
        "type": u.type or r["type"],
        "content": u.content or r["content"],
        "rationale": u.rationale if u.rationale is not None else r["rationale"],
        "tags": json.dumps(sorted({t.strip().lower() for t in u.tags if t.strip()}), ensure_ascii=False)
        if u.tags is not None else r["tags"],
    }
    vec = embed(embed_text(new["type"], new["content"], new["rationale"], json.loads(new["tags"])))
    with _lock:
        old = snapshot(r)
        db.execute("UPDATE memories SET type=?, content=?, rationale=?, tags=?, updated_at=? WHERE id=?",
                   (new["type"], new["content"], new["rationale"], new["tags"], now(), memory_id))
        store_vector(memory_id, vec)
        history(memory_id, "update", old, snapshot(get_row(memory_id)), u.reason, u.actor, u.project, u.session)
        return {"memory": row_to_dict(get_row(memory_id)), "embedded": vec is not None}


@app.delete("/memories/{memory_id}")
def forget(memory_id: int, reason: str, project: Optional[str] = None, session: Optional[str] = None,
           actor: str = "agent"):
    with _lock:
        r = get_row(memory_id)
        db.execute("UPDATE memories SET status='deleted', updated_at=? WHERE id=?", (now(), memory_id))
        db.execute("DELETE FROM memory_vec WHERE rowid = ?", (memory_id,))
        history(memory_id, "delete", snapshot(r), None, reason, actor, project, session)
    return {"deleted": memory_id}


@app.post("/search")
def search(s: SearchIn):
    k = max(s.limit * 5, 30)
    vec = embed(s.query)
    with _lock:
        fts_ids = fts_search(s.query, k)
        vec_hits = vector_search(vec, k) if vec is not None else []
        scores: dict[int, float] = {}
        sims = dict(vec_hits)
        for rank, i in enumerate(fts_ids):
            scores[i] = scores.get(i, 0) + 1 / (60 + rank)
        for rank, (i, _) in enumerate(vec_hits):
            scores[i] = scores.get(i, 0) + 1 / (60 + rank)
        if not scores:
            return {"results": [], "mode": "hybrid" if vec is not None else "fulltext"}
        rows = {r["id"]: r for r in db.execute(
            f"SELECT * FROM memories WHERE id IN ({','.join('?' * len(scores))})", list(scores))}
        results = []
        for i, sc in scores.items():
            r = rows.get(i)
            if not r or (not s.include_inactive and r["status"] != "active"):
                continue
            if s.types and r["type"] not in s.types:
                continue
            if s.project and r["project"] == s.project:
                sc *= 1.15  # project match only affects ranking
            results.append((sc, r))
        results.sort(key=lambda x: -x[0])
        results = results[: s.limit]
        ts = now()
        for _, r in results:
            db.execute("UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?", (ts, r["id"]))
        out = []
        for sc, r in results:
            d = row_to_dict(r)
            d["score"] = round(sc * 100, 2)
            d["match"] = ("text+semantic" if r["id"] in fts_ids and r["id"] in sims
                          else "text" if r["id"] in fts_ids else "semantic")
            out.append(d)
    return {"results": out, "mode": "hybrid" if vec is not None else "fulltext"}


def do_backup() -> str:
    name = BACKUP_DIR / f"memory-{datetime.now().strftime('%Y%m%d-%H%M%S')}.db"
    with _lock:
        dst = sqlite3.connect(name)
        db.backup(dst)
        dst.close()
    for old in sorted(BACKUP_DIR.glob("memory-*.db"))[:-BACKUP_KEEP]:
        old.unlink()
    return str(name)


@app.post("/backup")
def backup():
    return {"backup": do_backup()}


# ------------------------------------------------------------- Background jobs

def background():
    """Backfill missing vectors (e.g. after an embedding service outage), daily backup."""
    last_backup = 0.0
    while True:
        try:
            with _lock:
                todo = db.execute("SELECT * FROM memories WHERE embedded = 0 AND status = 'active' LIMIT 20").fetchall()
            for r in todo:
                vec = embed(embed_text(r["type"], r["content"], r["rationale"], json.loads(r["tags"])))
                if vec is None:
                    break
                with _lock:
                    store_vector(r["id"], vec)
            if time.time() - last_backup > 86400:
                do_backup()
                last_backup = time.time()
        except Exception as e:  # the background job must never die
            print("background:", e, flush=True)
        time.sleep(60)


threading.Thread(target=background, daemon=True).start()
