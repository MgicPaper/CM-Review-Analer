import json
from contextlib import asynccontextmanager

import httpx2
import uvicorn
import was
from typesafe_sdk import AsyncTypeSafeClient

REVIEW = "뚜껑을 닫아도 물이 샙니다."


def mock_jev(request):
    payload = json.loads(request.content)
    assert payload["state"] == {"reviews": {"review_0": REVIEW}}
    assert set(payload["questions"]) == {"review_0_has_product_issue", "review_0_issue_scope"}
    return httpx2.Response(200, json={
        "model": "jev-1.14.0",
        "usage": {"input_tokens": 123, "output_tokens": 42},
        "answers": {
            "review_0_has_product_issue": {"type": "noul", "noul": 0.96},
            "review_0_issue_scope": {
                "type": "choice",
                "choice": "product",
                "confidence": 1.0,
                "probabilities": {"product": 1.0},
            },
        },
    })


@asynccontextmanager
async def mock_lifespan(app):
    async with AsyncTypeSafeClient(
        api_key="offline-test-key",
        model="jev-1.14.0",
        compression=False,
        transport=httpx2.MockTransport(mock_jev),
    ) as client:
        app.state.jev = client
        yield


was.app.router.lifespan_context = mock_lifespan
uvicorn.run(was.app, host="127.0.0.1", port=18766)

