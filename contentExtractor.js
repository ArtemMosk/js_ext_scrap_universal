// Content extraction functionality

// Log when content script loads
chrome.runtime.sendMessage({
    type: 'content_log',
    message: `Content script loaded on ${window.location.href}`,
    level: 'info'
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "extract_content") {
        // Add extraction start logging
        console.log('[CONTENT_EXTRACTOR] Starting content extraction for:', window.location.href);
        
        // Also log to background
        chrome.runtime.sendMessage({
            type: 'content_log',
            message: `Starting content extraction for ${window.location.href}`,
            level: 'info'
        });
        const extractionStartTime = Date.now();
        
        // Detect infinite scroll or dynamic loading
        const detectInfiniteScroll = () => {
            const indicators = [
                // Common infinite scroll class names
                document.querySelector('.infinite-scroll'),
                document.querySelector('[data-infinite-scroll]'),
                document.querySelector('.load-more'),
                document.querySelector('.pagination-loading'),
                // Check for scroll event listeners on window
                window.onscroll !== null,
                // Check body height changes
                document.body.scrollHeight > window.innerHeight * 10 // Very tall pages
            ];
            
            const hasInfiniteScroll = indicators.some(indicator => !!indicator);
            if (hasInfiniteScroll) {
                console.warn('[CONTENT_EXTRACTOR] Detected possible infinite scroll on:', window.location.href);
            }
            return hasInfiniteScroll;
        };
        
        const getMainContent = () => {
            // Common selectors for main content
            const contentSelectors = [
                'main',
                'article',
                '[role="main"]',
                '.main-content',
                '#main-content',
                '.content',
                '#content',
                '.post-content',
                '.article-content',
                // Add more common content selectors as needed
            ];
            
            console.log('[CONTENT_EXTRACTOR] Trying content selectors...');

            // Try to find the main content element with timeout protection
            let mainContent = null;
            const selectorStartTime = Date.now();
            
            for (const selector of contentSelectors) {
                // Add timeout check for each selector
                if (Date.now() - selectorStartTime > 5000) {
                    console.error('[CONTENT_EXTRACTOR] Selector search timeout after 5 seconds');
                    break;
                }
                
                try {
                    const element = document.querySelector(selector);
                    if (element) {
                        console.log('[CONTENT_EXTRACTOR] Found content with selector:', selector);
                        mainContent = element;
                        break;
                    }
                } catch (e) {
                    console.error('[CONTENT_EXTRACTOR] Error with selector:', selector, e);
                }
            }

            // If no main content found, try to find the largest text container
            if (!mainContent) {
                console.log('[CONTENT_EXTRACTOR] No main content found with selectors, searching text containers...');
                const containerStartTime = Date.now();
                
                try {
                    // Limit the number of elements to check to prevent hanging
                    const allContainers = document.querySelectorAll('div, section');
                    console.log('[CONTENT_EXTRACTOR] Found', allContainers.length, 'containers to check');
                    
                    // Only check first 100 containers to prevent hanging
                    const containersToCheck = Array.from(allContainers).slice(0, 100);
                    
                    const textContainers = containersToCheck
                        .filter(el => {
                            // Add timeout check
                            if (Date.now() - containerStartTime > 3000) {
                                console.warn('[CONTENT_EXTRACTOR] Container search timeout');
                                return false;
                            }
                            
                            try {
                                const text = el.textContent.trim();
                                return text.length > 100; // Minimum text length to consider as main content
                            } catch (e) {
                                return false;
                            }
                        })
                        .sort((a, b) => {
                            try {
                                return b.textContent.length - a.textContent.length;
                            } catch (e) {
                                return 0;
                            }
                        });

                    if (textContainers.length > 0) {
                        mainContent = textContainers[0];
                        console.log('[CONTENT_EXTRACTOR] Found largest text container with', mainContent.textContent.length, 'chars');
                    }
                } catch (e) {
                    console.error('[CONTENT_EXTRACTOR] Error finding text containers:', e);
                }
            }

            return mainContent || document.body;
        };

        const removeNonEssentialElements = (element) => {
            console.log('[CONTENT_EXTRACTOR] Removing non-essential elements...');
            const removeStartTime = Date.now();
            
            // Limit clone size to prevent memory issues
            let clone;
            try {
                clone = element.cloneNode(true);
            } catch (e) {
                console.error('[CONTENT_EXTRACTOR] Failed to clone element:', e);
                return element; // Return original if cloning fails
            }
            
            // Elements to remove
            const selectorsToRemove = [
                'nav', 'header', 'footer', 'aside',
                '[role="navigation"]', '[role="complementary"]',
                '.nav', '.header', '.footer', '.sidebar',
                '.menu', '.navigation', '.ads', '.advertisement',
                '.social-share', '.related-posts', '.comments',
                '.cookie-notice', '.newsletter', '.popup',
                'script', 'style', 'noscript', 'iframe'
            ];

            selectorsToRemove.forEach(selector => {
                // Add timeout check for each selector
                if (Date.now() - removeStartTime > 5000) {
                    console.warn('[CONTENT_EXTRACTOR] Element removal timeout');
                    return;
                }
                
                try {
                    const elements = clone.querySelectorAll(selector);
                    console.log('[CONTENT_EXTRACTOR] Removing', elements.length, 'elements matching:', selector);
                    elements.forEach(el => el.remove());
                } catch (e) {
                    console.error('[CONTENT_EXTRACTOR] Error removing elements for selector:', selector, e);
                }
            });

            return clone;
        };

        // Add timeout wrapper for entire extraction process
        const EXTRACTION_TIMEOUT = 30000; // 30 seconds total timeout
        
        setTimeout(() => {
            console.error('[CONTENT_EXTRACTOR] Total extraction timeout after', EXTRACTION_TIMEOUT, 'ms');
            sendResponse({ 
                content: {
                    rawHtml: '<html><body>Extraction timeout</body></html>',
                    rawPurifiedContent: 'Content extraction timed out',
                    readableContent: 'Content extraction timed out', 
                    title: document.title || 'Timeout',
                    url: window.location.href,
                    error: 'EXTRACTION_TIMEOUT',
                    hasInfiniteScroll: detectInfiniteScroll()
                }
            });
        }, EXTRACTION_TIMEOUT);
        
        try {
            // Detect infinite scroll before processing
            const hasInfiniteScroll = detectInfiniteScroll();
            
            const mainContent = getMainContent();
            console.log('[CONTENT_EXTRACTOR] Main content element:', mainContent?.tagName, 'with', mainContent?.textContent?.length || 0, 'chars');
            
            const purifiedContent = removeNonEssentialElements(mainContent);
            
            // Get text content with size limits
            let rawPurifiedText = '';
            let readableText = '';
            
            try {
                // Limit text extraction to prevent hanging on huge pages
                rawPurifiedText = document.body.innerText?.substring(0, 1000000).trim() || ''; // 1MB limit
                readableText = purifiedContent.innerText?.substring(0, 500000).trim() || ''; // 500KB limit
            } catch (e) {
                console.error('[CONTENT_EXTRACTOR] Error extracting text:', e);
                rawPurifiedText = 'Error extracting text';
                readableText = 'Error extracting text';
            }
            
            // Limit HTML size
            let htmlContent = '';
            try {
                htmlContent = document.documentElement.outerHTML.substring(0, 2000000); // 2MB limit
            } catch (e) {
                console.error('[CONTENT_EXTRACTOR] Error getting HTML:', e);
                htmlContent = '<html><body>Error getting HTML</body></html>';
            }
            
            const content = {
                rawHtml: htmlContent,
                rawPurifiedContent: rawPurifiedText,
                readableContent: readableText,
                title: document.title || 'No title',
                url: window.location.href,
                extractionTime: Date.now() - extractionStartTime,
                hasInfiniteScroll: hasInfiniteScroll,
                debug: {
                    pageHeight: document.body.scrollHeight,
                    viewportHeight: window.innerHeight,
                    elementCount: document.querySelectorAll('*').length
                }
            };
            
            console.log('[CONTENT_EXTRACTOR] Extraction completed in', content.extractionTime, 'ms');
            console.log('[CONTENT_EXTRACTOR] Content sizes - HTML:', htmlContent.length, 'Raw:', rawPurifiedText.length, 'Readable:', readableText.length);
            
            sendResponse({ content });
        } catch (error) {
            console.error('[CONTENT_EXTRACTOR] Extraction failed:', error);
            sendResponse({ 
                content: {
                    rawHtml: '<html><body>Extraction error</body></html>',
                    rawPurifiedContent: error.message,
                    readableContent: error.message,
                    title: document.title || 'Error',
                    url: window.location.href,
                    error: error.message
                }
            });
        }
    }
    return true;
}); 