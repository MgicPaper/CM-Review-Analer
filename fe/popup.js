import { parseReviewPage, parseReviewerReviews, describeResponseShape } from "./coupang.js";

const form = document.querySelector("#analysis");
const productId = document.querySelector("#product-id");
const reviewList = document.querySelector("#reviews");
const template = document.querySelector("#review-template");
const addButton = document.querySelector("#add-review");
const submitButton = document.querySelector("#submit");
const port = document.querySelector("#port");
const status = document.querySelector("#status");
const results = document.querySelector("#results");
const maxReviews = 8;
const maxTextLength = 3000;
const reviewSources = new WeakMap();
const issueScopes = {
    product: "상품 자체",
    option: "옵션",
    delivery: "배송·포장·판매자 서비스",
    other: "기타 불만",
    unspecified: "구체적 불만 미확인",
};

function showStatus(message, isError = false) {
    status.textContent = message;
    status.dataset.error = String(isError);
}

async function activeProduct() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url || tab.id === undefined) return null;

    const url = new URL(tab.url);
    if (url.origin !== "https://www.coupang.com") return null;

    const match = /^\/vp\/products\/(\d+)\/?$/.exec(url.pathname);
    return match ? { tabId: tab.id, id: match[1] } : null;
}

async function importSelection(textArea) {
    try {
        const product = await activeProduct();
        if (!product) {
            showStatus("쿠팡 상품 탭에서 본문을 선택하거나 직접 붙여넣으세요.", true);
            return;
        }
        const [selection] = await chrome.scripting.executeScript({
            target: { tabId: product.tabId },
            func: () => window.getSelection()?.toString().trim() ?? "",
        });
        const text = selection?.result;
        if (!text) {
            showStatus("리뷰 본문을 선택한 뒤 다시 가져오거나 직접 붙여넣으세요.", true);
            return;
        }
        if (text.length > maxTextLength) {
            showStatus("본문은 3,000자 이하로 선택해 주세요.", true);
            return;
        }
        productId.value ||= product.id;
        textArea.value = text;
        showStatus("본문을 가져왔습니다. 리뷰 별점을 선택하세요.");
    } catch {
        showStatus("선택 내용을 읽을 수 없습니다. 본문을 직접 붙여넣으세요.", true);
    }
}

function refreshReviewButtons() {
    const count = reviewList.children.length;
    addButton.disabled = count >= maxReviews;
    for (const button of reviewList.querySelectorAll("[data-remove]")) {
        button.hidden = count === 1;
    }
}

function addReview(review) {
    if (reviewList.children.length >= maxReviews) return;

    const row = template.content.firstElementChild.cloneNode(true);
    const textArea = row.querySelector("[data-text]");
    if (review?.text) {
        textArea.value = review.text;
        row.querySelector("[data-rating]").value = review.rating;
        row.dataset.reviewKey = review.key;
        reviewSources.set(row, review);
        row.dataset.productId = productId.value.trim();
    }
    row.querySelector("[data-selection]").addEventListener("click", () => importSelection(textArea));
    row.querySelector("[data-remove]").addEventListener("click", () => {
        row.remove();
        refreshReviewButtons();
    });
    reviewList.append(row);
    refreshReviewButtons();
}

function displayJudgments(response) {
    const judgments = response.judgments;
    if (!judgments.length) {
        showStatus("1~2점 리뷰가 없어 Jev 분석을 건너뛰었습니다.");
        return;
    }

    for (const judgment of judgments) {
        const item = document.createElement("li");
        if (judgment.review_id) item.dataset.reviewId = judgment.review_id;
        const scope = issueScopes[judgment.issue_scope] ?? judgment.issue_scope;
        const probability = Math.round(judgment.product_issue_probability * 100);
        item.textContent = "리뷰 " + (judgment.review_index + 1) + " · " + scope
            + " · 상품 단점 언급 확률 " + probability + "%";
        results.append(item);
    }
    results.hidden = false;
    showStatus("1~2점 리뷰 " + response.low_rating_count + "건을 분석했습니다.");
}

function serverError(reply) {
    if (reply?.error) return reply.error;
    if (reply?.status === 422) return "상품 ID, 별점, 본문을 확인하세요.";
    if (typeof reply?.body?.detail === "string") {
        const messages = {
            "Jev API key is not configured on the server.": "WAS의 .env에서 TypeSafe API 키를 설정하세요.",
            "Jev is temporarily rate limited.": "Jev 요청 한도에 도달했습니다. 잠시 후 다시 시도하세요.",
        };
        if (messages[reply.body.detail]) return messages[reply.body.detail];
    }
    return "분석 요청에 실패했습니다. WAS 실행 상태를 확인하세요.";
}

