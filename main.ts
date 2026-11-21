// Sokoban solver: push-optimal per-room A* with hallway chaining.
// Deterministic: budgets are node counts only. No clock, no randomness, no network.
// Each level is a 1-wide hallway plus 1-4 rooms off it; boxes never leave their room,
// so each room is solved independently (push-optimal) and the rooms are chained
// by walking the hallway. Total pushes = sum of room optima = P*.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const DC = ['u', 'd', 'l', 'r'];

const ROOM_CAP = 300_000;
const GREEDY_CAP = 100_000;
const GLOBAL_LIMIT = 2_500_000;

const budget = { used: 0 };

interface Level {
  w: number;
  h: number;
  wall: boolean[];
  goals: number[];
  boxes: number[];
  player: number;
}

interface Room {
  cells: Set<number>;
  door: number;
  entry: number;
  boxes: number[];
  goals: number[];
  requireExit: boolean;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  let w = 0;
  for (const r of rows) if (r.length > w) w = r.length;
  const wall: boolean[] = new Array(w * h).fill(false);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = 0;
  for (let y = 0; y < h; y++) {
    const row = rows[y] ?? '';
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      wall[i] = ch === '#';
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  }
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// BFS over passable cells; returns parent maps and the reached set.
function bfsRegion(
  from: number,
  w: number,
  h: number,
  passable: (i: number) => boolean,
): { parent: Map<number, number>; pch: Map<number, string>; reached: Set<number> } {
  const parent = new Map<number, number>();
  const pch = new Map<number, string>();
  const reached = new Set<number>([from]);
  const q: number[] = [from];
  parent.set(from, -1);
  let head = 0;
  while (head < q.length) {
    const c = q[head++]!;
    const cx = c % w;
    const cy = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d]!;
      const ny = cy + DY[d]!;
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const ni = ny * w + nx;
      if (!passable(ni) || reached.has(ni)) continue;
      reached.add(ni);
      parent.set(ni, c);
      pch.set(ni, DC[d]!);
      q.push(ni);
    }
  }
  return { parent, pch, reached };
}

function tracePath(to: number, from: number, parent: Map<number, number>, pch: Map<number, string>): string {
  let s = '';
  let cur = to;
  while (cur !== from) {
    s = pch.get(cur)! + s;
    cur = parent.get(cur)!;
  }
  return s;
}

// Split a level into the hallway (the player's row/column run) and its rooms.
// Each room is a connected component of floor cells off the hallway, attached
// through exactly one door cell.
function decompose(level: Level): { rooms: Room[] } {
  const { w, h, wall } = level;
  const floor = (i: number) => !wall[i];
  const px = level.player % w;
  const py = (level.player / w) | 0;
  const rowRun: number[] = [];
  for (let x = px; x < w && floor(py * w + x); x++) rowRun.push(py * w + x);
  for (let x = px - 1; x >= 0 && floor(py * w + x); x--) rowRun.push(py * w + x);
  let hallway: number[];
  if (rowRun.length >= 3) {
    hallway = rowRun;
  } else {
    const colRun: number[] = [];
    for (let y = py; y < h && floor(y * w + px); y++) colRun.push(y * w + px);
    for (let y = py - 1; y >= 0 && floor(y * w + px); y--) colRun.push(y * w + px);
    hallway = colRun.length >= 3 ? colRun : rowRun;
  }
  const hallSet = new Set(hallway);
  const boxSet = new Set(level.boxes);
  const goalSet = new Set(level.goals);
  const seen = new Set<number>();
  const rooms: Room[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!floor(i) || hallSet.has(i) || seen.has(i)) continue;
    const cells: number[] = [];
    const q = [i];
    seen.add(i);
    while (q.length > 0) {
      const c = q.pop()!;
      cells.push(c);
      const cx = c % w;
      const cy = (c / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX[d]!;
        const ny = cy + DY[d]!;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const ni = ny * w + nx;
        if (!floor(ni) || hallSet.has(ni) || seen.has(ni)) continue;
        seen.add(ni);
        q.push(ni);
      }
    }
    let door = -1;
    let entry = -1;
    outer: for (const c of cells) {
      const cx = c % w;
      const cy = (c / w) | 0;
      for (let d = 0; d < 4; d++) {
        const nx = cx + DX[d]!;
        const ny = cy + DY[d]!;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const ni = ny * w + nx;
        if (hallSet.has(ni)) {
          door = c;
          entry = ni;
          break outer;
        }
      }
    }
    if (door < 0) continue;
    const boxes = cells.filter((c) => boxSet.has(c));
    const goals = cells.filter((c) => goalSet.has(c));
    if (boxes.length === 0 && goals.length === 0) continue;
    rooms.push({ cells: new Set(cells), door, entry, boxes, goals, requireExit: true });
  }
  rooms.sort((a, b) => a.entry - b.entry);
  if (rooms.length === 0) {
    // Fallback: treat the whole level as one room.
    const cells = new Set<number>();
    for (let i = 0; i < w * h; i++) if (floor(i)) cells.add(i);
    rooms.push({
      cells,
      door: level.player,
      entry: level.player,
      boxes: [...level.boxes],
      goals: [...level.goals],
      requireExit: false,
    });
  }
  return { rooms };
}

