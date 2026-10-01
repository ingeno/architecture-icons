#!/usr/bin/env node
// aws-diagram-miro: Miro REST API v2 bridge (used through the Ingeno MCP "miro" connection).
//
// The layout engine (adm.mjs render) still writes a Miro SVG. This file turns that SVG into REST calls,
// and turns REST listings back into the same SVG dialect so `adm.mjs readback` keeps working.
//
// Commands
//   node rest.mjs plan   --svg diagram.svg --board <board id> [--out plan.json]
//        Prints the calls to make, in order. Bodies that need an id created earlier hold
//        placeholders: "@frame" and "@<svg id>" (ex. "@n_api").
//   node rest.mjs ids    --plan plan.json --frame <frame id> --items items1.json [items2.json ...] [--out ids.json]
//        Matches the frame children listed by GET /v2/boards/{b}/items?parent_item_id=<frame>
//        to the plan by type and position. Writes { "<svg id>": "<miro id>" }.
//   node rest.mjs fill   --plan plan.json --ids ids.json --step connectors|groups
//        Prints the request bodies of that step with every placeholder replaced by a Miro id.
//   node rest.mjs tosvg  --items items1.json [...] --connectors conn1.json [...] --frame <frame id> [--card card.json] [--out board.svg]
//        Rebuilds an SVG in the canvas_read_as_svg dialect for `adm.mjs readback`.

import fs from "node:fs";

