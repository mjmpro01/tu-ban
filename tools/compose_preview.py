"""Compose a small office scene from the processed assets to sanity-check scale and style."""
from __future__ import annotations

import json

import numpy as np
from PIL import Image

from assetlib import OUT, PREVIEW

T = 16


def img(path):
    return Image.open(path).convert("RGBA")


def main():
    floor = img(OUT / "tiles" / "tiles_floor.png")
    wall = img(OUT / "tiles" / "tiles_wall.png")
    fmeta = json.loads((OUT / "tiles" / "tiles_floor.json").read_text())["tiles"]
    wmeta = json.loads((OUT / "tiles" / "tiles_wall.json").read_text())["tiles"]
    objects = img(OUT / "objects" / "objects.png")
    frames = json.loads((OUT / "objects" / "objects.json").read_text())["frames"]
    emotes = img(OUT / "ui" / "emotes.png")

    W, H = 24, 16
    scene = Image.new("RGBA", (W * T, H * T), (0, 0, 0, 255))

    def tile(sheet, idx, x, y):
        c, r = idx % 8, idx // 8
        scene.alpha_composite(sheet.crop((c * T, r * T, (c + 1) * T, (r + 1) * T)), (x * T, y * T))

    # floor
    for y in range(3, H - 1):
        for x in range(1, W - 1):
            tile(floor, fmeta[f"wood_{1 + (x * 7 + y * 3) % 4}"], x, y)
    for y in range(9, 14):  # meeting carpet
        for x in range(16, 22):
            tile(floor, fmeta[f"carpet_green_{1 + (x + y) % 4}"], x, y)
    # top wall (2 tiles tall face + cap row above)
    x = 1
    pieces = ["wall_cream_a", "wall_cream_a", "wall_cream_window", "wall_cream_a", "wall_cream_b", "wall_cream_window",
              "wall_cream_a", "wall_cream_a", "wall_cream_door", "wall_cream_a", "wall_cream_window", "wall_cream_a",
              "wall_cream_b", "wall_cream_a", "wall_cream_a", "wall_cream_a"]
    for p in pieces * 2:
        grid = wmeta[p]
        for j, row in enumerate(grid):
            for i, idx in enumerate(row):
                if x + i < W - 1:
                    tile(wall, idx, x + i, 1 + j)
        x += len(grid[0])
        if x >= W - 1:
            break
    for x in range(W):
        tile(wall, wmeta["wall_top"], x, 0)
    for y in range(H):
        tile(wall, wmeta["wall_top"], 0, y)
        tile(wall, wmeta["wall_top"], W - 1, y)
    for x in range(W):
        tile(wall, wmeta["wall_top"], x, H - 1)

    def obj(name, x, y):
        f = frames[name]["frame"]
        scene.alpha_composite(objects.crop((f["x"], f["y"], f["x"] + f["w"], f["y"] + f["h"])), (int(x), int(y - f["h"])))

    def char(name, row, col, x, y):
        sheet = img(OUT / "characters" / f"char_{name}.png")
        scene.alpha_composite(sheet.crop((col * 32, row * 32, (col + 1) * 32, (row + 1) * 32)), (int(x), int(y - 32)))

    def emote(row, x, y):
        scene.alpha_composite(emotes.crop((0, row * 16, 16, (row + 1) * 16)), (int(x) + 2, int(y) - 4))

    obj("wall_picture", 2.5 * T, 2.2 * T)
    obj("wall_clock", 9.3 * T, 2.2 * T)
    obj("wall_corkboard", 15.3 * T, 2.4 * T)
    obj("bookshelf_large", 1.2 * T, 4.6 * T)
    obj("plant_monstera", 3.4 * T, 4.6 * T)
    obj("sofa", 5 * T, 4.8 * T)
    obj("coffee_counter", 11.5 * T, 4.4 * T)
    obj("water_cooler", 14.3 * T, 4.4 * T)
    obj("server_rack_a", 21 * T, 4.6 * T)
    obj("server_rack_b", 22 * T, 4.6 * T)

    desks = [(3, 8), (7, 8), (3, 12), (7, 12), (11, 12)]
    who = ["manager", "researcher", "writer", "cursor", "copilot"]
    state = ["desk_on_orange", "desk_on_orange", "desk_off", "desk_on_blue", "desk_on_blue"]
    for (dx, dy), name, st in zip(desks, who, state):
        obj(st, dx * T, dy * T)
    # characters sit in front of their desk with their back to the camera; the chair back
    # is drawn over them. Back-seated rows: 12 = type, 13 = think, 14 = doze.
    seated_row = {"manager": 13, "researcher": 12, "writer": 14, "cursor": 12, "copilot": 12}
    for (dx, dy), name in zip(desks, who):
        char(name, seated_row[name], 0, dx * T, dy * T + 12)
        obj("chair_back", dx * T + 10, dy * T + 17)
    for (dx, dy), em in zip(desks, [0, 6, 3, 7, 9]):  # thinking, search, sleep, code, remote
        emote(em, dx * T + 6, dy * T - 42)

    obj("whiteboard", 17.5 * T, 9 * T)
    obj("meeting_table", 16.5 * T, 13 * T)
    obj("plant_snake", 22 * T, 9 * T)
    char("manager", 7, 1, 13.5 * T, 9.5 * T)  # walking right
    emote(1, 13.5 * T + 6, 9.5 * T - 52)

    out = scene.resize((scene.width * 3, scene.height * 3), Image.Resampling.NEAREST)
    PREVIEW.mkdir(parents=True, exist_ok=True)
    out.save(PREVIEW / "scene.png")
    print("scene ->", PREVIEW / "scene.png")


if __name__ == "__main__":
    main()
