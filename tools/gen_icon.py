#!/usr/bin/env python3
"""SuperCode 应用图标生成器（P1-10，「指挥官终端」概念）。

设计语言：发光的 >_ 终端提示符（总控/运行的符号）+ 深空靛蓝渐变 squircle
+ 右上互联节点（多 agent 编排隐喻）+ 青→靛→紫渐变（呼应应用暗色终端审美）。

用法：python3 tools/gen_icon.py [输出路径，默认 apps/desktop/public/icon-master.png]
产出 1024x1024 透明角 master；再经 `pnpm tauri icon` 生成全尺寸（PNG/ICO/ICNS）。
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# 渲染超采样（2x）后缩小，保证边缘平滑
S = 2048
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "apps/desktop/public/icon-master.png")

# 配色（与应用 Tailwind 暗色终端风一致）
BG_TOP = np.array([13, 20, 52], dtype=float)       # #0D1434 深空靛
BG_BOTTOM = np.array([64, 34, 140], dtype=float)   # #40228C 暗紫
PROMPT_A = (103, 232, 249)                        # cyan-300
PROMPT_B = (129, 140, 248)                        # indigo-400
PROMPT_C = (192, 132, 252)                        # purple-400


def diagonal_gradient(size, c_from, c_to):
    """左上→右下对角渐变（numpy 向量化）。"""
    y, x = np.mgrid[0:size, 0:size].astype(float)
    t = (x / size + y / size) / 2
    rgb = c_from[None, None, :] * (1 - t[..., None]) + c_to[None, None, :] * t[..., None]
    return Image.fromarray(np.dstack([rgb, np.full((size, size), 255.0)]).astype(np.uint8), "RGBA")


def radial_glow(size, center, radius, color, max_alpha):
    """中心向外的径向柔光（numpy 距离场）。"""
    cy, cx = center
    y, x = np.mgrid[0:size, 0:size].astype(float)
    d = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / radius
    a = np.clip(1 - d, 0, 1) ** 2 * max_alpha
    rgb = np.zeros((size, size, 4))
    rgb[..., 0], rgb[..., 1], rgb[..., 2] = color
    rgb[..., 3] = a
    return Image.fromarray(rgb.astype(np.uint8), "RGBA")


def lerp_rgba(c1, c2, t):
    return tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(4))


def draw_prompt(size):
    """主视觉 >_ ：白底 mask（chevron 两笔圆头线 + 圆角方块光标）。"""
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    w = 172  # 笔宽
    # chevron ">"：两段线 + 端点圆（圆头帽）
    p_top, apex, p_bot = (580, 610), (990, 1024), (580, 1438)
    d.line([p_top, apex], fill=255, width=w)
    d.line([apex, p_bot], fill=255, width=w, joint="curve")
    for p in (p_top, apex, p_bot):
        r = w / 2
        d.ellipse([p[0] - r, p[1] - r, p[0] + r, p[1] + r], fill=255)
    # 光标 "_"：贴基线的宽扁药丸（终端下划线光标形态，与 chevron 底端 1438 对齐；
    # 居中方块会读成"小正方形"——P1-10 用户反馈）
    d.rounded_rectangle([1085, 1228, 1535, 1438], radius=105, fill=255)
    return mask


def prompt_gradient(size):
    """青→靛→紫对角渐变（作用于提示符 mask）。"""
    return diagonal_gradient(size, np.array(PROMPT_A, float), np.array(PROMPT_C, float))


def draw_constellation(size):
    """右上互联节点（多 agent 隐喻）：细线 + 圆点，低透明度。"""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    nodes = [(1400, 380), (1640, 540), (1500, 760), (1720, 300), (1280, 560)]
    edges = [(0, 1), (1, 2), (0, 3), (0, 4), (4, 2)]
    line_c = (148, 163, 255, 60)
    for a, b in edges:
        d.line([nodes[a], nodes[b]], fill=line_c, width=6)
    for i, (x, y) in enumerate(nodes):
        r = 16 if i else 26  # 首节点略大（指挥节点）
        glow_r = r * 2.2
        d.ellipse([x - glow_r, y - glow_r, x + glow_r, y + glow_r], fill=(129, 140, 248, 46))
        d.ellipse([x - r, y - r, x + r, y + r], fill=(196, 181, 253, 165))
    return layer.filter(ImageFilter.GaussianBlur(1.2))


def main():
    # 1) 背景：对角渐变 squircle
    img = diagonal_gradient(S, BG_TOP, BG_BOTTOM)
    # 中心偏左的青色氛围光 + 右下紫色氛围光
    img = Image.alpha_composite(img, radial_glow(S, (760, 1024), 900, (34, 211, 238), 40))
    img = Image.alpha_composite(img, radial_glow(S, (1700, 1750), 1000, (124, 58, 237), 55))

    # 2) 互联节点层
    img = Image.alpha_composite(img, draw_constellation(S))

    # 3) 提示符发光层（形状模糊后以低透明度垫底）
    prompt_mask = draw_prompt(S)
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    glow.paste((56, 189, 248, 130), (0, 0), prompt_mask)
    glow = glow.filter(ImageFilter.GaussianBlur(52))
    img = Image.alpha_composite(img, glow)

    # 4) 提示符本体：渐变穿过形状 mask + 顶部渐隐高光（玻璃质感，逐行衰减 alpha）
    grad = prompt_gradient(S)
    body = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    body.paste(grad, (0, 0), prompt_mask)
    img = Image.alpha_composite(img, body)
    fade = Image.fromarray(np.tile(np.linspace(96, 0, S).astype(np.uint8)[:, None], (1, S)), "L")
    hl_alpha = Image.composite(fade, Image.new("L", (S, S), 0), prompt_mask)
    highlight = Image.new("RGBA", (S, S), (255, 255, 255, 255))
    highlight.putalpha(hl_alpha)
    img = Image.alpha_composite(img, highlight)

    # 5) squircle 裁形 + 内描边（深色桌面上的轮廓定义；描边叠加在内容之上，
    #    此前误用 Image.composite(stroke, out, mask) 把内部整层换成了描边——
    #    mask=255 区域取第一参数，导致整图 alpha 归零、转 RGB 后全黑）
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=470, fill=255)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    stroke = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(stroke).rounded_rectangle(
        [10, 10, S - 11, S - 11], radius=462, outline=(255, 255, 255, 36), width=8
    )
    out = Image.alpha_composite(out, stroke)

    # 6) 缩到 1024 输出
    out = out.resize((1024, 1024), Image.LANCZOS)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    out.save(OUT)
    out.resize((512, 512), Image.LANCZOS).save(OUT.with_name("icon-preview.png"))
    print(f"master → {OUT}（1024）；preview → {OUT.with_name('icon-preview.png')}")


if __name__ == "__main__":
    main()
