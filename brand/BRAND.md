# parley-api brand

parley-api uses Parley's brand as it is: the same mark, palette and typeface. The source of truth
is [Parley's BRAND.md](https://github.com/abiodunosagie/parley/blob/main/brand/BRAND.md).

| File | What it is |
| --- | --- |
| `banner.svg`, `banner-dark.svg` | animated README header (still under reduced motion) |
| `banner.png` | social preview, 1280 x 640 |
| `social-preview.svg` | the social preview's source |

Rebuild with `python3 brand/generate.py` (needs fontTools, and Chrome for the PNG). Text is
outlined from `brand/fonts` (Bricolage Grotesque, SIL Open Font License).