// Push-optimal A* for one room. The player starts at the room's entry hallway
// cell; boxes must stay inside the room. Returns the full move string for the
// room (entry pushes plus the exit walk back to the entry cell).
function solveRoom(
  level: Level,
  room: Room,
  startPlayer: number,
  greedy: boolean,
  cap: number,
): { ok: boolean; moves: string; pushes: number } {
  const { w, h } = level;
  const cells = room.cells;
  const entry = room.entry;
  const goalSet = new Set(room.goals);
  const boxes0 = [...room.boxes].sort((a, b) => a - b);
  const n = boxes0.length;
  const m = room.goals.length;
  const allowed = new Set<number>(cells);
  allowed.add(entry);

  // Wall-aware distances from each goal over the room's cells (box travel lower bound).
  const dist: number[][] = [];
  for (const g of room.goals) {
    const d = new Array<number>(w * h).fill(Infinity);
    d[g] = 0;
    const q = [g];
    let head = 0;
    while (head < q.length) {
      const c = q[head++]!;
      const cx = c % w;
      const cy = (c / w) | 0;
      for (let di = 0; di < 4; di++) {
        const nx = cx + DX[di]!;
        const ny = cy + DY[di]!;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const ni = ny * w + nx;
        if (!cells.has(ni) || d[ni] !== Infinity) continue;
        d[ni] = d[c]! + 1;
        q.push(ni);
      }
    }
    dist.push(d);
  }

  // Dead squares: reverse pulls from the goals. A box on a non-live square can
  // never reach a goal, so such a state is dead.
  const standable = new Set<number>(cells);
  standable.add(entry);
  const live = new Set<number>(room.goals);
  {
    const q = [...room.goals];
    let head = 0;
    while (head < q.length) {
      const y = q[head++]!;
      const yx = y % w;
      const yy = (y / w) | 0;
      for (let di = 0; di < 4; di++) {
        const xx = yx + DX[di]!;
        const xy = yy + DY[di]!;
        if (xx < 0 || xx >= w || xy < 0 || xy >= h) continue;
        const x = xy * w + xx;
        if (!cells.has(x) || live.has(x)) continue;
        const px = xx + DX[di]!;
        const py = xy + DY[di]!;
        if (px < 0 || px >= w || py < 0 || py >= h) continue;
        if (!standable.has(py * w + px)) continue;
        live.add(x);
        q.push(x);
      }
    }
  }

  // Min-assignment heuristic (brute-force permutations; n <= 4). Admissible.
  const hCache = new Map<string, number>();
  function heuristic(boxes: number[]): number {
    const key = String.fromCharCode(...boxes);
    const hit = hCache.get(key);
    if (hit !== undefined) return hit;
    const used = new Array<boolean>(m).fill(false);
    let bestSum = Infinity;
    const rec = (bi: number, sum: number): void => {
      if (sum >= bestSum) return;
      if (bi === n) {
        bestSum = sum;
        return;
      }
      for (let gi = 0; gi < m; gi++) {
        if (used[gi]) continue;
        const d = dist[gi]![boxes[bi]!]!;
        if (d === Infinity) continue;
        used[gi] = true;
        rec(bi + 1, sum + d);
        used[gi] = false;
      }
    };
    rec(0, 0);
    hCache.set(key, bestSum);
    return bestSum;
  }

  // Freeze deadlock: iteratively, a box that cannot be pushed in any direction
  // (target and standing cell blocked by walls or frozen boxes) is frozen; a
  // frozen box off a goal means the state is dead. Sound: it never prunes a
  // state that can still be solved.
  function frozenDeadlock(boxes: number[]): boolean {
    const frozen = new Set<number>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const b of boxes) {
        if (frozen.has(b) || goalSet.has(b)) continue;
        let canPush = false;
        const bx = b % w;
        const by = (b / w) | 0;
        for (let di = 0; di < 4; di++) {
          const tx = bx + DX[di]!;
          const ty = by + DY[di]!;
          const hx = bx - DX[di]!;
          const hy = by - DY[di]!;
          if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
          if (hx < 0 || hx >= w || hy < 0 || hy >= h) continue;
          const t = ty * w + tx;
          const hc = hy * w + hx;
          const tOk = cells.has(t) && !frozen.has(t);
          const hOk = (cells.has(hc) || hc === entry) && !frozen.has(hc);
          if (tOk && hOk) {
            canPush = true;
            break;
          }
        }
        if (!canPush) {
          frozen.add(b);
          changed = true;
        }
      }
    }
    for (const b of frozen) if (!goalSet.has(b)) return true;
    return false;
  }

  function stateKey(p: number, bs: number[]): string {
    return String.fromCharCode(p, ...bs);
  }

  // Binary heap ordered by (f, h, seq) for deterministic tie-breaking.
  const heap: [number, number, number, number][] = [];
  const heapLess = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  function heapPush(e: [number, number, number, number]): void {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      const tmp = heap[i]!;
      heap[i] = heap[p]!;
      heap[p] = tmp;
      i = p;
    }
  }
  function heapPop(): [number, number, number, number] {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        const tmp = heap[i]!;
        heap[i] = heap[c]!;
        heap[c] = tmp;
        i = c;
      }
    }
    return top;
  }

  const sp: number[] = [];
  const sb: number[][] = [];
  const sg: number[] = [];
  const sparent: number[] = [];
  const sseg: string[] = [];
  const best = new Map<string, number>();

  function addState(p: number, bs: number[], g: number, parent: number, seg: string): number {
    const idx = sp.length;
    sp.push(p);
    sb.push(bs);
    sg.push(g);
    sparent.push(parent);
    sseg.push(seg);
    best.set(stateKey(p, bs), idx);
    return idx;
  }

  const h0 = heuristic(boxes0);
  if (h0 === Infinity || boxes0.some((b) => !live.has(b)) || frozenDeadlock(boxes0)) {
    return { ok: false, moves: '', pushes: 0 };
  }
  let seq = 0;
  const root = addState(startPlayer, boxes0, 0, -1, '');
  heapPush([h0, h0, seq++, root]);

  let expansions = 0;
  while (heap.length > 0 && expansions < cap && budget.used < GLOBAL_LIMIT) {
    const [, , , s] = heapPop();
    const p = sp[s]!;
    const bs = sb[s]!;
    const g = sg[s]!;
    if (best.get(stateKey(p, bs)) !== s) continue;
    expansions++;
    budget.used++;
    // Goal: every box on a goal and the player can still walk out to the entry.
    if (bs.every((b) => goalSet.has(b))) {
      let canExit = !room.requireExit;
      let exitWalk = '';
      if (room.requireExit) {
        const boxSet = new Set(bs);
        const reg = bfsRegion(p, w, h, (i) => allowed.has(i) && !boxSet.has(i));
        if (reg.reached.has(entry)) {
          canExit = true;
          exitWalk = tracePath(entry, p, reg.parent, reg.pch);
        }
      }
      if (canExit) {
        const parts: string[] = [];
        let cur = s;
        while (cur !== -1) {
          parts.push(sseg[cur]!);
          cur = sparent[cur]!;
        }
        parts.reverse();
        const moves = parts.join('') + exitWalk;
        return { ok: true, moves, pushes: g };
      }
    }
    // Player's reachable region (one BFS per expansion).
    const boxSet = new Set(bs);
    const reg = bfsRegion(p, w, h, (i) => allowed.has(i) && !boxSet.has(i));
    for (let bi = 0; bi < bs.length; bi++) {
      const b = bs[bi]!;
      const bx = b % w;
      const by = (b / w) | 0;
      for (let di = 0; di < 4; di++) {
        const tx = bx + DX[di]!;
        const ty = by + DY[di]!;
        const hx = bx - DX[di]!;
        const hy = by - DY[di]!;
        if (tx < 0 || tx >= w || ty < 0 || ty >= h) continue;
        if (hx < 0 || hx >= w || hy < 0 || hy >= h) continue;
        const t = ty * w + tx;
        const hc = hy * w + hx;
        if (!cells.has(t) || boxSet.has(t)) continue;
        if (!reg.reached.has(hc)) continue;
        const walk = tracePath(hc, p, reg.parent, reg.pch);
        const next = [...bs];
        next[bi] = t;
        next.sort((a, b2) => a - b2);
        if (next.some((x) => !live.has(x))) continue;
        if (frozenDeadlock(next)) continue;
        const hh = heuristic(next);
        if (hh === Infinity) continue;
        const ng = g + 1;
        const key = stateKey(b, next);
        const prev = best.get(key);
        if (prev !== undefined && sg[prev]! <= ng) continue;
        const seg = walk + DC[di]!;
        const idx = addState(b, next, ng, s, seg);
        heapPush([greedy ? hh : ng + hh, hh, seq++, idx]);
      }
    }
  }
  return { ok: false, moves: '', pushes: 0 };
}

// Solve one level by chaining its rooms in hallway order.
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const { rooms } = decompose(level);
  const { w, h, wall } = level;
  let moves = '';
  let player = level.player;
  const allBoxes = new Set(level.boxes);
  const floorPass = (i: number) => i >= 0 && i < w * h && !wall[i] && !allBoxes.has(i);
  for (const room of rooms) {
    // Walk the hallway to this room's entry cell.
    const reg = bfsRegion(player, w, h, floorPass);
    if (!reg.reached.has(room.entry)) return moves;
    moves += tracePath(room.entry, player, reg.parent, reg.pch);
    player = room.entry;
    // Solve the room optimally; fall back to greedy if the cap is hit.
    let res = solveRoom(level, room, player, false, ROOM_CAP);
    if (!res.ok) res = solveRoom(level, room, player, true, GREEDY_CAP);
    if (!res.ok) return moves;
    moves += res.moves;
    player = room.entry;
    // Boxes of the solved room are now on goals; they still block the hallway
    // walk only if they sit on it, which they never do (rooms hold their boxes).
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
