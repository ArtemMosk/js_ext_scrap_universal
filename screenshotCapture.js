// Screenshot capture functionality
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "takeScreenshot") {
        console.log('[SCREENSHOT] Starting screenshot capture for:', window.location.href);
        const captureStartTime = Date.now();
        const requestedTimeout = Number.isFinite(Number(request.timeoutMs))
            ? Math.max(50, Number(request.timeoutMs))
            : 30000;
        
        const { scrollHeight, clientHeight } = document.documentElement;
        const devicePixelRatio = window.devicePixelRatio || 1;
        let capturedHeight = 0;
        let capturedImages = [];
        let captureCount = 0;
        
        // Detect problematic page conditions
        const pageInfo = {
            url: window.location.href,
            scrollHeight: scrollHeight,
            clientHeight: clientHeight,
            totalScreenshots: Math.ceil(scrollHeight / clientHeight),
            hasInfiniteScroll: scrollHeight > clientHeight * 20 // More than 20 viewports
        };
        
        console.log('[SCREENSHOT] Page info:', pageInfo);
        
        // Set reasonable limits
        const MAX_SCREENSHOTS = 10; // Limit to 10 screenshots max
        const CAPTURE_TIMEOUT = Math.min(30000, requestedTimeout); // total timeout
        const MAX_PAGE_HEIGHT = clientHeight * 15; // Max 15 viewports
        let settled = false;

        const settle = (payload) => {
            if (settled) return true;
            settled = true;
            clearTimeout(timeoutId);
            sendResponse(payload);
            return true;
        };

        const remainingMs = () => Math.max(0, CAPTURE_TIMEOUT - (Date.now() - captureStartTime));
        
        // Set overall timeout
        const timeoutId = setTimeout(() => {
            console.error('[SCREENSHOT] Total capture timeout after', CAPTURE_TIMEOUT, 'ms');
            settle({
                images: capturedImages,
                error: 'CAPTURE_TIMEOUT',
                debug: {
                    capturedCount: captureCount,
                    timeElapsed: Date.now() - captureStartTime
                }
            });
        }, CAPTURE_TIMEOUT);
        
        const captureAndScroll = async () => {
            const scrollAmount = clientHeight;
            try {
                if (settled) return;
                if (remainingMs() <= 0) {
                    settle({
                        images: capturedImages,
                        error: 'CAPTURE_TIMEOUT',
                        debug: {
                            capturedCount: captureCount,
                            timeElapsed: Date.now() - captureStartTime
                        }
                    });
                    return;
                }

                // Check capture limits
                if (captureCount >= MAX_SCREENSHOTS) {
                    console.warn('[SCREENSHOT] Reached max screenshot limit:', MAX_SCREENSHOTS);
                    settle({ images: capturedImages });
                    return;
                }
                
                // Check if we've captured enough for very tall pages
                if (capturedHeight >= MAX_PAGE_HEIGHT) {
                    console.warn('[SCREENSHOT] Reached max page height limit:', MAX_PAGE_HEIGHT);
                    settle({ images: capturedImages });
                    return;
                }
                
                // Check if we've reached the end BEFORE capturing
                const isLastCapture = capturedHeight + scrollAmount >= scrollHeight;
                
                console.log('[SCREENSHOT] Capture', captureCount + 1, '- Height:', capturedHeight, '/', scrollHeight);
                
                // Always capture the current view with individual timeout
                const captureTimeout = Math.max(100, Math.min(5000, remainingMs())); // 5 seconds per capture
                const dataUrl = await Promise.race([
                    new Promise((resolve, reject) => {
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
                    }),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Individual capture timeout')), captureTimeout)
                    )
                ]);
                
                if (dataUrl) {
                    capturedImages.push(dataUrl);
                    capturedHeight += scrollAmount;
                    captureCount++;
                    
                    console.log('[SCREENSHOT] Captured screenshot', captureCount, 'successfully');
                    
                    // If this was the last capture, send response immediately
                    if (isLastCapture) {
                        console.log('[SCREENSHOT] Reached end of page, total captures:', captureCount);
                        settle({
                            images: capturedImages,
                            debug: {
                                totalCaptures: captureCount,
                                totalTime: Date.now() - captureStartTime
                            }
                        });
                        return;
                    }
                    
                    // Otherwise, scroll and continue
                    window.scrollTo(0, capturedHeight);
                    
                    // Wait for content to settle, but not too long
                    await new Promise(resolve => setTimeout(resolve, 300));
                    
                    // Check for dynamic content loading
                    const newScrollHeight = document.documentElement.scrollHeight;
                    if (newScrollHeight > scrollHeight * 1.5) {
                        console.warn('[SCREENSHOT] Page height increased significantly, possible infinite scroll');
                        settle({
                            images: capturedImages,
                            warning: 'INFINITE_SCROLL_DETECTED'
                        });
                        return;
                    }
                    
                    await captureAndScroll();
                } else {
                    throw new Error('Screenshot capture returned null');
                }
            } catch (error) {
                console.error('[SCREENSHOT] Capture failed:', error);
                settle({
                    images: capturedImages,
                    error: error.message,
                    debug: {
                        capturedCount: captureCount,
                        failedAt: capturedHeight
                    }
                }); // Send what we have so far
            }
        };
        
        // For williamspaniel.com specifically, add detection
        if (window.location.hostname.includes('williamspaniel.com')) {
            console.warn('[SCREENSHOT] Special handling for williamspaniel.com');
            // Log any specific page characteristics
            console.log('[SCREENSHOT] Page characteristics:', {
                hasVideo: !!document.querySelector('video'),
                hasIframe: !!document.querySelector('iframe'),
                hasCanvas: !!document.querySelector('canvas'),
                bodyClasses: document.body.className,
                computedHeight: window.getComputedStyle(document.body).height
            });
        }
        
        // Start capturing and scrolling
        captureAndScroll().catch(error => {
            console.error('[SCREENSHOT] Unexpected error in captureAndScroll:', error);
            settle({
                images: capturedImages || [],
                error: 'UNEXPECTED_ERROR: ' + error.message
            });
        });
        
        return true; // Keep the message channel open for async response
    }
    return true;
});
