import { event_types, eventSource } from '../../../events.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import * as stloTokenizers from '../../../tokenizers.js';
import { getStringHash, getCharaFilename } from '../../../utils.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { characters, this_chid, main_api, getCurrentChatId, getMaxContextSize, getRequestHeaders, saveSettingsDebounced, stopGeneration, getCharacterCardFields } from '../../../../script.js';
import { loadWorldInfo, saveWorldInfo, worldInfoCache, world_info, world_info_character_strategy, world_info_insertion_strategy, world_info_budget, world_info_budget_cap, world_names, selected_world_info, METADATA_KEY, getSortedEntries, checkWorldInfo, world_info_include_names } from '../../../world-info.js';
import { power_user } from '../../../power-user.js';
import { NOTE_MODULE_NAME } from '../../../authors-note.js';
import { POPUP_TYPE, Popup } from '../../../popup.js';
import { addLocaleData, getCurrentLocale, translate, t, applyLocale } from '../../../i18n.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { applyJevRecall, fitJevRecall, getNanoJevConnection, jevEntryKey, normalizeJevBudget, prepareJevRecall, requestJevRecall, getJevWorlds, normalizeJevOptions, planJevRequests, splitJevBatch, rankJevDecisions, JEV_PRESETS, isJevCandidate, selectAdaptiveJevMode, DEFAULT_JEV_ADAPTIVE_THRESHOLD, createAdaptiveCueCache, coverAdaptiveJevCandidates, applyJevExcerpts, createAdaptivePlanCache, estimateAdaptiveJevPlan, routeAdaptiveJevEstimate } from './jevRecall.mjs';

import { createJevPromptLibrary, mountJevPromptLibrary } from './jevPromptLibrary.mjs';
import { METRICS_VERSION, createUsageTracker, createTokenLedger, summarizeBookBudgets, summarizeFunnel, summarizeScanTrims, summarizeInjection, historyRow } from './jevMetrics.mjs';

function slothToastTitle() {
    const locale = String(getCurrentLocale() || '').toLowerCase();
    return '🦥 ' + (/^ko(?:[-_]|$)/.test(locale) ? '로어북 예산 관리' : 'STLO');
}

const EXTENSION_NAME = 'stlo';
const SELECTORS = {
    WORLD_EDITOR_SELECT: '#world_editor_select',
    LOREBOOK_PRIORITY_SELECT: 'lorebook_priority_select',
    LOREBOOK_BUDGET_MODE: 'lorebook_budget_mode',
    LOREBOOK_BUDGET_VALUE: 'lorebook_budget_value',
    LOREBOOK_BUDGET_VALUE_CONTAINER: 'lorebook_budget_value_container',
    LOREBOOK_RANDOM_TRIM: 'lorebook_random_trim',
    LOREBOOK_VECTOR_THRESHOLD: 'lorebook_vector_threshold'
};

// Default settings for lorebooks
const DEFAULT_LOREBOOK_SETTINGS = {
    priority: null,     // null = default priority (3)
    budget: null,       // value semantics depend on budgetMode
    budgetMode: 'default', // 'default' | 'percentage_context' | 'percentage_budget' | 'fixed'
    orderAdjustment: 0, // Order adjustment value (-10000 to +10000, default 0)
    orderAdjustmentGroupOnly: false, // Only apply order adjustment in group chats
    characterOverrides: {},  // Character-specific priority overrides for group chats
    onlyWhenSpeaking: false,  // Only activate in group chats when assigned characters are speaking
    randomTrim: false,
    vectorThreshold: null,
    vectorThresholdEnabled: false, // opt-in: old saved thresholds must not silently reactivate paid calls
    jevRecall: false,
    jevExclude: false
};

// Global switch for prioritizing always-on World Info entries across lorebooks.
// Explicit opt-in. An unset value must not change SillyTavern's behavior.
function getProtectAlwaysOn() {
    return extension_settings[EXTENSION_NAME]?.protectAlwaysOn === true;
}
function setProtectAlwaysOn(value) {
    extension_settings[EXTENSION_NAME] = {
        ...(extension_settings[EXTENSION_NAME] || {}),
        protectAlwaysOn: Boolean(value),
    };
    saveSettingsDebounced();
}

// Cleanup tracking
let eventListeners = [];
let jevGeneration = null;
let nativeVectorPasses = 0;
let guardedVectorInterceptor = null;
let lastJevReport = null;
let metricsCurrent=null;
let metricsSerial=0;
let metricsHistory=[];
const adaptiveCueCache = createAdaptiveCueCache();
const adaptivePlanCache = createAdaptivePlanCache();
let adaptivePlanScope = null;
let adaptiveCueScope = null;

function getCachedLorebook(world) {
    // Read cached metadata without cloning the entries in StructuredCloneMap.get().
    return worldInfoCache instanceof Map ? Map.prototype.get.call(worldInfoCache, world) : worldInfoCache.get(world);
}

function getJevCharacterAvatar(context = getContext()) {
    return context.groupId == null ? characters?.[this_chid]?.avatar : undefined;
}

function getCharacterJevRecall(avatar) {
    const byCharacter = extension_settings[EXTENSION_NAME]?.jevByCharacter;
    return avatar ? !!(byCharacter && Object.hasOwn(byCharacter, avatar) && byCharacter[avatar] === true) : undefined;
}

function setCharacterJevRecall(settings, avatar, choice) {
    if (!avatar || !['on', 'off'].includes(choice)) return;
    settings.jevByCharacter = { ...(settings.jevByCharacter ?? {}), [avatar]: choice === 'on' };
}

async function hasActiveJevLorebook(context) {
    const worlds = new Set([
        ...selected_world_info,
        ...(getCurrentCharacterLinkedLorebooks() ?? []),
        context.chatMetadata?.[METADATA_KEY],
        power_user.persona_description_lorebook,
    ]);
    const uncached = [];
    for (const world of worlds) {
        if (!world) continue;
        if (worldInfoCache.has(world)) {
            const book = getCachedLorebook(world)?.[EXTENSION_NAME];
            if (book?.jevRecall === true && book.jevExclude !== true) return true;
        } else if (world_names.includes(world)) {
            uncached.push(world);
        }
    }
    // On a cold cache, reuse the normal World Info loader so the scan can read
    // those same cached books without a second set of requests.
    const books = await Promise.allSettled(uncached.map(world => loadWorldInfo(world)));
    return books.some(book => book.status === 'fulfilled' && book.value?.[EXTENSION_NAME]?.jevRecall === true && book.value[EXTENSION_NAME].jevExclude !== true);
}

function hasEnabledVectorRecall() {
    if (extension_settings.disabledExtensions?.includes('vectors')) return false;
    const vectors = extension_settings.vectors;
    return Boolean(vectors?.enabled_world_info || vectors?.enabled_chats || vectors?.enabled_files);
}

function isCurrentJev(run) {
    return Boolean(run && run === jevGeneration && !run.controller.signal.aborted && run.chatId === getCurrentChatId() && (!run.metrics || run.metrics.scope===metricsScope()));
}

function getJevOptions() {
    return normalizeJevOptions(extension_settings[EXTENSION_NAME]?.jevOptions ?? {});
}

// A bounded, ephemeral report; never retain prompts, credentials or lore text.
function updateJevReport(run, changes = {}) {
    if (!isCurrentJev(run)) return;
    const previousPhase = run.report?.phase;
    run.report = { ...run.report, ...changes, elapsedMs: Math.round(performance.now() - run.startedAt) };
    lastJevReport = { chatId: run.chatId, ...run.report };
    try {
        if (previousPhase !== run.report.phase) syncJevTopBar();
    } catch (error) { stloDebug('Jev report UI:', error); }
}
function currentJevReport() {
    if(!lastJevReport||lastJevReport.chatId!==getCurrentChatId())return null;
    if(lastJevReport.metricsScope!==undefined&&lastJevReport.metricsScope!==metricsScope())return null;
    return lastJevReport;
}
// Only share a known, stable host tokenizer identity. Remote/dynamic or
// unavailable tokenizer identities fail closed (ordinary STLO still works).
function metricsTokenizer(){
    try{
        if(typeof main_api!=='string'||typeof stloTokenizers==='undefined')return null;
        if(main_api==='openai'){
            const model=stloTokenizers.getTokenizerModel?.();
            return typeof model==='string'&&model?'st-1:openai:'+JSON.stringify([getContext()?.chatCompletionSettings?.chat_completion_source??null,model,power_user.tokenizer??null]):null;
        }
        const configured=Number(power_user.tokenizer);
        const resolved=configured===stloTokenizers.tokenizers?.BEST_MATCH?stloTokenizers.getTokenizerBestMatch?.(main_api):configured;
        return Number.isSafeInteger(resolved)&&resolved>0&&![6,9,10,99].includes(resolved)?'st-1:'+main_api+':'+resolved:null;
    }catch{return null;}
}
function metricsScope(){
    const context=getContext();
    return JSON.stringify([getCurrentChatId(),getJevCharacterAvatar(context),context.groupId??null,EXTENSION_STATE.currentSpeakingCharacter??null]);
}
function currentMetrics(){
    try{return metricsCurrent&&metricsCurrent.scope===metricsScope()?metricsCurrent:null;}catch{return null;}
}
function canShareMetrics(m,tokenizer=metricsTokenizer()){
    if(!m||m.sharingInvalidated)return false;
    if(m.tokenizer!==tokenizer){
        // Once an incompatible tokenizer was observed, an old opaque handle
        // must not revive when the user later returns to that tokenizer.
        m.sharingInvalidated=true;
        m.ledger.clear();m.companionPending.clear();
        return false;
    }
    return Boolean(tokenizer);
}
function beginMetrics(run){
    // One latest generation ledger; history stores numeric snapshots only.
    metricsCurrent?.ledger.clear();
    const scope=metricsScope();
    if(metricsHistory.length&&metricsHistory[0].scope!==scope)metricsHistory=[];
    const id=++metricsSerial;
    const metrics={id,scope,handle:Object.freeze({id}),tokenizer:metricsTokenizer(),ledger:createTokenLedger(),
        usage:createUsageTracker(),limits:new Map(),trims:new Map(),selected:new Map(),accepted:new Set(),
        activated:null,pending:null,localCounts:new WeakMap(),companionPending:new Map(),recallEnabled:false,active:false};
    metricsCurrent=metrics;
    run.metrics=metrics;
    run.report={...run.report,metricsId:id,metricsTime:Date.now(),metricsScope:scope};
}
function archiveMetrics(run){
    if(!run?.metrics?.active||run.report.metricsId!==run.metrics.id)return;
    const row={...historyRow(run.report),scope:run.metrics.scope};
    metricsHistory=[row,...metricsHistory.filter(item=>item.id!==row.id&&item.scope===row.scope)].slice(0,8);
}
function observeBudgetCount(m,entry,text,count,tokenizer){
    if(!m||currentMetrics()!==m||metricsTokenizer()!==tokenizer)return;
    if(Number.isSafeInteger(count)&&count>=0&&!(count===0&&text.trim()))
        m.localCounts.set(entry,{text,count,tokenizer});
}
async function countWithLoreInsight(text,padding){
    const companion=globalThis.STWII?.loreTokenCountV1;
    const m=currentMetrics();
    const tokenizer=metricsTokenizer();
    const valid=()=>currentMetrics()===m&&metricsTokenizer()===tokenizer;
    // The companion shares the exact unpadded OpenAI input. Multiple entry
    // keys can have identical text; do not bypass the pending shared count.
    if(padding===undefined&&typeof main_api==='string'&&main_api==='openai'&&m&&tokenizer&&m.tokenizer===tokenizer&&
        companion?.apiVersion===1&&typeof companion.count==='function'){
        const previous=m.companionPending.get(text);
        if(previous)return previous;
        const pending=Promise.resolve().then(async()=>{
            if(!valid())return null;
            try{
                const value=await companion.count(text);
                if(!valid())return null;
                if(Number.isSafeInteger(value)&&value>=0&&!(value===0&&text.trim()))return value;
            }catch{/* Optional viewer must not change admission policy. */}
            if(!valid())return null;
            return getTokenCountAsync(text);
        });
        m.companionPending.set(text,pending);
        try{return await pending;}
        finally{if(m.companionPending.get(text)===pending)m.companionPending.delete(text);}
    }
    return padding===undefined?getTokenCountAsync(text):getTokenCountAsync(text,padding);
}
async function countBudgetEntry(entry){
    const m=currentMetrics();
    const content=typeof entry?.content==='string'?entry.content:'';
    if(!m||jevGeneration?.metrics!==m||!isCurrentJev(jevGeneration)||!entry||typeof entry!=='object')return getEntryTokenCountCached(entry);
    const text=content+'\n';
    const tokenizer=metricsTokenizer();
    let count;
    if(canShareMetrics(m,tokenizer)){
        count=await m.ledger.measure({target:jevEntryKey(entry),text,tokenizer},()=>countWithLoreInsight(text),
            ()=>currentMetrics()===m&&metricsTokenizer()===tokenizer);
        count=count??0;
    }else{
        // Unknown tokenizer cannot safely share across cloned entries. If
        // identity changed mid-run, do not use the old object count cache.
        count=m.sharingInvalidated?await getTokenCountAsync(text).catch(()=>0):await getEntryTokenCountCached(entry);
    }
    observeBudgetCount(m,entry,text,count,tokenizer);
    return count;
}
function knownBudgetCount(m,entry){
    const text=String(entry.content??'')+'\n';
    const tokenizer=metricsTokenizer();
    const local=m.localCounts.get(entry);
    if(local?.text===text&&local.tokenizer===tokenizer)return local.count;
    if(canShareMetrics(m,tokenizer))return m.ledger.lookup({target:jevEntryKey(entry),text,tokenizer});
    return null;
}
function publishScanMetrics(run, entries, observed){
    try{
        const m=run?.metrics;
        if(!m?.active||!isCurrentJev(run))return;
        const keys=new Set(entries.map(jevEntryKey));
        if(observed)m.activated=keys;
        else if(m.activated!==null)return;
        const pending=m.pending;
        const matches=!!pending&&keys.size===pending.keys.size&&[...keys].every(key=>pending.keys.has(key));
        const funnel=run.enabled?summarizeFunnel(run.report,m.trims,observed?keys:null,m.accepted):{};
        const allTrims=summarizeScanTrims(m.trims,keys);
        const observedTotals={totalActivated:observed?keys.size:null,totalScanDropped:observed?allTrims.total:null};
        // A real activation event with different keys must not inherit an
        // unrelated scan's budget total. Retain the observed funnel only.
        if(!matches){
            if(observed)updateJevReport(run,{phase:'done',...(run.enabled?{}:{mode:'budget-only'}),...funnel,...observedTotals,activationObserved:true,bookBudgetObserved:false,
                bookBudgets:undefined,finalRecallBudgetTokens:null,finalRecallBudgetKnown:undefined,finalRecallBudgetUnknown:undefined,
                sharedJevBudget:undefined,sharedJevUsed:undefined,sharedJevRemaining:undefined,
                ...(run.enabled?{injected:funnel.activated}:{})});
            return;
        }
        const rows=pending.rows;
        const recalledUnknown=rows.reduce((n,row)=>n+row.recalledBudgetUnknown,0);
        const known=rows.reduce((n,row)=>n+row.recalledBudgetKnown,0);
        const jevKnown=rows.reduce((n,row)=>n+row.jevUsedKnown,0);
        const jevUnknown=rows.reduce((n,row)=>n+row.jevUnknown,0);
        const jevCap=run.selection?.budget;
        updateJevReport(run,{phase:'done',...(run.enabled?{}:{mode:'budget-only'}),
            ...funnel,...observedTotals,activationObserved:observed,bookBudgetObserved:observed,bookBudgets:rows,
            finalRecallBudgetKnown:run.enabled&&observed?known:undefined,finalRecallBudgetUnknown:run.enabled&&observed?recalledUnknown:undefined,
            finalRecallBudgetTokens:run.enabled&&observed&&!recalledUnknown?known:null,
            sharedJevBudget:jevCap,sharedJevUsed:observed&&jevCap!==undefined&&!jevUnknown?jevKnown:null,
            sharedJevRemaining:observed&&jevCap!==undefined&&!jevUnknown?Math.max(0,jevCap-jevKnown):null,
            ...(run.enabled&&observed?{injected:funnel.activated}:{})});
    }catch(error){stloDebug('Optional scan report:',error);}
}
function stageScanMetrics(run,entries,originallyIgnored){
    try{
        const m=run?.metrics;
        if(!m||!isCurrentJev(run)||m.activated!==null)return;
        m.active=true;
        const list=[...entries];
        const rows=summarizeBookBudgets(list,m.limits,entry=>knownBudgetCount(m,entry),jevEntryKey,originallyIgnored,
            m.accepted,run.selection?.worlds??new Set(),m.trims);
        m.pending={rows,keys:new Set(list.map(jevEntryKey))};
        publishScanMetrics(run,list,false);
    }catch(error){stloDebug('Optional scan measurement:',error);}
}
// Optional contract, consumed by STWII only on its existing generation and
// measurement paths. Never ask it to measure and never scan its DOM or data.
// The handle remains valid for the last completed generation, until a new
// generation, chat/group switch or incompatible tokenizer invalidates it.
function installMemoryMetricsBridge(){
    globalThis.STLOMemoryMetrics=Object.freeze({
        version:METRICS_VERSION,
        context(){
            const m=currentMetrics();const tokenizer=metricsTokenizer();
            return m?.active&&canShareMetrics(m,tokenizer)?{generation:m.handle,tokenizer}:null;
        },
        lookup({generation,tokenizer,target,text,padding}={}){
            const m=currentMetrics();
            if(!m?.active||m.handle!==generation||!canShareMetrics(m)||m.tokenizer!==tokenizer)return null;
            return m.ledger.lookup({target,text,tokenizer,padding});
        },
        async measure({generation,tokenizer,target,text,padding}={}){
            const m=currentMetrics();
            const valid=()=>currentMetrics()===m&&m?.active&&m.handle===generation&&canShareMetrics(m)&&m.tokenizer===tokenizer;
            if(!valid()||typeof text!=='string'||typeof target!=='string')return null;
            // The current companion counter calls the host directly. A future
            // recursive adapter must not wait on its own in-flight promise.
            if(m.companionPending.has(text))return m.ledger.lookup({target,text,tokenizer,padding});
            const result=await m.ledger.measure({target,text,tokenizer,padding},()=>countWithLoreInsight(text,padding),valid);
            return valid()?result:null;
        },
        selection({generation,key}={}){
            const m=currentMetrics();
            if(!m?.active||m.handle!==generation||!canShareMetrics(m)||typeof key!=='string')return null;
            const selected=m.selected.get(key);
            if(!selected)return null;
            return {...selected,budget:m.accepted.has(key)?(m.trims.get(key)??'accepted'):(selected.budget??'not-accepted'),
                activated:m.activated===null?null:m.activated.has(key)};
        },
        publishInjection({generation,tokenizer,records,complete}={}){
            const m=currentMetrics();
            if(!m?.active||!m.recallEnabled||m.handle!==generation||!canShareMetrics(m)||m.tokenizer!==tokenizer||m.activated===null)return false;
            // The companion owns final payload evidence. We aggregate only
            // STLO-selected entries; ignore native-only entries on this side.
            if(!Array.isArray(records))return false;
            const expected=new Set([...m.accepted].filter(key=>m.activated.has(key)));
            const relevant=records.filter(record=>expected.has(record?.key));
            const summary=summarizeInjection(relevant,expected,m.ledger,tokenizer,complete);
            if(!summary)return false;
            const run=jevGeneration;
            if(run?.metrics===m&&isCurrentJev(run))updateJevReport(run,{rpInjection:summary});
            else if(lastJevReport?.metricsId===m.id&&lastJevReport.chatId===getCurrentChatId()){
                lastJevReport={...lastJevReport,rpInjection:summary};
                metricsHistory=metricsHistory.map(row=>row.id===m.id?{...row,rpTokens:summary.tokens,rpConfirmed:summary.confirmed}:row);
            }else return false;
            return true;
        },
    });
}

