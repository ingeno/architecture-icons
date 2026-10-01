#!/usr/bin/env node
// aws-diagram-miro engine: pivot spec -> ELK layout -> Miro SVG (sent to Miro REST by rest.mjs).
//
// Commands
//   node adm.mjs resolve  --catalog catalog.json "s3" "nat gateway" "snowflake"
//   node adm.mjs render   --spec spec.json --catalog catalog.json --base URL [--logo-base URL] [--x 0 --y 0] [--out out.svg]
//   node adm.mjs readback --board board.svg --catalog catalog.json [--spec spec.json]
//                         (board.svg = `rest.mjs tosvg` of the frame and its spec card; prints the
//                          spec found on the board and the manual edits made since, as JSON)
//
// The spec (pivot format) is documented in SPEC.md next to this file.

import fs from "node:fs";
import ELK from "elkjs/lib/elk.bundled.js";
import { optimizeBest as optimize, previewSvg } from "./opt.mjs";

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
  // Ingeno conventions (on top of AWS ones)
  "internet":              { stroke: "#232F3E", fill: "none",    dash: false, icon: "res:internet", bold: true },
  "client-lane":           { stroke: "#232F3E", fill: "none",    dash: "2,2", icon: null },
  "context":               { stroke: "#FF6464", fill: "none",    dash: true,  icon: null, bold: true },
  "foundation":            { stroke: "#7D8998", fill: "#F7F7F7", dash: false, icon: null },
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


// ---------- normalize: Ingeno lane rules ----------
// 1. A client lane that holds a single item adds nothing: drop the box and keep the item.
// 2. When every member of a client lane has the same edge (same other end, label, style), draw one
//    edge from or to the lane instead of one per member. Partial matches stay per member.
const LANE_TYPES = new Set(["client-lane"]);
function normalize(spec) {
  const s = JSON.parse(JSON.stringify(spec));
  s.groups = s.groups || []; s.nodes = s.nodes || []; s.edges = s.edges || [];
  const notes = [];
  const kids = (gid) => [...s.groups.filter((g) => g.parent === gid), ...s.nodes.filter((n) => n.parent === gid)];
  for (const g of [...s.groups]) {
    if (!LANE_TYPES.has(g.type)) continue;
    const k = kids(g.id);
    if (k.length !== 1 || s.edges.some((e) => e.from === g.id || e.to === g.id)) continue;
    k[0].parent = g.parent; if (!k[0].parent) delete k[0].parent;
    s.groups = s.groups.filter((x) => x.id !== g.id);
    notes.push(`lane ${g.id} held only ${k[0].id}: box removed`);
  }
  for (const g of s.groups.filter((g) => LANE_TYPES.has(g.type))) {
    const members = kids(g.id).map((x) => x.id);
    if (members.length < 2) continue;
    for (const dir of ["from", "to"]) {
      const other = dir === "from" ? "to" : "from";
      const key = (e) => JSON.stringify([e[other], e.label || "", e.style || "solid", !!e.bidirectional]);
      const byKey = new Map();
      for (const e of s.edges) if (members.includes(e[dir]) && !members.includes(e[other])) {
        if (!byKey.has(key(e))) byKey.set(key(e), []);
        byKey.get(key(e)).push(e);
      }
      for (const list of byKey.values()) {
        const covered = new Set(list.map((e) => e[dir]));
        if (!members.every((m) => covered.has(m))) continue;
        const merged = { ...list[0], [dir]: g.id };
        if (list.some((e) => e.layout)) merged.layout = true;
        const at = s.edges.indexOf(list[0]);
        s.edges = s.edges.filter((e) => !list.includes(e));
        s.edges.splice(Math.min(at, s.edges.length), 0, merged);
        notes.push(`${list.map((e) => `${e.from}->${e.to}`).join(", ")} merged into ${merged.from}->${merged.to}`);
      }
    }
  }
  return { spec: s, notes };
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
        // Room between columns and rows inside every box, so arrow captions fit between them.
        "elk.spacing.nodeNode": "60",
        "elk.layered.spacing.nodeNodeBetweenLayers": "130",
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
      "elk.spacing.nodeNode": "60",
      "elk.layered.spacing.nodeNodeBetweenLayers": "130",
      "elk.spacing.edgeNode": "24",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.layered.nodePlacement.bk.fixedAlignment": "BALANCED",
      "elk.layered.nodePlacement.favorStraightEdges": "true",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.padding": "[top=0,left=0,bottom=0,right=0]",
    },
    children: children(null),
    // Dashed edges mean "X uses Y" (dependency). They do not drive the layout: a shared dependency
    // (WAF, Secrets Manager) would otherwise be pushed to the far end of the flow.
    edges: (spec.edges || []).map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to], dashed: e.style === "dashed" && !e.layout }))
      .filter((e) => !e.dashed).map(({ dashed, ...e }) => e),
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


