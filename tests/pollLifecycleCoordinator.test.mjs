import assert from 'node:assert/strict';
import test from 'node:test';

import { PollLifecycleCoordinator } from '../pollLifecycleCoordinator.js';

function harness(initial = {}) {
    const values = { ...initial };
    const controller = {
        desired: undefined,
        calls: [],
        setDesired(value) { this.desired = value; this.calls.push(value); },
        whenSettled() { return Promise.resolve(); },
    };
    const alarms = {
        value: null,
        clears: 0,
        creates: 0,
        async get() { return this.value; },
        async clear() { this.clears += 1; this.value = null; return true; },
        create(name, options) { this.creates += 1; this.value = { name, ...options }; },
    };
    const storage = {
        async get() { return { ...values }; },
        async set(update) { Object.assign(values, update); },
        async clear() {
            for (const key of Object.keys(values)) { delete values[key]; }
        },
    };
    const events = [];
    const statuses = [];
    const coordinator = new PollLifecycleCoordinator({
        controller,
        storage,
        alarms,
        onEvent: (event) => events.push(event),
        onStatus: (status) => statuses.push(status),
    });
    return { coordinator, controller, alarms, storage, values, events, statuses };
}

test('boot with configured legacy profile adopts enabled intent and starts exactly one owner', async () => {
    const h = harness({ controlUrl: 'http://a.test', pollInterval: 30 });
    await h.coordinator.reconcile('boot');
    assert.deepEqual(h.controller.desired, { controlUrl: 'http://a.test' });
    assert.equal(h.alarms.creates, 1);
    assert.equal(h.alarms.value.periodInMinutes, 0.5);
    assert.equal(h.statuses.at(-1), 'Polling');
});

test('duplicate alarm reconcile keeps matching alarm and current desired URL', async () => {
    const h = harness({ controlUrl: 'http://a.test', pollInterval: 30, pollingEnabled: true });
    await h.coordinator.reconcile('boot');
    await h.coordinator.reconcile('alarm');
    assert.equal(h.alarms.creates, 1);
    assert.deepEqual(h.controller.calls, [
        { controlUrl: 'http://a.test' },
        { controlUrl: 'http://a.test' },
    ]);
});

test('overlapping A-B-C events coalesce before side effects and latest settings win', async () => {
    let releaseFirst;
    let reads = 0;
    const h = harness({ controlUrl: 'http://a.test', pollInterval: 30, pollingEnabled: true });
    h.storage.get = async () => {
        reads += 1;
        if (reads === 1) { await new Promise((resolve) => { releaseFirst = resolve; }); }
        return { ...h.values };
    };

    const a = h.coordinator.reconcile('A');
    await Promise.resolve();
    Object.assign(h.values, { controlUrl: 'http://b.test' });
    const b = h.coordinator.reconcile('B');
    Object.assign(h.values, { controlUrl: 'http://c.test' });
    const c = h.coordinator.reconcile('C');
    releaseFirst();
    await Promise.all([a, b, c]);

    assert.deepEqual(h.controller.calls, [{ controlUrl: 'http://c.test' }]);
    assert.equal(h.alarms.creates, 1);
});

test('explicit stop persists disabled intent and a late alarm cannot revive polling', async () => {
    const h = harness({ controlUrl: 'http://a.test', pollInterval: 30, pollingEnabled: true });
    await h.coordinator.reconcile('boot');
    await h.coordinator.stop('popup-stop');
    await h.coordinator.reconcile('late-alarm');
    assert.equal(h.values.pollingEnabled, false);
    assert.equal(h.controller.desired, null);
    assert.equal(h.alarms.value, null);
    assert.equal(h.controller.calls.filter(Boolean).length, 1);
});

test('start validates and persists settings before reconciling', async () => {
    const h = harness();
    await h.coordinator.start({ controlUrl: 'http://new.test', pollInterval: 45 }, 'popup-start');
    assert.deepEqual(h.values, {
        controlUrl: 'http://new.test', pollInterval: 45, pollingEnabled: true,
    });
    assert.deepEqual(h.controller.desired, { controlUrl: 'http://new.test' });
});

test('missing alarm is recreated without starting a second lifecycle owner', async () => {
    const h = harness({ controlUrl: 'http://a.test', pollInterval: 30, pollingEnabled: true });
    await h.coordinator.reconcile('boot');
    h.alarms.value = null;
    await h.coordinator.reconcile('alarm-missing');
    assert.equal(h.alarms.creates, 2);
    assert.deepEqual(h.controller.desired, { controlUrl: 'http://a.test' });
});

test('storage failure is fail-loud and does not mutate controller or alarm', async () => {
    const h = harness();
    h.storage.get = async () => { throw new Error('storage unavailable'); };
    await assert.rejects(h.coordinator.reconcile('boot'), /storage unavailable/);
    assert.equal(h.controller.calls.length, 0);
    assert.equal(h.alarms.creates, 0);
    assert.ok(h.events.some((event) => event.event === 'reconcile_failed'));
});

test('reload preparation synchronously suppresses relaunch without changing durable settings', () => {
    const h = harness({ controlUrl: 'http://a.test', pollingEnabled: true });
    h.coordinator.prepareReload('server-command');
    assert.equal(h.controller.desired, null);
    assert.equal(h.values.pollingEnabled, true);
    assert.ok(h.events.some((event) => event.event === 'reload_prepared'));
});

test('clear removes durable config and joins the stopped controller before resolving', async () => {
    const h = harness({ controlUrl: 'http://a.test', pollInterval: 30, pollingEnabled: true });
    let settleCalls = 0;
    h.controller.whenSettled = async () => { settleCalls += 1; };
    await h.coordinator.reconcile('boot');
    await h.coordinator.clear('reset');
    assert.deepEqual(h.values, {});
    assert.equal(h.controller.desired, null);
    assert.equal(settleCalls, 2);
});
