// Obs-contract: click forwards text_match/exclude_within; trace frames are capped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
globalThis.chrome = {
    storage: { sync: { get: async () => ({}) }, session: { get: async () => ({}), set: async () => {} },
               local: { get: async () => ({}), set: async () => {} } },
    runtime: { id: 'test-ext', getManifest: () => ({ name: 'Test Extension', version: '1.3.9' }),
               sendMessage: () => {}, onMessage: { addListener: () => {} }, lastError: null },
    scripting: { executeScript: async () => {} },
    tabs: {
        create: async () => ({ id: 1, windowId: 7 }),
        get: async () => ({ id: 1, windowId: 7, url: 'https://chatgpt.com/c/test' }),
        remove: async () => {},
        query: async () => [],
        sendMessage: async () => ({})
    },
    windows: { update: async () => ({}) },
};
const { buildClickStep, pushFrame, MAX_TRACE_FRAMES, runInteractionTask } = await import('../interactionRunner.js');

test('click step forwards text_match + exclude_within (clickTextMatch capability)', () => {
    const wire = buildClickStep({ selector: 'button', pick: 'first',
        text_match: '^Retry$', exclude_within: '.foo' });
    assert.equal(wire.action, 'click');
    assert.equal(wire.text_match, '^Retry$');
    assert.equal(wire.exclude_within, '.foo');
});

test('trace frames are capped at MAX_TRACE_FRAMES (+1 marker), never unbounded', () => {
    const frames = [];
    let accepted = 0;
    for (let i = 0; i < MAX_TRACE_FRAMES + 20; i++) if (pushFrame(frames, { i })) accepted++;
    assert.equal(accepted, MAX_TRACE_FRAMES);
    assert.equal(frames.length, MAX_TRACE_FRAMES + 1);       // + one 'capped' marker
    assert.equal(frames[frames.length - 1].phase, 'capped');
});

test('failure evidence captures before cancel and submits normalized envelope', async () => {
    const calls = [];
    let submitted = null;

    globalThis.fetch = async (url, options = {}) => {
        if (String(url).endsWith('/submit_task')) {
            submitted = JSON.parse(options.body).result;
        }
        return { ok: true, status: 200, text: async () => '' };
    };

    chrome.tabs.sendMessage = async (_tabId, message, callback) => {
        if (message && message.action === 'takeScreenshot') {
            calls.push('screenshot');
            callback({ images: [] });
            return;
        }
        const step = message.step || {};
        if (step.action === 'detectTextPatterns') {
            calls.push(step.fail_on_match === false ? 'rate-probe' : 'rate-guard');
            return step.fail_on_match === false
                ? { ok: true, pattern_detected: 'rate_limit', snippet: 'too fast' }
                : { ok: true, pattern_detected: null };
        }
        if (step.action === 'click') {
            if (step.selector === 'button[data-testid="stop-button"]') {
                calls.push('cancel');
                return { ok: true };
            }
            calls.push('failing-click');
            return { ok: false, error: 'forced click failure', missing: false, disabled: false };
        }
        if (step.action === 'probe') {
            calls.push(calls.includes('cancel') ? 'post-probe' : 'pre-probe');
            return { ok: true, data: { text: '{"dom":true}' } };
        }
        return { ok: true, exists: true, visible: true, count: 1, naturalWidth: 0, src: '' };
    };

    await assert.rejects(
        runInteractionTask({
            task_id: 'obs-fail-order',
            task_type: 'browser_interaction',
            params: {
                debug_on_failure: true,
                cancel_selector: 'button[data-testid="stop-button"]',
                timeout_sec: 5,
                steps: [
                    { action: 'navigate', url: 'https://chatgpt.com/' },
                    { action: 'detectTextPatterns', label: 'rate_limit', patterns: ['too fast'],
                      fail_on_match: true },
                    { action: 'click', selector: '#never', wait_enabled_ms: 1 }
                ]
            }
        }, 'http://core.test', {
            waitForTabLoad: async () => {},
            networkTracker: { setTargetUrl: () => {} }
        }),
        /forced click failure/
    );

    assert.deepEqual(calls.slice(0, 6),
        ['rate-guard', 'failing-click', 'rate-probe', 'screenshot', 'pre-probe', 'cancel']);
    assert.equal(calls[6], 'post-probe');
    assert.equal(submitted.status, 'failed');
    assert.equal(submitted.metadata.rate_limited, true);
    assert.ok(submitted.metadata.evidence.failure.capture_errors[0].startsWith('screenshot:'));
    assert.equal(submitted.metadata.evidence.failure.dom, '{"dom":true}');
    assert.equal(submitted.metadata.evidence.post_cancel.dom, '{"dom":true}');
});

