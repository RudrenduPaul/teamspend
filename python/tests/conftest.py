import json
from pathlib import Path
from typing import Any, Callable, Dict, List

import pytest

from teamspend.http_client import HttpResponse, TransportError

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES_DIR = REPO_ROOT / "python" / "fixtures"


@pytest.fixture
def fixtures_dir() -> Path:
    return FIXTURES_DIR


def json_response(status: int, body: Any) -> HttpResponse:
    return HttpResponse(status=status, body=json.dumps(body).encode("utf-8"))


class ScriptedTransport:
    """
    A fake transport that replays a fixed sequence of responses (or raises
    TransportError), one per call, then repeats the final entry -- mirrors
    the TS test suite's `vi.fn().mockResolvedValueOnce(...).mockResolvedValue(...)`
    chaining pattern.
    """

    def __init__(self, responses: List[Any]) -> None:
        self._responses = responses
        self.call_count = 0
        self.calls: List[Dict[str, Any]] = []

    def __call__(self, url: str, headers: Dict[str, str], timeout: float) -> HttpResponse:
        index = min(self.call_count, len(self._responses) - 1)
        entry = self._responses[index]
        self.call_count += 1
        self.calls.append({"url": url, "headers": headers, "timeout": timeout})
        if isinstance(entry, Exception):
            raise entry
        return entry


@pytest.fixture
def no_sleep() -> Callable[[float], None]:
    def _sleep(_seconds: float) -> None:
        return None

    return _sleep
