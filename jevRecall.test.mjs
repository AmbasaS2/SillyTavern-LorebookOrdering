import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { applyJevRecall, fitJevRecall, getNanoJevConnection, jevEntryKey, normalizeJevBudget, prepareJevRecall, requestJevRecall, planJevRequests, splitJevBatch, rankJevDecisions, estimateJevTokens, JEV_REQUEST_TARGET, JEV_QUESTION_TARGET } from './jevRecall.mjs';

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
    assert.equal(requests[2].text, 'edited\n');
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
    const candidateOf = q => JSON.parse(q.instructions.slice(q.instructions.indexOf('{')));
    assert.deepEqual(new Set(Object.values(prepared.body.questions).map(q => candidateOf(q).book)), worlds);
    assert.equal(prepared.candidates.size, 9);
    assert.match(prepared.body.state.assessment, /established voice.*scene a natural way to move forward/);
    assert.deepEqual(prepared.body.state.background.map(x=>x.text), ['Always on']);
    assert.equal(prepared.body.state.lore, undefined);
    for (const [id, question] of Object.entries(prepared.body.questions)) {
        assert.equal(question.type, 'choice');
        assert.deepEqual(question.criteria, { include: null, skip: null });
        assert.equal(candidateOf(question).text, entries.find(e => jevEntryKey(e) === prepared.candidates.get(id)).content);
    }
    const answers = Object.fromEntries([...prepared.candidates].map(([id, key]) => [
        id, { choice: key === jevEntryKey(rejected) ? 'skip' : 'include', confidence: 0.8 },
    ]));
    const result = await requestJevRecall(prepared, connection, {}, undefined, async (route, request) => {
        assert.equal(route, '/api/backends/chat-completions/generate');
        assert.equal(JSON.parse(request.body).model, 'typesafe/jev-1.14');
        return response({ answers });
    });
    const ranked = rankJevDecisions(prepared, result.decisions);
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
    assert.deepEqual([...await fitJevRecall(entries, worlds, ranked, { ...limits, budget: 4 })], [[jevEntryKey(small), 0]]);
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

test('Every eligible entry reaches the chosen Jev connection once across safe batches', async () => {
    const worlds = new Set(['Memory', 'NPC']);
    const big = Array.from({length:72}, (_, i) => lore('Memory', i, '등불 '.repeat(240) + 'MIDDLE' + 'a'.repeat(1200)));
    const npc = lore('NPC', 72, 'A rare promise');
    const entries = [...big, npc];
    const message = 'Earlier important detail. ' + 'Dialogue. '.repeat(200);
    const prepared = prepareJevRecall(entries, worlds, [{mes:message}]);
    assert.equal(prepared.candidates.size, 73);
    assert.deepEqual(prepared.body.state.current, [{speaker:'',text:message}]);
    assert.equal(prepared.stats.truncatedMessages,0);
    assert.equal(prepared.stats.truncatedLore,0);
    const batches = planJevRequests(prepared);
    assert.ok(batches.length > 1);
    const seen = new Set();
    const decisions = [];
    let requests = 0;
    for (const batch of batches) {
        assert.ok(batch.estimatedTokens <= JEV_REQUEST_TARGET);
        assert.ok([...batch.questionCosts.values()].every(cost=>batch.sharedEstimate+cost<=JEV_QUESTION_TARGET));
        const result = await requestJevRecall(batch, connection, {}, undefined, async (route, request) => {
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
            assert.deepEqual(state, prepared.body.state);
            const answers = Object.fromEntries(Object.entries(format.questions).map(([id,q]) => {
                assert.equal(seen.has(id), false);
                seen.add(id);
                const candidate = JSON.parse(q.instructions.slice(q.instructions.indexOf('{')));
                assert.equal(candidate.text, entries.find(e=>jevEntryKey(e)===batch.candidates.get(id)).content);
                return [id, { choice:candidate.book === 'NPC' ? 'include' : 'skip' }];
            }));
            return {ok:true,json:async()=>({usage:{prompt_tokens:123},choices:[{message:{content:JSON.stringify(answers)}}]})};
        });
        assert.equal(result.inputTokens,123);
        decisions.push(...result.decisions);
    }
    assert.equal(requests, batches.length);
    assert.equal(seen.size, 73);
    assert.deepEqual(rankJevDecisions(prepared, decisions), [jevEntryKey(npc)]);
});