function reviewMetadata(review) {
    const metadata = { rating: review.rating };
    if (review.id && review.id.length <= 100) metadata.review_id = review.id;
    if (review.vendorItemId && review.vendorItemId.length <= 100) metadata.vendor_item_id = review.vendorItemId;

    const parts = /^(\d{4})[-.](\d{1,2})[-.](\d{1,2})\.?$/.exec(review.date.trim());
    if (parts) {
        const [, year, month, day] = parts;
        const date = year + "-" + month.padStart(2, "0") + "-" + day.padStart(2, "0");
        const parsed = new Date(date + "T00:00:00Z");
        if (Number(year) > 0 && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date) {
            metadata.written_at = date;
        }
    }
    return metadata;
}

async function submit(event) {
    event.preventDefault();
    if (submitButton.disabled) return;
    if ([...reviewList.children].some(row => row.dataset.productId && row.dataset.productId !== productId.value.trim())) {
        showStatus("수집한 리뷰의 상품 ID와 입력한 상품 ID가 다릅니다. 상품 ID를 확인하세요.", true);
        return;
    }
    const reviews = [...reviewList.children].map((row) => {
        const rating = Number(row.querySelector("[data-rating]").value);
        const text = row.querySelector("[data-text]").value.trim();
        const source = reviewSources.get(row);
        const metadata = source?.rating === rating && source.text === text
            ? reviewMetadata(source) : { rating };
        return { ...metadata, text };
    });
    const payload = { product_id: productId.value.trim(), reviews };
    if (collectedProductId === payload.product_id && collectedReviews.length && collectedSample) {
        payload.review_sample = { ...collectedSample, reviews: collectedReviews.map(reviewMetadata) };
    }
    results.replaceChildren();
    results.hidden = true;
    if (reviews.some((review) => !review.text)) {
        showStatus("리뷰 본문을 입력해 주세요.", true);
        return;
    }

    const controls = [...form.querySelectorAll("input, select, textarea, button")]
        .filter((control) => !control.disabled);
    for (const control of controls) control.disabled = true;
    showStatus("분석 중입니다.");
    try {
        const reply = await chrome.runtime.sendMessage({
            type: "analyze-reviews",
            port: port.valueAsNumber,
            payload,
        });
        if (reply?.status === 200 && Array.isArray(reply.body?.judgments)) {
            displayJudgments(reply.body);
        } else {
            showStatus(serverError(reply), true);
        }
    } catch {
        showStatus("분석을 시작할 수 없습니다. 확장프로그램을 다시 열어 주세요.", true);
    } finally {
        for (const control of controls) control.disabled = false;
    }
}

async function restoreSettings() {
    try {
        const { wasPort } = await chrome.storage.local.get("wasPort");
        if (Number.isInteger(wasPort) && wasPort >= 1 && wasPort <= 65535) port.value = wasPort;

        const product = await activeProduct();
        if (product && !productId.value) productId.value = product.id;
    } catch {
        showStatus("상품 ID와 로컬 WAS 포트를 직접 입력할 수 있습니다.");
    }
}

addReview();
addButton.addEventListener("click", () => addReview());
form.addEventListener("submit", submit);
port.addEventListener("invalid", () => {
    port.closest("details").open = true;
});
port.addEventListener("change", async () => {
    if (!port.checkValidity()) return;
    try {
        await chrome.storage.local.set({ wasPort: port.valueAsNumber });
    } catch {
        showStatus("WAS 포트를 저장할 수 없습니다. 현재 입력값으로 분석할 수 있습니다.", true);
    }
});
restoreSettings();

const collectButton = document.querySelector("#collect");
const collectionStatus = document.querySelector("#collection-status");
const collectedList = document.querySelector("#collected");
const useButton = document.querySelector("#use-reviews");
const diagnostic = document.querySelector("#response-diagnostic");
const responseShape = document.querySelector("#response-shape");
const historyPanel = document.querySelector("#reviewer-history");
const historyStatus = document.querySelector("#reviewer-history-status");
const historyList = document.querySelector("#reviewer-history-list");
const historyPrev = document.querySelector("#reviewer-history-prev");
const historyNext = document.querySelector("#reviewer-history-next");
let collectedReviews = [];
let collectedSample = null;
let collectedProductId = "";
let historySource = null;
let historyPage = 0;
let historySerial = 0;

