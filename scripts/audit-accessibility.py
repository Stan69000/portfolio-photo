"""Structural accessibility smoke checks on the built HTML, not a RGAA certification.
Run after npm run build: python3 scripts/audit-accessibility.py
"""
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}
class Element:
    def __init__(self, tag='', attrs=(), parent=None):
        self.tag, self.attrs, self.parent = tag, dict(attrs), parent
        self.children, self.text = [], ''
    def content(self):
        return self.text + ''.join(child.content() for child in self.children)
    def name(self):
        return self.attrs.get('aria-label') or self.content().strip() or ''.join(child.attrs.get('alt', '') for child in self.children)
class Document(HTMLParser):
    def __init__(self):
        super().__init__()
        self.root = Element()
        self.current, self.nodes = self.root, []
    def handle_starttag(self, tag, attrs):
        node = Element(tag, attrs, self.current)
        self.current.children.append(node)
        self.nodes.append(node)
        if tag not in VOID: self.current = node
    def handle_endtag(self, tag):
        node = self.current
        while node.parent:
            if node.tag == tag:
                self.current = node.parent
                return
            node = node.parent
    def handle_data(self, data):
        if self.current.tag not in {'script', 'style'}: self.current.text += data

def inspect(path):
    doc = Document()
    doc.feed(path.read_text())
    nodes = doc.nodes
    issues = []
    by_tag = lambda tag: [n for n in nodes if n.tag == tag]
    ids = Counter(n.attrs['id'] for n in nodes if 'id' in n.attrs)
    if not by_tag('html') or by_tag('html')[0].attrs.get('lang') != 'fr': issues.append('langue du document')
    if len(by_tag('main')) != 1: issues.append('zone main unique')
    if len(by_tag('h1')) != 1: issues.append('titre h1 unique')
    if not by_tag('title') or not by_tag('title')[0].content().strip(): issues.append('titre de page')
    if any(count > 1 for count in ids.values()): issues.append('identifiants dupliqués')
    if not any(n.attrs.get('href') == '#main-content' for n in by_tag('a')): issues.append('lien d’évitement')
    for n in nodes:
        if n.tag == 'img' and 'alt' not in n.attrs: issues.append('image sans alt')
        if n.tag in {'h1','h2','h3','h4','h5','h6'} and not n.content().strip(): issues.append('titre vide')
        if n.tag == 'svg' and not any(k in n.attrs for k in ['aria-hidden','aria-label','aria-labelledby']) and not any(c.tag == 'title' for c in n.children): issues.append('SVG sans nom ni masquage')
        if n.tag == 'button' and not n.name() and not n.attrs.get('aria-labelledby'): issues.append('bouton sans nom')
        if n.tag == 'iframe' and not n.attrs.get('title'): issues.append('iframe sans titre')
        if n.tag in {'input','select','textarea'} and n.attrs.get('type') not in {'hidden','submit','button'}:
            parent = n.parent
            wrapped = False
            while parent:
                wrapped |= parent.tag == 'label'
                parent = parent.parent
            if not wrapped and not n.attrs.get('aria-label') and not n.attrs.get('aria-labelledby') and not any(label.attrs.get('for') == n.attrs.get('id') for label in by_tag('label')): issues.append('champ sans étiquette')
        for attr in ['aria-controls','aria-labelledby','aria-describedby']:
            if any(value not in ids for value in n.attrs.get(attr,'').split()): issues.append(f'cible {attr} absente')
    return sorted(set(issues))

if __name__ == '__main__':
    pages = sorted((ROOT/'dist').rglob('*.html'))
    if not pages: raise SystemExit('Build absent : exécuter npm run build.')
    failures = []
    for page in pages:
        issues = inspect(page)
        if issues: failures.append({'page': str(page.relative_to(ROOT/'dist')), 'issues': issues})
    report = {'scope': 'Structure HTML générée uniquement ; contrôles clavier et visuels complémentaires requis.', 'pages': len(pages), 'failures': failures}
    (ROOT/'docs/accessibility-structure.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(bool(failures))
