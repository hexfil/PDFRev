#!/usr/bin/env python3
r"""PDFRev_Tauri 素材生成：从设计原图产出应用图标与版权页 logo。

用法（在 F:\PDFRev_Tauri 下）：
    python tools/make-assets.py

输入（项目根目录的设计原图，脚本不改动它们）：
    pdfrev_icon.png   1024x1024  应用图标原图
    pdfrev_logo.png   1536x1024  版权页 logo 原图

输出：
    src-tauri/icons/icon.ico       多尺寸图标（16/24/32/48/64/128/256）
    src-tauri/icons/icon.png       512x512 图标
    src/assets/pdfrev_icon.png     256x256 界面用图标
    src/assets/pdfrev_logo.png     版权页 logo（裁白边后 720px 宽）

为什么要写脚本而不是直接放原图：
  1. pdfrev_icon.png 是 AI 出图，里面把“透明”画成了灰白棋盘格（40.96px 一格
     的烘焙像素，并不是真透明）。直接当图标用，任务栏里会显示棋盘格。这里按
     “与边界连通的浅色低饱和区域”找出棋盘格底并置为真透明，再对边缘做一次
     anti-alias 的 alpha 估算，避免留下白边。
  2. 图形四周有大片空白（bbox 约 183,196 - 841,832），直接缩放会让图形偏小
     且不居中；这里先裁到内容再补成正方形。
  3. 版权页 logo 原图 631 KB，界面上只显示约 320 CSS px；缩到 720px 宽可以把
     体积降到几十分之一（资源是编译期内嵌的，省下的都是净收益）。

依赖：Pillow、numpy、scipy。
"""

import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_SRC = os.path.join(ROOT, 'pdfrev_icon.png')
LOGO_SRC = os.path.join(ROOT, 'pdfrev_logo.png')
ICON_DIR = os.path.join(ROOT, 'src-tauri', 'icons')
ASSET_DIR = os.path.join(ROOT, 'src', 'assets')

# 棋盘格：原图 1024 边长上是 25 格，左上角第一格是浅灰
GRID = 25
GRAY = (235, 234, 233)
WHITE = (255, 255, 255)
ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
LOGO_WIDTH = 720
# 版权页 logo 的调色板色数（平涂图，64 色已足够）
LOGO_COLORS = 64


def log(msg):
    print(msg)


def checkerboard(size, grid=GRID):
    """还原原图里那张假透明棋盘格底，返回 (h, w, 3) 的 uint8 数组。"""
    p = size / float(grid)
    cy = np.arange(size) // p
    cx = np.arange(size) // p
    even = ((cy[:, None] + cx[None, :]) % 2) == 0
    out = np.empty((size, size, 3), dtype=np.uint8)
    out[even] = GRAY
    out[~even] = WHITE
    return out


def strip_checkerboard(src):
    """去掉烘焙的棋盘格底，返回 RGBA（真透明）与内容 bbox。"""
    im = Image.open(src).convert('RGB')
    a = np.asarray(im).astype(np.int16)
    h, w = a.shape[:2]

    lum = a.mean(axis=2)
    sat = a.max(axis=2) - a.min(axis=2)
    light = (lum > 205) & (sat < 28)

    # 只把“与边界连通”的浅色区域当背景：图形内部的白色属于设计本身，
    # 不能一起抠掉（那些是纯白 255，跟棋盘格的灰白格不是一回事）。
    lbl, _n = ndimage.label(light)
    border = set(lbl[0, :].tolist()) | set(lbl[-1, :].tolist())
    border |= set(lbl[:, 0].tolist()) | set(lbl[:, -1].tolist())
    border.discard(0)
    bg = np.isin(lbl, sorted(border))

    # 边缘 anti-alias：贴着背景的一圈算部分透明，实体像素全不透明
    near_bg = ndimage.binary_dilation(bg, iterations=2)
    board = checkerboard(w).astype(np.int16)
    dist = np.abs(a - board).max(axis=2).astype(np.float32)
    alpha = np.where(bg, 0.0, 255.0)
    edge = near_bg & ~bg
    alpha[edge] = np.clip(dist[edge] / 48.0, 0.0, 1.0) * 255.0

    rgba = np.dstack([a.astype(np.uint8), alpha.astype(np.uint8)])
    ys, xs = np.nonzero(rgba[:, :, 3] > 8)
    bbox = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    return Image.fromarray(rgba, 'RGBA'), bbox


def square_with_margin(im, margin_ratio=0.06):
    """裁到内容后补成正方形（留一点边距），透明底填充。"""
    w, h = im.size
    side = int(max(w, h) * (1 + margin_ratio * 2))
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - w) // 2, (side - h) // 2), im)
    return canvas


def build_icon():
    im, bbox = strip_checkerboard(ICON_SRC)
    log('图标：抠除棋盘格底，内容 bbox = %s（原图 %dx%d）' % (bbox, im.width, im.height))
    content = im.crop(bbox)
    sq = square_with_margin(content)
    master = sq.resize((256, 256), Image.LANCZOS)

    os.makedirs(ICON_DIR, exist_ok=True)
    ico = os.path.join(ICON_DIR, 'icon.ico')
    master.save(ico, format='ICO', sizes=ICO_SIZES)
    png = os.path.join(ICON_DIR, 'icon.png')
    sq.resize((512, 512), Image.LANCZOS).save(png, optimize=True)

    os.makedirs(ASSET_DIR, exist_ok=True)
    master.save(os.path.join(ASSET_DIR, 'pdfrev_icon.png'), optimize=True)

    for f in (ico, png):
        log('  -> %s (%d 字节)' % (os.path.relpath(f, ROOT), os.path.getsize(f)))


def build_logo():
    im = Image.open(LOGO_SRC).convert('RGB')
    a = np.asarray(im).astype(np.int16)
    # 原图四周是大片纯白，先按亮度裁掉
    nz = np.nonzero(a.min(axis=2) < 245)
    bbox = (int(nz[1].min()), int(nz[0].min()), int(nz[1].max()) + 1, int(nz[0].max()) + 1)
    log('Logo：裁除白边 %s -> %s' % (bbox, (bbox[2] - bbox[0], bbox[3] - bbox[1])))
    cropped = im.crop(bbox)

    pad = 12
    canvas = Image.new('RGB', (cropped.width + pad * 2, cropped.height + pad * 2), WHITE)
    canvas.paste(cropped, (pad, pad))

    scale = LOGO_WIDTH / float(canvas.width)
    out = canvas.resize((LOGO_WIDTH, max(1, int(round(canvas.height * scale)))), Image.LANCZOS)

    # logo 基本是平涂色（红字 + 深灰标语 + 白底），量化到 64 色几乎无损
    # （实测平均色差 1.16/255），体积却只有 1/3；资源是编译期内嵌进 exe 的，
    # 省下的都是发布物净减少的字节。
    out = out.quantize(colors=LOGO_COLORS, method=Image.MEDIANCUT).convert('RGB')

    os.makedirs(ASSET_DIR, exist_ok=True)
    dst = os.path.join(ASSET_DIR, 'pdfrev_logo.png')
    out.save(dst, optimize=True)
    log('  -> %s (%dx%d, %d 字节)' % (os.path.relpath(dst, ROOT), out.width, out.height, os.path.getsize(dst)))


def main():
    for f in (ICON_SRC, LOGO_SRC):
        if not os.path.exists(f):
            log('缺少设计原图：%s' % f)
            return 1
    build_icon()
    build_logo()
    log('素材生成完成。')
    return 0


if __name__ == '__main__':
    sys.exit(main())

