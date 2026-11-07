"""Score contiguous cell relationships, never mere words anywhere in the page."""
import re
import unicodedata
from decimal import Decimal


def normalize(value):
    value = re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(value))).casefold()
    return format(Decimal(value).normalize(), "f") if re.fullmatch(r"[+-]?\d+(?:\.\d+)?", value) else value


def grid(table):
    data = table.get("data", {})
    cells = data.get("table_cells", [])
    rows = data.get("num_rows", 0)
    cols = data.get("num_cols", 0)
    if not 0 <= rows <= 10000 or not 0 <= cols <= 1000 or rows * cols > 100000:
        raise ValueError("table grid exceeds probe limits")
    result = [[""] * cols for _ in range(rows)]
    for cell in cells:
        r0, r1 = cell["start_row_offset_idx"], cell["end_row_offset_idx"]
        c0, c1 = cell["start_col_offset_idx"], cell["end_col_offset_idx"]
        if not 0 <= r0 < r1 <= rows or not 0 <= c0 < c1 <= cols:
            raise ValueError("cell span outside table")
        for r in range(r0, r1):
            for c in range(c0, c1):
                if result[r][c]:
                    raise ValueError("overlapping nonempty cells")
                result[r][c] = cell.get("text", "")
    return result


def score_rows(case, tables):
    headers = [normalize(v) for v in case.get("headers", [])]
    rows = []
    for table in tables:
        columns = []
        for row in table:
            if not headers:
                rows.extend(row[i:] for i in range(len(row)))
                continue
            keys = [normalize(v) for v in row]
            if all(key in keys for key in headers):
                fields = [(i, key) for i, key in enumerate(keys) if key in headers]
                columns = []
                for start in range(0, len(fields), len(headers)):
                    group = {key: i for i, key in fields[start:start + len(headers)]}
                    if set(group) == set(headers):
                        columns.append([group[key] for key in headers])
            else:
                rows.extend([row[i] if i < len(row) else "" for i in group] for group in columns)
    hits, missing, observed = [], [], []
    for expected in case["expected"]:
        needle = [normalize(v) for v in expected]
        matches = [row[:len(needle)] for row in rows if row and normalize(row[0]) == needle[0]]
        match = len(matches) == 1 and [normalize(v) for v in matches[0]] == needle
        (hits if match else missing).append(expected)
        if not match:
            observed.append({"expected": expected, "recognized": matches})
    return {"tableCount": len(tables), "expectedRecords": len(case["expected"]), "correctRecords": len(hits), "recordAccuracy": len(hits) / len(case["expected"]), "missing": missing, "mismatches": observed, "pass": not missing}


def score(case, document):
    return score_rows(case, [grid(t) for t in document.get("tables", [])])


def markdown_tables(markdown):
    from bs4 import BeautifulSoup

    tables, group = [], []
    for line in markdown.splitlines() + [""]:
        if line.strip().startswith("|"):
            cells = [v.strip() for v in re.split(r"(?<!\\)\|", line.strip()[1:].rstrip("|"))]
            if not all(re.fullmatch(r":?-+:?", v) for v in cells):
                group.append(cells)
        elif group:
            tables.append(group)
            group = []
    for table in BeautifulSoup(markdown, "html.parser").find_all("table"):
        rows = []
        pending = {}
        for r, row in enumerate(table.find_all("tr")):
            cells = {c: value for (r0, c), value in pending.items() if r0 == r}
            c = 0
            for cell in row.find_all(["td", "th"], recursive=False):
                while c in cells:
                    c += 1
                value = cell.get_text(" ", strip=True)
                width = min(100, int(cell.get("colspan", 1)))
                height = min(100, int(cell.get("rowspan", 1)))
                for j in range(c, c + width):
                    cells[j] = value
                    for i in range(r + 1, r + height):
                        pending[i, j] = value
                c += width
            rows.append([cells.get(c, "") for c in range(max(cells, default=-1) + 1)])
        tables.append(rows)
    return tables
