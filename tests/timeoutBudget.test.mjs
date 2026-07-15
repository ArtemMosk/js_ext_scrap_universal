import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.chrome = {
    storage: { sync: { get: async () => ({}) }, session: { get: async () => ({}), set: async () => {} },
               local: { get: async () => ({}), set: async () => {} } },
    runtime: { id: 'test-ext', getManifest: () => ({ name: 'Test Extension', version: '1.3.12' }),
               sendMessage: () => {}, onMessage: { addListener: () => {} }, lastError: null },
    scripting: { executeScript: async () => {} },
    tabs: { sendMessage: async () => ({ ok: true }) },
};

const {
    backgroundFetchImage,
    failureScreenshotTimeoutMs,
    responseTimeoutMs,
    sendStep,
} = await import(`../interactionRunner.js?timeout-budget-test=${Date.now()}`);

test('extractImage response budget includes encode/fetch margin beyond 15s generic bound', async () => {
    assert.equal(responseTimeoutMs({ action: 'extractImage', wait_ms: 15000 }), 25000);

    chrome.tabs.sendMessage = async () => new Promise(resolve => {
        setTimeout(() => resolve({ ok: true, data: { dataUrl: 'data:image/png;base64,QQ==' } }), 15100);
    });

    const started = Date.now();
    const result = await sendStep(1, { action: 'extractImage', wait_ms: 15000 });

    assert.equal(result.ok, true);
    assert.ok(Date.now() - started >= 15000);
});

test('background image fetch fallback is bounded and aborts stalled network work', async () => {
    globalThis.fetch = async (_url, options = {}) => new Promise((_resolve, reject) => {
        if (options.signal) {
            options.signal.addEventListener('abort', () => {
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
            });
        }
    });

    await assert.rejects(
        backgroundFetchImage('https://cdn.example.invalid/stalled.png', 25),
        /background image fetch timed out after 50ms/
    );
});

test('failure screenshot timeout uses bounded fallback semantics', () => {
    assert.equal(failureScreenshotTimeoutMs(-1), 8000);
    assert.equal(failureScreenshotTimeoutMs(0), 8000);
    assert.equal(failureScreenshotTimeoutMs(10), 50);
});
