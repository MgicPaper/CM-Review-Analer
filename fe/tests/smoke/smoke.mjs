import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const wasDirectory = path.resolve(root, "../../../was");
const apiUrl = "http://127.0.0.1:18765";
const fixture = readFileSync(path.join(root, "fixture.html"));
const fixtureServer = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(fixture);
});
const api = spawn(path.join(wasDirectory, ".venv", "Scripts", "python.exe"), [
    "-B", "-m", "uvicorn", "api:app", "--host", "127.0.0.1", "--port", "18765",
], { cwd: root, windowsHide: true, stdio: "inherit" });
let chrome;

async function until(probe, description, attempts = 80) {
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
            .then((health) => health.smoke === true)
            .catch(() => false);
    }, "smoke test API");
    await new Promise((resolve, reject) => {
        fixtureServer.once("error", reject);
        fixtureServer.listen(0, "127.0.0.1", resolve);
    });

    chrome = spawn(process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", [
        "--headless",
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
    chrome.stdio[4].setEncoding("utf8").on("data", (chunk) => {
        buffer += chunk;
        const messages = buffer.split("\0");
        buffer = messages.pop();
        for (const raw of messages) {
            const message = JSON.parse(raw);
            const handle = pending.get(message.id);
            if (handle) handle(message);
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
    await send("Extensions.loadUnpacked", {
        path: path.join(root, "extension"),
    });
    const fixtureUrl = "http://127.0.0.1:" + fixtureServer.address().port + "/";
    await send("Target.createTarget", { url: fixtureUrl });
    const page = await until(async () => {
        const { targetInfos } = await send("Target.getTargets", { filter: [{ type: "page" }] });
        return targetInfos.find((info) => info.url === fixtureUrl);
    }, "fixture page target");
    const { sessionId } = await send("Target.attachToTarget", {
        targetId: page.targetId,
        flatten: true,
    });
    async function evaluate(expression) {
        const { result, exceptionDetails } = await send("Runtime.evaluate", {
            expression,
            returnByValue: true,
        }, sessionId);
        if (exceptionDetails) throw new Error(exceptionDetails.text);
        return result.value;
    }

    await until(() => evaluate('Boolean(document.querySelector("#reviewanaler-smoke-analyze"))'), "extension button");
    for (const historyCount of [0, 2]) {
        if (historyCount > 0) await evaluate('document.querySelector("#profile summary").click()');
        await evaluate("delete document.documentElement.dataset.smokeResponse");
        await evaluate('document.querySelector("#reviewanaler-smoke-analyze").click()');
        const raw = await until(() => evaluate("document.documentElement.dataset.smokeResponse"), "extension response");
        const response = JSON.parse(raw);
        assert.deepEqual(response, {
            status: 200,
            body: {
                product_id: "sample-product",
                review_count: 2,
                low_rating_count: 1,
                history_count: historyCount,
            },
        });
        console.log("PASS extension to FastAPI: " + JSON.stringify(response));
    }

    if (process.argv.includes("--live")) {
        await send("Page.enable", {}, sessionId);
        const navigation = await send("Page.navigate", {
            url: "https://www.coupang.com/vp/products/7330106093?itemId=29194420237&vendorItemId=96115128240",
        }, sessionId, 25000);
        if (navigation.errorText) {
            console.log("Live navigation: " + navigation.errorText);
        } else {
            const info = await until(() => evaluate(`document.readyState === "complete" && ({
                title: document.title,
                body: document.body?.innerText.slice(0, 140),
                status: performance.getEntriesByType("navigation")[0]?.responseStatus,
                reviewControls: Array.from(document.querySelectorAll("a, button, [role=tab]"))
                    .map((el) => (el.innerText || "").trim())
                    .filter((text) => /^(상품평|상품 리뷰|최신순)(\\s|\\(|$)/.test(text)).slice(0, 10)
            })`), "live page");
            console.log("Live page: " + JSON.stringify(info));
        }
    }
    await send("Browser.close");
} finally {
    if (chrome && chrome.exitCode === null) chrome.kill();
    api.kill();
    fixtureServer.close();
}