function jevStatusLabel(phase) {
    const names = {
        preparing: ['Preparing candidates', 'stlo.jev.status.preparing'],
        running: ['Jev is deciding', 'stlo.jev.status.running'],
        retry: ['Waiting for retry or cancel', 'stlo.jev.status.retry'],
        ready: ['Selection ready', 'stlo.jev.status.ready'],
        done: ['Recall complete', 'stlo.jev.status.done'],
        cancelled: ['Reply cancelled', 'stlo.jev.status.cancelled'],
        empty: ['No eligible candidates', 'stlo.jev.status.empty'],
    };
    const pair = names[phase] ?? ['No recall report yet', 'stlo.jev.status.none'];
    return translate(...pair);
}
function metricUsageText(value,reported,successful){
    if(successful===undefined)return undefined;
    if(!Number.isFinite(value)||!reported)return translate('Unmeasured','stlo.metrics.unmeasured');
    return value.toLocaleString()+' ('+reported+'/'+successful+')';
}
function reportNode(parent,tag,className,text){
    const node=document.createElement(tag);
    if(className)node.className=className;
    if(text!==undefined)node.textContent=String(text);
    parent?.append(node);
    return node;
}
function makeReportSection(panel,label,open=false){
    const details=reportNode(panel,'details','stlo-report-section');
    details.open=open;
    reportNode(details,'summary','',label);
    return reportNode(details,'div','stlo-report-section-body');
}
function reportLine(parent,label,value){
    const row=reportNode(parent,'div','stlo-report-row');
    reportNode(row,'span','',label);
    reportNode(row,'span','stlo-report-value',value);
}
function reportNum(value){
    return Number.isFinite(value)?value.toLocaleString():translate('Unmeasured','stlo.metrics.unmeasured');
}
function reportSeconds(ms){
    return Number.isFinite(ms)?(ms/1000).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})+' '+reportLabel('seconds','s'):reportNum(null);
}
function reportUsage(value,reported,successful){
    return Number.isFinite(value)&&reported>0&&Number.isFinite(successful)?reportNum(value):reportNum(null);
}
function reportLabel(key,fallback){return translate(fallback,'stlo.report.'+key);}
function reportNote(parent,text){return reportNode(parent,'small','stlo-report-note',text);}
function reportIcon(parent,name){
    const glyph=reportNode(parent,'i','fa-solid fa-'+name);
    glyph.setAttribute('aria-hidden','true');
}
function reportHeading(parent,label,icon){
    const row=reportNode(parent,'div','stlo-report-heading');
    if(icon)reportIcon(row,icon);
    reportNode(row,'h4','',label);
    return row;
}
function reportStat(parent,label,value,caption){
    const item=reportNode(parent,'div','stlo-report-stat');
    reportNode(item,'small','',label);
    reportNode(item,'strong','',value);
    if(caption)reportNote(item,caption);
    return item;
}
function reportBudgetBar(parent,cap,used){
    // Never infer a percentage from an unknown or unlimited budget.
    if(!Number.isFinite(cap)||cap<=0||!Number.isFinite(used)||used<0)return;
    const bar=reportNode(parent,'progress','stlo-report-budget-bar');
    bar.setAttribute('max',String(cap));
    bar.setAttribute('value',String(Math.min(cap,used)));
    bar.setAttribute('aria-label',reportLabel('budgetUse','Jev budget usage'));
}
function reportActivation(report){
    return report?.activationObserved===true&&Number.isFinite(report.injected)?report.injected:null;
}
function reportZeroBudgetExclusions(report){
    // Pre-admission and final scan counts are separate; do not sum uncertain
    // or provisional counters and present them as observed exclusions.
    const fields=['rejectedBook','rejectedJev','rejectedWorld','scanBudgetBook','scanBudgetJev','scanBudgetWorld'];
    return report.activationObserved===true&&fields.every(key=>report[key]===0);
}
function appendReportOverview(panel,report,budgetOnly){
    const status=budgetOnly?(report.phase==='cancelled'?jevStatusLabel('cancelled'):translate('Budget check complete','stlo.metrics.budgetComplete')):jevStatusLabel(report?.phase);
    const overview=reportNode(panel,'section','stlo-report-overview');
    const line=reportNode(overview,'div','stlo-report-status');
    reportNode(line,'span','',status);
    if(Number.isFinite(report?.elapsedMs))reportNode(line,'span','stlo-report-time',reportSeconds(report.elapsedMs));
    if(!report)return;
    const hero=reportNode(overview,'div','stlo-report-hero');
    const activated=budgetOnly?(report.activationObserved===true?report.totalActivated:null):reportActivation(report);
    reportNode(hero,'strong','',reportNum(activated));
    reportNode(hero,'span','',budgetOnly?translate('All activated lore entries','stlo.metrics.allActivated'):Number.isFinite(activated)?reportLabel('activated','Memories activated'):reportLabel('activatedShort','Activated'));
    if(!budgetOnly&&Number.isFinite(report.candidates))
        reportNote(hero,'/ '+reportNum(report.candidates)+' '+reportLabel('candidates','candidates'));
    if(budgetOnly){
        reportNote(overview,translate('Jev is off. Only existing lore budget checks are reported.','stlo.metrics.budgetOnlyHelp'));
        reportLine(overview,translate('All STLO scan budget exclusions','stlo.metrics.allScanExclusions'),reportNum(report.totalScanDropped));
        return;
    }
    const funnel=reportNode(overview,'div','stlo-report-funnel');
    const stages=[
        [reportLabel('assessed','Assessed'),report.assessed],
        [reportLabel('chosen','AI selected'),report.selected],
        [reportLabel('accepted','Within budget'),report.accepted],
        [reportLabel('activatedShort','Activated'),activated],
    ];
    for(const [label,value] of stages)reportStat(funnel,label,reportNum(value));
    if(reportZeroBudgetExclusions(report))reportNote(overview,reportLabel('noBudgetExclusions','No budget exclusions'));
    else if(report.activationObserved===false)reportNote(overview,translate('Provisional final scan; actual activation not confirmed.','stlo.metrics.provisional'));
}
function appendReportBudget(panel,report,budgetOnly){
    if(!report||report.metricsId===undefined)return;
    const tr=(label,key)=>translate(label,'stlo.metrics.'+key);
    if(!budgetOnly){
        const block=reportNode(panel,'section','stlo-report-primary');
        reportHeading(block,reportLabel('budgetUse','Jev budget usage'),'gauge-high');
        const value=reportNode(block,'div','stlo-report-hero stlo-report-budget-number');
        reportNode(value,'strong','',reportNum(report.sharedJevUsed));
        if(Number.isFinite(report.sharedJevBudget))reportNode(value,'span','','/ '+reportNum(report.sharedJevBudget)+' '+reportLabel('tokens','tokens'));
        if(Number.isFinite(report.sharedJevBudget)&&report.sharedJevBudget>0&&Number.isFinite(report.sharedJevUsed)&&report.sharedJevUsed>=0){
            reportNote(value,(100*report.sharedJevUsed/report.sharedJevBudget).toLocaleString(undefined,{maximumFractionDigits:1})+'%');
        }
        reportBudgetBar(block,report.sharedJevBudget,report.sharedJevUsed);
        if(Number.isFinite(report.sharedJevRemaining))reportLine(block,reportLabel('remaining','Remaining budget'),reportNum(report.sharedJevRemaining));
        const known=report.finalRecallBudgetUnknown?' ('+reportNum(report.finalRecallBudgetKnown)+' + '+report.finalRecallBudgetUnknown+' '+tr('Unmeasured','unmeasured')+')':'';
        reportLine(block,reportLabel('recalledTokens','Activated memories · full-text tokens'),reportNum(report.finalRecallBudgetTokens)+known);
        reportNote(block,reportLabel('budgetBasis','Host estimates from full text, not final RP tokens.'));
        if(!report.bookBudgetObserved&&report.bookBudgets)reportNote(block,tr('Provisional final scan; actual activation not confirmed.','provisional'));
        if(report.bookBudgetObserved&&report.bookBudgets){
            for(const book of report.bookBudgets.filter(book=>book.recalled>0)){
                const row=reportNode(block,'div','stlo-report-book-preview');
                reportIcon(row,'book-open');
                reportNode(row,'span','stlo-report-book-name',book.world);
                reportNode(row,'span','stlo-report-value',reportNum(book.recalled)+' · '+reportNum(book.recalledBudgetUnknown?null:book.recalledBudgetKnown)+' '+reportLabel('tokens','tokens'));
            }
        }
    }
}
function appendReportSearch(panel,report){
    if(!report||report.mode==='budget-only')return;
    const block=reportNode(panel,'section','stlo-report-primary');
    reportHeading(block,reportLabel('searchUsage','AI search usage'),'magnifying-glass');
    const grid=reportNode(block,'div','stlo-report-search-grid');
    const coverage=(reported,total)=>Number.isFinite(reported)&&Number.isFinite(total)&&reported<total?reportLabel('reportedRequests','Reported requests')+': '+reported+'/'+total:null;
    reportStat(grid,reportLabel('input','Input tokens'),reportUsage(report.actualInputTokens,report.usageReportedBatches,report.successfulRequests),coverage(report.usageReportedBatches,report.successfulRequests));
    reportStat(grid,reportLabel('output','Output tokens'),reportUsage(report.actualOutputTokens,report.outputUsageBatches,report.successfulRequests),coverage(report.outputUsageBatches,report.successfulRequests));
    reportStat(grid,reportLabel('requests','AI requests'),reportNum(report.requests));
    reportStat(grid,reportLabel('requestTime','AI request time'),reportSeconds(report.requestMs));
    reportNote(block,reportLabel('providerBasis','Provider-reported token usage; cache and estimates are in diagnostics.'));
}
function appendReportRP(panel,report){
    if(!report||report.mode==='budget-only')return;
    const block=reportNode(panel,'section','stlo-report-primary stlo-report-rp');
    reportHeading(block,reportLabel('rpInclusion','RP prompt inclusion'),'circle-info');
    const rp=report.rpInjection,activated=reportActivation(report);
    if(!rp){
        if(Number.isFinite(activated))reportLine(block,reportLabel('unknown','Unconfirmed'),reportNum(activated));
        reportNote(block,translate('Final RP inclusion is unmeasured unless a compatible viewer provides evidence. Activation is not proof of injection.','stlo.metrics.rpUnavailable'));
        return;
    }
    if(rp.confirmed===0&&rp.excluded===0&&rp.unknown>0){
        reportLine(block,reportLabel('unknown','Unconfirmed'),reportNum(rp.unknown));
    }else{
        const grid=reportNode(block,'div','stlo-report-rp-grid');
        for(const [label,value] of [[reportLabel('confirmed','Confirmed'),rp.confirmed],[reportLabel('excluded','Excluded'),rp.excluded],[reportLabel('unknown','Unconfirmed'),rp.unknown]])
            reportStat(grid,label,reportNum(value));
    }
    if(rp.unknown>0||rp.complete!==true)reportNote(block,reportLabel('rpPending','Activation alone does not confirm final RP inclusion.'));
    if(rp.confirmed>0||rp.complete===true){
        reportLine(block,reportLabel('rpTokens','Confirmed RP memory tokens'),reportNum(rp.tokens));
        if(rp.measured!==rp.confirmed)reportNote(block,reportLabel('rpMeasured','Measured entries')+': '+reportNum(rp.measured)+' / '+reportNum(rp.confirmed));
    }
}
function appendMemoryMetrics(panel,report){
    if(!report||report.metricsId===undefined)return;
    const unknown=translate('Unmeasured','stlo.metrics.unmeasured');
    const num=reportNum;
    const tr=(label,key)=>translate(label,'stlo.metrics.'+key);
    const row=reportLine,note=reportNote;
    const card=(parent,label)=>{
        const element=reportNode(parent,'div','stlo-report-book-card');
        reportNode(element,'strong','',label);
        return element;
    };
    const budgetOnly=report.mode==='budget-only';
    if(report.bookBudgets){
        const budgets=makeReportSection(panel,reportLabel('bookDetails','Book budgets'));
        if(budgetOnly)note(budgets,tr('Jev is off. Only existing lore budget checks are reported.','budgetOnlyHelp'));
        if(!report.bookBudgetObserved)note(budgets,tr('Provisional final scan; actual activation not confirmed.','provisional'));
        note(budgets,reportLabel('budgetBasis','Host estimates from full text, not final RP tokens.'));
        if(report.sharedJevBudget!==undefined)row(budgets,tr('Shared Jev budget / used / remaining','sharedBudget'),[report.sharedJevBudget,report.sharedJevUsed,report.sharedJevRemaining].map(num).join(' / '));
        for(const book of report.bookBudgets){
            const item=card(budgets,book.world);
            row(item,tr('Cap','cap'),book.capKnown?(book.cap===null?tr('Shared / no separate cap','noCap'):num(book.cap)):unknown);
            if(book.capKnown&&book.cap!==null&&book.budgetUnknown===0)reportBudgetBar(item,book.cap,book.budgetUsedKnown);
            row(item,tr('Used / remaining','usedRemaining'),num(book.budgetUsedKnown)+(book.budgetUnknown?' + '+book.budgetUnknown+' '+unknown:'')+' / '+(book.capKnown&&book.cap===null?'—':num(book.remaining)));
            if(book.over>0)row(item,tr('Over budget','over'),num(book.over));
            row(item,tr('Ignored budget entries','ignored'),num(book.ignored));
            row(item,tr('Activated','activated'),num(book.activated));
            row(item,tr('Removed by STLO scan budget','scanDropped'),num(book.scanDropped));
        }
    }
    if(metricsHistory.length){
        const recent=makeReportSection(panel,tr('Recent runs (this chat, session only)','recent'));
        for(const run of metricsHistory){
            const item=card(recent,new Date(run.time).toLocaleTimeString()+' · '+run.mode+' · '+jevStatusLabel(run.phase));
            if(run.mode==='budget-only'){
                row(item,tr('All activated lore entries','allActivated'),num(run.totalActivated));
                row(item,tr('All STLO scan budget exclusions','allScanExclusions'),num(run.totalScanDropped));
                continue;
            }
            row(item,reportLabel('activatedShort','Activated'),num(run.activated)+' / '+num(run.candidates));
            row(item,reportLabel('input','Input tokens'),metricUsageText(run.actualInputTokens,run.usageReportedBatches,run.successfulRequests)??unknown);
            row(item,reportLabel('output','Output tokens'),metricUsageText(run.actualOutputTokens,run.outputUsageBatches,run.successfulRequests)??unknown);
            row(item,reportLabel('requestTime','AI request time'),reportSeconds(run.requestMs));
            const detail=makeReportSection(item,reportLabel('historyDetails','Run details'));
            row(detail,tr('Candidates / assessed / selected / accepted / activated','funnel'),[run.candidates,run.assessed,run.selected,run.accepted,run.activated].map(num).join(' / '));
            row(detail,tr('Provider cache-read tokens (reported batches only)','cacheRead'),metricUsageText(run.cacheReadTokens,run.cacheReadBatches,run.successfulRequests)??unknown);
            row(detail,tr('Estimated input','estimated'),num(run.estimatedInputTokens));
            row(detail,tr('RP tokens','rpShort'),num(run.rpTokens));
        }
    }
}
function openJevReport() {
    const report=currentJevReport();
    const panel=reportNode(null,'div','stlo-jev-report');
    const budgetOnly=report?.mode==='budget-only';
    reportNode(panel,'h3','',budgetOnly?translate('Latest lorebook budget report','stlo.metrics.budgetReport'):reportLabel('title','Jev search result'));
    appendReportOverview(panel,report,budgetOnly);
    appendReportBudget(panel,report,budgetOnly);
    appendReportSearch(panel,report);
    appendReportRP(panel,report);
    appendMemoryMetrics(panel,report);
    const fields = budgetOnly ? [
        [translate('Status','stlo.jev.status'),report.phase==='cancelled'?jevStatusLabel('cancelled'):translate('Budget check complete','stlo.metrics.budgetComplete'),'overview'],
        [translate('All activated lore entries','stlo.metrics.allActivated'),report.totalActivated??null,'overview'],
        [translate('All STLO scan budget exclusions','stlo.metrics.allScanExclusions'),report.totalScanDropped??null,'overview'],
        [translate('Jev','stlo.jev.recall'),translate('Off','stlo.jev.off'),'overview'],
    ] : report ? [
        [translate('Status', 'stlo.jev.status'), jevStatusLabel(report.phase),'overview'],
        [translate('Adaptive full-plan estimate', 'stlo.jev.adaptiveEstimate'), report.adaptiveEstimate],
        [translate('Adaptive estimate cache hits / new calculations', 'stlo.jev.adaptivePlanCache'), report.adaptivePlanCacheHits===undefined?undefined:report.adaptivePlanCacheHits+' / '+report.adaptivePlanCacheMisses],
        [translate('Candidate route', 'stlo.jev.adaptiveRoute'), report.requestedMode==='adaptive'?
            translate(report.mode==='filtered'?'Native hits + memory coverage':'All eligible lorebook entries (default)',
                report.mode==='filtered'?'stlo.jev.adaptiveCoverageRoute':'stlo.jev.modeAll'):undefined],
        [translate('Adaptive decision', 'stlo.jev.adaptiveDecision'), report.adaptiveReason?
            translate(({empty:'No eligible candidates','within-threshold':'Within the estimated input threshold',
                'above-threshold':'Above the estimated input threshold','vector-unavailable':'World Info vector recall unavailable; assessed all',
                'empty-filter':'No native hits; assessed all','coverage-all':'Candidate coverage includes every eligible entry'})[report.adaptiveReason],
                'stlo.jev.adaptiveReason.'+report.adaptiveReason):undefined],
        [translate('Native hits', 'stlo.jev.adaptiveNative'), report.adaptiveNative],
        [translate('Additional durable-memory candidates', 'stlo.jev.adaptiveDurable'), report.adaptiveDurable],
        [translate('Additional concise memories', 'stlo.jev.adaptiveCompact'), report.adaptiveCompact],
        [translate('Additional long-term / NPC records', 'stlo.jev.adaptiveRoles'), report.adaptiveRoles],
        [translate('Additional metadata matches', 'stlo.jev.adaptiveAnchors'), report.adaptiveAnchors],
        [translate('Additional recent candidates', 'stlo.jev.adaptiveRecent'), report.adaptiveRecent],
        [translate('Eligible before candidate selection', 'stlo.metrics.eligible'), report.eligibleEntries??report.adaptiveEligible],
        [translate('Candidates', 'stlo.jev.candidates'), report.candidates,'overview'],
        [translate('Assessed candidates', 'stlo.metrics.assessed'), report.assessed,'overview'],
        [translate('Model selected', 'stlo.jev.selected'), report.selected,'overview'],
        [translate('Successful excerpt questions', 'stlo.jev.partialQuestions'), report.partialQuestions,'partial'],
        [translate('Confident excerpt selections', 'stlo.jev.partialSelected'), report.partialSelected,'partial'],
        [translate('Excerpts applied to final scan', 'stlo.jev.partialApplied'), report.partialApplied,'partial'],
        [translate('Characters removed from final scan (not tokens)', 'stlo.jev.partialSavedChars'), report.partialSavedChars,'partial'],
        [translate('Within budget', 'stlo.jev.accepted'), report.accepted,'overview'],
        [translate('Actually activated', 'stlo.jev.injected'), report.activationObserved===false?translate('Unmeasured','stlo.metrics.unmeasured'):report.injected,'overview'],
        [translate('All activated lore entries','stlo.metrics.allActivated'),report.totalActivated??undefined],
        [translate('All STLO scan budget exclusions','stlo.metrics.allScanExclusions'),report.totalScanDropped??undefined],
        [translate('Accepted but not activated (other/unknown reason)', 'stlo.metrics.otherNotActivated'), report.otherNotActivated??undefined],
        [translate('Final scan budget exclusions (book / Jev / world)', 'stlo.metrics.scanExclusions'), report.scanBudgetBook===undefined?undefined:[report.scanBudgetBook,report.scanBudgetJev,report.scanBudgetWorld].join(' / ')],
        [translate('Book budget rejected', 'stlo.jev.rejectedBook'), report.rejectedBook],
        [translate('Jev budget rejected', 'stlo.jev.rejectedJev'), report.rejectedJev],
        [translate('World Info budget rejected', 'stlo.jev.rejectedWorld'), report.rejectedWorld],
        [translate('Jev requests', 'stlo.jev.requests'), report.requests,'request'],
        [translate('Planned batches', 'stlo.jev.plannedBatches'), report.plannedBatches,'request'],
        [translate('Completed batches', 'stlo.jev.completedBatches'), report.completedBatches,'request'],
        [translate('Unassessed candidates', 'stlo.jev.unassessed'), report.unassessed,'request'],
        [translate('Shared background entries', 'stlo.jev.sharedEntries'), report.sharedEntries],
        [translate('Messages shortened by reading limit', 'stlo.jev.truncatedMessages'), report.truncatedMessages],
        [translate('Lore entries shortened by reading limit', 'stlo.jev.truncatedLore'), report.truncatedLore],
        [translate('Estimated input tokens (attempted requests)', 'stlo.jev.estimatedInputTokens'), report.estimatedInputTokens,'request'],
        [translate('Reported input tokens (successful requests)', 'stlo.jev.actualInputTokens'), report.actualInputTokens,'request'],
        [translate('Batches reporting token usage', 'stlo.jev.usageReportedBatches'), report.usageReportedBatches,'request'],
        [translate('Provider output tokens (reported batches only)', 'stlo.metrics.output'), metricUsageText(report.actualOutputTokens,report.outputUsageBatches,report.successfulRequests),'request'],
        [translate('Provider cache-read tokens (reported batches only)', 'stlo.metrics.cacheRead'), metricUsageText(report.cacheReadTokens,report.cacheReadBatches,report.successfulRequests),'request'],
        [translate('Provider cache-write tokens (reported batches only)', 'stlo.metrics.cacheWrite'), metricUsageText(report.cacheWriteTokens,report.cacheWriteBatches,report.successfulRequests),'request'],
        [translate('Native vector interceptor time (ms)', 'stlo.metrics.nativeTime'), report.nativeVectorMs,'request'],
        [translate('Native candidate scan time (ms)', 'stlo.metrics.previewTime'), report.previewMs,'request'],
        [translate('Request characters (not tokens)', 'stlo.jev.inputChars'), report.inputChars,'request'],
        [translate('Request time (ms)', 'stlo.jev.requestMs'), report.requestMs,'request'],
        [translate('Elapsed time (ms)', 'stlo.jev.elapsedMs'), report.elapsedMs,'request'],
    ] : [[translate('Status', 'stlo.jev.status'), jevStatusLabel(),'overview']];

    const detailRows=[];
    for(const [name,value,group] of fields){
        if(value===undefined||group==='overview')continue;
        detailRows.push([name,value,group??'selection']);
    }
    const sectionLabels={
        selection:translate('Candidate and budget decisions','stlo.metrics.selectionDetails'),
        partial:translate('Partial injection details','stlo.metrics.partialDetails'),
        request:reportLabel('diagnostics','Technical diagnostics'),
    };
    for(const group of ['selection','partial','request']){
        const rows=detailRows.filter(row=>row[2]===group);
        if(!rows.length)continue;
        const section=makeReportSection(panel,sectionLabels[group]);
        for(const [name,value] of rows)reportLine(section,name,typeof value==='number'||value===null?reportNum(value):value);
        if(group==='request'&&!budgetOnly){
            reportNote(section,translate('Provider usage and host estimates are different units; cached tokens are not added again. Actual billing and unreported usage are unknown.','stlo.metrics.units'));
            if(report?.rpInjection){
                const rp=report.rpInjection;
                reportLine(section,translate('RP confirmed / excluded / unknown','stlo.metrics.rpFunnel'),[rp.confirmed,rp.excluded,rp.unknown].map(reportNum).join(' / '));
                reportLine(section,translate('Confirmed RP Jev memory: rendered individual tokens (host estimate)','stlo.metrics.rpTokens'),reportNum(rp.tokens)+' ('+rp.measured+'/'+rp.confirmed+' '+translate('measured','stlo.metrics.measured')+')');
            }
        }
    }
    if(report?.error)reportNode(panel,'p','stlo-report-error',report.error);
    return new Popup(panel,POPUP_TYPE.TEXT,'',{okButton:translate('Close','stlo.jev.close'),leftAlign:true,allowVerticalScrolling:true}).show();
}
function syncJevTopBar() {
    const bar = document.getElementById('extensionTopBar');
    if (!bar) return;
    let button = document.getElementById('stlo-jev-topbar');
    const report = currentJevReport();
    if (!report) {
        button?.remove();
        return;
    }
    if (!button) {
        button = document.createElement('i');
        button.id = 'stlo-jev-topbar';
        button.className = 'fa-solid fa-scale-balanced fa-fw right_menu_button';
        button.tabIndex = 0;
        button.setAttribute('role', 'button');
        button.addEventListener('click', () => { void openJevReport(); });
        button.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                void openJevReport();
            }
        });
    }
    const jobs = document.getElementById('stmb-jobs-topbar');
    const close = document.getElementById('extensionTopBarCloseChat');
    const anchor = jobs?.parentElement === bar ? jobs.nextElementSibling : close?.parentElement === bar ? close : null;
    if (anchor !== button && (button.parentElement !== bar || button.nextElementSibling !== anchor)) {
        bar.insertBefore(button, anchor);
    }
    const label = translate('View latest injection calculation', 'stlo.manager.latestCalculation');
    if (button.title !== label) button.title = label;
    if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
    if (button.dataset.status !== report.phase) button.dataset.status = report.phase;
}

function guardNativeVectorInterceptor() {
    const interceptor = globalThis.vectors_rearrangeChat;
    if (typeof interceptor !== 'function') return false;
    if (interceptor === guardedVectorInterceptor) return true;
    guardedVectorInterceptor = async function (chat, contextSize, abort, type) {
        const run = jevGeneration;
        if (!run?.enabled || !isCurrentJev(run)) return interceptor.call(this, chat, contextSize, abort, type);
        nativeVectorPasses++;
        const vectorStarted=performance.now();
        try {
            await interceptor.call(this, chat, contextSize, abort, type);
        } catch (error) {
            if (run?.awaitingVector && isCurrentJev(run)) {
                await abortJevPreparation(run, abort, error);
                return;
            }
            throw error;
        } finally {
            nativeVectorPasses--;
            if(run?.metrics?.active&&isCurrentJev(run))updateJevReport(run,{nativeVectorMs:(run.report.nativeVectorMs??0)+Math.round(performance.now()-vectorStarted)});
        }
        // Native vector storage runs at its original loading order. Reuse its
        // results; never invoke the native interceptor ourselves or twice.
        if (run?.awaitingVector && isCurrentJev(run)) {
            run.awaitingVector = false;
            await prepareJevGeneration(run, chat, contextSize, abort, type);
        }
    };
    globalThis.vectors_rearrangeChat = guardedVectorInterceptor;
    return true;
}

function stopJevGeneration() {
    jevGeneration?.controller.abort();
    jevGeneration = null;
}
function finishJevGeneration() {
    const run = jevGeneration;
    if (run?.selection && run.report.phase === 'ready') recordJevActivated([],true);
    archiveMetrics(run);
    stopJevGeneration();
}
function onJevStopped() {
    const run=jevGeneration;
    if (run?.metrics?.active && run.report?.phase !== 'cancelled') {
        updateJevReport(run, { phase: 'cancelled' });
    }
    archiveMetrics(run);
    // ST 1.19.1 hideStopButton emits GENERATION_ENDED before STOPPED.
    // finishJevGeneration may already have released the run. A STOPPED
    // event invalidates the remaining handle even in that host ordering.
    const m=currentMetrics();
    if(m){
        m.ledger.clear();m.companionPending.clear();metricsCurrent=null;
        // Retain factual completed recall statistics, but never display an
        // unfinished preparation as still running after the host stopped.
        if(!run&&lastJevReport?.metricsId===m.id&&['preparing','running','retry','ready'].includes(lastJevReport.phase)){
            lastJevReport={...lastJevReport,phase:'cancelled'};
            metricsHistory=metricsHistory.map(row=>row.id===m.id?{...row,phase:'cancelled'}:row);
            syncJevTopBar();
        }
    }
    stopJevGeneration();
}
function startJevGeneration(type, _options, dryRun) {
    if (dryRun || !['normal', 'continue', 'regenerate', 'swipe'].includes(type)) return;
    stopJevGeneration();
    const chatId = getCurrentChatId();
    if (chatId) {
        jevGeneration = {
            chatId, controller: new AbortController(),
            characterRecall: getCharacterJevRecall(getJevCharacterAvatar()),
            options: getJevOptions(),
            forced: new Map(), startedAt: performance.now(),
            report: { requests: 0, requestMs: 0 },
        };
        beginMetrics(jevGeneration);
    }
}
function rememberForcedEntries(entries) {
    const run = jevGeneration;
    if (!run?.enabled || run.options.mode !== 'filtered' || run.replaying || !isCurrentJev(run) || !Array.isArray(entries)) return;
    for (const entry of entries) {
        if (entry?.world && entry.uid != null) run.forced.set(jevEntryKey(entry), structuredClone(entry));
    }
}

// Runs before the native RP request, using ST's supported abort callback.
async function stloJevInterceptor(chat, contextSize, abort, type) {
    const run = jevGeneration;
    if (!run || !HAS_WORLDINFO_SCAN_DONE || !isCurrentJev(run) || !['normal', 'continue', 'regenerate', 'swipe'].includes(type)) return;
    try {
        run.enabled = run.characterRecall ?? await hasActiveJevLorebook(getContext());
        if (!isCurrentJev(run)) { abort(true); return; }
        if (!run.enabled) {
            lastJevReport = null;
            syncJevTopBar();
            return;
        }
        run.metrics.active=true;
        run.metrics.recallEnabled=true;
        updateJevReport(run, { phase: 'preparing', mode: run.options.mode });
        const nativeAvailable = hasEnabledVectorRecall() && guardNativeVectorInterceptor();
        if(run.options.mode==='adaptive'){
            const entries=await getSortedEntries();
            if(!isCurrentJev(run)){abort(true);return;}
            const settings=new Map(EXTENSION_STATE.scanWorldSettings);
            const active=new Set(entries.map(entry=>entry.world));
            const worlds=new Set([...getJevWorlds(settings,run.characterRecall)].filter(world=>active.has(world)));
            const scope=JSON.stringify([run.chatId,getJevCharacterAvatar(),getContext().groupId,EXTENSION_STATE.currentSpeakingCharacter,[...worlds].sort()]);
            if(adaptivePlanScope!==scope){adaptivePlanCache.clear();adaptivePlanScope=scope;}
            const full=estimateAdaptiveJevPlan(entries,worlds,chat??getContext().chat??[],run.options,adaptivePlanCache);
            // Chat/file vectors alone cannot provide World Info candidates.
            const worldVectors=Boolean(nativeAvailable&&extension_settings.vectors?.enabled_world_info&&
                entries.some(entry=>isJevCandidate(entry,worlds)&&(entry.vectorized||extension_settings.vectors?.enabled_for_all)));
            const route=routeAdaptiveJevEstimate(full,{threshold:run.options.adaptiveThreshold,vectorAvailable:worldVectors});
            run.requestedMode='adaptive';
            run.options={...run.options,mode:route.mode};
            if(route.mode==='all')run.adaptiveSnapshot={entries,settings};
            updateJevReport(run,{requestedMode:'adaptive',mode:route.mode,adaptiveEstimate:route.estimatedTokens??undefined,adaptiveReason:route.reason,adaptivePlanCacheHits:full.cacheHits,adaptivePlanCacheMisses:full.cacheMisses});
        }
        if (run.options.mode === 'filtered' && nativeAvailable) {
            run.awaitingVector = true;
            return;
        }
        await prepareJevGeneration(run, chat, contextSize, abort, type);
    } catch (error) {
        await abortJevPreparation(run, abort, error);
    }
}

