import math
import os
import sys
import textwrap

import numpy as np
import qrcode
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont
from moviepy import VideoClip


# ============================================================
# codeNXT / codeTone screen-video generator v2
#
# Bruk:
# python3 pete_qr_video.py CT-3947 en
# python3 pete_qr_video.py CT-3947 en "PETE ANDERSON" "THE TUNING FORK" "JULY 4, 2026"
#
# Output:
# ./screen_videos/<event_code>_screen.mp4
#
# V2:
# - 1920x1080 widescreen
# - samme badge / QR / glow-logikk som v1
# - artistnavn øverst
# - CTA + venue/date nederst
# - QR holdes stabil og ren
# ============================================================


# -----------------------------
# INPUT
# -----------------------------
event_code = sys.argv[1] if len(sys.argv) > 1 else "CT-3947"
lang = sys.argv[2] if len(sys.argv) > 2 else "en"
artist_name = sys.argv[3] if len(sys.argv) > 3 else "PETE ANDERSON"
venue_name = sys.argv[4] if len(sys.argv) > 4 else "THE TUNING FORK"
event_date = sys.argv[5] if len(sys.argv) > 5 else "JULY 4, 2026"
output_path = sys.argv[6] if len(sys.argv) > 6 else f"./public/screen-videos/{event_code}_screen.mp4"

# -----------------------------
# PATHS
# -----------------------------
qr_data = f"https://codetone.codenxt.global/join/{event_code}?lang={lang}"

# Bruk din ferdige transparente ramme med kvadratisk hull:
frame_path = "PeteA.png"

os.makedirs(os.path.dirname(output_path), exist_ok=True)

# -----------------------------
# VIDEO CONFIG
# -----------------------------
duration = 8
fps = 24

BG_W = 640
BG_H = 640

# Badge-plassering og størrelse
badge_size = 560
badge_center_x = BG_W // 2
badge_center_y = 455

# QR i badge
qr_size = 168
qr_center_x_rel = 280
qr_center_y_rel = 283

# Glow / puls
base_glow_blur = 36
base_glow_strength = 1.12
pulse_scale_amount = 0.022
pulse_speed = 1.0
unlock_boost_start = 7.4
unlock_flash_strength = 0.16

# Stjerner
np.random.seed(42)
num_stars = 260
stars = []

# Tekst
headline_y = 90
cta_y = 770
status_y = 845
footer_rule_y = 920
footer_y = 960
brand_y = 1005

headline_color = (255, 255, 255, 255)
cta_color = (255, 255, 255, 255)
status_color = (22, 215, 230, 255)
footer_color = (255, 255, 255, 255)
brand_primary_color = (255, 255, 255, 255)
brand_secondary_color = (200, 205, 214, 255)

# QR-farger
qr_fill_color = "#000000"
qr_back_color = "#F4EFE6"

# -----------------------------
# FONTS
# -----------------------------
FONT_CANDIDATES_BOLD = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Supplemental/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
]
FONT_CANDIDATES_REGULAR = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/System/Library/Fonts/Supplemental/Helvetica.ttc",
]


def load_font(candidates: list[str], size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size=size)
            except Exception:
                continue
    return ImageFont.load_default()


headline_font = load_font(FONT_CANDIDATES_BOLD, 84)
cta_font = load_font(FONT_CANDIDATES_BOLD, 54)
status_font = load_font(FONT_CANDIDATES_BOLD, 46)
footer_font = load_font(FONT_CANDIDATES_BOLD, 42)
brand_font = load_font(FONT_CANDIDATES_REGULAR, 22)
brand_font_bold = load_font(FONT_CANDIDATES_BOLD, 22)

