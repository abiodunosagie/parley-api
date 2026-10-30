"""Builds parley-api's README banners and social preview from one place, in Parley's brand: the
same mark and palette, the same typeface outlined from brand/fonts (SIL Open Font License), so no
file depends on a font being installed.

Run from the repo root:  python3 brand/generate.py   (needs fontTools, and Chrome for the PNG)
"""
import pathlib
import shutil
import subprocess

from textpath import font, glyph_bounds, text_path

ROOT = pathlib.Path(__file__).resolve().parents[1]
BRAND = ROOT / 'brand'

# Parley's palette (github.com/abiodunosagie/parley, brand/BRAND.md).
GREEN, MINT, INK, PAPER, DEEP, NIGHT, MUTED = (
    '#1F6F54', '#5CC79C', '#15130F', '#F3EFE6', '#14503D', '#0F0E0C', '#6B675F')

# Parley's mark: two half-discs facing across a gap, the left one a step higher.
LEFT = 'M120 36A80 80 0 0 0 120 196Z'
RIGHT = 'M136 60A80 80 0 0 1 136 220Z'

WORD = font('BricolageGrotesque%5Bopsz,wdth,wght%5D.ttf', wght=600, opsz=48, wdth=100)
BODY = font('BricolageGrotesque%5Bopsz,wdth,wght%5D.ttf', wght=400, opsz=14, wdth=100)
MONO = font('BricolageGrotesque%5Bopsz,wdth,wght%5D.ttf', wght=500, opsz=14, wdth=100)

TITLE = 'parley-api'
LINE = "Parley's backend as a NestJS service."
DETAIL = 'Supabase auth  ·  atomic rate limits  ·  SSE streaming  ·  Claude API  ·  Vercel'


def svg(w, h, body):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">{body}</svg>'


def fitted(f, text, size, max_width, x, baseline):
    """Outlines [text] at [size], shrunk until it fits [max_width]."""
    while size > 10:
        x0, _, x1, _ = glyph_bounds(f, text, size)
        if x1 - x0 <= max_width:
            break
        size -= 1
    return text_path(f, text, size, x=x, baseline=baseline)[0]


def banner(dark):
    """The README header: the halves slide in and meet, then the name and the lines appear. CSS
    animations run once and respect reduced motion; the last frame is the resting design."""
    w, h = 1280, 360
    bg, left, right, ink, sub = (NIGHT, PAPER, MINT, PAPER, '#A29D93') if dark else ('#FFFFFF', GREEN, MINT, INK, MUTED)
    word = fitted(WORD, TITLE, 120, w - 400 - 64, x=400, baseline=186)
    line1 = fitted(BODY, LINE, 34, w - 404 - 64, x=404, baseline=248)
    line2 = fitted(MONO, DETAIL, 24, w - 404 - 64, x=404, baseline=290)
    style = '''<style>
.l{animation:l 1.1s cubic-bezier(.2,.8,.2,1) both}
.r{animation:r 1.1s cubic-bezier(.2,.8,.2,1) both}
.t{animation:t .8s ease-out .7s both}
.s{animation:t .8s ease-out 1s both}
@keyframes l{from{transform:translateX(-70px);opacity:0}to{transform:none;opacity:1}}
@keyframes r{from{transform:translateX(70px);opacity:0}to{transform:none;opacity:1}}
@keyframes t{from{transform:translateY(12px);opacity:0}to{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){.l,.r,.t,.s{animation:none}}
</style>'''
    body = (style + f'<rect width="{w}" height="{h}" fill="{bg}"/>'
            f'<g transform="translate(96 52)"><path class="l" fill="{left}" d="{LEFT}"/><path class="r" fill="{right}" d="{RIGHT}"/></g>'
            f'<path class="t" fill="{ink}" d="{word}"/>'
            f'<path class="s" fill="{ink}" d="{line1}"/><path class="s" fill="{sub}" d="{line2}"/>')
    return svg(w, h, body)


def social():
    w, h = 1280, 640
    word = fitted(WORD, TITLE, 140, w - 430 - 60, x=430, baseline=330)
    line = fitted(BODY, LINE, 40, w - 436 - 60, x=436, baseline=400)
    feats = fitted(MONO, DETAIL, 26, w - 436 - 60, x=436, baseline=450)
    t = 'translate(150 192) translate(128 128) scale(1.15) translate(-128 -128)'
    body = (f'<rect width="{w}" height="{h}" fill="{DEEP}"/>'
            f'<g transform="{t}"><path fill="{PAPER}" d="{LEFT}"/><path fill="{MINT}" d="{RIGHT}"/></g>'
            f'<path fill="{PAPER}" d="{word}"/><path fill="{PAPER}" d="{line}"/><path fill="{MINT}" d="{feats}"/>')
    return svg(w, h, body)


def chrome():
    for path in ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', shutil.which('chromium'), shutil.which('google-chrome')]:
        if path and pathlib.Path(path).exists():
            return path
    raise SystemExit('Headless Chrome is needed for the PNG export.')


def png(svg_path, out, size):
    w, h = size
    html = BRAND / '_render.html'
    html.write_text(f'<html><body style="margin:0"><img src="{svg_path.name}" style="width:{w}px;height:{h}px;display:block"></body></html>')
    subprocess.run([chrome(), '--headless=new', '--disable-gpu', '--hide-scrollbars', f'--window-size={w},{h}',
                    f'--screenshot={out}', html.as_uri()], check=True, capture_output=True)
    html.unlink()


if __name__ == '__main__':
    (BRAND / 'banner.svg').write_text(banner(dark=False))
    (BRAND / 'banner-dark.svg').write_text(banner(dark=True))
    (BRAND / 'social-preview.svg').write_text(social())
    png(BRAND / 'social-preview.svg', BRAND / 'banner.png', (1280, 640))
    print('Brand files written to', BRAND)
