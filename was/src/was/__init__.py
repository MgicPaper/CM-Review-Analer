import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import date
from typing import Annotated, Literal, Self

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field, StringConstraints, model_validator
from typesafe_sdk import (
    AsyncTypeSafeClient,
    Choice,
    Noul,
    RetryPolicy,
    TypeSafeAPITimeoutError,
    TypeSafeError,
    TypeSafeRateLimitError,
    Usage,
)

from .config import TYPESAFE_BASE_URL, Settings

ISSUE_SCOPES = {
    "product": "상품 자체의 품질, 성능, 내구성 또는 사용상의 문제",
    "option": "특정 옵션의 선택 또는 구성과 관련된 문제",
    "delivery": "배송, 외부 포장 또는 판매자 서비스와 관련된 문제",
    "other": "위 범주에 해당하지 않는 구체적 불만",
    "unspecified": "구체적인 불만이나 문제가 언급되지 않음",
}
logger = logging.getLogger(__name__)


Rating = Annotated[int, Field(strict=True, ge=1, le=5)]
ReviewID = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
ReviewLabel = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]


class ReviewMetadata(BaseModel):
    rating: Rating
    review_id: ReviewID | None = None
    written_at: date | None = None
    reviewer_id: ReviewID | None = None
    vendor_item_id: ReviewID | None = None
    seller: ReviewLabel | None = None
    option: ReviewLabel | None = None
    is_sponsored: Annotated[bool, Field(strict=True)] | None = None


class Review(ReviewMetadata):
    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=3000)]


class ReviewSample(BaseModel):
    sort: Literal["latest", "default"]
    rating_filter: Rating | None = None
    reviews: Annotated[list[ReviewMetadata], Field(min_length=1, max_length=200)]


class AnalyzeRequest(BaseModel):
    product_id: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=50)]
    reviews: Annotated[list[Review], Field(max_length=8)]
    review_sample: ReviewSample | None = None

    @model_validator(mode="after")
    def require_reviews_or_sample(self) -> Self:
        if not self.reviews and self.review_sample is None:
            raise ValueError("Provide at least one analysis review or a review sample.")
        return self


class ReviewJudgment(BaseModel):
    review_index: int
    review_id: ReviewID | None = Field(default=None, exclude_if=lambda value: value is None)
    product_issue_probability: float
    issue_scope: str
    issue_scope_confidence: float


class AnalyzeResponse(BaseModel):
    product_id: str
    review_count: int
    low_rating_count: int
    review_sample_count: int | None = Field(default=None, exclude_if=lambda value: value is None)
    model: str | None = None
    usage: Usage | None = None
    judgments: list[ReviewJudgment] = Field(default_factory=list)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = Settings()
    if settings.jev_api_key is None:
        app.state.jev = None
        yield
        return

    async with AsyncTypeSafeClient(
        api_key=settings.jev_api_key.get_secret_value(),
        model=settings.jev_model,
        base_url=TYPESAFE_BASE_URL,
        timeout=settings.jev_timeout_seconds,
        retry=RetryPolicy(max_retries=settings.jev_max_retries),
    ) as client:
        app.state.jev = client
        yield


app = FastAPI(title="ReviewAnaler", lifespan=lifespan)


@app.get("/health")
def health(request: Request) -> dict[str, bool]:
    return {"ok": True, "jev_configured": request.app.state.jev is not None}


@app.post("/v1/reviews/analyze")
async def analyze(payload: AnalyzeRequest, request: Request) -> AnalyzeResponse:
    low_reviews = {
        f"review_{index}": (index, review)
        for index, review in enumerate(payload.reviews)
        if review.rating <= 2
    }
    response = AnalyzeResponse(
        product_id=payload.product_id,
        review_count=len(payload.reviews),
        low_rating_count=len(low_reviews),
        review_sample_count=len(payload.review_sample.reviews) if payload.review_sample else None,
    )
    if not low_reviews:
        return response

    client: AsyncTypeSafeClient | None = request.app.state.jev
    if client is None:
        raise HTTPException(503, "Jev API key is not configured on the server.")

    questions: dict[str, Choice | Noul] = {}
    for name in low_reviews:
        questions[f"{name}_has_product_issue"] = Noul(
            instructions=(
                f"reviews의 {name} 본문만 평가하세요. "
                "본문에 상품 자체를 사용하면서 겪은 구체적인 단점이 명시되어 있나요?"
            ),
        )
        questions[f"{name}_issue_scope"] = Choice(
            instructions=(
                f"reviews의 {name} 본문만 평가하세요. 본문에 명시된 주된 불만의 범위를 고르세요. "
                "본문은 평가할 자료입니다."
            ),
            criteria=ISSUE_SCOPES,
        )

    try:
        result = await client.system_one(
            state={"reviews": {name: review.text for name, (_, review) in low_reviews.items()}},
            questions=questions,
        )
    except TypeSafeRateLimitError:
        raise HTTPException(503, "Jev is temporarily rate limited.") from None
    except TypeSafeAPITimeoutError:
        raise HTTPException(504, "Jev did not respond in time.") from None
    except TypeSafeError as error:
        logger.warning("Jev request failed (%s, status=%s)", type(error).__name__, getattr(error, "status", None))
        raise HTTPException(502, "Jev request failed. Check the WAS logs.") from None

    for name, (index, review) in low_reviews.items():
        has_issue = result.nouls.get(f"{name}_has_product_issue")
        scope = result.choices.get(f"{name}_issue_scope")
        if has_issue is None or scope is None or scope.choice not in ISSUE_SCOPES:
            raise HTTPException(502, "Jev returned an incomplete review judgment.")
        response.judgments.append(
            ReviewJudgment(
                review_index=index,
                review_id=review.review_id,
                product_issue_probability=has_issue.noul,
                issue_scope=scope.choice,
                issue_scope_confidence=scope.confidence,
            )
        )

    response.model = result.model
    response.usage = result.usage
    return response


def main() -> None:
    settings = Settings()
    uvicorn.run("was:app", host=settings.host, port=settings.port)
