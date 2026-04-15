import { parse, type HTMLElement, type Node } from "node-html-parser";

const BLOCK_TAGS = new Set([
  "p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "pre", "article", "section", "header", "footer",
]);

const VOID_BREAK_TAGS = new Set(["br", "hr"]);

const DROP_TAGS = new Set(["script", "style", "head", "noscript"]);

function walk(node: Node, out: string[]): void {
  if (node.nodeType === 3) {
    out.push(node.rawText);
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as HTMLElement;
  const tag = el.rawTagName?.toLowerCase();
  if (tag && DROP_TAGS.has(tag)) return;
  if (tag && VOID_BREAK_TAGS.has(tag)) {
    out.push("\n");
    return;
  }
  const isBlock = tag !== undefined && BLOCK_TAGS.has(tag);
  if (isBlock) out.push("\n");
  for (const child of el.childNodes) walk(child, out);
  if (isBlock) out.push("\n");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) =>
      String.fromCodePoint(Number.parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d: string) =>
      String.fromCodePoint(Number.parseInt(d, 10)),
    )
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&amp;/g, "&");
}

function normalize(raw: string): string {
  const decoded = decodeEntities(raw).replace(/\u00a0/g, " ");
  const lines = decoded.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim());
  const out: string[] = [];
  let blanks = 0;
  for (const line of lines) {
    if (line === "") {
      blanks += 1;
      if (blanks <= 1) out.push("");
    } else {
      blanks = 0;
      out.push(line);
    }
  }
  while (out.length > 0 && out[0] === "") out.shift();
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

export function htmlToText(html: string): string {
  if (html.trim() === "") return "";
  const cleaned = html.replace(/<!DOCTYPE[^>]*>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const root = parse(cleaned, {
    comment: false,
    blockTextElements: { script: false, noscript: false, style: false, pre: true },
  });
  const buf: string[] = [];
  for (const child of root.childNodes) walk(child, buf);
  return normalize(buf.join(""));
}
