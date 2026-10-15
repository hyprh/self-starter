#!/usr/bin/env python3
"""Render the README notification demo. Requires Python, pycairo and FFmpeg.

Run from any directory: python docs/demos/render-notification.py
The interface and notification are illustrations, not a live Codex capture.
"""
import json
import math
import re
import subprocess
from pathlib import Path

import cairo

ROOT = Path(__file__).resolve().parent
DATA = json.loads((ROOT / 'futu-notification.json').read_text())
WIDTH, HEIGHT, FPS, DURATION = 1280, 720, 30, 26
BG, PANEL, LINE = '#0b111b', '#131d2b', '#28364a'
TEXT, MUTED, GREEN, BLUE, AMBER, RED = '#eef4ff', '#9aaac1', '#6ae4b4', '#88baff', '#f0cc7a', '#ff8b9a'
COPY = json.dumps(DATA, ensure_ascii=False)
assert not re.search(r'[\u3400-\u9fff]|\b\d{1,2}:\d{2}\b|20\d{2}-\d{2}-\d{2}|/home/|codex://threads/', COPY)


def color(ctx, value, alpha=1):
    value = value.lstrip('#')
    ctx.set_source_rgba(*(int(value[i:i + 2], 16) / 255 for i in (0, 2, 4)), alpha)


def box(ctx, x, y, w, h, fill=PANEL, stroke=LINE, radius=18, alpha=1):
    ctx.new_sub_path()
    for cx, cy, begin in ((x + w - radius, y + radius, -math.pi / 2),
                          (x + w - radius, y + h - radius, 0),
                          (x + radius, y + h - radius, math.pi / 2),
                          (x + radius, y + radius, math.pi)):
        ctx.arc(cx, cy, radius, begin, begin + math.pi / 2)
    ctx.close_path()
    color(ctx, fill, alpha)
    ctx.fill_preserve()
    if stroke:
        color(ctx, stroke, alpha)
        ctx.set_line_width(1)
        ctx.stroke()
    else:
        ctx.new_path()


def text(ctx, x, y, value, size=22, fill=TEXT, bold=False, alpha=1):
    ctx.select_font_face('Noto Sans', cairo.FONT_SLANT_NORMAL,
                         cairo.FONT_WEIGHT_BOLD if bold else cairo.FONT_WEIGHT_NORMAL)
    ctx.set_font_size(size)
    color(ctx, fill, alpha)
    ctx.move_to(x, y)
    ctx.show_text(value)


def lines(ctx, x, y, value, width, size=22, fill=TEXT, bold=False, leading=1.45):
    ctx.select_font_face('Noto Sans', cairo.FONT_SLANT_NORMAL,
                         cairo.FONT_WEIGHT_BOLD if bold else cairo.FONT_WEIGHT_NORMAL)
    ctx.set_font_size(size)
    for paragraph in value.split('\n'):
        current = ''
        for word in paragraph.split():
            test = f'{current} {word}'.strip()
            if current and ctx.text_extents(test).x_advance > width:
                text(ctx, x, y, current, size, fill, bold)
                y += size * leading
                current = word
            else:
                current = test
        if current:
            text(ctx, x, y, current, size, fill, bold)
        y += size * leading
    return y


def ease(value):
    value = max(0, min(1, value))
    return 1 - (1 - value) ** 3


def eyes(ctx, x, y, scale=1):
    for dx in (0, 13):
        color(ctx, GREEN)
        ctx.arc(x + dx * scale, y, 5 * scale, 0, 2 * math.pi)
        ctx.fill()
        color(ctx, BG)
        ctx.arc(x + dx * scale + scale, y, 2 * scale, 0, 2 * math.pi)
        ctx.fill()


def chrome(ctx):
    gradient = cairo.LinearGradient(0, 0, WIDTH, HEIGHT)
    gradient.add_color_stop_rgb(0, 0.045, 0.085, 0.13)
    gradient.add_color_stop_rgb(1, 0.025, 0.04, 0.07)
    ctx.set_source(gradient)
    ctx.paint()
    eyes(ctx, 71, 51)
    text(ctx, 104, 59, 'Self-Starter', 23, TEXT, True)
    box(ctx, 919, 31, 297, 38, '#142332', '#2b4559', 19)
    text(ctx, 940, 56, 'FUTU WATCH  /  EDITED REPLAY', 14, GREEN, True)
    text(ctx, 64, 693, 'Illustrated interface and notification  /  Historical quotes  /  Waiting condensed', 14, MUTED)


def heading(ctx, title, subtitle):
    text(ctx, 64, 153, title, 52, TEXT, True)
    text(ctx, 65, 201, subtitle, 23, MUTED)


