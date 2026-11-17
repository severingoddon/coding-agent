// Pi extension "tokspeed": shows generation speed (tokens/s) of the local LLM in the footer.
// While streaming: live estimate (~4 chars per token). After each response: exact value
// from usage.output, measured from the first streamed token (decode speed, without
// prefill), plus time to first token and the session average.
// After the whole run (agent_end): total response time from submitting the prompt until the
// final answer is done, incl. thinking, all LLM turns and tool calls. Time spent waiting on
// blocking UI prompts (e.g. confirmations) is excluded.
// Overhead: only a few performance.now() calls per event, no timers, repaint throttled.
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
  let runStart = 0; // prompt submitted (agent_start)
  let promptStart = 0; // blocking UI prompt open since
  let promptMs = 0; // time spent in UI prompts during this run
  let lastStatus = ""; // last per-message status, extended with the total at agent_end

  const fmt = (n: number) => (n >= 100 ? n.toFixed(0) : n.toFixed(1));
  const fmtDur = (ms: number) => {
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    return `${Math.floor(s / 60)}m${Math.round(s % 60).toString().padStart(2, "0")}s`;
  };
  const elapsed = (now: number) => now - runStart - promptMs - (promptStart ? now - promptStart : 0);

  pi.on("agent_start", async () => {
    runStart = performance.now();
    promptStart = 0;
    promptMs = 0;
    lastStatus = "";
  });

  pi.on("ui_prompt_start", async () => {
    if (runStart && !promptStart) promptStart = performance.now();
  });

  pi.on("ui_prompt_end", async () => {
    if (!promptStart) return;
    promptMs += performance.now() - promptStart;
    promptStart = 0;
  });

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
    ctx.ui.setStatus(
      KEY,
      ctx.ui.theme.fg("dim", `⚡ ~${fmt(tps)} tok/s` + (runStart ? ` · ⏱ ${fmtDur(elapsed(now))}` : "")),
    );
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
    lastStatus =
      t.fg("accent", "⚡ ") +
      t.fg("dim", `${fmt(tps)} tok/s · ${out} tok`) +
      (ttft !== undefined ? t.fg("dim", ` · TTFT ${ttft.toFixed(1)}s`) : "") +
      t.fg("dim", ` · ⌀ ${fmt(avg)}`);
    ctx.ui.setStatus(KEY, lastStatus);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!runStart) return;
    const total = elapsed(performance.now());
    runStart = 0;
    promptStart = 0;
    const t = ctx.ui.theme;
    ctx.ui.setStatus(KEY, (lastStatus ? lastStatus + t.fg("dim", " · ") : "") + t.fg("dim", `⏱ ${fmtDur(total)}`));
  });
}
