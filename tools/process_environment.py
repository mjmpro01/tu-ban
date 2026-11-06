"""Turn the environment source images into:

- tiles_floor.png  : 8x4 floor tiles (16x16)            + tiles_floor.json (tile names -> index)
- tiles_wall.png   : wall tileset (16x16 grid)          + tiles_wall.json
- objects.png/json : Phaser JSON-hash atlas of every furniture item and wall decoration
"""
from __future__ import annotations

import json

import numpy as np
from scipy import ndimage

from assetlib import OUT, PREVIEW, SRC, bbox, clean_mask, downscale, load, opaque, preview, quantize_opaque_only, save

ENV = SRC / "environment"
T = 16

# ---------------------------------------------------------------- floors
FLOOR_ROWS = [
    ["wood_1", "wood_2", "wood_3", "wood_4", "wood_dark_1", "wood_dark_2", "wood_dark_3", "wood_dark_4"],
    ["carpet_orange_1", "carpet_orange_2", "carpet_orange_3", "carpet_orange_4",
     "carpet_green_1", "carpet_green_2", "carpet_green_3", "carpet_green_4"],
    ["checker_1", "checker_2", "checker_3", "checker_4", "concrete_1", "concrete_2", "concrete_3", "concrete_4"],
    ["rug_edge_1", "rug_edge_2", "rug_edge_3", "rug_edge_4", "rug_edge_5", "rug_edge_6", "rug_edge_7", "rug_edge_8"],
]


def floors():
    arr = load(ENV / "tiles_floor_source.png")
    h, w = arr.shape[:2]
    cw, ch = w / 8, h / 4
    out = np.zeros((4 * T, 8 * T, 4), np.uint8)
    names = {}
    for r in range(4):
        for c in range(8):
            inset = 5  # skip the separator lines between source cells
            x0, y0 = int(c * cw) + inset, int(r * ch) + inset
            x1, y1 = int((c + 1) * cw) - inset, int((r + 1) * ch) - inset
            out[r * T : (r + 1) * T, c * T : (c + 1) * T] = downscale(arr[y0:y1, x0:x1], (T, T), alpha_thr=1)
            names[FLOOR_ROWS[r][c]] = r * 8 + c
    out = quantize_opaque_only(out, 48)
    save(out, OUT / "tiles" / "tiles_floor.png")
    (OUT / "tiles" / "tiles_floor.json").write_text(json.dumps({"tileSize": T, "columns": 8, "tiles": names}, indent=2))
    # seamless check: 3x3 repeat of a few tiles
    demo = np.concatenate(
        [np.tile(out[r * T : (r + 1) * T, c * T : (c + 1) * T], (3, 3, 1)) for r, c in [(0, 0), (0, 4), (1, 0), (1, 4), (2, 0), (2, 4)]],
        axis=1,
    )
    preview(out, PREVIEW / "tiles_floor.png", scale=6, grid=(T, T))
    preview(demo, PREVIEW / "tiles_floor_seamless.png", scale=4)


# ---------------------------------------------------------------- walls
# Source rectangles (x0, y0, x1, y1) in tiles_wall_source.png and their size in tiles.
WALL_PIECES = {
    # name: (rect, (tiles_w, tiles_h))
    "wall_cream_a": ((50, 25, 190, 375), (1, 2)),
    "wall_cream_b": ((440, 25, 600, 375), (1, 2)),
    "wall_cream_window": ((828, 25, 1138, 375), (2, 2)),
    "wall_cream_door": ((1142, 25, 1422, 375), (2, 2)),
    "wall_green_a": ((40, 755, 190, 1060), (1, 2)),
    "wall_green_b": ((610, 755, 770, 1060), (1, 2)),
    "wall_green_window": ((812, 755, 1094, 1060), (2, 2)),
    "wall_green_window_sunset": ((1100, 755, 1422, 1060), (2, 2)),
}
# layout of the output wall tileset (tile column, tile row)
WALL_LAYOUT = {
    "wall_cream_a": (0, 0), "wall_cream_b": (1, 0), "wall_cream_window": (2, 0), "wall_cream_door": (4, 0),
    "wall_green_a": (6, 0), "wall_green_b": (7, 0),
    "wall_green_window": (0, 2), "wall_green_window_sunset": (2, 2),
}
WALL_DECOR_CELLS = [  # row with picture/clock/... on the cream wall (between the separator lines)
    ("wall_picture", 24, 202), ("wall_clock", 209, 380), ("wall_corkboard", 386, 555), ("wall_switch", 561, 720),
    ("wall_shelf", 727, 894), ("wall_lamp", 900, 1070), ("wall_hanging_plant", 1077, 1245), ("wall_leaf_frame", 1251, 1424),
]
WALL_DECOR_Y = (572, 738)
# Grid lines the generator drew straight through the wall art: (axis, start, end, span_start, span_end)
WALL_GRID_LINES = [
    ("row", 213, 220, 24, 1424), ("row", 908, 915, 24, 1424),
    ("col", 213, 220, 25, 378), ("col", 414, 421, 25, 378), ("col", 619, 626, 25, 378), ("col", 1015, 1022, 25, 378),
    ("col", 202, 211, 755, 1060), ("col", 397, 405, 755, 1060), ("col", 586, 594, 755, 1060), ("col", 774, 782, 755, 1060),
]


