"""UI assets: emotes (4x12 grid of 16x16), 9-slice bubbles (4 x 24x24), bubble tails (4 x 8x8), emote frame (20x20)."""
from __future__ import annotations

import json

import numpy as np
from scipy import ndimage

from assetlib import OUT, PREVIEW, SRC, bbox, clean_mask, downscale, load, opaque, preview, quantize_opaque_only, save

UI = SRC / "ui"
EMOTES = ["thinking", "alert", "question", "sleep", "angry", "done", "search", "code", "coffee", "remote", "handoff", "celebrate"]
EMOTE_FRAMES = {name: 4 for name in EMOTES}  # the source has 4 frames for every emote
BUBBLES = ["speech", "thought", "alert", "error"]


def blobs(arr, min_area=2000, dilate=6):
    m = clean_mask(opaque(arr), 60)
    lab, _ = ndimage.label(ndimage.binary_dilation(m, iterations=dilate))
    out = []
    for i, sl in enumerate(ndimage.find_objects(lab), start=1):
        b = bbox(m[sl] & (lab[sl] == i))
        if b is None:
            continue
        x0, y0, x1, y1 = sl[1].start + b[0], sl[0].start + b[1], sl[1].start + b[2], sl[0].start + b[3]
        if (x1 - x0) * (y1 - y0) >= min_area:
            out.append((x0, y0, x1, y1))
    return sorted(out, key=lambda b: b[0]), m


def emotes():
    arr = load(UI / "emotes.png")
    h, w = arr.shape[:2]
    cw, ch = w / 4, h / 12
    out = np.zeros((12 * 16, 4 * 16, 4), np.uint8)
    for r in range(12):
        cells = []
        for c in range(EMOTE_FRAMES[EMOTES[r]]):
            x0, y0, x1, y1 = int(c * cw), int(r * ch), int((c + 1) * cw), int((r + 1) * ch)
            cell = arr[y0:y1, x0:x1].copy()
            cell[~clean_mask(opaque(cell), 30)] = 0
            cells.append(cell)
        # crop every frame of the row to the same square (union bbox) so the icon fills the
        # 16px cell while the animation frames stay aligned with each other
        boxes = [bbox(opaque(c)) for c in cells if bbox(opaque(c))]
        ux0, uy0 = min(b[0] for b in boxes), min(b[1] for b in boxes)
        ux1, uy1 = max(b[2] for b in boxes), max(b[3] for b in boxes)
        side = max(ux1 - ux0, uy1 - uy0)
        cx, cy = (ux0 + ux1) // 2, (uy0 + uy1) // 2
        for c, cell in enumerate(cells):
            sq = np.zeros((side, side, 4), np.uint8)
            sx0, sy0 = cx - side // 2, cy - side // 2
            src = cell[max(0, sy0) : sy0 + side, max(0, sx0) : sx0 + side]
            sq[max(0, -sy0) : max(0, -sy0) + src.shape[0], max(0, -sx0) : max(0, -sx0) + src.shape[1]] = src
            tile = np.zeros((16, 16, 4), np.uint8)
            tile[1:15, 1:15] = downscale(sq, (14, 14), alpha_thr=100)
            out[r * 16 : (r + 1) * 16, c * 16 : (c + 1) * 16] = tile
    out = quantize_opaque_only(out, 40)
    save(out, OUT / "ui" / "emotes.png")
    anims = {name: {"frames": [r * 4 + c for c in range(EMOTE_FRAMES[name])], "frameRate": 4,
                    "repeat": -1} for r, name in enumerate(EMOTES)}
    (OUT / "ui" / "emotes.json").write_text(json.dumps({"frameWidth": 16, "frameHeight": 16, "columns": 4, "animations": anims}, indent=2))
    preview(out, PREVIEW / "emotes.png", scale=6, grid=(16, 16))


def nine_slice(tile: np.ndarray, corner: int = 8) -> np.ndarray:
    """Make edges and centre uniform so the bubble stretches cleanly."""
    t = tile.copy()
    n = t.shape[0]
    mid = n // 2
    t[:, corner : n - corner] = t[:, mid : mid + 1]
    t[corner : n - corner, :] = t[mid : mid + 1, :]
    return t


def bubbles():
    arr = load(UI / "bubbles.png")
    bs, m = blobs(arr)
    assert len(bs) == 4, bs
    out = np.zeros((24, 96, 4), np.uint8)
    for i, (x0, y0, x1, y1) in enumerate(bs):
        crop = arr[y0:y1, x0:x1].copy()
        crop[~m[y0:y1, x0:x1]] = 0
        out[:, i * 24 : (i + 1) * 24] = nine_slice(downscale(crop, (24, 24), alpha_thr=100))
    out = quantize_opaque_only(out, 24)
    save(out, OUT / "ui" / "bubbles.png")
    preview(out, PREVIEW / "bubbles.png", scale=8, grid=(8, 8))


def tails():
    arr = load(UI / "bubble_tails.png")
    bs, m = blobs(arr, dilate=20)
    assert len(bs) == 4, bs
    out = np.zeros((8, 32, 4), np.uint8)
    for i, (x0, y0, x1, y1) in enumerate(bs):
        crop = arr[y0:y1, x0:x1].copy()
        crop[~m[y0:y1, x0:x1]] = 0
        # drop the dithered strip the generator left along the top edge
        rows = opaque(crop).mean(1)
        top = 0
        while top < len(rows) // 3 and rows[top] < 0.85 * rows.max():
            top += 1
        if i != 1:  # the thought-bubble trail is two circles, keep it whole
            crop = crop[top:]
        th = max(1, min(8, round(8 * crop.shape[0] / crop.shape[1])))
        small = downscale(crop, (8, th), alpha_thr=100)
        out[:th, i * 8 : (i + 1) * 8] = small
    out = quantize_opaque_only(out, 16)
    save(out, OUT / "ui" / "bubble_tails.png")
    preview(out, PREVIEW / "bubble_tails.png", scale=12, grid=(8, 8))


def emote_frame():
    arr = load(UI / "emote_frame.png")
    bs, m = blobs(arr)
    x0, y0, x1, y1 = max(bs, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))
    crop = arr[y0:y1, x0:x1].copy()
    crop[~m[y0:y1, x0:x1]] = 0
    h = max(1, round(20 * crop.shape[0] / crop.shape[1]))
    out = np.zeros((20, 20, 4), np.uint8)
    out[(20 - h) // 2 : (20 - h) // 2 + h] = downscale(crop, (20, h), alpha_thr=100)
    out = quantize_opaque_only(out, 12)
    save(out, OUT / "ui" / "emote_frame.png")
    preview(out, PREVIEW / "emote_frame.png", scale=12)


def main():
    emotes()
    bubbles()
    tails()
    emote_frame()
    (OUT / "ui" / "ui.json").write_text(json.dumps({
        "bubbles": {"file": "bubbles.png", "size": 24, "corner": 8, "order": BUBBLES},
        "tails": {"file": "bubble_tails.png", "size": 8, "order": BUBBLES},
        "emoteFrame": {"file": "emote_frame.png", "size": 20},
    }, indent=2))
    print("ui ok")


if __name__ == "__main__":
    main()
