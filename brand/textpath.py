"""Turn text into SVG path data with fontTools (outlined, no live <text>)."""
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.varLib import instancer

FONTS = str(__import__('pathlib').Path(__file__).resolve().parent / 'fonts') + '/'
_cache = {}

def font(name, **axes):
    key = (name, tuple(sorted(axes.items())))
    if key not in _cache:
        f = TTFont(FONTS + name)
        if axes and 'fvar' in f:
            f = instancer.instantiateVariableFont(f, axes)
        _cache[key] = f
    return _cache[key]

def text_path(f, text, size, x=0, baseline=0, tracking=0.0, kern=True):
    """Returns (d, width). tracking in em units fraction."""
    gs = f.getGlyphSet(); cmap = f.getBestCmap(); upem = f['head'].unitsPerEm
    scale = size / upem
    hmtx = f['hmtx']
    names = [cmap[ord(c)] for c in text]
    # simple pair kerning from GPOS is complex; use kern table if present
    pen = SVGPathPen(gs)
    cursor = 0.0
    for i, n in enumerate(names):
        tp = TransformPen(pen, (scale, 0, 0, -scale, x + cursor * scale, baseline))
        gs[n].draw(tp)
        cursor += hmtx[n][0] + tracking * upem
    return pen.getCommands(), cursor * scale - tracking * upem * scale

def glyph_bounds(f, text, size):
    from fontTools.pens.boundsPen import BoundsPen
    gs = f.getGlyphSet(); cmap = f.getBestCmap(); upem = f['head'].unitsPerEm
    bp = BoundsPen(gs); cursor = 0
    for c in text:
        n = cmap[ord(c)]
        tp = TransformPen(bp, (1, 0, 0, 1, cursor, 0)); gs[n].draw(tp); cursor += f['hmtx'][n][0]
    xmin, ymin, xmax, ymax = bp.bounds
    s = size / upem
    return xmin*s, ymin*s, xmax*s, ymax*s
