// Adapter tests (Iteration 1, Phase 1.2): map transport outcomes to the controller's pollOnce
// contract. Load-bearing case (codex finding 5): a transport TIMEOUT must make the controller start a
// replacement poll — proven end-to-end, not just as an error label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePollOnce } from '../pollAdapter.js';
import { POLL_REQUEST_TIMEOUT_MS } from '../pollTransport.js';
import { PollController } from '../pollController.js';

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };
const authHeaders = async () => ({ Authorization: 'Bearer test' });
const noopDispatch = async () => {};
function timeoutError() { const e = new Error('timed out'); e.name = 'AbortError'; e.reason = 'timeout'; return e; }
function externalError() { const e = new Error('aborted'); e.name = 'AbortError'; e.reason = 'external'; return e; }
function waitFor(cond, timeoutMs = 1000, stepMs = 2) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const t = setInterval(() => {
            let ok = false; try { ok = cond(); } catch (_) { ok = false; }
            if (ok) { clearInterval(t); resolve(); } else if (Date.now() - start > timeoutMs) { clearInterval(t); reject(new Error('waitFor timeout')); }
        }, stepMs);
    });
}

test('timeout → pollOnce returns true (replacement poll)', async () => {
    const pollOnce = makePollOnce({ authHeaders, dispatch: noopDispatch, timeoutMs: 100, pollGetUrlImpl: async () => { throw timeoutError(); } });
    assert.equal(await pollOnce('http://c', { signal: new AbortController().signal }), true);
});

test('external abort → pollOnce re-throws (controller will see the abort, not an error)', async () => {
    const pollOnce = makePollOnce({ authHeaders, dispatch: noopDispatch, timeoutMs: 100, pollGetUrlImpl: async () => { throw externalError(); } });
    await assert.rejects(pollOnce('http://c', { signal: new AbortController().signal }), (e) => e.name === 'AbortError' && e.reason === 'external');
});

test('other error (auth/HTTP/network) → pollOnce re-throws (controller records exception)', async () => {
    const pollOnce = makePollOnce({ authHeaders, dispatch: noopDispatch, timeoutMs: 100, pollGetUrlImpl: async () => { throw new Error('storage unavailable'); } });
    await assert.rejects(pollOnce('http://c', { signal: new AbortController().signal }), /storage unavailable/);
});

test('payload → dispatch is called then pollOnce returns true', async () => {
    let dispatched = null;
    const pollOnce = makePollOnce({ authHeaders, timeoutMs: 100, dispatch: async (data) => { dispatched = data; }, pollGetUrlImpl: async () => ({ type: 'payload', data: { url: 'x' } }) });
    assert.equal(await pollOnce('http://c', { signal: new AbortController().signal }), true);
    assert.deepEqual(dispatched, { url: 'x' });
});

test('dispatch failure is classified at the adapter boundary', async () => {
    const pollOnce = makePollOnce({
        authHeaders,
        timeoutMs: 100,
        dispatch: async () => { throw new Error('handler failed'); },
        pollGetUrlImpl: async () => ({ type: 'payload', data: { url: 'x' } }),
    });
    await assert.rejects(
        pollOnce('http://c', { signal: new AbortController().signal }),
        (error) => /handler failed/.test(error.message) && error.pollCategory === 'dispatch',
    );
});

test('empty (204) → pollOnce returns true, no dispatch', async () => {
    let dispatchCalls = 0;
    const pollOnce = makePollOnce({ authHeaders, timeoutMs: 100, dispatch: async () => { dispatchCalls++; }, pollGetUrlImpl: async () => ({ type: 'empty' }) });
    assert.equal(await pollOnce('http://c', { signal: new AbortController().signal }), true);
    assert.equal(dispatchCalls, 0);
});

test('construction fails loud when payload dispatch is missing', () => {
    assert.throws(
        () => makePollOnce({ authHeaders, timeoutMs: 100 }),
        /requires a dispatch/,
    );
});

test('malformed and unknown transport outcomes fail loud instead of dropping work', async () => {
    for (const outcome of [null, { type: 'mystery' }, { type: 'payload', data: null }]) {
        const pollOnce = makePollOnce({
            authHeaders,
            dispatch: noopDispatch,
            timeoutMs: 100,
            pollGetUrlImpl: async () => outcome,
        });
        await assert.rejects(
            pollOnce('http://c', { signal: new AbortController().signal }),
            (error) => /malformed|unknown|without an object body/.test(error.message) &&
                error.pollCategory === 'protocol',
        );
    }
});

test('default timeout is the pinned 22s hold plus 5s client margin', async () => {
    let observedTimeout = null;
    const pollOnce = makePollOnce({
        authHeaders,
        dispatch: noopDispatch,
        pollGetUrlImpl: async (_url, options) => {
            observedTimeout = options.timeoutMs;
            return { type: 'empty' };
        },
    });
    await pollOnce('http://c', { signal: new AbortController().signal });
    assert.equal(observedTimeout, POLL_REQUEST_TIMEOUT_MS);
    assert.equal(POLL_REQUEST_TIMEOUT_MS, 27_000);
});

test('INTEGRATION: a transport timeout makes the CONTROLLER start a replacement poll', async () => {
    let calls = 0;
    const pollGetUrlImpl = async () => {
        calls += 1;
        if (calls === 1) { throw timeoutError(); }   // first held poll times out
        return { type: 'empty' };                     // subsequent polls: no work → keep polling
    };
    const pollOnce = makePollOnce({ authHeaders, dispatch: noopDispatch, timeoutMs: 100, pollGetUrlImpl });
    const ctl = new PollController({ pollOnce, logger: noopLogger, delayMs: 1 });
    ctl.setDesired({ controlUrl: 'A' });
    await waitFor(() => calls >= 2);   // the timeout did NOT stop polling — the controller repolled
    assert.ok(calls >= 2, 'a transport timeout must result in a replacement poll');
    ctl.setDesired(null);
    await waitFor(() => !ctl.isPolling());
});
