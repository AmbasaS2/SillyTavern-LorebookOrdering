// Generation-local measurement and reporting. Never reads lorebooks, polls,
// persists logs or initiates an AI request. Budget counts are host tokenizer
// results (estimates of prompt contribution), not provider usage.
export const METRICS_VERSION=1;
const validCount=n=>Number.isSafeInteger(n)&&n>=0;
const inputCount=(...values)=>values.find(validCount)??null;
export function extractJevUsage(usage, fallback){
    const inputTokens=inputCount(usage?.prompt_tokens,usage?.input_tokens,fallback?.input_tokens);
    const outputTokens=inputCount(usage?.completion_tokens,usage?.output_tokens,fallback?.output_tokens);
    const cacheReadTokens=inputCount(usage?.prompt_tokens_details?.cached_tokens,usage?.input_tokens_details?.cached_tokens,usage?.cache_read_input_tokens,fallback?.cache_read_input_tokens);
    const cacheWriteTokens=inputCount(usage?.cache_creation_input_tokens,fallback?.cache_creation_input_tokens);
    return {inputTokens,...(outputTokens===null?{}:{outputTokens}),...(cacheReadTokens===null?{}:{cacheReadTokens}),...(cacheWriteTokens===null?{}:{cacheWriteTokens})};
}
export function createUsageTracker(){
    const kinds=['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'];
    const sums=Object.fromEntries(kinds.map(key=>[key,0]));
    const counts=Object.fromEntries(kinds.map(key=>[key,0]));
    let successful=0;
    return {
        add(result){
            successful++;
            for(const key of kinds)if(validCount(result?.[key])){sums[key]+=result[key];counts[key]++;}
        },
        summary(){
            const get=k=>counts[k]?sums[k]:undefined;
            return {successfulRequests:successful,actualInputTokens:get('inputTokens'),usageReportedBatches:counts.inputTokens,
                actualOutputTokens:get('outputTokens'),outputUsageBatches:counts.outputTokens,
                cacheReadTokens:get('cacheReadTokens'),cacheReadBatches:counts.cacheReadTokens,
                cacheWriteTokens:get('cacheWriteTokens'),cacheWriteBatches:counts.cacheWriteTokens};
        },
    };
}
// The exact text is a Map key, not a lossy content hash. The descriptor
// includes target + tokenizer + effective padding. Distinct rendered text,
// combined vs individual measurements and edits never share a count.
// Bounded FIFO; concurrent requests for the same descriptor share a promise.
export function createTokenLedger({maxEntries=2048,maxChars=2000000}={}){
    const buckets=new Map(),records=new Set();
    let chars=0;
    const descriptor=d=>typeof d?.target==='string'&&d.target.length>0&&typeof d.tokenizer==='string'&&d.tokenizer.length>0&&typeof d.text==='string'&&
        (d.padding===undefined||Number.isSafeInteger(d.padding))?JSON.stringify([d.target,d.tokenizer,d.padding??null]):null;
    const find=d=>{const key=descriptor(d);return key===null?undefined:buckets.get(key)?.get(d.text);};
    function drop(record){
        const bucket=buckets.get(record.key);
        if(bucket?.get(record.text)!==record)return;
        bucket.delete(record.text);if(!bucket.size)buckets.delete(record.key);
        records.delete(record);chars-=record.text.length;
    }
    return {
        lookup(d){const record=find(d);return validCount(record?.value)?record.value:null;},
        async measure(d,measure,isStillValid=()=>true){
            const key=descriptor(d);
            if(key===null||typeof measure!=='function'||!isStillValid())return null;
            const existing=find(d);
            if(existing)return existing.promise;
            if(d.text.length>maxChars||maxEntries<1){
                const value=await measure();return validCount(value)?value:null;
            }
            while(records.size>=maxEntries||chars+d.text.length>maxChars){
                const first=records.values().next().value;
                if(!first)break;drop(first);
            }
            const record={key,text:d.text,value:null,promise:null};
            if(!buckets.has(key))buckets.set(key,new Map());
            buckets.get(key).set(d.text,record);records.add(record);chars+=d.text.length;
            record.promise=Promise.resolve().then(measure).then(value=>{
                if(!validCount(value)||(value===0&&d.text.trim())){drop(record);return null;}
                if(!isStillValid())drop(record);
                else record.value=value;
                return value;
            },()=>{drop(record);return null;});
            return record.promise;
        },
        clear(){buckets.clear();records.clear();chars=0;},
    };
}

