# goddonimemory

Central memory for Pi across all projects and sandboxes. Pi uses it **only when it decides to**, via tools. Nothing is loaded into the context automatically.

## Components

| What | Where |
|---|---|
| Pi extension `goddonimemory` | `../extensions/goddonimemory/index.ts` |
| API (FastAPI, SQLite WAL + FTS5 + sqlite-vec) | container `pidev-memory-api-1`, `172.31.250.12:8080` |
| Embeddings (llama.cpp, bge-m3 Q8, CPU) | container `pidev-memory-embed-1`, `172.31.250.13:8080`, blocked for sandboxes |
| Data | `~/.pidev-memory/memory.db`, backups in `~/.pidev-memory/backups/` |

## Tools for Pi

- `memory_search`: hybrid search (full text + semantic)
- `memory_save`: store a memory of type `fact`, `preference`, `decision`, `event` or `howto`. If similar entries exist (cosine ≥ 0.80), the server does not save but returns them. Pi then updates one, replaces it (`supersedes`) or saves anyway with `force`.
- `memory_update`, `memory_forget`: change or mark as deleted (soft delete), with history

For the user in Pi: `/goddonimemory` shows status and the latest entries.

## Operation

- Start: automatically with `pidev`, manually `docker compose up -d` (in this folder)
- Stop: `docker compose stop`
- Embedding service down: search falls back to full text, missing vectors are backfilled later
- API down: the tools return an error, Pi keeps working normally

## Backup / restore

- Automatic daily backup, the last 14 are kept. Manually from a container on the network:
  `docker run --rm --network pidev-web curlimages/curl:8.11.1 -s -X POST http://172.31.250.12:8080/backup`
- Restore: `docker compose stop api` → copy a backup to `~/.pidev-memory/memory.db` (and delete `memory.db-wal`/`-shm`) → `docker compose start api`

## API

`GET /health` · `POST /memories` · `GET /memories` · `GET|PATCH|DELETE /memories/{id}` · `POST /search` · `POST /backup`

## Extending

- New memory types: `TYPES` in `api/app.py` and in the extension
- Similarity threshold: environment variable `DUP_SIMILARITY`
- Possible later: automatic extraction from sessions (`~/.pi-sandbox-agent/sessions`) with the local model
