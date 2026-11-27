import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';

test('all eleven shipped locales contain every English UI translation key',()=>{
    const base=new URL('./locales/',import.meta.url);
    const en=JSON.parse(readFileSync(new URL('en.json',base),'utf8'));
    const keys=Object.keys(en);
    assert.ok(keys.length>=301);
    const locales=readdirSync(base).filter(name=>name.endsWith('.json'));
    assert.equal(locales.length,11);
    for(const name of locales){
        const values=JSON.parse(readFileSync(new URL(name,base),'utf8'));
        for(const key of keys){
            assert.ok(typeof values[key]==='string'&&values[key].trim(),name+': '+key);
            const placeholders=value=>[...value.matchAll(/\$\{\d+\}/g)].map(x=>x[0]).sort();
            assert.deepEqual(placeholders(values[key]),placeholders(en[key]),name+' placeholders: '+key);
        }
    }
});
