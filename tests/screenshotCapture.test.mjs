import { test } from 'node:test';
import assert from 'node:assert/strict';

test('content screenshot capture settles once when visible-tab capture stalls', async () => {
    let listener = null;
    const responses = [];

    globalThis.window = {
        location: { href: 'http://127.0.0.1/test_page', hostname: '127.0.0.1' },
        devicePixelRatio: 1,
        scrollTo: () => {},
    };
    globalThis.document = {
        documentElement: { scrollHeight: 2000, clientHeight: 1000 },
        body: { className: '' },
        querySelector: () => null,
    };
    globalThis.chrome = {
        runtime: {
            lastError: null,
            onMessage: {
                addListener: (fn) => { listener = fn; },
            },
            sendMessage: () => {
                // Simulate a wedged captureVisibleTab path: callback is never invoked.
            },
        },
    };

    await import(`../screenshotCapture.js?stall-test=${Date.now()}`);

    assert.equal(typeof listener, 'function');
    assert.equal(listener({ action: 'takeScreenshot', timeoutMs: 50 }, {}, (payload) => {
        responses.push(payload);
    }), true);

    await new Promise(resolve => setTimeout(resolve, 180));

    assert.equal(responses.length, 1);
    assert.equal(responses[0].error, 'CAPTURE_TIMEOUT');
    assert.deepEqual(responses[0].images, []);
});
