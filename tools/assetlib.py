"""Shared helpers for turning the AI-generated source images into game-ready pixel art."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "source"
OUT = ROOT / "assets" / "game"
PREVIEW = ROOT / "assets" / "preview"


def load(path: Path) -> np.ndarray:
    """Load an image as an RGBA uint8 array."""
    return np.array(Image.open(path).convert("RGBA"))


def to_img(arr: np.ndarray) -> Image.Image:
    return Image.fromarray(arr.astype(np.uint8), "RGBA")


def opaque(arr: np.ndarray, thr: int = 128) -> np.ndarray:
    return arr[..., 3] >= thr


def thin_runs(profile: np.ndarray, frac: float, max_width: int = 4, offset: int = 0) -> list[tuple[int, int]]:
    """Return (start, end) runs where profile > frac. Runs wider than max_width are tagged negative width."""
    on = profile > frac
    runs, start = [], None
    for i, v in enumerate(on):
        if v and start is None:
            start = i
        elif not v and start is not None:
            runs.append((start + offset, i - 1 + offset))
            start = None
    if start is not None:
        runs.append((start + offset, len(on) - 1 + offset))
    return [r for r in runs if r[1] - r[0] + 1 <= max_width] if max_width else runs


def clean_mask(mask: np.ndarray, min_size: int = 40) -> np.ndarray:
    """Drop tiny specks and thin line remnants from a boolean mask."""
    lab, n = ndimage.label(mask, structure=np.ones((3, 3)))
    if n == 0:
        return mask
    keep = np.zeros(n + 1, bool)
    for i, sl in enumerate(ndimage.find_objects(lab), start=1):
        h, w = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        size = int((lab[sl] == i).sum())
        thin_line = min(h, w) <= 3 and max(h, w) >= 12
        keep[i] = size >= min_size and not thin_line
    return keep[lab]


def bbox(mask: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.nonzero(mask)
    if len(ys) == 0:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def downscale(arr: np.ndarray, size: tuple[int, int], alpha_thr: int = 110) -> np.ndarray:
    """High-quality downscale (premultiplied Lanczos) then hard alpha so edges stay crisp."""
    a = arr[..., 3:4].astype(np.float32) / 255.0
    pre = np.concatenate([arr[..., :3] * a, a * 255.0], axis=2)
    chans = [
        np.array(Image.fromarray(pre[..., c].astype(np.float32), "F").resize(size, Image.Resampling.LANCZOS))
        for c in range(4)
    ]
    out = np.stack(chans, axis=2)
    alpha = np.clip(out[..., 3], 0, 255)
    safe = np.maximum(alpha / 255.0, 1e-6)[..., None]
    rgb = np.clip(out[..., :3] / safe, 0, 255)
    hard = np.where(alpha >= alpha_thr, 255, 0)
    res = np.concatenate([rgb, hard[..., None]], axis=2).astype(np.uint8)
    res[hard == 0] = 0
    return res


def quantize(arr: np.ndarray, colors: int = 32) -> np.ndarray:
    """Reduce to a shared limited palette (no dithering), keeping binary alpha."""
    mask = arr[..., 3] > 0
    if not mask.any():
        return arr
    rgb = Image.fromarray(arr[..., :3])
    q = rgb.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert("RGB")
    out = np.concatenate([np.array(q), np.where(mask, 255, 0)[..., None]], axis=2).astype(np.uint8)
    out[~mask] = 0
    return out


def quantize_opaque_only(arr: np.ndarray, colors: int = 32) -> np.ndarray:
    """Quantize using only the opaque pixels to build the palette (transparent area ignored)."""
    mask = arr[..., 3] > 0
    if not mask.any():
        return arr
    px = arr[mask][:, :3]
    side = int(np.ceil(np.sqrt(len(px))))
    pad = np.zeros((side * side, 3), np.uint8)
    pad[: len(px)] = px
    pad[len(px):] = px[0]
    pal_img = Image.fromarray(pad.reshape(side, side, 3)).quantize(
        colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE
    )
    q = Image.fromarray(arr[..., :3]).quantize(palette=pal_img, dither=Image.Dither.NONE).convert("RGB")
    out = np.concatenate([np.array(q), np.where(mask, 255, 0)[..., None]], axis=2).astype(np.uint8)
    out[~mask] = 0
    return out


def save(arr: np.ndarray, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    to_img(arr).save(path, optimize=True)


def checker(w: int, h: int, cell: int = 8) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w]
    c = ((yy // cell + xx // cell) % 2).astype(np.uint8)
    bg = np.where(c[..., None] == 1, np.array([70, 70, 80, 255]), np.array([90, 90, 100, 255]))
    return bg.astype(np.uint8)


def preview(arr: np.ndarray, path: Path, scale: int = 4, grid: tuple[int, int] | None = None) -> None:
    """Save an upscaled preview on a checkerboard, optionally drawing frame grid lines."""
    img = to_img(arr).resize((arr.shape[1] * scale, arr.shape[0] * scale), Image.Resampling.NEAREST)
    bg = to_img(checker(img.width, img.height, cell=scale * 4))
    bg.alpha_composite(img)
    out = np.array(bg)
    if grid:
        gw, gh = grid[0] * scale, grid[1] * scale
        out[::gh, :, :3] = (120, 200, 255)
        out[:, ::gw, :3] = (120, 200, 255)
    path.parent.mkdir(parents=True, exist_ok=True)
    to_img(out).save(path)
