// Pi extension "goddonimemory": central memory (pidev/memory, container on the Mac, 172.31.250.12).
// Deliberately agent-driven only: nothing is loaded into the context automatically.
// Pi decides when to search or save. If the service is down, the tools only
// return an error and Pi keeps working normally.
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const API = process.env.PIDEV_MEMORY_URL ?? "http://172.31.250.12:8080";
const PROJECT = process.env.PIDEV_PROJECT || undefined;
const TYPES = ["fact", "preference", "decision", "event", "howto"] as const;

async function call(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<any> {
  const signals = [AbortSignal.timeout(8_000)];
  if (signal) signals.push(signal);
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any(signals),
    });
  } catch {
    throw new Error("Memory service unavailable. Continue without memory.");
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = typeof data?.detail === "string" ? data.detail : JSON.stringify(data?.detail ?? data);
    throw new Error(`Memory error (HTTP ${res.status}): ${detail}`);
  }
  return data;
}

function fmt(m: any): string {
  const meta = [m.type, m.project ?? "global", (m.updated_at ?? "").slice(0, 10)];
  if (m.status && m.status !== "active") meta.push(m.status + (m.superseded_by ? ` by #${m.superseded_by}` : ""));
  let s = `#${m.id} [${meta.join(" · ")}] ${m.content}`;
  if (m.rationale) s += `\n    why: ${m.rationale}`;
  if (m.tags?.length) s += `\n    tags: ${m.tags.join(", ")}`;
  return s;
}

const text = (t: string) => [{ type: "text" as const, text: t }];