# -----------------------------
# HELPERS
# -----------------------------
def fit_text(draw: ImageDraw.ImageDraw, text: str, max_width: int, start_size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    size = start_size
    while size >= 32:
        font = load_font(FONT_CANDIDATES_BOLD, size)
        bbox = draw.textbbox((0, 0), text, font=font)
        width = bbox[2] - bbox[0]
        if width <= max_width:
            return font
        size -= 2
    return load_font(FONT_CANDIDATES_BOLD, 32)


def center_text(draw: ImageDraw.ImageDraw, y: int, text: str, font: ImageFont.ImageFont, fill: tuple[int, int, int, int]) -> None:
    bbox = draw.textbbox((0, 0), text, font=font)
    text_w = bbox[2] - bbox[0]
    x = (BG_W - text_w) // 2
    draw.text((x, y), text, font=font, fill=fill)


def draw_centered_multiline(
    draw: ImageDraw.ImageDraw,
    center_x: int,
    start_y: int,
    text: str,
    font: ImageFont.ImageFont,
    fill: tuple[int, int, int, int],
    line_spacing: int = 8,
) -> None:
    lines = text.split("\n")
    bboxes = [draw.textbbox((0, 0), line, font=font) for line in lines]
    heights = [(b[3] - b[1]) for b in bboxes]
    total_h = sum(heights) + line_spacing * (len(lines) - 1)
    y = start_y - total_h // 2

    for line, bbox, h in zip(lines, bboxes, heights):
        w = bbox[2] - bbox[0]
        x = center_x - (w // 2)
        draw.text((x, y), line, font=font, fill=fill)
        y += h + line_spacing


# -----------------------------
# GENERER QR
# -----------------------------
qr = qrcode.QRCode(
    error_correction=qrcode.constants.ERROR_CORRECT_H,
    box_size=10,
    border=1,
)
qr.add_data(qr_data)
qr.make(fit=True)

qr_img = qr.make_image(fill_color=qr_fill_color, back_color=qr_back_color).convert("RGBA")
qr_img = qr_img.resize((qr_size, qr_size), Image.Resampling.LANCZOS)

# -----------------------------
# LAST RAMME
# -----------------------------
if not os.path.exists(frame_path):
    raise FileNotFoundError(
        f"Fant ikke rammefilen: {frame_path}\n"
        f"Legg den der eller endre frame_path i scriptet."
    )

frame = Image.open(frame_path).convert("RGBA")
frame = frame.resize((badge_size, badge_size), Image.Resampling.LANCZOS)
FW, FH = frame.size

frame_base_x = badge_center_x - FW // 2
frame_base_y = badge_center_y - FH // 2

paste_x = frame_base_x + qr_center_x_rel - (qr_size // 2)
paste_y = frame_base_y + qr_center_y_rel - (qr_size // 2)

# -----------------------------
# GLOW-FORARBEID
# -----------------------------
alpha = frame.getchannel("A")
glow_pad = 180

glow_base = Image.new("L", (FW + glow_pad * 2, FH + glow_pad * 2), 0)
glow_base.paste(alpha, (glow_pad, glow_pad))

glow_mask = glow_base.filter(ImageFilter.GaussianBlur(base_glow_blur))
glow_color = Image.new("RGBA", glow_base.size, (86, 224, 255, 0))
glow_color.putalpha(glow_mask)

# -----------------------------
# STJERNER
# -----------------------------
for _ in range(num_stars):
    stars.append(
        {
            "x": np.random.randint(0, BG_W),
            "y": np.random.randint(0, BG_H),
            "size": int(np.random.choice([1, 1, 1, 2])),
            "phase": np.random.rand() * 2 * math.pi,
            "speed": np.random.uniform(0.4, 1.4),
        }
    )


def make_background(t: float) -> Image.Image:
    canvas = Image.new("RGBA", (BG_W, BG_H), (5, 8, 14, 255))

    # Subtil radial dybde
    depth = Image.new("RGBA", (BG_W, BG_H), (0, 0, 0, 0))
    depth_draw = ImageDraw.Draw(depth, "RGBA")
    depth_draw.ellipse(
        (-220, -60, BG_W + 220, BG_H + 240),
        fill=(20, 46, 96, 55),
    )
    depth = depth.filter(ImageFilter.GaussianBlur(120))
    canvas.alpha_composite(depth)

    # Stjerner
    star_layer = Image.new("RGBA", (BG_W, BG_H), (0, 0, 0, 0))
    for s in stars:
        brightness = int(105 + 120 * (0.5 + 0.5 * math.sin(t * s["speed"] + s["phase"])))
        y = int((s["y"] + t * 3.2) % BG_H)

        for dx in range(s["size"]):
            for dy in range(s["size"]):
                px = s["x"] + dx
                py = y + dy
                if 0 <= px < BG_W and 0 <= py < BG_H:
                    star_layer.putpixel((px, py), (brightness, brightness, brightness, 255))

    canvas.alpha_composite(star_layer)
    return canvas


def make_text_layer() -> Image.Image:
    layer = Image.new("RGBA", (BG_W, BG_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer, "RGBA")

    fitted_headline_font = fit_text(draw, artist_name.upper(), BG_W - 220, 84)
    center_text(draw, headline_y, artist_name.upper(), fitted_headline_font, headline_color)

    cta_text = "SCAN NOW"
    center_text(draw, cta_y, cta_text, cta_font, cta_color)

    status_text = "ACTIVE AFTER THE SHOW"
    center_text(draw, status_y, status_text, status_font, status_color)

    # footer rule
    rule_w = 560
    draw.line(
        ((BG_W - rule_w) // 2, footer_rule_y, (BG_W + rule_w) // 2, footer_rule_y),
        fill=(255, 255, 255, 70),
        width=2,
    )

    footer_text = f"{venue_name.upper()} • {event_date.upper()}"
    fitted_footer_font = fit_text(draw, footer_text, BG_W - 260, 42)
    center_text(draw, footer_y, footer_text, fitted_footer_font, footer_color)

    # brand
    brand_left = "codeTone"
    brand_mid = " powered by "
    brand_right = "codeNXT"

    b1 = draw.textbbox((0, 0), brand_left, font=brand_font_bold)
    b2 = draw.textbbox((0, 0), brand_mid, font=brand_font)
    b3 = draw.textbbox((0, 0), brand_right, font=brand_font_bold)

    w1 = b1[2] - b1[0]
    w2 = b2[2] - b2[0]
    w3 = b3[2] - b3[0]
    total_w = w1 + w2 + w3

    x = (BG_W - total_w) // 2
    draw.text((x, brand_y), brand_left, font=brand_font_bold, fill=brand_primary_color)
    x += w1
    draw.text((x, brand_y), brand_mid, font=brand_font, fill=brand_secondary_color)
    x += w2
    draw.text((x, brand_y), brand_right, font=brand_font_bold, fill=brand_primary_color)

    return layer


text_layer = make_text_layer()


def make_frame(t: float):
    pulse = 0.5 + 0.5 * math.sin(2 * math.pi * pulse_speed * t)
    scale = 1.0 + pulse_scale_amount * pulse
    glow_strength = base_glow_strength + 0.22 * pulse

    unlock_progress = 0.0
    if t >= unlock_boost_start:
        unlock_progress = min((t - unlock_boost_start) / (duration - unlock_boost_start), 1.0)

    flash = unlock_flash_strength * unlock_progress

    canvas = make_background(t)

    # QR rent
    qr_layer = Image.new("RGBA", (BG_W, BG_H), (0, 0, 0, 0))
    qr_layer.alpha_composite(qr_img, (paste_x, paste_y))

    # Glow
    glow = glow_color.copy()
    enhancer = ImageEnhance.Brightness(glow)
    glow = enhancer.enhance(glow_strength + flash)

    glow_w, glow_h = glow.size
    glow_scaled_w = int(glow_w * scale)
    glow_scaled_h = int(glow_h * scale)
    glow_scaled = glow.resize((glow_scaled_w, glow_scaled_h), Image.Resampling.LANCZOS)

    glow_x = badge_center_x - glow_scaled_w // 2
    glow_y = badge_center_y - glow_scaled_h // 2
    canvas.alpha_composite(glow_scaled, (glow_x, glow_y))

    # QR først
    canvas.alpha_composite(qr_layer)

    # Ramme øverst
    frame_scaled_w = int(FW * scale)
    frame_scaled_h = int(FH * scale)
    frame_scaled = frame.resize((frame_scaled_w, frame_scaled_h), Image.Resampling.LANCZOS)

    frame_x = badge_center_x - frame_scaled_w // 2
    frame_y = badge_center_y - frame_scaled_h // 2
    canvas.alpha_composite(frame_scaled, (frame_x, frame_y))

    # Tegn QR på nytt så den holder seg crisp
    canvas.alpha_composite(qr_layer)

    # Subtil unlock-boost
    if unlock_progress > 0:
        overlay_alpha = int(34 * unlock_progress)
        light_overlay = Image.new("RGBA", (BG_W, BG_H), (255, 255, 255, overlay_alpha))
        canvas.alpha_composite(light_overlay)

    # Tekst øverst/nederst
    canvas.alpha_composite(text_layer)

    return np.array(canvas.convert("RGB"))


clip = VideoClip(make_frame, duration=duration)
clip.write_videofile(
    output_path,
    fps=fps,
    codec="libx264",
    audio=False,
)

print("QR URL:", qr_data)
print("Screen-video klar:", output_path)