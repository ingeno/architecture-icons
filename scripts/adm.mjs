#!/usr/bin/env node
// aws-diagram-miro engine: pivot spec -> ELK layout -> Miro Canvas Composer SVG.
//
// Commands
//   node adm.mjs resolve  --catalog catalog.json "s3" "nat gateway" "snowflake"
//   node adm.mjs render   --spec spec.json --catalog catalog.json --base URL [--logo-base URL] [--x 0 --y 0] [--out out.svg]
//   node adm.mjs readback --board board.svg --catalog catalog.json [--spec spec.json]
//                         (board.svg = canvas_read_as_svg of the frame and its spec card; prints the
//                          spec found on the board and the manual edits made since, as JSON)
//
// The spec (pivot format) is documented in SPEC.md next to this file.

import fs from "node:fs";
import ELK from "elkjs/lib/elk.bundled.js";

// ---------- AWS group conventions (AWS Architecture Icons guidelines) ----------
const GROUPS = {
  "aws-cloud":             { stroke: "#232F3E", fill: "none",    dash: false, icon: "grp:aws-cloud-logo" },
  "aws-account":           { stroke: "#E7157B", fill: "none",    dash: false, icon: "grp:aws-account" },
  "region":                { stroke: "#00A4A6", fill: "none",    dash: true,  icon: "grp:region" },
  "availability-zone":     { stroke: "#00A4A6", fill: "none",    dash: true,  icon: null },
  "vpc":                   { stroke: "#8C4FFF", fill: "none",    dash: false, icon: "grp:vpc" },
  "public-subnet":         { stroke: "#7AA116", fill: "#F2F6E8", dash: false, icon: "grp:public-subnet" },
  "private-subnet":        { stroke: "#00A4A6", fill: "#E6F6F7", dash: false, icon: "grp:private-subnet" },
  "security-group":        { stroke: "#DD344C", fill: "none",    dash: false, icon: null },
  "auto-scaling-group":    { stroke: "#ED7100", fill: "none",    dash: true,  icon: "grp:auto-scaling-group" },
  "corporate-data-center": { stroke: "#7D8998", fill: "none",    dash: false, icon: "grp:corporate-data-center" },
  "server-contents":       { stroke: "#7D8998", fill: "none",    dash: false, icon: "grp:server-contents" },
  "ec2-instance-contents": { stroke: "#ED7100", fill: "none",    dash: false, icon: "grp:ec2-instance-contents" },
  "spot-fleet":            { stroke: "#ED7100", fill: "none",    dash: false, icon: "grp:spot-fleet" },
  "greengrass-deployment": { stroke: "#7AA116", fill: "none",    dash: false, icon: "grp:greengrass-deployment" },
  "generic":               { stroke: "#7D8998", fill: "none",    dash: true,  icon: null },
};

const INK = "#232F3E";
const FONT = "arial";
const ICON = 64;
const NODE_W = 150;
const LINE_H = 17;
const CHARS_PER_LINE = 19;
const MARGIN = 60;

// ---------- helpers ----------
function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escBody = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const loadJSON = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

function wrapLines(text) {
  if (!text) return 0;
  let lines = 0;
  for (const para of String(text).split("\n")) {
    const words = para.split(/\s+/);
    let cur = 0, n = 1;
    for (const w of words) {
      if (cur && cur + 1 + w.length > CHARS_PER_LINE) { n++; cur = w.length; } else cur += (cur ? 1 : 0) + w.length;
    }
    lines += n;
  }
  return lines;
}

