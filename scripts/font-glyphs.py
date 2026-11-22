"""Print the exact glyph set a Material Symbols subset needs, one line.

Usage: python3 scripts/font-glyphs.py <stage-2-filtered.woff2> <icons.txt>

Takes the filtered font (after filter-font-ligatures.py), NOT the full
font: stage 1's pyftsubset pass renames the icon glyphs ('close' ->
'glyph01800'), so only the filtered font has the names stage 3 needs.
For each icon it takes the ligature's output glyph, plus the single
characters the ligatures are built from (the letters in the names and
'underscore'). That is exactly what pyftsubset --glyphs needs to keep
those ligatures and nothing else.

No '.fill' variants: FILL works through the variable axis (gvar) on the
base glyph, not through substitution — the font has no 'rvrn' feature —
and the app only ever sets FILL 0 anyway.
"""
import sys
from fontTools.ttLib import TTFont


def ligature_glyph(font, target):
    for lookup in font['GSUB'].table.LookupList.Lookup:
        for sub in lookup.SubTable:
            subs = [sub.ExtSubTable] if hasattr(sub, 'ExtSubTable') else [sub]
            for s in subs:
                if hasattr(s, 'ligatures'):
                    for first, ligset in s.ligatures.items():
                        for lig in ligset:
                            name = (first + ''.join(lig.Component)).replace('underscore', '_')
                            if name == target:
                                return lig.LigGlyph
    return None


def main():
    font = TTFont(sys.argv[1])
    icons = [l.strip() for l in open(sys.argv[2], encoding='utf-8') if l.strip()]
    glyphs = ['.notdef']
    chars = set()
    for name in icons:
        out = ligature_glyph(font, name)
        if out is None:
            print(f'font-glyphs: no ligature for icon {name!r}', file=sys.stderr)
            return 1
        glyphs.append(out)
        for ch in name:
            chars.add('underscore' if ch == '_' else ch)
    glyphs.extend(sorted(chars))
    print(','.join(glyphs))


if __name__ == '__main__':
    sys.exit(main())