// Priority constants
const PRIORITY_LEVELS = {
    LOWEST: 1,
    LOW: 2,
    DEFAULT: 3,
    HIGH: 4,
    HIGHEST: 5
};

// Extension state tracking
const EXTENSION_STATE = {
    modalOpen: false,
    currentSpeakingCharacter: null,  // Track current speaking character for group chat overrides
    budgetHandlersRegistered: false,
    // These settings were read once when the current World Info scan began.
    scanWorldSettings: new Map(),
    scanBudgetWorlds: new Set(),
    scanHasExplicitBudgets: false
};

// Feature detection: WORLDINFO_SCAN_DONE exists only on newer ST branches
const HAS_WORLDINFO_SCAN_DONE = Boolean(event_types && event_types.WORLDINFO_SCAN_DONE);

// Debugging flag and helper
const DEBUG_STLO = false;
function stloDebug(...args) {
    if (DEBUG_STLO && typeof console !== 'undefined') {
        console.info('🦥 STLO', '[STLO][DEBUG]', ...args);
    }
}
// Utility functions

// Token counts are cached by the exact entry object and content, not by UID
// and length (which can collide across lorebooks or edited content).
let TOKEN_COUNT_CACHE = new WeakMap();
function getEntryTokenCountCached(entry) {
    if (!entry || typeof entry !== 'object') return 0;
    const content = typeof entry.content === 'string' ? entry.content : '';
    const cached = TOKEN_COUNT_CACHE.get(entry);
    if (cached?.content === content) return cached.tokens;

    const cache = TOKEN_COUNT_CACHE;
    const tokens = getTokenCountAsync(content + '\n').then(value => Number(value) || 0).catch(() => {
        if (cache.get(entry)?.tokens === tokens) cache.delete(entry);
        return 0;
    });
    cache.set(entry, { content, tokens });
    return tokens;
}
﻿// Utility functions

// Random shuffle helper for random trimming
function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// STLO i18n adapter: load extension locale and key-based interpolation
const EXT_BASE_URL = new URL('.', import.meta.url);
async function loadStloLocale() {
    try {
        const current = String(getCurrentLocale() || 'en').toLowerCase();
        const base = current.split('-')[0];
        const aliases = { ko: 'ko-kr', ja: 'ja-jp', zh: 'zh-cn', es: 'es-es', de: 'de-de', fr: 'fr-fr', id: 'id-id', ms: 'ms-my', ru: 'ru-ru' };
        const variant = /^zh-(?:hant|hk|mo|tw)(?:-|$)/.test(current) ? 'zh-tw' : aliases[base];
        const candidates = new Set([current, variant, base, 'en'].filter(Boolean));
        const TIMEOUT_MS = 3000;

        // Small helper for fetch timeouts
        const fetchWithTimeout = async (resource, ms) => {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), ms);
            try {
                return await fetch(resource, { signal: controller.signal });
            } finally {
                clearTimeout(id);
            }
        };

        for (const code of candidates) {
            try {
                const url = new URL(`./locales/${code}.json`, EXT_BASE_URL);
                const res = await fetchWithTimeout(url, TIMEOUT_MS);
                if (res && res.ok) {
                    const data = await res.json();
                    addLocaleData(current, data);
                    break; // first available wins
                }
                stloDebug('Locale unavailable:', code, res?.status);
            } catch (error) {
                stloDebug('Locale request failed:', code, error);
            }
        }
        // Re-apply locale so existing DOM picks up newly injected keys
        try {
            applyLocale();
            // Expose a debug helper in DevTools: run window.stloI18nStatus()
            try {
                // eslint-disable-next-line no-undef
                window.stloI18nStatus = () => {
                    const cur = String(getCurrentLocale() || 'en').toLowerCase();
                    const sample = translate('Configure STLO Priority & Budget', 'stlo.button.configure');
                    console.table({ currentLocale: cur, 'stlo.button.configure': sample });
                    return { currentLocale: cur, sample };
                };
            } catch (e2) {
                stloDebug('Unable to expose stloI18nStatus:', e2);
            }
        } catch (e) {
            console.warn('🦥 STLO', '[STLO i18n] applyLocale() threw:', e);
        }
    } catch (e) {
        console.warn('🦥 STLO', '[STLO] i18n load failed:', e);
    }
}

/**
 * Interpolate a translation string by stable key using ${index} placeholders.
 * Example: tKey('stlo.settings.saved', 'STLO settings saved for ${0}', currentLorebook)
 */
function tKey(key, fallback, ...values) {
    const template = translate(fallback, key);
    return template.replace(/\$\{(\d+)\}/g, (_, i) => String(values[i] ?? ''));
}

function cleanupListeners(listeners, listenerArray) {
    listeners.forEach(({ source, event, handler }) => {
        try {
            if (source && typeof source.off === 'function') {
                source.off(event, handler);
            } else if (source && typeof source.removeListener === 'function') {
                source.removeListener(event, handler);
            }
        } catch (error) {
            console.error('🦥 STLO', 'Error removing event listener:', error);
        }
    });
    listenerArray.length = 0;
}

/**
 * Set up event handlers for world info integration
 */
function setupEventHandlers() {
    // Clean up existing event listeners
    cleanupListeners(eventListeners, eventListeners);

    // Hook into world info entries loading to apply our sorting synchronously
    // so the core sees the merged arrays before building its combined list.
    const handler = async (data) => {
        try {
            await handleWorldInfoEntriesLoaded(data);
        } catch (e) {
            console.warn('🦥 STLO', '[STLO] WORLDINFO_ENTRIES_LOADED handler error:', e);
        }
    };
    eventSource.on(event_types.WORLDINFO_ENTRIES_LOADED, handler);

    const chatChangedHandler = () => {
        EXTENSION_STATE.currentSpeakingCharacter = null;  // Clear character override state on chat change
        stopJevGeneration();
        adaptiveCueCache.clear();
        adaptiveCueScope = null;
        adaptivePlanCache.clear();
        adaptivePlanScope=null;
        metricsCurrent?.ledger.clear();metricsCurrent=null;metricsHistory=[];
        lastJevReport = null;
        syncJevTopBar();
    };

    // Group chat character override handler
    const groupMemberDraftedHandler = (chId) => {
        const previous=EXTENSION_STATE.currentSpeakingCharacter;
        // Clear any stale state first, then set current speaking character
        EXTENSION_STATE.currentSpeakingCharacter = null;

        if (chId !== undefined && chId !== null && characters && characters[chId]) {
            const character = characters[chId];
            const characterName = (character?.avatar?.replace(/\.[^/.]+$/, '') || character?.name || null);
            EXTENSION_STATE.currentSpeakingCharacter = characterName;
        }
        if(previous!==EXTENSION_STATE.currentSpeakingCharacter){
            stopJevGeneration();
            metricsCurrent?.ledger.clear();metricsCurrent=null;metricsHistory=[];
            lastJevReport=null;
            adaptiveCueCache.clear();adaptiveCueScope=null;
            adaptivePlanCache.clear();adaptivePlanScope=null;
        }
        syncJevTopBar();
    };

    eventSource.on(event_types.CHAT_CHANGED, chatChangedHandler);
    eventSource.on(event_types.GROUP_MEMBER_DRAFTED, groupMemberDraftedHandler);
    eventSource.on(event_types.GENERATION_STARTED, startJevGeneration);
    eventSource.on(event_types.GENERATION_STOPPED, onJevStopped);
    eventSource.on(event_types.GENERATION_ENDED, finishJevGeneration);
    eventSource.on(event_types.WORLDINFO_FORCE_ACTIVATE, rememberForcedEntries);
    eventSource.on(event_types.WORLD_INFO_ACTIVATED, recordJevActivated);
    eventSource.on(event_types.GENERATE_AFTER_DATA, guardUnpreparedJevReply);
    globalThis.stlo_jevInterceptor = stloJevInterceptor;
    try{installMemoryMetricsBridge();}catch(error){stloDebug('Optional metrics bridge:',error);}

    // Track for cleanup
    eventListeners.push(
        { source: eventSource, event: event_types.WORLDINFO_ENTRIES_LOADED, handler: handler },
        { source: eventSource, event: event_types.CHAT_CHANGED, handler: chatChangedHandler },
        { source: eventSource, event: event_types.GROUP_MEMBER_DRAFTED, handler: groupMemberDraftedHandler },
        { source: eventSource, event: event_types.GENERATION_STARTED, handler: startJevGeneration },
        { source: eventSource, event: event_types.GENERATION_STOPPED, handler: onJevStopped },
        { source: eventSource, event: event_types.GENERATION_ENDED, handler: finishJevGeneration },
        { source: eventSource, event: event_types.WORLDINFO_FORCE_ACTIVATE, handler: rememberForcedEntries },
        { source: eventSource, event: event_types.WORLD_INFO_ACTIVATED, handler: recordJevActivated },
        { source: eventSource, event: event_types.GENERATE_AFTER_DATA, handler: guardUnpreparedJevReply }
    );
}



/** Format only the STLO dialog; other SillyTavern panels are unaffected. */
function installStloModalStyles() {
    if (document.getElementById('stlo-modal-styles')) return;
    const style = document.createElement('style');
    style.id = 'stlo-modal-styles';
    style.textContent = `
        .stlo-jev-report {
            width:100%; min-width:0; display:flex; flex-direction:column; gap:11px; text-align:start; box-sizing:border-box;
            --stlo-report-rule:color-mix(in srgb,var(--SmartThemeBodyColor) 21%,transparent);
            --stlo-report-tint:color-mix(in srgb,var(--SmartThemeBodyColor) 5%,transparent);
        }
        .stlo-jev-report *, .stlo-jev-report *::before { box-sizing:border-box; }
        .stlo-jev-report h3 { margin:0; font-size:1.15em; line-height:1.35; text-align:start; }
        .stlo-jev-report h4 { margin:0; font-size:.98em; line-height:1.4; text-align:start; }
        .stlo-report-overview { display:grid; gap:7px; min-width:0; }
        .stlo-report-status { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:5px; font-size:.86em; opacity:.85; }
        .stlo-report-time { font-variant-numeric:tabular-nums; white-space:nowrap; }
        .stlo-report-hero { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 7px; min-width:0; }
        .stlo-report-hero > strong { font-size:1.85em; font-weight:700; line-height:1.1; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
        .stlo-report-hero > span { font-size:.9em; font-weight:600; }
        .stlo-report-hero > small { flex:0 1 auto; }
        .stlo-report-funnel,.stlo-report-rp-grid,.stlo-report-search-grid { display:grid; gap:6px; min-width:0; }
        .stlo-report-funnel { grid-template-columns:repeat(4,minmax(0,1fr)); padding:8px 5px; border-radius:8px; background:var(--stlo-report-tint); }
        .stlo-report-rp-grid { grid-template-columns:repeat(3,minmax(0,1fr)); }
        .stlo-report-search-grid { grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px 12px; }
        .stlo-report-stat { display:grid; align-content:start; gap:3px; min-width:0; text-align:start; }
        .stlo-report-stat small { font-size:.79em; line-height:1.35; opacity:.78; overflow-wrap:anywhere; }
        .stlo-report-stat strong { font-size:1.22em; font-variant-numeric:tabular-nums; line-height:1.3; overflow-wrap:anywhere; }
        .stlo-report-funnel .stlo-report-stat,.stlo-report-rp-grid .stlo-report-stat { text-align:center; }
        .stlo-report-funnel .stlo-report-stat { border-inline-end:1px solid var(--stlo-report-rule); }
        .stlo-report-funnel .stlo-report-stat:last-child { border:0; }
        .stlo-report-primary { display:grid; gap:7px; min-width:0; padding-block-start:11px; border-top:1px solid var(--stlo-report-rule); }
        .stlo-report-heading { display:flex; align-items:center; gap:7px; min-width:0; }
        .stlo-report-heading i { flex:none; width:16px; text-align:center; opacity:.78; }
        .stlo-report-budget-number > strong { font-size:1.5em; }
        .stlo-report-budget-bar { display:block; width:100%; height:7px; border:0; border-radius:5px; overflow:hidden; accent-color:var(--SmartThemeQuoteColor,var(--SmartThemeEmColor)); }
        .stlo-report-book-preview { display:flex; align-items:baseline; flex-wrap:wrap; gap:6px; font-size:.88em; min-width:0; }
        .stlo-report-book-preview i { flex:none; opacity:.65; }
        .stlo-report-book-name { flex:1 1 40%; min-width:0; overflow-wrap:anywhere; }
        .stlo-report-note { display:block; opacity:.77; font-size:.79em; line-height:1.45; overflow-wrap:anywhere; }
        .stlo-report-section { border:1px solid var(--stlo-report-rule); border-radius:8px; margin:0; min-width:0; width:100%; }
        .stlo-report-section > summary { display:flex; align-items:center; gap:8px; min-width:0; list-style:none; cursor:pointer; font-weight:600; padding:9px 10px; line-height:1.4; overflow-wrap:anywhere; }
        .stlo-report-section > summary::-webkit-details-marker { display:none; }
        .stlo-report-section > summary::before { content:""; flex:none; border-inline-start:6px solid currentColor; border-block:4px solid transparent; opacity:.75; }
        .stlo-report-section[open] > summary::before { transform:rotate(90deg); }
        .stlo-report-section > summary:focus-visible { outline:2px solid currentColor; outline-offset:2px; }
        .stlo-report-section-body { display:grid; gap:3px; padding:3px 10px 10px; min-width:0; }
        .stlo-report-section[open] > .stlo-report-section-body { border-top:1px solid var(--stlo-report-rule); }
        .stlo-report-row { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,42%); align-items:baseline; gap:8px; padding-block:4px; font-size:.88em; line-height:1.4; min-width:0; }
        .stlo-report-row > span:first-child { min-width:0; overflow-wrap:anywhere; }
        .stlo-report-value { min-width:0; text-align:end; overflow-wrap:anywhere; font-variant-numeric:tabular-nums; font-weight:600; }
        .stlo-report-book-card { display:grid; gap:2px; min-width:0; padding:8px 0; border-bottom:1px solid var(--stlo-report-rule); }
        .stlo-report-book-card:last-child { border-bottom:0; }
        .stlo-report-book-card > strong { overflow-wrap:anywhere; line-height:1.4; margin-bottom:3px; }
        .stlo-report-book-card > .stlo-report-section { border:0; background:var(--stlo-report-tint); }
        .stlo-report-book-card > .stlo-report-section > summary { font-size:.83em; font-weight:500; padding:5px 7px; }
        .stlo-report-error { overflow-wrap:anywhere; }
        @media (max-width:360px) {
            .stlo-report-funnel { grid-template-columns:repeat(2,minmax(0,1fr)); }
            .stlo-report-funnel .stlo-report-stat:nth-child(2n) { border:0; }
            .stlo-report-row { gap:6px; }
        }
        .stlo-modal-ui { display: flex; flex-direction: column; align-items: stretch; gap: 7px; width: 100%; min-width: 0; box-sizing: border-box; text-align: left; }
        .stlo-modal-ui .stlo-section { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; width: 100%; min-width: 0; margin: 0; padding: 0 0 10px; border-bottom: 1px solid var(--SmartThemeBorderColor); text-align: left; box-sizing: border-box; }
        .stlo-modal-ui .stlo-section:last-child { padding-bottom: 0; border-bottom: none; }
        .stlo-modal-ui .stlo-section[hidden] { display: none; }
        .stlo-modal-ui h3, .stlo-modal-ui h4, .stlo-modal-ui h5 { margin: 0; line-height: 1.35; text-align: left; }
        .stlo-modal-ui h3 { margin-bottom: 3px; }
        .stlo-modal-ui small { display: block; margin: 0; line-height: 1.4; text-align: left; opacity: .85; }
        .stlo-modal-ui .stlo-section > select, .stlo-modal-ui .stlo-budget-options > select { width: min(100%, 320px) !important; max-width: 100%; min-width: 0; box-sizing: border-box; margin: 2px 0 0 !important; }
        .stlo-modal-ui .stlo-section > input[type="number"] { width: min(100%, 220px) !important; max-width: 100%; min-width: 0; box-sizing: border-box; margin: 2px 0 0 !important; }
        .stlo-modal-ui .stlo-field-heading, .stlo-modal-ui .stlo-option-line { display: flex; align-items: center; justify-content: flex-start; gap: 7px; width: 100%; min-width: 0; }
        .stlo-modal-ui .stlo-option-line { gap: 6px; }
        .stlo-modal-ui .stlo-toggle-block { display: flex; flex-direction: column; align-items: flex-start; gap: 0; width: 100%; margin: 2px 0 0; }
        .stlo-modal-ui .stlo-checkrow { display: inline-flex; align-items: center; justify-content: flex-start; gap: 7px; width: auto; max-width: 100%; min-width: 0; margin: 0; line-height: 1.35; text-align: left; }
        .stlo-modal-ui .stlo-checkrow input[type="checkbox"] { width: 16px !important; height: 16px !important; min-width: 16px !important; max-width: 16px !important; min-height: 16px !important; max-height: 16px !important; flex: 0 0 16px; aspect-ratio: 1; border-radius: 3px !important; box-sizing: border-box; margin: 0 !important; padding: 0 !important; }
        .stlo-modal-ui .checkbox_label > .checkmark { display: none; }
        .stlo-modal-ui .stlo-info { position: relative; display: inline-flex; align-items: center; flex: 0 0 auto; margin: 0; padding: 0; }
        .stlo-modal-ui .stlo-info > summary { display: inline-flex; align-items: center; justify-content: flex-start; width: 22px; height: 22px; box-sizing: border-box; border: 0; border-radius: 50%; font-size: 0; line-height: 1; opacity: .8; list-style: none; cursor: pointer; user-select: none; }
        .stlo-modal-ui .stlo-info > summary::before { content: "i"; display: inline-flex; align-items: center; justify-content: center; width: 12px; height: 12px; border: 1px solid currentColor; border-radius: 50%; box-sizing: border-box; font-size: 9px; font-style: normal; font-weight: 700; line-height: 1; }
        .stlo-modal-ui .stlo-info > summary::-webkit-details-marker { display: none; }
        .stlo-modal-ui .stlo-info > summary::marker { content: ""; }
        .stlo-modal-ui .stlo-info > summary:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
        .stlo-modal-ui .stlo-info[open] > summary { opacity: 1; }
        .stlo-modal-ui .stlo-info-body { display: none; }
        .stlo-info-popup { position: fixed; z-index: 2147483000; width: min(270px, calc(100vw - 24px)); max-width: calc(100vw - 24px); max-height: calc(100dvh - 24px); overflow-y: auto; box-sizing: border-box; padding: 9px 11px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 7px; background: var(--SmartThemeBlurTintColor, #f8f3e9); color: var(--SmartThemeBodyColor, #333); box-shadow: 0 3px 12px rgba(0,0,0,.18); text-align: left; }
        .stlo-info-popup[hidden] { display: none !important; }
        .stlo-info-popup small { display: block; margin: 0; font-size: 14px; line-height: 1.5; color: inherit; }
        .stlo-info-popup small + small { margin-top: 6px; }
        .stlo-modal-ui .stlo-jev-advanced { width: 100%; box-sizing: border-box; margin: 2px 0; }
        .stlo-modal-ui .stlo-jev-advanced > summary { cursor: pointer; font-weight: 600; padding: 4px 0; }
        .stlo-modal-ui .stlo-jev-advanced-body { display: flex; flex-direction: column; gap: 7px; padding: 7px 0 0 6px; width:100%; box-sizing:border-box; min-width:0; }
        .stlo-modal-ui .stlo-scope-name { font-weight: 600; overflow-wrap: anywhere; }
        .stlo-modal-ui .stlo-character-line { display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; min-width:0; max-width:100%; }
        .stlo-modal-ui .stlo-character-line > span { font-size:.9em; font-weight:400; }
        .stlo-modal-ui .stlo-character-line > strong { font-size:1.05em; font-weight:700; overflow-wrap:anywhere; min-width:0; }
        .stlo-modal-ui .stlo-reading-summary > small { display:inline; margin-inline-start:7px; font-weight:400; }
        .stlo-modal-ui .stlo-legacy-book { width: 100%; margin: 2px 0 0; }
        .stlo-modal-ui .stlo-legacy-book[hidden] { display: none !important; }
        .stlo-jev-settings { gap:6px; }
        .stlo-jev-settings > .stlo-section { gap:4px; padding-bottom:7px; }
        .stlo-jev-settings > .stlo-section:last-child { padding-bottom:0; }
        .stlo-jev-settings .stlo-jev-advanced { margin:0; }
        .stlo-jev-settings .stlo-jev-advanced > summary { padding:3px 0; }
        .stlo-jev-settings .stlo-jev-advanced-body { gap:5px; padding-top:5px; }
        .stlo-jev-settings .stlo-jev-fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr)); gap:6px 12px; align-items:stretch; width:100%; min-width:0; }
        .stlo-jev-settings .stlo-jev-limit-fields { padding-top:4px; }
        .stlo-jev-settings .stlo-jev-field { display:flex; flex-direction:column; justify-content:space-between; align-items:stretch; gap:2px; min-width:0; }
        .stlo-jev-settings .stlo-jev-field .stlo-field-heading { gap:4px; }
        .stlo-jev-settings .stlo-jev-field .stlo-field-heading > label { min-width:0; overflow-wrap:anywhere; text-align:left; }
        .stlo-jev-settings .stlo-jev-field > :is(select,input[type="number"]) { width:100% !important; min-width:0; max-width:100%; min-height:1.8em; box-sizing:border-box; margin:0 !important; }
        .stlo-modal-ui .stlo-jev-prompt-library { display:grid; gap:5px; width:100%; min-width:0; text-align:start; margin-block:7px; }
        .stlo-modal-ui .stlo-jev-prompt-library :is(.stlo-jev-prompt-heading,.stlo-jev-prompt-selection,.stlo-jev-prompt-tools) { display:flex; align-items:center; gap:4px; min-width:0; }
        .stlo-modal-ui .stlo-jev-prompt-heading { justify-content:space-between; flex-wrap:wrap; }
        .stlo-modal-ui .stlo-jev-prompt-heading .stlo-field-heading { flex:1 1 auto; width:auto; min-width:0; }
        .stlo-modal-ui .stlo-jev-prompt-tools { flex:0 0 auto; }
        .stlo-modal-ui .stlo-jev-prompt-selection select { flex:1 1 0; min-width:0; width:auto !important; margin:0 !important; }
        .stlo-modal-ui .stlo-jev-prompt-library .stlo-jev-prompt-icon.menu_button { display:inline-flex; flex:0 0 max(24px,1.75em); align-items:center; justify-content:center; width:max(24px,1.75em) !important; min-width:24px !important; max-width:none !important; min-height:24px; height:max(24px,1.75em); padding:2px; font-size:.9em; margin:0 !important; box-sizing:border-box; white-space:nowrap; }
        .stlo-modal-ui .stlo-jev-prompt-icon i { pointer-events:none; }
        .stlo-modal-ui .stlo-jev-prompt-library textarea.text_pole, .stlo-jev-expanded textarea.text_pole { margin:0; width:100%; box-sizing:border-box; line-height:1.4; resize:vertical; }
        .stlo-modal-ui .stlo-jev-prompt-library textarea[readonly] { opacity:.86; }
        .stlo-jev-expanded h3 { margin:0 0 7px; }
        .stlo-jev-expanded textarea.text_pole { min-height:7em; max-height:min(52dvh,30rem); }
        .stlo-modal-ui .stlo-jev-prompt-library :is(.stlo-jev-prompt-status:empty,input[type="file"]) { display:none !important; }
        .stlo-modal-ui .stlo-jev-radio { display: flex; align-items: flex-start; gap: 6px; font-weight: normal; }
        .stlo-modal-ui .stlo-jev-radio input { flex: 0 0 auto; }
        .stlo-modal-ui .stlo-jev-actions { display:flex; flex-wrap:wrap; align-items:center; gap:6px; width:100%; min-width:0; }
        .stlo-modal-ui .stlo-jev-actions > .menu_button { display:inline-flex; align-items:center; justify-content:center; flex:0 0 auto; width:auto !important; min-width:max-content !important; max-width:100%; margin:0 !important; padding:4px 8px; white-space:nowrap !important; word-break:keep-all; overflow-wrap:normal; }
        #stlo-jev-topbar[data-status="running"], #stlo-jev-topbar[data-status="preparing"] { opacity: .65; }
        #stlo-jev-topbar[data-status="retry"], #stlo-jev-topbar[data-status="cancelled"] { color: var(--SmartThemeQuoteColor, inherit); }
        .stlo-modal-ui .stlo-order-controls { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; margin: 3px 0 0; padding: 7px 0 0 12px; width: 100%; box-sizing: border-box; }
        .stlo-modal-ui .stlo-order-controls[hidden] { display: none !important; }
        .stlo-modal-ui .stlo-inline-number { display: flex; align-items: center; justify-content: flex-start; flex-wrap: wrap; gap: 7px; }
        .stlo-modal-ui .stlo-inline-number input[type="number"] { width: 110px !important; max-width: 100%; }
        .stlo-modal-ui .stlo-budget-options { display: flex; flex-direction: column; align-items: flex-start; gap: 5px; width: 100%; }
        .stlo-modal-ui .stlo-budget-value { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; width: 100%; }
        .stlo-modal-ui .stlo-budget-value input[type="number"] { width: 130px !important; max-width: 100%; margin: 0 !important; }
        .stlo-modal-ui .stlo-advanced-drawer { width:100%; margin:3px 0 0; box-sizing:border-box; }
        .stlo-modal-ui .stlo-advanced-drawer > summary { cursor:pointer; font-weight:600; padding:4px 0; }
        .stlo-modal-ui .stlo-advanced-drawer > .stlo-group-body { padding-top:6px; width:100%; box-sizing:border-box; }
        .stlo-modal-ui .stlo-group-cards { display:flex; flex-direction:column; gap:8px; margin-top:8px; width:100%; min-width:0; }
        .stlo-modal-ui .stlo-group-cards:empty { margin-top:0; }
        .stlo-modal-ui .stlo-group-card { display:flex; flex-direction:column; gap:6px; border:1px solid var(--SmartThemeBorderColor); border-radius:7px; padding:9px; width:100%; min-width:0; box-sizing:border-box; }
        .stlo-modal-ui .stlo-group-card-head { display:flex; align-items:center; justify-content:space-between; gap:6px; }
        .stlo-modal-ui .stlo-group-card select { min-width:0; max-width:100%; margin:0 !important; box-sizing:border-box; }
        .stlo-modal-ui .stlo-group-card > select { width:100% !important; }
        .stlo-modal-ui .stlo-group-card .stlo-group-priority { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,156px); gap:6px; align-items:center; }
        .stlo-modal-ui .stlo-group-card .stlo-group-priority select { width:100% !important; }
        .stlo-modal-ui .stlo-group-card .stlo-group-adjust-row { display:flex; align-items:center; gap:5px; flex-wrap:wrap; }
        .stlo-modal-ui .stlo-group-card .stlo-group-adjust-row .stlo-option-line { width:auto; flex:1 1 auto; }
        .stlo-modal-ui .stlo-group-card input.stlo-group-adjustment { width:86px !important; max-width:100%; min-width:0; margin:0 !important; box-sizing:border-box; }
        .stlo-modal-ui .stlo-group-card input.stlo-group-adjustment[hidden] { display:none !important; }
        .stlo-modal-ui .stlo-group-card .stlo-group-remove.menu_button { display:inline-flex; flex:0 0 25px; width:25px !important; min-width:25px; height:25px; align-items:center; justify-content:center; margin:0 !important; }
        .stlo-modal-ui .stlo-group-add.menu_button { display:inline-flex; align-items:center; justify-content:center; gap:6px; width:auto !important; min-width:max-content; max-width:100%; margin:8px 0 0 !important; padding:4px 10px; white-space:nowrap; word-break:keep-all; }
        .stlo-modal-ui .stlo-advanced-drawer .stlo-group-body > .stlo-toggle-block { margin-top:5px; }
        .stlo-book-manager { gap:10px; }
        .stlo-book-manager .stlo-manager-top { gap:6px; padding-bottom:9px; }
        .stlo-book-manager .stlo-manager-heading { display:flex; flex-wrap:wrap; align-items:center; gap:7px; padding-bottom:3px; }
        .stlo-book-manager .stlo-manager-heading h3 { margin:0; }
        .stlo-book-manager .stlo-manager-heading i { font-size:1.05em; }
        .stlo-book-manager .stlo-manager-report.menu_button {
            margin:0; margin-inline-start:auto; flex:0 0 auto; width:auto !important; white-space:nowrap; font-size:.85em;
        }
        .stlo-book-manager .stlo-book-cards { display:flex; flex-direction:column; gap:9px; width:100%; min-width:0; }
        .stlo-book-manager .stlo-book-cards:empty { display:none; }
        .stlo-book-manager .stlo-book-card { position:relative; width:100%; min-width:0; box-sizing:border-box; border:1px solid var(--SmartThemeBorderColor, #8885); border-radius:8px; }
        .stlo-book-manager .stlo-book-disclosure { width:100%; margin:0; box-sizing:border-box; }
        .stlo-book-manager .stlo-book-disclosure > summary { display:flex; align-items:center; gap:8px; cursor:pointer; min-width:0; padding:10px 42px 10px 12px; list-style:none; }
        .stlo-book-manager .stlo-book-disclosure > summary::-webkit-details-marker { display:none; }
        .stlo-book-manager .stlo-book-disclosure > summary::before { content:""; flex:0 0 7px; width:7px; height:7px; border-right:1.5px solid currentColor; border-bottom:1.5px solid currentColor; transform:rotate(-45deg); opacity:.75; }
        .stlo-book-manager .stlo-book-disclosure[open] > summary::before { transform:rotate(45deg); }
        .stlo-book-manager .stlo-book-heading { display:flex; flex-direction:column; gap:2px; min-width:0; overflow-wrap:anywhere; }
        .stlo-book-manager .stlo-book-title { font-size:1em; line-height:1.35; }
        .stlo-book-manager .stlo-book-summary { font-size:.82em; font-weight:400; opacity:.72; }
        .stlo-book-manager .stlo-book-remove.menu_button { position:absolute; top:10px; right:10px; display:inline-flex; align-items:center; justify-content:center; width:25px !important; min-width:25px; height:25px; padding:0; margin:0 !important; }
        .stlo-book-manager .stlo-book-body { padding:11px; border-top:1px solid var(--SmartThemeBorderColor, #8885); box-sizing:border-box; min-width:0; }
        .stlo-book-manager .stlo-book-picker { width:100% !important; min-width:0; margin:0 !important; box-sizing:border-box; }
        .stlo-book-manager .stlo-book-editor { display:flex; flex-direction:column; gap:8px; min-width:0; }
        .stlo-book-manager .stlo-book-editor .stlo-section { gap:5px; padding-bottom:8px; }
        .stlo-book-manager .stlo-book-editor .stlo-section:last-child { padding-bottom:0; }
        .stlo-book-manager .stlo-book-editor .stlo-section > select, .stlo-book-manager .stlo-budget-options > select { width:100% !important; }
        .stlo-book-manager .stlo-book-advanced { width:100%; }
        .stlo-book-manager .stlo-book-advanced > summary { font-weight:600; cursor:pointer; padding:3px 0; }
        .stlo-book-manager .stlo-book-advanced-body { display:flex; flex-direction:column; gap:4px; padding:7px 0 0; min-width:0; }
        .stlo-book-manager .stlo-book-advanced-body > .stlo-toggle-block { margin:0; }
        .stlo-book-manager .stlo-book-vector { display:flex; flex-direction:column; gap:4px; width:100%; min-width:0; margin-top:4px; }
        .stlo-book-manager .stlo-book-vector input { width:min(100%, 156px) !important; margin:0 !important; }
        .stlo-book-manager .stlo-manager-add.menu_button { display:inline-flex; align-items:center; justify-content:center; gap:6px; width:100% !important; min-width:0; padding:7px; margin:0 !important; white-space:nowrap; word-break:keep-all; }
        .stlo-book-manager .stlo-manager-status:empty, .stlo-book-manager .stlo-manager-empty[hidden] { display:none !important; }
        @media (max-width: 480px) {
            .stlo-modal-ui { gap: 6px; }
            .stlo-book-manager .stlo-book-body { padding:9px; }
            .stlo-modal-ui .stlo-section { gap: 5px; padding-bottom: 8px; }
            .stlo-modal-ui .stlo-jev-prompt-heading .stlo-field-heading { flex:1 1 130px; }
            .stlo-modal-ui .stlo-group-card .stlo-group-priority { grid-template-columns:minmax(0,1fr) minmax(0,132px); }
        }
    `;
    document.head.appendChild(style);
}

