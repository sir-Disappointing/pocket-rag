// Example of opening the assistant from your own button.
document.querySelectorAll(".ask-link").forEach((b) => b.addEventListener("click", () => window.pocketRag && window.pocketRag.ask(b.dataset.q)));
