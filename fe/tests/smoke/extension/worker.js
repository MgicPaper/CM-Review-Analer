const endpoint = "http://127.0.0.1:18765/v1/reviews/analyze";

chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type !== "analyze-reviews" || !sender.tab) return;
    fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message.payload),
    })
        .then(async (response) => respond({
            status: response.status,
            body: await response.json(),
        }))
        .catch((error) => respond({ error: error.message }));
    return true;
});
