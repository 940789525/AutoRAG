"""HTTP contract tests use a deterministic engine; live ONNX evidence is separate."""
import asyncio
import importlib.util
from pathlib import Path
import threading
import unittest

import httpx
import numpy as np

spec = importlib.util.spec_from_file_location("embedding_service", Path(__file__).parents[2] / "src/embedding/service.py")
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)

class Tokenizer:
    def encode(self, text):
        return type("Encoded", (), {"ids": list(range(len(text)))})()

class Engine:
    def __init__(self):
        self.calls = []
        self.fail = False
        self.gate = None
        self.entered = threading.Event()
    def embed(self, texts, **_kwargs):
        self.calls.append(texts)
        self.entered.set()
        if self.gate:
            self.gate.wait(3)
        if self.fail:
            raise RuntimeError("fixture ONNX failure")
        return [np.ones(1024, dtype=np.float32) for _ in texts]

class ContractTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = Engine()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=service.create_app(self.engine, Tokenizer(), Path("/fixture/model"))), base_url="http://fixture")
    async def asyncTearDown(self):
        await self.client.aclose()
    async def post(self, **fields):
        return await self.client.post("/v1/embeddings", json={"model": service.MODEL_LOCK["model"], "input": ["中文", "English"], **fields})
    async def test_readiness_and_raw_inputs(self):
        health = (await self.client.get("/health")).json()
        self.assertTrue(health["ready"])
        self.assertEqual(health["prefixOwner"], "client")
        response = await self.post()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()["data"][1]["embedding"]), 1024)
        self.assertEqual(self.engine.calls, [["中文", "English"]])
    async def test_reject_model_length_empty_and_unsupported_fields(self):
        for fields in [{"model":"wrong"}, {"input":["x" * 2049]}, {"input":[""]}, {"input":[]}, {"dimensions":4}, {"encoding_format":"base64"}]:
            self.assertEqual((await self.post(**fields)).status_code, 400)
        self.assertEqual(self.engine.calls, [])
    async def test_failures_release_the_inference_slot(self):
        self.engine.fail = True
        response = await self.post()
        self.assertEqual(response.status_code, 500)
        self.assertIn("fixture ONNX failure", response.text)
        self.engine.fail = False
        self.assertEqual((await self.post()).status_code, 200)
    async def test_overload_is_bounded(self):
        self.engine.gate = threading.Event()
        task = asyncio.create_task(self.post())
        await asyncio.to_thread(self.engine.entered.wait, 3)
        response = await self.post()
        self.assertEqual(response.status_code, 429)
        self.engine.gate.set()
        self.assertEqual((await task).status_code, 200)
    async def test_body_limit(self):
        response = await self.client.post("/v1/embeddings", content=b"x" * (service.MAX_BODY_BYTES + 1))
        self.assertEqual(response.status_code, 413)

if __name__ == "__main__":
    unittest.main()
