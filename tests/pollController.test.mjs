// Regression suite for the desired-state PollController (Iteration 1). IN the normal suite so
// `npm test` guards it. Exercises the REAL controller + REAL StateLock; only chrome.storage is mocked
// with a fault injector (the actual environmental trigger). Covers: the dead-until-reload poison, the
// real lock acquire/release throw paths, graceful stop, latest-wins dedupe, 2-command overlap, and the
// 3-command A/B/C race that command-style ownership could not serialize.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PollController } from '../pollController.js';
import { StateLock } from '../stateLock.js';

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

function exitRecorder(onEvent = null) {
    const events = [];
    return {
        events,
        onExit(event) {
            events.push(event);
            return onEvent ? onEvent(event) : undefined;
        },
    };
}

// Deterministic wait: poll a condition until true or timeout (no fixed sleeps racing the loop).
function waitFor(cond, timeoutMs = 1000, stepMs = 2) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const t = setInterval(() => {
            let ok = false;
            try { ok = cond(); } catch (_) { ok = false; }
            if (ok) { clearInterval(t); resolve(); }
            else if (Date.now() - start > timeoutMs) { clearInterval(t); reject(new Error('waitFor timeout')); }
        }, stepMs);
    });
}

// A poll that records each call and, for URLs in `blockUrls`, holds until aborted (models a held poll).
function makeBlockingPollOnce(calls, blockUrls = new Set()) {
    return async (url, opts = {}) => {
        calls.push(url);
        if (blockUrls.has(url)) {
            // A held poll ends only via abort (never resolves) — models the real 20-25s server hold.
            await new Promise((_resolve, reject) => {
                if (opts.signal) opts.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            });
        }
        return true;
    };
}

// Real-lock poll: mirrors production (bg:422 acquire → body → finally release), both able to throw.
function realLockChrome() {
    const map = new Map();
    const fp = { failGet: false, failRemove: false };
    globalThis.chrome = { storage: { local: {
        async get(k) { if (fp.failGet) { fp.failGet = false; throw new Error('storage.get injected'); } return map.has(k) ? { [k]: map.get(k) } : {}; },
        async set(o) { for (const [k, v] of Object.entries(o)) map.set(k, v); },
        async remove(k) { if (fp.failRemove) { fp.failRemove = false; throw new Error('storage.remove injected'); } map.delete(k); },
    } } };
    return fp;
}
function realLockPollOnce(lock) {
    return async (_url) => {
        const lockId = await lock.tryAcquireLock('polling', 3, 1000);   // acquire — can THROW
        if (!lockId) { return false; }
        try { return true; } finally { await lock.releaseLock('polling', lockId); }   // release — can THROW
    };
}

test('POISON: a poll exception clears the run (not poisoned); a later setDesired relaunches (alarm recovery)', async () => {
    const exits = exitRecorder();
    let calls = 0;
    const pollOnce = async () => { calls++; throw new Error('storage unavailable (injected)'); };
    const ctl = new PollController({ pollOnce, logger: noopLogger, onExit: exits.onExit, delayMs: 1 });

    ctl.setDesired({ controlUrl: 'A' });
    await waitFor(() => exits.events.length >= 1);
    assert.equal(ctl.isPolling(), false, 'run must be cleared after an exception, not poisoned');
    assert.equal(exits.events[0].reason, 'exception');
    assert.equal(exits.events[0].error, 'storage unavailable (injected)');
    assert.equal(exits.events[0].errorCategory, 'runtime');
    assert.equal(calls, 1);

    ctl.setDesired({ controlUrl: 'A' });        // simulate the recovery alarm
    await waitFor(() => calls >= 2);
    assert.ok(calls >= 2, 'a later setDesired must relaunch the run (no stuck state)');
    ctl.setDesired(null);
    await waitFor(() => !ctl.isPolling());
});

test('REAL LOCK / acquire throw: a chrome.storage.get rejection at lock-acquire clears the run', async () => {
    const fp = realLockChrome();
    const lock = new StateLock(noopLogger);
    const exits = exitRecorder();
    const ctl = new PollController({ pollOnce: realLockPollOnce(lock), logger: noopLogger, onExit: exits.onExit, delayMs: 1 });
    fp.failGet = true;
    ctl.setDesired({ controlUrl: 'A' });
    await waitFor(() => exits.events.some((event) => event.reason === 'exception'));
    assert.equal(ctl.isPolling(), false);
    ctl.setDesired(null);
});

