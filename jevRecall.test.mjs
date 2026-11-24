import test from 'node:test';
import assert from 'node:assert/strict';
import { applyJevRecall, fitJevRecall, jevEntryKey, normalizeJevBudget, prepareJevRecall, requestJevRecall } from './jevRecall.mjs';

const lore = (world, uid, text, flags = {}) => ({
    world, uid, comment: world+' '+uid, key: ['lantern'], content: text, vectorized: true, constant: false, ...flags,
});

test('Jev selects ordinary entries from all enabled books and preserves special and native entries', async () => {
    const worlds = new Set(['Memory', 'Core', 'World', 'NPC']);
    const positive = [...worlds].flatMap(world => [lore(world, 1, 'A lantern'), lore(world, 2, 'A fact')]);
    const rejected = lore('Memory', 3, 'Unrelated');
    const pinned = lore('Core', 10, 'Always on', { constant: true });
    const native = lore('Other', 1, 'Native keyword');
    const special = [
        lore('World', 3, 'Outlet', { position: 7 }),
        lore('World', 4, 'Disabled', { disable: true }),
        lore('Core', 5, 'Managed side prompt', { STMB_slothSideNote: true }),
        lore('NPC', 3, '@@dont_activate\nManual rule'),
        lore('NPC', 4, 'Private rule', { characterFilter: { names: ['Someone else'] } }),
    ];
    const entries = [...positive, ...special, native, pinned, rejected, positive[0]];
    const prepared = prepareJevRecall(entries, worlds, [{ name: 'User', mes: 'Lantern?' }]);
    assert.deepEqual(new Set(Object.values(prepared.body.state.lore).map(entry => entry.book)), worlds);
    assert.equal(prepared.candidates.size, 9);
    assert.match(prepared.body.state.assessment, /established voice.*scene a natural way to move forward/);
    for (const [id, question] of Object.entries(prepared.body.questions)) {
        assert.deepEqual(question, {
            type: 'choice',
            instructions: id,
            criteria: { include: null, skip: null },
        });
    }
    const answers = Object.fromEntries([...prepared.candidates].map(([id, key]) => [
        id, { choice: key === jevEntryKey(rejected) ? 'skip' : 'include', confidence: 0.8 },
    ]));
    const ranked = await requestJevRecall(prepared, {}, undefined, async (route, request) => {
        assert.equal(route, '/api/plugins/scene-reader-jev/nanogpt/systemone');
        assert.equal(JSON.parse(request.body).model, 'typesafe/jev-1.14');
        return { ok: true, json: async () => ({ answers }) };
    });
    const accepted = await fitJevRecall(entries, worlds, ranked, {
        budget: 10000, worldInfoBudget: 20000, bookBudgets: new Map(), countTokens: async text => text.length,
    });
    assert.equal(accepted.size, 8);
    applyJevRecall(entries, worlds, accepted);
    assert.deepEqual(entries.slice(0, 8), positive.map(entry => ({
        ...entry, vectorized: false, content: '@@activate\n'+entry.content,
    })));
    assert.deepEqual(entries.slice(8), [...special, native, pinned]);
    assert.equal(positive[0].constant, false);
    assert.equal(positive[0].vectorized, true);
});

test('Jev reserves all applicable constants and fits books in model score order', async () => {
    const worlds = new Set(['Core', 'NPC']);
    const pinned = lore('Core', 10, '1234', { constant: true });
    const outside = lore('World', 1, '1234', { constant: true, ignoreBudget: true, __stloReservedConstant: true });
    const large = lore('Core', 1, '1234');
    const small = lore('Core', 2, '12');
    const npc = lore('NPC', 1, '1234');
    const entries = [pinned, outside, large, small, npc];
    const ranked = [large, small, npc].map(jevEntryKey);
    const limits = { budget: 13, worldInfoBudget: 18, bookBudgets: new Map([['Core', 8]]), countTokens: async text => text.length };
    const selection = await fitJevRecall(entries, worlds, ranked, limits);
    assert.deepEqual([...selection.keys()], [small, npc].map(jevEntryKey));
    assert.equal((await fitJevRecall(entries, worlds, ranked, { ...limits, budget: 4 })).size, 0);
    assert.deepEqual([...await fitJevRecall(entries, worlds, ranked, { ...limits, bookBudgets: new Map([['Core', 7]]) })],
        [[jevEntryKey(npc), 0]]);
    assert.deepEqual([...await fitJevRecall(entries, worlds, ranked, { ...limits, worldInfoBudget: 14 })],
        [[jevEntryKey(small), 0]]);
    assert.equal(normalizeJevBudget(), 10000);
    assert.equal(normalizeJevBudget('12500'), 12500);
});

test('Every eligible entry reaches the chosen Jev connection in one request', async () => {
    const worlds = new Set(['Memory', 'NPC']);
    const big = Array.from({length:72}, (_, i) => lore('Memory', i, '등불 '.repeat(240)));
    const npc = lore('NPC', 72, 'A rare promise');
    const prepared = prepareJevRecall([...big, npc], worlds, [{ mes: 'A lantern appears.' }]);
    assert.equal(prepared.candidates.size, 73);
    const seen = new Set();
    let requests = 0;
    const selected = await requestJevRecall(prepared, {}, undefined, async (route, request) => {
        requests++;
        assert.equal(route, '/api/plugins/scene-reader-jev/systemone');
        const body = JSON.parse(request.body);
        assert.equal(body.model, 'jev-1.14.0');
        assert.ok(new TextEncoder().encode(JSON.stringify(body.state)).length > 30000);
        assert.equal(Object.keys(body.questions).length, 73);
        const answers = Object.fromEntries(Object.keys(body.questions).map(id => {
            assert.equal(seen.has(id), false);
            seen.add(id);
            return [id, { choice:body.state.lore[id].book === 'NPC' ? 'include' : 'skip' }];
        }));
        return { ok:true, json:async()=>({answers}) };
    }, 'typesafe');
    assert.equal(requests, 1);
    assert.equal(seen.size, 73);
    assert.deepEqual(selected, [jevEntryKey(npc)]);
});

test('A missing decision or unavailable provider fails without substituting incomplete results', async () => {
    const entries = [lore('NPC', 1, 'A secret'), lore('NPC', 2, 'A fact')];
    const request = prepareJevRecall(entries, new Set(['NPC']), [{ mes: 'Secrets' }]);
    await assert.rejects(requestJevRecall(request, {}, undefined, async () => ({
        ok: false, status: 404,
    })), /unavailable/);
    let calls = 0;
    await assert.rejects(requestJevRecall(request, {}, undefined, async () => {
        calls++;
        return { ok: false, status: 413 };
    }), /413/);
    assert.equal(calls, 1);
    await assert.rejects(requestJevRecall(request, {}, undefined, async () => ({
        ok: true, json: async () => ({ answers: { e1: { choice: 'skip' } } }),
    })), /every candidate/);
    assert.deepEqual(await requestJevRecall(request, {}, undefined, async () => ({
        ok: true, json: async () => ({ answers: { e1: { choice: 'skip' }, e2: { choice: 'skip' } } }),
    })), []);
});