def scene_ask(ctx, elapsed):
    heading(ctx, 'Ask once.', 'Tell your agent what deserves your attention.')
    box(ctx, 64, 251, 1152, 296)
    text(ctx, 97, 297, 'YOU', 15, BLUE, True)
    words = DATA['watch_request'].split()
    visible = ' '.join(words[:int(max(0, elapsed - 0.35) * 27)])
    lines(ctx, 97, 340, visible, 1055, 25)
    if elapsed > 2.5:
        text(ctx, 97, 498, 'SELF-STARTER + FUTU', 15, GREEN, True)
        text(ctx, 335, 498, 'Watch configured. Investigation requested when a move stands out.', 18, MUTED)
    text(ctx, 65, 616, 'One request. A watch that can bring Codex back.', 25, GREEN)


def scene_wait(ctx, elapsed):
    heading(ctx, 'You keep working.', 'The watch stays on your machine.')
    box(ctx, 64, 253, 720, 327)
    text(ctx, 94, 294, 'YOUR WORKSPACE', 15, MUTED, True)
    color(ctx, LINE)
    ctx.rectangle(94, 313, 660, 1)
    ctx.fill()
    text(ctx, 100, 392, 'Build something.', 38, TEXT, True)
    text(ctx, 101, 439, 'You can close Codex and focus elsewhere.', 21, MUTED)
    for i, w in enumerate((480, 391, 444)):
        box(ctx, 101, 479 + i * 22, w, 7, '#28364a', None, 3)

    box(ctx, 816, 253, 400, 327, '#111f2a', '#2b4b48')
    color(ctx, GREEN, 0.7 + 0.3 * math.sin(elapsed * 3) ** 2)
    ctx.arc(849, 292, 5, 0, 2 * math.pi)
    ctx.fill()
    text(ctx, 867, 299, 'WATCHING LOCALLY', 16, GREEN, True)
    for i, symbol in enumerate(DATA['symbols']):
        x, y = 845 + (i % 4) * 88, 326 + (i // 4) * 53
        box(ctx, x, y, 79, 36, '#1a2a3a', '#30465c', 8)
        text(ctx, x + 12, y + 25, symbol, 15, TEXT, True)
    text(ctx, 846, 478, 'No model calls while waiting.', 21, TEXT, True)
    lines(ctx, 846, 512, 'A small probe checks the condition in the background.', 335, 17, MUTED)
    text(ctx, 65, 635, 'No open chat window required.', 25, GREEN)


def check(ctx, x, y, done):
    color(ctx, GREEN if done else LINE)
    ctx.arc(x, y, 10, 0, 2 * math.pi)
    ctx.fill()
    if done:
        color(ctx, BG)
        ctx.set_line_width(2)
        ctx.move_to(x - 4, y)
        ctx.line_to(x - 1, y + 3)
        ctx.line_to(x + 5, y - 4)
        ctx.stroke()


def scene_investigate(ctx, elapsed):
    heading(ctx, 'A move stands out.', 'Codex comes back to the conversation and investigates.')
    box(ctx, 64, 251, 443, 326)
    text(ctx, 97, 299, DATA['quote']['symbol'], 23, TEXT, True)
    text(ctx, 97, 370, DATA['quote']['price'], 51, TEXT, True)
    text(ctx, 98, 425, DATA['quote']['change'], 37, RED, True)
    text(ctx, 98, 475, 'Compared with SMH: -2.05%', 21, MUTED)
    text(ctx, 98, 536, 'Historical Futu quote', 15, MUTED)

    box(ctx, 539, 251, 677, 326)
    text(ctx, 573, 299, 'CODEX  /  INVESTIGATING', 15, GREEN, True)
    steps = ['Compare the move with its sector.', 'Check price and trading volume.',
             'Verify whether the headline is new.', 'Return an act-or-watch assessment.']
    for i, step in enumerate(steps):
        done = elapsed > 0.2 + i * 0.7
        check(ctx, 584, 340 + i * 58, done)
        text(ctx, 611, 347 + i * 58, step, 22, TEXT if done else MUTED)
    text(ctx, 65, 635, 'The trigger starts the work. Codex checks the context.', 25, GREEN)


def bell(ctx, x, y):
    ctx.save()
    ctx.translate(x, y)
    color(ctx, GREEN)
    ctx.set_line_width(2.5)
    ctx.arc(0, -2, 9, math.pi, 2 * math.pi)
    ctx.line_to(9, 7)
    ctx.line_to(13, 11)
    ctx.line_to(-13, 11)
    ctx.line_to(-9, 7)
    ctx.close_path()
    ctx.stroke()
    ctx.arc(0, 13, 3, 0, math.pi)
    ctx.stroke()
    ctx.restore()


def scene_notify(ctx, elapsed):
    heading(ctx, 'The result finds you.', 'Codex investigates. Self-Starter notifies your desktop.')
    box(ctx, 64, 268, 617, 307)
    text(ctx, 98, 314, 'BACK IN YOUR CONVERSATION', 15, GREEN, True)
    text(ctx, 98, 366, DATA['conclusion'].upper(), 31, AMBER, True)
    lines(ctx, 98, 414, DATA['finding'], 532, 25)
    lines(ctx, 98, 519, 'An investigation, not just a price ping.', 532, 20, MUTED)

    arrived = ease((elapsed - 0.5) / 0.8)
    x = 720 + (1 - arrived) * 560
    y = 302 - 18 * math.sin(arrived * math.pi)
    ctx.save()
    ctx.push_group()
    text(ctx, x + 2, y - 23, 'DESKTOP NOTIFICATION', 15, GREEN, True)
    for spread, opacity in ((12, 0.08), (6, 0.12)):
        box(ctx, x - spread, y - spread, 496 + spread * 2, 242 + spread * 2,
            GREEN, None, 22 + spread, opacity)
    box(ctx, x, y, 496, 242, '#172b35', '#4a8e7b', 20)
    box(ctx, x + 22, y + 22, 44, 44, '#22463f', None, 12)
    bell(ctx, x + 44, y + 44)
    text(ctx, x + 82, y + 40, 'Self-Starter', 18, TEXT, True)
    text(ctx, x + 82, y + 63, 'Futu unusual price and volume', 15, MUTED)
    text(ctx, x + 25, y + 111, 'AMD down 4.31%.', 25, TEXT, True)
    text(ctx, x + 25, y + 149, 'Investigation ready in Codex.', 23, TEXT)
    lines(ctx, x + 25, y + 195, 'Return to your conversation for the full brief.', 446, 17, MUTED)
    group = ctx.pop_group()
    ctx.set_source(group)
    ctx.paint_with_alpha(arrived)
    ctx.restore()
    text(ctx, 65, 635, 'Watch. Investigate. Notify.', 28, GREEN, True)


SCENES = [(0, 6, scene_ask), (6, 11, scene_wait),
          (11, 16, scene_investigate), (16, DURATION, scene_notify)]


def render():
    video = ROOT / 'futu-notification.mp4'
    gif = ROOT / 'futu-notification.gif'
    palette = ROOT / '.notification-palette.png'
    encoder = subprocess.Popen([
        'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'rawvideo', '-pixel_format', 'bgr0', '-video_size', f'{WIDTH}x{HEIGHT}',
        '-framerate', str(FPS), '-i', 'pipe:0', '-an', '-c:v', 'libx264',
        '-threads', '2', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p',
        '-map_metadata', '-1', '-metadata', 'creation_time=', '-movflags', '+faststart', str(video),
    ], stdin=subprocess.PIPE)
    try:
        surface = cairo.ImageSurface(cairo.FORMAT_RGB24, WIDTH, HEIGHT)
        ctx = cairo.Context(surface)
        for frame in range(FPS * DURATION):
            at = frame / FPS
            chrome(ctx)
            for start, end, draw in SCENES:
                if start <= at < end:
                    ctx.save()
                    ctx.push_group()
                    draw(ctx, at - start)
                    group = ctx.pop_group()
                    ctx.set_source(group)
                    ctx.paint_with_alpha(ease((at - start) / 0.25))
                    ctx.restore()
            surface.flush()
            encoder.stdin.write(surface.get_data())
        encoder.stdin.close()
        if encoder.wait() != 0:
            raise RuntimeError('MP4 encoding failed')
    except BaseException:
        encoder.kill()
        encoder.wait()
        raise

    base = ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-threads', '2',
            '-filter_threads', '2', '-filter_complex_threads', '2']
    try:
        subprocess.run(base + ['-i', str(video), '-vf', 'fps=12,palettegen=max_colors=192:stats_mode=diff',
                              '-frames:v', '1', '-update', '1', str(palette)], check=True)
        subprocess.run(base + ['-i', str(video), '-i', str(palette), '-filter_complex',
                              '[0:v]fps=12[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
                              '-loop', '0', '-map_metadata', '-1', str(gif)], check=True)
    finally:
        palette.unlink(missing_ok=True)
    for path in (video, gif):
        if path.stat().st_size >= 10_000_000:
            raise RuntimeError(f'{path.name} exceeds the 10 MB attachment target')
        print(f'{path.name}: {path.stat().st_size:,} bytes', flush=True)


if __name__ == '__main__':
    render()
