// Screenshot capture functionality
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "takeScreenshot") {
        const { scrollHeight, clientHeight } = document.documentElement;
        const devicePixelRatio = window.devicePixelRatio || 1;
        let capturedHeight = 0;
        let capturedImages = [];
        
        const captureAndScroll = async () => {
            const scrollAmount = clientHeight;
            try {
                // Check if we've reached the end BEFORE capturing
                const isLastCapture = capturedHeight + scrollAmount >= scrollHeight;
                
                // Always capture the current view
                const dataUrl = await new Promise((resolve, reject) => {
                    chrome.runtime.sendMessage({ 
                        action: "captureVisibleTab", 
                        pixelRatio: devicePixelRatio 
                    }, (response) => {
                        if (chrome.runtime.lastError) {
                            reject(chrome.runtime.lastError);
                            return;
                        }
                        resolve(response);
                    });
                });
                
                if (dataUrl) {
                    capturedImages.push(dataUrl);
                    capturedHeight += scrollAmount;
                    
                    // If this was the last capture, send response immediately
                    if (isLastCapture) {
                        sendResponse({ images: capturedImages });
                        return;
                    }
                    
                    // Otherwise, scroll and continue
                    window.scrollTo(0, capturedHeight);
                    await new Promise(resolve => setTimeout(resolve, 500));
                    await captureAndScroll();
                } else {
                    throw new Error('Screenshot capture returned null');
                }
            } catch (error) {
                console.error('Screenshot capture failed:', error);
                sendResponse({ images: capturedImages }); // Send what we have so far
            }
        };
        
        // Start capturing and scrolling
        captureAndScroll();
        return true; // Keep the message channel open for async response
    }
    return true;
});