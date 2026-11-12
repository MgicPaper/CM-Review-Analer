import asyncio
import json
import os
from contextlib import chdir
from functools import partial
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import httpx2
import was
from pydantic import ValidationError
from typesafe_sdk import AsyncTypeSafeClient
from was.config import Settings


PAYLOAD = {
    "product_id": "sample-product",
    "reviews": [
        {"rating": 5, "text": "보관하기 편해요.", "date": "2026-11-01"},
        {"rating": 2, "text": "뚜껑이 헐거워서 용기를 기울이면 내용물이 새요."},
        {"rating": 1, "text": "배송 중 외부 상자가 찢어졌어요."},
    ],
    "history": [{"rating": 5, "text": "sample author history"}],
}
SAMPLE = {
    "sort": "latest",
    "rating_filter": None,
    "reviews": [
        {"review_id": str(index), "rating": 5, "written_at": "2026-11-12"}
        for index in range(10)
    ],
}
calls = []
upstream_status = 200
omit_answer = False


def mock_jev(request):
    assert request.method == "POST"
    assert str(request.url) == "https://api.typesafe.ai/v1/systemone"
    assert request.headers["Authorization"] == "Bearer local-test-key"
    data = json.loads(request.content)
    assert data["model"] == "jev-1.14.0"
    assert data["state"] == {"reviews": {"review_1": PAYLOAD["reviews"][1]["text"], "review_2": PAYLOAD["reviews"][2]["text"]}}
    assert set(data["questions"]) == {
        "review_1_has_product_issue", "review_1_issue_scope",
        "review_2_has_product_issue", "review_2_issue_scope",
    }
    assert data["questions"]["review_1_has_product_issue"]["type"] == "noul"
    assert data["questions"]["review_2_issue_scope"]["type"] == "choice"
    calls.append(data)
    if upstream_status != 200:
        return httpx2.Response(upstream_status, json={"detail": "simulated error"})
    answers = {
        "review_1_has_product_issue": {"type": "noul", "noul": 0.97},
        "review_1_issue_scope": {
            "type": "choice", "choice": "product", "confidence": 0.9,
            "probabilities": {"product": 0.96, "delivery": 0.04},
        },
        "review_2_has_product_issue": {"type": "noul", "noul": 0.02},
        "review_2_issue_scope": {
            "type": "choice", "choice": "delivery", "confidence": 0.95,
            "probabilities": {"product": 0.02, "delivery": 0.98},
        },
    }
    if omit_answer:
        answers.pop("review_2_issue_scope")
    return httpx2.Response(200, json={
        "model": "jev-1.14.0", "answers": answers,
        "usage": {"input_tokens": 183, "output_tokens": 12},
    })


def create_mock_client(**options):
    return AsyncTypeSafeClient(**options, compression=False, transport=httpx2.MockTransport(mock_jev))


