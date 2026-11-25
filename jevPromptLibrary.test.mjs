import test from 'node:test';
import assert from 'node:assert/strict';
import { createJevPromptLibrary } from './jevPromptLibrary.mjs';
import { JEV_PRESETS, normalizeJevOptions, prepareJevRecall } from './jevRecall.mjs';

function model(opts={}, stored={}) {
    let count=0;
    return createJevPromptLibrary(opts,stored,{defaultName:'Default',previousName:'Previous'},()=> 'custom-'+(++count));
}

test('legacy custom prompt migrates without changing the active decision criteria',()=>{
    const old={preset:'balanced',prompt:'Preserve this exact decision rule.'};
    const m=model(old);
    assert.equal(m.current().name,'Previous');
    assert.equal(m.text(),old.prompt);
    const s=m.snapshot();
    assert.equal(s.prompt,old.prompt);
    const again=model(s,s.library);
    assert.equal(again.selected(),s.library.selectedId);
    assert.equal(again.records().length,2);
});

test('built-in presets remain read-only and retain the three original criteria',()=>{
    const m=model({preset:'strict'});
    for(const preset of Object.keys(JEV_PRESETS)) {
        m.chooseBuiltin(preset);
        assert.equal(m.text(),JEV_PRESETS[preset]);
        m.edit('Never applied');
        assert.equal(m.text(),JEV_PRESETS[preset]);
        assert.equal(m.snapshot().prompt,'');
        assert.equal(m.snapshot().preset,preset);
    }
    assert.equal(m.remove(),false);
    assert.equal(m.rename('Cannot rename'),false);
});

test('named prompt creation, edit, rename, save-as, switching and deletion',()=>{
    const m=model({preset:'generous'});
    assert.equal(m.add('A'),true);
    const a=m.selected();
    m.edit('Rule A');
    assert.equal(m.dirty(),true);
    assert.equal(m.save(),true);
    assert.equal(m.rename('A new'),true);
    assert.equal(m.add('B'),true);
    const b=m.selected();
    m.edit('Rule B');
    m.choose(a);
    assert.equal(m.text(),'Rule A');
    m.choose(b);
    assert.equal(m.text(),'Rule B');
    assert.equal(m.snapshot().prompt,'Rule B');
    assert.equal(m.remove(),true);
    assert.equal(m.selected(),'builtin');
    assert.equal(m.snapshot().preset,'generous');
    assert.equal(m.snapshot().library.presets.length,1);
});

test('dialog state does not mutate stored settings until snapshot is committed',()=>{
    const stored={selectedId:'a',presets:[{id:'a',name:'A',text:'Old'}]};
    const m=model({prompt:'Old'},stored);
    m.edit('New');
    m.save();
    m.rename('Renamed');
    assert.deepEqual(stored,{selectedId:'a',presets:[{id:'a',name:'A',text:'Old'}]});
    assert.equal(m.snapshot().prompt,'New');
    assert.equal(m.snapshot().library.presets[0].name,'Renamed');
});

test('selecting default/reset preserves named custom prompts',()=>{
    const m=model({prompt:'Legacy rule'});
    const previous=m.selected();
    m.chooseBuiltin('balanced');
    const s=m.snapshot();
    assert.equal(s.prompt,'');
    assert.equal(s.library.presets.length,1);
    m.choose(previous);
    assert.equal(m.text(),'Legacy rule');
});

test('reject empty/invalid imports and duplicate names; import valid duplicates with unique names',()=>{
    const m=model();
    assert.equal(m.add('Default'),false);
    assert.equal(m.add('Empty',' '),false);
    assert.equal(m.importRecord({format:'sloth-summary-prompt',version:1,name:'Test',text:'Rule'}),false);
    assert.equal(m.importRecord({format:'stlo-jev-prompt',version:1,name:'Test',text:'Rule'}),true);
    assert.equal(m.importRecord({format:'stlo-jev-prompt',version:1,name:'Test',text:'Rule2'}),true);
    assert.equal(m.current().name,'Test (2)');
    m.edit('');
    assert.equal(m.snapshot(),null);
    m.edit('Rule3');
    assert.equal(m.snapshot().prompt,'Rule3');
});

test('options remain compatible with the generation engine',()=>{
    const m=model({preset:'strict'});
    m.add('Custom','Choose only current scene details.');
    const s=m.snapshot();
    const opts=normalizeJevOptions({...s,mode:'filtered',recent:7});
    assert.equal(opts.prompt,'Choose only current scene details.');
    assert.equal(opts.preset,'strict');
    assert.equal(opts.mode,'filtered');
    assert.equal(opts.recent,7);
    const resumed=model(opts,s.library);
    assert.equal(resumed.current().name,'Custom');
});