test('small requests stay single; splitting preserves question ids, scores and common state', ()=>{
    const prepared=prepareJevRecall([lore('A',1,'one'),lore('A',2,'two'),lore('A',3,'three')],new Set(['A']),[{mes:'scene'}]);
    const batches=planJevRequests(prepared);
    assert.equal(batches.length,1);
    const [a,b]=splitJevBatch(batches[0]);
    assert.deepEqual([...a.candidates,...b.candidates],[...prepared.candidates]);
    assert.equal(a.body.state,b.body.state);
    assert.deepEqual(rankJevDecisions(prepared,[{key:jevEntryKey(lore('A',3,'three')),score:.9},{key:jevEntryKey(lore('A',2,'two')),score:.7},{key:jevEntryKey(lore('A',1,'one')),score:.7}]), ['["A",3]','["A",1]','["A",2]']);
    assert.throws(()=>planJevRequests(prepared,56000,100),{name:'JevInputLimitError'});
    assert.equal(splitJevBatch(b).length,0);
});

test('oversized single question fails before dispatch without silently removing lore', ()=>{
    const entry=lore('A',1,'x'.repeat(130000));
    const prepared=prepareJevRecall([entry],new Set(['A']),[{mes:'scene'}]);
    assert.ok(prepared.body.questions.e1.instructions.includes(entry.content));
    assert.throws(()=>planJevRequests(prepared),{name:'JevInputLimitError'});
    assert.ok(estimateJevTokens('한글 글자')>0);
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
        response({ answers: { e1: { choice: 'skip' }, e2: { choice: 'skip' } } })), {decisions:[],inputTokens:null});
});

test('Jev defaults, custom criteria and explicit candidate scope', async () => {
    const { getJevWorlds, normalizeJevOptions, JEV_PRESETS, DEFAULT_JEV_PROMPT } = await import('./jevRecall.mjs');
    const settings = new Map([
        ['A', { jevRecall: true }],
        ['B', { jevRecall: false }],
        ['C', { jevRecall: true, jevExclude: true }],
    ]);
    assert.deepEqual([...getJevWorlds(settings, true)], ['A', 'B']);
    assert.deepEqual([...getJevWorlds(settings, undefined)], ['A']);
    assert.equal(getJevWorlds(settings, false).size, 0);
    assert.deepEqual(normalizeJevOptions(), {inputVersion:2,mode:'all',recent:20,messageLength:0,loreLength:0,preset:'balanced',prompt:''});
    assert.deepEqual(normalizeJevOptions({recent:0,messageLength:20001,loreLength:NaN}), normalizeJevOptions());
    assert.deepEqual(normalizeJevOptions({recent:6,messageLength:1400,loreLength:960}),normalizeJevOptions());
    assert.equal(normalizeJevOptions({inputVersion:2,recent:6,messageLength:1400,loreLength:960}).messageLength,1400);
    assert.equal(normalizeJevOptions({recent:10,messageLength:2500,loreLength:1500}).loreLength,1500);
    assert.equal(JEV_PRESETS.balanced, DEFAULT_JEV_PROMPT);
    const entries = [lore('A',1,'a'.repeat(1200)), lore('B',1,'b'), lore('C',1,'c')];
    const keys = new Set([jevEntryKey(entries[0]),jevEntryKey(entries[2])]);
    const messages = [{mes:'old'},{mes:'recent'.repeat(50)},{mes:'hidden',is_system:true}];
    const prepared = prepareJevRecall(entries, getJevWorlds(settings,true), messages, {recent:1,messageLength:100,loreLength:100,preset:'generous',prompt:'Prefer relationship details.'}, keys);
    assert.equal(prepared.candidates.size,1);
    assert.equal(prepared.body.state.current.length,1);
    assert.equal(prepared.body.state.current[0].text.length,100);
    assert.ok(JSON.parse(prepared.body.questions.e1.instructions.slice(prepared.body.questions.e1.instructions.indexOf('{'))).text.length <= 100);
    assert.equal(prepared.stats.truncatedMessages,1);
    assert.equal(prepared.stats.truncatedLore,1);
    assert.match(prepared.body.state.assessment,/Prefer relationship details/);
    assert.match(prepared.body.state.assessment,/include\/skip/);
    assert.equal(prepareJevRecall(entries,getJevWorlds(settings,true),messages,{},new Set()),null);
});

