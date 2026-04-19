import math
import sys
import qrcode
import numpy as np
from PIL import Image, ImageFilter, ImageEnhance, ImageDraw, ImageFont
from moviepy import VideoClip

# ================= INPUT =================
event_code = sys.argv[1] if len(sys.argv) > 1 else "CT-0000"
lang = sys.argv[2] if len(sys.argv) > 2 else "en"
artist_name = sys.argv[3] if len(sys.argv) > 3 else "ARTIST NAME"
venue = sys.argv[4] if len(sys.argv) > 4 else "VENUE"
event_date = sys.argv[5] if len(sys.argv) > 5 else "DATE"
output_path = sys.argv[6] if len(sys.argv) > 6 else f"./public/screen-videos/{event_code}_screen.mp4"

# ================= CONFIG =================
qr_data = f"https://codetone.codenxt.global/join/{event_code}?lang={lang}"

duration = 10
fps = 30

BG_W = 720
BG_H = 720

qr_size = 150
center_x = 360
center_y = 360

base_glow_blur = 22
base_glow_strength = 1.15
pulse_scale_amount = 0.03
pulse_speed = 1.0
unlock_boost_start = 7.6
unlock_flash_strength = 0.22

frame_path = "PeteA.png"

# ================= STARS =================
np.random.seed(42)
num_stars = 180
stars = []

for _ in range(num_stars):
    stars.append({
        "x": np.random.randint(0, BG_W),
        "y": np.random.randint(0, BG_H),
        "size": int(np.random.choice([1, 1, 1, 2])),
        "phase": np.random.rand() * 2 * math.pi,
        "speed": np.random.uniform(0.5, 1.5),
    })

# ================= QR =================
qr = qrcode.QRCode(
    error_correction=qrcode.constants.ERROR_CORRECT_H,
    box_size=10,
    border=1,
)
qr.add_data(qr_data)
qr.make(fit=True)

qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGBA")
qr_img = qr_img.resize((qr_size, qr_size), Image.Resampling.LANCZOS)

# ================= FRAME =================
frame = Image.open(frame_path).convert("RGBA")
FW, FH = frame.size

frame_base_x = (BG_W - FW) // 2
frame_base_y = (BG_H - FH) // 2

paste_x = center_x - (qr_size // 2)
paste_y = center_y - (qr_size // 2)

# ================= GLOW =================
alpha = frame.getchannel("A")

glow_pad = 120
glow_base = Image.new("L", (FW + glow_pad * 2, FH + glow_pad * 2), 0)
glow_base.paste(alpha, (glow_pad, glow_pad))

glow_mask = glow_base.filter(ImageFilter.GaussianBlur(base_glow_blur))
glow_color = Image.new("RGBA", glow_base.size, (86, 224, 255, 0))
glow_color.putalpha(glow_mask)

# ================= TEXT =================
def draw_text_layer():
    img = Image.new("RGBA", (BG_W, BG_H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    try:
        font_big = ImageFont.truetype("Arial.ttf", 40)
        font_small = ImageFont.truetype("Arial.ttf", 26)
    except:
        font_big = ImageFont.load_default()
        font_small = ImageFont.load_default()

    draw.text((BG_W//2, 40), artist_name, anchor="mm", fill=(255,255,255,255), font=font_big)
    draw.text((BG_W//2, BG_H-90), venue, anchor="mm", fill=(200,200,200,255), font=font_small)
    draw.text((BG_W//2, BG_H-60), event_date, anchor="mm", fill=(160,160,160,255), font=font_small)

    return img

text_layer = draw_text_layer()

# ================= FRAME FUNCTION =================
def make_frame(t: float):
    pulse = 0.5 + 0.5 * math.sin(2 * math.pi * pulse_speed * t)
    scale = 1.0 + pulse_scale_amount * pulse
    glow_strength = base_glow_strength + 0.25 * pulse

    unlock_progress = 0.0
    if t >= unlock_boost_start:
        unlock_progress = min((t - unlock_boost_start) / (duration - unlock_boost_start), 1.0)

    flash = unlock_flash_strength * unlock_progress

    canvas = Image.new("RGBA", (BG_W, BG_H), (5, 8, 14, 255))

    # stars
    star_layer = Image.new("RGBA", (BG_W, BG_H), (0,0,0,0))
    for s in stars:
        brightness = int(110 + 120 * (0.5 + 0.5 * math.sin(t * s["speed"] + s["phase"])))
        y = int((s["y"] + t * 4) % BG_H)

        for dx in range(s["size"]):
            for dy in range(s["size"]):
                px = s["x"] + dx
                py = y + dy
                if 0 <= px < BG_W and 0 <= py < BG_H:
                    star_layer.putpixel((px, py), (brightness, brightness, brightness, 255))

    canvas.alpha_composite(star_layer)

    # QR
    qr_layer = Image.new("RGBA", (BG_W, BG_H), (0,0,0,0))
    qr_layer.alpha_composite(qr_img, (paste_x, paste_y))
    canvas.alpha_composite(qr_layer)

    # glow
    glow = glow_color.copy()
    enhancer = ImageEnhance.Brightness(glow)
    glow = enhancer.enhance(glow_strength + flash)

    glow_scaled = glow.resize(
        (int(glow.size[0]*scale), int(glow.size[1]*scale)),
        Image.Resampling.LANCZOS
    )

    glow_x = (BG_W - glow_scaled.size[0]) // 2
    glow_y = (BG_H - glow_scaled.size[1]) // 2

    canvas.alpha_composite(glow_scaled, (glow_x, glow_y))

    canvas.alpha_composite(qr_layer)

    # frame
    frame_scaled = frame.resize(
        (int(FW*scale), int(FH*scale)),
        Image.Resampling.LANCZOS
    )

    frame_x = (BG_W - frame_scaled.size[0]) // 2
    frame_y = (BG_H - frame_scaled.size[1]) // 2

    canvas.alpha_composite(frame_scaled, (frame_x, frame_y))

    canvas.alpha_composite(text_layer)

    return np.array(canvas.convert("RGB"))

# ================= RENDER =================
clip = VideoClip(make_frame, duration=duration)
clip.write_videofile(
    output_path,
    fps=fps,
    codec="libx264",
    audio=False,
)

print("VIDEO CREATED:", output_path)