async def check():
    global upstream_status, omit_answer
    async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=was.app), base_url="http://testserver") as client:
        os.environ.pop("TYPESAFE_API_KEY", None)
        async with was.app.router.lifespan_context(was.app):
            assert (await client.get("/health")).json() == {"ok": True, "jev_configured": False}
            assert (await client.post("/v1/reviews/analyze", json=PAYLOAD)).status_code == 503
            positive_only = {"product_id": PAYLOAD["product_id"], "reviews": PAYLOAD["reviews"][:1]}
            skipped = await client.post("/v1/reviews/analyze", json=positive_only)
            assert skipped.status_code == 200
            assert skipped.json()["usage"] is None
            sample_only = await client.post("/v1/reviews/analyze", json={
                "product_id": PAYLOAD["product_id"], "reviews": [], "review_sample": SAMPLE,
            })
            assert sample_only.status_code == 200
            assert sample_only.json() == {
                "product_id": "sample-product", "review_count": 0, "low_rating_count": 0,
                "review_sample_count": 10, "model": None, "usage": None, "judgments": [],
            }
            empty = await client.post("/v1/reviews/analyze", json={
                "product_id": PAYLOAD["product_id"], "reviews": [],
            })
            assert empty.status_code == 422
            assert not calls
        with patch.dict(os.environ, {"TYPESAFE_API_KEY": "local-test-key"}), patch.object(was, "AsyncTypeSafeClient", create_mock_client):
            async with was.app.router.lifespan_context(was.app):
                assert (await client.get("/health")).json() == {"ok": True, "jev_configured": True}
                result = await client.post("/v1/reviews/analyze", json=PAYLOAD)
                assert result.status_code == 200, result.text
                assert result.json() == {
                    "product_id": "sample-product", "review_count": 3, "low_rating_count": 2,
                    "model": "jev-1.14.0", "usage": {"input_tokens": 183, "output_tokens": 12},
                    "judgments": [
                        {"review_index": 1, "product_issue_probability": 0.97, "issue_scope": "product", "issue_scope_confidence": 0.9},
                        {"review_index": 2, "product_issue_probability": 0.02, "issue_scope": "delivery", "issue_scope_confidence": 0.95},
                    ],
                }
                assert len(calls) == 1
                enriched = {
                    **PAYLOAD,
                    "reviews": [dict(review) for review in PAYLOAD["reviews"]],
                    "review_sample": SAMPLE,
                }
                enriched["reviews"][1].update({
                    "review_id": "review-101", "written_at": "2026-11-11",
                    "reviewer_id": "public-profile-4", "vendor_item_id": "2001",
                    "seller": "sample seller", "option": "sample option", "is_sponsored": False,
                })
                identified = await client.post("/v1/reviews/analyze", json=enriched)
                assert identified.status_code == 200, identified.text
                assert identified.json()["judgments"][0]["review_id"] == "review-101"
                assert identified.json()["review_sample_count"] == 10
                enriched["reviews"][1]["written_at"] = "2026-02-30"
                invalid_date = await client.post("/v1/reviews/analyze", json=enriched)
                assert invalid_date.status_code == 422
                for upstream_status, expected in [(401, 502), (429, 503), (500, 502)]:
                    failed = await client.post("/v1/reviews/analyze", json=PAYLOAD)
                    assert failed.status_code == expected, failed.text
                upstream_status = 200
                omit_answer = True
                incomplete = await client.post("/v1/reviews/analyze", json=PAYLOAD)
                assert incomplete.status_code == 502, incomplete.text
                invalid = await client.post("/v1/reviews/analyze", json={
                    "product_id": "test", "reviews": [{"rating": 6, "text": "review"}],
                })
                assert invalid.status_code == 422
                assert len(calls) == 6


def check_settings():
    defaults = Settings(_env_file=None)
    assert (defaults.host, defaults.port, defaults.jev_model) == ("127.0.0.1", 8765, "jev-1.14.0")
    assert defaults.jev_api_key is None

    with TemporaryDirectory() as directory, chdir(directory):
        Path(".env").write_text(
            "WAS_HOST=0.0.0.0\nWAS_PORT=9875\nTYPESAFE_API_KEY=file-test-key\n"
            "JEV_TIMEOUT_SECONDS=2.5\nJEV_MAX_RETRIES=1\n",
            encoding="utf-8-sig",
        )
        settings = Settings()
        assert (settings.host, settings.port) == ("0.0.0.0", 9875)
        assert settings.jev_api_key is not None
        assert settings.jev_api_key.get_secret_value() == "file-test-key"
        assert "file-test-key" not in repr(settings)
        assert (settings.jev_timeout_seconds, settings.jev_max_retries) == (2.5, 1)

        with patch.dict(os.environ, {"WAS_PORT": "9876", "TYPESAFE_API_KEY": "  "}):
            assert Settings().jev_api_key is None
            with patch.object(was.uvicorn, "run") as run:
                was.main()
                run.assert_called_once_with("was:app", host="0.0.0.0", port=9876)

        with patch.dict(os.environ, {"WAS_PORT": "65536"}):
            try:
                Settings()
            except ValidationError as error:
                assert error.errors()[0]["loc"] == ("WAS_PORT",)
            else:
                raise AssertionError("An invalid WAS port was accepted")


with patch.dict(os.environ):
    for key in (
        "WAS_HOST", "WAS_PORT", "TYPESAFE_API_KEY",
        "JEV_MODEL", "JEV_TIMEOUT_SECONDS", "JEV_MAX_RETRIES",
    ):
        os.environ.pop(key, None)
    check_settings()
    with patch.object(was, "Settings", partial(Settings, _env_file=None)):
        asyncio.run(check())
print("PASS: configuration, batched SDK request, token usage, absent key, upstream errors, metadata samples, review ID mapping, and input validation")
