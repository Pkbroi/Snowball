"""Keep only the ligatures for the icons in <icons.txt>, drop the rest.

Usage: python3 scripts/filter-font-ligatures.py <in.woff2> <out.woff2> <icons.txt>

Why: pyftsubset prunes a LigatureSubst by its first glyph only, and the
first glyphs are just letters shared by thousands of icon names — so a
--glyphs subset keeps all ~3772 ligatures (and their ~3500 icon glyphs)
even when only 22 icons were asked for. Filtering the GSUB first leaves
exactly the wanted ligatures, so the following --glyphs pass can drop
every other glyph.
"""
import sys
from fontTools.ttLib import TTFont


def main():
    in_path, out_path, icons_path = sys.argv[1], sys.argv[2], sys.argv[3]
    icons = {l.strip() for l in open(icons_path, encoding='utf-8') if l.strip()}
    font = TTFont(in_path)
    kept_total = 0
    for lookup in font['GSUB'].table.LookupList.Lookup:
        for sub in lookup.SubTable:
            subs = [sub.ExtSubTable] if hasattr(sub, 'ExtSubTable') else [sub]
            for s in subs:
                if not hasattr(s, 'ligatures'):
                    continue
                for first in list(s.ligatures.keys()):
                    kept = [
                        lig for lig in s.ligatures[first]
                        if (first + ''.join(lig.Component)).replace('underscore', '_').lower() in icons
                    ]
                    kept_total += len(kept)
                    if kept:
                        s.ligatures[first] = kept
                    else:
                        del s.ligatures[first]
    font.save(out_path)
    print(f'filter-font-ligatures: kept {kept_total} ligatures for {len(icons)} icons')


if __name__ == '__main__':
    sys.exit(main())