function clearReviewerHistory() {
    historySerial++;
    historySource = null;
    historyPanel.hidden = true;
    historyList.replaceChildren();
    historyStatus.textContent = "";
}

async function loadReviewerHistory(page) {
    const source = historySource;
    const serial = ++historySerial;
    historyPanel.hidden = false;
    historyList.replaceChildren();
    historyStatus.dataset.error = "false";
    historyStatus.textContent = "작성자의 다른 상품평을 조회하고 있습니다.";
    historyPrev.disabled = true;
    historyNext.disabled = true;
    try {
        const product = await activeProduct();
        if (product?.id !== source.productId) throw new Error("조회한 상품의 쿠팡 탭에서 확장프로그램을 열어 주세요.");
        const reply = await chrome.runtime.sendMessage({
            type: "reviewer-reviews", productId: source.productId,
            reviewId: source.reviewId, vendorItemId: source.vendorItemId,
            page, tabId: product.tabId,
        });
        if (serial !== historySerial) return;
        const data = parseReviewerReviews(reply, source.productId);
        for (const review of data.reviews) {
            const item = document.createElement("article");
            item.className = "reviewer-history-item";
            const heading = document.createElement("strong");
            const date = Number.isFinite(review.date) ? new Date(review.date).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" }) : "";
            heading.textContent = (review.itemName || "상품 " + review.productId)
                + (review.rating === null ? "" : " · " + review.rating + "점")
                + (date ? " · " + date : "");
            const body = document.createElement("p");
            body.textContent = review.text ? review.text.slice(0, 400) : "본문 없음";
            item.append(heading, body);
            historyList.append(item);
        }
        historyPage = data.page;
        historyStatus.textContent = (data.totalElements === null ? "" : "작성 상품평 전체 " + data.totalElements + "건 · ")
            + (data.page + 1) + (data.totalPages === null ? "페이지" : " / " + data.totalPages + "페이지")
            + " · 이 페이지의 다른 상품평 " + data.reviews.length + "건"
            + (data.reviews.length ? "" : ". 다른 페이지도 확인해 보세요.");
        historyPrev.disabled = data.page <= 0;
        historyNext.disabled = !data.isMore || (data.totalPages !== null && data.page + 1 >= data.totalPages);
    } catch (error) {
        if (serial !== historySerial) return;
        historyStatus.textContent = error.message;
        historyStatus.dataset.error = "true";
    }
}

historyPrev.addEventListener("click", () => loadReviewerHistory(historyPage - 1));
historyNext.addEventListener("click", () => loadReviewerHistory(historyPage + 1));

