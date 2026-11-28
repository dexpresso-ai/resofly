"""Proef 1B-1 (bouwplan pagina's, §9): letters en emoji in een PDF via LibreOffice.

Maakt drie Word-bestanden en de letters als TTF, om te zien wat LibreOffice (en
dus Collabora, dezelfde motor) met onze huisstijlletters en met emoji doet:

  a-zonder-letter.docx  vraagt Poppins en DM Sans vet, zonder ze mee te geven;
  d-ingesloten.docx     dezelfde tekst, met de letters als TTF in de DOCX
                        (ECMA-376 deel 1, 17.8.1: versleuteld met de fontKey);
  e-emoji.docx          emoji en tekens, in de standaardletter en in Poppins;
  poppins-400.ttf, dm-sans-700.ttf  om te installeren (proef c).

Gebruik (Python 3 met fonttools: pip install fonttools):

  python3 scripts/proef-letters-docx.py <uitmap> public/fonts/pdf
  soffice --headless --convert-to pdf --outdir <uitmap> <uitmap>/a-zonder-letter.docx
  pdffonts <uitmap>/a-zonder-letter.pdf

De uitkomst van 28 november 2026 staat in
docs/rapporten/PROEF_1B1_LETTERS_EMOJI_2026-11-28.md.
"""
import io
import sys
import uuid
import zipfile

from fontTools.ttLib import TTFont

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

TEKST = 'Huisstijl: Pagina 12 — € 1.234,56 · café, naïef'
EMOJI = 'Emoji: 😀 ✅ ❤️ 👍🏽 🇳🇱 · tekens: ✓ ☐ ☒ → •'


def woff_to_ttf(path):
    """LibreOffice gebruikt geen .woff, ook niet als fontconfig hem kent (proef b)."""
    font = TTFont(path)
    font.flavor = None
    buffer = io.BytesIO()
    font.save(buffer)
    return buffer.getvalue()


def obfuscate(data, key):
    """De eerste 32 bytes XOR met de bytes van de GUID, achterstevoren (17.8.1)."""
    guid = bytes.fromhex(key.strip('{}').replace('-', ''))
    out = bytearray(data)
    for i in range(32):
        out[i] ^= guid[15 - (i % 16)]
    return bytes(out)


def para(text, font=None, bold=False):
    props = ''
    if font:
        props += f'<w:rFonts w:ascii="{font}" w:hAnsi="{font}" w:cs="{font}"/>'
    if bold:
        props += '<w:b/>'
    props = f'<w:rPr>{props}</w:rPr>' if props else ''
    return f'<w:p><w:r>{props}<w:t xml:space="preserve">{text}</w:t></w:r></w:p>'


def docx(path, body, embed=()):
    files = {
        '[Content_Types].xml': HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/>'
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>'
        '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
        '</Types>',
        '_rels/.rels': HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
        '</Relationships>',
        'word/_rels/document.xml.rels': HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        f'<Relationship Id="rId1" Type="{R}/fontTable" Target="fontTable.xml"/>'
        f'<Relationship Id="rId2" Type="{R}/settings" Target="settings.xml"/></Relationships>',
        'word/settings.xml': HEAD + f'<w:settings xmlns:w="{W}">' + ('<w:embedTrueTypeFonts/>' if embed else '') + '</w:settings>',
        'word/document.xml': HEAD + f'<w:document xmlns:w="{W}" xmlns:r="{R}"><w:body>{body}<w:sectPr/></w:body></w:document>',
    }
    fonts, rels = '', ''
    for i, (family, style, ttf) in enumerate(embed, start=1):
        key = '{' + str(uuid.UUID(int=0x0123456789ABCDEF0123456789ABCDEF + i)).upper() + '}'
        files[f'word/fonts/font{i}.odttf'] = obfuscate(ttf, key)
        fonts += f'<w:font w:name="{family}"><w:embed{style} r:id="rId{i}" w:fontKey="{key}"/></w:font>'
        rels += f'<Relationship Id="rId{i}" Type="{R}/font" Target="fonts/font{i}.odttf"/>'
    if rels:
        files['word/_rels/fontTable.xml.rels'] = HEAD + f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{rels}</Relationships>'
    files['word/fontTable.xml'] = HEAD + f'<w:fonts xmlns:w="{W}" xmlns:r="{R}">{fonts}</w:fonts>'
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            archive.writestr(name, data)


def main():
    out, fonts = sys.argv[1], sys.argv[2]
    poppins = woff_to_ttf(f'{fonts}/poppins-400.woff')
    dm_bold = woff_to_ttf(f'{fonts}/dm-sans-700.woff')
    docx(f'{out}/a-zonder-letter.docx', para(TEKST, 'Poppins') + para(TEKST, 'DM Sans', True))
    docx(f'{out}/d-ingesloten.docx', para(TEKST, 'Poppins') + para(TEKST, 'DM Sans', True),
         embed=[('Poppins', 'Regular', poppins), ('DM Sans', 'Bold', dm_bold)])
    docx(f'{out}/e-emoji.docx', para(EMOJI) + para(EMOJI, 'Poppins'))
    open(f'{out}/poppins-400.ttf', 'wb').write(poppins)
    open(f'{out}/dm-sans-700.ttf', 'wb').write(dm_bold)


if __name__ == '__main__':
    main()
