import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { applyJevRecall, fitJevRecall, getNanoJevConnection, jevEntryKey, normalizeJevBudget, prepareJevRecall, requestJevRecall } from './jevRecall.mjs';

const lore = (world, uid, text, flags = {}) => ({
    world, uid, comment: world+' '+uid, key: ['lantern'], content: text, vectorized: true, constant: false, ...flags,
});
const endpoint = 'https://nano-gpt.com/api/subscription/v1';
const profile = {
    id: 'nano-profile', name: 'NanoGPT subscription', api: 'custom',
    'custom-connection': {
        version: 1, settings: { custom_url: endpoint, custom_model: 'google/gemma-4-31b-it' },
        credential: { mode: 'legacy-custom', id: 'vault-entry' }, auth: { mode: 'bearer', required: false },
    },
};
const connection = getNanoJevConnection(profile);
const response = data => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(data) } }] }) });

test('budget token counts share an async request and retry a failed count', async () => {
    const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
    const start = source.indexOf('let TOKEN_COUNT_CACHE = new WeakMap();');
    const end = source.indexOf('\n}', source.indexOf('function getEntryTokenCountCached', start)) + 2;
    assert.ok(start >= 0 && end > start);
    const requests = [];
    const count = runInNewContext(source.slice(start, end) + '\ngetEntryTokenCountCached', {
        getTokenCountAsync: text => new Promise((resolve, reject) => requests.push({text, resolve, reject})),
    });
    const entry = { content: 'first' };
    const initial = count(entry);
    assert.equal(count(entry), initial);
    assert.equal(requests.length, 1);
    entry.content = 'edited';
    const edited = count(entry);
    requests[0].reject(Error('tokenizer unavailable'));
    assert.equal(await initial, 0);
    assert.equal(count(entry), edited);
    requests[1].reject(Error('tokenizer unavailable'));
    assert.equal(await edited, 0);
    const retry = count(entry);
    assert.equal(requests[2].text, 'edited');
    requests[2].resolve(11);
    assert.equal(await retry, 11);
});

