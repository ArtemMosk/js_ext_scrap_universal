// Content extraction functionality
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "extract_content") {
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

            // Try to find the main content element
            let mainContent = null;
            for (const selector of contentSelectors) {
                const element = document.querySelector(selector);
                if (element) {
                    mainContent = element;
                    break;
                }
            }

            // If no main content found, try to find the largest text container
            if (!mainContent) {
                const textContainers = Array.from(document.querySelectorAll('div, section'))
                    .filter(el => {
                        const text = el.textContent.trim();
                        return text.length > 100; // Minimum text length to consider as main content
                    })
                    .sort((a, b) => b.textContent.length - a.textContent.length);

                if (textContainers.length > 0) {
                    mainContent = textContainers[0];
                }
            }

            return mainContent || document.body;
        };

        const removeNonEssentialElements = (element) => {
            const clone = element.cloneNode(true);
            
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
                const elements = clone.querySelectorAll(selector);
                elements.forEach(el => el.remove());
            });

            return clone;
        };

        const mainContent = getMainContent();
        const purifiedContent = removeNonEssentialElements(mainContent);
        
        const content = {
            rawHtml: document.documentElement.outerHTML,
            rawPurifiedContent: document.body.innerText.trim(), // All text from the page
            readableContent: purifiedContent.innerText.trim(), // Only main content text
            title: document.title,
            url: window.location.href
        };
        
        sendResponse({ content });
    }
    return true;
}); 