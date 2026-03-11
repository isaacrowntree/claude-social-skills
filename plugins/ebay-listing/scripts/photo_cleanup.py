#!/usr/bin/env python3
"""Auto-cleanup product photos for eBay listings.

Applies: auto white balance, auto contrast, brightness boost, sharpening.
Saves processed images alongside originals with _clean suffix.
"""
import os
import sys
from PIL import Image, ImageEnhance, ImageFilter, ImageOps


def auto_white_balance(img: Image.Image) -> Image.Image:
    """Gray world white balance correction."""
    pixels = list(img.getdata())
    r_avg = sum(p[0] for p in pixels) / len(pixels)
    g_avg = sum(p[1] for p in pixels) / len(pixels)
    b_avg = sum(p[2] for p in pixels) / len(pixels)
    avg = (r_avg + g_avg + b_avg) / 3

    r_scale = avg / r_avg if r_avg > 0 else 1
    g_scale = avg / g_avg if g_avg > 0 else 1
    b_scale = avg / b_avg if b_avg > 0 else 1

    r, g, b = img.split()
    r = r.point(lambda x: min(255, int(x * r_scale)))
    g = g.point(lambda x: min(255, int(x * g_scale)))
    b = b.point(lambda x: min(255, int(x * b_scale)))
    return Image.merge("RGB", (r, g, b))


def cleanup_image(input_path: str, output_path: str):
    """Apply auto-corrections to a product photo."""
    img = Image.open(input_path).convert("RGB")

    # 1. Auto white balance
    img = auto_white_balance(img)

    # 2. Auto contrast (histogram stretch)
    img = ImageOps.autocontrast(img, cutoff=0.5)

    # 3. Slight brightness boost
    img = ImageEnhance.Brightness(img).enhance(1.08)

    # 4. Slight contrast boost
    img = ImageEnhance.Contrast(img).enhance(1.05)

    # 5. Sharpen
    img = ImageEnhance.Sharpness(img).enhance(1.3)

    # Save at high quality
    img.save(output_path, "JPEG", quality=95)
    print(f"  {os.path.basename(input_path)} -> {os.path.basename(output_path)}")


def main():
    if len(sys.argv) < 2:
        print("Usage: photo_cleanup.py <directory|file> [...]")
        sys.exit(1)

    paths = []
    for arg in sys.argv[1:]:
        if os.path.isdir(arg):
            for f in sorted(os.listdir(arg)):
                if f.lower().endswith((".jpg", ".jpeg", ".png")) and "_clean" not in f:
                    paths.append(os.path.join(arg, f))
        elif os.path.isfile(arg):
            paths.append(arg)

    if not paths:
        print("No images found.")
        sys.exit(1)

    print(f"Processing {len(paths)} images...")
    for path in paths:
        name, ext = os.path.splitext(path)
        output = f"{name}_clean{ext}"
        cleanup_image(path, output)

    print("Done!")


if __name__ == "__main__":
    main()
