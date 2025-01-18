// Content extraction functionality
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "extract_content") {
        const content = {
            rawHtml: document.documentElement.outerHTML,
            readableContent: document.body.innerText,
            title: document.title,
            url: window.location.href
        };
        sendResponse({ content });
    }
    return true;
}); 