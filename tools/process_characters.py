"""Cut the 5 character atlases into Phaser spritesheets (32x32 frames) + 64x64 portraits.

Source layout (per atlas): REFERENCE strip, MOVEMENT grid (8 rows x 4 cols),
ACTION grid (4 rows x 4 cols), PORTRAIT box. Grid lines are detected automatically.
"""
from __future__ import annotations

import json

import numpy as np
from scipy import ndimage

from assetlib import OUT, PREVIEW, SRC, bbox, clean_mask, downscale, load, opaque, preview, quantize_opaque_only, save, thin_runs

CHARACTERS = ["manager", "researcher", "writer", "cursor", "copilot"]
FRAME = 32
CHAR_HEIGHT = 30  # standing height in px inside a 32px frame
COLS = 4

# Row order in the output sheet (same order as the source grids).
ROWS = [
    ("idle_down", 2), ("idle_up", 2), ("idle_right", 2), ("idle_left", 2),
    ("walk_down", 4), ("walk_up", 4), ("walk_right", 4), ("walk_left", 4),
    ("type", 4), ("think", 2), ("doze", 2), ("ask", 2),
]
FRAME_RATES = {"idle": 2, "walk": 8, "type": 8, "think": 2, "doze": 1, "ask": 3}


def column_lines(m: np.ndarray) -> list[int]:
    """x positions of the label panel edge + the 4 grid column separators."""
    vruns = thin_runs(m[200:780].mean(0), 0.5, max_width=0)
    label_end = max(r[1] for r in vruns if r[1] - r[0] > 60 and r[1] < 400)
    thin_v = [r for r in vruns if r[1] - r[0] <= 4 and r[0] > label_end + 20]
    xs = [label_end] + [(r[0] + r[1]) // 2 for r in thin_v[:COLS]]
    assert len(xs) == COLS + 1, xs
    return xs


def find_sprite_rows(arr: np.ndarray):
    """Locate every sprite inside the movement/action grids and group them into rows.

    Grid lines are erased first, then sprite blobs are clustered by their vertical
    centre. This is robust to grids whose lines are faint or slightly misaligned.
    """
    m = opaque(arr)
    xs = column_lines(m)
    x0, x1 = xs[0] + 4, xs[-1] - 4
    area = m[:, x0:x1].copy()
    lines = np.zeros_like(area)
    for y in np.nonzero(area.mean(1) > 0.4)[0]:
        lines[max(0, y - 2) : y + 3] = True
    for x in xs[1:-1]:
        lines[:, max(0, x - x0 - 4) : x - x0 + 5] = True
    area = clean_mask(area & ~lines, 40)
    # merge nearby sprite parts, but never across an erased grid line
    grown = ndimage.binary_dilation(area, iterations=3) & ~lines
    lab, n = ndimage.label(grown, structure=np.ones((3, 3)))
    blobs = []
    for i, sl in enumerate(ndimage.find_objects(lab), start=1):
        sub = area[sl] & (lab[sl] == i)
        b = bbox(sub)
        if b is None:
            continue
        bx0, by0 = sl[1].start + b[0] + x0, sl[0].start + b[1]
        bx1, by1 = sl[1].start + b[2] + x0, sl[0].start + b[3]
        cy, h = (by0 + by1) / 2, by1 - by0
        if 185 < cy < 1170 and 40 <= h <= 120:
            blobs.append((cy, (bx0, by0, bx1, by1)))
    blobs.sort()
    rows, last = [], None
    for cy, b in blobs:
        if last is None or cy - last > 25:
            rows.append([])
        rows[-1].append(b)
        last = cy
    full = np.zeros_like(m)
    full[:, x0:x1] = area
    grid = []
    for row in rows:
        cells = [None] * COLS
        for b in row:
            cx = (b[0] + b[2]) / 2
            c = int(np.searchsorted(xs, cx)) - 1
            if 0 <= c < COLS:
                cells[c] = b if cells[c] is None else (
                    min(cells[c][0], b[0]), min(cells[c][1], b[1]), max(cells[c][2], b[2]), max(cells[c][3], b[3]))
        sprites = []
        for b in cells:
            if b is None:
                sprites.append(None)
                continue
            crop = arr[b[1] : b[3], b[0] : b[2]].copy()
            crop[~full[b[1] : b[3], b[0] : b[2]]] = 0
            sprites.append(crop)
        grid.append(sprites)
    bottom = max(b[3] for row in rows for b in row)
    return xs, grid, bottom


def head_center_x(sprite) -> float:
    m = opaque(sprite)
    top = m[: max(1, int(m.shape[0] * 0.35))]
    xs = np.nonzero(top.any(0))[0]
    return (xs.min() + xs.max() + 1) / 2 if len(xs) else m.shape[1] / 2


def head_width(sprite) -> float:
    """Width of the head (widest row in the top 30%) - used to match seated vs standing scale."""
    m = opaque(sprite)
    top = m[: max(1, int(m.shape[0] * 0.3))]
    spans = [np.nonzero(r)[0] for r in top if r.any()]
    return float(max(s.max() - s.min() + 1 for s in spans)) if spans else float(m.shape[1])


def place(sprite, scale):
    h, w = sprite.shape[:2]
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    small = downscale(sprite, (nw, nh))
    frame = np.zeros((FRAME, FRAME, 4), np.uint8)
    cx = head_center_x(sprite) * scale
    ox = int(round(FRAME / 2 - cx))
    oy = FRAME - nh
    # clip into the frame
    sx0, sy0 = max(0, -ox), max(0, -oy)
    dx0, dy0 = max(0, ox), max(0, oy)
    cw, ch = min(nw - sx0, FRAME - dx0), min(nh - sy0, FRAME - dy0)
    frame[dy0 : dy0 + ch, dx0 : dx0 + cw] = small[sy0 : sy0 + ch, sx0 : sx0 + cw]
    return frame


def portrait(arr, act_bottom):
    h, w = arr.shape[:2]
    region = arr[act_bottom + 30 : h - 20, 40 : w - 40].copy()
    m = opaque(region)
    # strip long straight box lines (some portraits are drawn inside a frame)
    for a, b in thin_runs(m.mean(0), 0.9, max_width=4):
        m[:, a : b + 1] = False
    for a, b in thin_runs(m.mean(1), 0.9, max_width=4):
        m[a : b + 1, :] = False
    lab, n = ndimage.label(m, structure=np.ones((3, 3)))
    sizes = ndimage.sum(m, lab, range(1, n + 1))
    main = int(np.argmax(sizes)) + 1
    mb = bbox(lab == main)
    keep = np.zeros_like(m)
    for i, sl in enumerate(ndimage.find_objects(lab), start=1):
        # keep blobs overlapping the main blob's bounding box (hair strands, pencil...)
        if sizes[i - 1] >= 30 and sl[1].start < mb[2] and sl[1].stop > mb[0] and sl[0].start < mb[3] and sl[0].stop > mb[1]:
            keep |= lab == i
    x0, y0, x1, y1 = bbox(keep)
    region[~keep] = 0
    crop = region[y0:y1, x0:x1]
    side = max(crop.shape[:2])
    sq = np.zeros((side, side, 4), np.uint8)
    ox = (side - crop.shape[1]) // 2
    sq[side - crop.shape[0] :, ox : ox + crop.shape[1]] = crop  # bottom aligned (shoulders)
    return quantize_opaque_only(downscale(sq, (64, 64)), 40)


def process(name):
    arr = load(SRC / "characters" / f"{name}_atlas.png")
    xs, cells, grid_bottom = find_sprite_rows(arr)
    assert len(cells) == len(ROWS), f"{name}: found {len(cells)} sprite rows"

    idle_h = [s.shape[0] for s in cells[0] if s is not None]
    scale = CHAR_HEIGHT / float(np.median(idle_h))

    # The action grid was drawn at a larger zoom than the movement grid:
    # rescale each action row so its head size matches the standing head size.
    ref_head = float(np.median([head_width(s) for s in cells[0] if s is not None]))
    row_scale = []
    for r, row in enumerate(cells):
        if r < 8:
            row_scale.append(scale)
        else:
            heads = [head_width(s) for s in row if s is not None]
            row_scale.append(scale * ref_head / float(np.median(heads)) if heads else scale)

    sheet = np.zeros((FRAME * len(ROWS), FRAME * COLS, 4), np.uint8)
    anims = {}
    for r, ((anim, expected), row) in enumerate(zip(ROWS, cells)):
        frames = [s for s in row if s is not None][:expected]
        if len(frames) != expected:
            print(f"  ! {name}.{anim}: found {len(frames)} frames, expected {expected}")
        for c, spr in enumerate(frames):
            sheet[r * FRAME : (r + 1) * FRAME, c * FRAME : (c + 1) * FRAME] = place(spr, row_scale[r])
        kind = anim.split("_")[0]
        anims[anim] = {
            "frames": [r * COLS + c for c in range(len(frames))],
            "frameRate": FRAME_RATES[kind],
            "repeat": -1,
        }
    sheet = quantize_opaque_only(sheet, 32)
    save(sheet, OUT / "characters" / f"char_{name}.png")
    save(portrait(arr, grid_bottom), OUT / "portraits" / f"portrait_{name}.png")
    print(f"  {name}: columns x={xs} scale={scale:.3f} action={[round(x / scale, 2) for x in row_scale[8:]]}")
    return sheet, anims


def main():
    sheets, meta = [], {"frameWidth": FRAME, "frameHeight": FRAME, "columns": COLS, "animations": {}}
    for name in CHARACTERS:
        sheet, anims = process(name)
        sheets.append(sheet)
        meta["animations"] = anims  # identical layout for every character
    meta["characters"] = CHARACTERS
    (OUT / "characters" / "characters.json").write_text(json.dumps(meta, indent=2))
    gap = np.zeros((sheets[0].shape[0], 8, 4), np.uint8)
    combo = np.concatenate([x for s in sheets for x in (s, gap)][:-1], axis=1)
    preview(combo, PREVIEW / "characters.png", scale=3)
    from assetlib import load as _l  # noqa: F401
    ports = np.concatenate([np.array(__import__("PIL.Image", fromlist=["Image"]).open(OUT / "portraits" / f"portrait_{n}.png").convert("RGBA")) for n in CHARACTERS], axis=1)
    preview(ports, PREVIEW / "portraits.png", scale=3)


if __name__ == "__main__":
    main()
