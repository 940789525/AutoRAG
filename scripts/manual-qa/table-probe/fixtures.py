"""Reproducible, non-private document families; gold precedes OCR output."""
import hashlib
import json
from pathlib import Path


def generate(root, font):
    from PIL import Image
    import pypdfium2 as pdfium
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen.canvas import Canvas
    from docx import Document
    from openpyxl import Workbook

    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    pdfmetrics.registerFont(TTFont("ProbeCJK", str(font)))
    manifest = {"version": 2, "license": "CC0-1.0", "cases": []}
    variants = {
        "zh": (["课程", "学期", "成绩", "学分"], ["体育一", "体育二", "体育三", "体育四"], ["秋季", "春季"]),
        "en": (["Course", "Term", "Score", "Credits"], ["PE Alpha", "PE Beta", "PE Gamma", "PE Delta"], ["Autumn", "Spring"]),
        "mixed": (["课程 Course", "学期 Term", "成绩 Score", "学分 Credit"], ["体育 Alpha", "体育 Beta", "体育 Gamma", "体育 Delta"], ["秋季", "Spring"]),
    }
    designs = [
        ("zh-dual-scan", "zh", "scan", "dual", "dev"),
        ("en-dual-native", "en", "pdf", "dual", "dev"),
        ("mixed-dual-scan", "mixed", "scan", "dual-offset", "holdout"),
        ("zh-image", "zh", "png", "single", "dev"),
        ("en-image", "en", "jpg", "single", "dev"),
        ("mixed-image", "mixed", "webp", "single", "dev"),
        ("zh-office", "zh", "docx", "single", "dev"),
        ("en-sheet", "en", "xlsx", "single", "dev"),
        ("en-merged", "en", "pdf", "merged", "holdout"),
        ("zh-merged-scan", "zh", "scan", "merged", "holdout"),
        ("mixed-multipage", "mixed", "pdf", "multipage", "holdout"),
        ("en-wide", "en", "pdf", "wide", "dev"),
    ]
    for name, language, fmt, layout, split in designs:
        headers, courses, terms = variants[language]
        records = [[course, terms[i % 2], str(88 - i * 3), "1.0"] for i, course in enumerate(courses)]
        suffix = "pdf" if fmt == "scan" else fmt
        destination = root / f"{name}.{suffix}"
        rows = [records[0], ["Calculus" if language == "en" else "数学", terms[0], "91", "3.0"], records[1], records[2], ["History" if language == "en" else "历史", terms[1], "85", "2.0"], records[3]]
        if fmt == "docx":
            doc = Document()
            doc.add_heading("Synthetic course ledger", 0)
            table = doc.add_table(rows=1, cols=4)
            table.style = "Table Grid"
            for cell, value in zip(table.rows[0].cells, headers):
                cell.text = value
            for row in rows:
                for cell, value in zip(table.add_row().cells, row):
                    cell.text = value
            doc.save(destination)
        elif fmt == "xlsx":
            book = Workbook()
            sheet = book.active
            sheet.title = "Courses"
            sheet.append(headers)
            for row in rows:
                sheet.append(row)
            book.save(destination)
        else:
            native = root / f"{name}.native.pdf"
            c = Canvas(str(native), pagesize=(842, 595), invariant=1)

            def panel(x, y, data, widths, merged=False):
                height = 35
                c.setFont("ProbeCJK", 12)
                if merged:
                    c.rect(x, y, sum(widths), height)
                    c.drawString(x + 8, y + 12, "课程记录 / Course records")
                    y -= height
                for row in [headers + (["Note"] if len(widths) == 5 else [])] + data:
                    cx = x
                    for value, width in zip(row, widths):
                        if pdfmetrics.stringWidth(value, "ProbeCJK", 12) > width - 12:
                            raise ValueError(f"{name}: text overflows its cell: {value!r}")
                        c.rect(cx, y, width, height)
                        c.drawString(cx + 6, y + 12, value)
                        cx += width
                    y -= height

            c.setFont("ProbeCJK", 17)
            c.drawString(35, 555, "合成课程成绩记录 / Synthetic course ledger")
            if layout.startswith("dual"):
                widths = [126, 86, 72, 72] if language == "mixed" else [150, 86, 60, 60]
                panel(25, 460, rows[:3], widths)
                panel(445, 425 if layout == "dual-offset" else 460, rows[3:], widths)
            elif layout == "multipage":
                panel(60, 440, rows[:3], [240, 160, 100, 100])
                c.showPage()
                panel(60, 440, rows[3:], [240, 160, 100, 100])
            elif layout == "wide":
                panel(25, 440, [row + ["Approved training record"] for row in rows], [180, 125, 75, 75, 320])
            else:
                panel(60, 440, rows, [240, 160, 100, 100], layout == "merged")
            c.save()
            if fmt == "pdf":
                native.replace(destination)
            else:
                pdf = pdfium.PdfDocument(native)
                image = pdf[0].render(scale=3).to_pil().convert("RGB")
                if fmt == "scan":
                    image.save(destination, "PDF", resolution=216)
                else:
                    image.save(destination, quality=92)
                pdf.close()
                native.unlink()
        manifest["cases"].append({"id": name, "file": destination.name, "language": language, "format": fmt, "family": layout, "split": split, "core": layout.startswith("dual"), "headers": headers, "expected": records, "sha256": hashlib.sha256(destination.read_bytes()).hexdigest()})
    (root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    return manifest


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("root", type=Path)
    p.add_argument("font", type=Path)
    a = p.parse_args()
    print(json.dumps({"cases": len(generate(a.root, a.font)["cases"])}, ensure_ascii=False))