/**
 * Use the same character lorebook links as the Lorebook Manager:
 * the character's primary world and its additional character lorebooks.
 * Global and chat lorebooks are not included in the default filter.
 * No active character means all lorebooks are available.
 */
function getCurrentCharacterLinkedLorebooks() {
    if (this_chid === undefined || this_chid === null) return null;
    const character = characters?.[this_chid];
    if (!character) return null;

    const books = new Set();
    const primary = character.data?.extensions?.world;
    if (typeof primary === 'string' && primary.trim()) books.add(primary);

    let fileName = '';
    try {
        fileName = getCharaFilename(this_chid);
    } catch (error) {
        console.warn('🦥 STLO', '[STLO] Could not resolve character filename for linked lorebooks:', error);
    }

    const charLore = Array.isArray(world_info?.charLore)
        ? world_info.charLore.find(item => item?.name === fileName)
        : null;
    for (const name of Array.isArray(charLore?.extraBooks) ? charLore.extraBooks : []) {
        if (typeof name === 'string' && name.trim()) books.add(name);
    }
    return books;
}

/**
 * Open the multi-book STLO manager directly. Its add list defaults to
 * the current character's attached lorebooks.
 */
async function openLorebookBudgetFromMenu() {
    return openLorebookSettings();
}

/** Add a Font Awesome book entry only to SillyTavern's extensions menu. */
function addLorebookBudgetMenuItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return;
    const add = (id, iconName, title, action) => {
        if (document.getElementById(id)) return;
        const container = document.createElement('div');
        container.className = 'extension_container';
        const item = document.createElement('div');
        item.id = id;
        item.className = 'list-group-item flex-container flexGap5';
        const icon = document.createElement('div');
        icon.className = 'fa-solid ' + iconName + ' extensionsMenuExtensionButton';
        const label = document.createElement('span');
        label.textContent = title;
        item.append(icon, label);
        item.addEventListener('click', action);
        container.appendChild(item);
        menu.appendChild(container);
    };
    add('stlo_budget_menu_item', 'fa-scale-balanced', translate('Lorebook Budget Management', 'stlo.menu.budget'), openLorebookBudgetFromMenu);
    add('stlo_jev_settings_menu_item', 'fa-scale-balanced', translate('Lorebook Jev Recall', 'stlo.jev.settingsTitle'), openJevSettings);
}

/**
 * Per-lorebook vector score thresholds require separate native queries when
 * different thresholds are active. The upstream query-multi API does not return
 * similarity scores, so results are merged deterministically and capped at the
 * *single global* Max Entries value (round-robin by lorebook, in result order).
 * No override = no extra vector network request. Other vector queries are untouched.
 */
let vectorCollectionNames = [];
let vectorWorldByCollection = new Map();

function getVectorWorldByCollection() {
    const names = Array.isArray(world_names) ? world_names : [];
    // Compare values, not just array identity/length: a host or another
    // extension may rename or replace a name in place.
    if (names.length === vectorCollectionNames.length
        && names.every((name, index) => name === vectorCollectionNames[index])) return vectorWorldByCollection;
    vectorCollectionNames = [...names];
    vectorWorldByCollection = new Map(
        names.filter(name => typeof name === 'string')
            .map(name => ['world_' + getStringHash(name), name])
    );
    return vectorWorldByCollection;
}

function getCachedVectorThreshold(world, fallback) {
    try {
        // Read only the relevant scalar fields. getLorebookSettings clones all
        // per-character settings; the vector wrapper never mutates them.
        const settings = world && worldInfoCache.has(world) ? getCachedLorebook(world)?.[EXTENSION_NAME] : null;
        const value = settings?.vectorThreshold;
        if (settings?.vectorThresholdEnabled === true
            && typeof value === 'number' && Number.isFinite(value)
            && value >= 0 && value <= 1) return value;
    } catch (error) {
        console.error('🦥 STLO', 'Error reading cached STLO vector threshold:', error);
    }
    return fallback;
}

function installPerLorebookVectorThresholds() {
    if (window.fetch.__stloPerLorebookThresholds) return;
    const nativeFetch = window.fetch.bind(window);
    const wrappedFetch = async (input, init) => {
        if (typeof input !== 'string'
            || (input !== '/api/vector/query-multi' && !input.startsWith('/api/vector/query-multi?'))
            || !init || typeof init.body !== 'string') {
            return nativeFetch(input, init);
        }

        let request;
        try {
            request = JSON.parse(init.body);
        } catch {
            return nativeFetch(input, init);
        }
        if (!Array.isArray(request.collectionIds) || request.collectionIds.length === 0
            || !request.collectionIds.every(id => typeof id === 'string' && id.startsWith('world_'))) {
            return nativeFetch(input, init);
        }

        const worldByCollection = getVectorWorldByCollection();
        const originalThreshold = Number.isFinite(Number(request.threshold))
            ? Number(request.threshold) : 0;
        const groups = new Map();
        for (const id of request.collectionIds) {
            const world = worldByCollection.get(id);
            const threshold = getCachedVectorThreshold(world, originalThreshold);
            if (!groups.has(threshold)) groups.set(threshold, []);
            groups.get(threshold).push(id);
        }

        // If all active lorebooks share one threshold, preserve exactly one
        // native request even if they explicitly set the same value.
        if (groups.size === 1) {
            const threshold = groups.keys().next().value;
            return threshold === originalThreshold
                ? nativeFetch(input, init)
                : nativeFetch(input, { ...init, body: JSON.stringify({ ...request, threshold }) });
        }

        const results = await Promise.all(
            Array.from(groups, async ([threshold, collectionIds]) => {
                return nativeFetch(input, {
                    ...init,
                    body: JSON.stringify({ ...request, collectionIds, threshold }),
                });
            })
        );
        const failed = results.find(response => !response.ok);
        if (failed) return failed;

        const allById = new Map();
        for (const response of results) {
            const json = await response.json();
            for (const [id, data] of Object.entries(json || {})) {
                allById.set(id, data);
            }
        }

        // A merged response must never exceed Vector Storage's global topK.
        // Backend responses omit similarity scores, so we cannot reproduce
        // cross-book score ranking; distribute available hits by rank instead.
        const max = Math.max(1, Math.trunc(Number(request.topK) || 10));
        const collections = request.collectionIds.map(id => {
            const result = allById.get(id) || {};
            return { id, hashes: Array.isArray(result.hashes) ? result.hashes : [],
                metadata: Array.isArray(result.metadata) ? result.metadata : [], next: 0 };
        });
        const merged = {};
        const hashesUsed = new Set();
        let selectedCount = 0;
        let progressed = true;
        while (selectedCount < max && progressed) {
            progressed = false;
            for (const c of collections) {
                if (selectedCount >= max) break;
                while (c.next < c.hashes.length) {
                    const index = c.next++;
                    const hash = c.hashes[index];
                    if (hashesUsed.has(hash)) continue;
                    progressed = true;
                    hashesUsed.add(hash);
                    if (!merged[c.id]) merged[c.id] = { hashes: [], metadata: [] };
                    merged[c.id].hashes.push(hash);
                    merged[c.id].metadata.push(c.metadata[index] ?? {});
                    selectedCount++;
                    break;
                }
            }
        }

        return new Response(JSON.stringify(merged), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    };
    wrappedFetch.__stloPerLorebookThresholds = true;
    window.fetch = wrappedFetch;
}

/**
 * Handle the WORLDINFO_ENTRIES_LOADED event to apply our sorting
 * @param {Object} eventData - Contains globalLore, characterLore, chatLore, personaLore arrays
 */
function loreArrays(data) {
    return ['globalLore', 'characterLore', 'chatLore', 'personaLore'].map(key =>
        Array.isArray(data[key]) ? data[key] : (data[key] = []));
}

function nativeLoreOrder(data) {
    const [global, character, chat, persona] = loreArrays(data);
    const byOrder = (a, b) => (b?.order ?? 100) - (a?.order ?? 100);
    const sorted = list => list.slice().sort(byOrder);
    const strategy = typeof world_info_character_strategy === 'undefined' ? 0 : Number(world_info_character_strategy);
    const modes = typeof world_info_insertion_strategy === 'undefined' ? { character_first:1, global_first:2 } : world_info_insertion_strategy;
    const rest = strategy === modes.character_first ? [...sorted(character), ...sorted(global)]
        : strategy === modes.global_first ? [...sorted(global), ...sorted(character)]
        : sorted([...global, ...character]);
    return [...sorted(chat), ...sorted(persona), ...rest];
}

function omitJevVectorCollections(data, run) {
    if (!run?.selection || run.options.mode !== 'all') return;
    const arrays = loreArrays(data);
    const managed = run.selection.worlds;
    const keepNative = new Set();
    const allVectorized = extension_settings.vectors?.enabled_for_all === true;
    // Special nonconstant entries can still need native vector activation.
    // Keep their entire book's collection, rather than deleting a subset
    // from the persistent vector index.
    for (const list of arrays) for (const entry of list) {
        if (managed.has(entry.world) && !entry.disable && !entry.constant && entry.content
            && (entry.vectorized || allVectorized) && !isJevCandidate(entry, managed)) keepNative.add(entry.world);
    }
    for (const list of arrays) {
        let write = 0;
        for (const entry of list) {
            if (!managed.has(entry.world) || keepNative.has(entry.world)) list[write++] = entry;
        }
        list.length = write;
    }
}

async function handleWorldInfoEntriesLoaded(eventData) {
    try {
        if (!eventData || typeof eventData !== 'object') return;
        await applyPriorityOrdering(eventData);
        const run = jevGeneration;
        if (nativeVectorPasses > 0) {
            if (run?.enabled && isCurrentJev(run)) omitJevVectorCollections(eventData, run);
            return;
        }
        if (run?.preview && isCurrentJev(run) && !run.preview.entries) {
            run.preview.entries = structuredClone(nativeLoreOrder(eventData));
            run.preview.settings = new Map(EXTENSION_STATE.scanWorldSettings);
        }
        if (HAS_WORLDINFO_SCAN_DONE && run?.selection?.worlds.size && !run.preparing && !run.preview && isCurrentJev(run)) {
            const receipt = globalThis.STWII?.recordStloJevRecall;
            const appliedKeys = typeof receipt === 'function'||run.selection.excerpts?.size ? new Set() : null;
            const arrays = loreArrays(eventData);
            const [global, character, chat, persona] = arrays;
            const strategy = typeof world_info_character_strategy === 'undefined' ? 0 : Number(world_info_character_strategy);
            const modes = typeof world_info_insertion_strategy === 'undefined' ? { character_first:1, global_first:2 } : world_info_insertion_strategy;
            const byOrder = (a,b) => (b.order ?? 100) - (a.order ?? 100);
            if (strategy === modes.character_first || strategy === modes.global_first) {
                for (const list of arrays) {
                    list.sort(byOrder);
                    applyJevSelection(list, appliedKeys);
                }
            } else {
                // In evenly mode the core sorts both arrays together.
                const globalKeys = new Set(global.map(jevEntryKey));
                const combined = [...global, ...character].sort(byOrder);
                applyJevSelection(combined, appliedKeys);
                global.length = 0;
                character.length = 0;
                for (const entry of combined) (globalKeys.has(jevEntryKey(entry)) ? global : character).push(entry);
                for (const list of [chat, persona]) {
                    list.sort(byOrder);
                    applyJevSelection(list, appliedKeys);
                }
            }
            for (const list of arrays) for (const entry of list) {
                if (!run.selection.worlds.has(entry.world) || entry.disable || entry.ignoreBudget
                    || entry.outletName || Number(entry.position) === 7) continue;
                if (run.selection.accepted.has(jevEntryKey(entry))) {
                    entry.__stloReservedJev = true;
                    entry.ignoreBudget = true;
                }
            }
            // Optional display receipt, bound to this scan payload. Never alter
            // injection or fail a reply because a viewer is unavailable.
            if(run.selection.excerpts?.size)run.selection.excerptAppliedKeys=appliedKeys;
            if (typeof receipt==='function'&&appliedKeys) {
                try { receipt(eventData, appliedKeys); } catch { /* display only */ }
            }
        }
        // Older hosts lack a structured budget hook. Do not pre-disable
        // unactivated lore simply because the default global budget is finite.
    } catch (error) {
        console.warn('🦥 STLO', '[STLO] handleWorldInfoEntriesLoaded error:', error);
    }
}

function applyJevSelection(entries, appliedKeys = null) {
    const run = jevGeneration;
    if (!run?.selection || run.preparing || run.preview || !isCurrentJev(run)) return;
    applyJevRecall(entries, run.selection.worlds, run.selection.accepted, appliedKeys);
}

function getJevConnection() {
    const profileId = extension_settings[EXTENSION_NAME]?.jevProfileId;
    const profile = extension_settings.connectionManager?.profiles?.find(candidate => candidate?.id === profileId);
    return getNanoJevConnection(profile);
}
function jevFailureReason(error) {
    if (error?.name === 'TimeoutError') return translate('Request timed out.', 'stlo.jev.timeout');
    if (error?.name === 'JevInputLimitError') return translate('The recent dialogue, background or one lore entry is too large for Jev. Reduce the recent message count or explicitly enable a reading limit.', 'stlo.jev.inputTooLarge');
    const message = String(error?.message ?? '');
    // Only show known safe, locally constructed messages and status codes.
    if (/^Jev is unavailable \(\d{3}\)\.$/.test(message)) return message;
    if (message === 'No recent dialogue for Jev.') return translate(message, 'stlo.jev.noDialogue');
    if (message === 'Select a NanoGPT subscription connection profile.') return translate(message, 'stlo.jev.missingProfile');
    if (message === 'Jev did not return a decision for every candidate.' || message === 'NanoGPT did not return readable Jev decisions.' || message === 'NanoGPT did not complete the Jev request.') return translate('Invalid or incomplete Jev response.', 'stlo.jev.invalidResponse');
    return translate('Recall could not be completed.', 'stlo.jev.failureReason');
}
async function askJevRetry(run, error, retryAvailable = true) {
    if (!isCurrentJev(run)) return false;
    const reason = jevFailureReason(error);
    updateJevReport(run, { phase: 'retry', error: reason });
    const panel = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = translate('Jev memory recall failed', 'stlo.jev.failureTitle');
    const detail = document.createElement('p');
    detail.textContent = reason;
    const notice = document.createElement('p');
    notice.textContent = retryAvailable
        ? translate('Retry sends one additional Jev request. The RP reply has not been generated.', 'stlo.jev.retryNotice')
        : translate('The reply has not been generated. Cancel and try again after checking your settings.', 'stlo.jev.cancelNotice');
    panel.append(title, detail, notice);
    const popup = new Popup(panel, POPUP_TYPE.CONFIRM, '', {
        okButton: retryAvailable ? translate('Retry Jev', 'stlo.jev.retryButton') : false,
        cancelButton: translate('Cancel reply', 'stlo.jev.cancelButton'),
        defaultResult: 0,
    });
    const cancel = () => { void popup.completeCancelled(); };
    run.controller.signal.addEventListener('abort', cancel, { once: true });
    try {
        const result = await popup.show();
        return retryAvailable && result === 1 && isCurrentJev(run);
    } finally {
        run.controller.signal.removeEventListener('abort', cancel);
    }
}
function cancelJevReply(run, abort) {
    if (isCurrentJev(run)) {
        updateJevReport(run, { phase: 'cancelled' });
        // Prevent later interceptors and the main model; stop also clears ST's UI.
        abort(true);
        stopGeneration();
    } else {
        abort(true);
    }
}
async function abortJevPreparation(run, abort, error) {
    if (!isCurrentJev(run)) { abort(true); return; }
    console.warn('🦥 STLO', '[STLO] Jev preparation failed:', error?.name ?? 'Error');
    try {
        await askJevRetry(run, error, false);
    } finally {
        cancelJevReply(run, abort);
    }
}
async function decideJevWithRetry(run, prepared, batches) {
    const queue = [...batches];
    const decisions = [];
    let partialQuestions=0;
    let completed = 0;
    let assessed = 0;
    const usage=run.metrics.usage;
    while (queue.length && isCurrentJev(run)) {
        const batch = queue[0];
        const connection = getJevConnection();
        try {
            if (!connection) throw Error('Select a NanoGPT subscription connection profile.');
            updateJevReport(run, { phase: 'running', error: null,
                requests: run.report.requests + 1,
                estimatedInputTokens: (run.report.estimatedInputTokens ?? 0) + batch.estimatedTokens,
                inputChars: (run.report.inputChars ?? 0) + JSON.stringify(batch.body).length,
            });
            const start = performance.now();
            let result;
            try {
                const signal = AbortSignal.any([run.controller.signal, AbortSignal.timeout(60000)]);
                result = await requestJevRecall(batch, connection, getRequestHeaders(), signal);
            } finally {
                updateJevReport(run, { requestMs: run.report.requestMs + Math.round(performance.now() - start) });
            }
            if (!isCurrentJev(run)) return null;
            decisions.push(...result.decisions);
            partialQuestions+=batch.partialPlans?.size??0;
            queue.shift();
            completed++;
            assessed += batch.candidates.size;
            usage.add(result);
            updateJevReport(run, {
                completedBatches: completed,
                ...(run.options.partialInjection===true?{partialQuestions}:{}),
                assessed,
                unassessed: prepared.candidates.size - assessed,
                ...usage.summary(),
            });
        } catch (error) {
            if (!isCurrentJev(run)) return null;
            if (error?.name === 'JevInputLimitError') {
                // Excerpt questions are optional. Prefer the unchanged base
                // request over splitting/retrying solely for an excerpt.
                if(batch.baseBatch){queue[0]=batch.baseBatch;continue;}
                const smaller = splitJevBatch(batch);
                if (!smaller.length) throw error;
                // Only an explicit provider size rejection can cause an
                // automatic split. Ordinary errors require user approval.
                queue.splice(0, 1, ...smaller);
                updateJevReport(run, { plannedBatches: completed + queue.length });
                continue;
            }
            if (!await askJevRetry(run, error)) return null;
        }
    }
    if(queue.length||!isCurrentJev(run))return null;
    for(const item of decisions)run.metrics.selected.set(item.key,{decision:'include',score:Number.isFinite(item.score)?item.score:null,
        source:run.candidateSources?.get(item.key)??(run.options.mode==='filtered'?'native':'all')});
    if(run.options.partialInjection===true){
        run.excerpts=new Map(decisions.filter(item=>item.excerpt).map(item=>[item.key,item.excerpt]));
        updateJevReport(run,{partialSelected:run.excerpts.size});
    }
    return rankJevDecisions(prepared, decisions);
}

// The optional filtered mode uses a native dry scan after the existing vector
// interceptor. The scan event exposes matched candidates before its budget
// loop, even when some are not ultimately activated. No extra vector query.
async function collectNativeJevCandidates(run, chat, contextSize, type) {
    const context = getContext();
    const prompts = context.extensionPrompts;
    const oldNote = prompts?.[NOTE_MODULE_NAME] ? structuredClone(prompts[NOTE_MODULE_NAME]) : undefined;
    const hadNote = Boolean(prompts && Object.hasOwn(prompts, NOTE_MODULE_NAME));
    const meta = context.chatMetadata;
    const hadTimed = Boolean(meta && Object.hasOwn(meta, 'timedWorldInfo'));
    const oldTimed = hadTimed ? structuredClone(meta.timedWorldInfo) : undefined;
    const preview = { entries: null, settings: null, candidates: new Set() };
    run.preview = preview;
    try {
        const card = getCharacterCardFields();
        const scanData = {
            trigger: type, personaDescription: card.persona, characterDescription: card.description,
            characterPersonality: card.personality, characterDepthPrompt: card.charDepthPrompt,
            scenario: card.scenario, creatorNotes: card.creatorNotes,
        };
        const messages = (chat ?? []).map(message => world_info_include_names ? message.name + ': ' + message.mes : message.mes).reverse();
        await checkWorldInfo(messages, contextSize, true, scanData);
        if (!preview.entries || !preview.settings) throw Error('Native candidate scan did not complete.');
        return preview;
    } finally {
        run.preview = null;
        // Native dry scans still reset external activations and may touch the
        // Author's Note. Restore those transient values, never persisted books.
        if (isCurrentJev(run)) {
            if (prompts) {
                if (hadNote) prompts[NOTE_MODULE_NAME] = oldNote;
                else delete prompts[NOTE_MODULE_NAME];
            }
            if (meta) {
                if (hadTimed) meta.timedWorldInfo = oldTimed;
                else delete meta.timedWorldInfo;
            }
            // Restore consumed external hits only after successful preparation.

        }
    }
}

async function restoreNativeVectorHits(run) {
    if (run.options.mode !== 'filtered' || !run.forced.size || !isCurrentJev(run)) return;
    run.replaying = true;
    try {
        await eventSource.emit(event_types.WORLDINFO_FORCE_ACTIVATE, [...run.forced.values()]);
    } finally {
        run.replaying = false;
        run.forced.clear();
    }
}

async function prepareJevGeneration(run, chat, contextSize, abort, type) {
    if (!isCurrentJev(run)) { abort(true); return; }
    if (run.preparing || run.selection) return;
    run.preparing = true;
    try {
        const previewStart=performance.now();
        const preview = run.options.mode === 'filtered'
            ? await collectNativeJevCandidates(run, chat, contextSize, type)
            : null;
        if(preview)updateJevReport(run,{previewMs:Math.round(performance.now()-previewStart)});
        const snapshot=run.adaptiveSnapshot;
        run.adaptiveSnapshot=null;
        const entries = preview?.entries ?? snapshot?.entries ?? await getSortedEntries();
        if (!isCurrentJev(run)) { abort(true); return; }
        const settings = preview?.settings ?? snapshot?.settings ?? new Map(EXTENSION_STATE.scanWorldSettings);
        const active = new Set(entries.map(entry => entry.world));
        const worlds = new Set([...getJevWorlds(settings, run.characterRecall)].filter(world => active.has(world)));
        const budget = normalizeJevBudget(extension_settings[EXTENSION_NAME]?.jevBudget);
        let candidateKeys = preview?.candidates ?? null;
        if(run.requestedMode==='adaptive'&&candidateKeys){
            const scope=JSON.stringify([run.chatId,getJevCharacterAvatar(),getContext().groupId,EXTENSION_STATE.currentSpeakingCharacter]);
            if(adaptiveCueScope!==scope){adaptiveCueCache.clear();adaptiveCueScope=scope;}
            const coverage=coverAdaptiveJevCandidates(entries,worlds,candidateKeys,{chatId:run.chatId,messages:chat??getContext().chat??[],cueCache:adaptiveCueCache});
            const report={adaptiveEligible:coverage.eligibleCount,adaptiveNative:coverage.nativeCount,
                adaptiveDurable:coverage.durableCount,adaptiveCompact:coverage.compactCount,adaptiveRoles:coverage.roleCount,adaptiveAnchors:coverage.anchorCount,adaptiveRecent:coverage.recentCount};
            if(!coverage.nativeCount||coverage.candidateKeys.size===coverage.eligibleCount){
                // Preserve existing zero-hit fallback and vector replay. If
                // coverage itself reaches the whole set, report it honestly.
                candidateKeys=null;
                run.candidateSources=null;
                updateJevReport(run,{...report,mode:'all',adaptiveReason:coverage.nativeCount?'coverage-all':'empty-filter'});
            }else{
                candidateKeys=coverage.candidateKeys;
                run.candidateSources=coverage.sources;
                updateJevReport(run,report);
            }
        }
        if (!isCurrentJev(run)) { abort(true); return; }
        const messages = chat ?? getContext().chat ?? [];
        const hasCandidate = entries.some(entry => isJevCandidate(entry, worlds) && (!candidateKeys || candidateKeys.has(jevEntryKey(entry))));
        if (hasCandidate && !messages.some(message => !message?.is_system && typeof message?.mes === 'string' && message.mes.trim())) {
            throw Error('No recent dialogue for Jev.');
        }
        const prepared=prepareJevRecall(entries,worlds,messages,run.options,candidateKeys,run.requestedMode==='adaptive'?adaptivePlanCache:null);
        updateJevReport(run, { eligibleEntries:prepared?.stats.eligibleEntries??run.report.adaptiveEligible,
            assessed:0, candidates: prepared?.candidates.size ?? 0,
            unassessed: prepared?.candidates.size ?? 0, inputChars: 0, estimatedInputTokens: 0,
            truncatedMessages: prepared?.stats.truncatedMessages ?? 0, truncatedLore: prepared?.stats.truncatedLore ?? 0,
            sharedEntries: prepared?.stats.sharedEntries ?? 0, plannedBatches: 0, completedBatches: 0,
            ...(run.options.partialInjection===true?{partialQuestions:0,partialSelected:0,partialApplied:0,partialSavedChars:0}:{}),
        });
        if (!prepared) {
            // Empty candidates are a successful zero-selection, not a failure.
            run.selection = { accepted: new Map(), worlds, budget, contextSize };
            await restoreNativeVectorHits(run);
            updateJevReport(run, { phase: 'empty', selected: 0, accepted: 0, injected: 0 });
            return;
        }
        const batches = planJevRequests(prepared);
        updateJevReport(run, { plannedBatches: batches.length });
        const ranked = await decideJevWithRetry(run, prepared, batches);
        if (ranked === null || !isCurrentJev(run)) { cancelJevReply(run, abort); return; }
        const worldInfoBudget = calculateTotalWIBudget(contextSize);
        const bookBudgets = new Map(await Promise.all([...active].map(async world =>
            [world, await calculateLorebookBudget(settings.get(world), worldInfoBudget, contextSize)])));
        const bookPriorities = new Map([...worlds].map(world => {
            const book = settings.get(world);
            const override = book?.characterOverrides?.[EXTENSION_STATE.currentSpeakingCharacter];
            return [world, override?.priority ?? book?.priority ?? PRIORITY_LEVELS.DEFAULT];
        }));
        const diagnostics = new Map();
        const accepted = await fitJevRecall(entries, worlds, ranked, {
            budget, worldInfoBudget: worldInfoBudget || Infinity, bookBudgets, countTokens: getTokenCountAsync, countEntryTokens:countBudgetEntry,
            bookPriorities, diagnostics,
        });
        if (!isCurrentJev(run)) { abort(true); return; }
        run.metrics.limits=new Map(bookBudgets);
        run.metrics.accepted=new Set(accepted.keys());
        for(const [key,reason] of diagnostics){const item=run.metrics.selected.get(key);if(item)item.budget=reason;}
        const excerpts=run.excerpts?new Map([...run.excerpts].filter(([key])=>accepted.has(key))):null;
        run.excerpts=null;
        run.selection = { accepted, worlds, budget, contextSize, ...(excerpts?.size?{excerpts}:{}) };
        await restoreNativeVectorHits(run);
        const reasons = [...diagnostics.values()];
        updateJevReport(run, { phase: 'ready', selected: ranked.length, accepted: accepted.size,
            rejectedBook: reasons.filter(reason => reason === 'book-budget').length,
            rejectedJev: reasons.filter(reason => reason === 'jev-budget').length,
            rejectedWorld: reasons.filter(reason => reason === 'world-budget').length,
        });
    } catch (error) {
        run.selection = null;
        await abortJevPreparation(run, abort, error);
    } finally {
        run.preparing = false;
    }
}

function guardUnpreparedJevReply(_data, dryRun) {
    const run = jevGeneration;
    if(!dryRun&&run?.metrics?.pending?.keys.size===0&&isCurrentJev(run))publishScanMetrics(run,[],true);
    if (dryRun || !run?.enabled || run.selection || !isCurrentJev(run)) return;
    updateJevReport(run, { phase: 'cancelled', error: translate('Recall preparation did not complete.', 'stlo.jev.vectorMissing') });
    stopGeneration();
    toastr.error(translate('Recall preparation did not complete. The reply was cancelled.', 'stlo.jev.prepareCancelled'), slothToastTitle());
}
function recordJevActivated(entries,fromScan=false) {
    const run = jevGeneration;
    if (!run || !isCurrentJev(run) || run.preview || !Array.isArray(entries)) return;
    if(!fromScan)publishScanMetrics(run,entries,true);
    if(!run.selection)return;
    const keys = new Set(entries.map(jevEntryKey));
    const injected = [...run.selection.accepted.keys()].filter(key => keys.has(key)).length;
    updateJevReport(run, { phase: 'done', injected });
}

/**
 * Get settings for a specific lorebook
 * @param {string} worldName - Name of the lorebook
 * @returns {Object} Lorebook settings or defaults
 */
async function getLorebookSettings(worldName) {
    try {
        // Cache-first: avoid backend fetches that may be gated by permissions/visibility
        if (worldInfoCache.has(worldName)) {
            const worldData = getCachedLorebook(worldName);
            const extensionData = worldData && typeof worldData === 'object' ? worldData[EXTENSION_NAME] : null;
            return { ...DEFAULT_LOREBOOK_SETTINGS, ...(extensionData ? structuredClone(extensionData) : {}) };
        }

        // Not in cache: intentionally return defaults without fetching
        return { ...DEFAULT_LOREBOOK_SETTINGS };
    } catch (error) {
        console.error('🦥 STLO', `Error reading STLO settings for ${worldName} from cache:`, error);
        return { ...DEFAULT_LOREBOOK_SETTINGS };
    }
}

/**
 * Save settings for a specific lorebook
 * @param {string} worldName - Name of the lorebook
 * @param {Object} settings - Settings to save
 */
function equalBookSetting(a, b) {
    if (Object.is(a, b)) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equalBookSetting(a[key], b[key]));
}

