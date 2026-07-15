import assert from 'node:assert/strict';
import test from 'node:test';

import { LifecycleJournal } from '../lifecycleJournal.js';

function storageHarness() {
    const values = {};
    return {
        values,
        async get(key) { return { [key]: values[key] }; },
        async set(update) { Object.assign(values, structuredClone(update)); },
        async remove(key) { delete values[key]; },
        async getBytesInUse() { return 321; },
    };
}

test('journal stores only bounded lifecycle fields and excludes secrets/page data', async () => {
    const storage = storageHarness();
    const journal = new LifecycleJournal({ storage, sessionId: 'session-1' });
    await journal.append('poll_exit', {
        generation: 7,
        reason: 'exception',
        error: 'token=secret http://private.test/chat',
        controlUrl: 'http://private.test',
        dom: '<html>secret</html>',
        screenshot: 'base64-secret',
    });
    assert.deepEqual(storage.values.pollLifecycleJournal, [{
        sessionId: 'session-1',
        event: 'poll_exit',
        at: storage.values.pollLifecycleJournal[0].at,
        generation: 7,
        reason: 'exception',
        storageBytes: 321,
    }]);
    assert.doesNotMatch(JSON.stringify(storage.values), /secret|private\.test|html|screenshot/);
});

test('journal is bounded and preserves append order', async () => {
    const storage = storageHarness();
    const journal = new LifecycleJournal({ storage, maxEntries: 3, sessionId: 's' });
    await Promise.all([
        journal.append('one', { generation: 1 }),
        journal.append('two', { generation: 2 }),
        journal.append('three', { generation: 3 }),
        journal.append('four', { generation: 4 }),
    ]);
    assert.deepEqual(
        storage.values.pollLifecycleJournal.map((record) => record.event),
        ['two', 'three', 'four'],
    );
});

test('a hung journal write does not block lifecycle callers', async () => {
    const storage = storageHarness();
    storage.set = () => new Promise(() => {});
    const journal = new LifecycleJournal({ storage });
    journal.append('poll_exit');
    const winner = await Promise.race([
        Promise.resolve('control-continued'),
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 25)),
    ]);
    assert.equal(winner, 'control-continued');
});

test('clear removes all lifecycle evidence', async () => {
    const storage = storageHarness();
    const journal = new LifecycleJournal({ storage });
    await journal.append('boot');
    await journal.clear();
    assert.equal(storage.values.pollLifecycleJournal, undefined);
});
