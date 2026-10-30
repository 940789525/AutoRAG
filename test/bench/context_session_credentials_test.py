"""Offline checks for the host credential broker; never reads a real login."""

import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest


SOURCE = Path(__file__).resolve().parents[2] / "scripts/bench/run-codex-session-suite.py"
SPEC = importlib.util.spec_from_file_location("codex_broker", SOURCE)
BROKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BROKER)


class CredentialTransportTests(unittest.TestCase):
    def transport(self, auth):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "auth.json"
            before = json.dumps(auth).encode()
            path.write_bytes(before)
            try:
                return BROKER.credential_payload(path)
            finally:
                self.assertEqual(path.read_bytes(), before)

    @staticmethod
    def token(expiry):
        claims = base64.urlsafe_b64encode(json.dumps({"exp": expiry}).encode()).decode().rstrip("=")
        return "synthetic." + claims + ".signature"

    def test_forwards_access_and_expiry_without_refresh_or_account_information(self):
        access = self.token(int(time.time()) + 3600)
        payload, digest = self.transport({"tokens": {
            "access_token": access,
            "refresh_token": "never-forward-refresh",
            "id_token": "never-forward-id-token",
            "account_id": "never-forward-account",
        }})
        value = json.loads(payload)
        self.assertEqual(set(value), {"access", "expiresAt", "sourceHash"})
        self.assertEqual(value["access"], access)
        self.assertEqual(value["sourceHash"], digest)
        self.assertNotIn(b"never-forward", payload)

    def test_rejects_expired_credentials_without_refresh(self):
        with self.assertRaisesRegex(ValueError, "never refreshes"):
            self.transport({"tokens": {"access_token": self.token(1)}})

    def test_rejects_missing_access(self):
        with self.assertRaisesRegex(ValueError, "no usable JWT"):
            self.transport({"tokens": {"refresh_token": "never-forward-refresh"}})


if __name__ == "__main__":
    unittest.main()
