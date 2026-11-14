// Pi extension "tokspeed": shows generation speed (tokens/s) of the local LLM in the footer.
// While streaming: live estimate (~4 chars per token). After each response: exact value
// from usage.output, measured from the first streamed token (decode speed, without
// prefill), plus time to first token and the session average.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const KEY = "tokspeed";
const CHARS_PER_TOKEN = 4;
const UPDATE_MS = 250;

export default function (pi: ExtensionAPI) {
  let start = 0; // request sent (message_start)
  let first = 0; // first streamed delta
  let chars = 0; // streamed characters (live estimate)
  let lastPaint = 0;
  let totalTokens = 0;
  let totalMs = 0;

  const fmt = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));

  pi.on("message_start", async (event) => {
    if ((event.message as any).role !== "assistant") return;
    start = performance.now();
    first = 0;
    chars = 0;
    lastPaint = 0;
  });

  pi.on("message_update", async (event, ctx) => {
    const e: any = event.assistantMessageEvent;
    if (typeof e?.delta !== "string") return; // text_delta, thinking_delta, toolcall_delta
    const now = performance.now();
    if (!first) first = now;
    chars += e.delta.length;
    if (now - lastPaint < UPDATE_MS || now - first < 300) return;
    lastPaint = now;
    const tps = chars / CHARS_PER_TOKEN / ((now - first) / 1000);
    ctx.ui.setStatus(KEY, ctx.ui.theme.fg("dim", `⚡ ~${fmt(tps)} tok/s`));
  });

  pi.on("message_end", async (event, ctx) => {
    const msg: any = event.message;
    if (msg.role !== "assistant" || !start) return;
    const end = performance.now();
    const out: number = msg.usage?.output ?? 0;
    const decodeMs = first ? end - first : 0;
    const ttft = first ? (first - start) / 1000 : undefined;
    start = 0;
    if (!out || decodeMs < 50) return; // aborted/empty response: keep last value

    const tps = out / (decodeMs / 1000);
    totalTokens += out;
    totalMs += decodeMs;
    const avg = totalTokens / (totalMs / 1000);
    const t = ctx.ui.theme;
    ctx.ui.setStatus(
      KEY,
      t.fg("accent", "⚡ ") +
        t.fg("dim", `${fmt(tps)} tok/s · ${out} tok`) +
        (ttft !== undefined ? t.fg("dim", ` · TTFT ${ttft.toFixed(1)}s`) : "") +
        t.fg("dim", ` · ⌀ ${fmt(avg)}`),
    );
  });
}
