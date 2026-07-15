import { test } from 'node:test';
import assert from 'node:assert/strict';

function memLocal(init = {}) {
    return {
        get: async (keys) => {
            const ks = Array.isArray(keys) ? keys : [keys];
            const out = {};
            for (const k of ks) if (k in init) out[k] = init[k];
            return out;
        },
    };
}

globalThis.chrome = {
    storage: { sync: { get: async () => ({}), set: async () => {}, remove: async () => {} },
               local: memLocal(), session: { get: async () => ({}), set: async () => {} } },
    runtime: { id: 'test-ext', getManifest: () => ({ name: 'x', version: '1.3.13' }),
               sendMessage: () => {}, onMessage: { addListener: () => {} }, lastError: null },
    scripting: { executeScript: async () => {} },
    tabs: { sendMessage: async () => ({ ok: true }) },
};

const { authHeaders, sendHeartbeat } = await import(`../interactionRunner.js?token-auth-test=${Date.now()}`);

test('authHeaders reads the bearer token from LOCAL storage, never sync', async () => {
    chrome.storage.local = memLocal({ apiToken: 'live-token' });
    chrome.storage.sync = { get: async () => ({ apiToken: 'stale-synced' }) };   // must be ignored
    const h = await authHeaders({ 'Content-Type': 'application/json' });
    assert.equal(h.Authorization, 'Bearer live-token');
    assert.equal(h['Content-Type'], 'application/json');
});

test('authHeaders adds no Authorization when there is no local token', async () => {
    chrome.storage.local = memLocal();
    const h = await authHeaders();
    assert.equal(h.Authorization, undefined);
});

test('authHeaders FAILS LOUD on a local-storage read error — never sends an unauthenticated request (B-M0-2)', async () => {
    chrome.storage.local = { get: async () => { throw new Error('storage unavailable'); } };
    // Must reject (so pollServer/submit stop) — NOT resolve to headers-without-Authorization.
    await assert.rejects(authHeaders({ 'Content-Type': 'application/json' }), /storage unavailable/);
});

test('sendHeartbeat OBSERVES an authHeaders rejection — no unhandled rejection, never beats unauthenticated (B-M0-2 heartbeat caller)', async () => {
    // authHeaders now REJECTS on storage fault; the fire-and-forget heartbeat is the one caller that
    // cannot observe a throw via `fetch(url,{headers:await authHeaders()}).catch()` (the await throws
    // before fetch is called, so .catch never attaches → unhandled rejection). sendHeartbeat awaits
    // authHeaders INSIDE its try, so the rejection is caught here instead of escaping.
    chrome.storage.local = { get: async () => { throw new Error('storage unavailable'); } };
    let fetchCalled = false;
    globalThis.fetch = async () => { fetchCalled = true; return { ok: true, text: async () => '' }; };
    // Must RESOLVE (rejection caught internally). If sendHeartbeat rejected, this await would throw
    // and fail the test — that is the unhandled-rejection regression we are guarding against.
    await sendHeartbeat('http://control.test', 'task-hb-1');
    assert.equal(fetchCalled, false);   // auth failed BEFORE the network call — no unauthenticated beat
});