async function setLorebookSettings(worldName, settings) {
    try {
        if (!world_names.includes(worldName)) throw Error('Lorebook is no longer available.');
        const loaded = await loadWorldInfo(worldName);
        if (!loaded) throw Error('Could not load the selected lorebook.');
        const existing = loaded[EXTENSION_NAME] || {};
        // Merge only changed STLO fields into the current book. Never edit
        // lore entries or character associations from this settings manager.
        const worldData = { ...loaded, [EXTENSION_NAME]: { ...existing, ...settings } };
        await saveWorldInfo(worldName, worldData, true);
        // The native save emits WORLDINFO_UPDATED itself. Do not emit again.
        const response = await fetch('/api/worldinfo/get', {
            method: 'POST', headers: getRequestHeaders(),
            body: JSON.stringify({ name: worldName }), cache: 'no-cache',
        });
        if (!response.ok) throw Error('Could not verify the saved lorebook.');
        const persisted = await response.json();
        if (!persisted || typeof persisted !== 'object') throw Error('Could not verify the saved lorebook.');
        worldInfoCache.set(worldName, persisted);
        const actual = persisted[EXTENSION_NAME] || {};
        if (!Object.entries(settings).every(([key, value]) => equalBookSetting(actual[key], value))) {
            throw Error('Saved values do not match.');
        }
        return true;
    } catch (error) {
        // Native ST updates its cache before saving. Never leave an
        // unverified value cached as though the write had succeeded.
        worldInfoCache.delete(worldName);
        console.error('🦥 STLO', '[STLO] Error saving or verifying lorebook settings:', worldName, error);
        return false;
    } finally {
        EXTENSION_STATE.scanWorldSettings = new Map();
        EXTENSION_STATE.scanBudgetWorlds = new Set();
        EXTENSION_STATE.scanHasExplicitBudgets = false;
    }
}

/**
 * Get the currently active/selected lorebook name
 * @returns {string|null} Name of the active lorebook
 */
function getCurrentLorebookName() {
    // Check if we're in the world info editor (matching SillyTavern's pattern)
    const worldSelect = document.querySelector(SELECTORS.WORLD_EDITOR_SELECT);
    if (worldSelect && worldSelect.value !== '' && worldSelect.value !== 'none') {
        const selectedIndex = parseInt(worldSelect.value);
        if (!isNaN(selectedIndex) && world_names && Array.isArray(world_names) &&
            selectedIndex >= 0 && selectedIndex < world_names.length &&
            world_names[selectedIndex]) { // Ensure array element exists
            const selectedName = world_names[selectedIndex];
            // Ensure the selected name is a valid non-empty string
            if (selectedName && typeof selectedName === 'string' && selectedName.trim() !== '') {
                return selectedName;
            }
        }
    }

    return null;
}

// Case-insensitive lorebook index lookup
function findLorebookIndexByName(name) {
    try {
        if (!name) return -1;
        const target = String(name).trim().toLowerCase();
        if (!Array.isArray(world_names)) return -1;
        return world_names.findIndex(n => typeof n === 'string' && n.trim().toLowerCase() === target);
    } catch {
        return -1;
    }
}

// Select a lorebook by index in the World Info selector
async function selectLorebookByIndex(index) {
    const worldSelect = document.querySelector(SELECTORS.WORLD_EDITOR_SELECT);
    if (!worldSelect) return false;
    if (!Array.isArray(world_names) || index < 0 || index >= world_names.length) return false;
    worldSelect.value = String(index);
    worldSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 1));
    return true;
}

// Open STLO modal for a specific lorebook name (required, case-insensitive)
async function openStloForLorebook(name) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) {
        toastr.warning(translate('Usage: /stlo <lorebook name>', 'stlo.cmd.usage'), slothToastTitle());
        return '';
    }

    const idx = findLorebookIndexByName(trimmed);
    if (idx === -1) {
        toastr.warning(tKey('stlo.cmd.notfound', 'Lorebook not found: ${0}', trimmed), slothToastTitle());
        return '';
    }

    // Attempt selection (silently continue if not possible), then open modal
    await selectLorebookByIndex(idx);
    await openLorebookSettings(world_names[idx]);
    return '';
}

// Register the /stlo slash command
function registerStloSlashCommand() {
    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'stlo',
            callback: async (_args, value) => {
                return await openStloForLorebook(typeof value === 'string' ? value : '');
            },
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: translate('lorebook name (case-insensitive)', 'stlo.cmd.arg.name'),
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: true,
                }),
            ],
            helpString: `
                <div>${translate('Open STLO Priority & Budget for a specific lorebook.', 'stlo.cmd.help')}</div>
                <div><code>/stlo My Lorebook</code></div>
            `,
        }));
    } catch (e) {
        console.warn('🦥 STLO', '[STLO] Failed to register /stlo command:', e);
    }
}

/**
 * Open the lorebook settings modal
 */
function infoHelp(key, fallback) {
    return `<details class="stlo-info"><summary aria-label="Help">i</summary><div class="stlo-info-body"><small data-i18n="${key}">${fallback}</small></div></details>`;
}

async function openJevSettings() {
    if (EXTENSION_STATE.modalOpen) return;
    EXTENSION_STATE.modalOpen = true;
    const listeners = [];
    let frame = null;
    try {
        const avatar = getJevCharacterAvatar();
        const characterName = avatar ? characters?.[this_chid]?.name || avatar : '';
        const enabled = getCharacterJevRecall(avatar) === true;
        const jevOptions = getJevOptions();
        const tr = (fallback, key) => translate(fallback, 'stlo.jev.' + key);
        const promptModel = createJevPromptLibrary(jevOptions, extension_settings[EXTENSION_NAME]?.jevPromptLibrary, {
            defaultName: tr('Default prompt', 'promptDefault'),
            previousName: tr('Previous prompt', 'promptPrevious'),
        });
        let promptUi = null;
        let dialogOpen = true;
        const promptIcon = (action, icon, key) => '<button type="button" class="menu_button stlo-jev-prompt-icon" data-jev-prompt-action="' + action + '" data-jev-prompt-label="' + key + '"><i class="fa-solid ' + icon + '" aria-hidden="true"></i></button>';
        const html = `
            <div class="stlo-modal-ui stlo-jev-settings">
                <div class="world_entry_form_control stlo-section">
                    <h3 data-i18n="stlo.jev.settingsTitle">Lorebook Jev Recall</h3>
                    ${HAS_WORLDINFO_SCAN_DONE && avatar ? `
                        <div class="stlo-character-line">
                            <span data-i18n="stlo.jev.characterTitle">Current character</span>
                            <strong id="stlo-jev-character-name"></strong>
                        </div>
                        <div class="stlo-option-line">
                            <label class="checkbox_label stlo-checkrow" for="stlo-jev-character-choice">
                                <input type="checkbox" id="stlo-jev-character-choice" ${enabled ? 'checked' : ''}>
                                <span class="checkmark"></span>
                                <span data-i18n="stlo.jev.characterActivation">Use Jev</span>
                            </label>
                            ${infoHelp('stlo.jev.characterActivationHelp', 'Applies to every chat with this character and all active linked lorebooks, except books excluded from Jev.')}
                        </div>` : HAS_WORLDINFO_SCAN_DONE ? `<small data-i18n="stlo.jev.noCharacter">Open a one-to-one chat to set character-level Jev. Group chats use the book settings.</small>` : `<small data-i18n="stlo.jev.unsupported">Jev requires World Info scan support.</small>`}
                </div>
                ${HAS_WORLDINFO_SCAN_DONE ? `
                <div class="world_entry_form_control stlo-section">
                    <h4 data-i18n="stlo.jev.sharedTitle">Jev injection settings (all characters)</h4>
                    <div class="stlo-jev-fields">
                        <div class="stlo-jev-field"><div class="stlo-field-heading"><label for="stlo-jev-budget" data-i18n="stlo.jev.budget">Total Jev budget (tokens)</label>${infoHelp('stlo.jev.budgetHelp', 'Shared injection ceiling, not an API input-token limit. World Info and individual book limits still apply.')}</div><input type="number" id="stlo-jev-budget" class="text_pole textarea_compact" min="1" step="1" value="${normalizeJevBudget(extension_settings[EXTENSION_NAME]?.jevBudget)}"></div>
                        <div class="stlo-jev-field"><div class="stlo-field-heading"><label for="stlo-jev-profile" data-i18n="stlo.jev.profile">NanoGPT connection profile</label>${infoHelp('stlo.jev.keyHelp', 'Only NanoGPT connection keys are supported. Use a key with Billing set to Subscription only to block balance charges.')}</div><select id="stlo-jev-profile" class="text_pole textarea_compact"><option value="" data-i18n="stlo.jev.chooseProfile">Select a profile</option></select></div>
                    </div>
                </div>
                <div class="world_entry_form_control stlo-section">
                <div class="stlo-field-heading"><h4 data-i18n="stlo.jev.mode">Jev candidate source</h4>${infoHelp('stlo.jev.modeHelp', 'All: assess every eligible entry instead of ordinary vector recall for Jev books. Filtered: assess only keyword/vector hits. Other vector recall is retained.')}</div>
                <label class="stlo-jev-radio"><input type="radio" name="stlo-jev-mode" value="all" ${jevOptions.mode === "all" ? "checked" : ""}><span data-i18n="stlo.jev.modeAll">All eligible lorebook entries (default)</span></label>
                <label class="stlo-jev-radio"><input type="radio" name="stlo-jev-mode" value="filtered" ${jevOptions.mode === "filtered" ? "checked" : ""}><span data-i18n="stlo.jev.modeFiltered">Vector / keyword search candidates</span></label>
                <label class="stlo-jev-radio"><input type="radio" name="stlo-jev-mode" value="adaptive" ${jevOptions.mode === "adaptive" ? "checked" : ""}><span data-i18n="stlo.jev.modeAdaptive">Adaptive (experimental)</span></label>
                <div class="stlo-jev-field" id="stlo-jev-adaptive-field" ${jevOptions.mode==='adaptive'?'':'hidden'}>
                    <div class="stlo-field-heading"><label for="stlo-jev-adaptive-threshold" data-i18n="stlo.jev.adaptiveThreshold">Full-plan input threshold (estimated tokens)</label>${infoHelp('stlo.jev.adaptiveHelp','Assess all entries below the threshold; above it, supplement native World Info hits with durable-memory cues, concise entries, explicit long-term/NPC records, concrete title/key matches, and recent entries with comparable source positions. Without World Info vectors or eligible hits, assess all. Coverage is experimental, not a recall guarantee. The threshold is an estimate, not an injection budget.')}</div>
                    <input type="number" id="stlo-jev-adaptive-threshold" class="text_pole textarea_compact" min="1" max="100000000" step="1" value="${jevOptions.adaptiveThreshold??DEFAULT_JEV_ADAPTIVE_THRESHOLD}">
                </div>
                </div>
                <div class="world_entry_form_control stlo-section">
                <details class="stlo-jev-advanced"><summary data-i18n="stlo.jev.advanced">Advanced Jev settings</summary><div class="stlo-jev-advanced-body">
                <div class="stlo-jev-fields">
                <div class="stlo-jev-field"><div class="stlo-field-heading"><label for="stlo-jev-recent" data-i18n="stlo.jev.recent">Recent messages</label>${infoHelp('stlo.jev.recentHelp', 'Jev reads this many recent messages in full by default. Default: 20.')}</div><input type="number" id="stlo-jev-recent" class="text_pole textarea_compact" min="1" max="100" step="1" value="${jevOptions.recent}"></div>
                <div class="stlo-jev-field"><div class="stlo-field-heading"><label for="stlo-jev-preset" data-i18n="stlo.jev.preset">Default selection style</label>${infoHelp('stlo.jev.presetHelp', 'Strict: direct relevance. Balanced: default. Generous: indirect relevance too. Changing this selects the built-in prompt.')}</div><select id="stlo-jev-preset" class="text_pole textarea_compact"><option value="strict" data-i18n="stlo.jev.strict">Strict</option><option value="balanced" data-i18n="stlo.jev.balanced">Balanced</option><option value="generous" data-i18n="stlo.jev.generous">Generous</option></select></div>
                </div>
                <div class="stlo-option-line"><label class="checkbox_label stlo-checkrow" for="stlo-jev-partial"><input type="checkbox" id="stlo-jev-partial" ${jevOptions.partialInjection===true?'checked':''}><span class="checkmark"></span><span data-i18n="stlo.jev.partial">Partial injection (experimental)</span></label>${infoHelp('stlo.jev.partialHelp','Only long structured Scene memories, with a built-in prompt and no reading limits. Jev may select a safe excerpt in the same request; uncertainty keeps the full text. Full-text budgets and native activation remain unchanged.')}</div>
                <details class="stlo-jev-advanced stlo-jev-reading-limits" ${jevOptions.messageLength || jevOptions.loreLength ? 'open' : ''}>
                    <summary class="stlo-reading-summary"><span data-i18n="stlo.jev.readingLimits">Reading limits</span><small id="stlo-jev-reading-status"></small></summary>
                    <div class="stlo-jev-fields stlo-jev-limit-fields">
                        <div class="stlo-jev-field"><div class="stlo-field-heading"><label for="stlo-jev-message-length" data-i18n="stlo.jev.messageLength">Message character limit</label>${infoHelp('stlo.jev.messageLengthHelp', '0 reads the full message. A positive limit keeps the end.')}</div><input type="number" id="stlo-jev-message-length" class="text_pole textarea_compact" min="0" max="20000" step="1" value="${jevOptions.messageLength}"></div>
                        <div class="stlo-jev-field"><div class="stlo-field-heading"><label for="stlo-jev-lore-length" data-i18n="stlo.jev.loreLength">Lore character limit</label>${infoHelp('stlo.jev.loreLengthHelp', '0 reads the full entry. A positive limit keeps the beginning and end.')}</div><input type="number" id="stlo-jev-lore-length" class="text_pole textarea_compact" min="0" max="20000" step="1" value="${jevOptions.loreLength}"></div>
                    </div>
                </details>
                <div class="stlo-jev-prompt-library" id="stlo-jev-prompt-library">
                    <header class="stlo-jev-prompt-heading">
                        <div class="stlo-field-heading"><h4 data-i18n="stlo.jev.prompt">Selection prompt</h4>${infoHelp('stlo.jev.promptHelp', 'Edit decision criteria, not the structured response format. The settings are shared across characters.')}</div>
                        <div class="stlo-jev-prompt-tools">
                            ${promptIcon('expand','fa-expand','promptExpand')}
                            ${promptIcon('export','fa-file-export','promptExport')}
                            ${promptIcon('import','fa-file-import','promptImport')}
                            ${promptIcon('delete','fa-trash','promptDelete')}
                        </div>
                    </header>
                    <div class="stlo-jev-prompt-selection">
                        <select id="stlo-jev-prompt-choice" class="text_pole" aria-label="Jev prompt"></select>
                        ${promptIcon('save','fa-floppy-disk','promptSave')}
                        ${promptIcon('rename','fa-pen','promptRename')}
                        ${promptIcon('copy','fa-file-circle-plus','promptSaveAs')}
                    </div>
                    <textarea id="stlo-jev-prompt" class="text_pole" rows="5" spellcheck="false" aria-label="Jev prompt"></textarea>
                    <small class="stlo-jev-prompt-status" id="stlo-jev-prompt-status" role="status" aria-live="polite"></small>
                    <input type="file" id="stlo-jev-prompt-file" accept=".json,application/json" hidden>
                </div>
                <div class="stlo-jev-actions"><button type="button" class="menu_button" id="stlo-jev-reset" data-i18n="stlo.jev.reset">Restore defaults</button></div></div></details>
                </div>` : ''}
            </div>`;
        const result = await new Promise(resolve => {
            const popup = new Popup(html, POPUP_TYPE.CONFIRM, '', {
                okButton: translate('Save Settings', 'stlo.modal.save.ok'),
                cancelButton: translate('Cancel', 'stlo.modal.cancel'),
                wide: false, large: false, allowVerticalScrolling: true,
                onClosing: closingPopup => {
                    if (closingPopup.result !== 1) { dialogOpen = false; resolve(null); return true; }
                    const result = {};
                    if (HAS_WORLDINFO_SCAN_DONE) {
                        if (!promptUi || promptUi.isBusy()) return false;
                        const promptState = promptModel.snapshot();
                        if (!promptState) {
                            toastr.warning(tr('Prompt text cannot be empty.', 'promptEmpty'), slothToastTitle());
                            return false;
                        }
                        const val = id => document.getElementById(id)?.value;
                        const opts = {
                            inputVersion: 2,
                            mode: document.querySelector('input[name="stlo-jev-mode"]:checked')?.value,
                            adaptiveThreshold: val('stlo-jev-adaptive-threshold'),
                            partialInjection: document.getElementById('stlo-jev-partial')?.checked===true,
                            recent: val('stlo-jev-recent'),
                            messageLength: val('stlo-jev-message-length'),
                            loreLength: val('stlo-jev-lore-length'),
                            preset: promptState.preset,
                            prompt: promptState.prompt,
                        };
                        const numeric = [[opts.recent, 1, 100, false], [opts.messageLength, 100, 20000, true], [opts.loreLength, 100, 20000, true],[opts.adaptiveThreshold,1,100000000,false]];
                        if (numeric.some(([value, min, max, allowZero]) => !String(value ?? '').trim() || !Number.isSafeInteger(Number(value)) || (!(allowZero && Number(value) === 0) && (Number(value) < min || Number(value) > max)))) {
                            toastr.error(translate('Check the Jev numeric settings and custom prompt.', 'stlo.jev.validation'), slothToastTitle());
                            return false;
                        }
                        const rawBudget = val('stlo-jev-budget');
                        const budget = Number(rawBudget);
                        if (!String(rawBudget ?? '').trim() || !Number.isSafeInteger(budget) || budget <= 0) {
                            toastr.error(translate('Enter a positive whole-number injection budget.', 'stlo.jev.invalidBudget'), slothToastTitle());
                            return false;
                        }
                        result.jevBudget = budget;
                        result.jevProfileId = val('stlo-jev-profile') ?? '';
                        result.jevOptions = normalizeJevOptions(opts);
                        result.jevPromptLibrary = promptState.library;
                        const characterChoice = document.getElementById('stlo-jev-character-choice');
                        result.characterChoice = characterChoice ? (characterChoice.checked ? 'on' : 'off') : undefined;
                    }
                    dialogOpen = false;
                    resolve(result);
                    return true;
                },
            });
            popup.show();
            frame = requestAnimationFrame(() => {
                frame = null;
                const name = document.getElementById('stlo-jev-character-name');
                if (name) name.textContent = characterName;
                setupStloInfoPopups(listeners);
                if (HAS_WORLDINFO_SCAN_DONE) {
                    promptUi = setupJevModalBehavior(listeners, promptModel, tr, () => dialogOpen);
                }
            });
        });
        if (result) {
            const settings = extension_settings[EXTENSION_NAME] ??= {};
            if (HAS_WORLDINFO_SCAN_DONE) {
                settings.jevBudget = result.jevBudget;
                settings.jevProfileId = result.jevProfileId;
                settings.jevOptions = result.jevOptions;
                settings.jevPromptLibrary = result.jevPromptLibrary;
                setCharacterJevRecall(settings, avatar, result.characterChoice);
            }
            saveSettingsDebounced();
            toastr.success(translate('Settings saved.', 'stlo.jev.settingsSaved'), slothToastTitle());
        }
    } catch (error) {
        console.error('🦥 STLO', '[STLO] Error opening Jev settings:', error);
        toastr.error(translate('Failed to open or save Jev settings.', 'stlo.jev.settingsError'), slothToastTitle());
    } finally {
        if (frame !== null) cancelAnimationFrame(frame);
        document.getElementById('stlo-info-popup')?.remove();
        for (const { element, event, handler, capture } of listeners) {
            element.removeEventListener(event, handler, Boolean(capture));
        }
        EXTENSION_STATE.modalOpen = false;
    }
}

