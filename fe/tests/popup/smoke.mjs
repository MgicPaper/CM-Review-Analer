import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const extensionDirectory = path.resolve(root, "../..");
const wasDirectory = path.resolve(extensionDirectory, "../was");
const apiUrl = "http://127.0.0.1:18766";
const api = spawn(path.join(wasDirectory, ".venv", "Scripts", "python.exe"), [
    "-B", path.join(root, "mock_was.py"),
], { cwd: root, windowsHide: true, stdio: "inherit" });
let chrome;
const liveResponses = [];

async function until(probe, description, attempts = 70) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const value = await probe();
        if (value) return value;
        await delay(150);
    }
    throw new Error("Timed out waiting for " + description);
}

try {
    await until(async () => {
        if (api.exitCode !== null) throw new Error("The test API exited with code " + api.exitCode);
        return fetch(apiUrl + "/health")
            .then((response) => response.json())
            .then((health) => health.jev_configured === true)
            .catch(() => false);
    }, "test WAS");

    chrome = spawn(process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", [
        ...(process.argv.includes("--headed") ? [] : ["--headless"]),
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--remote-debugging-pipe",
        "--enable-unsafe-extension-debugging",
        "--user-data-dir=" + mkdtempSync(path.join(tmpdir(), "reviewanaler-smoke-")),
        "about:blank",
    ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
    chrome.stderr.on("data", (chunk) => process.stderr.write(chunk));
    const pending = new Map();
    let lastId = 0;
    let buffer = "";
    let reviewStatus = 200;
    let reviewBody = {
        rCode: "RET0000", rData: { paging: { totalPage: 2, contents: [
            { reviewId: 1001, vendorItemId: 2001, reviewAt: "2026.11.12", rating: 2, content: "뚜껑을 닫아도 물이 샙니다." },
            { reviewId: "fixture-2", rating: 5, content: "보관하기 편합니다." },
            { reviewId: "fixture-long", rating: 1, content: "가".repeat(3001) },
            { reviewId: "fixture-empty", rating: 5, title: "", content: "" },
        ] } },
    };
    let historyBody = { rCode: "RET0000", rData: { profilesReviews: {
        metadata: { totalPages: 2, totalElements: 16, size: 15, currentPage: 0 },
        content: [
            { productId: 9001, itemName: "다른 상품", rating: 4, content: "다른 상품평 본문", createdAt: 1762905600000 },
            { productId: 7330106093, itemName: "원래 상품", rating: 2, content: "같은 상품평", createdAt: 1762905600000 },
        ], isMore: true,
    } } };
    const reviewRequests = [];
    const historyRequests = [];
    const interceptionTasks = [];
    chrome.stdio[4].setEncoding("utf8").on("data", (chunk) => {
        buffer += chunk;
        const messages = buffer.split("\0");
        buffer = messages.pop();
        for (const raw of messages) {
            const message = JSON.parse(raw);
            const handle = pending.get(message.id);
            if (handle) handle(message);
            if (message.method === "Network.responseReceived") {
                const response = message.params.response;
                const url = new URL(response.url);
                if (url.origin === "https://www.coupang.com" &&
                    ["/vp/products/7330106093", "/next-api/review"].includes(url.pathname)) {
                    liveResponses.push({ path: url.pathname, status: response.status, type: message.params.type,
                        query: Object.fromEntries(url.searchParams),
                        headers: Object.fromEntries(Object.entries(response.headers)
                            .filter(([name]) => ["server", "content-type"].includes(name.toLowerCase()))),
                    });
                }
            }
            if (message.method === "Fetch.requestPaused") {
                const { requestId, request } = message.params;
                const url = new URL(request.url);
                const isReview = url.pathname === "/next-api/review";
                const isHistory = url.pathname === "/next-api/review/profile/reviews";
                if (isReview) reviewRequests.push({ url: request.url, method: request.method });
                if (isHistory) historyRequests.push({ url: request.url, method: request.method });
                interceptionTasks.push(send("Fetch.fulfillRequest", {
                    requestId, responseCode: isReview ? reviewStatus : 200,
                    responseHeaders: [{ name: "Content-Type", value: isReview || isHistory ? "application/json" : "text/html" }],
                    body: Buffer.from(isReview ? JSON.stringify(reviewBody) : isHistory ? JSON.stringify(historyBody)
                        : "<!doctype html><title>Product fixture</title><p>Product</p>").toString("base64"),
                }, message.sessionId));
            }
        }
    });
    function send(method, params = {}, sessionId, timeoutMs = 12000) {
        const id = ++lastId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error("DevTools timeout for " + method + " (Chrome exit " + chrome.exitCode + ")"));
            }, timeoutMs);
            pending.set(id, (message) => {
                clearTimeout(timer);
                pending.delete(id);
                if (message.error) reject(new Error(method + ": " + message.error.message));
                else resolve(message.result);
            });
            chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
        });
    }

    const version = await send("Browser.getVersion");
    console.log("Browser: " + version.product);
    console.log("Mode: " + (process.argv.includes("--headed") ? "headed" : "headless") + ", fresh temporary profile");
    const { id } = await send("Extensions.loadUnpacked", { path: extensionDirectory });
    console.log("Loaded extension: " + extensionDirectory);
    const { targetId } = await send("Target.createTarget", { url: "chrome-extension://" + id + "/popup.html" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    async function evaluate(expression) {
        const { result, exceptionDetails } = await send("Runtime.evaluate", {
            expression, returnByValue: true, awaitPromise: true,
        }, sessionId);
        if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
        return result.value;
    }

    await until(() => evaluate('document.querySelectorAll("#reviews .review").length === 1'), "popup script");
    await evaluate('document.querySelector("[data-selection]").click()');
    await until(() => evaluate('document.querySelector("#status").textContent.includes("직접 붙여넣으세요")'), "selection fallback");
    await evaluate(`(() => {
        document.querySelector("#product-id").value = "7330106093";
        document.querySelector("[data-rating]").value = "2";
        document.querySelector("[data-text]").value = "뚜껑을 닫아도 물이 샙니다.";
        document.querySelector("#add-review").click();
        const second = document.querySelectorAll(".review")[1];
        second.querySelector("[data-rating]").value = "5";
        second.querySelector("[data-text]").value = "보관하기 편합니다.";
        const port = document.querySelector("#port");
        port.value = "18766";
        port.dispatchEvent(new Event("change"));
        document.querySelector("#analysis").requestSubmit();
    })()`);
    const text = await until(() => evaluate('document.querySelector("#results li")?.textContent'), "analyzed review");
    assert.equal(text, "리뷰 1 · 상품 자체 · 상품 단점 언급 확률 96%");
    console.log("PASS popup -> extension service worker -> actual WAS with mocked Jev");

    await evaluate(`(() => {
        document.querySelector("[data-remove]").click();
        document.querySelector("#analysis").requestSubmit();
    })()`);
    await until(() => evaluate('document.querySelector("#status").textContent.includes("건너뛰었습니다")'), "positive-only response");
    assert.equal(await evaluate('document.querySelector("#results").hidden'), true);

    const unusedPort = await new Promise((resolve, reject) => {
        const listener = createServer();
        listener.on("error", reject);
        listener.listen(0, "127.0.0.1", () => {
            const port = listener.address().port;
            listener.close(() => resolve(port));
        });
    });
    await evaluate(`document.querySelector("#port").value = "${unusedPort}"; document.querySelector("#analysis").requestSubmit();`);
    await until(() => evaluate('document.querySelector("#status").textContent.includes("로컬 WAS에 연결할 수 없습니다")'), "connection error");
    console.log("PASS selection fallback, positive-only response, and local WAS error");

    const productUrl = "https://www.coupang.com/vp/products/7330106093";
    const productTarget = await send("Target.createTarget", { url: "about:blank" });
    const productSession = await send("Target.attachToTarget", { targetId: productTarget.targetId, flatten: true });
    await send("Fetch.enable", { patterns: [{ urlPattern: "https://www.coupang.com/*" }] }, productSession.sessionId);
    await send("Page.navigate", { url: productUrl }, productSession.sessionId);
    await until(() => evaluate(`chrome.tabs.query({url: "${productUrl}"}).then(tabs => tabs[0]?.id)`), "product fixture");
    await evaluate(`chrome.tabs.query({url: "${productUrl}"}).then(tabs => chrome.tabs.update(tabs[0].id, {active:true}))`);
    await send("Runtime.evaluate", { expression: `(() => {
        const range = document.createRange();
        range.selectNodeContents(document.querySelector("p"));
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
    })()` }, productSession.sessionId);
    await evaluate('document.querySelector("[data-selection]").click()');
    await until(() => evaluate('document.querySelector("[data-text]").value === "Product"'), "selected page text import");
    assert.ok(await evaluate('document.querySelector("#status").textContent.includes("본문을 가져왔습니다")'));
    console.log("PASS selected product-tab text imports into popup");
    await evaluate(`
        document.querySelector("#reviews").replaceChildren();
        document.querySelector("#add-review").click();
        document.querySelector("#port").value = "18766";
        document.querySelector("#collect").click();
    `);
    await until(() => evaluate('document.querySelectorAll("#collected input").length === 4'), "direct review collection");
    assert.equal(await evaluate('document.querySelectorAll("#collected input")[2].disabled'), true);
    assert.equal(await evaluate('document.querySelectorAll("#collected input")[3].disabled'), true);
    assert.ok(await evaluate('document.querySelector("#collection-status").textContent.includes("본문 없음 1건")'));
    assert.equal(reviewRequests.length, 1);
    const requested = new URL(reviewRequests[0].url);
    assert.equal(reviewRequests[0].method, "GET");
    assert.equal(requested.searchParams.get("productId"), "7330106093");
    assert.equal(requested.searchParams.get("page"), "1");
    assert.equal(requested.searchParams.get("sortBy"), "ORDER_SCORE_ASC");
    assert.equal(requested.searchParams.get("ratings"), "");
    await evaluate('document.querySelector(".collected-review button").click()');
    await until(() => evaluate('document.querySelector("#reviewer-history-list").textContent.includes("다른 상품평 본문")'), "other product reviews");
    assert.equal(await evaluate('document.querySelectorAll("#reviewer-history-list article").length'), 1);
    assert.ok(!await evaluate('document.querySelector("#reviewer-history-list").textContent.includes("같은 상품평")'));
    assert.equal(new URL(historyRequests.at(-1).url).searchParams.get("page"), "0");
    assert.equal(new URL(historyRequests.at(-1).url).searchParams.get("reviewId"), "1001");
    assert.equal(new URL(historyRequests.at(-1).url).searchParams.get("vendorItemId"), "2001");
    historyBody.rData.profilesReviews = {
        metadata: { totalPages: 2, totalElements: 16, size: 15, currentPage: 1 },
        content: [{ productId: 9002, itemName: "다음 상품", rating: 1, content: "다음 상품평 본문" }],
        isMore: false,
    };
    await evaluate('document.querySelector("#reviewer-history-next").click()');
    await until(() => evaluate('document.querySelector("#reviewer-history-list").textContent.includes("다음 상품평 본문")'), "other product reviews next page");
    assert.equal(new URL(historyRequests.at(-1).url).searchParams.get("page"), "1");
    assert.equal(await evaluate('document.querySelector("#reviewer-history-next").disabled'), true);
    assert.equal(await evaluate('document.querySelector("#reviewer-history-prev").disabled'), false);
    console.log("PASS reviewer other-product reviews load in popup with pagination and no navigation");
    await evaluate(`document.querySelector("#collected input").checked=true; document.querySelector("#use-reviews").click(); document.querySelector("#analysis").requestSubmit()`);
    await until(() => evaluate('document.querySelector("#results li")?.textContent.includes("96%")'), "collected review analysis");
    assert.equal(await evaluate('document.querySelector("#results li").dataset.reviewId'), "1001");
    await evaluate('document.querySelector("#use-reviews").click()');
    assert.equal(await evaluate('document.querySelectorAll("#reviews .review").length'), 1);

    reviewBody = { rCode: "RET0000", rData: { paging: { totalPage: 2, contents: [] } } };
    await evaluate('document.querySelector("#review-page").value="2"; document.querySelector("#collect").click()');
    await until(() => evaluate('document.querySelector("#collection-status").textContent.includes("수신 0건")'), "empty page");
    assert.equal(new URL(reviewRequests.at(-1).url).searchParams.get("page"), "2");
    assert.equal(await evaluate('document.querySelector("#use-reviews").hidden'), true);

    reviewStatus = 403;
    await evaluate('document.querySelector("#collect").click()');
    await until(() => evaluate('document.querySelector("#collection-status").textContent.includes("HTTP 403")'), "blocked response");
    assert.equal(await evaluate('document.querySelector("[data-text]").value'), "뚜껑을 닫아도 물이 샙니다.");
    reviewStatus = 200;
    reviewBody = { unexpected: true };
    await evaluate('document.querySelector("#collect").click()');
    await until(() => evaluate('document.querySelector("#collection-status").textContent.includes("해석할 수 없습니다")'), "schema failure");
    assert.equal(await evaluate('document.querySelector("#response-diagnostic").hidden'), false);
    reviewBody = { rCode: "RET0000", rData: { paging: { totalPage: 254, contents: [
        { unrecognizedReview: { score: 2, body: "PRIVATE REVIEW TEXT", author: "PRIVATE AUTHOR" } },
    ] } } };
    await evaluate('document.querySelector("#collect").click()');
    await until(() => evaluate('document.querySelector("#collection-status").textContent.includes("제외 1건")'), "unrecognized review fields");
    assert.equal(await evaluate('document.querySelector("#response-diagnostic").hidden'), false);
    const diagnosticText = await evaluate('document.querySelector("#response-shape").value');
    assert.ok(diagnosticText.includes("unrecognizedReview"));
    assert.ok(diagnosticText.includes("score"));
    assert.ok(!diagnosticText.includes("PRIVATE"));
    console.log("PASS schema diagnosis displays field types while omitting review and author values");
    reviewBody = { rCode: "RET0000", rData: { paging: { totalPage: 254, contents:
        Array.from({ length: 10 }, (_, index) => ({ reviewId: index + 1, rating: 5, title: "", content: "" })),
    } } };
    await evaluate('document.querySelector("#review-sort").value="DATE_DESC"; document.querySelector("#review-sort").dispatchEvent(new Event("change")); document.querySelector("#collect").click()');
    await until(() => evaluate('document.querySelector("#collection-status").textContent.includes("본문 없음 10건")'), "ten empty-text reviews");
    assert.equal(new URL(reviewRequests.at(-1).url).searchParams.get("sortBy"), "DATE_DESC");
    assert.equal(new URL(reviewRequests.at(-1).url).searchParams.get("page"), "1");
    assert.equal(await evaluate('document.querySelectorAll("#collected input:disabled").length'), 10);
    assert.equal(await evaluate('document.querySelector("#use-reviews").hidden'), true);
    assert.ok(await evaluate('document.querySelector("#collection-status").textContent.includes("표시 10건")'));
    assert.ok(await evaluate('document.querySelector("#collection-status").textContent.includes("제외 0건")'));
    console.log("PASS empty-text reviews remain visible, cannot be selected, and sort changes reset the page");
    reviewBody.rData.ratingSummaryTotal = { ratingSummaries: [{ rating: 2, count: 46 }] };
    await evaluate('document.querySelector("#review-rating-filter").value="2"; document.querySelector("#review-rating-filter").dispatchEvent(new Event("change")); document.querySelector("#collect").click()');
    await until(() => evaluate('document.querySelector("#collection-status").textContent.includes("HTTP 200")'), "filtered reviews");
    assert.equal(new URL(reviewRequests.at(-1).url).searchParams.get("ratings"), "2");
    assert.equal(new URL(reviewRequests.at(-1).url).searchParams.get("page"), "1");
    assert.ok(await evaluate('document.querySelector("#collection-status").textContent.includes("예상 5페이지 · 2점 리뷰 집계 46건")'));
    assert.ok(!await evaluate('document.querySelector("#collection-status").textContent.includes("총 254페이지")'));
    console.log("PASS rating filter sends selected Coupang query and resets pagination");
    const location = await send("Runtime.evaluate", { expression: "location.href", returnByValue: true }, productSession.sessionId);
    assert.equal(location.result.value, productUrl);
    const { targetInfos } = await send("Target.getTargets");
    const workerTarget = targetInfos.find(target => target.type === "service_worker" && target.url === "chrome-extension://" + id + "/worker.js");
    assert.ok(workerTarget, "extension service worker exists");
    const workerSession = await send("Target.attachToTarget", { targetId: workerTarget.targetId, flatten: true });
    await send("Fetch.enable", { patterns: [{ urlPattern: "https://www.coupang.com/next-api/review*" }] }, workerSession.sessionId);
    reviewBody = { rCode: "RET0000", rData: { paging: { totalPage: 1, contents: [
        { reviewId: "worker-1", rating: 1, content: "서비스 워커 수집 테스트" },
    ] } } };
    await evaluate('document.querySelector("#request-mode").value="worker"; document.querySelector("#collect").click()');
    await until(() => evaluate('document.querySelector("#collected")?.textContent.includes("서비스 워커 수집 테스트")'), "service worker collection");
    console.log("PASS service worker cross-origin GET and review display");
    await Promise.all(interceptionTasks);
    console.log("PASS mocked Coupang GET -> content script -> popup -> real WAS/mock Jev, no navigation, pagination, deduplication, oversized review, empty page, 403 and schema errors");

    if (process.argv.includes("--live") || process.argv.includes("--coupang-live")) {
        await send("Fetch.disable", {}, productSession.sessionId);
        await send("Fetch.disable", {}, workerSession.sessionId);
        await send("Network.enable", {}, productSession.sessionId);
        await send("Network.enable", {}, workerSession.sessionId);
        await send("Page.navigate", { url: productUrl }, productSession.sessionId);
        await until(async () => {
            const result = await send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, productSession.sessionId);
            return result.result.value === "complete";
        }, "live product load");
        for (const mode of ["tab", "worker"]) {
            await evaluate(`
                document.querySelector("#product-id").value="7330106093";
                document.querySelector("#review-sort").value="ORDER_SCORE_ASC";
                document.querySelector("#review-page").value="1";
                document.querySelector("#request-mode").value="${mode}";
                document.querySelector("#collect").click();
            `);
            let timedOut = false;
            try {
                await until(() => evaluate('!document.querySelector("#collect").disabled'), "live collection response", 150);
            } catch (error) {
                timedOut = true;
                console.log("LIVE collection timeout", mode, error.message);
            }
            const result = await evaluate(`({
                message:document.querySelector("#collection-status").textContent,
                error:document.querySelector("#collection-status").dataset.error,
                displayed:document.querySelectorAll("#collected input").length,
                selectable:document.querySelectorAll("#collected input:not(:disabled)").length
            })`);
            console.log("LIVE Coupang popup", mode, JSON.stringify(result));
            if (timedOut) {
                process.exitCode = 1;
                break;
            }
        }
        const finalLocation = await send("Runtime.evaluate", { expression: "location.href", returnByValue: true }, productSession.sessionId);
        assert.equal(finalLocation.result.value, productUrl);
    }
    if (process.argv.includes("--live")) {
        try {
            const health = await fetch("http://127.0.0.1:8765/health", {signal: AbortSignal.timeout(3000)});
            const body = await health.json();
            console.log("LIVE WAS health", health.status, JSON.stringify(body));
            if (health.ok && body.jev_configured) {
                const reply = await evaluate(`chrome.runtime.sendMessage({type:"analyze-reviews",port:8765,payload:{product_id:"prototype-synthetic-test",reviews:[{rating:2,text:"뚜껑을 닫아도 물이 샙니다."}]}})`);
                console.log("LIVE WAS synthetic review", JSON.stringify(reply));
            }
        } catch (error) {
            console.log("LIVE WAS unavailable", error.message);
        }
    }
    await send("Browser.close");
} finally {
    if (liveResponses.length) console.log("LIVE Network", JSON.stringify(liveResponses));
    if (chrome && chrome.exitCode === null) chrome.kill();
    api.kill();
}
