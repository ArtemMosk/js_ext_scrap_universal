// B6 regression (design doc §21): a FAILED conversation task must never store the new reuse
// context — otherwise the next identical request would skip uploadFile although the reference
// was never actually attached (fail-loud violation).
// Run: node --test tests/reuseContext.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The runner module targets the extension runtime; stub the chrome API surface its imports
// touch at module scope so the PURE function under test is importable under plain node.
globalThis.chrome = {
    storage: {
        sync: { get: async () => ({}), set: async () => {} },
        session: { get: async () => ({}), set: async () => {} },
        local: { get: async () => ({}), set: async () => {} },
    },
    runtime: { sendMessage: () => {}, onMessage: { addListener: () => {} }, lastError: null },
    tabs: { sendMessage: async () => ({}), get: async () => ({}), query: async () => [] },
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
};

const { nextReuseContext } = await import('../interactionRunner.js');

const CTX = 'conversation|refs=abc123';

test('success claims the new context', () => {
    assert.equal(nextReuseContext({ success: true, reusedWithMatch: false, reuseContext: CTX }), CTX);
    assert.equal(nextReuseContext({ success: true, reusedWithMatch: true, reuseContext: CTX }), CTX);
});

test('failure on a NEW tab stores contextless — next request must re-upload (B6 core case)', () => {
    // e.g. first conversation request with ref A fails at uploadFile: the ref was never
    // attached, so the stored tab must NOT claim refs=A.
    assert.equal(nextReuseContext({ success: false, reusedWithMatch: false, reuseContext: CTX }), '');
});

test('failure while reusing a MATCHING context keeps it (established by a prior success)', () => {
    // the ref really is in the conversation from an earlier successful task; a later
    // mid-generation failure does not un-attach it.
    assert.equal(nextReuseContext({ success: false, reusedWithMatch: true, reuseContext: CTX }), CTX);
});

test('failure after a context MISMATCH reuse stores contextless', () => {
    // we reused the tab but context differed (so upload ran and failed) — nothing established.
    assert.equal(nextReuseContext({ success: false, reusedWithMatch: false, reuseContext: 'conversation|refs=NEW' }), '');
});

test('POISONED conversation always stores contextless — even after matching reuse (codex blocker 1)', () => {
    assert.equal(nextReuseContext({ success: false, reusedWithMatch: true, reuseContext: CTX, poisoned: true }), '');
    assert.equal(nextReuseContext({ success: true, reusedWithMatch: true, reuseContext: CTX, poisoned: true }), '');
});
