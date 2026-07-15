import { test } from 'node:test';
import assert from 'node:assert/strict';

test('background screenshot capture waits past content timeout for partial response', async () => {
    let requestedContentTimeout = null;

    globalThis.chrome = {
        runtime: { lastError: null, onMessage: { addListener: () => {} } },
        storage: { local: { get: async () => ({}), set: async () => {} } },
        tabs: {
            sendMessage: (_tabId, message, callback) => {
                requestedContentTimeout = message.timeoutMs;
                setTimeout(() => {
                    callback({
                        images: ['data:image/png;base64,QQ=='],
                        error: 'CAPTURE_TIMEOUT',
                    });
                }, 70);
            },
        },
    };
    globalThis.fetch = async () => ({ blob: async () => ({}) });
    globalThis.createImageBitmap = async () => ({ width: 10, height: 10, close: () => {} });
    globalThis.OffscreenCanvas = class {
        constructor(width, height) {
            this.width = width;
            this.height = height;
        }
        getContext() {
            return { drawImage: () => {} };
        }
        async convertToBlob() {
            return {};
        }
    };
    globalThis.FileReader = class {
        readAsDataURL() {
            this.result = 'data:image/png;base64,QQ==';
            setTimeout(() => this.onloadend(), 0);
        }
    };

    const { default: ScreenshotCapture } = await import(
        `../backgroundScreenshotHandler.js?partial-margin-test=${Date.now()}`
    );
    const dataUrl = await new ScreenshotCapture().captureFullPage(
        1,
        { timeoutMs: 50, ipcMarginMs: 100 }
    );

    assert.equal(requestedContentTimeout, 50);
    assert.equal(dataUrl, 'data:image/png;base64,QQ==');
});
