import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resetExtensionSettings } from '../settingsReset.js';

test('reset joins polling before removing token, journal, processing state, and reuse context', async () => {
    const order = [];
    let releaseJoin;
    const joined = new Promise((resolve) => { releaseJoin = resolve; });
    const coordinator = {
        async clear() { order.push('stop-start'); await joined; order.push('stop-joined'); },
    };
    const journal = { async clear() { order.push('journal'); } };
    const localStorage = {
        async remove(keys) {
            order.push('local');
            assert.ok(keys.includes('apiToken'));
            assert.ok(keys.includes('state_processing'));
        },
    };
    const sessionStorage = {
        async remove(keys) {
            order.push('session');
            assert.deepEqual(keys, ['reuseTabId', 'reuseContext']);
        },
    };

    const reset = resetExtensionSettings({ coordinator, journal, localStorage, sessionStorage });
    await Promise.resolve();
    assert.deepEqual(order, ['stop-start']);
    releaseJoin();
    await reset;
    assert.deepEqual(order, ['stop-start', 'stop-joined', 'journal', 'local', 'session']);
});

test('reset failure preserves the token when polling cannot be joined', async () => {
    let localRemoved = false;
    await assert.rejects(
        resetExtensionSettings({
            coordinator: { async clear() { throw new Error('storage unavailable'); } },
            journal: { async clear() {} },
            localStorage: { async remove() { localRemoved = true; } },
        }),
        /storage unavailable/,
    );
    assert.equal(localRemoved, false);
});
