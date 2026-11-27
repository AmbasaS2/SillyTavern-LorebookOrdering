import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as recall from './jevRecall.mjs';
import * as metrics from './jevMetrics.mjs';

const source = readFileSync(new URL('./index.js',import.meta.url),'utf8');
const entry = (world,uid,content,extra={}) => ({world,uid,content,key:['lantern'],comment:world+uid,order:100,constant:false,...extra});
const raw = [
    entry('A',1,'Relevant vector memory',{vectorized:true}),
    entry('A',2,'Relevant keyword memory'),
    entry('B',1,'Unmatched memory'),
    entry('B',2,'Always on',{constant:true}),
    entry('C',1,'Excluded native keyword'),
];
const endpoint='https://nano-gpt.com/api/subscription/v1';
const profile={id:'nano',api:'custom','api-url':endpoint,'secret-id':'test-only'};
function harness({mode='all',enabled=true,vectors=true,responses=[1],decisions,failures=0,sizeFailures=0,failAt=0,entries=raw,chatText='lantern',extraVectors=false,strategy=0,wiBudget=10000,scores={},receiptMode=false,adaptiveThreshold,emptyHits=false,partialInjection=false,partialAnswers,jevBudget=1000,companionMode,group=false}={}) {
    const listeners=new Map();
    const counters={jev:0,vector:0,preview:0,sorted:0,abort:0,stop:0,popup:0,domWrites:0,token:0};
    const events=new Proxy({}, {get:(_,key)=>key});
    const eventSource={
        on(k,f){if(!listeners.has(k))listeners.set(k,[]);listeners.get(k).push(f);},
        once(){},
        off(k,f){listeners.set(k,(listeners.get(k)||[]).filter(x=>x!==f));},
        async emit(k,...args){for(const fn of [...(listeners.get(k)||[])])await fn(...args);},
    };
    const settings={stlo:{jevByCharacter:{'avatar.png':enabled},jevOptions:{mode,adaptiveThreshold,partialInjection},jevProfileId:'nano',jevBudget},
        connectionManager:{profiles:[profile]},vectors:{enabled_world_info:vectors,enabled_chats:extraVectors,enabled_files:extraVectors},disabledExtensions:[]};
    const books=new Map([['A',{stlo:{}}],['B',{stlo:{}}],['C',{stlo:{jevExclude:true}}]]);
    const ctx={groupId:group?'group-one':null,chatMetadata:{timedWorldInfo:{sticky:{a:1}}},extensionPrompts:{'3_vectors':{value:'old'},'4_vectors_data_bank':{value:'old'},note:{value:'original'}},chat:[{name:'User',mes:chatText}]};
    const force=new Map();
    const batches=[], vectorKeys=[], receipts=[];
    let activated=[];
    eventSource.on(events.WORLDINFO_FORCE_ACTIVATE,entries=>{for(const e of entries)force.set(recall.jevEntryKey(e),e);});
    const elements=new Map();
    const makeNode=()=>{
        const attrs=new Map();
        return {dataset:{},title:'',children:[],append(...children){this.children.push(...children);for(const child of children)if(child.id)elements.set(child.id,child);counters.domWrites++;},
            remove(){elements.delete(this.id);counters.domWrites++;},addEventListener(){},getAttribute(k){return attrs.get(k);},setAttribute(k,v){attrs.set(k,v);counters.domWrites++;}};
    };
    elements.set('extensionTopBar',makeNode());
    const doc={getElementById:id=>elements.get(id)||null,createElement:makeNode};
    const popupResponses=[...responses];
    let lastPopupPanel=null;
    class Popup { constructor(_panel,_type,_input,opts){this.opts=opts;lastPopupPanel=_panel;} async show(){counters.popup++;return popupResponses.shift()??0;} async completeCancelled(){} }
    const sandbox={
        ...recall,...metrics,Map,Set,Array,Object,Promise,URL,AbortController,AbortSignal,structuredClone,performance,
        main_api:'openai',stloTokenizers:{getTokenizerModel:()=> 'fixture-tokenizer'},
        eventSource,event_types:events,extension_settings:settings,document:doc,Popup,POPUP_TYPE:{CONFIRM:2,TEXT:1},NOTE_MODULE_NAME:'note',
        characters:[{avatar:'avatar.png'},{avatar:'other.png'}],this_chid:0,getCurrentChatId:()=> 'chat1',getContext:()=>ctx,
        getTokenCountAsync:async s=>{counters.token++;return s.length;},getRequestHeaders:()=>({}),getMaxContextSize:()=>10000,world_info_character_strategy:strategy,world_info_insertion_strategy:{evenly:0,character_first:1,global_first:2},
        getCharacterCardFields:()=>({}),world_info:{},getCharaFilename:()=> 'avatar',world_info_budget:100,world_info_budget_cap:0,world_info_include_names:false,
        worldInfoCache:books,world_names:[...books.keys()],selected_world_info:[...books.keys()],power_user:{},METADATA_KEY:'world',
        translate:t=>t,console:{warn(){},error(){},info(){},debug(){}},toastr:{error(){}},
        stopGeneration(){counters.stop++;void eventSource.emit(events.GENERATION_STOPPED);},
        getSortedEntries:async()=>{
            counters.sorted++;
            const data={globalLore:[],characterLore:[],chatLore:[],personaLore:[]};
            for(const e of structuredClone(entries)) data[e.source || 'globalLore'].push(e);
            await eventSource.emit(events.WORLDINFO_ENTRIES_LOADED,data);
            const sort=arr=>arr.sort((a,b)=>(b.order??100)-(a.order??100));
            const rest=strategy===1?[...sort(data.characterLore),...sort(data.globalLore)]:strategy===2?[...sort(data.globalLore),...sort(data.characterLore)]:sort([...data.globalLore,...data.characterLore]);
            return [...sort(data.chatLore),...sort(data.personaLore),...rest];
        },
        checkWorldInfo:async()=>{
            counters.preview++;
            const entries=await sandbox.getSortedEntries();
            const matches=entries.filter(e=>e.constant||(!emptyHits&&(e.uid===2&&e.world==='A'||force.has(recall.jevEntryKey(e))))||e.world==='C');
            ctx.extensionPrompts.note.value='preview-modified';
            ctx.chatMetadata.timedWorldInfo={sticky:{preview:1}};
            await eventSource.emit(events.WORLDINFO_SCAN_DONE,{new:{all:matches},activated:{entries:new Map()},state:{next:0}});
            force.clear();
        },
        requestJevRecall:async(prepared)=>{
            counters.jev++;
            batches.push([...prepared.candidates.keys()]);
            if(counters.jev<=sizeFailures)throw new recall.JevInputLimitError('Jev rejected the input size.');
            if(counters.jev<=failures||counters.jev===failAt)throw Error('Jev is unavailable (503).');
            if(partialAnswers){
                const answers=Object.fromEntries([...prepared.candidates].map(([id,key])=>[id,{choice:!decisions||decisions.includes(key)?'include':'skip',probabilities:{include:scores[key]??.9}}]));
                if(partialAnswers!=='missing')for(const [id,plan] of prepared.partialPlans??[]){
                    const choice=[...plan.options.keys()][0];
                    answers[id]={choice,probabilities:{[choice]:partialAnswers==='low'?.5:.96}};
                }
                return recall.requestJevRecall(prepared,recall.getNanoJevConnection(profile),{},undefined,async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({answers})}}],usage:{prompt_tokens:100}})}));
            }
            return { decisions:[...prepared.candidates.values()].filter(key=>!decisions||decisions.includes(key)).map(key=>({key,score:scores[key]??.9})), inputTokens:100 };
        },
    };
    sandbox.globalThis=sandbox;
    if (receiptMode) sandbox.STWII={recordStloJevRecall:(lists, keys)=>{
        receipts.push({lists,keys:[...keys]});
        if (receiptMode==='throw') throw Error('optional viewer failed');
    }};
    const companionCache=new Map();let companionCalls=0,companionTokenizations=0;
    if(companionMode)sandbox.STWII={...(sandbox.STWII??{}),loreTokenCountV1:{apiVersion:companionMode==='incompatible'?2:1,async count(text){
        companionCalls++;
        if(companionMode==='throw')throw Error('viewer failed');
        if(companionMode==='null')return null;
        if(!companionCache.has(text)){companionTokenizations++;companionCache.set(text,text.length);}
        return companionCache.get(text);
    }}};
    sandbox.vectors_rearrangeChat=async()=>{
        if(!vectors)return;
        counters.vector++;
        const entries=await sandbox.getSortedEntries();
        const hits=entries.filter(e=>e.vectorized);
        vectorKeys.push(...hits.map(recall.jevEntryKey));
        if(extraVectors) {
            ctx.extensionPrompts['3_vectors']={value:'native chat recall'};
            ctx.extensionPrompts['4_vectors_data_bank']={value:'native file recall'};
        }
        await eventSource.emit(events.WORLDINFO_FORCE_ACTIVATE,hits);
    };
    const code=source.replace(/^import .*?;\s*$/gm,'').replace('import.meta.url',JSON.stringify('file:///stlo/index.js'));
    runInNewContext(code+'\nsetupEventHandlers(); registerPerLoopBudgetTrimmer();\n globalThis.testApi={startJevGeneration,currentJevReport,stopJevGeneration,setCharacterJevRecall,openJevReport};',sandbox);
    async function generate({dryRun=false}={}){
        await eventSource.emit(events.GENERATION_STARTED,'normal',{},dryRun);
        if(!dryRun)companionCache.clear();
        if(dryRun)return;
        const abort=()=>{counters.abort++;};
        await sandbox.stlo_jevInterceptor(ctx.chat,10000,abort,'normal');
        if(!counters.abort&&vectors)await sandbox.vectors_rearrangeChat(ctx.chat,10000,abort,'normal');
        if(counters.abort)return;
        const entries=await sandbox.getSortedEntries();
        // Simulate native activation and its early budget cutoff, then
        // run the real extension's structural final-scan handler.
        const active=new Map();
        let used=0, overflow=false;
        for(const e of entries) {
            if(e.disable||!(e.content.startsWith('@@activate')||e.constant||e.world==='C'||force.has(recall.jevEntryKey(e)))) continue;
            const copy={...e,content:e.content.replace(/^@@activate\n/,''), decorators:e.content.startsWith('@@activate\n')?['@@activate']:[]};
            const cost=copy.content.length+1;
            if(!copy.ignoreBudget && (overflow||used+cost>wiBudget)) {overflow=true;continue;}
            used+=cost;
            active.set(recall.jevEntryKey(copy),copy);
        }
        await eventSource.emit(events.WORLDINFO_SCAN_DONE,{activated:{entries:active},sortedEntries:entries,state:{next:0},budget:{current:wiBudget}});
        activated=[...active.values()];
        await eventSource.emit(events.WORLD_INFO_ACTIVATED,activated);
        return entries;
    }
    return {generate,counters,ctx,force,settings,books,batches,vectorKeys,receipts,companionStats:()=>({calls:companionCalls,tokenizations:companionTokenizations}),companionCount:text=>sandbox.STWII?.loreTokenCountV1?.count(text),setSpeaker:id=>eventSource.emit(events.GROUP_MEMBER_DRAFTED,id),bridge:()=>sandbox.STLOMemoryMetrics,end:()=>eventSource.emit(events.GENERATION_ENDED),stop:()=>eventSource.emit(events.GENERATION_STOPPED),hostActivation:entries=>eventSource.emit(events.WORLD_INFO_ACTIVATED,entries),setTokenizer:model=>{sandbox.stloTokenizers.getTokenizerModel=()=>model;},activated:()=>activated,setChoice:(avatar,choice)=>sandbox.testApi.setCharacterJevRecall(settings.stlo,avatar,choice),report:()=>sandbox.testApi.currentJevReport(),openReport:async()=>{await sandbox.testApi.openJevReport();return lastPopupPanel;},elements};
}

