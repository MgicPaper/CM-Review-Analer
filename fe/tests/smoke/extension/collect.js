(() => {
    const product = document.querySelector("main[data-product-id]");
    const reviews = product?.querySelector("#reviews");
    if (!reviews) return;

    const button = document.createElement("button");
    button.id = "reviewanaler-smoke-analyze";
    button.textContent = "Analyze reviews";
    reviews.before(button);

    const readReviews = (selector) => [...product.querySelectorAll(selector)]
        .map((review) => ({
            rating: Number(review.dataset.rating),
            date: review.querySelector("time").dateTime,
            text: review.querySelector("p").textContent.trim(),
        }));

    button.addEventListener("click", async () => {
        try {
            const payload = {
                product_id: product.dataset.productId,
                reviews: readReviews("#reviews article"),
                history: readReviews("#profile[open] article"),
            };
            const response = await chrome.runtime.sendMessage({ type: "analyze-reviews", payload });
            document.documentElement.dataset.smokeResponse = JSON.stringify(response);
        } catch (error) {
            document.documentElement.dataset.smokeResponse = JSON.stringify({ error: error.message });
        }
    });
})();
