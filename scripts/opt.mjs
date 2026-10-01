// aws-diagram-miro readability optimizer.
//
// ELK gives a sound first layout, but it ignores dependency (dashed) edges and it does not know how
// Miro draws elbowed connectors. This module models the route Miro draws for each connector from
// the sides it is attached to, scores the whole diagram the way a reader would (crossings, lines
// through icons or labels, lines on top of each other, bends, length) and then moves icons and
// boxes inside their parent group, and picks connector sides, to lower that score.
//
// Everything here works on L.pos (id -> {x, y, w, h}, absolute, top-left) and L.sides
// (edge index -> [startSide, endSide]).

const ICON = 64, LABEL_TOP = 70, LINE_H = 17, STUB = 20;
// Icons closer than ALIGN px to a common row or column get lined up (ALIGN_SIB inside the same box).
const ALIGN = 48, ALIGN_SIB = 100;
const W = { cross: 10, hit: 25, overlap: 20, trunk: 3, bend: 1.5, detour: 30, len: 0.01, backward: 30, drift: 0.03, misalign: 3, text: 15 };
const SIDES = ["top", "right", "bottom", "left"];
const N = { top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function makeModel(spec, L, titles) {
  const groups = spec.groups || [], nodes = spec.nodes || [], edges = spec.edges || [];
  const gById = new Map(groups.map((g) => [g.id, g]));
  const isGroup = (id) => gById.has(id);
  const hasIcon = (id) => !isGroup(id) && !!L.resolved.get(id);
  const parentOf = (id) => (gById.get(id) || nodes.find((n) => n.id === id) || {}).parent || null;
  const kids = (id) => [...groups.filter((g) => g.parent === id).map((g) => g.id), ...nodes.filter((n) => n.parent === id).map((n) => n.id)];
  const descendants = (id) => kids(id).flatMap((k) => [k, ...descendants(k)]);
  const box = (id) => L.pos.get(id);

  // label text extent (Miro centers it under the icon)
  const labelLines = new Map(nodes.map((n) => {
    const t = [titles.get(n.id) || n.title || n.id, n.label].filter(Boolean).join("\n");
    return [n.id, t.split("\n")];
  }));
  const iconBox = (id) => { const b = box(id); return hasIcon(id) ? { x: b.x + (b.w - ICON) / 2, y: b.y, w: ICON, h: ICON } : { ...b }; };
  const labelBox = (id) => {
    const b = box(id), lines = labelLines.get(id) || [""];
    const w = Math.min(b.w, Math.max(...lines.map((l) => l.length)) * 7.4 + 8);
    return { x: b.x + (b.w - w) / 2, y: b.y + LABEL_TOP, w, h: lines.length * LINE_H + 4 };
  };
  const anchorBox = (id, side) => (isGroup(id) ? { ...box(id) } : side === "bottom" && hasIcon(id) ? labelBox(id) : iconBox(id));
  const port = (id, side) => {
    const b = anchorBox(id, side);
    return { top: { x: b.x + b.w / 2, y: b.y }, bottom: { x: b.x + b.w / 2, y: b.y + b.h }, left: { x: b.x, y: b.y + b.h / 2 }, right: { x: b.x + b.w, y: b.y + b.h / 2 } }[side];
  };
  const center = (id) => { const b = isGroup(id) ? box(id) : iconBox(id); return { x: b.x + b.w / 2, y: b.y + b.h / 2 }; };

  // Route Miro draws for an elbowed connector between two ports.
  function route(p0, s0, p1, s1) {
    const n0 = N[s0], n1 = N[s1];
    const sg = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    if (n0.x && n1.x && n0.x === -n1.x && sg(dx) === n0.x && Math.abs(dx) > 2 * STUB) {
      if (Math.abs(dy) < 1) return { pts: [p0, p1], bends: 0 };
      const mx = (p0.x + p1.x) / 2;
      return { pts: [p0, { x: mx, y: p0.y }, { x: mx, y: p1.y }, p1], bends: 2 };
    }
    if (n0.y && n1.y && n0.y === -n1.y && sg(dy) === n0.y && Math.abs(dy) > 2 * STUB) {
      if (Math.abs(dx) < 1) return { pts: [p0, p1], bends: 0 };
      const my = (p0.y + p1.y) / 2;
      return { pts: [p0, { x: p0.x, y: my }, { x: p1.x, y: my }, p1], bends: 2 };
    }
    if (n0.x && n1.y && sg(dx) === n0.x && Math.abs(dx) > STUB && sg(p0.y - p1.y) === n1.y && Math.abs(dy) > STUB)
      return { pts: [p0, { x: p1.x, y: p0.y }, p1], bends: 1 };
    if (n0.y && n1.x && sg(dy) === n0.y && Math.abs(dy) > STUB && sg(p0.x - p1.x) === n1.x && Math.abs(dx) > STUB)
      return { pts: [p0, { x: p0.x, y: p1.y }, p1], bends: 1 };
    const a = { x: p0.x + n0.x * STUB, y: p0.y + n0.y * STUB }, b = { x: p1.x + n1.x * STUB, y: p1.y + n1.y * STUB };
    const c = n0.x ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
    return { pts: [p0, a, c, b, p1], bends: 4, detour: true };
  }

  const segs = (pts) => pts.slice(1).map((q, k) => [pts[k], q]).filter(([p, q]) => Math.abs(p.x - q.x) + Math.abs(p.y - q.y) > 0.5);
  const segHitsBox = ([p, q], b) => {
    const m = 2, x1 = Math.min(p.x, q.x), x2 = Math.max(p.x, q.x), y1 = Math.min(p.y, q.y), y2 = Math.max(p.y, q.y);
    return x2 > b.x + m && x1 < b.x + b.w - m && y2 > b.y + m && y1 < b.y + b.h - m;
  };
  // One obstacle per node: icon and label together, with a little air around them, so a line
  // cannot slip between an icon and its own label.
  const obstacles = () => nodes.map((n) => {
    if (!hasIcon(n.id)) return [n.id, box(n.id)];
    const a = iconBox(n.id), l = labelBox(n.id), pad = 12;
    const x = Math.min(a.x, l.x) - pad, y = a.y - pad;
    return [n.id, { x, y, w: Math.max(a.x + a.w, l.x + l.w) + pad - x, h: l.y + l.h + pad - y }];
  });

  // Group titles (icon + text in the top-left corner) are text too: no line may run over them.
  const groupTitles = groups.filter((g) => (g.label ?? g.type) !== "").map((g) => {
    const b = box(g.id), w = 40 + String(g.label ?? g.type).length * 7.6;
    return [g.id, { x: b.x - 2, y: b.y - 2, w, h: 36 }];
  });
  // Group borders, as segments, so an arrow caption is never drawn across a box outline.
  const borders = () => groups.flatMap((g) => {
    const b = box(g.id), a = { x: b.x, y: b.y }, c = { x: b.x + b.w, y: b.y }, d = { x: b.x + b.w, y: b.y + b.h }, e = { x: b.x, y: b.y + b.h };
    return [[a, c], [c, d], [d, e], [e, a]];
  });
  // Miro puts a connector caption in the middle of the path (by length).
  // With the REST API the caption can sit anywhere along the path (t = 0..1, default the middle).
  const capT = new Map();
  function captionBox(S, text, t = 0.5) {
    if (!text) return null;
    const total = S.reduce((a, [p, q]) => a + Math.abs(p.x - q.x) + Math.abs(p.y - q.y), 0);
    let left = total * t, mid = S[0] ? S[0][0] : { x: 0, y: 0 };
    for (const [p, q] of S) {
      const l = Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
      if (left <= l) { const t = l ? left / l : 0; mid = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }; break; }
      left -= l;
    }
    // Box includes a margin of air: a caption touching a line reads as hidden too.
    const w = String(text).length * 7.2 + 40, h = 30;
    return { x: mid.x - w / 2, y: mid.y - h / 2, w, h };
  }
  // What text is hidden, in words (for the report and for debugging).
  function hiddenText(sides) {
    const G = edges.map((_, i) => edgeGeom(i, sides[i])), out = [];
    const name = (e) => `${e.from}->${e.to}${e.label ? ` "${e.label}"` : ""}`;
    G.forEach((g, i) => {
      const e = edges[i];
      for (const [gid, b] of groupTitles) if (g.S.some((s) => segHitsBox(s, b))) out.push(`${name(e)} line over title of ${gid}`);
      if (!g.cap) return;
      groups.forEach((gr) => { const b = box(gr.id); const sg = [[{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }], [{ x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }], [{ x: b.x, y: b.y + b.h }, { x: b.x + b.w, y: b.y + b.h }], [{ x: b.x, y: b.y }, { x: b.x, y: b.y + b.h }]]; if (sg.some((s) => segHitsBox(s, g.cap))) out.push(`${name(e)} caption on border of ${gr.id}`); });
      for (const [id, b] of textObstacles()) if (boxesTouch(g.cap, b)) out.push(`${name(e)} caption on ${id}`);
      G.forEach((h, j) => { if (j !== i && h.S.some((s) => segHitsBox(s, g.cap))) out.push(`${name(e)} caption under ${name(edges[j])}`); });
    });
    return out;
  }
  // For captions, icon and label are separate boxes: a caption may sit between two icons on a row.
  const pad = (b, p) => ({ x: b.x - p, y: b.y - p, w: b.w + 2 * p, h: b.h + 2 * p });
  const textObstacles = () => nodes.flatMap((n) => (hasIcon(n.id) ? [[n.id, pad(iconBox(n.id), 4)], [n.id, pad(labelBox(n.id), 2)]] : [[n.id, box(n.id)]]));
  const boxesTouch = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  // Per-edge geometry and cost of its own (bends, length, detours, lines through icons).
  function edgeGeom(i, sd) {
    const e = edges[i];
    const r = route(port(e.from, sd[0]), sd[0], port(e.to, sd[1]), sd[1]);
    const S = segs(r.pts);
    const skip = new Set([e.from, e.to, ...(isGroup(e.from) ? descendants(e.from) : []), ...(isGroup(e.to) ? descendants(e.to) : [])]);
    let hits = 0;
    for (const [id, b] of obstacles()) if (!skip.has(id) && S.some((s) => segHitsBox(s, b))) hits++;
    const len = S.reduce((a, [p, q]) => a + Math.abs(p.x - q.x) + Math.abs(p.y - q.y), 0);
    // Flow arrows read left to right: a solid arrow pointing back to the left costs extra.
    const back = e.style !== "dashed" && !e.bidirectional && center(e.to).x < center(e.from).x - 8 ? W.backward : 0;
    // Hidden text: this line over a group title, or this caption over a border, an icon or a title.
    let texts = 0;
    for (const [gid, b] of groupTitles) if (!skip.has(gid) && S.some((s) => segHitsBox(s, b))) texts++;
    const cap = captionBox(S, e.label, capT.get(i) ?? 0.5);
    if (cap) {
      texts += borders().filter((s) => segHitsBox(s, cap)).length;
      for (const [id, b] of textObstacles()) if (boxesTouch(cap, b)) texts++;
      for (const [, b] of groupTitles) if (boxesTouch(cap, b)) texts++;
    }
    return { S, sd, cap, texts, own: W.hit * hits + W.text * texts + W.bend * r.bends + (r.detour ? W.detour : 0) + W.len * len + back, hits, bends: r.bends, detour: !!r.detour };
  }
  // Interaction cost between two routed edges: crossings and lines drawn on top of each other.
  function pairCost(i, gi, j, gj) {
    let cross = 0, over = 0;
    const ei = edges[i], ej = edges[j];
    for (const [a, b] of gi.S) for (const [c, d] of gj.S) {
      const hA = Math.abs(a.y - b.y) < 0.5, hC = Math.abs(c.y - d.y) < 0.5;
      if (hA !== hC) {
        const [h1, h2, v1, v2] = hA ? [a, b, c, d] : [c, d, a, b];
        const X = v1.x, Y = h1.y;
        if (X > Math.min(h1.x, h2.x) + 3 && X < Math.max(h1.x, h2.x) - 3 && Y > Math.min(v1.y, v2.y) + 3 && Y < Math.max(v1.y, v2.y) - 3) cross++;
      } else if (hA && Math.abs(a.y - c.y) < 3) {
        const o = Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x));
        if (o > 8) over += o > 0 ? 1 : 0;
      } else if (!hA && Math.abs(a.x - c.x) < 3) {
        const o = Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y));
        if (o > 8) over += 1;
      }
    }
    // Two connectors leaving one node from the same side share a trunk: tolerated, lightly counted.
    const trunk = (ei.from === ej.from && gi.sd[0] === gj.sd[0]) || (ei.to === ej.to && gi.sd[1] === gj.sd[1]);
    // Captions must stay clear of the other connectors and of each other.
    let texts = 0;
    if (gi.cap) texts += gj.S.filter((s) => segHitsBox(s, gi.cap)).length;
    if (gj.cap) texts += gi.S.filter((s) => segHitsBox(s, gj.cap)).length;
    if (gi.cap && gj.cap && boxesTouch(gi.cap, gj.cap)) texts++;
    return { cost: W.cross * cross + (trunk ? W.trunk : W.overlap) * over + W.text * texts, cross, over, texts };
  }

  const origin = new Map([...L.pos].map(([k, v]) => [k, { x: v.x, y: v.y }]));
  const drift = () => [...L.pos].reduce((a, [k, v]) => a + (isGroup(k) ? 0 : Math.abs(v.x - origin.get(k).x) + Math.abs(v.y - origin.get(k).y)), 0);
  // Clean grid: icons that are almost in line with a neighbour (same row or column) look sloppy.
  const misalign = () => {
    let n = 0;
    const ids = nodes.map((x) => x.id);
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const a = center(ids[i]), b = center(ids[j]);
      const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
      const near = parentOf(ids[i]) === parentOf(ids[j]) ? ALIGN_SIB : ALIGN;
      if (dx > 0.5 && dx < near && dy < 700) n++;
      if (dy > 0.5 && dy < near && dx < 700) n++;
    }
    return n;
  };
  function score(sides) {
    const G = edges.map((_, i) => edgeGeom(i, sides[i]));
    let total = G.reduce((a, g) => a + g.own, 0) + W.drift * drift() + W.misalign * misalign(), crossings = 0, overlaps = 0, hits = G.reduce((a, g) => a + g.hits, 0), texts = G.reduce((a, g) => a + g.texts, 0);
    for (let i = 0; i < G.length; i++) for (let j = i + 1; j < G.length; j++) { const p = pairCost(i, G[i], j, G[j]); total += p.cost; crossings += p.cross; overlaps += p.over; texts += p.texts; }
    return { total, crossings, overlaps, hits, texts, G };
  }

  // Best sides for each edge given the others (greedy passes).
  const candidates = SIDES.flatMap((a) => SIDES.map((b) => [a, b]));
  function chooseSides(sides, only) {
    const G = edges.map((_, i) => edgeGeom(i, sides[i]));
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < edges.length; i++) {
        if (only && !only.has(i)) continue;
        let best = null;
        for (const sd of candidates) {
          const g = edgeGeom(i, sd);
          if (g.detour) continue;
          let c = g.own;
          for (let j = 0; j < edges.length; j++) if (j !== i) c += pairCost(i, g, j, G[j]).cost;
          // flows read in the layout direction: small nudge toward right/left for solid edges
          if (edges[i].style !== "dashed" && !(sd[0] === "right" && sd[1] === "left")) c += 0.5;
          if (!best || c < best.c) best = { c, sd, g };
        }
        if (best) { sides[i] = best.sd; G[i] = best.g; }
      }
    }
    return sides;
  }

  // Movable items: every node, and every group that has a parent group.
  const movable = [...nodes.map((n) => n.id), ...groups.filter((g) => g.parent).map((g) => g.id)];
  const extent = (id) => (isGroup(id) ? box(id) : { ...box(id), h: LABEL_TOP + (labelLines.get(id) || [""]).length * LINE_H + 4 });
  function fits(id) {
    const b = extent(id), par = parentOf(id);
    if (par) {
      const p = box(par), g = gById.get(par);
      const top = (g.label ?? g.type) === "" ? 16 : 44;
      const side = isGroup(id) ? 28 : 16, bottom = isGroup(id) ? 28 : 12;
      if (b.x < p.x + side || b.x + b.w > p.x + p.w - side || b.y < p.y + top || b.y + b.h > p.y + p.h - bottom) return false;
    }
    for (const s of kids(par)) {
      if (s === id) continue;
      const o = extent(s), m = 20;
      if (!(b.x + b.w + m <= o.x || o.x + o.w + m <= b.x || b.y + b.h + m <= o.y || o.y + o.h + m <= b.y)) return false;
    }
    return true;
  }
  const moveBy = (id, dx, dy) => { const b = box(id); b.x += dx; b.y += dy; if (isGroup(id)) for (const k of kids(id)) moveBy(k, dx, dy); };
  const incident = (id) => { const ids = new Set([id, ...(isGroup(id) ? descendants(id) : [])]); return new Set(edges.map((e, i) => (ids.has(e.from) || ids.has(e.to) ? i : -1)).filter((i) => i >= 0)); };

  return { capT, hiddenText, edges, nodes, groups, isGroup, movable, fits, moveBy, incident, center, score, chooseSides, box, parentOf, kids };
}

