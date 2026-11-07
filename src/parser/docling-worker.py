"""Offline Docling worker for AutoRAG's opt-in local document parser."""
import contextlib
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys
import traceback

MAX_REQUEST = 8192
MAX_REPLY = 4 * 1024 * 1024


def verify(models, ocr):
    lock = json.loads(Path(__file__).with_name("docling-models.json").read_text(encoding="utf-8"))
    for name, version in lock["packages"].items():
        actual = importlib.metadata.version(name)
        if actual != version:
            raise ValueError(f"Docling runtime package {name}: expected {version}, found {actual}")
    for relative, expected in lock["files"].items():
        if not ocr and relative.startswith("rapidocr/"):
            continue
        path = models / relative
        if not path.is_file():
            raise FileNotFoundError(f"Missing prepared model: {path}")
        with path.open("rb") as file:
            if hashlib.file_digest(file, "sha256").hexdigest() != expected:
                raise ValueError(f"Docling model SHA-256 mismatch: {path}")


def converter(models, ocr, timeout):
    from docling.datamodel.accelerator_options import AcceleratorOptions
    from docling.datamodel.backend_options import ThreadedDoclingParseBackendOptions
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions, TableFormerMode, TableStructureOptions
    from docling.document_converter import DocumentConverter, ImageFormatOption, PdfFormatOption

    rapid = models / "rapidocr"
    options = PdfPipelineOptions(
        artifacts_path=models,
        accelerator_options=AcceleratorOptions(device="cpu", num_threads=4),
        queue_max_size=1, ocr_batch_size=1, layout_batch_size=1, table_batch_size=1,
        document_timeout=timeout,
        do_ocr=ocr, do_table_structure=True,
        do_picture_description=False, do_picture_classification=False,
        do_code_enrichment=False, do_formula_enrichment=False, do_chart_extraction=False,
        enable_remote_services=False, allow_external_plugins=False,
        table_structure_options=TableStructureOptions(mode=TableFormerMode.ACCURATE),
        ocr_options=RapidOcrOptions(
            lang=["ch"], backend="onnxruntime", model_size="small",
            det_model_path=str(rapid / "PP-OCRv6_det_small.onnx"),
            cls_model_path=str(rapid / "ch_ppocr_mobile_v2.0_cls_mobile.onnx"),
            rec_model_path=str(rapid / "PP-OCRv6_rec_small.onnx"),
            rapidocr_params={"EngineConfig.onnxruntime.intra_op_num_threads": 4,
                             "EngineConfig.onnxruntime.inter_op_num_threads": 1},
        ),
    )
    return DocumentConverter(format_options={
        InputFormat.PDF: PdfFormatOption(pipeline_options=options, backend_options=ThreadedDoclingParseBackendOptions(parser_threads=1, max_concurrent_results=1)),
        InputFormat.IMAGE: ImageFormatOption(pipeline_options=options),
    })


def convert(engine, source):
    from docling_core.types.doc import TableItem, TextItem

    result = engine.convert(source, raises_on_error=False)
    diagnostics = [item.model_dump(mode="json") for item in result.errors]
    if result.status.value != "success":
        raise ValueError(f"Docling {result.status.value}: {json.dumps(diagnostics, ensure_ascii=False)}")
    doc = result.document
    blocks = []
    for item, _level in doc.iterate_items():
        if isinstance(item, TableItem):
            if item.data.num_rows == 0 or item.data.num_cols == 0:
                diagnostics.append({"message": f"Table {item.self_ref} has no grid"})
                continue
            table = item.model_dump(mode="json", include={"data", "prov"})
            table["title"] = item.caption_text(doc)
            blocks.append({"table": table})
        elif isinstance(item, TextItem):
            blocks.append({"text": item.text, "label": item.label.value})
    if not blocks:
        diagnostics.append({"message": "Docling returned no indexable text or tables"})
    return {"blocks": blocks, "diagnostics": diagnostics}


def main(wire):
    models, stage = (Path(p).resolve() for p in sys.argv[1:3])
    ocr = sys.argv[3] == "true"
    engine = None
    for line in iter(lambda: sys.stdin.buffer.readline(MAX_REQUEST + 1), b""):
        identity = None
        try:
            if len(line) > MAX_REQUEST or not line.endswith(b"\n"):
                raise ValueError("invalid Docling JSONL request length")
            message = json.loads(line)
            identity = message.get("id")
            if message.get("v") != 1 or type(identity) is not int:
                raise ValueError("invalid Docling JSONL request identity")
            filename = message["filename"]
            if Path(filename).name != filename:
                raise ValueError("invalid Docling input filename")
            source = (stage / message["file"]).resolve(strict=True)
            if source.parent != stage or source.suffix.lower() != Path(filename).suffix.lower():
                raise ValueError("Docling input is outside the task staging directory")
            if engine is None:
                verify(models, ocr)
                engine = converter(models, ocr, float(sys.argv[4]))
            reply = {"v": 1, "id": identity, "ok": True, **convert(engine, source)}
            data = json.dumps(reply, ensure_ascii=False, allow_nan=False).encode() + b"\n"
            if len(data) > MAX_REPLY:
                raise ValueError("Docling JSON exceeds the 4 MiB reply limit")
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            data = json.dumps({"v": 1, "id": identity, "ok": False, "error": str(error)}).encode() + b"\n"
        wire.write(data)
        wire.flush()


if __name__ == "__main__":
    output = sys.stdout.buffer
    with contextlib.redirect_stdout(sys.stderr):
        main(output)
