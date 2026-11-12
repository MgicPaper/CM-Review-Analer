export function reviewUrl(productId, page, sortBy = "ORDER_SCORE_ASC", rating = "") {
    if (!/^\d{1,50}$/.test(productId) || !Number.isInteger(page) || page < 1 || page > 10000) {
        throw new Error("상품 ID와 조회 페이지를 확인하세요.");
    }
    if (!["ORDER_SCORE_ASC", "DATE_DESC"].includes(sortBy)) {
        throw new Error("리뷰 정렬 방식을 확인하세요.");
    }
    if (!["", "1", "2"].includes(rating)) {
        throw new Error("리뷰 별점 필터를 확인하세요.");
    }
    const url = new URL("https://www.coupang.com/next-api/review");
    url.search = new URLSearchParams({
        productId, page: String(page), size: "10", sortBy,
        ratingSummary: "true", ratings: rating, market: "",
    });
    return url.href;
}

export function reviewerReviewsUrl(reviewId, vendorItemId, page = 0) {
    if (!/^\d+$/.test(reviewId) || !/^\d+$/.test(vendorItemId)
        || !Number.isInteger(page) || page < 0 || page > 10000) {
        throw new Error("작성자 상품평 요청 정보를 확인하세요.");
    }
    const url = new URL("https://www.coupang.com/next-api/review/profile/reviews");
    url.search = new URLSearchParams({ reviewId, vendorItemId, page: String(page), size: "15" });
    return url.href;
}

// Self-contained because Chrome serializes this function into the product tab.
export async function requestReviewPage(url) {
    try {
        const response = await fetch(url, {
            credentials: "include", redirect: "error",
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) return { status: response.status };
        const body = await response.json().catch(() => null);
        return { status: response.status, body };
    } catch (error) {
        return { error: error.name === "TimeoutError"
            ? "쿠팡 리뷰 요청 시간이 초과됐습니다."
            : "쿠팡 리뷰 요청에 실패했습니다. 쿠팡 탭의 접속 상태를 확인하세요." };
    }
}

export function parseReviewPage(reply, selectedRating = "") {
    if (reply?.error) throw new Error(reply.error);
    if (reply?.status !== 200) {
        throw new Error("쿠팡 리뷰 조회 HTTP " + (reply?.status ?? "알 수 없음")
            + ". 쿠팡 상품평이 정상 표시되는지 확인하세요.");
    }
    const body = reply.body;
    if (body?.rCode !== "RET0000" || !Array.isArray(body?.rData?.paging?.contents)) {
        throw new Error("쿠팡 응답을 리뷰 목록으로 해석할 수 없습니다. 응답 형식 또는 서버 오류를 확인하세요.");
    }
    const paging = body.rData.paging;
    const reviews = [];
    let skipped = 0;
    let emptyTextCount = 0;
    const seen = new Set();
    for (const [index, item] of paging.contents.entries()) {
        const rating = typeof item?.rating === "number" || typeof item?.rating === "string"
            ? Number(item.rating) : NaN;
        const content = typeof item?.content === "string" ? item.content.trim() : "";
        const title = typeof item?.title === "string" ? item.title.trim() : "";
        const text = [title, content].filter(Boolean).join("\n");
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
            skipped++;
            continue;
        }
        const id = item.reviewId == null ? null : String(item.reviewId);
        const key = id ?? (text ? rating + "\n" + text : "empty-" + index);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!text) emptyTextCount++;
        const vendorItemId = item.vendorItemId == null ? null : String(item.vendorItemId);
        reviews.push({ id, vendorItemId, key, rating, text,
            author: typeof item.displayWriter === "string" ? item.displayWriter : "",
            date: item.reviewAt == null ? "" : String(item.reviewAt),
        });
    }
    const ratingSummaries = body.rData.ratingSummaryTotal?.ratingSummaries;
    const selectedCount = Array.isArray(ratingSummaries)
        ? ratingSummaries.find(item => String(item.rating) === selectedRating)?.count : null;
    const estimatedPages = Number.isInteger(selectedCount) && selectedCount >= 0
        ? Math.ceil(selectedCount / 10) : null;
    return { reviews, skipped, emptyTextCount, received: paging.contents.length,
        totalPages: selectedRating ? estimatedPages : Number.isInteger(paging.totalPage) ? paging.totalPage : null,
        estimatedPages: Boolean(selectedRating), selectedCount: estimatedPages === null ? null : selectedCount };
}

export function parseReviewerReviews(reply, sourceProductId) {
    if (reply?.error) throw new Error(reply.error);
    if (reply?.status !== 200) throw new Error("작성자의 다른 상품평 조회 HTTP " + (reply?.status ?? "알 수 없음"));
    const data = reply.body?.rData?.profilesReviews;
    if (reply.body?.rCode !== "RET0000" || !Array.isArray(data?.content)) {
        throw new Error("작성자 상품평 응답을 해석할 수 없습니다.");
    }
    const reviews = data.content.filter(item => item?.productId != null && String(item.productId) !== sourceProductId)
        .map(item => ({
            productId: String(item.productId ?? ""),
            itemName: typeof item.itemName === "string" ? item.itemName.trim() : "",
            rating: Number.isInteger(item.rating) && item.rating >= 1 && item.rating <= 5 ? item.rating : null,
            text: [item.title, item.content].filter(value => typeof value === "string" && value.trim())
                .map(value => value.trim()).join("\n"),
            date: typeof item.createdAt === "number" ? item.createdAt : item.reviewAt,
        }));
    const metadata = data.metadata;
    return { reviews, received: data.content.length,
        page: Number.isInteger(metadata?.currentPage) ? metadata.currentPage : 0,
        totalPages: Number.isInteger(metadata?.totalPages) ? metadata.totalPages : null,
        totalElements: Number.isInteger(metadata?.totalElements) ? metadata.totalElements : null,
        isMore: data.isMore === true };
}

// Keep field names and types for schema diagnosis without copying review values.
export function describeResponseShape(value, depth = 0) {
    if (value === null) return "null";
    if (typeof value === "string") return "string (" + value.length + " chars)";
    if (typeof value !== "object") return typeof value;
    if (depth >= 4) return Array.isArray(value) ? "array" : "object";
    if (Array.isArray(value)) {
        return { type: "array", length: value.length, first: describeResponseShape(value[0], depth + 1) };
    }
    return Object.fromEntries(Object.entries(value).slice(0, 40)
        .map(([key, item]) => [key, describeResponseShape(item, depth + 1)]));
}