export function optimize(spec, L, titles, { iters = 6000, seed = 7 } = {}) {
  const M = makeModel(spec, L, titles);
  const rand = rng(seed);
  let sides = M.edges.map((_, i) => L.sides.get(i) || ["right", "left"]);
  sides = M.chooseSides(sides);
  let cur = M.score(sides).total;
  const start = M.score(sides);
  const snapshot = () => new Map([...L.pos].map(([k, v]) => [k, { ...v }]));
  let best = { total: cur, pos: snapshot(), sides: sides.map((s) => [...s]) };
  const T0 = 8;
  for (let it = 0; it < iters; it++) {
    const T = T0 * (1 - it / iters) + 0.05;
    const id = M.movable[Math.floor(rand() * M.movable.length)];
    const before = { ...M.box(id) };
    let dx = 0, dy = 0, swapWith = null;
    const r = rand();
    const inc = [...M.incident(id)];
    if (r < 0.45 && inc.length) {
      // align with the other end of one of its connectors
      const e = M.edges[inc[Math.floor(rand() * inc.length)]];
      const other = e.from === id || M.kids(id).includes(e.from) ? e.to : e.from;
      const self = e.from === other ? e.to : e.from;
      const a = M.center(self), b = M.center(other);
      if (rand() < 0.5) dy = b.y - a.y; else dx = b.x - a.x;
    } else if (r < 0.6) {
      const sib = M.kids(M.parentOf(id)).filter((s) => s !== id && !M.isGroup(s) && !M.isGroup(id));
      if (sib.length) swapWith = sib[Math.floor(rand() * sib.length)];
    } else {
      const step = 8 * (1 + Math.floor(rand() * 20));
      if (rand() < 0.5) dx = rand() < 0.5 ? -step : step; else dy = rand() < 0.5 ? -step : step;
    }
    let moved = [];
    if (swapWith) {
      const a = M.box(id), b = M.box(swapWith);
      const [ax, ay, bx, by] = [a.x, a.y, b.x, b.y];
      a.x = bx; a.y = by; b.x = ax; b.y = ay;
      if (!M.fits(id) || !M.fits(swapWith)) { a.x = ax; a.y = ay; b.x = bx; b.y = by; continue; }
      moved = [id, swapWith];
    } else {
      if (Math.abs(dx) + Math.abs(dy) < 0.5) continue;
      M.moveBy(id, dx, dy);
      if (!M.fits(id)) { M.moveBy(id, -dx, -dy); continue; }
      moved = [id];
    }
    const only = new Set(moved.flatMap((m) => [...M.incident(m)]));
    const trial = M.chooseSides(sides.map((s) => [...s]), only);
    const s = M.score(trial).total;
    if (s <= cur || rand() < Math.exp((cur - s) / T)) {
      cur = s; sides = trial;
      if (s < best.total) best = { total: s, pos: snapshot(), sides: sides.map((x) => [...x]) };
    } else if (swapWith) {
      const a = M.box(id), b = M.box(swapWith);
      const [ax, ay] = [a.x, a.y]; a.x = b.x; a.y = b.y; b.x = ax; b.y = ay;
    } else M.moveBy(id, -dx, -dy);
    void before;
  }
  for (const [k, v] of best.pos) Object.assign(L.pos.get(k), v);
  sides = M.chooseSides(best.sides);
  // Polish: line up icons that are almost in line, whenever it does not make things worse.
  cur = M.score(sides).total;
  for (let round = 0, improved = true; round < 6 && improved; round++) {
    improved = false;
    const ids = M.nodes.map((n) => n.id);
    for (const a of ids) for (const b of ids) {
      if (a === b) continue;
      const ca = M.center(a), cb = M.center(b);
      for (const [dx, dy] of [[cb.x - ca.x, 0], [0, cb.y - ca.y]]) {
        const d = Math.abs(dx) + Math.abs(dy);
        if (d < 0.5 || d >= (M.parentOf(a) === M.parentOf(b) ? ALIGN_SIB : ALIGN)) continue;
        M.moveBy(a, dx, dy);
        if (!M.fits(a)) { M.moveBy(a, -dx, -dy); continue; }
        const trial = M.chooseSides(sides.map((x) => [...x]), M.incident(a));
        const sc = M.score(trial).total;
        if (sc <= cur) { cur = sc; sides = trial; improved = true; } else M.moveBy(a, -dx, -dy);
      }
    }
  }
  placeCaptions(M, sides);
  const end = M.score(sides);
  L.sides = new Map(sides.map((s, i) => [i, s]));
  L.capPos = new Map(M.capT);
  return {
    before: { score: Math.round(start.total), crossings: start.crossings, lines_through_icons: start.hits, overlaps: start.overlaps, hidden_text: start.texts },
    after: { score: Math.round(end.total), crossings: end.crossings, lines_through_icons: end.hits, overlaps: end.overlaps, hidden_text: end.texts, hidden: M.hiddenText(sides) },
  };
}

