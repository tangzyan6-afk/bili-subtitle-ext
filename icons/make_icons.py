# -*- coding: utf-8 -*-
# 把生成的 1024 图处理成扩展用的多尺寸图标：
# 1) 裁掉右下角水印（裁掉底部一条）
# 2) 水平居中裁成方形
# 3) LANCZOS 缩放到 128/48/32/16
from PIL import Image
import glob, os

src = glob.glob(os.path.join(os.path.dirname(__file__), "A_cute_*.png"))[0]
img = Image.open(src).convert("RGBA")
w, h = img.size
print("source:", w, "x", h)

# 裁掉底部 8%（水印在右下角）
img = img.crop((0, 0, w, int(h * 0.92)))
w, h = img.size

# 居中裁成方形
side = min(w, h)
left = (w - side) // 2
img = img.crop((left, 0, left + side, side))

out = os.path.dirname(__file__)
for size in (128, 48, 32, 16):
    im = img.resize((size, size), Image.LANCZOS)
    p = os.path.join(out, f"icon{size}.png")
    im.save(p, optimize=True)
    print("saved", p, os.path.getsize(p), "bytes")

# 原图归档为 source.png（避免 glob 再匹配到）
os.replace(src, os.path.join(out, "source.png"))
print("renamed source ->", "source.png")
