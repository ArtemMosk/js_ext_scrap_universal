import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Clear Settings delegates the reset transaction to the background owner', async () => {
    const messages = [];
    const handlers = {};
    const elements = {};
    const stubEl = (id) => (elements[id] ||= {
        value: '', textContent: '',
        addEventListener: (ev, fn) => { (handlers[id] ||= {})[ev] = fn; },
    });
    let domReady = null;
    globalThis.document = {
        getElementById: stubEl,
        addEventListener: (ev, fn) => { if (ev === 'DOMContentLoaded') domReady = fn; },
    };
    globalThis.confirm = () => true;
    globalThis.chrome = {
        storage: {
            sync: { get: async () => ({}), set: async () => {}, remove: async () => {},
                    clear: async () => { throw new Error('popup must not clear sync directly'); } },
            local: { get: async () => ({}), set: async () => {}, remove: async () => {
                throw new Error('popup must not clear credentials directly');
            } },
        },
        runtime: { sendMessage: (message, cb) => {
                       messages.push(message);
                       if (cb) cb({ status: 'Settings cleared' });
                   },
                   getManifest: () => ({ version: '1.3.13' }), id: 'test-ext' },
        tabs: { query: async () => [{ id: 1, url: 'http://x' }] },
    };

    await import(`../popup.js?ft1-test=${Date.now()}`);   // registers DOMContentLoaded
    assert.equal(typeof domReady, 'function');
    await domReady();                                     // registers the button click handlers
    assert.ok(handlers['clear-settings']?.click, 'clear-settings click handler registered');

    await handlers['clear-settings'].click();

    assert.deepEqual(messages.at(-1), { type: 'clear_settings' });
});