// Slide each caption along its path until no text is hidden, staying as close to the middle as possible.
function placeCaptions(M, sides) {
  for (let round = 0; round < 2; round++) {
    M.edges.forEach((e, i) => {
      if (!e.label) return;
      let best = null;
      for (const t of [0.5, 0.45, 0.55, 0.4, 0.6, 0.35, 0.65, 0.3, 0.7, 0.25, 0.75, 0.2, 0.8]) {
        M.capT.set(i, t);
        const s = M.score(sides);
        const c = s.texts * 1000 + s.total;
        if (!best || c < best.c - 0.01) best = { c, t };
        if (s.texts === 0 && t === 0.5) break;
      }
      M.capT.set(i, best.t);
    });
  }
}

export function evaluate(spec, L, titles) {
  const M = makeModel(spec, L, titles);
  const sides = M.edges.map((_, i) => L.sides.get(i));
  const s = M.score(sides);
  return { score: Math.round(s.total), crossings: s.crossings, lines_through_icons: s.hits, overlaps: s.overlaps };
}

// Quick local picture of what Miro will draw (boxes, icons, labels, modeled routes), for checks.
export function previewSvg(spec, L, titles) {
  const M = makeModel(spec, L, titles);
  const sides = M.edges.map((_, i) => L.sides.get(i));
  const s = M.score(sides);
  const out = [];
  let W0 = 0, H0 = 0;
  for (const [, b] of L.pos) { W0 = Math.max(W0, b.x + b.w + 40); H0 = Math.max(H0, b.y + b.h + 40); }
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W0}" height="${H0}" viewBox="0 0 ${W0} ${H0}" font-family="Arial" font-size="13"><rect width="100%" height="100%" fill="#fff"/>`);
  for (const g of M.groups) { const b = M.box(g.id); out.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="none" stroke="#999" stroke-dasharray="${g.type === "client-lane" ? "2,2" : "none"}"/><text x="${b.x + 6}" y="${b.y + 16}" fill="#555">${g.label || ""}</text>`); }
  for (const n of M.nodes) {
    const b = M.box(n.id), ix = b.x + (b.w - 64) / 2;
    out.push(`<rect x="${ix}" y="${b.y}" width="64" height="64" fill="#f2a65a" rx="6"/><text x="${b.x + b.w / 2}" y="${b.y + 84}" text-anchor="middle">${(titles.get(n.id) || n.id).replace(/&/g, "&amp;")}</text>`);
  }
  s.G.forEach((g, i) => {
    const e = M.edges[i];
    const d = g.S.map(([p, q], k) => `${k ? "" : `M${p.x},${p.y}`} L${q.x},${q.y}`).join(" ");
    out.push(`<path d="${d}" fill="none" stroke="${e.style === "dashed" ? "#1f6fd1" : "#222"}" stroke-width="2" stroke-dasharray="${e.style === "dashed" ? "6,4" : "none"}"/>`);
    if (g.cap) out.push(`<rect x="${g.cap.x}" y="${g.cap.y}" width="${g.cap.w}" height="${g.cap.h}" fill="#fff" stroke="#1f6fd1" stroke-width="0.5"/><text x="${g.cap.x + g.cap.w / 2}" y="${g.cap.y + 14}" text-anchor="middle" fill="#1f6fd1" font-size="12">${e.label}</text>`);
  });
  out.push(`</svg>`);
  return out.join("\n");
}

// Several independent runs from the same ELK start; keep the most readable result.
export function optimizeBest(spec, L, titles, { starts = 4, iters = 6000, seed = 7 } = {}) {
  const pos0 = new Map([...L.pos].map(([k, v]) => [k, { ...v }])), sides0 = new Map(L.sides);
  let best = null;
  for (let k = 0; k < starts; k++) {
    for (const [id, v] of pos0) Object.assign(L.pos.get(id), v);
    L.sides = new Map(sides0);
    const q = optimize(spec, L, titles, { iters, seed: seed + k * 101 });
    if (!best || q.after.score < best.q.after.score) best = { q, pos: new Map([...L.pos].map(([id, v]) => [id, { ...v }])), sides: new Map(L.sides), capPos: new Map(L.capPos || []) };
  }
  for (const [id, v] of best.pos) Object.assign(L.pos.get(id), v);
  L.sides = best.sides;
  L.capPos = best.capPos;
  return best.q;
}