test('Only profiles with bound NanoGPT subscription keys are selectable', () => {
    assert.equal(connection.id, profile.id);
    const snapshot = profile['custom-connection'];
    const withSnapshot = value => getNanoJevConnection({ ...profile, 'custom-connection': value });
    assert.equal(withSnapshot({ ...snapshot, settings: { custom_url: 'https://nano-gpt.com/api/v1' } }), null);
    assert.equal(withSnapshot({ ...snapshot, settings: { custom_url: endpoint + '?paid=true' } }), null);
    assert.equal(withSnapshot({ ...snapshot, credential: { mode:'legacy-custom', id: null } }), null);
    const legacy = { id: 'legacy', api: 'custom', 'api-url': endpoint, 'secret-id': 'legacy-vault-entry' };
    assert.equal(getNanoJevConnection(legacy).customAuth.credential.id, 'legacy-vault-entry');
    assert.equal(getNanoJevConnection({ ...legacy, 'custom-connection': { version: 1, excluded: true } }), null);
    const reference = { mode: 'reference', key: 'api_key_nanogpt', id: 'nano-vault-entry', endpoint };
    assert.equal(withSnapshot({ ...snapshot, credential: reference }).customAuth.credential.id, 'nano-vault-entry');
    assert.equal(getNanoJevConnection({ id: 'native-nano-profile', api: 'nanogpt', 'secret-id': 'nano-vault-entry' }), null);
    assert.equal(withSnapshot({ ...snapshot, credential: { ...reference, key: 'api_key_openai' } }), null);
    assert.equal(withSnapshot({ ...snapshot, credential: { ...reference, endpoint: 'https://example.test/api/v1' } }), null);
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
    const ranked = await requestJevRecall(prepared, connection, {}, undefined, async (route, request) => {
        assert.equal(route, '/api/backends/chat-completions/generate');
        assert.equal(JSON.parse(request.body).model, 'typesafe/jev-1.14');
        return response({ answers });
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

test('Jev admission follows scores in the available slots without altering native or saved insertion order', () => {
    const worlds = new Set(['Memory']);
    const lower = lore('Memory', 1, 'Lower score', { order: 40 });
    const higher = lore('Memory', 2, 'Higher score', { order: 10 });
    const native = lore('Other', 1, 'Native', { order: 30 });
    const pinned = lore('Memory', 3, 'Always on', { order: 50, constant: true });
    const entries = [pinned, lower, native, higher, lower];
    const scores = new Map([[jevEntryKey(higher), 0], [jevEntryKey(lower), 1]]);
    applyJevRecall(entries, worlds, scores);
    assert.deepEqual(entries, [
        pinned,
        { ...higher, order: 40, __stloJevInsertionOrder: 10, content: '@@activate\nHigher score', vectorized: false },
        native,
        { ...lower, order: 10, __stloJevInsertionOrder: 40, content: '@@activate\nLower score', vectorized: false },
    ]);
    assert.equal(higher.order, 10);
    assert.equal(lower.order, 40);
});

test('Every eligible entry reaches the chosen Jev connection in one request', async () => {
    const worlds = new Set(['Memory', 'NPC']);
    const big = Array.from({length:72}, (_, i) => lore('Memory', i, '등불 '.repeat(240)));
    const npc = lore('NPC', 72, 'A rare promise');
    const prepared = prepareJevRecall([...big, npc], worlds, [{ mes: 'A lantern appears.' }]);
    assert.equal(prepared.candidates.size, 73);
    const seen = new Set();
    let requests = 0;
    const selected = await requestJevRecall(prepared, connection, {}, undefined, async (route, request) => {
        requests++;
        assert.equal(route, '/api/backends/chat-completions/generate');
        const body = JSON.parse(request.body);
        const state = JSON.parse(body.messages[0].content);
        const format = JSON.parse(body.custom_include_body).response_format;
        assert.equal(body.model, 'typesafe/jev-1.14');
        assert.equal(body.chat_completion_source, 'custom');
        assert.equal(body.custom_url, endpoint);
        assert.equal(body.secret_id, 'vault-entry');
        assert.deepEqual(body.custom_auth, connection.customAuth);
        assert.equal(body.stream, false);
        assert.deepEqual(JSON.parse(body.custom_include_headers), { Accept: 'application/json' });
        assert.equal(format.type, 'questions');
        assert.ok(new TextEncoder().encode(body.messages[0].content).length > 30000);
        assert.equal(Object.keys(format.questions).length, 73);
        const answers = Object.fromEntries(Object.keys(format.questions).map(id => {
            assert.equal(seen.has(id), false);
            seen.add(id);
            return [id, { choice:state.lore[id].book === 'NPC' ? 'include' : 'skip' }];
        }));
        return response(answers);
    });
    assert.equal(requests, 1);
    assert.equal(seen.size, 73);
    assert.deepEqual(selected, [jevEntryKey(npc)]);
});

test('A missing decision or unavailable provider fails without substituting incomplete results', async () => {
    const entries = [lore('NPC', 1, 'A secret'), lore('NPC', 2, 'A fact')];
    const request = prepareJevRecall(entries, new Set(['NPC']), [{ mes: 'Secrets' }]);
    await assert.rejects(requestJevRecall(request, null, {}, undefined, async () => {
        assert.fail('An unselected profile must not call any endpoint');
    }), /profile/);
    await assert.rejects(requestJevRecall(request, connection, {}, undefined, async () => ({
        ok: false, status: 404,
    })), /unavailable/);
    let calls = 0;
    await assert.rejects(requestJevRecall(request, connection, {}, undefined, async () => {
        calls++;
        return { ok: false, status: 413 };
    }), /413/);
    assert.equal(calls, 1);
    await assert.rejects(requestJevRecall(request, connection, {}, undefined, async () => ({
        ok: true, json: async () => ({ error: { message: 'quota' } }),
    })), /did not complete/);
    await assert.rejects(requestJevRecall(request, connection, {}, undefined, async () =>
        response({ answers: { e1: { choice: 'skip' } } })), /every candidate/);
    assert.deepEqual(await requestJevRecall(request, connection, {}, undefined, async () =>
        response({ answers: { e1: { choice: 'skip' }, e2: { choice: 'skip' } } })), []);
});
