// Failure matrix for the one-poll transport (Iteration 1, Phase 1.2). Proves semantics: 204, payload,
// non-OK, network error, and — the load-bearing distinction — external abort vs timeout carry
// different reasons, and an auth failure fails loud.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollGetUrl, POLL_RESULT } from '../pollTransport.js';

const authHeaders = async () => ({ Authorization: 'Bearer test' });

// A fetch that never resolves on its own — it only rejects when its signal aborts (models a held poll).
function hangingFetch() {
    return (_url, { signal } = {}) => new Promise((_resolve, reject) => {
        if (signal.aborted) { const e = new Error('already aborted'); e.name = 'AbortError'; return reject(e); }
        signal.addEventListener('abort', () => { const e = new Error('fetch aborted'); e.name = 'AbortError'; reject(e); }, { once: true });
    });
}

test('204 → EMPTY result', async () => {
    const fetchImpl = async () => ({ status: 204, ok: false });
    const r = await pollGetUrl('http://c', { authHeaders, fetchImpl, timeoutMs: 5000 });
    assert.equal(r.type, POLL_RESULT.EMPTY);
});

test('200 → PAYLOAD result with decoded data', async () => {
    const fetchImpl = async () => ({ status: 200, ok: true, json: async () => ({ type: 'url', url: 'http://x' }) });
    const r = await pollGetUrl('http://c', { authHeaders, fetchImpl, timeoutMs: 5000 });
    assert.equal(r.type, POLL_RESULT.PAYLOAD);
    assert.equal(r.data.url, 'http://x');
});

test('non-OK status throws (surfaced, not swallowed)', async () => {
    const fetchImpl = async () => ({ status: 401, ok: false });
    await assert.rejects(pollGetUrl('http://c', { authHeaders, fetchImpl, timeoutMs: 5000 }), /HTTP 401/);
});

test('network error propagates', async () => {
    const fetchImpl = async () => { throw new Error('network down'); };
    await assert.rejects(pollGetUrl('http://c', { authHeaders, fetchImpl, timeoutMs: 5000 }), /network down/);
});

test('EXTERNAL abort → AbortError with reason "external" (stop/reconfigure, NOT a timeout)', async () => {
    const ext = new AbortController();
    const p = pollGetUrl('http://c', { signal: ext.signal, authHeaders, fetchImpl: hangingFetch(), timeoutMs: 5000 });
    setTimeout(() => ext.abort(), 5);
    await assert.rejects(p, (e) => e.name === 'AbortError' && e.reason === 'external');
});

test('TIMEOUT → AbortError with reason "timeout" (triggers a replacement poll upstream)', async () => {
    await assert.rejects(
        pollGetUrl('http://c', { authHeaders, fetchImpl: hangingFetch(), timeoutMs: 5 }),
        (e) => e.name === 'AbortError' && e.reason === 'timeout',
    );
});

test('auth failure fails loud (authHeaders rejection propagates)', async () => {
    const badAuth = async () => { throw new Error('storage unavailable'); };
    const fetchImpl = async () => ({ status: 204, ok: false });
    await assert.rejects(pollGetUrl('http://c', { authHeaders: badAuth, fetchImpl, timeoutMs: 5000 }), /storage unavailable/);
});

// codex finding 1: cancellation must cover the (non-abortable) authHeaders read, and a real auth
// failure must never be masked as a timeout.
test('CANCELLATION covers a hung authHeaders: external abort rejects promptly (reason external)', async () => {
    const hungAuth = () => new Promise(() => {});   // a storage read that never settles
    const ext = new AbortController();
    const p = pollGetUrl('http://c', { signal: ext.signal, authHeaders: hungAuth, fetchImpl: async () => ({ status: 204, ok: false }), timeoutMs: 5000 });
    setTimeout(() => ext.abort(), 5);
    // If cancellation did not cover auth, this would hang until the test times out.
    await assert.rejects(p, (e) => e.name === 'AbortError' && e.reason === 'external');
});

test('CANCELLATION covers a hung authHeaders: timeout rejects (reason timeout)', async () => {
    const hungAuth = () => new Promise(() => {});
    await assert.rejects(
        pollGetUrl('http://c', { authHeaders: hungAuth, fetchImpl: async () => ({ status: 204, ok: false }), timeoutMs: 5 }),
        (e) => e.name === 'AbortError' && e.reason === 'timeout',
    );
});

test('a DELAYED auth failure fails loud (NOT masked as timeout) when it settles before the timeout', async () => {
    const delayedBadAuth = () => new Promise((_r, reject) => setTimeout(() => reject(new Error('storage unavailable')), 5));
    await assert.rejects(
        pollGetUrl('http://c', { authHeaders: delayedBadAuth, fetchImpl: async () => ({ status: 204, ok: false }), timeoutMs: 300 }),
        /storage unavailable/,
    );
});