// ---------- refine: Ingeno readability rules applied after ELK ----------
// 1. Column order: nodes stacked in the same column (same parent, same x) are reordered to
//    minimize crossings, counting dashed "uses" edges too (ELK ignores them).
// 2. Straight arrows: a node with one link is slid so its arrow runs straight, when there is room.
// 3. Sides: aligned ends get straight arrows; other dependencies get a single-bend L
//    (leave vertically, arrive horizontally) instead of a Z.
function refine(spec, L) {
  const groups = spec.groups || [], nodes = spec.nodes || [], edges = spec.edges || [];
  const isGroup = (id) => groups.some((g) => g.id === id);
  const parentOf = (id) => (groups.find((g) => g.id === id) || nodes.find((n) => n.id === id) || {}).parent || null;
  const box = (id) => L.pos.get(id);
  // anchor box: the icon for icon nodes, the whole box otherwise
  const abox = (id) => {
    const b = box(id);
    if (!isGroup(id) && L.resolved.get(id)) return { x: b.x + (b.w - ICON) / 2, y: b.y, w: ICON, h: ICON };
    return b;
  };
  const ctr = (id) => { const b = abox(id); return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; };
  const moveBy = (id, dx, dy) => {
    const b = box(id); b.x += dx; b.y += dy;
    if (isGroup(id)) for (const x of [...groups, ...nodes]) if (x.parent === id) moveBy(x.id, dx, dy);
  };
  const segX = (p1, p2, p3, p4) => {
    const d = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    return d(p1, p2, p3) * d(p1, p2, p4) < 0 && d(p3, p4, p1) * d(p3, p4, p2) < 0;
  };
  const crossings = () => {
    let n = 0;
    for (let i = 0; i < edges.length; i++) for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i], b = edges[j];
      if ([a.from, a.to].some((x) => x === b.from || x === b.to)) continue;
      if (segX(ctr(a.from), ctr(a.to), ctr(b.from), ctr(b.to))) n++;
    }
    return n;
  };
  const notes = [];
  // 1. column reorder
  const cols = new Map();
  for (const n of nodes) {
    const b = box(n.id);
    const k = `${n.parent || ""}|${Math.round(b.x)}`;
    if (!cols.has(k)) cols.set(k, []);
    cols.get(k).push(n.id);
  }
  const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((r) => [x, ...r])));
  for (const ids of cols.values()) {
    if (ids.length < 2 || ids.length > 6) continue;
    const start = [...ids].sort((a, b) => box(a).y - box(b).y);
    const top0 = box(start[0]).y;
    const gaps = start.slice(1).map((id, i) => box(id).y - (box(start[i]).y + box(start[i]).h));
    const place = (order) => { let y = top0; order.forEach((id, i) => { box(id).y = y; y += box(id).h + (gaps[i] ?? 0); }); };
    let best = start, bestN = crossings();
    for (const o of perms(start)) { place(o); const c = crossings(); if (c < bestN) { best = o; bestN = c; } }
    place(best);
    if (best.join() !== start.join()) notes.push(`column reordered: ${best.join(", ")}`);
  }
  // 2. straighten single-link nodes
  const degree = (id) => edges.filter((e) => e.from === id || e.to === id).length;
  const siblings = (id) => [...groups, ...nodes].filter((x) => x.id !== id && (x.parent || null) === parentOf(id)).map((x) => x.id);
  const fits = (id, dy) => {
    const b = box(id), nb = { x: b.x, y: b.y + dy, w: b.w, h: b.h };
    const par = parentOf(id);
    if (par) { const p = box(par), g = groups.find((x) => x.id === par); const top = (g.label ?? g.type) === "" ? 16 : 56; if (nb.y < p.y + top || nb.y + nb.h > p.y + p.h - 16) return false; }
    return siblings(id).every((s) => { const o = box(s); return nb.x + nb.w + 16 <= o.x || o.x + o.w + 16 <= nb.x || nb.y + nb.h + 16 <= o.y || o.y + o.h + 16 <= nb.y; });
  };
  const locked = new Set();
  // 2a. near misses (up to 40 px) are snapped straight, whatever the node's degree
  for (const e of edges) {
    for (const [mover, other] of [[e.to, e.from], [e.from, e.to]]) {
      if (isGroup(mover) || locked.has(mover)) continue;
      const a = ctr(mover), b = ctr(other);
      const dy = b.y - a.y;
      if (Math.abs(dy) < 0.5 || Math.abs(dy) > 40 || Math.abs(b.x - a.x) < Math.abs(b.y - a.y) || !fits(mover, dy)) continue;
      moveBy(mover, 0, dy); locked.add(mover); locked.add(other);
      notes.push(`${mover} snapped to ${other}`);
      break;
    }
  }
  // 2b. single-link nodes slide to their only partner
  for (const e of edges) {
    for (const [mover, other] of [[e.from, e.to], [e.to, e.from]]) {
      if (isGroup(mover) || degree(mover) !== 1 || locked.has(mover)) continue;
      const a = ctr(mover), b = ctr(other);
      if (Math.abs(b.x - a.x) < Math.abs(b.y - a.y)) continue; // mostly vertical: leave it
      const dy = b.y - a.y;
      if (Math.abs(dy) < 0.5 || !fits(mover, dy)) continue;
      moveBy(mover, 0, dy); locked.add(mover);
      notes.push(`${mover} aligned with ${other}`);
      break;
    }
  }
  // 3. sides. Flow arrows (solid) are settled first; dependencies (dashed) then pick, among
  //    four simple routes, the one that avoids a side already used by a flow arrow, then runs
  //    through the fewest icons, then has the fewest bends (vertical-first L on a tie).
  const sides = new Map();
  const used = new Set(); // "node|side" taken by solid edges
  const straight = (e) => {
    const a = abox(e.from), b = abox(e.to), ca = ctr(e.from), cb = ctr(e.to);
    const dx = cb.x - ca.x, dy = cb.y - ca.y;
    const hOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    const vOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    if (Math.abs(dy) <= 8 || (hOverlap > 24 && Math.abs(dx) > Math.abs(dy))) return dx >= 0 ? ["right", "left"] : ["left", "right"];
    if (Math.abs(dx) <= 8 || (vOverlap > 24 && Math.abs(dy) > Math.abs(dx))) return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
    return null;
  };
  edges.forEach((e, i) => {
    if (e.style === "dashed") return;
    const sd = straight(e) || L.sides.get(i) || sideFor({ cx: ctr(e.from).x, cy: ctr(e.from).y }, { cx: ctr(e.to).x, cy: ctr(e.to).y });
    sides.set(i, sd);
    used.add(`${e.from}|${sd[0]}`); used.add(`${e.to}|${sd[1]}`);
  });
  const hits = (e, pts) => nodes.filter((n) => n.id !== e.from && n.id !== e.to).filter((n) => {
    const b = box(n.id);
    return pts.slice(1).some((q, k) => {
      const p0 = pts[k];
      const x1 = Math.min(p0.x, q.x), x2 = Math.max(p0.x, q.x), y1 = Math.min(p0.y, q.y), y2 = Math.max(p0.y, q.y);
      return x2 >= b.x && x1 <= b.x + b.w && y2 >= b.y && y1 <= b.y + b.h;
    });
  }).length;
  edges.forEach((e, i) => {
    if (e.style !== "dashed") return;
    const st = straight(e);
    if (st) { sides.set(i, st); return; }
    const ca = ctr(e.from), cb = ctr(e.to), dx = cb.x - ca.x, dy = cb.y - ca.y;
    const V = dy >= 0 ? ["bottom", "top"] : ["top", "bottom"], H = dx >= 0 ? ["right", "left"] : ["left", "right"];
    const my = (ca.y + cb.y) / 2, mx = (ca.x + cb.x) / 2;
    const cands = [
      { sd: [V[0], H[1]], bends: 1, pts: [ca, { x: ca.x, y: cb.y }, cb] },
      { sd: [H[0], V[1]], bends: 1, pts: [ca, { x: cb.x, y: ca.y }, cb] },
      { sd: [V[0], V[1]], bends: 2, pts: [ca, { x: ca.x, y: my }, { x: cb.x, y: my }, cb] },
      { sd: [H[0], H[1]], bends: 2, pts: [ca, { x: mx, y: ca.y }, { x: mx, y: cb.y }, cb] },
    ].map((c, k) => ({ ...c, k, conflicts: used.has(`${e.from}|${c.sd[0]}`) + used.has(`${e.to}|${c.sd[1]}`), hits: hits(e, c.pts) }));
    cands.sort((a, b) => a.conflicts - b.conflicts || a.hits - b.hits || a.bends - b.bends || a.k - b.k);
    sides.set(i, cands[0].sd);
  });
  L.sides = sides;
  notes.push(`estimated crossings: ${crossings()}`);
  return notes;
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
  const raw = loadJSON(opts.spec);
  const cat = new Catalog(opts.catalog);
  const errs = validate(raw);
  if (errs.length) { console.error(JSON.stringify({ ok: false, errors: errs }, null, 1)); process.exit(2); }
  const { spec, notes } = normalize(raw);
  const base = String(opts.base || "").replace(/\/?$/, "/");
  const logoBase = String(opts["logo-base"] || base).replace(/\/?$/, "/");
  const url = (e) => (e.kind === "logo" ? logoBase : base) + e.file;

  const L = await layout(spec, cat);
  const refineNotes = refine(spec, L);
  const titles = new Map([...L.pos].map(([k, v]) => [k, v.title]));
  const quality = optimize(spec, L, titles, { iters: Number(opts.iters || 6000), seed: Number(opts.seed || 7) });
  if (opts.preview) fs.writeFileSync(opts.preview, previewSvg(spec, L, titles));
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
  const P = (id) => { const p = L.pos.get(id); return { x: Math.round(ox + p.x), y: Math.round(oy + p.y), w: Math.round(p.w), h: Math.round(p.h), title: p.title }; };

  out.push(`<svg>`);
  out.push(`<g id="frame" transform="translate(${fx},${fy})" data-frame="${esc(frameTitle)}">`);
  out.push(`<rect data-type="frame" x="0" y="0" width="${frameW}" height="${frameH}" fill="#ffffff" data-title="${esc(frameTitle)}"/>`);

  // 1. groups, outermost first (z-order = creation order)
  const gs = [...groups].sort((a, b) => depth(groups, a.id) - depth(groups, b.id));
  for (const g of gs) {
    const st = GROUPS[g.type];
    const p = P(g.id);
    out.push(`<rect id="g_${g.id}" x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" fill="${st.fill}" stroke="${st.stroke}" stroke-width="2"${st.dash ? ` stroke-dasharray="${st.dash === true ? "5,5" : st.dash}"` : ""}/>`);
  }
  for (const g of gs) {
    const st = GROUPS[g.type];
    const p = P(g.id);
    const icon = st.icon && cat.byId.get(st.icon);
    const label = g.label ?? g.type;
    const fw = st.bold ? ' font-weight="bold"' : "";
    if (label === "") continue;
    if (icon) {
      out.push(`<image id="gi_${g.id}" data-type="image" href="${esc(url(icon))}" x="${p.x}" y="${p.y}" width="32" height="32"/>`);
      out.push(`<text id="gt_${g.id}" x="${p.x + 40}" y="${p.y + 21}" font-family="${FONT}" font-size="14"${fw} fill="${INK}">${esc(label)}</text>`);
    } else {
      out.push(`<text id="gt_${g.id}" x="${p.x + 12}" y="${p.y + 21}" font-family="${FONT}" font-size="14"${fw} fill="${["#7D8998", "#232F3E"].includes(st.stroke) ? INK : st.stroke}">${esc(label)}</text>`);
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
    const t = L.capPos && L.capPos.get(i);
    const label = e.label ? ` data-content="${esc(e.label)}"${t != null && t !== 0.5 ? ` data-caption-position="${Math.round(t * 100)}%"` : ""}` : "";
    const dash = e.style === "dashed" ? ' stroke-dasharray="5,5"' : "";
    const arrow = e.bidirectional ? "both" : "end";
    // An arrow that leaves or arrives under an icon attaches to its label, so it never hides the text.
    const end = (id, side) => (side === "bottom" && !groups.some((g) => g.id === id) && L.resolved.get(id) ? `nt_${id}` : anchor(id));
    out.push(`<line id="e_${i}" x1="${Math.round(a.cx)}" y1="${Math.round(a.cy)}" x2="${Math.round(b.cx)}" y2="${Math.round(b.cy)}" stroke="${INK}" stroke-width="2" data-arrow="${arrow}" data-shape="elbowed" data-start="${end(e.from, s1)}" data-end="${end(e.to, s2)}" data-start-side="${s1}" data-end-side="${s2}"${dash}${label}/>`);
  });

  // 3. nodes
  for (const n of nodes) {
    const p = P(n.id);
    const hit = L.resolved.get(n.id);
    const title = esc(p.title);
    const role = n.label ? esc(n.label).replace(/\n/g, "<br/>") : "";
    if (hit) {
      out.push(`<image id="n_${n.id}" data-type="image" href="${esc(url(hit))}" x="${p.x + (p.w - ICON) / 2}" y="${p.y}" width="${ICON}" height="${ICON}"/>`);
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
  const summary = { ok: true, frame: { title: frameTitle, x: fx, y: fy, width: frameW, height: frameH }, warnings: L.warnings, normalized: notes, quality,
    // Pairs to group after creation (Miro REST POST /v2/boards/{id}/groups): icon + label move together.
    group_pairs: [...nodes.filter((n) => L.resolved.get(n.id)).map((n) => [`n_${n.id}`, `nt_${n.id}`]),
      ...groups.filter((g) => GROUPS[g.type].icon && (g.label ?? g.type) !== "").map((g) => [`gi_${g.id}`, `gt_${g.id}`])],
    icons: Object.fromEntries(nodes.map((n) => [n.id, L.resolved.get(n.id)?.id || "generic"])) };
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
  spec = normalize(spec).spec; // idempotent: the card already holds the normalized spec
  const cat = new Catalog(opts.catalog);
  const L = await layout(spec, cat);
  refine(spec, L);
  optimize(spec, L, new Map([...L.pos].map(([k, v]) => [k, v.title])), { iters: Number(opts.iters || 6000), seed: Number(opts.seed || 7) });
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
