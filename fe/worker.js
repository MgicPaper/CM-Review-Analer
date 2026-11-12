import { reviewUrl, reviewerReviewsUrl, requestReviewPage } from "./coupang.js";

async function collect(message) {
    try {
        const url = reviewUrl(message.productId, message.page, message.sortBy, message.rating);
        if (message.mode === "worker") return await requestReviewPage(url);
        if (message.mode !== "tab" || !Number.isInteger(message.tabId)) {
            throw new Error("리뷰 요청 방식을 확인하세요.");
        }
        const tab = await chrome.tabs.get(message.tabId);
        const productUrl = new URL(tab.url);
        if (productUrl.origin !== "https://www.coupang.com"
            || productUrl.pathname.replace(/\/$/, "") !== "/vp/products/" + message.productId) {
            throw new Error("입력한 상품의 쿠팡 탭을 열고 다시 시도하세요.");
        }
        const [result] = await chrome.scripting.executeScript({
            target: { tabId: message.tabId },
            func: requestReviewPage, args: [url],
        });
        if (!result?.result) throw new Error("쿠팡 탭의 리뷰 요청 결과를 받지 못했습니다.");
        return result.result;
    } catch (error) {
        return { error: error.message };
    }
}

async function collectReviewerReviews(message) {
    try {
        if (!Number.isInteger(message.tabId)) throw new Error("쿠팡 상품 탭을 확인하세요.");
        const tab = await chrome.tabs.get(message.tabId);
        const productUrl = new URL(tab.url);
        if (productUrl.origin !== "https://www.coupang.com"
            || productUrl.pathname.replace(/\/$/, "") !== "/vp/products/" + message.productId) {
            throw new Error("조회한 상품의 쿠팡 탭을 열고 다시 시도하세요.");
        }
        const url = reviewerReviewsUrl(message.reviewId, message.vendorItemId, message.page);
        const [result] = await chrome.scripting.executeScript({
            target: { tabId: message.tabId }, func: requestReviewPage, args: [url],
        });
        if (!result?.result) throw new Error("작성자 상품평 조회 결과를 받지 못했습니다.");
        return result.result;
    } catch (error) {
        return { error: error.message };
    }
}

async function analyze(port, payload) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { error: "WAS 포트는 1부터 65535 사이의 정수로 입력하세요." };
    }

    try {
        const response = await fetch("http://127.0.0.1:" + port + "/v1/reviews/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(20000),
        });
        return { status: response.status, body: await response.json().catch(() => null) };
    } catch (error) {
        return {
            error: error.name === "TimeoutError"
                ? "WAS 응답 시간이 초과됐습니다."
                : "로컬 WAS에 연결할 수 없습니다. 실행 상태와 포트를 확인하세요.",
        };
    }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.url !== chrome.runtime.getURL("popup.html")) return;
    if (message?.type === "analyze-reviews") analyze(message.port, message.payload).then(respond);
    else if (message?.type === "collect-reviews") collect(message).then(respond);
    else if (message?.type === "reviewer-reviews") collectReviewerReviews(message).then(respond);
    else return;
    return true;
});
