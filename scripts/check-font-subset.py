"""Verify a subsetted Material Symbols font still works as an icon font.

Usage: python3 scripts/check-font-subset.py <font.woff2> <icons.txt>

Fails (exit 1) unless:
  - the variable axes FILL and wght are retained, and
  - every icon name in <icons.txt> has a ligature substitution in the
    font's GSUB table (that substitution is what turns the word "close"
    into the close glyph — without it the app shows the raw word).
"""
import sys
from fontTools.ttLib import TTFont


def ligatures(font):
    out = set()

    def walk_sub(sub):
        if hasattr(sub, 'ExtSubTable'):
            walk_sub(sub.ExtSubTable)
            return
        if hasattr(sub, 'ligatures'):
            for first, ligset in sub.ligatures.items():
                for lig in ligset:
                    # Component glyphs are single characters — except '_',
                    # whose glyph is named 'underscore', so the raw join
                    # spells e.g. 'addunderscorecomment' for 'add_comment'.
                    # Glyph names may also be uppercased by a subsetting
                    # pass ('c' -> 'C'), so compare lowercased.
                    out.add((first + ''.join(lig.Component)).replace('underscore', '_').lower())

    for lookup in font['GSUB'].table.LookupList.Lookup:
        for sub in lookup.SubTable:
            walk_sub(sub)
    return out


def main():
    font_path, icons_path = sys.argv[1], sys.argv[2]
    font = TTFont(font_path)
    icons = [l.strip() for l in open(icons_path, encoding='utf-8') if l.strip()]

    errors = []
    axes = [a.axisTag for a in font['fvar'].axes] if 'fvar' in font else []
    if axes != ['FILL', 'wght']:
        errors.append(f'variable axes are {axes}, expected [FILL, wght]')
    if 'GSUB' not in font:
        errors.append('no GSUB table (all ligatures lost)')
        ligs = set()
    else:
        ligs = ligatures(font)
    missing = [i for i in icons if i not in ligs]
    if missing:
        errors.append(f'icons without a ligature: {", ".join(missing)}')

    if errors:
        for e in errors:
            print(f'check-font-subset: FAIL: {e}', file=sys.stderr)
        return 1
    print(f'check-font-subset: OK: {len(icons)} icons, axes {axes}, '
          f'{len(ligs)} ligatures kept')
    return 0


if __name__ == '__main__':
    sys.exit(main())
