import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const product = "https://www.coupang.com/vp/products/7330106093?itemId=29194420237&vendorItemId=96115128240";
const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
    "--no-first-run", "--no-default-browser-check", "--remote-debugging-pipe",
    "--user-data-dir=" + mkdtempSync(path.join(tmpdir(), "reviewanaler-trace-")), "about:blank",
], { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
const pending = new Map();
const requests = new Map();
const requestExtras = new Map();
const bodyReads = [];
let lastId = 0;
let buffer = "";
let phase = "product";

function selectedHeaders(headers, names) {
    return Object.fromEntries(Object.entries(headers ?? {})
        .filter(([name]) => names.includes(name.toLowerCase())));
}

function observe(event) {
    const { method, params, sessionId } = event;
    const key = sessionId + ":" + params?.requestId;
    if (method === "Network.requestWillBeSent") {
        const url = new URL(params.request.url);
        if (url.origin !== "https://www.coupang.com") return;
        if (url.pathname !== "/vp/products/7330106093"
            && url.pathname !== "/next-api/review"
            && url.pathname !== "/next-api/review/batch") return;
        requests.set(key, {
            phase, method: params.request.method, host: url.hostname, path: url.pathname,
            query: Object.fromEntries(url.searchParams),
            requestHeaders: selectedHeaders(params.request.headers, ["origin", "referer", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"]),
            type: params.type, requestId: params.requestId, sessionId,
        });
    } else if (method === "Network.requestWillBeSentExtraInfo") {
        requestExtras.set(key, {
            headers: selectedHeaders(params.headers, ["origin", "referer", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"]),
            cookieHeaderPresent: Object.keys(params.headers ?? {}).some(name => name.toLowerCase() === "cookie"),
            associatedCookieCount: params.associatedCookies?.length ?? 0,
            blockedCookieReasons: (params.associatedCookies ?? []).flatMap(cookie => cookie.blockedReasons),
        });
    } else if (method === "Network.responseReceived") {
        const request = requests.get(key);
        if (request) Object.assign(request, {
            status: params.response.status, type: params.type, mimeType: params.response.mimeType,
            responseHeaders: selectedHeaders(params.response.headers, ["server", "content-type", "cache-control", "retry-after", "www-authenticate", "access-control-allow-origin"]),
        });
    } else if (method === "Network.loadingFinished") {
        const request = requests.get(key);
        if (request) {
            request.finished = true;
            if (request.status === 403) bodyReads.push(send("Network.getResponseBody", { requestId: params.requestId }, sessionId)
                .then(result => {
                    const body = result.base64Encoded ? Buffer.from(result.body, "base64").toString() : result.body;
                    request.denial = {
                        accessDenied: /Access Denied/i.test(body),
                        reference: body.match(/Reference[^<\n]*/i)?.[0],
                        errorHost: body.match(/(?:https?:\/\/)?errors\.[a-z0-9.-]+/i)?.[0],
                    };
                }).catch(error => { request.bodyError = error.message; }));
        }
    } else if (method === "Network.loadingFailed") {
        const request = requests.get(key);
        if (request) Object.assign(request, { failed: params.errorText, blocked: params.blockedReason });
    }
}
chrome.stdio[4].setEncoding("utf8").on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\0");
    buffer = lines.pop();
    for (const raw of lines) {
        const message = JSON.parse(raw);
        if (message.id) pending.get(message.id)?.(message);
        else observe(message);
    }
});
chrome.stderr.on("data", (chunk) => {
    const error = chunk.toString().split("\n").filter((line) => line.includes("DevTools"));
    if (error.length) process.stderr.write(error.join("\n") + "\n");
});
function send(method, params = {}, sessionId, timeoutMs = 15000) {
    const id = ++lastId;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error("DevTools timeout for " + method));
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
async function until(probe, label) {
    for (let attempt = 0; attempt < 70; attempt++) {
        const result = await probe();
        if (result) return result;
        await delay(150);
    }
    throw new Error("Timed out waiting for " + label);
}
try {
    const version = await send("Browser.getVersion");
    console.log("Browser", version.product);
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const call = (method, params) => send(method, params, sessionId);
    const evaluate = async (expression) => {
        const { result, exceptionDetails } = await call("Runtime.evaluate", { expression, returnByValue: true });
        if (exceptionDetails) throw new Error(exceptionDetails.text);
        return result.value;
    };
    await call("Network.enable");
    await call("Page.enable");
    await call("Page.bringToFront");
    const navigation = await send("Page.navigate", { url: product }, sessionId, 25000);
    console.log("Navigation", JSON.stringify({ error: navigation.errorText }));
    const point = await until(() => evaluate(`(() => {
        const control = Array.from(document.querySelectorAll("a,button,[role=tab]"))
            .find((element) => /^상품평\\s*\\(/.test((element.textContent || "").trim()));
        if (!control) return false;
        control.scrollIntoView({ block: "center" });
        const rect = control.getBoundingClientRect();
        return {x: rect.left + rect.width / 2, y: rect.top + rect.height / 2};
    })()`), "product review tab");
    await delay(350);
    phase = "review tab";
    for (const type of ["mousePressed", "mouseReleased"]) {
        await call("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
    }
    await until(() => [...requests.values()].find((request) =>
        request.path === "/next-api/review" && (request.finished || request.failed)
    ), "Coupang review response");
} finally {
    await Promise.all(bodyReads);
    const evidence = [...requests.values()]
        .map(({ requestId, sessionId, ...info }) => ({ ...info, requestExtra: requestExtras.get(sessionId + ":" + requestId) }));
    console.log("Network", JSON.stringify(evidence));
    await send("Browser.close", {}, undefined, 2000).catch(() => {});
    if (chrome.exitCode === null) chrome.kill();
}