export default function (pi: ExtensionAPI) {
  const session = (ctx: any): string | undefined => {
    try {
      return ctx.sessionManager.getSessionId();
    } catch {
      return undefined;
    }
  };

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description:
      "Search the persistent memory shared across all projects and sessions (hybrid full-text + semantic). " +
      "Contains user preferences, facts about the environment, past decisions with rationale, past events/errors, and reusable how-tos.",
    promptSnippet: "memory_search: look up long-term memory (preferences, decisions, past errors, how-tos)",
    promptGuidelines: [
      "Use memory_search when the task may depend on earlier work, user preferences, past decisions or known pitfalls; do not search for trivial tasks.",
      "Treat memories as hints that can be outdated: verify against the current code before relying on them.",
      "Save with memory_save only durable, reusable knowledge (stated preferences, decisions with rationale, verified lessons), never guesses or session chatter.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "What to look for; exact technical terms and natural language both work" }),
      types: Type.Optional(Type.Array(Type.String({ enum: [...TYPES] }), { description: "Filter by memory type" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 6, max 15)" })),
      include_inactive: Type.Optional(Type.Boolean({ description: "Also return superseded/deleted memories" })),
    }),
    async execute(_id, p, signal) {
      const data = await call("POST", "/search", {
        query: p.query,
        types: p.types ?? [],
        project: PROJECT,
        limit: Math.min(Math.max(p.limit ?? 6, 1), 15),
        include_inactive: p.include_inactive ?? false,
      }, signal);
      const lines = data.results.map(fmt);
      const head = data.mode === "fulltext" ? "(semantic search unavailable, full-text only)\n" : "";
      return {
        content: text(head + (lines.length ? lines.join("\n") : `No memories found for "${p.query}".`)),
        details: { count: data.results.length, mode: data.mode },
      };
    },
  });

  pi.registerTool({
    name: "memory_save",
    label: "Memory Save",
    description:
      "Store a durable memory, shared with all projects. Types: fact (environment/project facts), preference (how the user wants things), " +
      "decision (architecture choice + rationale), event (notable past incident/error and its resolution), howto (reusable procedure). " +
      "Write one self-contained statement. If very similar memories exist, nothing is saved and they are returned: " +
      "then update one with memory_update, replace outdated ones via supersedes, or set force=true if it is genuinely different.",
    parameters: Type.Object({
      content: Type.String({ description: "Self-contained statement, understandable without this conversation" }),
      type: Type.String({ enum: [...TYPES], description: "fact | preference | decision | event | howto" }),
      rationale: Type.Optional(Type.String({ description: "Why (required in spirit for decisions)" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Short keywords, e.g. tool or component names" })),
      global: Type.Optional(Type.Boolean({ description: "true = not specific to the current project" })),
      supersedes: Type.Optional(Type.Array(Type.Number(), { description: "IDs of memories this one replaces (marked superseded)" })),
      force: Type.Optional(Type.Boolean({ description: "Save even if similar memories exist" })),
    }),
    async execute(_id, p, signal, _u, ctx) {
      const data = await call("POST", "/memories", {
        content: p.content,
        type: p.type,
        rationale: p.rationale,
        tags: p.tags ?? [],
        project: p.global ? null : PROJECT,
        session: session(ctx),
        supersedes: p.supersedes ?? [],
        force: p.force ?? false,
      }, signal);
      if (!data.saved) {
        return {
          content: text(
            "Not saved: similar memories already exist.\n" +
              data.similar.map((m: any) => `${fmt(m)}\n    similarity: ${m.similarity}`).join("\n") +
              "\nUse memory_update on one of them, memory_save with supersedes=[id] if it is outdated, or force=true if different.",
          ),
          details: { saved: false },
        };
      }
      const sup = data.superseded?.length ? ` (superseded: ${data.superseded.map((i: number) => "#" + i).join(", ")})` : "";
      return { content: text(`Saved ${fmt(data.memory)}${sup}`), details: { saved: true, id: data.memory.id } };
    },
  });

  pi.registerTool({
    name: "memory_update",
    label: "Memory Update",
    description: "Correct or refine an existing memory by id. The previous version is kept in the history.",
    parameters: Type.Object({
      id: Type.Number(),
      reason: Type.String({ description: "Why it changes" }),
      content: Type.Optional(Type.String()),
      type: Type.Optional(Type.String({ enum: [...TYPES] })),
      rationale: Type.Optional(Type.String()),
      tags: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id, p, signal, _u, ctx) {
      const { id, ...rest } = p;
      const data = await call("PATCH", `/memories/${id}`, { ...rest, project: PROJECT, session: session(ctx) }, signal);
      return { content: text(`Updated ${fmt(data.memory)}`), details: { id } };
    },
  });

  pi.registerTool({
    name: "memory_forget",
    label: "Memory Forget",
    description: "Delete a memory that is wrong or no longer useful (soft delete, history is kept). Prefer supersedes when a newer fact replaces it.",
    parameters: Type.Object({
      id: Type.Number(),
      reason: Type.String({ description: "Why it is removed" }),
    }),
    async execute(_id, p, signal, _u, ctx) {
      const q = new URLSearchParams({ reason: p.reason, ...(PROJECT ? { project: PROJECT } : {}) });
      const s = session(ctx);
      if (s) q.set("session", s);
      await call("DELETE", `/memories/${p.id}?${q}`, undefined, signal);
      return { content: text(`Forgot #${p.id}.`), details: { id: p.id } };
    },
  });

  // For the user (not the model): /goddonimemory shows status and the latest entries
  pi.registerCommand("goddonimemory", {
    description: "Show memory status and recent memories",
    handler: async (_args, ctx) => {
      try {
        const [h, recent] = await Promise.all([call("GET", "/health"), call("GET", "/memories?limit=10")]);
        const counts = Object.entries(h.counts).map(([k, v]) => `${k}: ${v}`).join(", ") || "empty";
        const list = recent.map((m: any) => `#${m.id} [${m.type}] ${m.content.slice(0, 90)}`).join("\n");
        ctx.ui.notify(`goddonimemory ${h.embeddings ? "hybrid" : "full-text only"} · ${counts}\n${list}`, "info");
      } catch (e: any) {
        ctx.ui.notify(String(e.message ?? e), "error");
      }
    },
  });
}