test('REAL LOCK / release throw: a chrome.storage.remove rejection during releaseLock clears the run', async () => {
    const fp = realLockChrome();
    const lock = new StateLock(noopLogger);
    const exits = exitRecorder();
    const ctl = new PollController({ pollOnce: realLockPollOnce(lock), logger: noopLogger, onExit: exits.onExit, delayMs: 1 });
    fp.failRemove = true;
    ctl.setDesired({ controlUrl: 'A' });
    await waitFor(() => exits.events.some((event) => event.reason === 'exception'));
    assert.equal(ctl.isPolling(), false);
    ctl.setDesired(null);
});

test('CONTROL: pollOnce returning false stops gracefully (reason poll_returned_false)', async () => {
    const exits = exitRecorder();
    const ctl = new PollController({ pollOnce: async () => false, logger: noopLogger, onExit: exits.onExit, delayMs: 1 });
    ctl.setDesired({ controlUrl: 'A' });
    await waitFor(() => exits.events.length >= 1);
    assert.equal(exits.events[0].reason, 'poll_returned_false');
    assert.equal(ctl.isPolling(), false);
});

test('STOP: setDesired(null) aborts and joins the run (reason stopped)', async () => {
    const exits = exitRecorder();
    const calls = [];
    const ctl = new PollController({ pollOnce: makeBlockingPollOnce(calls, new Set(['A'])), logger: noopLogger, onExit: exits.onExit, delayMs: 1 });
    ctl.setDesired({ controlUrl: 'A' });
    await waitFor(() => ctl.isPolling() && calls.length >= 1);
    ctl.setDesired(null);
    await waitFor(() => !ctl.isPolling());
    await waitFor(() => exits.events.length >= 1);
    assert.equal(exits.events[0].reason, 'stopped');
});

test('DEDUPE: setDesired(sameUrl) while already polling does not relaunch (one generation)', async () => {
    const calls = [];
    const ctl = new PollController({ pollOnce: makeBlockingPollOnce(calls, new Set(['A'])), logger: noopLogger, delayMs: 1 });
    ctl.setDesired({ controlUrl: 'A' });
    await waitFor(() => ctl.isPolling());
    const g1 = ctl.currentGeneration();
    ctl.setDesired({ controlUrl: 'A' });        // same URL — must be a no-op
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(ctl.currentGeneration(), g1, 'same-URL desired must not relaunch');
    assert.equal(calls.filter((u) => u === 'A').length, 1, 'no extra poll from a duplicate desired');
    ctl.setDesired(null);
    await waitFor(() => !ctl.isPolling());
});

test('OVERLAP: setDesired(A) → setDesired(null) → setDesired(B) — A must not poll again; end on B', async () => {
    const calls = [];
    const ctl = new PollController({ pollOnce: makeBlockingPollOnce(calls, new Set(['A', 'B'])), logger: noopLogger, delayMs: 1 });
    ctl.setDesired({ controlUrl: 'A' });
    await waitFor(() => calls.includes('A'));
    ctl.setDesired(null);
    ctl.setDesired({ controlUrl: 'B' });
    await waitFor(() => ctl.activeUrl() === 'B');
    assert.equal(calls.filter((u) => u === 'A').length, 1, 'stopped A must not poll again');
    assert.equal(ctl.activeUrl(), 'B');
    ctl.setDesired(null);
    await waitFor(() => !ctl.isPolling());
});

test('A/B/C RACE: setDesired(A) then setDesired(B),setDesired(C) while A stops — end on C, B never polls', async () => {
    const calls = [];
    const ctl = new PollController({ pollOnce: makeBlockingPollOnce(calls, new Set(['A', 'C'])), logger: noopLogger, delayMs: 1 });
    ctl.setDesired({ controlUrl: 'A' });
    await waitFor(() => calls.includes('A'));   // A is held in-flight
    ctl.setDesired({ controlUrl: 'B' });        // begins reconcile: abort+join A
    ctl.setDesired({ controlUrl: 'C' });        // arrives while A is stopping — must coalesce to C
    await waitFor(() => ctl.activeUrl() === 'C');
    assert.equal(ctl.activeUrl(), 'C', 'latest command C must win');
    assert.equal(calls.filter((u) => u === 'B').length, 0, 'B was superseded by C before polling — never polls');
    assert.equal(calls.filter((u) => u === 'A').length, 1, 'A polled once then aborted, never again');
    ctl.setDesired(null);
    await waitFor(() => !ctl.isPolling());
});

