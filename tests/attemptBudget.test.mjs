// Budget math (codex blocker 3): attempts must FIT inside the task budget with stop margin.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.chrome = {
    storage: { sync: { get: async () => ({}) }, session: { get: async () => ({}), set: async () => {} },
               local: { get: async () => ({}) } },
    runtime: { sendMessage: () => {}, onMessage: { addListener: () => {} } },
    tabs: { sendMessage: async () => ({}) },
};
const { deriveAttemptBudget } = await import('../interactionRunner.js');

test('3 attempts fit inside the 320s default with 20s stop margin', () => {
    const budget = deriveAttemptBudget(320000, 2);
    assert.equal(budget, 100000);
    assert.ok(3 * budget + 20000 <= 320000);
});

test('never below the 15s floor; degenerate inputs safe', () => {
    assert.equal(deriveAttemptBudget(30000, 5), 15000);
    assert.equal(deriveAttemptBudget(240000, 0), 220000);
});
