# ReviewAnaler WAS

Python 3.14, FastAPI, Uvicorn과 TypeSafe Jev를 사용합니다.

## 로컬에서 실행

[TypeSafe 콘솔](https://console.typesafe.ai/keys)에서 API 키를 발급합니다. 처음 설정할 때 `.env.example`을 `.env`로 복사하고, `.env`의 `TYPESAFE_API_KEY`와 변경할 값을 입력합니다.

```powershell
cd 'C:\Users\Lenovo\Desktop\checkmate\ReviewAnaler\was'
if (-not (Test-Path -LiteralPath '.\.env')) {
    Copy-Item -LiteralPath '.\.env.example' -Destination '.\.env'
}
```

| 설정 | 기본값 | 용도 |
| --- | --- | --- |
| `WAS_HOST` | `127.0.0.1` | WAS가 수신할 IP 또는 호스트명 |
| `WAS_PORT` | `8765` | WAS 포트 |
| `TYPESAFE_API_KEY` | 비어 있음 | TypeSafe API 키 |
| `JEV_MODEL` | `jev-1.14.0` | Jev 모델 ID |
| `JEV_TIMEOUT_SECONDS` | `10` | Jev 요청 타임아웃(초) |
| `JEV_MAX_RETRIES` | `0` | Jev 호출의 최대 재시도 횟수 |

기본값은 [config.py](src/was/config.py)에 있습니다. 프로세스 환경 변수, 현재 실행 폴더의 `.env`, 코드 기본값 순으로 우선 적용합니다. 로컬에서는 `was`에서 실행하면 `was/.env`를 읽습니다. 설정을 바꾼 뒤 서버를 다시 시작합니다.

```powershell
uv run --locked was
```

[FastAPI 문서](http://127.0.0.1:8765/docs)에서 `POST /v1/reviews/analyze`의 **Try it out**을 선택하고 다음 요청을 보냅니다.

```json
{
  "product_id": "sample-product",
  "reviews": [
    {"rating": 2, "text": "뚜껑이 헐거워서 용기를 기울이면 내용물이 새요."},
    {"rating": 5, "text": "보관하기 편해요."}
  ]
}
```

최대 8개의 리뷰를 받으며, 리뷰 본문은 최대 3,000자입니다. 별점 1~2점 리뷰를 한 번의 Jev 요청으로 평가합니다. `judgments[].review_index`는 요청 배열에서 0부터 시작하는 위치입니다. 응답의 `usage`에는 Jev가 보고한 입력·출력 토큰이 들어갑니다.

선택 필드 `review_id`, `written_at`(ISO 날짜), `reviewer_id`(공개 프로필 식별자), `vendor_item_id`, `seller`, `option`, `is_sponsored`를 리뷰와 함께 보낼 수 있습니다. 확인 가능한 값만 넣습니다. WAS는 `review_id`가 있는 분석 결과에 같은 값을 반환합니다.

작성 빈도 분석에 사용할 입력은 선택 필드 `review_sample`에 분리합니다. 이 객체는 `sort`(`latest` 또는 `default`), `rating_filter`(`null`은 전체 별점), 본문 없이 메타데이터를 담는 `reviews` 1~200건으로 구성됩니다. `review_sample`이 있으면 최상위 `reviews`에 빈 배열을 보낼 수 있습니다. 이 경우 Jev 호출을 생략하고 `review_sample_count`를 반환합니다. 작성 빈도 계산은 다음 단계입니다.

`GET /health`의 `jev_configured`는 WAS에 키가 설정되어 있는지를 표시합니다. 키가 없으면 낮은 별점 리뷰의 분석 요청은 503을 반환합니다.

## 로컬 검증

`was`에서 `uv sync --locked`를 실행하면 이 폴더에 Python 3.14 가상환경 `.venv`가 생성됩니다. 다음 명령은 API 키 없이 FastAPI와 TypeSafe SDK의 요청·응답 형식과 오류 처리를 검증합니다.

```powershell
uv run --locked python .\tests\verify_jev.py
```

Chrome 확장프로그램 테스트와 검증 기록은 [프론트엔드 테스트 안내](../fe/README.md#테스트)와 [프론트엔드 테스트 기록](../fe/review.md)에 있습니다.
