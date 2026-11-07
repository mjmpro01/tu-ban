// Layout of the office (tile = 16px). Matches assets/preview/scene.png.
import floorTiles from "../../../../assets/game/tiles/tiles_floor.json";
import wallTiles from "../../../../assets/game/tiles/tiles_wall.json";

export const T = 16;
export const MAP_W = 24;
export const MAP_H = 16;

type WallGrid = number[][];
const W = wallTiles.tiles as Record<string, number | WallGrid>;
const F = floorTiles.tiles as Record<string, number>;

/** Tile indices for the floor layer (-1 = empty). */
export function floorLayer(): number[][] {
  const rows: number[][] = [];
  for (let y = 0; y < MAP_H; y++) {
    const row: number[] = [];
    for (let x = 0; x < MAP_W; x++) {
      if (y < 3 || y >= MAP_H - 1 || x < 1 || x >= MAP_W - 1) row.push(-1);
      else if (x >= 16 && x < 22 && y >= 9 && y < 14) row.push(F[`carpet_green_${1 + ((x + y) % 4)}`]);
      else row.push(F[`wood_${1 + ((x * 7 + y * 3) % 4)}`]);
    }
    rows.push(row);
  }
  return rows;
}

const WALL_PIECES = [
  "wall_cream_a", "wall_cream_a", "wall_cream_window", "wall_cream_a", "wall_cream_b", "wall_cream_window",
  "wall_cream_a", "wall_cream_a", "wall_cream_door", "wall_cream_a", "wall_cream_window", "wall_cream_a",
  "wall_cream_b", "wall_cream_a", "wall_cream_a", "wall_cream_a",
];

/** Tile indices for the wall layer: a 2-tile tall wall face on top, wall tops around the room. */
export function wallLayer(): number[][] {
  const rows = Array.from({ length: MAP_H }, () => Array<number>(MAP_W).fill(-1));
  const top = W.wall_top as number;
  for (let x = 0; x < MAP_W; x++) {
    rows[0][x] = top;
    rows[MAP_H - 1][x] = top;
  }
  for (let y = 0; y < MAP_H; y++) {
    rows[y][0] = top;
    rows[y][MAP_W - 1] = top;
  }
  let x = 1;
  for (const name of [...WALL_PIECES, ...WALL_PIECES]) {
    const grid = W[name] as WallGrid;
    for (let j = 0; j < grid.length; j++)
      for (let i = 0; i < grid[0].length; i++) if (x + i < MAP_W - 1) rows[1 + j][x + i] = grid[j][i];
    x += grid[0].length;
    if (x >= MAP_W - 1) break;
  }
  return rows;
}

export interface Prop {
  frame: string;
  /** Bottom-left corner in pixels. */
  x: number;
  y: number;
  /** Wall decorations and rugs do not block walking. */
  solid?: boolean;
}

export const PROPS: Prop[] = [
  { frame: "wall_picture", x: 2.5 * T, y: 2.2 * T },
  { frame: "wall_clock", x: 9.3 * T, y: 2.2 * T },
  { frame: "wall_corkboard", x: 15.3 * T, y: 2.4 * T },
  { frame: "bookshelf_large", x: 1.2 * T, y: 4.6 * T, solid: true },
  { frame: "plant_monstera", x: 3.4 * T, y: 4.6 * T, solid: true },
  { frame: "sofa", x: 5 * T, y: 4.8 * T, solid: true },
  { frame: "coffee_counter", x: 11.5 * T, y: 4.4 * T, solid: true },
  { frame: "water_cooler", x: 14.3 * T, y: 4.4 * T, solid: true },
  { frame: "server_rack_a", x: 21 * T, y: 4.6 * T, solid: true },
  { frame: "server_rack_b", x: 22 * T, y: 4.6 * T, solid: true },
  { frame: "whiteboard", x: 17.5 * T, y: 9 * T, solid: true },
  { frame: "meeting_table", x: 16.5 * T, y: 13 * T, solid: true },
  { frame: "plant_snake", x: 22 * T, y: 9 * T, solid: true },
  { frame: "plant_monstera", x: 1.3 * T, y: 14.8 * T, solid: true },
  { frame: "trash_bin", x: 13.2 * T, y: 13 * T, solid: true },
];

