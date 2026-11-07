import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[2] / "scripts/manual-qa/table-probe/evaluate.py"
spec = importlib.util.spec_from_file_location("evaluate", path)
evaluate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluate)


def table(rows):
    return {"data": {"num_rows": len(rows), "num_cols": len(rows[0]), "table_cells": [
        {"text": text, "start_row_offset_idx": r, "end_row_offset_idx": r + 1, "start_col_offset_idx": c, "end_col_offset_idx": c + 1}
        for r, row in enumerate(rows) for c, text in enumerate(row)]}}


class TableScoring(unittest.TestCase):
    def test_same_words_in_different_records_are_not_a_match(self):
        case = {"expected": [["体育一", "秋季", "88", "1.0"]]}
        result = evaluate.score(case, {"tables": [table([["体育一", "秋季", "77", "1.0"], ["历史", "春季", "88", "1.0"]])]})
        self.assertFalse(result["pass"])

    def test_independent_side_by_side_records_are_not_cross_joined(self):
        case = {"expected": [["PE Alpha", "Autumn", "88", "1.0"]]}
        self.assertFalse(evaluate.score(case, {"tables": [table([["PE Alpha", "Autumn", "77", "1.0", "History", "Spring", "88", "1.0"]])]})["pass"])

    def test_correct_grid_and_whitespace(self):
        case = {"expected": [["体育一", "秋季", "88", "1.0"]]}
        self.assertTrue(evaluate.score(case, {"tables": [table([["体 育 一", "秋季", "88", "1.0"]])]})["pass"])

    def test_text_without_table_never_passes(self):
        self.assertFalse(evaluate.score({"expected": [["PE", "Fall", "88", "1.0"]]}, {"text": "PE Fall 88 1.0"})["pass"])

    def test_invalid_cell_span_fails(self):
        t = table([["a"]])
        t["data"]["table_cells"][0]["end_col_offset_idx"] = 2
        with self.assertRaisesRegex(ValueError, "span"):
            evaluate.grid(t)

    def test_headers_allow_reordered_columns_but_not_inconsistent_rows(self):
        case = {"headers": ["课程", "学期", "成绩", "学分"], "expected": [["体育一", "秋季", "88", "1.0"]]}
        header = ["学期", "成绩", "学分", "课程"]
        good = table([header, ["秋季", "88", "1", "体育一"]])
        bad = table([header, ["秋季", "88", "体育一", "1"]])
        self.assertTrue(evaluate.score(case, {"tables": [good]})["pass"])
        self.assertFalse(evaluate.score(case, {"tables": [bad]})["pass"])


if __name__ == "__main__":
    unittest.main()