test('all-mode replaces managed world-vector collections while preserving native vector pass',async()=>{
    const h=harness();
    const entries=await h.generate();
    assert.equal(h.counters.jev,1);
    assert.equal(h.counters.vector,1);
    assert.deepEqual(h.vectorKeys,[]);
    assert.equal(h.counters.preview,0);
    assert.equal(h.counters.abort,0);
    assert.equal(entries.filter(e=>e.content.startsWith('@@activate')).length,3);
    assert.equal(entries.find(e=>e.world==='C').content,'Excluded native keyword');
    assert.equal(h.ctx.extensionPrompts['3_vectors'].value,'old');
    assert.equal(h.report().injected,3);
    assert.equal(h.elements.has('stlo-jev-topbar'),true);
});

test('filtered mode reuses one vector pass and one candidate scan; restores native transient state',async()=>{
    const h=harness({mode:'filtered'});
    const entries=await h.generate();
    assert.equal(h.counters.vector,1);
    assert.equal(h.counters.preview,1);
    assert.equal(h.counters.jev,1);
    assert.equal(h.counters.abort,0);
    assert.equal(entries.filter(e=>e.content.startsWith('@@activate')).length,2);
    assert.equal(entries.some(e=>e.world==='B'&&e.uid===1),false);
    assert.equal(h.ctx.extensionPrompts.note.value,'original');
    assert.deepEqual(h.ctx.chatMetadata.timedWorldInfo,{sticky:{a:1}});
    assert.equal(h.report().candidates,2);
});

