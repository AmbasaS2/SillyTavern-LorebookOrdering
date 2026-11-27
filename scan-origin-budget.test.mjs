import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const code=readFileSync(new URL('./index.js',import.meta.url),'utf8');
const start=code.indexOf('async function applyPriorityOrdering(');
const end=code.indexOf('\n// Extension initialization',start);
assert.ok(start>=0&&end>start);
function harness() {
    let resolve;
    const old=new Map([['new-chat',{priority:3}]]);
    const state={currentSpeakingCharacter:'A',scanWorldSettings:old};
    const scope={EXTENSION_STATE:state,PRIORITY_LEVELS:{DEFAULT:3},HAS_WORLDINFO_SCAN_DONE:false,
        jevGeneration:null,getProtectAlwaysOn:()=>false,DEBUG_STLO:false,
        getLorebookSettings:()=>new Promise(r=>{resolve=r;}),console};
    const run=vm.runInNewContext(code.slice(start,end)+'\napplyPriorityOrdering',scope);
    return {run,state,old,resolve:()=>resolve({priority:5})};
}
test('late World Info settings cannot overwrite the new chat’s scan state',async()=>{
    const h=harness();
    const entry={world:'old',uid:1,order:100};
    const data={globalLore:[entry],characterLore:[],chatLore:[],personaLore:[]};
    let current=true;
    const pending=h.run(data,()=>current);
    current=false;
    h.resolve();
    assert.equal(await pending,false);
    assert.equal(h.state.scanWorldSettings,h.old);
    assert.equal(entry.order,100);
});
test('current scan still applies configured priority',async()=>{
    const h=harness();
    const entry={world:'current',uid:1,order:100};
    const data={globalLore:[entry],characterLore:[],chatLore:[],personaLore:[]};
    const pending=h.run(data);
    h.resolve();
    assert.equal(await pending,true);
    assert.equal(entry.order,50100);
    assert.equal(h.state.scanWorldSettings.has('current'),true);
});