// ---------- catalog ----------
class Catalog {
  constructor(path) {
    const c = loadJSON(path);
    this.meta = c;
    this.byId = new Map(c.icons.map((e) => [e.id, e]));
  }
  // Returns ranked candidates for a free-text term.
  search(term, limit = 3) {
    const t = norm(term);
    if (this.byId.has(term)) return [{ ...this.byId.get(term), score: 100 }];
    const kindBonus = { svc: 3, res: 2, logo: 1, grp: 0, cat: -5 };
    const res = [];
    for (const e of this.byId.values()) {
      let s = 0;
      for (const a of e.aliases) {
        const na = norm(a);
        if (na === t) s = Math.max(s, 90);
        else if (na.startsWith(t + " ") || na.endsWith(" " + t)) s = Math.max(s, 60);
        else if (na.includes(t)) s = Math.max(s, 40);
        else {
          const tw = t.split(" ");
          const hits = tw.filter((w) => w.length > 1 && na.split(" ").includes(w)).length;
          if (hits) s = Math.max(s, 20 * hits / tw.length + 10);
        }
      }
      if (s) res.push({ ...e, score: s + kindBonus[e.kind] - e.name.length / 100 });
    }
    return res.sort((a, b) => b.score - a.score).slice(0, limit);
  }
  resolve(ref) {
    if (!ref || ref === "generic") return null;
    if (this.byId.has(ref)) return this.byId.get(ref);
    const [best] = this.search(ref, 1);
    return best && best.score >= 55 ? best : null;
  }
}

// ---------- spec validation ----------
function validate(spec) {
  const errs = [];
  const ids = new Set();
  for (const g of spec.groups || []) {
    if (!g.id) errs.push("group without id");
    if (ids.has(g.id)) errs.push(`duplicate id ${g.id}`);
    ids.add(g.id);
    if (!GROUPS[g.type]) errs.push(`group ${g.id}: unknown type "${g.type}" (use one of ${Object.keys(GROUPS).join(", ")})`);
  }
  for (const n of spec.nodes || []) {
    if (!n.id) errs.push("node without id");
    if (ids.has(n.id)) errs.push(`duplicate id ${n.id}`);
    ids.add(n.id);
  }
  for (const x of [...(spec.groups || []), ...(spec.nodes || [])])
    if (x.parent && !(spec.groups || []).some((g) => g.id === x.parent)) errs.push(`${x.id}: parent "${x.parent}" is not a group`);
  for (const e of spec.edges || [])
    for (const end of [e.from, e.to]) if (!ids.has(end)) errs.push(`edge ${e.from}->${e.to}: unknown end "${end}"`);
  return errs;
}

// ---------- layout ----------
async function layout(spec, cat) {
  const groups = spec.groups || [];
  const nodes = spec.nodes || [];
  const warnings = [];
  const resolved = new Map();
  for (const n of nodes) {
    const hit = cat.resolve(n.icon);
    if (!hit && n.icon && n.icon !== "generic") warnings.push(`node ${n.id}: no icon for "${n.icon}", drawn as a generic box`);
    resolved.set(n.id, hit);
  }
  const elkNode = (n) => {
    const hit = resolved.get(n.id);
    const title = n.title ?? (hit ? hit.label : n.icon || n.id);
    const lines = wrapLines(title) + wrapLines(n.label);
    const h = hit ? ICON + 8 + lines * LINE_H : Math.max(64, 16 + lines * LINE_H);
    return { id: n.id, width: NODE_W, height: h, _title: title };
  };
  const children = (parent) => [
    ...groups.filter((g) => (g.parent || null) === parent).map((g) => ({
      id: g.id,
      layoutOptions: {
        "elk.padding": "[top=56,left=28,bottom=28,right=28]",
        ...(g.direction ? { "elk.direction": g.direction } : {}),
      },
      children: children(g.id),
    })),
    ...nodes.filter((n) => (n.parent || null) === parent).map(elkNode),
  ];
  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": spec.direction || "RIGHT",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "48",
      "elk.layered.spacing.nodeNodeBetweenLayers": "96",
      "elk.spacing.edgeNode": "24",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.padding": "[top=0,left=0,bottom=0,right=0]",
    },
    children: children(null),
    edges: (spec.edges || []).map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
  };
  const out = await new ELK().layout(graph);
  const pos = new Map();
  const walk = (n, ox, oy) => {
    for (const c of n.children || []) {
      const x = ox + c.x, y = oy + c.y;
      pos.set(c.id, { x, y, w: c.width, h: c.height, title: c._title });
      walk(c, x, y);
    }
  };
  walk(out, 0, 0);
  // Which side of each end ELK attached the edge to: keeps Miro's router close to ELK's route.
  const sideOf = (pt, id) => {
    const b = pos.get(id);
    if (!b) return null;
    const d = { left: Math.abs(pt.x - b.x), right: Math.abs(pt.x - (b.x + b.w)), top: Math.abs(pt.y - b.y), bottom: Math.abs(pt.y - (b.y + b.h)) };
    return Object.entries(d).sort((a, c) => a[1] - c[1])[0][0];
  };
  const sides = new Map();
  for (const e of out.edges || []) {
    const secs = e.sections || [];
    if (!secs.length) continue;
    const i = Number(e.id.slice(1));
    const spec_e = (spec.edges || [])[i];
    // ELK gives section points relative to the edge's container (lowest common ancestor).
    const c = e.container && e.container !== "root" ? pos.get(e.container) : { x: 0, y: 0 };
    const abs = (pt) => ({ x: pt.x + c.x, y: pt.y + c.y });
    sides.set(i, [sideOf(abs(secs[0].startPoint), spec_e.from), sideOf(abs(secs[secs.length - 1].endPoint), spec_e.to)]);
  }
  return { pos, resolved, sides, width: out.width, height: out.height, warnings };
}

