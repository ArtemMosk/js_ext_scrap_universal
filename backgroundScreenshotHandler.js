import Logger from './logger.js';

const DEFAULT_CONTENT_SCREENSHOT_TIMEOUT_MS = 30000;
const DEFAULT_SCREENSHOT_IPC_MARGIN_MS = 5000;

function boundedPositiveMs(value, fallback, min = 50) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.max(min, n);
}

// Message handler for screenshot capture requests
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "captureVisibleTab") {
        chrome.tabs.captureVisibleTab(null, { 
            format: "png", 
            quality: 100 
        }, (dataUrl) => {
            sendResponse(dataUrl);
        });
        return true; // Keep message channel open for async response
    }
});

export default class ScreenshotCapture {
    constructor() {
        this.logger = new Logger('Screenshot');
    }

    async blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                resolve(reader.result);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    async captureFullPage(tabId, options = {}) {
        const contentTimeoutMs = boundedPositiveMs(
            options.contentTimeoutMs ?? options.timeoutMs,
            DEFAULT_CONTENT_SCREENSHOT_TIMEOUT_MS
        );
        const ipcMarginMs = boundedPositiveMs(
            options.ipcMarginMs,
            DEFAULT_SCREENSHOT_IPC_MARGIN_MS,
            0
        );
        const raceTimeoutMs = Number.isFinite(Number(options.raceTimeoutMs))
            ? Math.max(contentTimeoutMs, Number(options.raceTimeoutMs))
            : contentTimeoutMs + ipcMarginMs;
        let timeoutId = null;
        try {
            const capture = new Promise((resolve, reject) => {
                chrome.tabs.sendMessage(
                    tabId,
                    { action: "takeScreenshot", timeoutMs: contentTimeoutMs },
                    async (response) => {
                    if (chrome.runtime.lastError) {
                        this.logger.error('Screenshot capture failed', { 
                            error: chrome.runtime.lastError 
                        });
                        reject(chrome.runtime.lastError);
                        return;
                    }

                    try {
                        if (response && response.error && (!response.images || response.images.length === 0)) {
                            throw new Error(response.error);
                        }
                        const { images } = response || {};
                        if (!images || images.length === 0) {
                            throw new Error('No images captured');
                        }

                        // Create offscreen canvas
                        const canvas = new OffscreenCanvas(1, 1);
                        const ctx = canvas.getContext('2d');

                        // Load first image to get dimensions
                        const firstImageBlob = await fetch(images[0]).then(r => r.blob());
                        const firstBitmap = await createImageBitmap(firstImageBlob);

                        // Set canvas dimensions
                        canvas.width = firstBitmap.width;
                        canvas.height = firstBitmap.height * images.length;

                        // Draw each image
                        let yOffset = 0;
                        for (const dataUrl of images) {
                            const blob = await fetch(dataUrl).then(r => r.blob());
                            const bitmap = await createImageBitmap(blob);
                            ctx.drawImage(bitmap, 0, yOffset);
                            yOffset += firstBitmap.height;
                            bitmap.close();
                        }

                        firstBitmap.close();

                        // Convert to blob and resolve
                        const finalBlob = await canvas.convertToBlob({ 
                            type: 'image/png' 
                        });
                        resolve(await this.blobToBase64(finalBlob));

                    } catch (error) {
                        this.logger.error('Failed to process screenshots', { error });
                        reject(error);
                    }
                });
            });
            const timeout = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Error(`Screenshot capture timed out after ${raceTimeoutMs}ms`));
                }, raceTimeoutMs);
            });
            return await Promise.race([capture, timeout]);
        } catch (error) {
            this.logger.error(`Failed to capture full page screenshot for tab ${tabId}`, {
                error: error.message,
                stack: error.stack
            });
            throw error;
        } finally {
            if (timeoutId !== null) clearTimeout(timeoutId);
        }
    }
}
