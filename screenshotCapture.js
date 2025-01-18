// Screenshot capture functionality
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "takeScreenshot") {
        const { scrollHeight, clientHeight } = document.documentElement;
        const devicePixelRatio = window.devicePixelRatio || 1;

        let capturedHeight = 0;
        let capturedImages = [];

        const captureAndScroll = () => {
            const scrollAmount = clientHeight;

            chrome.runtime.sendMessage({ 
                action: "captureVisibleTab", 
                pixelRatio: devicePixelRatio 
            }, (dataUrl) => {
                capturedImages.push(dataUrl);
                capturedHeight += scrollAmount;

                if (capturedHeight < scrollHeight) {
                    // Scroll to the next part of the page
                    window.scrollTo(0, capturedHeight);
                    // Wait for any dynamic content to load
                    setTimeout(captureAndScroll, 500);
                } else {
                    // All parts captured, send back the array of images
                    sendResponse({ images: capturedImages });
                }
            });
        };

        // Start capturing and scrolling
        captureAndScroll();
        return true; // Keep the message channel open for async response
    }
    return true;
}); 