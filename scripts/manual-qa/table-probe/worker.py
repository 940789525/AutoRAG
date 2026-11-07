"""T1-only JSONL worker. Stdout is the protocol; diagnostics stay on stderr."""
import contextlib
import json
from pathlib import Path
import sys
import traceback

MAX_REQUEST = 8192
MAX_REPLY = 4 * 1024 * 1024


def worker(root, mode, wire):
    from docling.datamodel.accelerator_options import AcceleratorOptions
    from docling.datamodel.backend_options import ThreadedDoclingParseBackendOptions
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions, TableFormerMode, TableStructureOptions
    from docling.document_converter import DocumentConverter, ImageFormatOption, PdfFormatOption

    root = Path(root).resolve()
    models = root / "models"
    fixtures = root / "fixtures"
    converter = {}

    def convert(file, ocr):
        # Both formats share the same models and pipeline options within a run.
        if ocr not in converter:
            model_dir = models / "rapidocr"
            needed = [models / "docling-project--docling-layout-heron/model.safetensors", models / f"docling-project--docling-models/model_artifacts/tableformer/{mode}/tm_config.json"]
            if ocr:
                needed.extend(model_dir / name for name in ("PP-OCRv6_det_small.onnx", "ch_ppocr_mobile_v2.0_cls_mobile.onnx", "PP-OCRv6_rec_small.onnx"))
            for artifact in needed:
                if not artifact.is_file():
                    raise FileNotFoundError(f"Missing prepared model: {artifact}")
            options = PdfPipelineOptions(
                artifacts_path=models,
                accelerator_options=AcceleratorOptions(device="cpu", num_threads=4),
                queue_max_size=1, ocr_batch_size=1, layout_batch_size=1, table_batch_size=1,
                document_timeout=110,
                do_ocr=ocr, do_table_structure=True,
                do_picture_description=False, do_picture_classification=False,
                do_code_enrichment=False, do_formula_enrichment=False, do_chart_extraction=False,
                enable_remote_services=False, allow_external_plugins=False,
                table_structure_options=TableStructureOptions(mode=TableFormerMode(mode)),
                ocr_options=RapidOcrOptions(
                    lang=["ch"], backend="onnxruntime", model_size="small",
                    det_model_path=str(model_dir / "PP-OCRv6_det_small.onnx"),
                    cls_model_path=str(model_dir / "ch_ppocr_mobile_v2.0_cls_mobile.onnx"),
                    rec_model_path=str(model_dir / "PP-OCRv6_rec_small.onnx"),
                    rapidocr_params={"EngineConfig.onnxruntime.intra_op_num_threads": 4, "EngineConfig.onnxruntime.inter_op_num_threads": 1},
                ),
            )
            converter[ocr] = DocumentConverter(format_options={
                InputFormat.PDF: PdfFormatOption(pipeline_options=options, backend_options=ThreadedDoclingParseBackendOptions(parser_threads=1, max_concurrent_results=1)),
                InputFormat.IMAGE: ImageFormatOption(pipeline_options=options),
            })
        result = converter[ocr].convert(file, raises_on_error=False)
        return {
            "status": result.status.value,
            "document": result.document.export_to_dict(),
            "pages": len(result.pages) or 1,
            "diagnostics": [item.model_dump(mode="json") for item in result.errors],
        }

    while line := sys.stdin.buffer.readline(MAX_REQUEST + 1):
        request_id = None
        try:
            if len(line) > MAX_REQUEST or not line.endswith(b"\n"):
                raise ValueError("invalid JSONL request length or terminator")
            request = json.loads(line)
            request_id = request.get("id")
            if set(request) != {"v", "id", "file", "ocr"} or request["v"] != 1 or not isinstance(request_id, str) or type(request["ocr"]) is not bool:
                raise ValueError("invalid v1 request")
            file = (fixtures / request["file"]).resolve(strict=True)
            if not file.is_relative_to(fixtures) or file.suffix not in {".pdf", ".png", ".jpg", ".webp", ".docx", ".xlsx"}:
                raise ValueError("file is outside the synthetic fixture scope")
            with contextlib.redirect_stdout(sys.stderr):
                reply = {"v": 1, "id": request_id, "ok": True, **convert(file, request["ocr"])}
            data = json.dumps(reply, ensure_ascii=False).encode() + b"\n"
            if len(data) > MAX_REPLY:
                raise ValueError("Docling JSON exceeds the 4 MiB reply limit")
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            data = json.dumps({"v": 1, "id": request_id, "ok": False, "error": str(error)}).encode() + b"\n"
        wire.write(data)
        wire.flush()


if __name__ == "__main__":
    # Imports in some upstream packages print startup notices. Keep the wire clean.
    protocol_stdout = sys.stdout.buffer
    sys.stdout = sys.stderr
    worker(sys.argv[1], sys.argv[2], protocol_stdout)