// ---------- helpers ----------
function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const vals = [];
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) vals.push(argv[++i]);
      out[k] = vals.length === 0 ? true : vals.length === 1 ? vals[0] : vals;
    } else out._.push(a);
  }
  return out;
}
const list = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const loadJSON = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const num = (v) => Number(v || 0);
const decode = (h) => {
  let x = String(h || "");
  for (let i = 0; i < 3; i++) x = x.replace(/&amp;/g, "&").replace(/&#34;|&quot;/g, '"').replace(/&#43;/g, "+").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#160;|&nbsp;/g, " ");
  return x;
};
const escAttr = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function parseElements(svg) {
  const els = [];
  const re = /<(g|rect|image|text|textArea|line|circle)\b([^>]*?)(\/?)>/g;
  let m;
  while ((m = re.exec(svg))) {
    const attrs = {};
    for (const a of m[2].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    let body = "";
    if (!m[3] && ["text", "textArea"].includes(m[1])) {
      const end = svg.indexOf(`</${m[1]}>`, re.lastIndex);
      if (end > -1) body = svg.slice(re.lastIndex, end);
    }
    els.push({ tag: m[1], attrs, body, at: m.index });
  }
  return els;
}

// Text height estimate, shared by plan (top-left -> center) and tosvg (center -> top-left).
const LINE_H = 20;
function textLines(html, width, size = 14) {
  const plain = decode(String(html)).replace(/<\/p>\s*<p>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
  const per = Math.max(4, Math.floor((width - 8) / (size * 0.5)));
  let n = 0;
  for (const para of plain.split("\n")) {
    let cur = 0, k = 1;
    for (const w of para.split(/\s+/).filter(Boolean)) {
      if (cur && cur + 1 + w.length > per) { k++; cur = w.length; } else cur += (cur ? 1 : 0) + w.length;
    }
    n += k;
  }
  return Math.max(1, n);
}
const textH = (html, width, size) => textLines(html, width, size) * LINE_H + 8;
const textW = (s, size = 14) => Math.round(decode(s).replace(/<[^>]+>/g, "").length * size * 0.6 + 16);

// SVG markup in labels -> Miro REST rich text
const toHtml = (body) => "<p>" + decode(body).replace(/<br\s*\/?>/gi, "<br>").replace(/<b>/g, "<strong>").replace(/<\/b>/g, "</strong>") + "</p>";

function borderStyle(dash) {
  if (!dash) return "normal";
  const [a] = String(dash).split(",").map(Number);
  return a <= 2 ? "dotted" : "dashed";
}
const side = (s) => (["top", "bottom", "left", "right"].includes(s) ? s : "auto");

// ---------- plan ----------
function plan(opts) {
  const svg = fs.readFileSync(opts.svg, "utf8");
  const els = parseElements(svg);
  const board = String(opts.board || "<board>");
  const B = `https://api.miro.com/v2/boards/${encodeURIComponent(decodeURIComponent(board))}`;
  const g = els.find((e) => e.tag === "g" && e.attrs["data-frame"]);
  const fr = els.find((e) => e.tag === "rect" && e.attrs["data-type"] === "frame");
  const [fx, fy] = (g.attrs.transform.match(/translate\(([-\d.]+),\s*([-\d.]+)\)/) || [0, 0, 0]).slice(1).map(Number);
  const fw = num(fr.attrs.width), fh = num(fr.attrs.height);
  const frameEnd = svg.indexOf("</g>", g.at);

  const items = []; // { ref, type, x, y (center, frame-relative), body }
  const connectors = [];
  let card = null;
  for (const e of els) {
    const a = e.attrs;
    if (e.tag === "g" || a["data-type"] === "frame") continue;
    const inFrame = e.at > g.at && e.at < frameEnd;
    if (e.tag === "line") {
      const caption = a["data-content"] ? [{ content: decode(a["data-content"]), position: a["data-caption-position"] || "50%" }] : undefined;
      const dashed = !!a["stroke-dasharray"];
      const both = a["data-arrow"] === "both";
      connectors.push({ ref: a.id, body: {
        startItem: { id: "@" + a["data-start"], snapTo: side(a["data-start-side"]) },
        endItem: { id: "@" + a["data-end"], snapTo: side(a["data-end-side"]) },
        shape: a["data-shape"] === "straight" ? "straight" : "elbowed",
        ...(caption ? { captions: caption } : {}),
        style: { strokeColor: a.stroke || "#232F3E", strokeWidth: String(a["stroke-width"] || 2), strokeStyle: dashed ? "dashed" : "normal",
          startStrokeCap: both ? "stealth" : "none", endStrokeCap: "stealth", fontSize: "14", color: "#232F3E" },
      } });
      continue;
    }
    if (a["data-widget-type"] === "card") {
      card = { ref: a.id, body: { data: { title: decode(a["data-title"]), description: decode(a["data-description"]) },
        style: { cardTheme: a["data-color"] || "#2d3142" },
        position: { x: num(a.x) + num(a.width) / 2, y: num(a.y) + num(a.height) / 2 }, geometry: { width: num(a.width) } } };
      continue;
    }
    if (!inFrame) continue;
    if (e.tag === "image") {
      const w = num(a.width), h = num(a.height);
      items.push({ ref: a.id, type: "image", x: num(a.x) + w / 2, y: num(a.y) + h / 2,
        body: { type: "image", data: { url: decode(a.href) }, geometry: { width: w } } });
    } else if (e.tag === "rect" || e.tag === "circle") {
      const circle = e.tag === "circle";
      const w = circle ? 2 * num(a.r) : num(a.width), h = circle ? 2 * num(a.r) : num(a.height);
      const cx = circle ? num(a.cx) : num(a.x) + w / 2, cy = circle ? num(a.cy) : num(a.y) + h / 2;
      const fill = a.fill && a.fill !== "none" ? a.fill : null;
      const stroke = a.stroke && a.stroke !== "none" ? a.stroke : null;
      const content = a["data-content"] ? decode(a["data-content"]) : "";
      const bold = a["data-font-weight"] === "bold";
      items.push({ ref: a.id, type: "shape", x: cx, y: cy, body: { type: "shape",
        data: { shape: circle ? "circle" : a.rx ? "round_rectangle" : "rectangle", content: content ? `<p>${bold ? `<strong>${content}</strong>` : content}</p>`.replace(/<br\s*\/?>/gi, "<br>").replace(/<b>/g, "<strong>").replace(/<\/b>/g, "</strong>") : "" },
        style: { fillColor: fill || "#ffffff", fillOpacity: fill ? "1.0" : "0.0",
          borderColor: stroke || "#ffffff", borderOpacity: stroke ? "1.0" : "0.0", borderWidth: String(a["stroke-width"] || 2), borderStyle: borderStyle(a["stroke-dasharray"]),
          color: a["data-text-color"] || "#232F3E", fontSize: String(a["data-font-size"] || 14), fontFamily: a["data-font-family"] || "arial",
          textAlign: "center", textAlignVertical: "middle" },
        geometry: { width: w, height: h } } });
    } else if (e.tag === "textArea") {
      const w = num(a.width), size = num(a["font-size"] || 14);
      const html = toHtml(e.body);
      items.push({ ref: a.id, type: "text", x: num(a.x) + w / 2, y: num(a.y) + textH(html, w, size) / 2, body: { type: "text",
        data: { content: html }, style: { color: a.fill || "#232F3E", fontSize: String(size), fontFamily: a["font-family"] || "arial", textAlign: a["text-align"] || "left" },
        geometry: { width: w } } });
    } else if (e.tag === "text") {
      const size = num(a["font-size"] || 14);
      const label = decode(e.body);
      const w = textW(label, size);
      const html = `<p>${a["font-weight"] === "bold" ? `<strong>${label}</strong>` : label}</p>`;
      // SVG text y is the baseline: top of the box is about one font size above it.
      items.push({ ref: a.id, type: "text", x: num(a.x) - 4 + w / 2, y: num(a.y) - size - 4 + textH(html, w, size) / 2, body: { type: "text",
        data: { content: html }, style: { color: a.fill || "#232F3E", fontSize: String(size), fontFamily: a["font-family"] || "arial", textAlign: "left" },
        geometry: { width: w } } });
    }
  }

  // Groups: icon + label of every node, icon + title of every AWS group.
  const ids = new Set(items.map((i) => i.ref));
  const groups = [];
  for (const i of items) {
    if (/^n_/.test(i.ref) && ids.has("nt_" + i.ref.slice(2)) && i.type === "image") groups.push(["@" + i.ref, "@nt_" + i.ref.slice(2)]);
    if (/^gi_/.test(i.ref) && ids.has("gt_" + i.ref.slice(3))) groups.push(["@" + i.ref, "@gt_" + i.ref.slice(3)]);
  }

  const batches = [];
  for (let k = 0; k < items.length; k += 20) batches.push(items.slice(k, k + 20));
  const calls = [];
  calls.push({ step: "frame", method: "POST", url: `${B}/frames`, body: { data: { title: decode(fr.attrs["data-title"] || g.attrs["data-frame"]), format: "custom", type: "freeform" },
    position: { x: Math.round(fx + fw / 2), y: Math.round(fy + fh / 2) }, geometry: { width: fw, height: fh } } });
  batches.forEach((b, k) => calls.push({ step: `items:${k + 1}/${batches.length}`, method: "POST", url: `${B}/items/bulk`,
    body: b.map((i) => ({ ...i.body, position: { x: Math.round(i.x * 10) / 10, y: Math.round(i.y * 10) / 10 }, parent: { id: "@frame" } })) }));
  if (card) calls.push({ step: "card", method: "POST", url: `${B}/cards`, body: card.body });
  calls.push({ step: "list", method: "GET", url: `${B}/items?parent_item_id=@frame&limit=50`, note: "page with &cursor= until no cursor; save each page (max_inline_bytes 0, then curl) for `rest.mjs ids`" });
  connectors.forEach((c) => calls.push({ step: "connectors", ref: c.ref, method: "POST", url: `${B}/connectors`, body: c.body }));
  groups.forEach((p) => calls.push({ step: "groups", method: "POST", url: `${B}/groups`, body: { data: { items: p } } }));

  const out = { board, frame: { x: fx, y: fy, width: fw, height: fh }, items: items.map(({ ref, type, x, y }) => ({ ref, type, x, y })), calls };
  if (opts.out) fs.writeFileSync(opts.out, JSON.stringify(out, null, 1));
  const count = (s) => calls.filter((c) => c.step === s || c.step.startsWith(s + ":")).length;
  console.log(JSON.stringify({ ok: true, items: items.length, calls: { frame: 1, bulk: count("items"), card: card ? 1 : 0, list: 1, connectors: count("connectors"), groups: count("groups"), total: calls.length },
    order: "frame, items (bulk), card, list + ids, connectors, groups" }, null, 1));
}

// ---------- ids: match listed frame children to plan items ----------
function readPages(files) {
  return list(files).flatMap((f) => { const d = loadJSON(f); return d.data || d; });
}
function matchIds(opts) {
  const p = loadJSON(opts.plan);
  const listed = readPages(opts.items).filter((i) => !i.parent || String(i.parent.id) === String(opts.frame));
  const pool = listed.map((i) => ({ id: i.id, type: i.type, x: i.position.x, y: i.position.y, used: false }));
  const ids = { frame: String(opts.frame) };
  const misses = [];
  // Exact positions first (we set them), then nearest within 30 px.
  for (const pass of [2, 30]) {
    for (const it of p.items) {
      if (ids[it.ref]) continue;
      let best = null, bd = pass;
      for (const c of pool) {
        if (c.used || c.type !== it.type) continue;
        const d = Math.hypot(c.x - it.x, c.y - it.y);
        if (d <= bd) { bd = d; best = c; }
      }
      if (best) { best.used = true; ids[it.ref] = best.id; }
    }
  }
  for (const it of p.items) if (!ids[it.ref]) misses.push(it.ref);
  if (opts.out) fs.writeFileSync(opts.out, JSON.stringify(ids, null, 1));
  console.log(JSON.stringify({ ok: misses.length === 0, matched: Object.keys(ids).length - 1, of: p.items.length, misses, extra_on_board: pool.filter((c) => !c.used).length }, null, 1));
}

// ---------- fill: resolve placeholders for one step ----------
function fill(opts) {
  const p = loadJSON(opts.plan);
  const ids = loadJSON(opts.ids);
  const sub = (v) => (typeof v === "string" && v.startsWith("@") ? (ids[v.slice(1)] ?? (() => { throw new Error("no id for " + v); })()) : v);
  const walk = (o) => (Array.isArray(o) ? o.map(walk) : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, walk(v)])) : sub(o));
  const steps = p.calls.filter((c) => c.step === opts.step || c.step.startsWith(opts.step + ":"));
  const out = steps.map((c) => ({ method: c.method, url: c.url.replace("@frame", ids.frame), body: JSON.stringify(walk(c.body)) }));
  console.log(JSON.stringify(out, null, 1));
}