test('failure evidence screenshot timeout still submits DOM evidence', async () => {
    const calls = [];
    let submitted = null;

    globalThis.fetch = async (url, options = {}) => {
        if (String(url).endsWith('/submit_task')) {
            submitted = JSON.parse(options.body).result;
        }
        return { ok: true, status: 200, text: async () => '' };
    };

    chrome.tabs.sendMessage = async (_tabId, message, callback) => {
        if (message && message.action === 'takeScreenshot') {
            calls.push('screenshot-hung');
            return;
        }
        const step = message.step || {};
        if (step.action === 'type') {
            calls.push('failing-type');
            return { ok: false, error: 'type: no element matches "#never"' };
        }
        if (step.action === 'probe') {
            calls.push('probe');
            return { ok: true, data: { text: '{"dom":true}' } };
        }
        return { ok: true, exists: true, visible: true, count: 1, naturalWidth: 0, src: '' };
    };

    await assert.rejects(
        runInteractionTask({
            task_id: 'obs-fail-timeout',
            task_type: 'browser_interaction',
            params: {
                debug_on_failure: true,
                debug_screenshot_timeout_ms: 10,
                timeout_sec: 5,
                steps: [
                    { action: 'navigate', url: 'http://127.0.0.1/test_page' },
                    { action: 'type', selector: '#never', text: 'x' }
                ]
            }
        }, 'http://core.test', {
            waitForTabLoad: async () => {},
            networkTracker: { setTargetUrl: () => {} }
        }),
        /no element matches/
    );

    assert.deepEqual(calls, ['failing-type', 'screenshot-hung', 'probe']);
    assert.equal(submitted.status, 'failed');
    assert.match(submitted.metadata.evidence.failure.capture_errors[0],
                 /Screenshot capture timed out after 10ms/);
    assert.equal(submitted.metadata.evidence.failure.dom, '{"dom":true}');
});

test('failure evidence probe timeout still submits failed result', async () => {
    let submitted = null;

    globalThis.fetch = async (url, options = {}) => {
        if (String(url).endsWith('/submit_task')) {
            submitted = JSON.parse(options.body).result;
        }
        return { ok: true, status: 200, text: async () => '' };
    };

    chrome.tabs.sendMessage = async (_tabId, message, callback) => {
        if (message && message.action === 'takeScreenshot') {
            callback({ images: [] });
            return;
        }
        const step = message.step || {};
        if (step.action === 'type') {
            return { ok: false, error: 'type: no element matches "#never"' };
        }
        if (step.action === 'probe') {
            return new Promise(() => {});
        }
        return { ok: true, exists: true, visible: true, count: 1, naturalWidth: 0, src: '' };
    };

    await assert.rejects(
        runInteractionTask({
            task_id: 'obs-fail-probe-timeout',
            task_type: 'browser_interaction',
            params: {
                debug_on_failure: true,
                debug_step_timeout_ms: 10,
                timeout_sec: 5,
                steps: [
                    { action: 'navigate', url: 'http://127.0.0.1/test_page' },
                    { action: 'type', selector: '#never', text: 'x' }
                ]
            }
        }, 'http://core.test', {
            waitForTabLoad: async () => {},
            networkTracker: { setTargetUrl: () => {} }
        }),
        /no element matches/
    );

    assert.equal(submitted.status, 'failed');
    assert.match(
        submitted.metadata.evidence.failure.capture_errors.join('\n'),
        /probe response timed out after 50ms/
    );
});
