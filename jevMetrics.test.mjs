import test from 'node:test';
import assert from 'node:assert/strict';
import {createTokenLedger,extractJevUsage,createUsageTracker,summarizeBookBudgets,summarizeFunnel,summarizeInjection,historyRow} from './jevMetrics.mjs';

test('provider usage retains zero vs missing, cache read/write are not added to input',()=>{
    const usage=extractJevUsage({prompt_tokens:123,completion_tokens:0,prompt_tokens_details:{cached_tokens:90},cache_creation_input_tokens:10});
    assert.deepEqual(usage,{inputTokens:123,outputTokens:0,cacheReadTokens:90,cacheWriteTokens:10});
    const tracker=createUsageTracker();
    tracker.add(usage);tracker.add({inputTokens:null,outputTokens:4});tracker.add({});
    assert.deepEqual(tracker.summary(),{successfulRequests:3,actualInputTokens:123,usageReportedBatches:1,actualOutputTokens:4,outputUsageBatches:2,cacheReadTokens:90,cacheReadBatches:1,cacheWriteTokens:10,cacheWriteBatches:1});
    assert.deepEqual(extractJevUsage(null),{inputTokens:null});
});

test('ledger coalesces identical pending measurements and distinguishes exact text, target, tokenizer, padding',async()=>{
    const ledger=createTokenLedger({maxEntries:3,maxChars:1000});
    const base={target:'["A",1]',text:'hello\n',tokenizer:'host-A'};
    let calls=0;
    const count=async()=>{calls++;return 4;};
    assert.deepEqual(await Promise.all([ledger.measure(base,count),ledger.measure(base,count)]),[4,4]);
    assert.equal(calls,1);
    assert.equal(ledger.lookup(base),4);
    for(const change of [{text:'hello'},{target:'["B",1]'},{tokenizer:'host-B'},{padding:0}]){
        assert.equal(ledger.lookup({...base,...change}),null);
    }
    await ledger.measure({...base,text:'another'},count);
    await ledger.measure({...base,target:'B'},count);
    await ledger.measure({...base,target:'C'},count);
    assert.equal(ledger.lookup(base),null);
    const bad={...base,text:'broken'};
    assert.equal(await ledger.measure(bad,async()=>{throw Error('fail');}),null);
    assert.equal(ledger.lookup(bad),null);
    assert.equal(await ledger.measure(bad,count),4);
    const stale={...base,text:'stale'};let valid=true;
    await ledger.measure(stale,async()=>{valid=false;return 9;},()=>valid);
    assert.equal(ledger.lookup(stale),null);
    ledger.clear();assert.equal(ledger.lookup(bad),null);
});

test('book budgets use only already-known counts, distinguish no cap and unknown; selected trim is not other loss',()=>{
    const a={world:'A',uid:1,content:'a'},b={world:'A',uid:2,content:'b'},c={world:'A',uid:3,content:'c',ignoreBudget:true};
    const d={world:'B',uid:1,content:'d'},key=e=>JSON.stringify([e.world,e.uid]);
    const rows=summarizeBookBudgets([a,b,c,d],new Map([['A',20],['B',10],['Empty',7],['Default',0]]),e=>e===a?5:e===b?null:e===c?11:3,key,e=>!!e.ignoreBudget,new Set([key(a),key(b)]),new Set(['A']));
    const A=rows.find(x=>x.world==='A');
    assert.equal(A.budgetUsedKnown,5);assert.equal(A.budgetUnknown,1);assert.equal(A.ignored,1);assert.equal(A.remaining,null);
    assert.equal(A.jevUsedKnown,16);assert.equal(A.recalledBudgetUnknown,1);
    assert.equal(rows.find(x=>x.world==='B').remaining,7);
    assert.equal(rows.find(x=>x.world==='Empty').remaining,7);
    assert.equal(rows.find(x=>x.world==='Default').cap,null);
    const funnel=summarizeFunnel({assessed:8,selected:5,accepted:4},new Map([['b','book']]),new Set(['a','d']),new Set(['a','b','c','d']));
    assert.equal(funnel.activated,2);assert.equal(funnel.scanBudgetBook,1);assert.equal(funnel.otherNotActivated,1);
    assert.equal(summarizeFunnel({},new Map(),null,new Set()).activated,null);
});

test('injection evidence needs exact measured rendered text and complete accounting, history contains no raw text',async()=>{
    const ledger=createTokenLedger(),tokenizer='host-A',expected=new Set(['a','b']);
    await ledger.measure({target:'a',text:'rendered',tokenizer},async()=>4);
    const one={key:'a',status:'confirmed',text:'rendered'},two={key:'b',status:'confirmed',text:'other'};
    assert.equal(summarizeInjection([one,two],expected,ledger,tokenizer,true).tokens,null);
    assert.equal(summarizeInjection([one],expected,ledger,tokenizer,true).complete,false);
    assert.equal(summarizeInjection([one,one],expected,ledger,tokenizer,true),null);
    assert.equal(summarizeInjection([one,{key:'b',status:'excluded'}],expected,ledger,tokenizer,true).tokens,4);
    assert.equal(summarizeInjection([{...one,text:'changed'},{key:'b',status:'excluded'}],expected,ledger,tokenizer,true).tokens,null);
    assert.equal(summarizeInjection([one,{key:'b',status:'unknown'}],expected,ledger,tokenizer,true).tokens,null);
    assert.equal(JSON.stringify(historyRow({metricsId:1,prompt:'private',rpInjection:{tokens:4}})).includes('private'),false);
});
