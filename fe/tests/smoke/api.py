from datetime import date

from fastapi import FastAPI
from pydantic import BaseModel, Field


class Review(BaseModel):
    rating: int = Field(ge=1, le=5)
    date: date
    text: str = Field(min_length=1, max_length=10000)


class ReviewRequest(BaseModel):
    product_id: str = Field(min_length=1, max_length=50)
    reviews: list[Review] = Field(min_length=1, max_length=30)
    history: list[Review] = Field(max_length=30)


app = FastAPI()


@app.get("/health")
def health():
    return {"smoke": True}


@app.post("/v1/reviews/analyze")
def analyze(payload: ReviewRequest):
    return {
        "product_id": payload.product_id,
        "review_count": len(payload.reviews),
        "low_rating_count": sum(review.rating <= 2 for review in payload.reviews),
        "history_count": len(payload.history),
    }