test('preferred budgets share unused space, obey limits and only select Jev-approved entries', async () => {
    const entries = [
        lore('A',0,'aaaaa'), lore('A',1,'aaaaa'), lore('A',2,'aaaaa'),
        lore('B',0,'bb',{constant:true}), lore('B',1,'bbb'), lore('B',2,'bbbb'),
        lore('C',1,'ccc'),
    ];
    const ranked = [entries[0], entries[1], entries[2], entries[4], entries[5]].map(jevEntryKey);
    const opts = { budget:15,worldInfoBudget:20,bookBudgets:new Map([['B',7],['C',5]]),countTokens:async text=>text.length,bookPriorities:new Map([['C',5],['B',4]]),diagnostics:new Map()};
    const result=await fitJevRecall(entries,new Set(['A','B','C']),ranked,opts);
    assert.deepEqual([...result.keys()],[entries[4],entries[0]].map(jevEntryKey));
    assert.equal(result.has(jevEntryKey(entries[6])),false);
    assert.equal(opts.diagnostics.get(jevEntryKey(entries[1])),'jev-budget');
    const capped=await fitJevRecall(entries,new Set(['A','B','C']),ranked,{...opts,bookBudgets:new Map([['B',6]])});
    assert.equal(capped.has(jevEntryKey(entries[4])),false);
    assert.deepEqual([...capped.keys()],[entries[0],entries[1]].map(jevEntryKey));
});

test('conflicting preferred budgets use book priority without exceeding the shared ceiling', async () => {
    const a=lore('A',1,'aaa'),b=lore('B',1,'bbb');
    const result=await fitJevRecall([a,b],new Set(['A','B']),[a,b].map(jevEntryKey),{
        budget:4,worldInfoBudget:100,bookBudgets:new Map([['A',4],['B',4]]),countTokens:async text=>text.length,bookPriorities:new Map([['A',1],['B',5]])});
    assert.deepEqual([...result.keys()],[jevEntryKey(b)]);
});


test('constants that cannot fit their own book or total cap do not reserve phantom space', async () => {
    const oversized = lore('Other', 1, 'x'.repeat(9000), { constant: true });
    const pinned = lore('Memory', 1, 'p'.repeat(4999), { constant: true });
    const selected = lore('Memory', 2, 's'.repeat(999));
    const opts = { budget: 10000, worldInfoBudget: 10000, bookBudgets: new Map([['Memory',10000], ['Other',1000]]), countTokens: async text=>text.length };
    assert.deepEqual([...await fitJevRecall([oversized,pinned,selected],new Set(['Memory']),[jevEntryKey(selected)],opts)],[[jevEntryKey(selected),0]]);
    const huge = lore('Memory',3,'x'.repeat(12000),{constant:true});
    assert.deepEqual([...await fitJevRecall([huge,selected],new Set(['Memory']),[jevEntryKey(selected)],opts)],[[jevEntryKey(selected),0]]);
});

test('adaptive durable cues, explicit same-chat recency, eligibility and cache invalidation',async()=>{
    const {createAdaptiveCueCache,coverAdaptiveJevCandidates}=await import('./jevRecall.mjs');
    const worlds=new Set(['A','B']);
    const native=lore('A',1,'a native match');
    const promise=lore('A',2,'오래전 둘만의 약속을 했다.');
    const habit=lore('B',2,'Their morning ritual was to read by the door.');
    const secret=lore('B',3,'A secret only the captain knows.');
    const recent=lore('B',10,'A stone arch. '.repeat(70),{STMB_chatId:'chat-a',STMB_sourceRanges:[[5,6],[20,22]]});
    const recent2=lore('A',9,'A path. '.repeat(70),{STMB_chatId:'chat-a',STMB_start:15,STMB_end:16});
    const recent3=lore('A',8,'A chair. '.repeat(70),{STMB_chatId:'chat-a',STMB_start:8,STMB_end:10});
    const older=lore('A',500,'A window. '.repeat(70),{STMB_chatId:'chat-a',STMB_start:1,STMB_end:4});
    const foreign=lore('A',501,'A gate. '.repeat(70),{STMB_chatId:'chat-b',STMB_start:100,STMB_end:101});
    const invalid=lore('A',502,'A road. '.repeat(70),{STMB_chatId:'chat-a',STMB_sourceRanges:[[30,25]],STMB_start:100,STMB_end:101});
    const disabled=lore('A',503,'A promise',{disable:true});
    const special=lore('A',504,'A secret',{position:7});
    const pinned=lore('A',505,'A habit',{constant:true});
    const other=lore('C',506,'A promise');
    const entries=[native,promise,habit,secret,recent,recent2,recent3,older,foreign,invalid,disabled,special,pinned,other,promise];
    const cache=createAdaptiveCueCache({maxEntries:16,maxChars:2000});
    const get=()=>coverAdaptiveJevCandidates(entries,worlds,new Set([jevEntryKey(native),jevEntryKey(disabled),jevEntryKey(other)]),{chatId:'chat-a',cueCache:cache});
    const expected=[native,promise,habit,secret,recent,recent2,recent3].map(jevEntryKey);
    assert.deepEqual([...get().candidateKeys].sort(),expected.sort());
    assert.equal(get().nativeCount,1);
    assert.equal(get().durableCount,3);
    assert.equal(get().recentCount,3);
    assert.equal(get().eligibleCount,10);
    promise.content='A pebble. '.repeat(70);
    assert.equal(get().candidateKeys.has(jevEntryKey(promise)),false);
    promise.comment='A vow';
    assert.equal(get().candidateKeys.has(jevEntryKey(promise)),true);
    cache.clear();
    assert.equal(get().candidateKeys.has(jevEntryKey(promise)),true);
});