def erase_grid_lines(arr: np.ndarray) -> np.ndarray:
    """Replace each grid line with the pixels just next to it."""
    arr = arr.copy()
    for axis, a, b, s0, s1 in WALL_GRID_LINES:
        n = b - a + 1
        if axis == "row":
            src = arr[a - n : a, s0:s1] if a - n >= 0 else arr[b + 1 : b + 1 + n, s0:s1]
            arr[a : b + 1, s0:s1] = src
        else:
            arr[s0:s1, a : b + 1] = arr[s0:s1, a - n : a]
    return arr
WALL_SCALE = 32 / 350  # a 350px tall wall face becomes 32px


def wall_top_tile(cap: np.ndarray) -> np.ndarray:
    """A 16x16 'top of wall' tile (walls seen from above on the left/right/bottom of the room)."""
    m = cap.reshape(-1, 4)[:, :3].astype(int)
    lum = m.sum(1)
    dark, mid, light = (np.median(m[lum <= np.percentile(lum, q)], 0) for q in (10, 50, 90))
    tile = np.zeros((T, T, 4), np.uint8)
    tile[..., 3] = 255
    tile[..., :3] = mid
    tile[1:3, :, :3] = light
    tile[-2:, :, :3] = dark
    tile[0, :, :3] = dark
    return tile


def walls():
    arr = erase_grid_lines(load(ENV / "tiles_wall_source.png"))
    out = np.zeros((4 * T, 8 * T, 4), np.uint8)
    names = {}
    for name, ((x0, y0, x1, y1), (tw, th)) in WALL_PIECES.items():
        c, r = WALL_LAYOUT[name]
        out[r * T : (r + th) * T, c * T : (c + tw) * T] = downscale(arr[y0:y1, x0:x1], (tw * T, th * T), alpha_thr=1)
        names[name] = [[(r + j) * 8 + (c + i) for i in range(tw)] for j in range(th)]
    top = wall_top_tile(arr[30:65, 60:180])
    out[2 * T : 3 * T, 4 * T : 5 * T] = top
    names["wall_top"] = 2 * 8 + 4
    out = quantize_opaque_only(out, 48)
    save(out, OUT / "tiles" / "tiles_wall.png")
    (OUT / "tiles" / "tiles_wall.json").write_text(json.dumps({"tileSize": T, "columns": 8, "tiles": names}, indent=2))
    preview(out, PREVIEW / "tiles_wall.png", scale=6, grid=(T, T))
    return arr