test('retry is explicit, reuses candidates and does not rerun vector or keyword search',async()=>{
    const h=harness({mode:'filtered',failures:1,responses:[1]});
    await h.generate();
    assert.equal(h.counters.jev,2);
    assert.equal(h.counters.vector,1);
    assert.equal(h.counters.preview,1);
    assert.equal(h.counters.popup,1);
    assert.equal(h.counters.abort,0);
    assert.equal(h.report().requests,2);
});

test('cancel after Jev error prevents reply and never automatically retries',async()=>{
    const h=harness({mode:'filtered',failures:1,responses:[0]});
    assert.equal(await h.generate(),undefined);
    assert.equal(h.counters.jev,1);
    assert.equal(h.counters.popup,1);
    assert.equal(h.counters.abort,1);
    assert.equal(h.counters.stop,1);
    assert.equal(h.force.size,0);
    assert.equal(h.report().phase,'cancelled');
});

test('disabled and dry-run generations do not call Jev or create its top bar UI',async()=>{
    const h=harness({enabled:false});
    await h.generate();
    assert.equal(h.counters.jev,0);
    assert.equal(h.counters.preview,0);
    assert.equal(h.counters.vector,1);
    assert.equal(h.elements.has('stlo-jev-topbar'),false);
    const dry=harness();
    await dry.generate({dryRun:true});
    assert.equal(dry.counters.jev,0);
    assert.equal(dry.counters.domWrites,0);
});