function excerptScene(){
    const filler=n=>('The stone terrace displayed rows of painted tiles and marble carvings. '+n+' ').repeat(7);
    return ['Timeline: Early spring, at the observatory.','Scene:\nIona found the copper bell beside the sealed gate.',
        filler(1),'Iona promised to keep the copper bell until they reunited. The captain accepted this condition.',filler(2),
        filler(3),filler(4),'The captain left the observatory and Iona carried the bell home.',
        'Result: Iona kept the copper bell for the promised reunion.'].join('\n\n');
}

test('partial questions preserve binary decisions, fit existing batches, and fail open to full text',async()=>{
    const {applyJevExcerpts,normalizeJevOptions}=await import('./jevRecall.mjs');
    const e=lore('A',1,excerptScene());
    const pinned=lore('A',2,excerptScene(),{constant:true});
    const worlds=new Set(['A']);
    const messages=[{mes:'The captain returns. Iona reaches for the bell.'}];
    const base=prepareJevRecall([e,pinned],worlds,messages,{});
    const prepared=prepareJevRecall([e,pinned],worlds,messages,{partialInjection:true});
    assert.deepEqual(prepared.body.questions,base.body.questions);
    assert.equal(prepared.partialPlans.size,1);
    const fullBatch=planJevRequests(base)[0];
    const batches=planJevRequests(prepared);
    assert.equal(batches.length,1);
    const batch=batches[0];
    assert.deepEqual(batch.body.questions.e1.criteria,fullBatch.body.questions.e1.criteria);
    assert.ok(batch.body.questions.e1.instructions.includes('excerptSources.e1'));
    assert.ok(batch.body.questions.p1.instructions.includes('excerptSources.e1'));
    assert.equal(batch.body.state.excerptSources.e1.paragraphs.length,7);
    assert.ok(batch.excerptAddedEstimate<batch.excerptMinimumEstimatedSaving);
    assert.equal(batch.partialPlans.size,1);
    assert.equal(batch.candidates.size,1);
    assert.ok(batch.estimatedTokens<fullBatch.estimatedTokens*1.5);
    assert.ok(batch.estimatedTokens<=JEV_REQUEST_TARGET);
    const constrained=planJevRequests(prepared,fullBatch.estimatedTokens,JEV_QUESTION_TARGET);
    assert.equal(constrained.length,1);
    assert.deepEqual(constrained[0].body,fullBatch.body);
    assert.equal(constrained[0].partialPlans,undefined);
    assert.equal(normalizeJevOptions().partialInjection,undefined);
    for(const opts of [{partialInjection:true,prompt:'My exact criteria.'},{inputVersion:2,partialInjection:true,loreLength:1000},{inputVersion:2,partialInjection:true,messageLength:100}]){
        assert.equal(prepareJevRecall([e],worlds,messages,opts).partialPlans,undefined);
    }
    for(const source of ['Scene:\n'+e.content,e.content+' {{user}}',e.content.replace('Result:','Conclusion:')]){
        assert.equal(prepareJevRecall([{...e,content:source}],worlds,messages,{partialInjection:true}).partialPlans,undefined);
    }
    const choice=[...batch.partialPlans.get('p1').options.keys()][0];
    const call=async(secondary,primary='include')=>requestJevRecall(batch,connection,{},undefined,async(_url,req)=>{
        const sent=JSON.parse(req.body);
        const questions=JSON.parse(sent.custom_include_body).response_format.questions;
        assert.deepEqual(questions.e1.criteria,{include:null,skip:null});
        assert.ok(questions.p1.criteria.full);
        return response({answers:{e1:{choice:primary,probabilities:{include:.9,skip:.1}},...(secondary===undefined?{}:{p1:secondary})}});
    });
    const result=await call({choice,probabilities:{[choice]:.92}});
    assert.equal(result.decisions.length,1);
    assert.equal(result.decisions[0].score,.9);
    const excerpt=result.decisions[0].excerpt;
    assert.equal(excerpt.source,e.content);
    assert.ok(excerpt.text.length<e.content.length);
    assert.match(excerpt.text,/Timeline: Early spring/);
    assert.match(excerpt.text,/Iona found the copper bell/);
    assert.match(excerpt.text,/promised to keep the copper bell/);
    assert.match(excerpt.text,/The captain left the observatory/);
    assert.match(excerpt.text,/Result: Iona kept the copper bell/);
    for(const secondary of [undefined,{choice:'full',probabilities:{full:1}},{choice,probabilities:{[choice]:.5}},{choice,confidence:1},{choice:'unknown',probabilities:{unknown:1}}]){
        const r=await call(secondary);
        assert.equal(r.decisions[0].excerpt,undefined);
    }
    assert.equal((await call({choice,probabilities:{[choice]:.99}},'skip')).decisions.length,0);
    const key=jevEntryKey(e);
    const accepted=await fitJevRecall([e],worlds,[key],{budget:excerpt.text.length+10,worldInfoBudget:10000,bookBudgets:new Map(),countTokens:async text=>text.length});
    assert.equal(accepted.size,0,'reserve full source cost, not shortened text');
    const selection=new Map([[key,0]]),applied=new Set([key]),excerpts=new Map([[key,excerpt]]);
    const stored=e.content;
    const activated=new Map([[key,e],[jevEntryKey(pinned),pinned]]);
    assert.deepEqual(applyJevExcerpts(activated,selection,applied,excerpts),{applied:1,savedChars:stored.length-excerpt.text.length});
    assert.equal(activated.get(key).content,excerpt.text);
    assert.equal(e.content,stored);
    assert.equal(activated.get(jevEntryKey(pinned)),pinned);
    for(const changed of [{...e,content:stored+' edited'},{...e,constant:true},{...e,position:7}]){
        const a=new Map([[key,changed]]);
        assert.equal(applyJevExcerpts(a,selection,applied,excerpts).applied,0);
        assert.equal(a.get(key),changed);
    }
    assert.equal(applyJevExcerpts(new Map([[key,e]]),selection,new Set(),excerpts).applied,0);
});

