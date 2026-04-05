# C5 Envelope Generator

Python open-source tool to generate print-ready C5 landscape envelope PDFs from CSV data (or Google Sheets export).

## Features

- Automatic CSV delimiter detection (`,` or `;`)
- Sorting by zone (`PLAN` column)
- One PDF generated per zone
- Horizontal centering of each address line
- Clean name formatting (first given name, married name handling)
- UTF-8 safe reading to prevent broken special characters

## Project structure

```text
c5-envelope-generator/
├── src/
│   └── generate_envelopes.py
├── examples/
│   └── example_input.csv
├── README.md
├── LICENSE
├── requirements.txt
└── .gitignore
```

## Requirements

- Python 3.9+
- reportlab

Install dependency:

```bash
pip install -r requirements.txt
```

## Expected CSV columns

The script expects the following columns:

- `Nom`
- `Nom d'usage`
- `Prénom`
- `Numéro de voie`
- `libéllé`
- `Code postal`
- `Commune`
- `PLAN`

## Usage

1. Put your input file at project root and name it `input.csv`.
2. Run the script:

```bash
python src/generate_envelopes.py
```

3. Generated files will follow this pattern:

- `C5_ZONE_2.pdf`
- `C5_ZONE_3.pdf`
- etc.

## Notes

- Use anonymized sample data in shared repositories.
- Real input data should not be committed (`input.csv` is ignored in `.gitignore`).
- All generated PDFs are ignored by default.

## License

MIT
