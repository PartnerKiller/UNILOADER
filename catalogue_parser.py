#!/usr/bin/env python3
"""
Catalogue Parser - Indian & Bengali Regional CD Catalogue Number & Barcode Tokenizer
Extracts and normalizes commercial release identifiers for:
- Saregama / HMV India (CDNF, CDSV, CDPH, CDP)
- Asha Audio (CD-XXXX, ASHA CD)
- SVF / Shree Venkatesh Films (SIF-CD, SVF-CD)
- Sony DADC India (88697XXXXX2, A103XXXXXX)
- Regional EAN-13 / UPC barcodes
"""

import re

# Standard Bengali & Indian CD Catalogue Patterns
CATALOGUE_PATTERNS = [
    # Saregama / HMV India: CDNF 154020, CDSV 845210, CDPH 12040, CDP 1001
    {
        "label": "Saregama / HMV India",
        "regex": re.compile(r'(?i)\b(CDNF|CDSV|CDPH|CDP)\s*[-_./\s]?\s*([0-9]{4,7})\b'),
        "format": lambda m: f"{m.group(1).upper()} {m.group(2)}"
    },
    # SVF / Venkatesh / SIF: SIF-CD-042, SVF-CD-012, SIF CD 99
    {
        "label": "Shree Venkatesh Films (SVF)",
        "regex": re.compile(r'(?i)\b(SIF\s*[-_]?\s*CD|SVF\s*[-_]?\s*CD|SIF|SVF)\s*[-_./\s]?\s*([0-9]{2,5})\b'),
        "format": lambda m: f"SVF SIF-CD-{m.group(2).zfill(3)}"
    },
    # Asha Audio: CD-1024, ASHA CD 1088, ASHA-CD-1002
    {
        "label": "Asha Audio",
        "regex": re.compile(r'(?i)\b(ASHA\s*[-_]?\s*CD|(?:^|[^A-Za-z0-9])CD)\s*[-_./\s]?\s*([0-9]{3,5})\b'),
        "format": lambda m: f"Asha Audio CD-{m.group(2)}"
    },
    # Time Music: TCD-1020, TIME-CD-401
    {
        "label": "Time Music",
        "regex": re.compile(r'(?i)\b(TIME\s*[-_]?\s*CD|TCD)\s*[-_./\s]?\s*([0-9]{3,5})\b'),
        "format": lambda m: f"Time Music TCD-{m.group(2)}"
    },
    # Sagarika Music: SCD-501, SAGARIKA-CD-102
    {
        "label": "Sagarika Music",
        "regex": re.compile(r'(?i)\b(SAGARIKA\s*[-_]?\s*CD|SCD)\s*[-_./\s]?\s*([0-9]{3,5})\b'),
        "format": lambda m: f"Sagarika SCD-{m.group(2)}"
    },
    # Sony DADC India: 88697541202, A103XXXXXX
    {
        "label": "Sony DADC India",
        "regex": re.compile(r'(?i)\b(88[0-9]{9,11}|A103[0-9]{6,8})\b'),
        "format": lambda m: f"Sony DADC {m.group(1).upper()}"
    },
    # EAN-13 / UPC Barcodes (890 prefix for India)
    {
        "label": "EAN/UPC Barcode",
        "regex": re.compile(r'\b(890[0-9]{10}|[0-9]{12,13})\b'),
        "format": lambda m: f"Barcode {m.group(1)}"
    }
]

def parse_catalogue_number(text: str):
    """
    Scans a search string or folder name for commercial CD catalogue numbers.
    Returns dict with matched metadata or None.
    """
    if not text:
        return None

    clean = text.strip()
    # Explicit prefix: "cat:CD-1024" or "cat:CDNF 154020"
    prefix_match = re.search(r'(?i)\bcat(?:alogue)?\s*[:=]\s*([A-Za-z0-9\s\-_/]+)', clean)
    target = prefix_match.group(1).strip() if prefix_match else clean

    for entry in CATALOGUE_PATTERNS:
        m = entry["regex"].search(target)
        if m:
            normalized = entry["format"](m)
            raw_match = m.group(0)
            return {
                "detected": True,
                "label": entry["label"],
                "raw": raw_match,
                "normalized": normalized,
                "originalQuery": clean
            }

    return None

def is_catalogue_query(query: str) -> bool:
    """Returns True if query contains an identifiable catalogue number or explicit cat: prefix."""
    if not query:
        return False
    if re.search(r'(?i)\bcat(?:alogue)?\s*[:=]', query):
        return True
    return parse_catalogue_number(query) is not None

def clean_search_tokens(query: str) -> str:
    """
    Strips 'cat:' and extra punctuation for swarm querying,
    preserving essential release tokens.
    """
    if not query:
        return ""
    q = re.sub(r'(?i)\bcat(?:alogue)?\s*[:=]\s*', '', query)
    q = re.sub(r'[\(\[\{].*?[\)\]\}]', ' ', q)
    q = re.sub(r'\s+', ' ', q).strip()
    return q

if __name__ == '__main__':
    tests = [
        "Asha Audio CD-1024",
        "cat:CDNF 154020",
        "SIF-CD-042 Chirodini Tumi Je Amar",
        "Mayabono Biharini CD 1088",
        "8903242010245",
        "Bohemian Rhapsody Queen"
    ]
    for t in tests:
        res = parse_catalogue_number(t)
        print(f"Query: '{t}' -> {res['normalized'] if res else 'No Catalogue Match'}")