test('adaptive retains concise implicit memories without relying on titles or keywords',async()=>{
    const {coverAdaptiveJevCandidates}=await import('./jevRecall.mjs');
    const worlds=new Set(['A']);
    const rule=lore('A',1,'The lantern signals departure.');
    const habit=lore('A',2,'Mara counts three quiet breaths before answering a difficult question, then touches the blue ring.');
    const promise=lore('A',3,'He handed her the key. "When the bell sounds, I will be here."');
    const secret=lore('A',4,'Mira saw the ledger. Ellis was outside.');
    const filler=lore('A',5,'The harbor stonework was grey. '.repeat(50));
    const disabled=lore('A',6,'A concealed note',{disable:true});
    const entries=[rule,habit,promise,secret,filler,disabled];
    const coverage=coverAdaptiveJevCandidates(entries,worlds,new Set([jevEntryKey(rule)]));
    assert.deepEqual([...coverage.candidateKeys], [rule,habit,promise,secret].map(jevEntryKey));
    assert.equal(coverage.compactCount,3);
    assert.equal(coverage.eligibleCount,5);
});

test('adaptive estimate cache matches the exact full planner, invalidates edited inputs and avoids warm full serialization',async()=>{
    const {createAdaptivePlanCache,estimateAdaptiveJevPlan,routeAdaptiveJevEstimate,selectAdaptiveJevMode}=await import('./jevRecall.mjs');
    const cache=createAdaptivePlanCache({maxEntries:2000,maxChars:2000000});
    const worlds=new Set(['A','B']);
    const pinned=lore('A',9999,'Always-on background. 한글',{constant:true});
    const entries=[pinned,...Array.from({length:1010},(_,i)=>lore(i%2?'A':'B',i,('행동과 약속. Quoted "word" \\ text. 🐦 '+i+' ').repeat(i%5+1),{key:['키',String(i)],comment:'Title '+i})),
        lore('A',9998,'protected',{position:7}),lore('C',3,'foreign')];
    const messages=[{mes:'old',is_system:true},{mes:'dialogue one'},{mes:'dialogue two',name:'User'}];
    const compare=(entries,opts={},msgs=messages)=>{
        const prepared=prepareJevRecall(entries,worlds,msgs,{...opts,partialInjection:false});
        const estimated=estimateAdaptiveJevPlan(entries,worlds,msgs,opts,cache);
        const expected=selectAdaptiveJevMode(prepared,{threshold:2000,vectorAvailable:true});
        assert.deepEqual(routeAdaptiveJevEstimate(estimated,{threshold:2000,vectorAvailable:true}),expected);
        assert.equal(estimated.estimatedTokens,planJevRequests(prepared).reduce((n,b)=>n+b.estimatedTokens,0));
        return estimated;
    };
    const cold=compare(entries);
    assert.equal(cold.cacheMisses,1010);assert.equal(cold.cacheHits,0);
    const warm=compare(entries.slice().reverse());
    assert.equal(warm.cacheMisses,0);assert.equal(warm.cacheHits,1010);
    entries[2].content+=' Edited.';
    entries[3].comment='New title';
    entries[4].key=['new key'];
    pinned.content+=' changed background';
    const changed=compare(entries,{},[{mes:'new dialogue'}]);
    assert.equal(changed.cacheMisses,3);assert.equal(changed.cacheHits,1007);
    const limited=compare(entries,{inputVersion:2,loreLength:100,messageLength:100});
    assert.equal(limited.cacheMisses,1010);
    cache.clear();assert.equal(compare(entries).cacheHits,0);
    const huge=[lore('A',1,'x '.repeat(100000))];
    const oversized=estimateAdaptiveJevPlan(huge,worlds,messages,{},cache);
    assert.equal(oversized.oversized,true);
    assert.equal(oversized.estimatedTokens,null);
    assert.equal(routeAdaptiveJevEstimate(oversized,{vectorAvailable:true}).mode,'filtered');
});

