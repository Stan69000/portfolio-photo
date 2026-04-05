#!/usr/bin/env python3
"""
Generate C5 envelope PDFs from a CSV file.

- One PDF per zone (column PLAN)
- First page of each PDF = Zone title
- Addresses centered horizontally
- First given name only
- Handles CSV with , or ; automatically
"""

from reportlab.pdfgen import canvas
from reportlab.lib.units import mm
import csv
from collections import defaultdict

# Path to CSV (change as needed)
CSV_PATH = "input.csv"

# C5 landscape
PAGE_WIDTH = 229 * mm
PAGE_HEIGHT = 162 * mm

# Address block
BLOCK_WIDTH = 110 * mm
MARGIN_BOTTOM = 58 * mm
LINE_SPACING = 7 * mm

START_X = (PAGE_WIDTH - BLOCK_WIDTH) / 2
TOP_OF_BLOCK_Y = MARGIN_BOTTOM + (2 * LINE_SPACING)


def read_csv_auto(path):
    with open(path, newline="", encoding="utf-8") as f:
        sample = f.read(2048)
        f.seek(0)
        dialect = csv.Sniffer().sniff(sample)
        reader = csv.DictReader(f, dialect=dialect)
        return list(reader)


rows = read_csv_auto(CSV_PATH)

if not rows:
    raise Exception("CSV is empty or could not be read.")

print("Detected columns:", rows[0].keys())
print("Total rows:", len(rows))


def safe_int(v):
    try:
        return int(v)
    except:
        return 0


rows.sort(
    key=lambda r: (
        r.get("PLAN", ""),
        r.get("libéllé", ""),
        safe_int(r.get("Numéro de voie", "")),
    )
)

zones = defaultdict(list)
for row in rows:
    zone = str(row.get("PLAN", "")).strip()
    if zone:
        zones[zone].append(row)

for zone, data in zones.items():

    pdf_name = f"C5_ZONE_{zone}.pdf"
    c = canvas.Canvas(pdf_name, pagesize=(PAGE_WIDTH, PAGE_HEIGHT))

    # zone title
    c.setFont("Helvetica-Bold", 28)
    c.drawCentredString(PAGE_WIDTH / 2, PAGE_HEIGHT / 2, f"ZONE {zone}")
    c.showPage()

    for row in data:

        c.setFont("Helvetica", 11)

        nom_naissance = row.get("Nom", "").strip().upper()
        nom_epouse = row.get("Nom d'usage", "").strip().upper()

        prenoms_brut = row.get("Prénom", "").strip()
        prenom = prenoms_brut.split()[0] if prenoms_brut else ""

        if nom_epouse and nom_epouse != nom_naissance:
            line_nom = f"{prenom} {nom_naissance} épouse {nom_epouse}"
        else:
            line_nom = f"{prenom} {nom_naissance}"

        numero = row.get("Numéro de voie", "").strip()
        street = row.get("libéllé", "").strip()
        line_street = f"{numero} {street}".strip()

        postal_code = row.get("Code postal", "").strip()
        city = row.get("Commune", "").strip()
        line_city = f"{postal_code} {city}".strip()

        y = TOP_OF_BLOCK_Y

        for line in [line_nom, line_street, line_city]:
            text_width = c.stringWidth(line, "Helvetica", 11)
            x_centered = START_X + (BLOCK_WIDTH - text_width) / 2
            c.drawString(x_centered, y, line)
            y -= LINE_SPACING

        c.showPage()

    c.save()
    print(f"Generated: {pdf_name}")