function setupJevModalBehavior(modalEventListeners, promptModel, tr, isOpen) {
    const jevProfile = document.getElementById('stlo-jev-profile');
    if (jevProfile) {
        for (const profile of extension_settings.connectionManager?.profiles ?? []) {
            const connection = getNanoJevConnection(profile);
            if (connection) jevProfile.add(new Option(connection.name || connection.id, connection.id));
        }
        const stored = extension_settings[EXTENSION_NAME]?.jevProfileId || '';
        jevProfile.value = stored;
        if (stored && jevProfile.selectedIndex < 0) {
            jevProfile.add(new Option(translate('Saved profile (unavailable)', 'stlo.jev.unavailableProfile'), stored));
            jevProfile.value = stored;
        }
        if (jevProfile.selectedIndex < 0) jevProfile.selectedIndex = 0;
    }

    const preset = document.getElementById('stlo-jev-preset');
    const target = document.getElementById('stlo-jev-prompt-library');
    const reset = document.getElementById('stlo-jev-reset');
    if (!preset || !target || !reset) return null;
    const labelDefaults = {
        promptExpand: 'View full prompt', promptExport: 'Export prompt', promptImport: 'Import prompt',
        promptDelete: 'Delete prompt', promptSave: 'Save', promptRename: 'Rename prompt', promptSaveAs: 'Save as new prompt',
    };
    for (const button of target.querySelectorAll('[data-jev-prompt-label]')) {
        const key = button.dataset.jevPromptLabel;
        const label = tr(labelDefaults[key], key);
        button.title = label;
        button.setAttribute('aria-label', label);
    }
    const ui = mountJevPromptLibrary({ target, model: promptModel, generosity: preset, Popup, POPUP_TYPE, tr,
        warn: message => toastr.warning(message, slothToastTitle()), isOpen });
    const adaptiveField=document.getElementById('stlo-jev-adaptive-field');
    const syncAdaptive=()=>{if(adaptiveField)adaptiveField.hidden=document.querySelector('input[name="stlo-jev-mode"]:checked')?.value!=='adaptive';};
    for(const input of document.querySelectorAll('input[name="stlo-jev-mode"]')){
        input.addEventListener('change',syncAdaptive);
        modalEventListeners.push({element:input,event:'change',handler:syncAdaptive});
    }
    syncAdaptive();
    const messageLimit = document.getElementById('stlo-jev-message-length');
    const loreLimit = document.getElementById('stlo-jev-lore-length');
    const readingStatus = document.getElementById('stlo-jev-reading-status');
    const syncReadingStatus = () => {
        if (!readingStatus) return;
        const limited = Number(messageLimit?.value) > 0 || Number(loreLimit?.value) > 0;
        readingStatus.textContent = limited ? tr('Limit enabled', 'readingLimited') : tr('Full text', 'readingFull');
    };
    for (const input of [messageLimit, loreLimit]) {
        if (!input) continue;
        input.addEventListener('input', syncReadingStatus);
        modalEventListeners.push({ element: input, event: 'input', handler: syncReadingStatus });
    }
    syncReadingStatus();
    const onReset = () => {
        if (ui.isBusy()) return;
        const defaults = normalizeJevOptions();
        document.getElementById('stlo-jev-recent').value = String(defaults.recent);
        document.getElementById('stlo-jev-message-length').value = String(defaults.messageLength);
        document.getElementById('stlo-jev-lore-length').value = String(defaults.loreLength);
        const threshold=document.getElementById('stlo-jev-adaptive-threshold');
        if(threshold)threshold.value=String(DEFAULT_JEV_ADAPTIVE_THRESHOLD);
        const partial=document.getElementById('stlo-jev-partial');
        if(partial)partial.checked=false;
        syncReadingStatus();
        promptModel.chooseBuiltin('balanced');
        ui.render();
    };
    reset.addEventListener('click', onReset);
    modalEventListeners.push({ element: reset, event: 'click', handler: onReset });
    return ui;

}

// All IDs inside a book card are namespaced so several editors, including
// nested character cards, can coexist without selector or label collisions.
function bookField(root, id) {
    return root.querySelector('[data-stlo-field="' + id + '"]');
}

function createBookEditor(root, currentSettings, characterAvatar, showBookJev, prefix) {
    root.innerHTML = `
            <div class="world_entry_form_control stlo-section">
                <div class="stlo-field-heading">
                    <h4 data-i18n="stlo.modal.priority.title">Lorebook Priority</h4>
                    <details class="stlo-info">
                        <summary aria-label="Show help" data-i18n="[aria-label]stlo.ui.showHelp">i</summary>
                        <div class="stlo-info-body"><small data-i18n="stlo.modal.priority.help">Higher numbers (4-5) process first. Lower numbers (1-2) process last.</small></div>
                    </details>
                </div>

                <select id="${SELECTORS.LOREBOOK_PRIORITY_SELECT}" class="text_pole textarea_compact">
                    <option value="5" ${currentSettings.priority === 5 ? 'selected' : ''} data-i18n="stlo.modal.priority.option.5">5 - Highest Priority (Processes First)</option>
                    <option value="4" ${currentSettings.priority === 4 ? 'selected' : ''} data-i18n="stlo.modal.priority.option.4">4 - High Priority</option>
                    <option value="null" ${currentSettings.priority == null || Number(currentSettings.priority) === 3 ? 'selected' : ''} data-i18n="stlo.modal.priority.option.3">3 - Normal (SillyTavern Default)</option>
                    <option value="2" ${currentSettings.priority === 2 ? 'selected' : ''} data-i18n="stlo.modal.priority.option.2">2 - Low Priority</option>
                    <option value="1" ${currentSettings.priority === 1 ? 'selected' : ''} data-i18n="stlo.modal.priority.option.1">1 - Lowest Priority (Processes Last)</option>
                </select>
            </div>

            <div class="world_entry_form_control stlo-section">
                ${createBudgetControls('lorebook', currentSettings)}
            </div>

            <div class="world_entry_form_control stlo-section">
                <details class="stlo-book-advanced">
                    <summary data-i18n="stlo.manager.advanced">Advanced settings</summary>
                    <div class="stlo-book-advanced-body">
                <div class="stlo-toggle-block">
                    <div class="stlo-option-line">
                        <label class="checkbox_label stlo-checkrow" for="lorebook-order-adjustment-enabled">
                        <input type="checkbox" id="lorebook-order-adjustment-enabled"
                               ${currentSettings.orderAdjustment !== 0 ? 'checked' : ''}>
                        <span class="checkmark"></span>
                        <span data-i18n="stlo.modal.order.enableLabel">Enable Order Adjustment</span>
                    </label>
                    <details class="stlo-info stlo-info-end">
                        <summary aria-label="Show help" data-i18n="[aria-label]stlo.ui.showHelp">i</summary>
                        <div class="stlo-info-body"><small data-i18n="stlo.modal.order.help">Fine-tune processing order within this lorebook's priority level</small></div>
                    </details>
                    </div>
                </div>

                <div class="world_entry_form_control stlo-order-controls" id="lorebook-order-adjustment-container" ${currentSettings.orderAdjustment !== 0 ? '' : 'hidden'}>
                    <div class="stlo-field-heading">
                        <h4 data-i18n="stlo.modal.order.title">Order Adjustment</h4>
                        <details class="stlo-info">
                            <summary aria-label="Show help" data-i18n="[aria-label]stlo.ui.showHelp">i</summary>
                            <div class="stlo-info-body"><small data-i18n="stlo.modal.order.explain">Higher values process first. Examples: +250 for slight boost, -500 for lower priority.</small></div>
                        </details>
                    </div>
                    <div class="stlo-inline-number">
                        <input type="number" id="lorebook-order-adjustment" class="text_pole textarea_compact"
                               value="${Number(currentSettings.orderAdjustment) || 0}" min="-10000" max="10000" step="1"
                               placeholder="0" style="width: 100px;">
                        <details class="stlo-info"><summary aria-label="Help">i</summary><div class="stlo-info-body"><small data-i18n="stlo.modal.order.range">-10k to +10k</small></div></details>
                    </div>

                    <div class="stlo-toggle-block">
                        <div class="stlo-option-line">
                            <label class="checkbox_label stlo-checkrow" for="lorebook-order-adjustment-group-only">
                                <input type="checkbox" id="lorebook-order-adjustment-group-only"
                                       ${currentSettings.orderAdjustmentGroupOnly ? 'checked' : ''}>
                                <span class="checkmark"></span>
                                <span data-i18n="stlo.modal.order.groupOnly.label">Group Chats Only</span>
                            </label>
                            <details class="stlo-info stlo-info-end">
                                <summary aria-label="Show help" data-i18n="[aria-label]stlo.ui.showHelp">i</summary>
                                <div class="stlo-info-body"><small data-i18n="stlo.modal.order.groupOnly.help">Only apply order adjustment during group chats (ignored in single character chats)</small></div>
                            </details>
                        </div>
                    </div>
                </div>
                        ${showBookJev ? `<div class="stlo-toggle-block">
                            <div class="stlo-option-line"><label class="checkbox_label stlo-checkrow" for="stlo-jev-exclude"><input type="checkbox" id="stlo-jev-exclude" ${currentSettings.jevExclude === true ? "checked" : ""}><span class="checkmark"></span><span data-i18n="stlo.jev.exclude">Exclude this lorebook from Jev</span></label>${infoHelp('stlo.jev.excludeHelp', 'This book keeps native activation, including configured vector retrieval.')}</div>
                            <div class="stlo-legacy-book" ${characterAvatar ? "hidden" : ""}>
                            <div class="stlo-option-line"><label class="checkbox_label stlo-checkrow" for="stlo-jev-recall"><input type="checkbox" id="stlo-jev-recall" ${currentSettings.jevRecall === true ? "checked" : ""}><span class="checkmark"></span><span data-i18n="stlo.jev.legacyBook">Use Jev for this book in group chats</span></label>${infoHelp('stlo.jev.legacyBookHelp', 'Applies when using this book in a group chat.')}</div>
                            </div>
                        </div>` : ''}
                    <div class="stlo-book-vector">
                <div class="stlo-field-heading">
                    <h4 data-i18n="stlo.vector.threshold.title">Vector similarity threshold</h4>
                    <details class="stlo-info">
                        <summary aria-label="Show help" data-i18n="[aria-label]stlo.ui.showHelp">i</summary>
                        <div class="stlo-info-body"><small data-i18n="stlo.vector.threshold.help">Enter a value from 0 to 1. Leave blank to use the global setting. Different thresholds can require additional requests, time and cost.</small></div>
                    </details>
                </div>
                <input type="number" id="${SELECTORS.LOREBOOK_VECTOR_THRESHOLD}" class="text_pole textarea_compact"
                       min="0" max="1" step="0.01" placeholder="Leave blank to use global setting" data-i18n="[placeholder]stlo.vector.threshold.placeholder"
                       value="${currentSettings.vectorThresholdEnabled === true
                           && typeof currentSettings.vectorThreshold === 'number'
                           ? currentSettings.vectorThreshold : ''}">
            </div>
                    </div>
                </details>
            </div>
            <div class="world_entry_form_control stlo-section stlo-group-section">
                <details class="stlo-advanced-drawer">
                    <summary data-i18n="stlo.modal.groupOverrides.title">Group Chat Overrides</summary>
                    <div class="stlo-group-body">
                        <div class="stlo-toggle-block">
                            <div class="stlo-option-line">
                                <label class="checkbox_label stlo-checkrow" for="lorebook-only-when-speaking">
                                    <input type="checkbox" id="lorebook-only-when-speaking" ${currentSettings.onlyWhenSpeaking ? 'checked' : ''}>
                                    <span class="checkmark"></span>
                                    <span data-i18n="stlo.modal.onlyWhenSpeaking.label">Only use when an assigned character speaks</span>
                                </label>
                                ${infoHelp('stlo.modal.onlyWhenSpeaking.help.1', 'Applies only in group chats. When checked, this lorebook is used only on turns by assigned characters (none assigned means no injection). When unchecked, unassigned characters use the lorebook defaults.')}
                            </div>
                        </div>
                        <div id="advanced-priority-sections" class="stlo-group-cards"></div>
                        <button type="button" class="menu_button stlo-group-add" id="stlo-group-add-character"><i class="fa-solid fa-plus" aria-hidden="true"></i><span data-i18n="stlo.modal.groupOverrides.add">Add character</span></button>
                    </div>
                </details>
            </div>
        `;
    root.dataset.stloPrefix = prefix;
    for (const node of root.querySelectorAll('[id]')) {
        const original = node.id;
        node.dataset.stloField = original;
        node.id = prefix + original;
    }
    for (const label of root.querySelectorAll('label[for]')) label.htmlFor = prefix + label.htmlFor;
    applyLocale(root);
}

function readBookSettings(root, currentSettings, characterAvatar, showBookJev) {
    const field = id => bookField(root, id);
    const required = [SELECTORS.LOREBOOK_PRIORITY_SELECT, SELECTORS.LOREBOOK_BUDGET_MODE,
        SELECTORS.LOREBOOK_BUDGET_VALUE, 'lorebook-order-adjustment-enabled', 'lorebook-order-adjustment',
        'lorebook-order-adjustment-group-only', 'lorebook-only-when-speaking'];
    const fail = (fallback, key) => { toastr.error(translate(fallback, key), slothToastTitle()); return null; };
    if (required.some(id => !field(id))) return fail('Settings form not properly loaded. Please try again.', 'stlo.validation.formNotLoaded');
    const priorityValue = field(SELECTORS.LOREBOOK_PRIORITY_SELECT).value;
    const priority = priorityValue === 'null' ? null : Number(priorityValue);
    if (priority !== null && (!Number.isInteger(priority) || priority < 1 || priority > 5)) {
        return fail('Priority value must be between 1 and 5', 'stlo.validation.priorityRange');
    }
    const orderEnabled = field('lorebook-order-adjustment-enabled').checked;
    const rawOrder = field('lorebook-order-adjustment').value;
    const orderAdjustment = orderEnabled ? Number(rawOrder) : 0;
    if ((orderEnabled && !rawOrder.trim()) || !Number.isInteger(orderAdjustment) || Math.abs(orderAdjustment) > 10000) {
        return fail('Order adjustment must be between -10000 and 10000', 'stlo.validation.orderAdjustmentRange');
    }
    const mode = field(SELECTORS.LOREBOOK_BUDGET_MODE).value;
    const rawBudget = field(SELECTORS.LOREBOOK_BUDGET_VALUE).value;
    const budget = mode === 'default' ? 0 : Number(rawBudget);
    if (mode === 'percentage_context' || mode === 'percentage_budget') {
        if (!Number.isInteger(budget) || budget < 1 || budget > 100) {
            return fail('Budget percent must be between 1 and 100', 'stlo.validation.budgetPercentRange');
        }
    } else if (mode === 'fixed') {
        if (!Number.isSafeInteger(budget) || budget <= 0) {
            return fail('Fixed budget must be a positive integer', 'stlo.validation.fixedBudgetPositive');
        }
    } else if (mode !== 'default') {
        return fail('Settings form not properly loaded. Please try again.', 'stlo.validation.formNotLoaded');
    }
    const rawThreshold = String(field(SELECTORS.LOREBOOK_VECTOR_THRESHOLD)?.value ?? '').trim();
    const vectorThreshold = rawThreshold === '' ? null : Number(rawThreshold);
    if (vectorThreshold !== null && (!Number.isFinite(vectorThreshold) || vectorThreshold < 0 || vectorThreshold > 1)) {
        return fail('Enter a vector threshold between 0 and 1.', 'stlo.manager.thresholdRange');
    }
    // A collapsed or unopened drawer does not discard its saved assignments.
    const characterOverrides = getCharacterOverrides(root, currentSettings.characterOverrides || {});
    if (characterOverrides === null) return null;
    const result = {
        priority, budgetMode: mode, budget, orderAdjustment, characterOverrides,
        orderAdjustmentGroupOnly: field('lorebook-order-adjustment-group-only').checked,
        onlyWhenSpeaking: field('lorebook-only-when-speaking').checked,
        randomTrim: Boolean(field(SELECTORS.LOREBOOK_RANDOM_TRIM)?.checked),
        vectorThreshold, vectorThresholdEnabled: rawThreshold !== '',
    };
    if (showBookJev) {
        result.jevExclude = field('stlo-jev-exclude')?.checked === true;
        if (!characterAvatar) result.jevRecall = field('stlo-jev-recall')?.checked === true;
    }
    return result;
}

function changedBookFields(baseline, next) {
    return Object.fromEntries(Object.entries(next).filter(([key, value]) => !baseline || !equalBookSetting(baseline[key], value)));
}

function summarizeBook(root) {
    const priority = Number(bookField(root, SELECTORS.LOREBOOK_PRIORITY_SELECT)?.value) || 3;
    const mode = bookField(root, SELECTORS.LOREBOOK_BUDGET_MODE)?.value || 'default';
    const value = bookField(root, SELECTORS.LOREBOOK_BUDGET_VALUE)?.value || '0';
    const name = translate('Priority', 'stlo.modal.groupOverrides.priority');
    let budget = translate('Shared budget', 'stlo.manager.sharedBudget');
    if (mode === 'fixed') budget = Number(value).toLocaleString() + ' ' + translate('tokens', 'stlo.manager.tokens');
    else if (mode === 'percentage_budget') budget = value + '% ' + translate('of WI budget', 'stlo.manager.wiPercent');
    else if (mode === 'percentage_context') budget = value + '% ' + translate('of context', 'stlo.manager.contextPercent');
    return name + ' ' + priority + ' · ' + budget;
}

function removeModalListeners(listeners) {
    for (const { element, event, handler, capture } of listeners) element.removeEventListener(event, handler, Boolean(capture));
    listeners.length = 0;
}