test('STALE COMPLETION: an aborted old poll that resolves late cannot overlap or clobber latest desired', async () => {
    const calls = [];
    let active = 0;
    let maxActive = 0;
    const pollOnce = async (url, { signal }) => {
        calls.push(url);
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
            await new Promise((resolve) => {
                signal.addEventListener('abort', () => setTimeout(resolve, 10), { once: true });
            });
            return true; // stale transport resolves successfully after abort instead of rejecting
        } finally {
            active -= 1;
        }
    };
    const ctl = new PollController({ pollOnce, logger: noopLogger, delayMs: 1 });
    ctl.setDesired({ controlUrl: 'A' });
    await waitFor(() => calls.includes('A'));
    ctl.setDesired({ controlUrl: 'B' });
    ctl.setDesired({ controlUrl: 'C' });
    await waitFor(() => ctl.activeUrl() === 'C');
    assert.equal(maxActive, 1, 'the next generation must wait for stale completion to join');
    assert.equal(calls.filter((url) => url === 'B').length, 0, 'superseded B never polls');
    assert.equal(ctl.activeUrl(), 'C', 'late A completion cannot clear C');
    ctl.setDesired(null);
    await waitFor(() => !ctl.isPolling());
});

test('100-ROUND SETTINGS CHURN: every A/B/C burst ends on C and B never polls', async () => {
    const calls = [];
    const blockUrls = new Set();
    const ctl = new PollController({
        pollOnce: makeBlockingPollOnce(calls, blockUrls),
        logger: noopLogger,
        delayMs: 1,
    });

    for (let i = 0; i < 100; i += 1) {
        const a = `A-${i}`;
        const b = `B-${i}`;
        const c = `C-${i}`;
        blockUrls.add(a);
        blockUrls.add(c);
        ctl.setDesired({ controlUrl: a });
        await waitFor(() => ctl.activeUrl() === a && calls.includes(a));
        ctl.setDesired({ controlUrl: b });
        ctl.setDesired({ controlUrl: c });
        await waitFor(() => ctl.activeUrl() === c && calls.includes(c));
        assert.equal(calls.filter((url) => url === b).length, 0, `round ${i}: B must never poll`);
    }

    ctl.setDesired(null);
    await waitFor(() => !ctl.isPolling());
});

// The controller emits ordered immutable events but never awaits the observability sink. Persistence
// and bounded journal ordering belong to Phase 1.4, outside lifecycle control.
test('OBSERVABILITY cannot block or reorder control: a hung exit sink does not block A→B', async () => {
    const exits = exitRecorder(() => new Promise(() => {}));
    const calls = [];
    const ctl = new PollController({ pollOnce: makeBlockingPollOnce(calls, new Set(['A', 'B'])), logger: noopLogger, onExit: exits.onExit, delayMs: 1 });
    ctl.setDesired({ controlUrl: 'A' });
    await waitFor(() => calls.includes('A'));
    ctl.setDesired({ controlUrl: 'B' });                 // stop A (exit journal will hang), launch B
    await waitFor(() => ctl.activeUrl() === 'B');         // B MUST launch despite the stuck journal write
    assert.equal(ctl.activeUrl(), 'B');
    ctl.setDesired(null);
    await waitFor(() => !ctl.isPolling());
    assert.deepEqual(exits.events.map((event) => event.generation), [1, 2]);
    assert.ok(Object.isFrozen(exits.events[0]), 'exit events are immutable at the boundary');
});

test('whenSettled proves an explicit stop aborted and joined the held request', async () => {
    const calls = [];
    const ctl = new PollController({
        pollOnce: makeBlockingPollOnce(calls, new Set(['A'])),
        logger: noopLogger,
        delayMs: 1,
    });
    ctl.setDesired({ controlUrl: 'A' });
    await waitFor(() => calls.includes('A'));
    ctl.setDesired(null);
    await ctl.whenSettled();
    assert.equal(ctl.isPolling(), false);
    assert.equal(ctl.activeUrl(), null);
});