// ---------- tosvg: REST listing -> canvas_read_as_svg dialect ----------
function tosvg(opts) {
  const frameId = String(opts.frame);
  const all = readPages(opts.items);
  const frame = all.find((i) => String(i.id) === frameId) || (opts["frame-json"] ? loadJSON(opts["frame-json"]) : null);
  const kids = all.filter((i) => i.parent && String(i.parent.id) === frameId);
  const conns = readPages(opts.connectors);
  const kidIds = new Set(kids.map((k) => String(k.id)));
  const out = ["<svg>"];
  const title = frame?.data?.title || opts.title || "frame";
  const fw = frame?.geometry?.width || 0, fh = frame?.geometry?.height || 0;
  const fx = frame ? frame.position.x - fw / 2 : 0, fy = frame ? frame.position.y - fh / 2 : 0;
  out.push(`<g data-miro-id="${frameId}" transform="translate(${fx},${fy})" data-frame="${escAttr(title)}">`);
  out.push(`<rect data-type="frame" x="0" y="0" width="${fw}" height="${fh}"/>`);
  for (const i of kids) {
    const w = i.geometry?.width || 0, h = i.geometry?.height || 0;
    const cx = i.position.x, cy = i.position.y;
    if (i.type === "image") out.push(`<image id="${i.id}" data-miro-id="${i.id}" data-type="image" x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}"/>`);
    else if (i.type === "shape") out.push(`<rect id="${i.id}" data-miro-id="${i.id}" x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" data-content="${escAttr(i.data?.content || "")}"/>`);
    else if (i.type === "text") {
      const html = i.data?.content || "";
      const th = textH(html, w, Number(i.style?.fontSize || 14));
      const body = decode(html).replace(/<\/p>\s*<p>/gi, "<br/>").replace(/<\/?p>/gi, "").replace(/<br\s*\/?>/gi, "<br/>");
      out.push(`<textArea id="${i.id}" data-miro-id="${i.id}" x="${cx - w / 2}" y="${cy - th / 2}" width="${w}">${body}</textArea>`);
    }
  }
  out.push("</g>");
  for (const c of conns) {
    const s = String(c.startItem?.id || ""), e = String(c.endItem?.id || "");
    if (!kidIds.has(s) && !kidIds.has(e)) continue;
    const cap = (c.captions || []).map((x) => x.content).join(" ");
    out.push(`<line id="${c.id}" data-miro-id="${c.id}" data-start="${s}" data-end="${e}"${cap ? ` data-content="${escAttr(cap)}"` : ""}/>`);
  }
  if (opts.card) {
    const cd = loadJSON(opts.card);
    const c = cd.data && !Array.isArray(cd.data) ? cd : (cd.data || [cd])[0];
    out.push(`<rect id="${c.id}" data-type="custom-widget" data-widget-type="card" data-title="${escAttr(c.data.title)}" data-description="${escAttr(c.data.description)}"/>`);
  }
  out.push("</svg>");
  const svg = out.join("\n");
  if (opts.out) fs.writeFileSync(opts.out, svg); else console.log(svg);
  if (opts.out) console.log(JSON.stringify({ ok: true, frame_children: kids.length, connectors: out.filter((l) => l.startsWith("<line")).length }));
}

const a = args(process.argv.slice(2));
try {
  const cmd = a._[0];
  if (cmd === "plan") plan(a);
  else if (cmd === "ids") matchIds(a);
  else if (cmd === "fill") fill(a);
  else if (cmd === "tosvg") tosvg(a);
  else { console.error("usage: node rest.mjs plan|ids|fill|tosvg ..."); process.exit(1); }
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: String(e && e.stack || e) }));
  process.exit(3);
}