def wall_decor(arr):
    """Cut the wall decorations off their cream background."""
    items = {}
    y0, y1 = WALL_DECOR_Y
    for name, x0, x1 in WALL_DECOR_CELLS:
        cell = arr[y0:y1, x0 + 6 : x1 - 6].copy()
        rgb = cell[..., :3].astype(int)
        # the wall behind has a shadow band under the trim, so use every common border colour
        border_px = np.concatenate([rgb[:3].reshape(-1, 3), rgb[-3:].reshape(-1, 3),
                                    rgb[:, :3].reshape(-1, 3), rgb[:, -3:].reshape(-1, 3)])
        keys, counts = np.unique(border_px // 16, axis=0, return_counts=True)
        bg_colors = keys[counts > 0.03 * len(border_px)] * 16 + 8
        similar = np.zeros(rgb.shape[:2], bool)
        for col in bg_colors:
            similar |= np.abs(rgb - col).sum(2) < 40
        # flood fill the background from the cell border only
        lab, _ = ndimage.label(similar)
        border = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
        bgmask = np.isin(lab, list(border))
        fg = clean_mask(~bgmask, 30)
        b = bbox(fg)
        cell[~fg] = 0
        crop = cell[b[1] : b[3], b[0] : b[2]]
        size = (max(1, round(crop.shape[1] * WALL_SCALE)), max(1, round(crop.shape[0] * WALL_SCALE)))
        items[name] = downscale(crop, size)
    return items


# ---------------------------------------------------------------- furniture
# NOTE: furniture_meeting_source.png and furniture_decor_source.png have swapped contents.
FURNITURE = {
    "furniture_work_source.png": {
        "ref": ("desk_off", 32),
        "names": ["desk_off", "desk_on_blue", "desk_on_orange", "chair_front", "chair_back",
                  "desk_lamp", "mug", "papers", "laptop"],
    },
    "furniture_break_source.png": {
        "ref": ("sofa", 48),
        "names": ["coffee_counter", "water_cooler", "fridge", "sofa", "coffee_table", "snack_table", "beanbag"],
    },
    "furniture_meeting_source.png": {  # actually the decor sheet
        "ref": ("bookshelf_large", 32),
        "names": ["bookshelf_large", "bookshelf_small", "plant_monstera", "plant_snake", "cactus",
                  "hanging_plant", "floor_lamp", "trash_bin", "rug_round", "coat_rack"],
    },
    "furniture_tech_source.png": {
        "ref": ("server_rack_a", 16),
        "names": ["server_rack_a", "server_rack_b", "server_rack_alert", "printer", "router", "filing_cabinet"],
    },
    "furniture_decor_source.png": {  # actually the meeting sheet
        "ref": ("meeting_table", 64),
        "names": ["meeting_table", "whiteboard", "whiteboard_empty", "tv_screen"],
    },
}


def furniture_items(fname, spec):
    arr = load(ENV / fname)
    m = clean_mask(opaque(arr), 80)
    lab, _ = ndimage.label(ndimage.binary_dilation(m, iterations=8))
    blobs = []
    for i, sl in enumerate(ndimage.find_objects(lab), start=1):
        sub = m[sl] & (lab[sl] == i)
        b = bbox(sub)
        if b is None:
            continue
        x0, y0 = sl[1].start + b[0], sl[0].start + b[1]
        x1, y1 = sl[1].start + b[2], sl[0].start + b[3]
        if (x1 - x0) * (y1 - y0) > 1500:
            blobs.append((x0, y0, x1, y1))
    # rows by vertical centre (gap clustering), then left-to-right
    blobs.sort(key=lambda b: (b[1] + b[3]) / 2)
    rows, last = [], None
    for b in blobs:
        cy = (b[1] + b[3]) / 2
        if last is None or cy - last > 100:
            rows.append([])
        rows[-1].append(b)
        last = cy
    ordered = [b for row in rows for b in sorted(row, key=lambda b: b[0])]
    names = spec["names"]
    assert len(ordered) == len(names), (fname, len(ordered), len(names))
    ref_name, ref_w = spec["ref"]
    rb = ordered[names.index(ref_name)]
    scale = ref_w / (rb[2] - rb[0])
    items = {}
    for name, (x0, y0, x1, y1) in zip(names, ordered):
        crop = arr[y0:y1, x0:x1].copy()
        crop[~m[y0:y1, x0:x1]] = 0
        size = (max(1, round((x1 - x0) * scale)), max(1, round((y1 - y0) * scale)))
        items[name] = downscale(crop, size)
    return items


def pack(items: dict[str, np.ndarray], width: int = 256, pad: int = 2):
    """Simple shelf packer -> (atlas array, Phaser JSON-hash frames)."""
    order = sorted(items, key=lambda k: -items[k].shape[0])
    x = y = shelf_h = 0
    pos = {}
    for k in order:
        h, w = items[k].shape[:2]
        if x + w + pad > width:
            x, y, shelf_h = 0, y + shelf_h + pad, 0
        pos[k] = (x, y)
        x += w + pad
        shelf_h = max(shelf_h, h)
    height = y + shelf_h
    height = 1 << (height - 1).bit_length()
    atlas = np.zeros((height, width, 4), np.uint8)
    frames = {}
    for k, (px, py) in pos.items():
        h, w = items[k].shape[:2]
        atlas[py : py + h, px : px + w] = items[k]
        frames[k] = {
            "frame": {"x": px, "y": py, "w": w, "h": h},
            "rotated": False, "trimmed": False,
            "spriteSourceSize": {"x": 0, "y": 0, "w": w, "h": h},
            "sourceSize": {"w": w, "h": h},
        }
    return atlas, frames


def main():
    floors()
    wall_src = walls()
    items = {}
    for fname, spec in FURNITURE.items():
        items.update(furniture_items(fname, spec))
    items.update(wall_decor(wall_src))
    atlas, frames = pack(items)
    atlas = quantize_opaque_only(atlas, 64)
    save(atlas, OUT / "objects" / "objects.png")
    meta = {"frames": frames, "meta": {"image": "objects.png", "format": "RGBA8888",
                                       "size": {"w": atlas.shape[1], "h": atlas.shape[0]}, "scale": "1"}}
    (OUT / "objects" / "objects.json").write_text(json.dumps(meta, indent=2))
    preview(atlas, PREVIEW / "objects.png", scale=4)
    print(f"floors 32 tiles, walls ok, objects atlas {atlas.shape[1]}x{atlas.shape[0]} with {len(items)} items")
    for k, f in sorted(frames.items()):
        print(f"  {k:26s} {f['frame']['w']}x{f['frame']['h']}")


if __name__ == "__main__":
    main()
