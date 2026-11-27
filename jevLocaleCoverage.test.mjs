import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';

test('all shipped locales cover the adaptive, excerpt and efficiency report additions',()=>{
    const base=new URL('./locales/',import.meta.url);
    const en=JSON.parse(readFileSync(new URL('en.json',base),'utf8'));
    const keys=Object.keys(en).filter(key=>key.startsWith('stlo.metrics.')||/^stlo\.jev\.(adaptive|partial|modeAdaptive)/.test(key));
    assert.ok(keys.length>=63);
    const locales=readdirSync(base).filter(name=>name.endsWith('.json'));
    assert.equal(locales.length,11);
    for(const name of locales){
        const values=JSON.parse(readFileSync(new URL(name,base),'utf8'));
        for(const key of keys)assert.ok(typeof values[key]==='string'&&values[key].trim(),name+': '+key);
    }
});