async function openLorebookSettings(worldName = null) {
    if (EXTENSION_STATE.modalOpen) return;
    EXTENSION_STATE.modalOpen = true;
    const listeners = [];
    const cards = [];
    let alive = true, saving = false, serial = 0;
    try {
        const available = [...new Set((Array.isArray(world_names) ? world_names : []).filter(name => typeof name === 'string' && name.trim()))];
        const context = getContext();
        const characterAvatar = getJevCharacterAvatar(context);
        const linked = context.groupId == null ? getCurrentCharacterLinkedLorebooks() : null;
        const showBookJev = HAS_WORLDINFO_SCAN_DONE && (!characterAvatar || getCharacterJevRecall(characterAvatar) === true);
        const protectInitially = getProtectAlwaysOn();
        const tr = (fallback, key) => translate(fallback, 'stlo.manager.' + key);
        const root = document.createElement('div');
        root.className = 'stlo-modal-ui stlo-book-manager';
        root.innerHTML = `
            <div class="stlo-section stlo-manager-top">
                <div class="stlo-manager-heading">
                    <i class="fa-solid fa-scale-balanced" aria-hidden="true"></i>
                    <h3 data-i18n="stlo.manager.title">Lorebook Ordering for Sloths</h3>
                    <button type="button" class="menu_button stlo-manager-report" data-i18n="stlo.manager.latestCalculation">View latest injection calculation</button>
                </div>
                <div class="stlo-option-line">
                    <label class="checkbox_label stlo-checkrow" for="stlo-manager-protect">
                        <input type="checkbox" id="stlo-manager-protect" ${protectInitially ? 'checked' : ''}>
                        <span class="checkmark"></span><span data-i18n="stlo.budget.protect">Protect always-on entries first</span>
                    </label>
                    ${infoHelp('stlo.budget.protectHelp', 'Applies to all lorebooks. Prioritizes budget, not insertion order.')}
                </div>
                <div class="stlo-option-line">
                    <label class="checkbox_label stlo-checkrow" for="stlo-manager-all">
                        <input type="checkbox" id="stlo-manager-all" ${linked === null ? 'checked disabled' : ''}>
                        <span class="checkmark"></span><span data-i18n="stlo.manager.all">Show all lorebooks</span>
                    </label>
                    ${infoHelp('stlo.manager.filterHelp', 'Changes only the add list, never lorebook connections.')}
                </div>
            </div>
            <div class="stlo-book-cards"></div>
            <small class="stlo-manager-empty" role="status"></small>
            <button type="button" class="menu_button stlo-manager-add"><i class="fa-solid fa-plus" aria-hidden="true"></i><span data-i18n="stlo.manager.add">Add lorebook</span></button>
            <small class="stlo-manager-status" role="status" aria-live="polite"></small>`;
        applyLocale(root);
        const list = root.querySelector('.stlo-book-cards');
        const add = root.querySelector('.stlo-manager-add');
        const showAll = root.querySelector('#stlo-manager-all');
        const protect = root.querySelector('#stlo-manager-protect');
        const status = root.querySelector('.stlo-manager-status');
        const empty = root.querySelector('.stlo-manager-empty');
        const picked = () => new Set(cards.map(card => card.name).filter(Boolean));
        const eligible = () => available.filter(name => showAll.checked || linked === null || linked.has(name));
        const listen = (element, event, handler, bag = listeners) => {
            element.addEventListener(event, handler);
            bag.push({ element, event, handler });
        };
        listen(root.querySelector('.stlo-manager-report'), 'click', () => { void openJevReport(); });
        const updateChoices = () => {
            const taken = picked();
            const names = eligible().filter(name => !taken.has(name));
            for (const card of cards) {
                if (!card.picker || card.name) continue;
                card.picker.replaceChildren(new Option(tr('Choose a lorebook', 'choose'), ''), ...names.map(name => new Option(name, name)));
                card.picker.value = '';
                card.picker.disabled = !names.length;
            }
            const pending = cards.some(card => !card.name || card.loading);
            add.disabled = saving || pending || !names.length;
            add.title = !pending && !names.length
                ? (showAll.checked || linked === null ? tr('All available books are already listed.', 'allAdded') : tr('All linked books are already listed. Enable Show all lorebooks for other books.', 'linkedAdded'))
                : '';
            empty.textContent = !cards.length && !names.length
                ? tr('No lorebooks in this list. Enable Show all lorebooks to see other books.', 'empty')
                : '';
            empty.hidden = !empty.textContent;
        };
        const removeCard = card => {
            removeModalListeners(card.editorListeners);
            removeModalListeners(card.listeners);
            cards.splice(cards.indexOf(card), 1);
            card.element.remove();
            updateChoices();
        };
        const setTitle = card => {
            card.title.textContent = card.name || tr('New lorebook', 'new');
            card.summary.textContent = card.loading ? tr('Loading settings…', 'loading')
                : card.editor ? summarizeBook(card.editor) : tr('Choose a lorebook', 'choose');
            if (card.dirty && card.editor) card.summary.textContent += ' · ' + tr('Modified', 'modified');
        };
        const loadCard = async (card, name) => {
            if (!alive || card.loading || !name || picked().has(name)) return;
            card.name = name;
            card.loading = true;
            card.picker.disabled = true;
            card.remove.disabled = true;
            setTitle(card);
            updateChoices();
            try {
                const data = await loadWorldInfo(name);
                if (!data || typeof data !== 'object') throw Error('Could not load the selected lorebook.');
                if (!alive || !cards.includes(card)) return;
                const settings = { ...DEFAULT_LOREBOOK_SETTINGS, ...structuredClone(data[EXTENSION_NAME] || {}) };
                card.settings = settings;
                const editor = document.createElement('div');
                editor.className = 'stlo-book-editor';
                createBookEditor(editor, settings, characterAvatar, showBookJev, card.prefix);
                card.editor = editor;
                card.body.replaceChildren(editor);
                setupModalBehavior(card.editorListeners, settings, editor);
                card.baseline = readBookSettings(editor, settings, characterAvatar, showBookJev);
                const onEdit = () => { card.dirty = true; setTitle(card); };
                for (const event of ['change', 'input', 'stlo-book-change']) listen(editor, event, onEdit, card.editorListeners);
            } catch (error) {
                console.error('🦥 STLO', '[STLO] Could not open book settings:', name, error);
                if (!alive || !cards.includes(card)) return;
                removeModalListeners(card.editorListeners);
                card.name = '';
                card.editor = null;
                card.body.replaceChildren(card.picker);
                card.picker.disabled = false;
                toastr.error(tr('Could not load lorebook settings.', 'loadFailed') + ' ' + name, slothToastTitle());
            } finally {
                card.loading = false;
                card.remove.disabled = false;
                if (alive && cards.includes(card)) { setTitle(card); updateChoices(); }
            }
        };
        const addCard = (initialName = '') => {
            if (!alive || saving) return;
            const element = document.createElement('section');
            element.className = 'stlo-book-card';
            element.innerHTML = `
                <details class="stlo-book-disclosure" open>
                    <summary><span class="stlo-book-heading"><strong class="stlo-book-title"></strong><small class="stlo-book-summary"></small></span></summary>
                    <div class="stlo-book-body"></div>
                </details>
                <button type="button" class="menu_button stlo-book-remove"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`;
            const body = element.querySelector('.stlo-book-body');
            const picker = document.createElement('select');
            picker.className = 'text_pole textarea_compact stlo-book-picker';
            picker.setAttribute('aria-label', tr('Choose a lorebook', 'choose'));
            body.appendChild(picker);
            const card = {
                element, body, picker, name: '', prefix: 'stlo-book-' + (++serial) + '-',
                title: element.querySelector('.stlo-book-title'),
                summary: element.querySelector('.stlo-book-summary'),
                remove: element.querySelector('.stlo-book-remove'),
                disclosure: element.querySelector('.stlo-book-disclosure'),
                listeners: [], editorListeners: [], loading: false, dirty: false, editor: null,
            };
            card.remove.title = tr('Remove from editor (does not delete the lorebook)', 'remove');
            card.remove.setAttribute('aria-label', card.remove.title);
            cards.push(card);
            list.appendChild(element);
            listen(picker, 'change', () => void loadCard(card, picker.value), card.listeners);
            listen(card.remove, 'click', async () => {
                if (saving || card.loading) return;
                if (card.dirty) {
                    const message = document.createElement('div');
                    message.textContent = tr('Discard unsaved edits to this book and remove its card? The lorebook itself is not deleted.', 'discard');
                    if (await new Popup(message, POPUP_TYPE.CONFIRM, '').show() !== 1) return;
                }
                if (alive && cards.includes(card) && !saving) removeCard(card);
            }, card.listeners);
            setTitle(card);
            updateChoices();
            if (initialName) void loadCard(card, initialName);
            else picker.focus();
            return card;
        };
        listen(showAll, 'change', updateChoices);
        listen(add, 'click', () => { if (!add.disabled) addCard(); });
        const currentBook = getCurrentLorebookName();
        const initial = available.includes(worldName) ? worldName :
            eligible().includes(currentBook) ? currentBook : eligible()[0];
        if (initial) addCard(initial);
        else updateChoices();
        // Prevent changes while async native writes run. The popup stays
        // open on partial failure, with successful cards marked clean.
        const setBusy = value => {
            saving = value;
            list.inert = value;
            for (const control of popup.dlg.querySelectorAll('[data-result]')) control.inert = value;
            protect.disabled = value;
            showAll.disabled = value || linked === null;
            updateChoices();
        };
        const saveAll = async () => {
            if (saving || cards.some(card => card.loading)) return false;
            const jobs = [];
            // Validate every changed card before the first write.
            for (const card of cards) {
                if (!card.editor || !card.dirty) continue;
                const next = readBookSettings(card.editor, card.settings, characterAvatar, showBookJev);
                if (!next) { card.disclosure.open = true; card.element.scrollIntoView({ block: 'nearest' }); return false; }
                const patch = changedBookFields(card.baseline, next);
                if (Object.keys(patch).length) jobs.push({ card, next, patch });
                else { card.dirty = false; setTitle(card); }
            }
            setBusy(true);
            status.textContent = jobs.length ? tr('Saving settings…', 'saving') : '';
            const failed = [];
            let count = 0;
            try {
                for (const { card, next, patch } of jobs) {
                    if (await setLorebookSettings(card.name, patch)) {
                        card.baseline = next;
                        card.settings = { ...card.settings, ...patch };
                        card.dirty = false;
                        count++;
                        setTitle(card);
                    } else failed.push(card);
                }
                if (failed.length) {
                    status.textContent = tr('Saved', 'savedCount') + ': ' + count + ' · ' + tr('Not verified', 'failedCount') + ': ' + failed.map(card => card.name).join(', ');
                    toastr.error(status.textContent, slothToastTitle());
                    failed[0].disclosure.open = true;
                    return false;
                }
                if (protect.checked !== getProtectAlwaysOn()) setProtectAlwaysOn(protect.checked);
                toastr.success(translate('Settings saved.', 'stlo.jev.settingsSaved'), slothToastTitle());
                return true;
            } finally { setBusy(false); }
        };
        const popup = new Popup(root, POPUP_TYPE.CONFIRM, '', {
            okButton: translate('Save Settings', 'stlo.modal.save.ok'),
            cancelButton: translate('Cancel', 'stlo.modal.cancel'),
            wide: false, large: false, allowVerticalScrolling: true,
            onClosing: async closingPopup => {
                if (saving) return false;
                if (closingPopup.result === 1 && !await saveAll()) return false;
                alive = false;
                return true;
            },
        });
        const closed = popup.show();
        setupStloInfoPopups(listeners, root);
        await closed;
    } catch (error) {
        console.error('🦥 STLO', '[STLO] Could not open lorebook manager:', error);
        toastr.error(translate('Could not open lorebook settings.', 'stlo.manager.loadFailed'), slothToastTitle());
    } finally {
        alive = false;
        for (const card of cards) { removeModalListeners(card.editorListeners); removeModalListeners(card.listeners); }
        removeModalListeners(listeners);
        document.getElementById('stlo-info-popup')?.remove();
        EXTENSION_STATE.modalOpen = false;
    }
}

/**
 * Show only one short help popup at a time. Place it directly inside the
 * native popup <dialog>, outside its clipped/scrollable content. A body-level
 * overlay would render *behind* a modal dialog in the browser's top layer.
 * Placement is clamped to the viewport, including narrow mobile screens.
 */
function setupStloInfoPopups(modalEventListeners, modal = document.querySelector('.stlo-modal-ui')) {
    if (!modal) return;

    document.getElementById('stlo-info-popup')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'stlo-info-popup';
    overlay.className = 'stlo-info-popup';
    overlay.hidden = true;
    overlay.setAttribute('role', 'tooltip');
    const popupLayer = modal.closest('dialog') || document.body;
    popupLayer.appendChild(overlay);

    let current = null;
    const hide = () => {
        if (current) {
            current.open = false;
            current.querySelector('summary')?.removeAttribute('aria-describedby');
            current = null;
        }
        overlay.hidden = true;
        overlay.replaceChildren();
    };
    const show = (details, summary) => {
        const content = details.querySelector('.stlo-info-body');
        if (!content) return;
        overlay.replaceChildren(...Array.from(content.childNodes, node => node.cloneNode(true)));
        overlay.hidden = false;
        overlay.style.visibility = 'hidden';

        const bounds = summary.getBoundingClientRect();
        const viewWidth = document.documentElement.clientWidth || window.innerWidth;
        const viewHeight = window.innerHeight;
        const margin = 12;
        const width = Math.min(270, Math.max(1, viewWidth - 2 * margin));
        overlay.style.width = width + 'px';
        const height = overlay.getBoundingClientRect().height;
        const left = Math.max(margin, Math.min(bounds.left, viewWidth - margin - width));
        let top = bounds.bottom + 6;
        if (top + height > viewHeight - margin) {
            top = bounds.top - height - 6;
        }
        if (top < margin) top = margin;
        overlay.style.left = left + 'px';
        overlay.style.top = top + 'px';
        overlay.style.visibility = 'visible';

        details.open = true;
        summary.setAttribute('aria-describedby', overlay.id);
        current = details;
    };
    const onClick = event => {
        if (overlay.contains(event.target)) return;
        const summary = event.target.closest?.('summary');
        const details = summary?.parentElement;
        if (!details?.classList.contains('stlo-info') || !modal.contains(details)) {
            hide();
            return;
        }
        event.preventDefault(); // Native <details> would leave a clipped in-modal popup.
        if (details === current) {
            hide();
        } else {
            hide();
            show(details, summary);
        }
    };
    const onKeyDown = event => {
        if (current && event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            hide();
        }
    };
    // Close on scroll/resize rather than leaving a tooltip over unrelated UI.
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    modalEventListeners.push(
        { element: document, event: 'click', handler: onClick },
        { element: document, event: 'keydown', handler: onKeyDown },
        { element: document, event: 'scroll', handler: hide, capture: true },
        { element: window, event: 'resize', handler: hide },
    );
}

/**
 * Set up interactive behavior for the modal
 * @param {Array} modalEventListeners - Array to track event listeners for cleanup
 * @param {Object} currentSettings - Current lorebook settings
 */
function setupModalBehavior(modalEventListeners = [], currentSettings = {}, root) {
    // Set up order adjustment behavior for main settings
    const orderAdjustmentEnabled = bookField(root, 'lorebook-order-adjustment-enabled');
    const orderAdjustmentContainer = bookField(root, 'lorebook-order-adjustment-container');
    const orderAdjustmentInput = bookField(root, 'lorebook-order-adjustment');

    if (orderAdjustmentEnabled && orderAdjustmentContainer && orderAdjustmentInput) {
        const orderAdjustmentChangeHandler = () => {
            if (orderAdjustmentEnabled.checked) {
                orderAdjustmentContainer.hidden = false;
                if (orderAdjustmentInput.value === '' || orderAdjustmentInput.value === '0') {
                    orderAdjustmentInput.value = '0';
                }
            } else {
                orderAdjustmentContainer.hidden = true;
                orderAdjustmentInput.value = '0';
            }
        };

        // Add input validation handler for order adjustment
        const orderAdjustmentInputHandler = () => {
            const value = parseInt(orderAdjustmentInput.value);
            if (value < -10000) {
                orderAdjustmentInput.value = '-10000';
            } else if (value > 10000) {
                orderAdjustmentInput.value = '10000';
            }
        };

        orderAdjustmentEnabled.addEventListener('change', orderAdjustmentChangeHandler);
        orderAdjustmentInput.addEventListener('input', orderAdjustmentInputHandler);

        modalEventListeners.push(
            { element: orderAdjustmentEnabled, event: 'change', handler: orderAdjustmentChangeHandler },
            { element: orderAdjustmentInput, event: 'input', handler: orderAdjustmentInputHandler }
        );

        // Set initial state
        orderAdjustmentChangeHandler();
    }

    // Set up Budget controls
    setupBudgetControls(modalEventListeners, currentSettings, root);

    setupDrawerBehavior(modalEventListeners, () => setupAdvancedBehavior(modalEventListeners, currentSettings, root), root);
}

/**
 * Set up simple drawer toggle behavior
 * @param {Array} modalEventListeners - Array to track event listeners for cleanup
 */
function setupDrawerBehavior(modalEventListeners = [], mountOverrides, root) {
    const drawer = root.querySelector('.stlo-advanced-drawer');
    if (!drawer) return;
    const onToggle = () => { if (drawer.open) mountOverrides(); };
    drawer.addEventListener('toggle', onToggle);
    modalEventListeners.push({ element: drawer, event: 'toggle', handler: onToggle });
    onToggle();
}

// Render budget controls (mode + value)
function createBudgetControls(scope, currentSettings = {}) {
    const mode = currentSettings.budgetMode || 'default';
    const value = Number(currentSettings.budget) || 0;
    return `
        <div class="stlo-field-heading">
            <h4 data-i18n="stlo.budget.title">Budget</h4>
            <details class="stlo-info">
                <summary aria-label="Show help" data-i18n="[aria-label]stlo.ui.showHelp">i</summary>
                <div class="stlo-info-body">
                    <small data-i18n="stlo.budget.unifiedHelp">Maximum this book can inject. With Jev, this amount is also prioritized for relevant entries.</small>
                    <small data-i18n="stlo.budget.unifiedTip">Unused capacity is shared. All overall budgets still apply.</small>
                    <small data-i18n="stlo.budget.recursionHelp">With recursive scanning, lore excluded from the final prompt can still have activated other lore.</small>
                </div>
            </details>
        </div>
        <div class="stlo-budget-options">
            <select id="${SELECTORS.LOREBOOK_BUDGET_MODE}" class="text_pole textarea_compact">
                <option value="default" ${mode === 'default' ? 'selected' : ''} data-i18n="stlo.budget.mode.default">Use ST World Info Budget (default)</option>
                <option value="percentage_budget" ${mode === 'percentage_budget' ? 'selected' : ''} data-i18n="stlo.budget.mode.percentBudget">% of World Info budget</option>
                <option value="percentage_context" ${mode === 'percentage_context' ? 'selected' : ''} data-i18n="stlo.budget.mode.percentContext">% of Max Context</option>
                <option value="fixed" ${mode === 'fixed' ? 'selected' : ''} data-i18n="stlo.budget.mode.fixed">Fixed tokens</option>
            </select>
            <div id="${SELECTORS.LOREBOOK_BUDGET_VALUE_CONTAINER}" class="stlo-budget-value" style="${mode === 'default' ? 'display:none;' : ''}">
                <div class="stlo-inline-number">
                    <input type="number" id="${SELECTORS.LOREBOOK_BUDGET_VALUE}" class="text_pole textarea_compact"
                           value="${value || 0}" placeholder="0">
                    <details class="stlo-info"><summary aria-label="Help">i</summary><div class="stlo-info-body"><small id="${SELECTORS.LOREBOOK_BUDGET_VALUE_CONTAINER}-hint"></small></div></details>
                </div>
                <div class="stlo-toggle-block">
                    <label class="checkbox_label stlo-checkrow" for="${SELECTORS.LOREBOOK_RANDOM_TRIM}">
                        <input type="checkbox" id="${SELECTORS.LOREBOOK_RANDOM_TRIM}" ${currentSettings.randomTrim ? 'checked' : ''}>
                        <span class="checkmark"></span>
                        <span>${translate('Random trim (drop random entries when over budget)', 'stlo.budget.randomTrim')}</span>
                    </label>
                </div>
            </div>
        </div>
    `;
}

// Wire up budget controls (visibility + clamping)
function setupBudgetControls(modalEventListeners = [], currentSettings = {}, root) {
    const modeSelect = bookField(root, SELECTORS.LOREBOOK_BUDGET_MODE);
    const valueContainer = bookField(root, SELECTORS.LOREBOOK_BUDGET_VALUE_CONTAINER);
    const valueInput = bookField(root, SELECTORS.LOREBOOK_BUDGET_VALUE);
    const hint = bookField(root, `${SELECTORS.LOREBOOK_BUDGET_VALUE_CONTAINER}-hint`);

    if (!modeSelect || !valueContainer || !valueInput) return;

    const applyMode = () => {
        const mode = modeSelect.value;
        if (mode === 'default') {
            valueContainer.style.display = 'none';
            valueInput.value = '0';
            if (hint) hint.textContent = '';
        } else if (mode === 'percentage_budget' || mode === 'percentage_context') {
            valueContainer.style.display = 'flex';
            valueInput.min = '1';
            valueInput.max = '100';
            valueInput.step = '1';
            if (hint) hint.textContent = (mode === 'percentage_budget'
                ? translate('% of World Info budget (1–100)', 'stlo.budget.hint.percentBudget')
                : translate('% of Max Context (1–100)', 'stlo.budget.hint.percentContext'));
            if (valueInput.value === '' || Number(valueInput.value) === 0) valueInput.value = '25';
        } else {
            // fixed
            valueContainer.style.display = 'flex';
            valueInput.min = '1';
            valueInput.removeAttribute('max');
            valueInput.step = '1';
            if (hint) hint.textContent = translate('tokens (>= 1)', 'stlo.budget.hint.fixed');
            if (valueInput.value === '' || Number(valueInput.value) === 0) valueInput.value = '500';
        }
    };

    const clampInput = () => {
        const mode = modeSelect.value;
        let v = parseInt(valueInput.value, 10);
        if (isNaN(v)) v = 0;
        if (mode === 'percentage_budget' || mode === 'percentage_context') {
            if (v < 1) v = 1;
            if (v > 100) v = 100;
        } else if (mode === 'fixed') {
            if (v < 1) v = 1;
        }
        valueInput.value = String(v);
    };

    modeSelect.addEventListener('change', applyMode);
    valueInput.addEventListener('input', clampInput);

    modalEventListeners.push(
        { element: modeSelect, event: 'change', handler: applyMode },
        { element: valueInput, event: 'input', handler: clampInput },
    );

    applyMode();
}

/**
 * Build per-character overrides on first expansion only. Saved keys are the
 * same avatar filenames (without extension) used by the generation path.
 */
function setupAdvancedBehavior(modalEventListeners = [], currentSettings = {}, root) {
    const container = bookField(root, 'advanced-priority-sections');
    const add = bookField(root, 'stlo-group-add-character');
    if (!container || !add || container.dataset.mounted === 'true') return;
    const stored = currentSettings.characterOverrides || {};
    const roster = new Map();
    for (const character of getContext()?.characters || []) {
        const key = character?.avatar?.replace(/\.[^/.]+$/, '') || character?.name || '';
        if (key && !roster.has(key)) roster.set(key, character?.name || key);
    }
    // Preserve overrides for temporarily missing/deleted characters. They can
    // still be removed explicitly, but never disappear merely by opening UI.
    for (const key of Object.keys(stored)) {
        if (!roster.has(key)) roster.set(key, key + ' (' + translate('Not in character list', 'stlo.modal.groupOverrides.missing') + ')');
    }
    const counts = new Map();
    for (const name of roster.values()) counts.set(name, (counts.get(name) || 0) + 1);
    const rows = () => [...container.querySelectorAll('.stlo-group-card')];
    const selectedKeys = () => new Set(rows().map(row => row.querySelector('.stlo-group-character').value).filter(Boolean));
    const syncChoices = () => {
        const selected = selectedKeys();
        const currentRows = rows();
        for (const row of currentRows) {
            const select = row.querySelector('.stlo-group-character');
            for (const option of select.options) {
                option.disabled = option.value === '' || (option.value !== select.value && selected.has(option.value));
            }
        }
        // Finish an empty card before adding another; never create five
        // empty priority groups, and do not re-render existing cards.
        add.disabled = currentRows.some(row => !row.querySelector('.stlo-group-character').value)
            || ![...roster.keys()].some(key => !selected.has(key));
    };
    let serial = 0;
    const addCard = (key = '', saved = {}) => {
        const card = document.createElement('div');
        card.className = 'stlo-group-card';
        const id = root.dataset.stloPrefix + 'group-' + (++serial);
        card.innerHTML = `
            <div class="stlo-group-card-head">
                <label for="${id}-character" data-i18n="stlo.modal.groupOverrides.character">Character</label>
                <button type="button" class="menu_button stlo-group-remove"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
            </div>
            <select id="${id}-character" class="text_pole textarea_compact stlo-group-character"></select>
            <div class="stlo-group-priority">
                <label for="${id}-priority" data-i18n="stlo.modal.groupOverrides.priority">Priority</label>
                <select id="${id}-priority" class="text_pole textarea_compact stlo-group-priority-select"></select>
            </div>
            <div class="stlo-group-adjust-row">
                <div class="stlo-option-line">
                    <label class="checkbox_label stlo-checkrow" for="${id}-enabled">
                        <input type="checkbox" id="${id}-enabled" class="stlo-group-adjust-enabled">
                        <span class="checkmark"></span>
                        <span data-i18n="stlo.modal.order.enableLabel">Enable Order Adjustment</span>
                    </label>
                    ${infoHelp('stlo.modal.order.explain', 'Higher values process first. Range: -10000 to +10000.')}
                </div>
                <input type="number" id="${id}-adjustment" class="text_pole textarea_compact stlo-group-adjustment" min="-10000" max="10000" step="1" value="0">
            </div>`;
        const select = card.querySelector('.stlo-group-character');
        select.add(new Option(translate('Select a character', 'stlo.modal.groupOverrides.characterPlaceholder'), ''));
        for (const [value, name] of roster) {
            select.add(new Option(counts.get(name) > 1 && name !== value ? name + ' (' + value + ')' : name, value));
        }
        select.value = key;
        const priority = card.querySelector('.stlo-group-priority-select');
        for (const value of [5, 4, 3, 2, 1]) priority.add(new Option(value + ' - ' + getPriorityName(value), String(value)));
        const base = Number(bookField(root, SELECTORS.LOREBOOK_PRIORITY_SELECT)?.value);
        const validPriority = value => Number.isInteger(value) && value >= 1 && value <= 5;
        const savedPriority = Number(saved?.priority);
        priority.value = String(validPriority(savedPriority) ? savedPriority : validPriority(base) ? base : 3);
        const enabled = card.querySelector('.stlo-group-adjust-enabled');
        const adjustment = card.querySelector('.stlo-group-adjustment');
        const offset = Number(saved?.orderAdjustment) || 0;
        adjustment.value = String(offset);
        enabled.checked = offset !== 0;
        adjustment.hidden = !enabled.checked;
        adjustment.setAttribute('aria-label', translate('Order Adjustment', 'stlo.modal.order.title'));
        const remove = card.querySelector('.stlo-group-remove');
        remove.title = translate('Remove character', 'stlo.modal.groupOverrides.remove');
        remove.setAttribute('aria-label', remove.title);
        container.appendChild(card);
        applyLocale(card);
        return card;
    };
    // One delegated listener per event; removing a card releases its DOM.
    const onChange = event => {
        if (event.target.matches('.stlo-group-character')) syncChoices();
        else if (event.target.matches('.stlo-group-adjust-enabled')) {
            const input = event.target.closest('.stlo-group-card').querySelector('.stlo-group-adjustment');
            input.hidden = !event.target.checked;
            if (!event.target.checked) input.value = '0';
        }
    };
    const onClick = event => {
        const button = event.target.closest('.stlo-group-remove');
        if (!button) return;
        button.closest('.stlo-group-card').remove();
        syncChoices();
        root.dispatchEvent(new Event('stlo-book-change'));
    };
    const onAdd = () => {
        if (add.disabled) return;
        const card = addCard();
        syncChoices();
        root.dispatchEvent(new Event('stlo-book-change'));
        card.querySelector('.stlo-group-character').focus();
    };
    for (const [key, value] of Object.entries(stored)) addCard(key, value);
    for (const [element, event, handler] of [[container, 'change', onChange], [container, 'click', onClick], [add, 'click', onAdd]]) {
        element.addEventListener(event, handler);
        modalEventListeners.push({ element, event, handler });
    }
    container.dataset.mounted = 'true';
    syncChoices();
}