collectButton.addEventListener("click", async () => {
    if (!productId.reportValidity() || !document.querySelector("#review-page").reportValidity()) return;
    const id = productId.value.trim();
    const page = document.querySelector("#review-page").valueAsNumber;
    const mode = document.querySelector("#request-mode").value;
    const sortBy = document.querySelector("#review-sort").value;
    const rating = document.querySelector("#review-rating-filter").value;
    const controls = [...form.querySelectorAll("input, select, textarea, button")].filter(control => !control.disabled);
    for (const control of controls) control.disabled = true;
    collectedList.replaceChildren();
    collectedReviews = [];
    clearReviewerHistory();
    useButton.hidden = true;
    diagnostic.hidden = true;
    diagnostic.open = false;
    responseShape.value = "";
    collectionStatus.dataset.error = "false";
    collectionStatus.textContent = "쿠팡에 리뷰를 요청하고 있습니다.";
    try {
        const product = mode === "tab" ? await activeProduct() : null;
        if (mode === "tab" && product?.id !== id) throw new Error("입력한 상품의 쿠팡 탭에서 확장프로그램을 열어 주세요.");
        const reply = await chrome.runtime.sendMessage({
            type: "collect-reviews", productId: id, page, mode, sortBy, rating, tabId: product?.tabId,
        });
        if (reply.status === 200) {
            const contents = reply.body?.rData?.paging?.contents;
            responseShape.value = JSON.stringify({
                samplePath: Array.isArray(contents) && contents.length ? "rData.paging.contents[0]" : "response",
                shape: describeResponseShape(Array.isArray(contents) && contents.length ? contents[0] : reply.body),
            }, null, 2).slice(0, 16000);
        }
        const data = parseReviewPage(reply, rating);
        diagnostic.hidden = data.skipped === 0 && data.emptyTextCount === 0;
        collectedProductId = id;
        collectedReviews = data.reviews;
        collectedSample = { sort: sortBy === "DATE_DESC" ? "latest" : "default", rating_filter: rating ? Number(rating) : null };
        for (const [index, review] of collectedReviews.entries()) {
            const row = document.createElement("div");
            row.className = "collected-review";
            const label = document.createElement("label");
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.value = index;
            checkbox.disabled = !review.text || review.text.length > maxTextLength;
            const text = document.createElement("span");
            text.textContent = [review.rating + "점", review.author, review.date].filter(Boolean).join(" · ")
                + (review.text.length > maxTextLength ? " · 3,000자 초과" : "")
                + "\n" + (review.text || "응답에 본문 없음 · 분석 선택 불가");
            label.append(checkbox, text);
            row.append(label);
            if (/^\d+$/.test(review.id ?? "") && /^\d+$/.test(review.vendorItemId ?? "")) {
                const historyButton = document.createElement("button");
                historyButton.type = "button";
                historyButton.className = "secondary";
                historyButton.textContent = "작성자의 다른 상품평";
                historyButton.addEventListener("click", () => {
                    historySource = { reviewId: review.id, vendorItemId: review.vendorItemId, productId: id };
                    loadReviewerHistory(0);
                });
                row.append(historyButton);
            }
            collectedList.append(row);
        }
        const selectable = collectedReviews.filter(review => review.text && review.text.length <= maxTextLength).length;
        useButton.hidden = selectable === 0;
        collectionStatus.textContent = "HTTP 200 · " + page + "페이지"
            + (data.totalPages === null ? "" : data.estimatedPages
                ? " / 예상 " + data.totalPages + "페이지 · " + rating + "점 리뷰 집계 " + data.selectedCount + "건"
                : " / 총 " + data.totalPages + "페이지")
            + " · 수신 " + data.received + "건 · 표시 " + data.reviews.length + "건"
            + " · 본문 없음 " + data.emptyTextCount + "건 · 분석 선택 가능 " + selectable + "건"
            + " · 별점 형식 오류로 제외 " + data.skipped + "건";
        if (data.reviews.length && !selectable) {
            collectionStatus.textContent += ". 정렬이나 조회 페이지를 바꿔 본문이 포함된 리뷰를 찾아보세요.";
        }
    } catch (error) {
        diagnostic.hidden = !responseShape.value;
        collectionStatus.textContent = error.message;
        collectionStatus.dataset.error = "true";
    } finally {
        for (const control of controls) control.disabled = false;
    }
});

useButton.addEventListener("click", () => {
    if (productId.value.trim() !== collectedProductId) {
        showStatus("조회 후 상품 ID가 변경됐습니다. 다시 조회해 주세요.", true);
        return;
    }
    const selected = [...collectedList.querySelectorAll("input:checked:not(:disabled)")].map(input => collectedReviews[Number(input.value)]);
    const rows = [...reviewList.children];
    const filled = rows.filter(row => row.querySelector("[data-text]").value.trim());
    const keys = new Set(filled.map(row => row.dataset.reviewKey));
    const additions = selected.filter(review => !keys.has(review.key));
    if (!additions.length) return showStatus("추가할 리뷰를 선택하세요. 이미 추가한 리뷰는 제외됩니다.", true);
    if (filled.length + additions.length > maxReviews) return showStatus("분석 목록에는 최대 8건을 담을 수 있습니다.", true);
    for (const row of rows) if (!filled.includes(row)) row.remove();
    for (const review of additions) addReview(review);
    results.replaceChildren();
    results.hidden = true;
    showStatus(additions.length + "건을 분석 목록에 추가했습니다. 분석하기를 누르면 WAS로 전송합니다.");
});

for (const filter of [document.querySelector("#review-sort"), document.querySelector("#review-rating-filter")]) {
    filter.addEventListener("change", () => {
        document.querySelector("#review-page").value = "1";
        collectedReviews = [];
        collectedList.replaceChildren();
    clearReviewerHistory();
        useButton.hidden = true;
        diagnostic.hidden = true;
        responseShape.value = "";
        collectionStatus.textContent = "조회 조건을 변경했습니다. 리뷰 조회를 눌러 새 목록을 가져오세요.";
        collectionStatus.dataset.error = "false";
    });
}
