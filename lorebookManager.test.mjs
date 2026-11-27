import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { withSlothLorebookWriteLane } from './slothWriteLane.js';

const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
function extract(start, end) {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    assert.ok(a >= 0 && b > a, start);
    return source.slice(a, b);
}

const helpers = extract('function equalBookSetting(', '/**\n * Get the currently active/selected lorebook name');
const patchHelper = extract('function changedBookFields(', 'function summarizeBook(');
function harness({ failWrite = false, failVerify = false } = {}) {
    const original = {
        entries: { 0: { uid: 0, content: 'Unchanged original lore.' } },
        stlo: { priority: 3, budget: 1200, jevExclude: true, characterOverrides: { A: { priority: 4, orderAdjustment: 13, budget: 100 } } },
    };
    const disk = new Map([['Book', structuredClone(original)]]);
    const cache = new Map([['Book', structuredClone(original)]]);
    const writes = [], reads = [];
    const state = { scanWorldSettings: new Map([['Book', {}]]), scanBudgetWorlds: new Set(['Book']), scanHasExplicitBudgets: true };
    const vm = {
        withSlothLorebookWriteLane, structuredClone,
        EXTENSION_NAME: 'stlo', EXTENSION_STATE: state, world_names: ['Book'], worldInfoCache: cache,
        loadWorldInfo: async name => structuredClone(cache.get(name) ?? disk.get(name)),
        saveWorldInfo: async (name, data, immediately) => {
            assert.equal(immediately, true);
            writes.push(name);
            cache.set(name, structuredClone(data));
            if (!failWrite) disk.set(name, structuredClone(data));
        },
        getRequestHeaders: () => ({}),
        fetch: async (route, opts) => {
            assert.equal(route, '/api/worldinfo/get');
            const name = JSON.parse(opts.body).name;
            reads.push(name);
            return { ok: (!failVerify || reads.length === 1) && disk.has(name), json: async () => structuredClone(disk.get(name)) };
        },
        console: { error() {} },
    };
    const api = runInNewContext(helpers + patchHelper + '\n({equalBookSetting, changedBookFields, setLorebookSettings})', vm);
    return { ...api, disk, cache, original, writes, reads, state };
}

test('manager diffs nested data by value and leaves unchanged settings untouched', () => {
    const h = harness();
    const before = { priority: null, budget: 0, characterOverrides: { A: { priority: 3, orderAdjustment: 0 } } };
    const next = { priority: null, budget: 4000, characterOverrides: { A: { orderAdjustment: 0, priority: 3 } } };
    assert.deepEqual(JSON.parse(JSON.stringify(h.changedBookFields(before, next))), { budget: 4000 });
    assert.equal(h.equalBookSetting({ a: 1 }, { a: '1' }), false);
    assert.equal(h.equalBookSetting([1, 2], { 0: 1, 1: 2 }), false);
});

test('verified native save patches only changed STLO values, preserves lore and unknown settings', async () => {
    const h = harness();
    assert.equal(await h.setLorebookSettings('Book', { budget: 6000 }), true);
    assert.deepEqual(h.disk.get('Book').entries, h.original.entries);
    assert.deepEqual(h.disk.get('Book').stlo, { ...h.original.stlo, budget: 6000 });
    assert.deepEqual(h.writes, ['Book']);
    assert.deepEqual(h.reads, ['Book', 'Book']);
    assert.equal(h.state.scanWorldSettings.size, 0);
    assert.equal(h.state.scanHasExplicitBudgets, false);
});

test('silent native write failure is not reported as a successful save', async () => {
    const h = harness({ failWrite: true });
    assert.equal(await h.setLorebookSettings('Book', { budget: 6000 }), false);
    assert.deepEqual(h.disk.get('Book'), h.original);
    assert.equal(h.cache.has('Book'), false);
    assert.equal(h.state.scanWorldSettings.size, 0);
});

test('verification failure evicts optimistic cache without deleting persisted data', async () => {
    const h = harness({ failVerify: true });
    assert.equal(await h.setLorebookSettings('Book', { budget: 6000 }), false);
    assert.equal(h.disk.get('Book').stlo.budget, 6000);
    assert.equal(h.cache.has('Book'), false);
});

test('missing books are not recreated by manager save', async () => {
    const h = harness();
    assert.equal(await h.setLorebookSettings('Missing', { budget: 6000 }), false);
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.reads, []);
});

test('Ordering waits for a same-page memory write and reads the fresh book inside the lane', async () => {
    const h = harness();
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { started = resolve; });
    const memoryLane = (await import('./slothWriteLane.js?memory-books')).withSlothLorebookWriteLane;
    const memory = memoryLane('Book', async () => {
        started(); await gate;
        const next = structuredClone(h.disk.get('Book'));
        next.entries[1] = { uid: 1, content: 'new memory' };
        h.disk.set('Book', next); h.cache.set('Book', structuredClone(next));
    });
    await ready;
    const ordering = h.setLorebookSettings('Book', { budget: 4000 });
    await Promise.resolve();
    assert.deepEqual(h.reads, []);
    release(); await memory;
    assert.equal(await ordering, true);
    assert.equal(h.disk.get('Book').entries[1].content, 'new memory');
    assert.equal(h.disk.get('Book').stlo.budget, 4000);
});
test('pending native edits are rejected without erasing the cache or writing', async () => {
    const h = harness();
    h.cache.get('Book').entries[0].content = 'unsaved native edit';
    assert.equal(await h.setLorebookSettings('Book', { budget: 4000 }), false);
    assert.deepEqual(h.writes, []);
    assert.equal(h.cache.get('Book').entries[0].content, 'unsaved native edit');
    assert.deepEqual(h.disk.get('Book'), h.original);
});
