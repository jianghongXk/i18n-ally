"""生成扩展图标 res/logo.png（256x256 RGBA）。

设计：深蓝圆角方块 + 白色「A 文」并排，表示英中双向。
差异化于原版 i18n-ally 的橄榄绿双气泡，避免装在同一台机器上分不清。

内部按 4 倍尺寸绘制再降采样，边缘和字形都比直接画 256 干净。

用法：python scripts/build-logo.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT_SIZE = 256
SS = 4                     # 超采样倍数
S = OUT_SIZE * SS

RADIUS = 54 * SS
TOP = (26, 62, 168)        # #1A3EA8 深蓝
BOTTOM = (56, 132, 246)    # #3884F6 亮蓝
WHITE = (255, 255, 255)

FONT_LATIN = "C:/Windows/Fonts/arialbd.ttf"
FONT_CJK = "C:/Windows/Fonts/msyhbd.ttc"

OUT = Path(__file__).resolve().parent.parent / "res" / "logo.png"


def gradient(size: int) -> Image.Image:
    img = Image.new("RGB", (size, size), TOP)
    draw = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        draw.line(
            [(0, y), (size, y)],
            fill=tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3)),
        )
    return img


def main() -> None:
    grad = gradient(S)

    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=RADIUS, fill=255)

    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    canvas.paste(grad, (0, 0), mask)

    draw = ImageDraw.Draw(canvas)
    font_a = ImageFont.truetype(FONT_LATIN, 96 * SS)
    font_cjk = ImageFont.truetype(FONT_CJK, 80 * SS)

    box_a = draw.textbbox((0, 0), "A", font=font_a)
    box_w = draw.textbbox((0, 0), "文", font=font_cjk)
    width_a = box_a[2] - box_a[0]
    width_w = box_w[2] - box_w[0]

    gap = 16 * SS
    left = (S - (width_a + gap + width_w)) // 2

    # 两个字按底边对齐；基线略低于正中，方块图标视觉上更稳
    baseline = 170 * SS
    draw.text((left - box_a[0], baseline - box_a[3]), "A", font=font_a, fill=WHITE)
    draw.text((left + width_a + gap - box_w[0], baseline - box_w[3]), "文", font=font_cjk, fill=WHITE)

    canvas = canvas.resize((OUT_SIZE, OUT_SIZE), Image.LANCZOS)
    canvas.save(OUT, "PNG")
    print(f"wrote {OUT} ({OUT_SIZE}x{OUT_SIZE}, {SS}x supersampled)")


if __name__ == "__main__":
    main()