export function summarizeBookBudgets(entries, limits, knownCount, keyOf, originallyIgnored, selectedKeys=new Set(), managedWorlds=new Set()){
    const books=new Map();
    const rowFor=world=>{
        if(!books.has(world)){
            const configured=limits.get(world);
            books.set(world,{world,cap:validCount(configured)&&configured>0?configured:null,
                capKnown:limits.has(world),activated:0,budgetUsedKnown:0,budgetUnknown:0,ignored:0,
                recalled:0,recalledBudgetKnown:0,recalledBudgetUnknown:0,jevUsedKnown:0,jevUnknown:0});
        }
        return books.get(world);
    };
    for(const world of limits.keys())rowFor(world);
    const seen=new Set();
    for(const entry of entries){
        if(typeof entry?.world!=='string'||entry.disable)continue;
        const key=keyOf(entry);if(seen.has(key))continue;seen.add(key);
        const row=rowFor(entry.world);row.activated++;
        const count=knownCount(entry);
        const known=validCount(count)&&!(count===0&&String(entry.content??'').trim());
        if(originallyIgnored(entry))row.ignored++;
        else if(known)row.budgetUsedKnown+=count;else row.budgetUnknown++;
        if(managedWorlds.has(entry.world)&&!entry.outletName&&Number(entry.position)!==7){
            if(known)row.jevUsedKnown+=count;else row.jevUnknown++;
        }
        if(selectedKeys.has(key)){
            row.recalled++;
            if(known)row.recalledBudgetKnown+=count;else row.recalledBudgetUnknown++;
        }
    }
    return [...books.values()].map(row=>({...row,
        remaining:row.cap!==null&&row.budgetUnknown===0?Math.max(0,row.cap-row.budgetUsedKnown):null,
        over:row.cap!==null&&row.budgetUnknown===0?Math.max(0,row.budgetUsedKnown-row.cap):null}));
}

export function summarizeFunnel(report,trimReasons,activatedKeys,acceptedKeys){
    const activated=activatedKeys===null?null:[...acceptedKeys].filter(key=>activatedKeys.has(key)).length;
    const trims={book:0,jev:0,world:0};
    for(const [key,reason] of trimReasons){
        if(acceptedKeys.has(key)&&!activatedKeys?.has(key)&&Object.hasOwn(trims,reason))trims[reason]++;
    }
    const budgetTrimmed=trims.book+trims.jev+trims.world;
    return {assessed:report.assessed??null,selected:report.selected??null,accepted:report.accepted??null,activated,
        scanBudgetBook:trims.book,scanBudgetJev:trims.jev,scanBudgetWorld:trims.world,
        otherNotActivated:activated===null?null:Math.max(0,acceptedKeys.size-activated-budgetTrimmed)};
}

// A provider receipt can report only final, structurally/otherwise genuinely
// verified RP inclusion. An activation receipt alone is never sufficient.
// Lookup uses the actual rendered text, not the stored or budget body.
export function summarizeInjection(records, expectedKeys, ledger, tokenizer, complete){
    if(!Array.isArray(records)||typeof complete!=='boolean')return null;
    const seen=new Set();
    let confirmed=0,measured=0,knownTokens=0,unknown=0,excluded=0;
    for(const record of records){
        if(!record||!expectedKeys.has(record.key)||seen.has(record.key))return null;
        seen.add(record.key);
        if(record.status==='excluded'){excluded++;continue;}
        if(record.status==='unknown'){unknown++;continue;}
        if(record.status!=='confirmed'||typeof record.text!=='string'||!record.text.trim())return null;
        confirmed++;
        const count=ledger.lookup({target:record.key,text:record.text,tokenizer});
        if(validCount(count)){knownTokens+=count;measured++;}
    }
    const unreported=expectedKeys.size-seen.size;
    return {confirmed,measured,knownTokens,excluded,unknown:unknown+unreported,
        complete:complete&&unknown===0&&unreported===0,
        tokens:complete&&unknown===0&&unreported===0&&measured===confirmed?knownTokens:null,
        basis:'host-tokenizer-rendered-individual'};
}

// In-memory, per chat scope, no text or entry IDs retained in history.
export function historyRow(report){
    return {id:report.metricsId,time:report.metricsTime,mode:report.requestedMode??report.mode??'budget-only',phase:report.phase,
        candidates:report.candidates,assessed:report.assessed,selected:report.selected,accepted:report.accepted,activated:report.activationObserved?report.injected:null,
        requests:report.requests,successfulRequests:report.successfulRequests,
        estimatedInputTokens:report.estimatedInputTokens,actualInputTokens:report.actualInputTokens,usageReportedBatches:report.usageReportedBatches,
        actualOutputTokens:report.actualOutputTokens,outputUsageBatches:report.outputUsageBatches,
        cacheReadTokens:report.cacheReadTokens,cacheReadBatches:report.cacheReadBatches,
        requestMs:report.requestMs,elapsedMs:report.elapsedMs,finalRecallBudgetTokens:report.finalRecallBudgetTokens,
        rpTokens:report.rpInjection?.tokens??null,rpConfirmed:report.rpInjection?.confirmed??null};
}