/** Desk bottom-left corners in tiles, indexed by AgentInfo.desk. */
export const DESKS: { tx: number; ty: number }[] = [
  { tx: 3, ty: 8 },
  { tx: 7, ty: 8 },
  { tx: 3, ty: 12 },
  { tx: 7, ty: 12 },
  { tx: 11, ty: 12 },
];

/** Where a seated agent's feet go (sprite origin is bottom-centre). */
export const seatPixel = (desk: number) => ({ x: DESKS[desk].tx * T + 16, y: DESKS[desk].ty * T + 12 });
/** Tile the agent walks to before sliding onto the seat. */
export const seatApproach = (desk: number) => ({ tx: DESKS[desk].tx, ty: DESKS[desk].ty + 1 });
/** Tile beside a desk where a visitor (hand-off) stands. */
export const deskVisitor = (desk: number) => ({ tx: DESKS[desk].tx + 2, ty: DESKS[desk].ty });

export type PoiName = "bookshelf" | "coffee" | "water" | "sofa" | "server" | "whiteboard";
export const POIS: Record<PoiName, { tx: number; ty: number; face: "up" | "down" | "left" | "right" }> = {
  bookshelf: { tx: 2, ty: 5, face: "up" },
  coffee: { tx: 12, ty: 5, face: "up" },
  water: { tx: 14, ty: 5, face: "up" },
  sofa: { tx: 7, ty: 5, face: "up" },
  server: { tx: 21, ty: 5, face: "up" },
  whiteboard: { tx: 18, ty: 9, face: "up" },
};

/** Where agents stand around the meeting table (first spot = the Manager's). */
export const MEETING_SPOTS: { tx: number; ty: number; face: "up" | "down" }[] = [
  { tx: 18, ty: 10, face: "down" },
  { tx: 19, ty: 13, face: "up" },
  { tx: 17, ty: 13, face: "up" },
  { tx: 20, ty: 10, face: "down" },
  { tx: 18, ty: 13, face: "up" },
  { tx: 20, ty: 13, face: "up" },
];

/** true = walkable. */
export function walkGrid(frameSize: (frame: string) => { w: number; h: number }): boolean[][] {
  const grid = Array.from({ length: MAP_H }, (_, y) =>
    Array.from({ length: MAP_W }, (_, x) => y >= 3 && y < MAP_H - 1 && x >= 1 && x < MAP_W - 1),
  );
  const block = (px0: number, py0: number, px1: number, py1: number) => {
    for (let ty = Math.floor(py0 / T); ty <= Math.floor((py1 - 1) / T); ty++)
      for (let tx = Math.floor(px0 / T); tx <= Math.floor((px1 - 1) / T); tx++)
        if (grid[ty]?.[tx] !== undefined) grid[ty][tx] = false;
  };
  for (const p of PROPS) {
    if (!p.solid) continue;
    const { w, h } = frameSize(p.frame);
    const depth = Math.max(8, Math.min(h - 8, 24));
    block(p.x + 2, p.y - depth, p.x + w - 2, p.y);
  }
  for (const d of DESKS) block(d.tx * T + 2, d.ty * T - 14, d.tx * T + 30, d.ty * T);
  return grid;
}

/** Breadth-first path on the tile grid (4 directions). Returns tiles excluding the start. */
export function findPath(grid: boolean[][], from: { tx: number; ty: number }, to: { tx: number; ty: number }) {
  const key = (x: number, y: number) => y * MAP_W + x;
  const prev = new Map<number, number>();
  const start = key(from.tx, from.ty);
  const goal = key(to.tx, to.ty);
  const queue = [start];
  prev.set(start, -1);
  const free = (x: number, y: number) => grid[y]?.[x] || key(x, y) === goal;
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === goal) break;
    const cx = cur % MAP_W;
    const cy = Math.floor(cur / MAP_W);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx;
      const ny = cy + dy;
      const k = key(nx, ny);
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H || prev.has(k) || !free(nx, ny)) continue;
      prev.set(k, cur);
      queue.push(k);
    }
  }
  if (!prev.has(goal)) return null;
  const path: { tx: number; ty: number }[] = [];
  for (let k = goal; k !== start; k = prev.get(k)!) path.unshift({ tx: k % MAP_W, ty: Math.floor(k / MAP_W) });
  return path;
}