test('new recall paths use no DOM observer, polling or animation loop',()=>{
    assert.doesNotMatch(source,/\b(?:MutationObserver|ResizeObserver|IntersectionObserver|setInterval)\s*\(/);
});


test('character Jev choice is independent of other characters and book settings', async()=>{
    const h=harness({enabled:false});
    h.setChoice('other.png','on');
    h.setChoice('avatar.png','on');
    assert.equal(h.settings.stlo.jevByCharacter['other.png'],true);
    assert.equal(h.settings.stlo.jevByCharacter['avatar.png'],true);
    assert.equal(h.books.get('C').stlo.jevExclude,true);
    await h.generate();
    assert.equal(h.counters.jev,1);
    h.setChoice('avatar.png','off');
    assert.equal(h.settings.stlo.jevByCharacter['avatar.png'],false);
    assert.equal(h.settings.stlo.jevByCharacter['other.png'],true);
    const off=harness();
    off.setChoice('avatar.png','off');
    await off.generate();
    assert.equal(off.counters.jev,0);
});

test('unset single characters are off even if books have legacy opt-ins', async()=>{
    const h=harness();
    h.books.get('A').stlo.jevRecall=true;
    delete h.settings.stlo.jevByCharacter['avatar.png'];
    h.setChoice('other.png','on');
    await h.generate();
    assert.equal(h.counters.jev,0);
    assert.equal(h.counters.vector,1);
    assert.equal(h.books.get('A').stlo.jevRecall,true);
    assert.equal(h.settings.stlo.jevByCharacter['other.png'],true);
});

test('group chats retain book-level Jev opt-ins', async()=>{
    const h=harness({enabled:false});
    h.ctx.groupId='group';
    h.books.get('A').stlo.jevRecall=true;
    const entries=await h.generate();
    assert.equal(h.counters.jev,1);
    assert.equal(entries.some(e=>e.world==='B'&&e.uid===1&&e.content.startsWith('@@activate')),false);
    assert.equal(h.books.get('A').stlo.jevRecall,true);
});

test('explicit provider size failure splits only the rejected batch and uses no retry popup',async()=>{
    const h=harness({sizeFailures:1});
    const result=await h.generate();
    assert.equal(h.counters.jev,3);
    assert.equal(h.counters.popup,0);
    assert.deepEqual([...h.batches[1],...h.batches[2]],h.batches[0]);
    assert.equal(h.report().unassessed,0);
    assert.equal(h.report().completedBatches,2);
    assert.equal(h.report().actualInputTokens,200);
    assert.equal(result.filter(e=>e.content.startsWith('@@activate')).length,3);
});

test('failure in later batch retries only that batch; cancelling never injects partial selections',async()=>{
    const retry=harness({sizeFailures:1,failAt:3,responses:[1]});
    assert.ok(await retry.generate());
    assert.equal(retry.counters.jev,4);
    assert.deepEqual(retry.batches[2],retry.batches[3]);
    assert.equal(retry.report().completedBatches,2);
    assert.equal(retry.report().unassessed,0);
    const cancel=harness({sizeFailures:1,failAt:3,responses:[0]});
    assert.equal(await cancel.generate(),undefined);
    assert.equal(cancel.report().completedBatches,1);
    assert.ok(cancel.report().unassessed>0);
    assert.equal(cancel.counters.abort,1);
});

test('preflight rejects a single oversized question without any paid request',async()=>{
    const h=harness({entries:[entry('A',1,'x'.repeat(130000))],responses:[0]});
    assert.equal(await h.generate(),undefined);
    assert.equal(h.counters.jev,0);
    assert.equal(h.counters.abort,1);
    assert.equal(h.report().unassessed,1);
});


test('all-mode preserves excluded book vectors, chat and Data Bank recall', async()=>{
    const entries=raw.map(e=>e.world==='C'?{...e,vectorized:true}:e);
    const h=harness({entries,extraVectors:true});
    await h.generate();
    assert.deepEqual(h.vectorKeys,['["C",1]']);
    assert.equal(h.ctx.extensionPrompts['3_vectors'].value,'native chat recall');
    assert.equal(h.ctx.extensionPrompts['4_vectors_data_bank'].value,'native file recall');
    assert.equal(h.counters.jev,1);
});

test('special vector-dependent entries preserve the whole book collection, not just some hashes',async()=>{
    const entries=[...raw,entry('A',99,'sticky native vector',{sticky:3,vectorized:true})];
    const h=harness({entries});
    await h.generate();
    assert.ok(h.vectorKeys.includes('["A",1]'));
    assert.ok(h.vectorKeys.includes('["A",99]'));
    assert.ok(!h.vectorKeys.some(k=>k.startsWith('["B"')));
});

test('no configured priority or protection preserves native source precedence and raw insertion orders',async()=>{
    const entries=[entry('A',1,'global',{order:900}),entry('B',1,'character',{order:100,source:'characterLore'}),entry('C',1,'chat',{order:1,source:'chatLore'})];
    const h=harness({entries,enabled:false,vectors:false,strategy:1});
    const sorted=await h.generate();
    assert.deepEqual(sorted.map(e=>[e.world,e.order]),[['C',1],['B',100],['A',900]]);
    assert.ok(sorted.every(e=>!e.ignoreBudget&&!e.__stloReservedConstant));
});

test('explicit always-on protection reserves budget but retains raw insertion order',async()=>{
    const entries=[entry('A',1,'x'.repeat(80),{order:900}),entry('C',2,'p'.repeat(40),{order:1,constant:true}),entry('C',3,'z'.repeat(80),{order:800})];
    const h=harness({entries,enabled:false,vectors:false,wiBudget:100});
    h.settings.stlo.protectAlwaysOn=true;
    await h.generate();
    assert.deepEqual(h.activated().map(e=>[e.uid,e.order]),[[2,1]]);
    assert.equal(h.activated()[0].ignoreBudget,false);
    assert.ok(!Object.hasOwn(h.activated()[0],'__stloReservedConstant'));
});

test('zero Jev picks still enforce the managed-books cap on constants',async()=>{
    const entries=[entry('A',1,'x'.repeat(6999),{constant:true,order:300}),entry('A',2,'y'.repeat(5999),{constant:true,order:200})];
    const h=harness({entries,vectors:false,wiBudget:20000});
    h.settings.stlo.jevBudget=10000;
    await h.generate();
    assert.equal(h.counters.jev,0);
    assert.equal(h.activated().length,1);
    assert.equal(h.activated()[0].uid,1);
    assert.equal(h.activated()[0].order,300);
});

test('oversized external constant is trimmed and does not block an accepted Jev pick',async()=>{
    const entries=[entry('C',1,'x'.repeat(8999),{constant:true,order:900}),entry('A',1,'p'.repeat(4999),{constant:true,order:500}),entry('A',2,'m'.repeat(999),{order:100})];
    const h=harness({entries,vectors:false});
    h.books.get('C').stlo.budgetMode='fixed';h.books.get('C').stlo.budget=1000;
    h.settings.stlo.jevBudget=10000;
    await h.generate();
    assert.deepEqual(h.activated().map(e=>[e.world,e.uid]),[['A',1],['A',2]]);
    assert.equal(h.report().accepted,1);
});

test('explicit original budget exemption remains intact for native books',async()=>{
    const entries=[entry('C',1,'x'.repeat(149),{constant:true,ignoreBudget:true,order:10})];
    const h=harness({entries,enabled:false,vectors:false,wiBudget:100});
    h.settings.stlo.protectAlwaysOn=true;
    await h.generate();
    assert.equal(h.activated().length,1);
    assert.equal(h.activated()[0].ignoreBudget,true);
});


test('explicit STLO ordering is retained while protection leaves effective insertion values intact',async()=>{
    const entries=[entry('A',1,'constant',{constant:true,order:20}),entry('C',1,'native',{order:10})];
    const h=harness({entries,enabled:false,vectors:false});
    h.books.get('A').stlo.priority=5;
    h.books.get('C').stlo.priority=2;
    h.settings.stlo.protectAlwaysOn=true;
    await h.generate();
    assert.deepEqual(h.activated().map(e=>[e.world,e.order]),[['A',50020],['C',20010]]);
});

test('actual Jev selection restores swapped insertion slots after final budgeting',async()=>{
    const entries=[entry('A',1,'first',{order:200}),entry('A',2,'second',{order:100})];
    const h=harness({entries,vectors:false,scores:{'["A",1]':.1,'["A",2]':.9}});
    await h.generate();
    assert.deepEqual(h.activated().map(e=>[e.uid,e.order]),[[2,100],[1,200]]);
    assert.ok(h.activated().every(e=>e.ignoreBudget===false&&!Object.hasOwn(e,'__stloReservedJev')));
});

test('native special entries count toward the managed-book Jev ceiling without changing their activation rules',async()=>{
    const entries=[entry('A',1,'x'.repeat(6999),{constant:true,order:100}),entry('A',2,'y'.repeat(3999),{vectorized:true,sticky:2,order:50})];
    const h=harness({entries,vectors:true,wiBudget:20000});
    h.settings.stlo.jevBudget=10000;
    await h.generate();
    assert.equal(h.counters.jev,0);
    assert.deepEqual(h.vectorKeys,['["A",2]']);
    assert.deepEqual(h.activated().map(e=>e.uid),[1]);
});


test('unconfigured protection and explicit off leave native constant admission unchanged',async()=>{
    const entries=[entry('C',1,'x'.repeat(79),{order:900}),entry('C',2,'p'.repeat(39),{constant:true,order:100})];
    for(const explicit of [false,undefined]){
        const h=harness({entries,enabled:false,vectors:false,wiBudget:100});
        if(explicit!==undefined)h.settings.stlo.protectAlwaysOn=explicit;
        const sorted=await h.generate();
        assert.deepEqual(h.activated().map(e=>e.uid),[1]);
        assert.deepEqual(sorted.map(e=>e.order),[900,100]);
        assert.ok(sorted.every(e=>!e.ignoreBudget&&!e.__stloReservedConstant));
    }
});

test('display receipts only identify applied entries in the real scan, not candidate or vector scans',async()=>{
    for(const mode of ['all','filtered']){
        const h=harness({mode,receiptMode:true});
        const output=await h.generate();
        assert.equal(h.receipts.length,1);
        const [{lists,keys}]=h.receipts;
        assert.deepEqual([...keys].sort(),output.filter(e=>e.content.startsWith('@@activate\n')).map(recall.jevEntryKey).sort());
        assert.ok(lists.globalLore.length);
        assert.equal(h.counters.jev,1);
        assert.equal(h.counters.vector,1);
        assert.equal(h.counters.preview,mode==='filtered'?1:0);
        assert.equal(h.counters.abort,0);
    }
});
test('disabled/dry-run/cancelled Jev does not publish receipts and receiver failures never affect injection',async()=>{
    const off=harness({enabled:false,receiptMode:true}); await off.generate();
    assert.equal(off.receipts.length,0);
    const preview=harness({receiptMode:true}); await preview.generate({dryRun:true});
    assert.equal(preview.receipts.length,0);
    const cancelled=harness({receiptMode:true,failures:1,responses:[0]}); await cancelled.generate();
    assert.equal(cancelled.receipts.length,0);
    const baseline=harness(); const a=await baseline.generate();
    const failed=harness({receiptMode:'throw'}); const b=await failed.generate();
    assert.deepEqual(a,b); assert.equal(failed.report().injected,baseline.report().injected);
});

test('adaptive preserves all assessment below threshold, selects native hits above it, and never needs an extra vector pass',async()=>{
    const low=harness({mode:'adaptive',adaptiveThreshold:1000000});
    await low.generate();
    assert.equal(low.report().requestedMode,'adaptive');
    assert.equal(low.report().mode,'all');
    assert.equal(low.report().candidates,3);
    assert.equal(low.counters.preview,0);
    assert.equal(low.counters.jev,1);
    const high=harness({mode:'adaptive',adaptiveThreshold:1,entries:raw.map(e=>e.world==='B'&&e.uid===1?{...e,content:'Unrelated stonework. '.repeat(40)}:e)});
    await high.generate();
    assert.equal(high.report().mode,'filtered');
    assert.equal(high.report().candidates,2);
    assert.equal(high.counters.preview,1);
    assert.equal(high.counters.vector,1);
    assert.equal(high.counters.jev,1);
});
test('adaptive without World Info vectors or eligible native hits returns to the entire candidate set',async()=>{
    const off=harness({mode:'adaptive',adaptiveThreshold:1,vectors:false});
    await off.generate();
    assert.equal(off.report().mode,'all');
    assert.equal(off.report().adaptiveReason,'vector-unavailable');
    assert.equal(off.report().candidates,3);
    assert.equal(off.counters.preview,0);
    const empty=harness({mode:'adaptive',adaptiveThreshold:1,emptyHits:true});
    await empty.generate();
    assert.equal(empty.report().mode,'all');
    assert.equal(empty.report().adaptiveReason,'empty-filter');
    assert.equal(empty.report().candidates,3);
    assert.equal(empty.counters.jev,1);
});

test('adaptive coverage restores old durable memories before Jev without changing legacy filtered or full recall',async()=>{
    const rule=entry('A',2,'The lantern must be blue.');
    const promise=entry('B',8,'Long ago, Iona promised to keep the copper bell until reunion.',{key:[],comment:'Scene 1'});
    const habit=entry('B',9,'Mara counts three quiet breaths before answering a difficult question, then touches the blue ring.',{key:[],comment:'Scene 2'});
    const oversized=entry('A',1,'An unrelated massive item. '.repeat(300),{vectorized:true});
    const fillers=Array.from({length:230},(_,i)=>entry('B',100+i,('The stone terrace and granite steps stood beneath clouds. ').repeat(40),{key:[],comment:'Scene '+(100+i)}));
    const entries=[rule,promise,habit,oversized,...fillers,entry('B',90,'Core remains complete.',{constant:true}),entry('C',2,'Excluded secret.')];
    const expected=[rule,promise,habit].map(recall.jevEntryKey);
    const decisions=[...expected,recall.jevEntryKey(oversized)];
    const run=async mode=>{
        const h=harness({mode,adaptiveThreshold:1,entries,decisions,chatText:'Iona looks at the blue lantern. What now?'});
        await h.generate();
        assert.equal(h.counters.abort,0);
        return h;
    };
    const all=await run('all'), filtered=await run('filtered'), adaptive=await run('adaptive');
    const relevant=h=>h.activated().filter(e=>expected.includes(recall.jevEntryKey(e))).map(recall.jevEntryKey).sort();
    assert.deepEqual(relevant(all),expected.slice().sort());
    assert.deepEqual(relevant(filtered),[recall.jevEntryKey(rule)]);
    assert.deepEqual(relevant(adaptive),expected.slice().sort());
    assert.equal(all.report().candidates,234);
    assert.equal(filtered.report().candidates,2);
    assert.equal(adaptive.report().candidates,4);
    assert.equal(adaptive.report().adaptiveNative,2);
    assert.equal(adaptive.report().adaptiveDurable,1);
    assert.equal(adaptive.report().adaptiveCompact,1);
    assert.equal(adaptive.report().adaptiveRecent,0);
    assert.equal(adaptive.counters.vector,1);
    assert.equal(adaptive.counters.preview,1);
    assert.equal(adaptive.counters.jev,1);
    assert.ok(adaptive.report().estimatedInputTokens<all.report().estimatedInputTokens);
    assert.equal(adaptive.activated().some(e=>e.uid===1&&e.world==='A'),false);
    assert.equal(adaptive.activated().find(e=>e.uid===90).content,'Core remains complete.');
    assert.equal(promise.content,'Long ago, Iona promised to keep the copper bell until reunion.');
});

test('adaptive coverage reaching the full set is reported as full without a second search',async()=>{
    const entries=[...raw,entry('B',3,'A forgotten promise.'),entry('B',4,'An old habit.')].filter(e=>!(e.world==='B'&&e.uid===1));
    const h=harness({mode:'adaptive',adaptiveThreshold:1,entries});
    await h.generate();
    assert.equal(h.report().adaptiveReason,'coverage-all');
    assert.equal(h.report().mode,'all');
    assert.equal(h.report().candidates,4);
    assert.equal(h.counters.vector,1);
    assert.equal(h.counters.preview,1);
    assert.equal(h.counters.jev,1);
});

function excerptScene(repetitions=24){
    const filler=n=>('The stone terrace displayed rows of painted tiles and marble carvings. '+n+' ').repeat(repetitions);
    return ['Timeline: Early spring, at the observatory.','Scene:\nIona found the copper bell beside the sealed gate.',
        filler(1),'Iona promised to keep the copper bell until they reunited. The captain accepted this condition.',filler(2),
        filler(3),filler(4),'The captain left the observatory and Iona carried the bell home.',
        'Result: Iona kept the copper bell for the promised reunion.'].join('\n\n');
}

test('partial injection keeps the native scan and full budget intact, applies only at final activation, and has no additional request',async()=>{
    const scene=entry('A',1,excerptScene(),{vectorized:true});
    const constant=entry('B',2,'Always-on Core: the captain keeps the archive seal.',{constant:true});
    const entries=[scene,constant,entry('C',2,'Native unaffected')];
    const base=harness({entries,jevBudget:9000});
    await base.generate();
    const opt=harness({entries,jevBudget:9000,partialInjection:true,partialAnswers:'high',receiptMode:true});
    const scan=await opt.generate();
    assert.equal(base.counters.jev,1);
    assert.equal(opt.counters.jev,1);
    assert.equal(opt.counters.vector,1);
    assert.equal(opt.counters.abort,0);
    assert.equal(opt.report().partialQuestions,1);
    assert.equal(opt.report().partialSelected,1);
    assert.equal(opt.report().partialApplied,1);
    assert.ok(opt.report().partialSavedChars>0);
    assert.equal(opt.report().accepted,base.report().accepted);
    assert.equal(scan.find(e=>e.world==='A').content,'@@activate\n'+scene.content);
    assert.equal(opt.activated().find(e=>e.world==='B').content,constant.content);
    assert.match(opt.activated().find(e=>e.world==='A').content,/promised to keep the copper bell/);
    assert.ok(opt.activated().find(e=>e.world==='A').content.length<scene.content.length);
    assert.equal(scene.content,excerptScene());
    assert.deepEqual(opt.receipts[0].keys,[recall.jevEntryKey(scene)]);
    for(const partialAnswers of ['low','missing']){
        const h=harness({entries,jevBudget:9000,partialInjection:true,partialAnswers});
        await h.generate();
        assert.equal(h.counters.jev,1);
        assert.equal(h.report().partialApplied,0);
        assert.equal(h.activated().find(e=>e.world==='A').content,scene.content);
    }
    const size=harness({entries,jevBudget:9000,partialInjection:true,partialAnswers:'high',sizeFailures:1});
    await size.generate();
    assert.equal(size.counters.jev,2);
    assert.equal(size.counters.popup,0);
    assert.equal(size.report().partialQuestions,0);
    assert.equal(size.report().partialApplied,0);
    assert.equal(size.activated().find(e=>e.world==='A').content,scene.content);
});

test('metrics reuse full budget counts, keep confirmed RP measurements separate, and invalidate generation handles',async()=>{
    const h=harness();
    await h.generate();
    const report=h.report();
    assert.equal(report.assessed,3);
    assert.equal(report.activationObserved,true);
    assert.equal(report.injected,3);
    assert.equal(report.rpInjection,undefined);
    assert.equal(report.finalRecallBudgetUnknown,0);
    assert.equal(report.bookBudgets.find(x=>x.world==='A').recalled,2);
    assert.ok(report.finalRecallBudgetTokens>0);
    const bridge=h.bridge(), context=bridge.context();
    assert.equal(bridge.version,1);
    assert.ok(context);
    const a=h.activated().find(e=>e.world==='A'&&e.uid===1);
    const key=recall.jevEntryKey(a);
    assert.equal(bridge.selection({generation:context.generation,key}).activated,true);
    const budget={...context,target:key,text:a.content+'\n'};
    const calls=h.counters.token;
    assert.equal(bridge.lookup(budget),a.content.length+1);
    assert.equal(await bridge.measure(budget),a.content.length+1);
    assert.equal(h.counters.token,calls);
    const rendered={...context,target:key,text:a.content};
    assert.equal(bridge.lookup(rendered),null);
    const measured=await Promise.all([bridge.measure(rendered),bridge.measure(rendered)]);
    assert.deepEqual(measured,[a.content.length,a.content.length]);
    assert.equal(h.counters.token,calls+1);
    const records=h.activated().filter(e=>['A','B'].includes(e.world)&&!e.constant).map(e=>({key:recall.jevEntryKey(e),status:'confirmed',text:e.content}));
    assert.equal(bridge.publishInjection({...context,records,complete:true}),true);
    assert.equal(h.report().rpInjection.tokens,null);
    for(const record of records)await bridge.measure({...context,target:record.key,text:record.text});
    assert.equal(bridge.publishInjection({...context,records,complete:true}),true);
    assert.equal(h.report().rpInjection.tokens,records.reduce((n,x)=>n+x.text.length,0));
    await h.end();
    assert.equal(bridge.lookup(budget),a.content.length+1);
    await h.generate();
    assert.equal(bridge.lookup(budget),null);
    assert.equal(bridge.publishInjection({...context,records,complete:true}),false);
});

test('metrics invalidate on cancellation and tokenizer changes; mismatched host activation never inherits stale budget totals',async()=>{
    const h=harness();
    await h.generate();
    const bridge=h.bridge(), context=bridge.context();
    const a=h.activated().find(e=>e.world==='A'&&e.uid===1);
    const descriptor={...context,target:recall.jevEntryKey(a),text:a.content+'\n'};
    assert.ok(bridge.lookup(descriptor)>0);
    h.setTokenizer('changed-tokenizer');
    assert.equal(bridge.context(),null);
    assert.equal(bridge.lookup(descriptor),null);
    assert.equal(await bridge.measure(descriptor),null);
    h.setTokenizer('fixture-tokenizer');
    await h.hostActivation(h.activated().filter(e=>!(e.world==='A'&&e.uid===1)));
    assert.equal(h.report().activationObserved,true);
    assert.equal(h.report().bookBudgets,undefined);
    assert.equal(h.report().finalRecallBudgetTokens,null);
    assert.equal(h.report().injected,2);
    await h.stop();
    assert.equal(bridge.context(),null);
    assert.equal(bridge.lookup(descriptor),null);
});


test('current Lore Insight v1 reuses exact budget strings and fails safely when absent or unavailable',async()=>{
    const standalone=harness();
    await standalone.generate();
    const expected=standalone.activated().map(e=>e.content);
    assert.ok(standalone.counters.token>0);
    const both=harness({companionMode:'ready'});
    await both.generate();
    assert.deepEqual(both.activated().map(e=>e.content),expected);
    assert.equal(both.counters.token,0);
    assert.ok(both.companionStats().tokenizations>0);
    const active=both.activated().find(e=>e.world==='A'&&e.uid===1);
    const before=both.companionStats().tokenizations;
    assert.equal(await both.companionCount(active.content+'\n'),active.content.length+1);
    assert.equal(both.companionStats().tokenizations,before);
    const context=both.bridge().context();
    const descriptor={...context,target:recall.jevEntryKey(active),text:active.content+'\n'};
    assert.equal(await both.bridge().measure(descriptor),active.content.length+1);
    assert.equal(both.companionStats().tokenizations,before);
    const changed={...descriptor,text:active.content+'\n changed'};
    assert.equal(await both.bridge().measure(changed),changed.text.length);
    assert.equal(both.companionStats().tokenizations,before+1);
    for(const mode of ['throw','null','incompatible']){
        const h=harness({companionMode:mode});
        await h.generate();
        assert.deepEqual(h.activated().map(e=>e.content),expected);
        assert.ok(h.counters.token>0);
        assert.equal(h.counters.abort,0);
    }
});

test('report and measurement handle do not leak to a different drafted group speaker',async()=>{
    const h=harness({group:true});
    h.books.get('A').stlo.jevRecall=true;
    await h.setSpeaker(0);
    await h.generate();
    const old=h.bridge().context();
    assert.ok(old);
    assert.ok(h.report());
    await h.end();
    await h.setSpeaker(1);
    assert.equal(h.bridge().context(),null);
    assert.equal(h.report(),null);
});

test('existing report opens with compact overview and collapsible decision/usage sections, without extra work',async()=>{
    const h=harness();
    await h.generate();
    const counters={token:h.counters.token,jev:h.counters.jev,vector:h.counters.vector,sorted:h.counters.sorted};
    const before=JSON.stringify(h.settings.stlo);
    const panel=await h.openReport();
    const walk=node=>[node,...(node.children??[]).flatMap(walk)];
    const nodes=walk(panel);
    assert.equal(panel.className,'stlo-jev-report');
    assert.ok(nodes.some(n=>n.className==='stlo-report-overview'));
    assert.equal(nodes.filter(n=>n.className==='stlo-report-summary-card').length,6);
    const sections=nodes.filter(n=>n.className==='stlo-report-section');
    assert.ok(sections.length>=3);
    assert.equal(sections.filter(n=>n.open).length,1);
    assert.deepEqual({token:h.counters.token,jev:h.counters.jev,vector:h.counters.vector,sorted:h.counters.sorted},counters);
    assert.equal(JSON.stringify(h.settings.stlo),before);
});
