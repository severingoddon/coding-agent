// Page fetch for Pi: GET /fetch?url=<url> → JSON { url, status, contentType, title, text }
// HTML is reduced to its main content with Readability and returned as Markdown.
// SSRF guard: no private/local targets (otherwise this would be a hole from the sandbox into the LAN).
import http from "node:http";
import dns from "node:dns/promises";
import net from "node:net";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

const PORT = 8080;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 25_000;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
turndown.remove(["script", "style", "noscript", "iframe", "svg"]);

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

async function assertPublic(url) {
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`Protocol not allowed: ${url.protocol}`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new Error(`Private target blocked: ${host} → ${address}`);
  }
}

async function readLimited(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) { await reader.cancel(); break; }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function fetchPage(rawUrl) {
  let url = new URL(rawUrl);
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let res;
  for (let hop = 0; ; hop++) {
    await assertPublic(url);
    res = await fetch(url, {
      redirect: "manual",
      signal,
      headers: {
        "user-agent": UA,
        accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8",
        "accept-language": "de-CH,de;q=0.9,en;q=0.8",
      },
    });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      if (hop >= MAX_REDIRECTS) throw new Error("Too many redirects");
      url = new URL(loc, url);
      continue;
    }
    break;
  }

  const contentType = res.headers.get("content-type") || "";
  const body = await readLimited(res);
  let title = "";
  let text;

  if (/html|xml/.test(contentType)) {
    const html = body.toString("utf8");
    const { document } = parseHTML(html);
    title = document.title || "";
    let article = null;
    try { article = new Readability(document).parse(); } catch {}
    const content = article?.content || document.body?.innerHTML || html;
    text = turndown.turndown(content);
    title = article?.title || title;
  } else if (/^text\/|json|javascript/.test(contentType) || !contentType) {
    text = body.toString("utf8");
  } else {
    text = `[Unsupported content type: ${contentType}, ${body.length} bytes]`;
  }

  return { url: url.href, status: res.status, contentType, title, text: text.trim() };
}

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (u.pathname === "/health") return send(200, { ok: true });
    if (u.pathname !== "/fetch" || !u.searchParams.get("url")) return send(400, { error: "GET /fetch?url=..." });
    try {
      send(200, await fetchPage(u.searchParams.get("url")));
    } catch (e) {
      send(502, { error: String(e?.cause?.code || e?.message || e) });
    }
  })
  .listen(PORT, () => console.log(`pidev-fetch listening on :${PORT}`));
