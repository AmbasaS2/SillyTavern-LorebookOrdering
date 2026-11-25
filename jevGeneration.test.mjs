import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as recall from './jevRecall.mjs';

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
function harness({mode='all',enabled=true,vectors=true,responses=[1],decisions,failures=0}={}) {
    const listeners=new Map();
    const counters={jev:0,vector:0,preview:0,sorted:0,abort:0,stop:0,popup:0,domWrites:0};
    const events=new Proxy({}, {get:(_,key)=>key});
    const eventSource={
        on(k,f){if(!listeners.has(k))listeners.set(k,[]);listeners.get(k).push(f);},
        once(){},
        off(k,f){listeners.set(k,(listeners.get(k)||[]).filter(x=>x!==f));},
        async emit(k,...args){for(const fn of [...(listeners.get(k)||[])])await fn(...args);},
    };
    const settings={stlo:{jevByCharacter:{'avatar.png':enabled},jevOptions:{mode},jevProfileId:'nano',jevBudget:1000},
        connectionManager:{profiles:[profile]},vectors:{enabled_world_info:vectors},disabledExtensions:[]};
    const books=new Map([['A',{stlo:{}}],['B',{stlo:{}}],['C',{stlo:{jevExclude:true}}]]);
    const ctx={groupId:null,chatMetadata:{timedWorldInfo:{sticky:{a:1}}},extensionPrompts:{'3_vectors':{value:'old'},'4_vectors_data_bank':{value:'old'},note:{value:'original'}},chat:[{name:'User',mes:'lantern'}]};
    const force=new Map();
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
    class Popup { constructor(_panel,_type,_input,opts){this.opts=opts;} async show(){counters.popup++;return popupResponses.shift()??0;} async completeCancelled(){} }
    const sandbox={
        ...recall,Map,Set,Array,Object,Promise,URL,AbortController,AbortSignal,structuredClone,performance,
        eventSource,event_types:events,extension_settings:settings,document:doc,Popup,POPUP_TYPE:{CONFIRM:2,TEXT:1},NOTE_MODULE_NAME:'note',
        characters:[{avatar:'avatar.png'}],this_chid:0,getCurrentChatId:()=> 'chat1',getContext:()=>ctx,
        getTokenCountAsync:async s=>s.length,getRequestHeaders:()=>({}),getMaxContextSize:()=>10000,
        getCharacterCardFields:()=>({}),world_info_budget:100,world_info_budget_cap:0,world_info_include_names:false,
        worldInfoCache:books,world_names:[...books.keys()],selected_world_info:[...books.keys()],power_user:{},METADATA_KEY:'world',
        translate:t=>t,console:{warn(){},error(){},info(){},debug(){}},toastr:{error(){}},
        stopGeneration(){counters.stop++;void eventSource.emit(events.GENERATION_STOPPED);},
        getSortedEntries:async()=>{
            counters.sorted++;
            const data={globalLore:structuredClone(raw),characterLore:[],chatLore:[],personaLore:[]};
            await eventSource.emit(events.WORLDINFO_ENTRIES_LOADED,data);
            return data.globalLore;
        },
        checkWorldInfo:async()=>{
            counters.preview++;
            const entries=await sandbox.getSortedEntries();
            const matches=entries.filter(e=>e.constant||e.uid===2&&e.world==='A'||force.has(recall.jevEntryKey(e))||e.world==='C');
            ctx.extensionPrompts.note.value='preview-modified';
            ctx.chatMetadata.timedWorldInfo={sticky:{preview:1}};
            await eventSource.emit(events.WORLDINFO_SCAN_DONE,{new:{all:matches},activated:{entries:new Map()},state:{next:0}});
            force.clear();
        },
        requestJevRecall:async(prepared)=>{
            counters.jev++;
            if(counters.jev<=failures)throw Error('Jev is unavailable (503).');
            return [...prepared.candidates.values()].filter(key=>!decisions||decisions.includes(key));
        },
    };
    sandbox.globalThis=sandbox;
    sandbox.vectors_rearrangeChat=async()=>{
        if(!vectors)return;
        counters.vector++;
        const entries=await sandbox.getSortedEntries();
        await eventSource.emit(events.WORLDINFO_FORCE_ACTIVATE,entries.filter(e=>e.vectorized));
    };
    const code=source.replace(/^import .*?;\s*$/gm,'').replace('import.meta.url',JSON.stringify('file:///stlo/index.js'));
    runInNewContext(code+'\nsetupEventHandlers(); registerPerLoopBudgetTrimmer();\n globalThis.testApi={startJevGeneration,currentJevReport,stopJevGeneration};',sandbox);
    async function generate({dryRun=false}={}){
        await eventSource.emit(events.GENERATION_STARTED,'normal',{},dryRun);
        if(dryRun)return;
        const abort=()=>{counters.abort++;};
        await sandbox.stlo_jevInterceptor(ctx.chat,10000,abort,'normal');
        if(!counters.abort&&vectors)await sandbox.vectors_rearrangeChat(ctx.chat,10000,abort,'normal');
        if(counters.abort)return;
        const entries=await sandbox.getSortedEntries();
        const active=entries.filter(e=>e.content.startsWith('@@activate')||e.constant||e.world==='C');
        await eventSource.emit(events.WORLD_INFO_ACTIVATED,active);
        return entries;
    }
    return {generate,counters,ctx,force,report:()=>sandbox.testApi.currentJevReport(),elements};
}

test('all-mode generation skips vectors, honors exclusions and only asks Jev once',async()=>{
    const h=harness();
    const entries=await h.generate();
    assert.equal(h.counters.jev,1);
    assert.equal(h.counters.vector,0);
    assert.equal(h.counters.preview,0);
    assert.equal(h.counters.abort,0);
    assert.equal(entries.filter(e=>e.content.startsWith('@@activate')).length,3);
    assert.equal(entries.find(e=>e.world==='C').content,'Excluded native keyword');
    assert.equal(h.ctx.extensionPrompts['3_vectors'],undefined);
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