test('excerpt shared state sends the complete source once and respects all existing questions and batch limits',()=>{
    const worlds=new Set(['A']);
    const long=lore('A',1,excerptScene().replaceAll('The stone terrace displayed rows','UNIQUE_SOURCE_MARKER The stone terrace displayed rows'));
    const other=lore('A',2,'Ordinary memory unrelated to the copper bell.');
    const messages=[{mes:'The captain returns.'}];
    const base=planJevRequests(prepareJevRecall([long,other],worlds,messages))[0];
    const prepared=prepareJevRecall([long,other],worlds,messages,{partialInjection:true});
    const batch=planJevRequests(prepared)[0];
    assert.equal(batch.partialPlans.size,1);
    assert.deepEqual(batch.body.questions.e2,base.body.questions.e2);
    assert.equal(JSON.stringify(batch.body.questions).includes('UNIQUE_SOURCE_MARKER'),false);
    assert.equal(JSON.stringify(batch.body.state.excerptSources.e1).includes('UNIQUE_SOURCE_MARKER'),true);
    assert.equal(batch.body.state.excerptSources.e1.paragraphs[0].text,'Iona found the copper bell beside the sealed gate.');
    const expected=estimateJevTokens(JSON.stringify(batch.body.state))+128+
        Object.entries(batch.body.questions).reduce((n,[id,q])=>n+estimateJevTokens(JSON.stringify({[id]:q}))+12,0);
    assert.equal(batch.estimatedTokens,expected);
    assert.ok([...batch.questionCosts.values()].every(n=>batch.sharedEstimate+n<=JEV_QUESTION_TARGET));
    const baseMax=Math.max(...base.questionCosts.values())+base.sharedEstimate;
    const tight=planJevRequests(prepared,JEV_REQUEST_TARGET,baseMax);
    assert.equal(tight.length,1);
    assert.deepEqual(tight[0].body,base.body);
});
