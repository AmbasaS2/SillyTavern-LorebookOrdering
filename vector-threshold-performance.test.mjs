import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
function between(a, b) {
    const start = source.indexOf(a), end = source.indexOf(b, start);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end);
}
function harness() {
    let hashes = 0, cloned = 0;
    class CloneMap extends Map {
        get(key) { cloned++; return structuredClone(super.get(key)); }
    }
    const cache = new CloneMap([['A', { stlo: {} }], ['B', { stlo: {} }]]);
    const requests = [];
    const names = ['A', 'B'];
    const nativeFetch = async (input, init) => {
        requests.push({ input, body: JSON.parse(init.body) });
        const ids = JSON.parse(init.body).collectionIds || [];
        return new Response(JSON.stringify(Object.fromEntries(ids.map(id => [id, { hashes: [id + '-1', id + '-2'], metadata: [{}, {}] }]))));
    };
    const context = vm.createContext({
        world_names: names, worldInfoCache: cache, Map, Set, Response, EXTENSION_NAME: 'stlo',
        window: { fetch: nativeFetch }, console,
        getStringHash(name) { hashes++; return name; },
    });
    vm.runInContext(between('function getCachedLorebook(world)', '\nfunction getJevCharacterAvatar') +
        between('let vectorCollectionNames =', '\n/**'), context);
    context.installPerLorebookVectorThresholds();
    return { context, names, cache, requests, counts: () => [hashes, cloned],
        query: (ids, threshold = 0.3) => context.window.fetch('/api/vector/query-multi', {
            body: JSON.stringify({ collectionIds: ids, threshold, topK: 2 })
        }) };
}
test('unchanged names reuse hashes; threshold changes use fresh scalar metadata without cloning', async () => {
    const h = harness();
    await h.query(['world_A', 'world_B']);
    await h.query(['world_A', 'world_B']);
    assert.deepEqual(h.counts(), [2, 0]);
    assert.equal(h.requests.length, 2);
    h.cache.set('A', { stlo: { vectorThreshold: 0.8, vectorThresholdEnabled: true } });
    await h.query(['world_A']);
    assert.equal(h.requests.at(-1).body.threshold, 0.8);
    h.cache.set('A', { stlo: { vectorThreshold: 0.8, vectorThresholdEnabled: false } });
    await h.query(['world_A']);
    assert.equal(h.requests.at(-1).body.threshold, 0.3);
    assert.deepEqual(h.counts(), [2, 0]);
});
test('in-place same-length rename invalidates the cached world mapping; native fallback is preserved', async () => {
    const h = harness();
    await h.query(['world_A']);
    h.names[0] = 'New';
    h.cache.set('New', { stlo: { vectorThreshold: 0.7, vectorThresholdEnabled: true } });
    await h.query(['world_New']);
    assert.equal(h.requests.at(-1).body.threshold, 0.7);
    await h.query(['world_A']);
    assert.equal(h.requests.at(-1).body.threshold, 0.3);
    assert.deepEqual(h.counts(), [4, 0]);
    const before = h.counts();
    await h.context.window.fetch('/api/vector/query-multi', { body: JSON.stringify({ collectionIds: ['chat_other'], threshold: 0.2 }) });
    assert.deepEqual(h.counts(), before);
});
test('distinct thresholds still split once per group and merge within the global topK', async () => {
    const h = harness();
    h.cache.set('A', { stlo: { vectorThreshold: 0.8, vectorThresholdEnabled: true } });
    const result = await (await h.query(['world_A', 'world_B'])).json();
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.requests.map(r => r.body.threshold).sort(), [0.3, 0.8]);
    assert.equal(Object.values(result).reduce((sum, data) => sum + data.hashes.length, 0), 2);
});