// One array item per line: readable in a Miro code widget without being huge.
function compactJSON(o) {
  const lines = ["{"];
  const keys = Object.keys(o);
  keys.forEach((k, i) => {
    const v = o[k];
    const comma = i < keys.length - 1 ? "," : "";
    if (Array.isArray(v)) {
      lines.push(` ${JSON.stringify(k)}: [`);
      v.forEach((x, j) => lines.push(`  ${JSON.stringify(x)}${j < v.length - 1 ? "," : ""}`));
      lines.push(` ]${comma}`);
    } else lines.push(` ${JSON.stringify(k)}: ${JSON.stringify(v)}${comma}`);
  });
  lines.push("}");
  return lines.join("\n");
}

// ---------- SVG emission ----------
function sideFor(a, b) {
  const dx = b.cx - a.cx, dy = b.cy - a.cy;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ["right", "left"] : ["left", "right"];
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

function depth(groups, id) {
  let d = 0, g = groups.find((x) => x.id === id);
  while (g && g.parent) { d++; g = groups.find((x) => x.id === g.parent); }
  return d;
}

async function render(opts) {
  const spec = loadJSON(opts.spec);
  const cat = new Catalog(opts.catalog);
  const errs = validate(spec);
  if (errs.length) { console.error(JSON.stringify({ ok: false, errors: errs }, null, 1)); process.exit(2); }
  const base = String(opts.base || "").replace(/\/?$/, "/");
  const logoBase = String(opts["logo-base"] || base).replace(/\/?$/, "/");
  const url = (e) => (e.kind === "logo" ? logoBase : base) + e.file;

  const L = await layout(spec, cat);
  const groups = spec.groups || [];
  const nodes = spec.nodes || [];
  const edges = spec.edges || [];
  const numbered = !!spec.numbered && (spec.steps || []).length > 0;
  const ox = MARGIN, oy = MARGIN + 20;
  const legendW = Math.max(520, Math.min(900, L.width));
  const legendLines = numbered ? spec.steps.reduce((a, s) => a + Math.max(1, Math.ceil(String(s.text).length / 95)), 1) : 0;
  const legendH = numbered ? 40 + legendLines * 22 : 0;
  const frameW = Math.round(Math.max(L.width, numbered ? legendW : 0) + 2 * MARGIN);
  const frameH = Math.round(oy + L.height + (numbered ? 60 + legendH : 0) + MARGIN);
  const fx = Number(opts.x || 0), fy = Number(opts.y || 0);
  const v = spec.version || 1;
  const frameTitle = `v${v} · ${spec.title || "Architecture"}${spec.change ? " · " + spec.change : ""}`;

  const out = [];
  const pairs = []; // [icon id, label id] to group in Miro after creation
  const P = (id) => { const p = L.pos.get(id); return { x: Math.round(ox + p.x), y: Math.round(oy + p.y), w: Math.round(p.w), h: Math.round(p.h), title: p.title }; };

  out.push(`<svg>`);
  out.push(`<g id="frame" transform="translate(${fx},${fy})" data-frame="${esc(frameTitle)}">`);
  out.push(`<rect data-type="frame" x="0" y="0" width="${frameW}" height="${frameH}" fill="#ffffff" data-title="${esc(frameTitle)}"/>`);

  // 1. groups, outermost first (z-order = creation order)
  const gs = [...groups].sort((a, b) => depth(groups, a.id) - depth(groups, b.id));
  for (const g of gs) {
    const st = GROUPS[g.type];
    const p = P(g.id);
    out.push(`<rect id="g_${g.id}" x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" fill="${st.fill}" stroke="${st.stroke}" stroke-width="2"${st.dash ? ' stroke-dasharray="5,5"' : ""}/>`);
  }
  for (const g of gs) {
    const st = GROUPS[g.type];
    const p = P(g.id);
    const icon = st.icon && cat.byId.get(st.icon);
    const label = g.label ?? g.type;
    if (icon) {
      out.push(`<image id="gi_${g.id}" data-type="image" href="${esc(url(icon))}" x="${p.x}" y="${p.y}" width="32" height="32"/>`);
      pairs.push([`gi_${g.id}`, `gt_${g.id}`]);
      out.push(`<text id="gt_${g.id}" x="${p.x + 40}" y="${p.y + 21}" font-family="${FONT}" font-size="14" fill="${INK}">${esc(label)}</text>`);
    } else {
      out.push(`<text id="gt_${g.id}" x="${p.x + 12}" y="${p.y + 21}" font-family="${FONT}" font-size="14" fill="${st.stroke === "#7D8998" ? INK : st.stroke}">${esc(label)}</text>`);
    }
  }

  // anchor widget for each node (image, or rect for generic boxes)
  const anchor = (id) => (groups.some((g) => g.id === id) ? `g_${id}` : L.resolved.get(id) ? `n_${id}` : `n_${id}`);
  const center = (id) => {
    if (groups.some((g) => g.id === id)) { const p = P(id); return { cx: p.x + p.w / 2, cy: p.y + p.h / 2 }; }
    const p = P(id);
    return L.resolved.get(id) ? { cx: p.x + p.w / 2, cy: p.y + ICON / 2 } : { cx: p.x + p.w / 2, cy: p.y + p.h / 2 };
  };

  // 2. connectors before nodes so icons sit on top
  edges.forEach((e, i) => {
    const [s1, s2] = L.sides.get(i) && L.sides.get(i)[0] && L.sides.get(i)[1] ? L.sides.get(i) : sideFor(center(e.from), center(e.to));
    const a = center(e.from), b = center(e.to);
    const label = e.label ? ` data-content="${esc(e.label)}"` : "";
    const dash = e.style === "dashed" ? ' stroke-dasharray="5,5"' : "";
    const arrow = e.bidirectional ? "both" : "end";
    out.push(`<line id="e_${i}" x1="${Math.round(a.cx)}" y1="${Math.round(a.cy)}" x2="${Math.round(b.cx)}" y2="${Math.round(b.cy)}" stroke="${INK}" stroke-width="2" data-arrow="${arrow}" data-shape="elbowed" data-start="${anchor(e.from)}" data-end="${anchor(e.to)}" data-start-side="${s1}" data-end-side="${s2}"${dash}${label}/>`);
  });

  // 3. nodes
  for (const n of nodes) {
    const p = P(n.id);
    const hit = L.resolved.get(n.id);
    const title = esc(p.title);
    const role = n.label ? esc(n.label).replace(/\n/g, "<br/>") : "";
    if (hit) {
      out.push(`<image id="n_${n.id}" data-type="image" href="${esc(url(hit))}" x="${p.x + (p.w - ICON) / 2}" y="${p.y}" width="${ICON}" height="${ICON}"/>`);
      pairs.push([`n_${n.id}`, `nt_${n.id}`]);
      out.push(`<textArea id="nt_${n.id}" x="${p.x}" y="${p.y + ICON + 6}" width="${p.w}" font-family="${FONT}" font-size="14" text-align="center" fill="${INK}">${title}${role ? "<br/>" + role : ""}</textArea>`);
    } else {
      out.push(`<rect id="n_${n.id}" x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="8" fill="#ffffff" stroke="#7D8998" stroke-width="2" data-content="&lt;b&gt;${title}&lt;/b&gt;${role ? "&lt;br&gt;" + role : ""}" data-text-color="${INK}" data-font-size="14" data-font-family="${FONT}"/>`);
    }
    if (n.status === "new" || n.status === "changed") {
      const tag = n.status === "new" ? "NEW" : "CHANGED";
      const w = n.status === "new" ? 46 : 78;
      out.push(`<rect id="d_${n.id}" x="${p.x + p.w - w + 6}" y="${p.y - 12}" width="${w}" height="22" rx="11" fill="#FFF6B6" stroke="#AF7E04" stroke-width="2" data-content="${tag}" data-text-color="#AF7E04" data-font-size="11" data-font-weight="bold" data-font-family="${FONT}"/>`);
    }
  }

  // 4. numbered step badges next to the source of each numbered edge
  if (numbered) {
    const perNode = new Map();
    for (const e of edges.filter((e) => e.step != null)) {
      const k = e.from;
      const idx = perNode.get(k) || 0;
      perNode.set(k, idx + 1);
      let bx, by;
      if (groups.some((g) => g.id === k)) { const p = P(k); bx = p.x + p.w - 14 - idx * 30; by = p.y - 14; }
      else { const p = P(k); const ix = L.resolved.get(k) ? p.x + (p.w - ICON) / 2 : p.x; bx = ix - 16 - idx * 30; by = p.y - 12; }
      out.push(`<circle id="s_${e.from}_${e.step}" cx="${bx}" cy="${by}" r="13" fill="${INK}" stroke="none" data-content="${esc(e.step)}" data-text-color="#FFFFFF" data-font-size="13" data-font-weight="bold" data-font-family="${FONT}"/>`);
    }
    const ly = Math.round(oy + L.height + 60);
    const body = spec.steps.map((s) => `<b>${esc(s.n)}</b>&#160;&#160;${esc(s.text)}`).join("<br/>");
    out.push(`<textArea id="legend" x="${ox}" y="${ly}" width="${legendW}" font-family="${FONT}" font-size="14" fill="${INK}"><b>${esc(spec.legendTitle || "Flow")}</b><br/>${body}</textArea>`);
  }
  out.push(`</g>`);

  // 5. spec kept next to the frame, outside it, so exports of the frame stay clean
  const specCopy = { ...spec };
  delete specCopy.miro;
  out.push(`<rect id="spec" data-type="custom-widget" data-widget-type="card" data-title="${esc(`aws-diagram-miro spec · v${v} · ${spec.title || ""} (do not delete)`)}" data-description="${esc(JSON.stringify(specCopy))}" data-color="#2d3142" x="${fx}" y="${fy + frameH + 40}" width="320" height="88" fill="none" stroke="none"/>`);
  out.push(`</svg>`);

  const svg = out.join("\n");
  if (opts.out) fs.writeFileSync(opts.out, svg);
  const summary = { ok: true, frame: { title: frameTitle, x: fx, y: fy, width: frameW, height: frameH }, warnings: L.warnings, icons: Object.fromEntries(nodes.map((n) => [n.id, L.resolved.get(n.id)?.id || "generic"])), group_pairs: pairs };
  if (opts.out) console.log(JSON.stringify(summary, null, 1));
  else console.log(svg);
}

// ---------- readback: detect manual edits on the board ----------
// Works from a canvas_read_as_svg scope read of the frame (plus a margin). The spec is re-laid out
// (ELK is deterministic) and board widgets are matched to it by position, so no ids need to be kept.
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
const decode = (h) => {
  let x = String(h || "");
  for (let i = 0; i < 3; i++) x = x.replace(/&amp;/g, "&").replace(/&#34;|&quot;/g, '"').replace(/&#43;/g, "+").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#160;|&nbsp;/g, " ");
  return x;
};
const strip = (h) => decode(h).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").trim();

async function readback(opts) {
  const board = fs.readFileSync(opts.board, "utf8");
  const els = parseElements(board);
  // Spec: from --spec, or from the spec card found in the board read.
  let spec;
  if (opts.spec) spec = loadJSON(opts.spec);
  else {
    const card = els.find((e) => e.attrs["data-widget-type"] === "card" && /aws-diagram-miro spec/.test(e.attrs["data-title"] || ""));
    if (!card) throw new Error("no spec card in the board read and no --spec given");
    spec = JSON.parse(decode(card.attrs["data-description"]));
  }
  const cat = new Catalog(opts.catalog);
  const L = await layout(spec, cat);
  const ox = MARGIN, oy = MARGIN + 20;

  // frame-relative board widgets (children of the frame <g>) + connectors (anywhere)
  const frameIdx = els.findIndex((e) => e.tag === "g" && e.attrs["data-frame"]);
  const frameEnd = frameIdx >= 0 ? board.indexOf("</g>", els[frameIdx].at) : -1;
  const inFrame = els.filter((e, i) => i > frameIdx && e.at < frameEnd && e.tag !== "g" && e.attrs["data-type"] !== "frame");
  const lines = els.filter((e) => e.tag === "line");
  const num = (v) => Number(v || 0);
  const imgs = inFrame.filter((e) => e.tag === "image").map((e) => ({ id: e.attrs.id, x: num(e.attrs.x), y: num(e.attrs.y), used: false }));
  const texts = inFrame.filter((e) => e.tag === "textArea" || e.tag === "text").map((e) => ({ id: e.attrs.id, x: num(e.attrs.x), y: num(e.attrs.y) - (e.tag === "text" ? 14 : 0), text: strip(e.body), used: false }));
  const shapes = inFrame.filter((e) => e.tag === "rect" && !e.attrs["data-widget-type"]).map((e) => ({ id: e.attrs.id, x: num(e.attrs.x), y: num(e.attrs.y), w: num(e.attrs.width), h: num(e.attrs.height), text: strip(e.attrs["data-content"] || ""), used: false }));
  const nearest = (list, x, y, tol) => {
    let best = null, bd = tol;
    for (const it of list) { if (it.used) continue; const d = Math.hypot(it.x - x, it.y - y); if (d <= bd) { bd = d; best = it; } }
    if (best) best.used = true;
    return best ? { ...best, dist: Math.round(bd) } : null;
  };

  const report = { spec_version: spec.version || 1, moved_nodes: [], relabeled_nodes: [], removed_nodes: [], relabeled_groups: [], new_icons: [], new_boxes: [], new_edges: [], removed_edges: [], relabeled_edges: [], new_texts: [] };
  const boardToNode = {};
  const P = (id) => { const p = L.pos.get(id); return { x: ox + p.x, y: oy + p.y, w: p.w, h: p.h, title: p.title }; };

  for (const g of spec.groups || []) {
    const p = P(g.id);
    const r = nearest(shapes, p.x, p.y, 40);
    if (r) boardToNode[r.id] = g.id;
    const icon = GROUPS[g.type]?.icon;
    const t = nearest(texts, p.x + (icon ? 40 : 12), p.y + 7, 40);
    if (icon) nearest(imgs, p.x, p.y, 20);
    const want = g.label ?? g.type;
    if (t && norm(t.text) !== norm(want)) report.relabeled_groups.push({ id: g.id, before: want, after: t.text });
  }
  for (const n of spec.nodes || []) {
    const p = P(n.id);
    const hit = L.resolved.get(n.id);
    const want = [p.title, n.label].filter(Boolean).join("\n");
    if (hit) {
      const im = nearest(imgs, p.x + (p.w - ICON) / 2, p.y, 120);
      if (!im) { report.removed_nodes.push(n.id); continue; }
      boardToNode[im.id] = n.id;
      if (im.dist > 8) report.moved_nodes.push({ id: n.id, by: im.dist });
      const t = nearest(texts, im.x - (p.w - ICON) / 2, im.y + ICON + 6, 60);
      if (t && norm(t.text) !== norm(want)) report.relabeled_nodes.push({ id: n.id, before: want, after: t.text });
      if (!t) report.relabeled_nodes.push({ id: n.id, before: want, after: "" });
    } else {
      const r = nearest(shapes, p.x, p.y, 120);
      if (!r) { report.removed_nodes.push(n.id); continue; }
      boardToNode[r.id] = n.id;
      if (norm(r.text) !== norm(want)) report.relabeled_nodes.push({ id: n.id, before: want, after: r.text });
    }
  }
  // leftovers = manual additions (badges, legend and markers are ours and ignored)
  for (const im of imgs.filter((i) => !i.used)) {
    const t = nearest(texts, im.x - (NODE_W - ICON) / 2, im.y + ICON + 6, 80);
    report.new_icons.push({ board_id: im.id, x: im.x, y: im.y, label: t ? t.text : null });
    boardToNode[im.id] = `new:${im.id}`;
  }
  for (const r of shapes.filter((x) => !x.used && x.text && !/^(NEW|CHANGED)$/.test(x.text))) {
    report.new_boxes.push({ board_id: r.id, text: r.text, x: r.x, y: r.y });
    boardToNode[r.id] = `new:${r.id}`;
  }
  for (const t of texts.filter((x) => !x.used && !/^Flow\n|^Flux\n/.test(x.text) && !(spec.legendTitle && x.text.startsWith(spec.legendTitle)))) report.new_texts.push({ board_id: t.id, text: t.text });

  const specEdges = new Map((spec.edges || []).map((e) => [`${e.from}>${e.to}`, e]));
  const seen = new Set();
  for (const l of lines) {
    const f = boardToNode[l.attrs["data-start"]], t = boardToNode[l.attrs["data-end"]];
    if (!f || !t) continue;
    const key = `${f}>${t}`;
    const label = strip(l.attrs["data-content"] || "");
    if (specEdges.has(key)) {
      seen.add(key);
      const e = specEdges.get(key);
      if (norm(label) !== norm(e.label || "")) report.relabeled_edges.push({ from: f, to: t, before: e.label || "", after: label });
    } else report.new_edges.push({ from: f, to: t, label });
  }
  for (const [k, e] of specEdges) if (!seen.has(k) && !report.removed_nodes.includes(e.from) && !report.removed_nodes.includes(e.to)) report.removed_edges.push({ from: e.from, to: e.to, label: e.label || "" });
  report.note = "Edges are only detected when the board read covered them; removed_edges can be false positives if the read scope was partial.";
  console.log(JSON.stringify({ spec, report }, null, 1));
}

// ---------- main ----------
const a = args(process.argv.slice(2));
const cmd = a._[0];
try {
  if (cmd === "resolve") {
    const cat = new Catalog(a.catalog);
    const res = {};
    for (const t of a._.slice(1)) res[t] = cat.search(t, Number(a.limit || 3)).map((e) => ({ id: e.id, label: e.label, name: e.name, score: Math.round(e.score) }));
    console.log(JSON.stringify(res, null, 1));
  } else if (cmd === "render") await render(a);
  else if (cmd === "readback") await readback(a);
  else { console.error("usage: node adm.mjs resolve|render|readback ..."); process.exit(1); }
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: String(e && e.stack || e) }));
  process.exit(3);
}