/** Preserve the existing override map and any additional per-character fields. */
function getCharacterOverrides(root, existing = {}) {
    const container = bookField(root, 'advanced-priority-sections');
    if (container?.dataset.mounted !== 'true') return existing;
    const overrides = new Map();
    for (const row of container.querySelectorAll('.stlo-group-card')) {
        const key = row.querySelector('.stlo-group-character').value;
        if (!key) {
            toastr.error(translate('Select a character or remove the empty card.', 'stlo.modal.groupOverrides.emptyCard'), slothToastTitle());
            return null;
        }
        if (overrides.has(key)) {
            toastr.error(translate('Choose each character only once.', 'stlo.modal.groupOverrides.duplicate'), slothToastTitle());
            return null;
        }
        const priority = Number(row.querySelector('.stlo-group-priority-select').value);
        const enabled = row.querySelector('.stlo-group-adjust-enabled').checked;
        const raw = row.querySelector('.stlo-group-adjustment').value;
        const orderAdjustment = enabled ? Number(raw) : 0;
        if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
            toastr.error(translate('Priority value must be between 1 and 5', 'stlo.validation.priorityRange'), slothToastTitle());
            return null;
        }
        if ((enabled && !raw.trim()) || !Number.isInteger(orderAdjustment) || orderAdjustment < -10000 || orderAdjustment > 10000) {
            toastr.error(translate('Order adjustment must be between -10000 and 10000', 'stlo.validation.orderAdjustmentRange'), slothToastTitle());
            return null;
        }
        overrides.set(key, { ...(Object.hasOwn(existing, key) ? existing[key] : {}), priority, orderAdjustment });
    }
    return Object.fromEntries(overrides);
}

/**
 * Get priority level name for display
 * @param {number} priority - Priority level (1-5)
 * @returns {string} Priority name
 */
function getPriorityName(priority) {
    const names = {
        5: translate('Highest', 'stlo.priority.name.5'),
        4: translate('High', 'stlo.priority.name.4'),
        3: translate('Normal', 'stlo.priority.name.3'),
        2: translate('Low', 'stlo.priority.name.2'),
        1: translate('Lowest', 'stlo.priority.name.1')
    };
    return names[priority] || 'Unknown';
}

/**
 * Apply priority ordering to all entries
 * @param {Object} eventData - Contains globalLore, characterLore, chatLore, personaLore arrays
 */
async function applyPriorityOrdering(eventData) {
    try {
        if (!eventData || typeof eventData !== 'object') return;

        const gl = Array.isArray(eventData.globalLore) ? eventData.globalLore : (eventData.globalLore = []);
        const cl = Array.isArray(eventData.characterLore) ? eventData.characterLore : (eventData.characterLore = []);
        const chat = Array.isArray(eventData.chatLore) ? eventData.chatLore : (eventData.chatLore = []);
        const persona = Array.isArray(eventData.personaLore) ? eventData.personaLore : (eventData.personaLore = []);

        const allEntries = [...gl, ...cl, ...chat, ...persona];

        // Prefetch settings once per unique world
        const settingsCache = new Map();
        const uniqueWorlds = [];
        const seen = new Set();
        for (const e of allEntries) {
            const w = e?.world;
            if (w && !seen.has(w)) {
                seen.add(w);
                uniqueWorlds.push(w);
            }
        }
        if (uniqueWorlds.length) {
            await Promise.all(
                uniqueWorlds.map(async (w) => {
                    const s = await getLorebookSettings(w);
                    settingsCache.set(w, s || {});
                })
            );
        }

        // Reuse these small settings objects during subsequent scan passes.
        // Avoid reading/cloning a lorebook's settings again for every loop.
        EXTENSION_STATE.scanWorldSettings = settingsCache;
        const budgetWorlds = new Set();
        for (const [world, settings] of settingsCache) {
            const configured = (mode, value) => mode && mode !== 'default' && Number(value) > 0;
            const override = EXTENSION_STATE.currentSpeakingCharacter && settings?.characterOverrides?.[EXTENSION_STATE.currentSpeakingCharacter];
            if (configured(settings?.budgetMode, settings?.budget)
                || configured(override?.budgetMode, override?.budget)) {
                budgetWorlds.add(world);
            }
        }
        EXTENSION_STATE.scanBudgetWorlds = budgetWorlds;
        EXTENSION_STATE.scanHasExplicitBudgets = budgetWorlds.size > 0;

        const arrays = [gl, cl, chat, persona];
        const speaker = EXTENSION_STATE.currentSpeakingCharacter;
        const effective = entry => {
            const settings = settingsCache.get(entry?.world) || {};
            const override = speaker && settings.characterOverrides?.[speaker];
            return {
                priority: override?.priority ?? settings.priority ?? PRIORITY_LEVELS.DEFAULT,
                adjustment: settings.orderAdjustmentGroupOnly && !speaker
                    ? 0 : (override?.orderAdjustment ?? settings.orderAdjustment ?? 0),
            };
        };
        let skippedOnlyWhenSpeaking = 0;
        let customOrder = false;
        for (const list of arrays) {
            let write = 0;
            for (const entry of list) {
                const settings = settingsCache.get(entry?.world) || {};
                if (settings.onlyWhenSpeaking && speaker && !Object.hasOwn(settings.characterOverrides || {}, speaker)) {
                    skippedOnlyWhenSpeaking++;
                    continue;
                }
                const { priority, adjustment } = effective(entry);
                if (Number(priority) !== PRIORITY_LEVELS.DEFAULT || Number(adjustment) !== 0) customOrder = true;
                list[write++] = entry;
            }
            list.length = write;
        }
        const run = jevGeneration;
        const protect = HAS_WORLDINFO_SCAN_DONE && getProtectAlwaysOn();
        const managed = HAS_WORLDINFO_SCAN_DONE && run?.enabled && isCurrentJev(run)
            ? getJevWorlds(settingsCache, run.characterRecall) : new Set();
        // Bypass native early budget admission only for constants whose
        // priority was explicitly requested, or whose Jev share needs to
        // be counted first. The structured scan hook re-applies the caps.
        // Do not change the entry's order, activation flags or saved data.
        if (protect || managed.size) {
            for (const list of arrays) for (const entry of list) {
                if (entry.constant === true && !entry.disable && !entry.ignoreBudget
                    && (protect || managed.has(entry.world))) {
                    entry.__stloReservedConstant = true;
                    entry.ignoreBudget = true;
                }
            }
        }
        // Only an explicit effective priority/adjustment requests source
        // consolidation. Filtering and budget protection leave native
        // chat/persona/global/character precedence and order intact.
        if (!customOrder) return;
        const processedEntries = arrays.flat();
        for (const entry of processedEntries) {
            const { priority, adjustment } = effective(entry);
            entry.order = Number(priority) * 10000 + Number(adjustment) + Math.min(entry.order ?? 100, 9999);
        }
        processedEntries.sort((a,b) => b.order-a.order || (a.uid??0)-(b.uid??0) || String(a.world??'').localeCompare(String(b.world??'')));
        for (const list of arrays) list.length = 0;
        gl.push(...processedEntries);
        if (DEBUG_STLO) {
            stloDebug('applyPriorityOrdering summary:', { processed: processedEntries.length, skippedOnlyWhenSpeaking });
        }
    } catch (error) {
        console.error('🦥 STLO', 'Error applying priority ordering:', error);
    }
}

// Extension initialization
async function init() {
    const initializeExtension = async () => {
        try {
            // Initialize extension
            const context = getContext();
            if (!context) {
                throw new Error('Failed to get SillyTavern context');
            }

            setupEventHandlers();
            await loadStloLocale();
            addLorebookBudgetMenuItem();
            installStloModalStyles();
            installPerLorebookVectorThresholds();
            registerStloSlashCommand();
            registerBudgetEnforcementHandlers();
            // Register per-loop trimmer only on newer branches
            if (HAS_WORLDINFO_SCAN_DONE) {
                registerPerLoopBudgetTrimmer();
            } else {
                console.warn('🦥 STLO', '[STLO] This SillyTavern version lacks WORLDINFO_SCAN_DONE. Per-book budget trimming is unavailable without unsafe prompt edits.');
            }

        } catch (error) {
            console.error('🦥 STLO', 'Failed to load STLO extension:', error);
        }
    };

    // Wait for SillyTavern to be ready
    eventSource.once(event_types.APP_READY, initializeExtension);
}

init();

// ================== STLO: Per-lorebook Budget Markers & Trimming ==================

/**
 * Discard generation-only caches. Neither the final prompt nor other
 * extensions' messages need to be edited to apply scan-time budget decisions.
 */
function resetBudgetState() {
    EXTENSION_STATE.scanWorldSettings = new Map();
    EXTENSION_STATE.scanBudgetWorlds = new Set();
    EXTENSION_STATE.scanHasExplicitBudgets = false;
    TOKEN_COUNT_CACHE = new WeakMap();
}

// Compute total World Info budget (tokens) from base ST config
function calculateTotalWIBudget(contextSize = null) {
    try {
        const usableContext = Number(contextSize ?? (typeof getMaxContextSize === 'function' ? getMaxContextSize() : 0));
        if (!Number.isFinite(usableContext) || usableContext <= 0) {
            return 0; // no trimming without a valid prevailing context
        }

        const wiPercent = (typeof world_info_budget === 'number' && world_info_budget > 0) ? world_info_budget : 25;
        let totalBudget = Math.round(usableContext * (wiPercent / 100));

        const cap = (typeof world_info_budget_cap === 'number' && world_info_budget_cap > 0) ? world_info_budget_cap : 0;
        if (cap > 0 && totalBudget > cap) totalBudget = cap;

        return (Number.isFinite(totalBudget) && totalBudget > 0) ? totalBudget : 0;
    } catch (e) {
        console.warn('🦥 STLO', '[STLO] calculateTotalWIBudget error:', e);
        return 0;
    }
}

// Resolve per-lorebook token budget by mode (default | %budget | %context | fixed)
// Applies character-specific overrides when present
async function calculateLorebookBudget(settings, totalBudget, contextSize = null) {
    try {
        const usableContext = Number(contextSize ?? (typeof getMaxContextSize === 'function' ? getMaxContextSize() : 0));

        let budgetMode = settings?.budgetMode || 'default';
        let budgetValue = Number(settings?.budget || 0) || 0;

        // Apply character override if present
        if (EXTENSION_STATE.currentSpeakingCharacter && settings?.characterOverrides) {
            const override = settings.characterOverrides[EXTENSION_STATE.currentSpeakingCharacter];
            if (override && override.budgetMode && override.budgetMode !== 'default') {
                budgetMode = override.budgetMode;
                budgetValue = Number(override.budget || 0) || 0;
            }
        }

        switch (budgetMode) {
            case 'percentage_context':
                if (budgetValue >= 1 && budgetValue <= 100) {
                    return Math.floor((budgetValue / 100) * usableContext);
                }
                break;
            case 'percentage_budget':
                if (budgetValue >= 1 && budgetValue <= 100) {
                    return Math.floor((budgetValue / 100) * totalBudget);
                }
                break;
            case 'fixed':
                if (budgetValue > 0) {
                    return budgetValue;
                }
                break;
            default:
                break;
        }

        // default mode → no per-lorebook limit; defer to SillyTavern's global WI handling
        return 0;
    } catch (e) {
        console.warn('🦥 STLO', '[STLO] calculateLorebookBudget error:', e);
        return 0;
    }
}

/**
 * Only generation lifecycle reset handlers are necessary here.
 * The structural WorldInfo scan event owns per-lorebook trimming when present.
 * On older core versions there is no safe structured opportunity to trim a
 * selected entry; never rewrite arbitrary system prompt text by substring.
 */
function registerBudgetEnforcementHandlers() {
    try {
        if (EXTENSION_STATE.budgetHandlersRegistered) return;

        const resetGen = resetBudgetState;
        eventSource.on(event_types.GENERATION_ENDED, resetGen);
        eventListeners.push({ source: eventSource, event: event_types.GENERATION_ENDED, handler: resetGen });

        const resetChat = resetBudgetState;
        eventSource.on(event_types.CHAT_CHANGED, resetChat);
        eventListeners.push({ source: eventSource, event: event_types.CHAT_CHANGED, handler: resetChat });

        EXTENSION_STATE.budgetHandlersRegistered = true;
    } catch (e) {
        console.warn('🦥 STLO', '[STLO] Failed to register budget reset handlers:', e);
    }
}

/**
 * Trim only the structured activated-entry Map *before* SillyTavern builds the
 * final prompt. Never perform substring replacement on generated prompt text:
 * identical bodies can belong to different lore entries or unrelated prompts.
 *
 * This also reconciles total WI budget when constants are temporarily marked
 * ignoreBudget to bypass the native Sticky-before-Order scan preference.
 */
function registerPerLoopBudgetTrimmer() {
    try {
        const onScanDone = async (args) => {
            try {
                const run = jevGeneration;
                if (run?.preview && isCurrentJev(run)) {
                    for (const entry of args?.new?.all ?? []) {
                        if (entry?.world && entry.uid != null) run.preview.candidates.add(jevEntryKey(entry));
                    }
                    return;
                }
                const entries = args?.activated?.entries;
                if (!(entries instanceof Map) || entries.size === 0) {
                    if(run&&isCurrentJev(run)&&args?.state?.next===0&&(run.enabled||EXTENSION_STATE.scanHasExplicitBudgets)){
                        const total=Number(args?.budget?.current)||calculateTotalWIBudget(run.selection?.contextSize);
                        for(const [world,settings] of EXTENSION_STATE.scanWorldSettings)run.metrics.limits.set(world,await calculateLorebookBudget(settings,total,run.selection?.contextSize));
                        stageScanMetrics(run,[],()=>false);
                    }
                    if (run?.selection && args?.state?.next === 0) recordJevActivated([],true);
                    return;
                }

                const protect = getProtectAlwaysOn();
                const jev = jevGeneration?.selection;
                const settingsCache = EXTENSION_STATE.scanWorldSettings;
                let reserved = false;
                let hasUnknownWorld = false;
                let hasTemporaryOrder = false;
                for (const entry of entries.values()) {
                    if (Object.hasOwn(entry, '__stloJevInsertionOrder')) hasTemporaryOrder = true;
                    if (entry.__stloReservedConstant === true || entry.__stloReservedJev === true) reserved = true;
                    if (entry?.world && !settingsCache.has(entry.world)) hasUnknownWorld = true;
                }
                const finishOrder = () => {
                    if (args?.state?.next !== 0) return;
                    for (const entry of entries.values()) {
                        if (Object.hasOwn(entry, '__stloJevInsertionOrder')) entry.order = entry.__stloJevInsertionOrder;
                        delete entry.__stloJevInsertionOrder;
                        if (entry.__stloReservedConstant || entry.__stloReservedJev) entry.ignoreBudget = false;
                        delete entry.__stloReservedConstant;
                        delete entry.__stloReservedJev;
                    }
                };
                if (!reserved && !EXTENSION_STATE.scanHasExplicitBudgets && !hasUnknownWorld && !jev?.worlds.size) {
                    if (hasTemporaryOrder) finishOrder();
                    return;
                }

                const nativeBudget = Number(args?.budget?.current);
                const totalBudget = Number.isFinite(nativeBudget) && nativeBudget > 0
                    ? nativeBudget : calculateTotalWIBudget();
                const byWorld = new Map();
                for (const [key, entry] of entries) {
                    if (!entry?.world) continue;
                    if (!byWorld.has(entry.world)) byWorld.set(entry.world, []);
                    byWorld.get(entry.world).push({ key, entry });
                }

                let dropped = 0;
                const scanEntries = new Map();
                const sourceRank = new Map();
                for (const [index, entry] of (args?.sortedEntries || []).entries()) {
                    const key = jevEntryKey(entry);
                    scanEntries.set(key, entry);
                    sourceRank.set(key, index);
                }
                const countBudgetTokens = async entry => {
                    const count = await countBudgetEntry(entry);
                    if (!Number.isFinite(count) || count < 0 || (count === 0 && String(entry.content ?? '').trim())) return Infinity;
                    return count;
                };
                const discard = ({ key, entry },reason) => {
                    if (!entries.has(key)) return;
                    entries.delete(key);
                    if(run?.metrics&&reason&&isCurrentJev(run))run.metrics.trims.set(jevEntryKey(entry),reason);
                    entry.disable = true; // Keep a dropped entry out of recursion rescans.
                    const original = scanEntries.get(jevEntryKey(entry));
                    if (original) original.disable = true;
                    dropped++;
                };
                const orderDescending = (a, b) => (b.entry.order ?? 100) - (a.entry.order ?? 100);
                const nativeOrder = (a,b) => (sourceRank.get(jevEntryKey(a.entry)) ?? Infinity)
                    - (sourceRank.get(jevEntryKey(b.entry)) ?? Infinity) || orderDescending(a,b);
                const recallOrder = (a, b) => {
                    const aRank = jev?.accepted.get(jevEntryKey(a.entry));
                    const bRank = jev?.accepted.get(jevEntryKey(b.entry));
                    return (aRank ?? -1) - (bRank ?? -1) || orderDescending(a, b);
                };
                const originallyIgnored = e =>
                    e.ignoreBudget === true && e.__stloReservedConstant !== true && e.__stloReservedJev !== true;

                // Preserve ordinary per-book ordering. Spend the remaining
                // budget on Jev picks in relevance order.
                if (EXTENSION_STATE.scanHasExplicitBudgets || hasUnknownWorld) {
                    for (const [world, list] of byWorld) {
                        if (settingsCache.has(world) && !EXTENSION_STATE.scanBudgetWorlds.has(world)) {
                            continue; // A default-budget book needs no trimming.
                        }
                        const settings = settingsCache.get(world) ?? await getLorebookSettings(world);
                        const perBudget = await calculateLorebookBudget(settings, totalBudget, jev?.contextSize);
                        if(run?.metrics&&isCurrentJev(run))run.metrics.limits.set(world,perBudget);
                        if (!(perBudget > 0)) continue;

                        const native = [];
                        const selected = [];
                        for (const item of list) {
                            const target = jev?.accepted.has(jevEntryKey(item.entry)) ? selected : native;
                            target.push(item);
                        }
                        let sorted;
                        if (protect || jev?.worlds.has(world)) {
                            const always = native.filter(x => x.entry.constant === true).sort(orderDescending);
                            const optional = native.filter(x => x.entry.constant !== true);
                            if (settings.randomTrim) shuffleInPlace(optional);
                            else optional.sort(orderDescending);
                            sorted = [...always, ...optional];
                        } else {
                            sorted = native;
                            if (settings.randomTrim) shuffleInPlace(sorted);
                            else sorted.sort(orderDescending);
                        }
                        sorted.push(...selected.sort(recallOrder));

                        let used = 0;
                        for (const item of sorted) {
                            if (originallyIgnored(item.entry)) continue;
                            const tokens = await countBudgetTokens(item.entry);
                            if (used + tokens <= perBudget) used += tokens;
                            else discard(item,'book');
                        }
                    }
                }

                if (jev?.worlds.size) {
                    const constants = [], native = [], selected = [];
                    for (const [key, entry] of entries) {
                        if (!jev.worlds.has(entry.world) || entry.outletName || Number(entry.position) === 7) continue;
                        const item = { key, entry };
                        if (entry.constant === true) constants.push(item);
                        else if (jev.accepted.has(jevEntryKey(entry))) selected.push(item);
                        else native.push(item);
                    }
                    let used = 0;
                    for (const item of [...constants.sort(nativeOrder), ...native.sort(nativeOrder), ...selected.sort(recallOrder)]) {
                        const tokens = await countBudgetTokens(item.entry);
                        if (used + tokens <= jev.budget) used += tokens;
                        else discard(item,'jev');
                    }
                }

                // Reconcile the shared native budget whenever an activated
                // entry temporarily bypassed its early budget check.
                if (reserved && totalBudget > 0) {
                    const timed = args?.timedEffects;
                    // Cache the native Sticky status once per active entry.
                    // Calling isEffectActive inside sort() would repeatedly scan
                    // the sticky-effect buffer for every comparison.
                    const active = [...entries].map(([key, entry]) => {
                        let sticky = 0;
                        if (!protect || entry.constant !== true) {
                            try { sticky = timed?.isEffectActive?.('sticky', entry) ? 1 : 0; }
                            catch { /* Keep the original Order fallback. */ }
                        }
                        return { key, entry, sticky };
                    });
                    active.sort((a, b) => {
                        if (protect && (a.entry.constant === true) !== (b.entry.constant === true)) {
                            return a.entry.constant === true ? -1 : 1;
                        }
                        const stickyDiff = b.sticky - a.sticky;
                        if (stickyDiff) return stickyDiff;
                        // Core source precedence remains intact for native
                        // entries. Score ordering of Jev picks is enforced
                        // by their own cap and native admission slots.
                        return nativeOrder(a,b);
                    });
                    let used = 0;
                    for (const item of active) {
                        if (originallyIgnored(item.entry)) continue;
                        const tokens = await countBudgetTokens(item.entry);
                        if (used + tokens <= totalBudget) used += tokens;
                        else discard(item,'world');
                    }
                }

                // The core builds the final prompt from activated.entries.
                // All native activation, recursion and budget decisions used
                // full text. Only now may the separate opt-in excerpt replace
                // a generation-local copy; never edit activated.text or books.
                if(run&&isCurrentJev(run)&&args?.state?.next===0&&(run.enabled||EXTENSION_STATE.scanHasExplicitBudgets||reserved)){
                    for(const [world,settings] of settingsCache){
                        if(!run.metrics.limits.has(world)||EXTENSION_STATE.scanBudgetWorlds.has(world))
                            run.metrics.limits.set(world,await calculateLorebookBudget(settings,totalBudget,jev?.contextSize));
                    }
                    stageScanMetrics(run,entries.values(),originallyIgnored);
                }
                finishOrder();
                if (dropped) stloDebug('Trimmed WI entries structurally:', dropped);
                if (run?.selection && args?.state?.next === 0 && isCurrentJev(run)) {
                    if(jev?.excerpts?.size){
                        const {applied,savedChars}=applyJevExcerpts(entries,jev.accepted,jev.excerptAppliedKeys,jev.excerpts);
                        updateJevReport(run,{partialApplied:applied,partialSavedChars:savedChars});
                    }
                    recordJevActivated([...entries.values()],true);
                }
            } catch (e) {
                console.warn('🦥 STLO', '[STLO] per-loop budget trimmer error:', e);
            }
        };

        eventSource.on(event_types.WORLDINFO_SCAN_DONE, onScanDone);
        eventListeners.push({ source: eventSource, event: event_types.WORLDINFO_SCAN_DONE, handler: onScanDone });
    } catch (e) {
        console.warn('🦥 STLO', '[STLO] Failed to register per-loop budget trimmer:', e);
    }
}
