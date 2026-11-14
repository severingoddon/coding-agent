// Pi extension: web_search (SearXNG) + web_fetch (pidev-fetch).
// Both services run as containers on the Mac (pidev/web), reachable only via fixed IPs.
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SEARXNG = "http://172.31.250.10:8080";
const FETCH = "http://172.31.250.11:8080";

async function getJson(url: string, signal: AbortSignal | undefined, timeoutMs: number) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  const res = await fetch(url, { signal: AbortSignal.any(signals) });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body;
}

const text = (t: string) => [{ type: "text" as const, text: t }];

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web (meta search over Google, Bing, DuckDuckGo, Brave, Wikipedia, GitHub, StackOverflow and more). " +
      "Returns titles, URLs and snippets. Use web_fetch to read a result page.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      max_results: Type.Optional(Type.Number({ description: "Number of results (default 8, max 20)" })),
      categories: Type.Optional(
        Type.String({ description: "Optional SearXNG category: general, it, science, news, files, images" }),
      ),
      time_range: Type.Optional(Type.String({ description: "Optional: day, week, month, year" })),
      language: Type.Optional(Type.String({ description: "Optional language code, e.g. en, de (default: all)" })),
    }),

    async execute(_id, params, signal) {
      const max = Math.min(Math.max(params.max_results ?? 8, 1), 20);
      const q = new URLSearchParams({ q: params.query, format: "json" });
      if (params.categories) q.set("categories", params.categories);
      if (params.time_range) q.set("time_range", params.time_range);
      if (params.language) q.set("language", params.language);

      const data = await getJson(`${SEARXNG}/search?${q}`, signal, 30_000);
      const results: any[] = (data.results ?? []).slice(0, max);
      const lines: string[] = [];

      for (const a of data.answers ?? []) lines.push(`Answer: ${typeof a === "string" ? a : a.answer ?? ""}`);
      for (const box of data.infoboxes ?? []) lines.push(`Infobox: ${box.infobox}: ${(box.content ?? "").slice(0, 500)}`);
      results.forEach((r, i) => {
        lines.push(`${i + 1}. ${r.title}\n   ${r.url}\n   ${(r.content ?? "").replace(/\s+/g, " ").slice(0, 300)}`);
      });
      if (!results.length) {
        const down = (data.unresponsive_engines ?? []).map((e: any[]) => e.join(": ")).join(", ");
        lines.push(`No results for "${params.query}".${down ? ` Unresponsive engines: ${down}` : ""}`);
      }
      return { content: text(lines.join("\n")), details: { query: params.query, count: results.length } };
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a public web page (or text/JSON URL) and return its main content as Markdown. " +
      "Output is truncated to max_chars (default 20000); use offset to read further.",
    parameters: Type.Object({
      url: Type.String({ description: "Absolute http(s) URL" }),
      max_chars: Type.Optional(Type.Number({ description: "Max characters to return (default 20000, max 80000)" })),
      offset: Type.Optional(Type.Number({ description: "Character offset to start from (default 0)" })),
    }),

    async execute(_id, params, signal) {
      const max = Math.min(Math.max(params.max_chars ?? 20_000, 500), 80_000);
      const offset = Math.max(params.offset ?? 0, 0);
      const page = await getJson(`${FETCH}/fetch?url=${encodeURIComponent(params.url)}`, signal, 40_000);
      const full: string = page.text ?? "";
      const slice = full.slice(offset, offset + max);
      const rest = full.length - offset - slice.length;
      const header = `# ${page.title || page.url}\nURL: ${page.url} (HTTP ${page.status}, ${page.contentType})\n\n`;
      const footer = rest > 0 ? `\n\n[... ${rest} more characters, call web_fetch with offset=${offset + slice.length}]` : "";
      return {
        content: text(header + slice + footer),
        details: { url: page.url, status: page.status, length: full.length },
      };
    },
  });
}
