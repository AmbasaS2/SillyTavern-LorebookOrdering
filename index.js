import { event_types, eventSource } from '../../../events.js';
import { getTokenCountAsync } from '../../../tokenizers.js';
import { getStringHash, getCharaFilename } from '../../../utils.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { characters, this_chid, getCurrentChatId, getMaxContextSize, getRequestHeaders, saveSettingsDebounced, stopGeneration, getCharacterCardFields } from '../../../../script.js';
import { loadWorldInfo, saveWorldInfo, worldInfoCache, world_info, world_info_character_strategy, world_info_insertion_strategy, world_info_budget, world_info_budget_cap, world_names, selected_world_info, METADATA_KEY, getSortedEntries, checkWorldInfo, world_info_include_names } from '../../../world-info.js';
import { power_user } from '../../../power-user.js';
import { NOTE_MODULE_NAME } from '../../../authors-note.js';
import { POPUP_TYPE, Popup } from '../../../popup.js';
import { addLocaleData, getCurrentLocale, translate, t, applyLocale } from '../../../i18n.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { applyJevRecall, fitJevRecall, getNanoJevConnection, jevEntryKey, normalizeJevBudget, prepareJevRecall, requestJevRecall, getJevWorlds, normalizeJevOptions, planJevRequests, splitJevBatch, rankJevDecisions, JEV_PRESETS, isJevCandidate } from './jevRecall.mjs';

import { createJevPromptLibrary, mountJevPromptLibrary } from './jevPromptLibrary.mjs';

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
// Defaults ON to preserve the current fork's ordering; users may disable it.
function getProtectAlwaysOn() {
    return extension_settings[EXTENSION_NAME]?.protectAlwaysOn !== false;
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
    return run === jevGeneration && !run.controller.signal.aborted && run.chatId === getCurrentChatId();
}

function getJevOptions() {
    return normalizeJevOptions(extension_settings[EXTENSION_NAME]?.jevOptions ?? {});
}

// A bounded, ephemeral report; never retain prompts, credentials or lore text.
function updateJevReport(run, changes = {}) {
    if (!run || run !== jevGeneration || run.chatId !== getCurrentChatId()) return;
    const previousPhase = run.report?.phase;
    run.report = { ...run.report, ...changes, elapsedMs: Math.round(performance.now() - run.startedAt) };
    lastJevReport = { chatId: run.chatId, ...run.report };
    try {
        if (previousPhase !== run.report.phase) syncJevTopBar();
    } catch (error) { stloDebug('Jev report UI:', error); }
}
function currentJevReport() {
    return lastJevReport?.chatId === getCurrentChatId() ? lastJevReport : null;
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
function openJevReport() {
    const report = currentJevReport();
    const panel = document.createElement('div');
    const heading = document.createElement('h3');
    heading.textContent = translate('Latest Jev recall', 'stlo.jev.report');
    panel.append(heading);
    const fields = report ? [
        [translate('Status', 'stlo.jev.status'), jevStatusLabel(report.phase)],
        [translate('Candidates', 'stlo.jev.candidates'), report.candidates],
        [translate('Model selected', 'stlo.jev.selected'), report.selected],
        [translate('Within budget', 'stlo.jev.accepted'), report.accepted],
        [translate('Actually activated', 'stlo.jev.injected'), report.injected],
        [translate('Book budget rejected', 'stlo.jev.rejectedBook'), report.rejectedBook],
        [translate('Jev budget rejected', 'stlo.jev.rejectedJev'), report.rejectedJev],
        [translate('World Info budget rejected', 'stlo.jev.rejectedWorld'), report.rejectedWorld],
        [translate('Jev requests', 'stlo.jev.requests'), report.requests],
        [translate('Planned batches', 'stlo.jev.plannedBatches'), report.plannedBatches],
        [translate('Completed batches', 'stlo.jev.completedBatches'), report.completedBatches],
        [translate('Unassessed candidates', 'stlo.jev.unassessed'), report.unassessed],
        [translate('Shared background entries', 'stlo.jev.sharedEntries'), report.sharedEntries],
        [translate('Messages shortened by reading limit', 'stlo.jev.truncatedMessages'), report.truncatedMessages],
        [translate('Lore entries shortened by reading limit', 'stlo.jev.truncatedLore'), report.truncatedLore],
        [translate('Estimated input tokens (attempted requests)', 'stlo.jev.estimatedInputTokens'), report.estimatedInputTokens],
        [translate('Reported input tokens (successful requests)', 'stlo.jev.actualInputTokens'), report.actualInputTokens],
        [translate('Batches reporting token usage', 'stlo.jev.usageReportedBatches'), report.usageReportedBatches],
        [translate('Request characters (not tokens)', 'stlo.jev.inputChars'), report.inputChars],
        [translate('Request time (ms)', 'stlo.jev.requestMs'), report.requestMs],
        [translate('Elapsed time (ms)', 'stlo.jev.elapsedMs'), report.elapsedMs],
    ] : [[translate('Status', 'stlo.jev.status'), jevStatusLabel()]];
    for (const [name, value] of fields) {
        if (value === undefined) continue;
        const line = document.createElement('div');
        line.textContent = name + ': ' + value;
        panel.append(line);
    }
    if (report?.error) {
        const line = document.createElement('p');
        line.textContent = report.error;
        panel.append(line);
    }
    return new Popup(panel, POPUP_TYPE.TEXT, '', { okButton: translate('Close', 'stlo.jev.close'), leftAlign: true }).show();
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
        button.className = 'fa-solid fa-brain fa-fw right_menu_button';
        button.tabIndex = 0;
        button.setAttribute('role', 'button');
        button.addEventListener('click', () => { void openJevReport(); });
        button.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                void openJevReport();
            }
        });
        bar.append(button);
    }
    const label = 'Jev · ' + jevStatusLabel(report.phase);
    if (button.title !== label) button.title = label;
    if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
    if (button.dataset.status !== report.phase) button.dataset.status = report.phase;
}

function clearVectorPrompts(context) {
    delete context.extensionPrompts?.['3_vectors'];
    delete context.extensionPrompts?.['4_vectors_data_bank'];
}

function guardNativeVectorInterceptor() {
    const interceptor = globalThis.vectors_rearrangeChat;
    if (typeof interceptor !== 'function') return false;
    if (interceptor === guardedVectorInterceptor) return true;
    guardedVectorInterceptor = async function (chat, contextSize, abort, type) {
        const run = jevGeneration;
        if (run?.enabled && isCurrentJev(run) && run.options.mode === 'all') {
            clearVectorPrompts(getContext());
            return;
        }
        nativeVectorPasses++;
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
    if (run?.selection && run.report.phase === 'ready') recordJevActivated([]);
    stopJevGeneration();
}
function onJevStopped() {
    if (jevGeneration?.enabled && jevGeneration.report?.phase !== 'cancelled') {
        updateJevReport(jevGeneration, { phase: 'cancelled' });
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
        updateJevReport(run, { phase: 'preparing', mode: run.options.mode });
        const nativeAvailable = hasEnabledVectorRecall() && guardNativeVectorInterceptor();
        if (run.options.mode === 'all') clearVectorPrompts(getContext());
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
    pendingAnimationFrame: null,
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
        console.info('[STLO][DEBUG]', ...args);
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
    const tokens = getTokenCountAsync(content).then(value => Number(value) || 0).catch(() => {
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
        const candidates = new Set([current, base, 'en']);
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
            console.warn('[STLO i18n] applyLocale() threw:', e);
        }
    } catch (e) {
        console.warn('[STLO] i18n load failed:', e);
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
            console.error('Error removing event listener:', error);
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
            console.warn('[STLO] WORLDINFO_ENTRIES_LOADED handler error:', e);
        }
    };
    eventSource.on(event_types.WORLDINFO_ENTRIES_LOADED, handler);

    const chatChangedHandler = () => {
        EXTENSION_STATE.currentSpeakingCharacter = null;  // Clear character override state on chat change
        stopJevGeneration();
        lastJevReport = null;
        syncJevTopBar();
    };

    // Group chat character override handler
    const groupMemberDraftedHandler = (chId) => {
        // Clear any stale state first, then set current speaking character
        EXTENSION_STATE.currentSpeakingCharacter = null;

        if (chId !== undefined && chId !== null && characters && characters[chId]) {
            const character = characters[chId];
            const characterName = (character?.avatar?.replace(/\.[^/.]+$/, '') || character?.name || null);
            EXTENSION_STATE.currentSpeakingCharacter = characterName;
        }
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
        .stlo-modal-ui .stlo-jev-field { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 156px); align-items: center; gap: 6px; width: 100%; }
        .stlo-modal-ui .stlo-jev-field .stlo-field-heading > label { min-width: 0; overflow-wrap: anywhere; text-align: left; }
        .stlo-modal-ui .stlo-jev-field > select { width: 100% !important; min-width: 0; max-width: 100%; box-sizing: border-box; margin: 0 !important; }
        .stlo-modal-ui .stlo-jev-field > input[type="number"] { width: 100% !important; max-width: 156px; min-width: 0; box-sizing: border-box; margin: 0 !important; }
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
        .stlo-modal-ui .stlo-advanced-drawer { width: 100%; margin: 3px 0 0; }
        .stlo-modal-ui .stlo-advanced-drawer .inline-drawer-toggle { display: inline-flex; align-items: center; justify-content: flex-start; gap: 8px; width: max-content; max-width: 100%; min-width: 0; box-sizing: border-box; padding: 4px 2px 4px 0; }
        .stlo-modal-ui .stlo-advanced-drawer .inline-drawer-toggle > b { min-width: 0; }
        .stlo-modal-ui .stlo-advanced-drawer .inline-drawer-icon { flex: 0 0 auto; margin-left: 0 !important; }
        .stlo-modal-ui .stlo-advanced-drawer .inline-drawer-content { padding-top: 6px; }
        .stlo-modal-ui .stlo-advanced-drawer .info-block { margin-bottom: 6px !important; }
        .stlo-modal-ui .stlo-advanced-drawer .priority-section { margin-bottom: 9px; }
        @media (max-width: 480px) {
            .stlo-modal-ui { gap: 6px; }
            .stlo-modal-ui .stlo-section { gap: 5px; padding-bottom: 8px; }
            .stlo-modal-ui .stlo-jev-field { grid-template-columns: minmax(0, 1fr) minmax(0, 132px); gap: 4px; }
            .stlo-modal-ui .stlo-jev-field > input[type="number"] { max-width:132px; }
            .stlo-modal-ui .stlo-jev-prompt-heading .stlo-field-heading { flex:1 1 130px; }
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
        console.warn('[STLO] Could not resolve character filename for linked lorebooks:', error);
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
 * Open the STLO editor from the extensions menu. During a character chat,
 * show attached character lorebooks first; the checkbox reveals all books.
 * This filter is display-only and never changes lorebook connections.
 */
async function openLorebookBudgetFromMenu() {
    const available = (Array.isArray(world_names) ? world_names : [])
        .filter(name => typeof name === 'string' && name.trim() !== '');
    if (available.length === 0) {
        toastr.info(translate('Create or select a World Info file first.', 'stlo.info.noLorebook'));
        return;
    }

    const linked = getCurrentCharacterLinkedLorebooks();
    const current = getCurrentLorebookName();
    const form = document.createElement('div');
    form.className = 'world_entry_form_control';
    const label = document.createElement('label');
    label.htmlFor = 'stlo_menu_lorebook_select';
    label.textContent = '로어북 선택';

    const select = document.createElement('select');
    select.id = 'stlo_menu_lorebook_select';
    select.className = 'text_pole textarea_compact';

    const allLabel = document.createElement('label');
    allLabel.className = 'checkbox_label';
    allLabel.style.marginTop = '10px';
    const showAll = document.createElement('input');
    showAll.type = 'checkbox';
    showAll.id = 'stlo_menu_show_all_lorebooks';
    showAll.checked = linked === null;
    showAll.disabled = linked === null;
    const checkmark = document.createElement('span');
    checkmark.className = 'checkmark';
    const allText = document.createElement('span');
    allText.textContent = '모든 로어북 보기';
    allLabel.append(showAll, checkmark, allText);

    const updateOptions = () => {
        const names = showAll.checked || linked === null
            ? available
            : available.filter(name => linked.has(name));
        const previous = select.value;
        select.replaceChildren();
        if (names.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = '연결된 로어북이 없습니다';
            option.disabled = true;
            select.appendChild(option);
            select.value = '';
            return;
        }
        for (const name of names) {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            select.appendChild(option);
        }
        select.value = names.includes(previous) ? previous
            : (current && names.includes(current) ? current : names[0]);
    };
    showAll.addEventListener('change', updateOptions);
    updateOptions();
    form.append(label, select, allLabel);
    const selected = await new Promise(resolve => {
        const popup = new Popup(form, POPUP_TYPE.CONFIRM, '', {
            okButton: '설정 열기',
            cancelButton: translate('Cancel', 'stlo.modal.cancel'),
            onClosing: closingPopup => {
                resolve(closingPopup.result === 1 ? select.value : null);
                return true;
            },
        });
        popup.show();
    });
    if (selected) await openLorebookSettings(selected);
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
    add('stlo_budget_menu_item', 'fa-scale-balanced', '로어북 예산 관리', openLorebookBudgetFromMenu);
    add('stlo_jev_settings_menu_item', 'fa-scale-balanced', translate('Jev injection settings', 'stlo.jev.settingsTitle'), openJevSettings);
}

/**
 * Per-lorebook vector score thresholds require separate native queries when
 * different thresholds are active. The upstream query-multi API does not return
 * similarity scores, so results are merged deterministically and capped at the
 * *single global* Max Entries value (round-robin by lorebook, in result order).
 * No override = no extra vector network request. Other vector queries are untouched.
 */
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

        const worldByCollection = new Map(
            (Array.isArray(world_names) ? world_names : [])
                .filter(name => typeof name === 'string')
                .map(name => ['world_' + getStringHash(name), name])
        );
        const originalThreshold = Number.isFinite(Number(request.threshold))
            ? Number(request.threshold) : 0;
        const groups = new Map();
        for (const id of request.collectionIds) {
            const world = worldByCollection.get(id);
            const settings = world ? await getLorebookSettings(world) : null;
            const value = settings?.vectorThreshold;
            const enabled = settings?.vectorThresholdEnabled === true
                && typeof value === 'number' && Number.isFinite(value)
                && value >= 0 && value <= 1;
            const threshold = enabled ? value : originalThreshold;
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
async function handleWorldInfoEntriesLoaded(eventData) {
    try {
        if (!eventData || typeof eventData !== 'object') return;

        // Delegate consolidation, sorting, and budget to dedicated functions
        await applyPriorityOrdering(eventData);
        // Vector Storage uses this same event to synchronize persistent hashes.
        // Capture entry text and settings once during the optional native
        // candidate scan. No separate second lorebook load.
        const run = jevGeneration;
        if (run?.preview && isCurrentJev(run) && !run.preview.entries) {
            run.preview.entries = structuredClone(eventData.globalLore);
            run.preview.settings = new Map(EXTENSION_STATE.scanWorldSettings);
        }
        // Shape only the actual reply scan; keep the vector pass's full book.
        if (HAS_WORLDINFO_SCAN_DONE && nativeVectorPasses === 0) applyJevSelection(eventData.globalLore);
        // In newer branches (with WORLDINFO_SCAN_DONE), we trim per-loop and skip pre-scan entirely.
        if (!HAS_WORLDINFO_SCAN_DONE) {
            await enforceBudgetPreScan(eventData);
        }
    } catch (error) {
        console.warn('[STLO] handleWorldInfoEntriesLoaded error:', error);
    }
}

function applyJevSelection(entries) {
    const run = jevGeneration;
    if (!run?.selection || run.preparing || run.preview || !isCurrentJev(run)) return;
    applyJevRecall(entries, run.selection.worlds, run.selection.accepted);
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
    console.warn('[STLO] Jev preparation failed:', error?.name ?? 'Error');
    try {
        await askJevRetry(run, error, false);
    } finally {
        cancelJevReply(run, abort);
    }
}
async function decideJevWithRetry(run, prepared, batches) {
    const queue = [...batches];
    const decisions = [];
    let completed = 0;
    let assessed = 0;
    let confirmedInput = 0;
    let reportedUsage = 0;
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
            queue.shift();
            completed++;
            assessed += batch.candidates.size;
            if (result.inputTokens != null) {
                confirmedInput += result.inputTokens;
                reportedUsage++;
            }
            updateJevReport(run, {
                completedBatches: completed,
                unassessed: prepared.candidates.size - assessed,
                actualInputTokens: reportedUsage ? confirmedInput : undefined,
                usageReportedBatches: reportedUsage,
            });
        } catch (error) {
            if (!isCurrentJev(run)) return null;
            if (error?.name === 'JevInputLimitError') {
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
    return queue.length || !isCurrentJev(run) ? null : rankJevDecisions(prepared, decisions);
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
        const preview = run.options.mode === 'filtered'
            ? await collectNativeJevCandidates(run, chat, contextSize, type)
            : null;
        const entries = preview?.entries ?? await getSortedEntries();
        if (!isCurrentJev(run)) { abort(true); return; }
        const settings = preview?.settings ?? new Map(EXTENSION_STATE.scanWorldSettings);
        const active = new Set(entries.map(entry => entry.world));
        const worlds = new Set([...getJevWorlds(settings, run.characterRecall)].filter(world => active.has(world)));
        const budget = normalizeJevBudget(extension_settings[EXTENSION_NAME]?.jevBudget);
        const candidateKeys = preview?.candidates ?? null;
        if (!isCurrentJev(run)) { abort(true); return; }
        const messages = chat ?? getContext().chat ?? [];
        const hasCandidate = entries.some(entry => isJevCandidate(entry, worlds) && (!candidateKeys || candidateKeys.has(jevEntryKey(entry))));
        if (hasCandidate && !messages.some(message => !message?.is_system && typeof message?.mes === 'string' && message.mes.trim())) {
            throw Error('No recent dialogue for Jev.');
        }
        const prepared = prepareJevRecall(entries, worlds, messages, run.options, candidateKeys);
        updateJevReport(run, { candidates: prepared?.candidates.size ?? 0,
            unassessed: prepared?.candidates.size ?? 0, inputChars: 0, estimatedInputTokens: 0,
            truncatedMessages: prepared?.stats.truncatedMessages ?? 0, truncatedLore: prepared?.stats.truncatedLore ?? 0,
            sharedEntries: prepared?.stats.sharedEntries ?? 0, plannedBatches: 0, completedBatches: 0,
        });
        if (!prepared) {
            // Empty candidates are a successful zero-selection, not a failure.
            run.selection = { accepted: new Map(), worlds, budget };
            await restoreNativeVectorHits(run);
            updateJevReport(run, { phase: 'empty', selected: 0, accepted: 0, injected: 0 });
            return;
        }
        const batches = planJevRequests(prepared);
        updateJevReport(run, { plannedBatches: batches.length });
        const ranked = await decideJevWithRetry(run, prepared, batches);
        if (ranked === null || !isCurrentJev(run)) { cancelJevReply(run, abort); return; }
        const worldInfoBudget = calculateTotalWIBudget(contextSize);
        const bookBudgets = new Map(await Promise.all([...worlds].map(async world =>
            [world, await calculateLorebookBudget(settings.get(world), worldInfoBudget)])));
        const bookPriorities = new Map([...worlds].map(world => {
            const book = settings.get(world);
            const override = book?.characterOverrides?.[EXTENSION_STATE.currentSpeakingCharacter];
            return [world, override?.priority ?? book?.priority ?? PRIORITY_LEVELS.DEFAULT];
        }));
        const diagnostics = new Map();
        const accepted = await fitJevRecall(entries, worlds, ranked, {
            budget, worldInfoBudget: worldInfoBudget || Infinity, bookBudgets, countTokens: getTokenCountAsync,
            bookPriorities, diagnostics,
        });
        if (!isCurrentJev(run)) { abort(true); return; }
        run.selection = { accepted, worlds, budget };
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
    if (dryRun || !run?.enabled || run.selection || !isCurrentJev(run)) return;
    updateJevReport(run, { phase: 'cancelled', error: translate('Recall preparation did not complete.', 'stlo.jev.vectorMissing') });
    stopGeneration();
    toastr.error(translate('Recall preparation did not complete. The reply was cancelled.', 'stlo.jev.prepareCancelled'));
}
function recordJevActivated(entries) {
    const run = jevGeneration;
    if (!run?.selection || !isCurrentJev(run) || run.preview || !Array.isArray(entries)) return;
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
        console.error(`Error reading STLO settings for ${worldName} from cache:`, error);
        return { ...DEFAULT_LOREBOOK_SETTINGS };
    }
}

/**
 * Save settings for a specific lorebook
 * @param {string} worldName - Name of the lorebook
 * @param {Object} settings - Settings to save
 */
async function setLorebookSettings(worldName, settings) {
    try {
        const worldData = await loadWorldInfo(worldName);

        if (!worldData) {
            toastr.error(tKey('stlo.settings.loadError.body', 'Could not load settings for lorebook: ${0}', worldName), translate('Settings Error', 'stlo.settings.loadError.title'));
            return false;
        }

        // Save extension settings directly on the world data object (preserve existing keys)
        const existing = (worldData[EXTENSION_NAME] && typeof worldData[EXTENSION_NAME] === 'object') ? worldData[EXTENSION_NAME] : {};
        const finalSettings = { ...DEFAULT_LOREBOOK_SETTINGS, ...existing, ...settings };
        worldData[EXTENSION_NAME] = finalSettings;

        // Save the world data back immediately
        await saveWorldInfo(worldName, worldData, true);

        // Hot-update cache so subsequent reads see fresh settings immediately
        try {
            worldInfoCache.set(worldName, worldData);
        } catch (e) {
            console.warn('STLO: Failed to update worldInfoCache after save:', e);
        }

        // Discard any settings snapshot so the next scan uses the saved value.
        EXTENSION_STATE.scanWorldSettings = new Map();
        EXTENSION_STATE.scanBudgetWorlds = new Set();
        EXTENSION_STATE.scanHasExplicitBudgets = false;

        // Notify UI/listeners that World Info has updated so panels can re-render
        try {
            if (typeof eventSource?.emit === 'function') {
                eventSource.emit(event_types.WORLDINFO_UPDATED);
            }
        } catch (e) {
            console.warn('STLO: Failed to emit WORLDINFO_UPDATED after save:', e);
        }

        return true;
    } catch (error) {
        console.error(`Error saving settings for ${worldName}:`, error);
        toastr.error(tKey('stlo.settings.saveError.body', 'Error saving settings for ${0}', worldName), translate('Save Error', 'stlo.settings.saveError.title'));
        return false;
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
        toastr.warning(translate('Usage: /stlo <lorebook name>', 'stlo.cmd.usage'));
        return '';
    }

    const idx = findLorebookIndexByName(trimmed);
    if (idx === -1) {
        toastr.warning(tKey('stlo.cmd.notfound', 'Lorebook not found: ${0}', trimmed));
        return '';
    }

    // Attempt selection (silently continue if not possible), then open modal
    await selectLorebookByIndex(idx);
    await openLorebookSettings();
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
        console.warn('[STLO] Failed to register /stlo command:', e);
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
        const saved = getCharacterJevRecall(avatar);
        const choice = saved === true ? 'on' : 'off';
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
            <div class="stlo-modal-ui">
                <div class="world_entry_form_control stlo-section">
                    <h3 data-i18n="stlo.jev.dialogTitle">Jev settings</h3>
                    ${HAS_WORLDINFO_SCAN_DONE && avatar ? `
                        <div class="stlo-character-line">
                            <span data-i18n="stlo.jev.characterTitle">Current character</span>
                            <strong id="stlo-jev-character-name"></strong>
                        </div>
                        <div class="stlo-field-heading"><label for="stlo-jev-character-choice" data-i18n="stlo.jev.characterActivation">Jev selection</label>${infoHelp('stlo.jev.characterActivationHelp', 'Applies to every chat with this character and all active linked lorebooks, except books excluded from Jev.')}</div>
                        <select id="stlo-jev-character-choice" class="text_pole textarea_compact">
                            <option value="on" ${choice === 'on' ? 'selected' : ''} data-i18n="stlo.jev.on">On</option>
                            <option value="off" ${choice === 'off' ? 'selected' : ''} data-i18n="stlo.jev.off">Off</option>
                        </select>` : HAS_WORLDINFO_SCAN_DONE ? `<small data-i18n="stlo.jev.noCharacter">Open a one-to-one chat to set character-level Jev. Group chats use the book settings.</small>` : `<small data-i18n="stlo.jev.unsupported">Jev requires World Info scan support.</small>`}
                </div>
                ${HAS_WORLDINFO_SCAN_DONE ? `
                <div class="world_entry_form_control stlo-section">
                    <h4 data-i18n="stlo.jev.sharedTitle">Jev injection settings (all characters)</h4>
                <div class="stlo-jev-field"><div class="stlo-field-heading"><label for="stlo-jev-budget" data-i18n="stlo.jev.budget">Total Jev budget (tokens)</label>${infoHelp('stlo.jev.budgetHelp', 'Shared injection ceiling, not an API input-token limit. World Info and individual book limits still apply.')}</div><input type="number" id="stlo-jev-budget" class="text_pole textarea_compact" min="1" step="1" value="${normalizeJevBudget(extension_settings[EXTENSION_NAME]?.jevBudget)}"></div>
                <div class="stlo-jev-field"><div class="stlo-field-heading"><label for="stlo-jev-profile" data-i18n="stlo.jev.profile">NanoGPT connection profile</label>${infoHelp('stlo.jev.keyHelp', 'Only NanoGPT connection keys are supported. Use a key with Billing set to Subscription only to block balance charges.')}</div><select id="stlo-jev-profile" class="text_pole textarea_compact"><option value="" data-i18n="stlo.jev.chooseProfile">Select a profile</option></select></div>
                </div>
                <div class="world_entry_form_control stlo-section">
                <div class="stlo-field-heading"><h4 data-i18n="stlo.jev.mode">Jev candidate source</h4>${infoHelp('stlo.jev.modeHelp', 'All eligible entries: skip vector search. Filtered: judge only vector and keyword hits. Requests split automatically when needed.')}</div>
                <label class="stlo-jev-radio"><input type="radio" name="stlo-jev-mode" value="all" ${jevOptions.mode === "all" ? "checked" : ""}><span data-i18n="stlo.jev.modeAll">All eligible lorebook entries (default)</span></label>
                <label class="stlo-jev-radio"><input type="radio" name="stlo-jev-mode" value="filtered" ${jevOptions.mode === "filtered" ? "checked" : ""}><span data-i18n="stlo.jev.modeFiltered">Vector / keyword search candidates</span></label>
                </div>
                <div class="world_entry_form_control stlo-section">
                <details class="stlo-jev-advanced"><summary data-i18n="stlo.jev.advanced">Advanced Jev settings</summary><div class="stlo-jev-advanced-body">
                <div class="stlo-jev-field"><div class="stlo-field-heading"><label for="stlo-jev-recent" data-i18n="stlo.jev.recent">Recent messages</label>${infoHelp('stlo.jev.recentHelp', 'Jev reads this many recent messages in full by default. Default: 20.')}</div><input type="number" id="stlo-jev-recent" class="text_pole textarea_compact" min="1" max="100" step="1" value="${jevOptions.recent}"></div>
                <details class="stlo-jev-advanced stlo-jev-reading-limits" ${jevOptions.messageLength || jevOptions.loreLength ? 'open' : ''}>
                    <summary class="stlo-reading-summary"><span data-i18n="stlo.jev.readingLimits">Reading limits</span><small id="stlo-jev-reading-status"></small></summary>
                    <div class="stlo-jev-advanced-body">
                        <div class="stlo-jev-field"><div class="stlo-field-heading"><label for="stlo-jev-message-length" data-i18n="stlo.jev.messageLength">Message character limit</label>${infoHelp('stlo.jev.messageLengthHelp', '0 reads the full message. A positive limit keeps the end.')}</div><input type="number" id="stlo-jev-message-length" class="text_pole textarea_compact" min="0" max="20000" step="1" value="${jevOptions.messageLength}"></div>
                        <div class="stlo-jev-field"><div class="stlo-field-heading"><label for="stlo-jev-lore-length" data-i18n="stlo.jev.loreLength">Lore character limit</label>${infoHelp('stlo.jev.loreLengthHelp', '0 reads the full entry. A positive limit keeps the beginning and end.')}</div><input type="number" id="stlo-jev-lore-length" class="text_pole textarea_compact" min="0" max="20000" step="1" value="${jevOptions.loreLength}"></div>
                    </div>
                </details>
                <div class="stlo-jev-field"><div class="stlo-field-heading"><label for="stlo-jev-preset" data-i18n="stlo.jev.preset">Default selection style</label>${infoHelp('stlo.jev.presetHelp', 'Strict: direct relevance. Balanced: default. Generous: indirect relevance too. Changing this selects the built-in prompt.')}</div><select id="stlo-jev-preset" class="text_pole textarea_compact"><option value="strict" data-i18n="stlo.jev.strict">Strict</option><option value="balanced" data-i18n="stlo.jev.balanced">Balanced</option><option value="generous" data-i18n="stlo.jev.generous">Generous</option></select></div>
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
                <div class="stlo-jev-actions"><button type="button" class="menu_button" id="stlo-jev-reset" data-i18n="stlo.jev.reset">Restore defaults</button><button type="button" class="menu_button" id="stlo-jev-report" data-i18n="stlo.jev.report">Latest Jev recall</button></div></div></details>
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
                            toastr.warning(tr('Prompt text cannot be empty.', 'promptEmpty'));
                            return false;
                        }
                        const val = id => document.getElementById(id)?.value;
                        const opts = {
                            inputVersion: 2,
                            mode: document.querySelector('input[name="stlo-jev-mode"]:checked')?.value,
                            recent: val('stlo-jev-recent'),
                            messageLength: val('stlo-jev-message-length'),
                            loreLength: val('stlo-jev-lore-length'),
                            preset: promptState.preset,
                            prompt: promptState.prompt,
                        };
                        const numeric = [[opts.recent, 1, 100, false], [opts.messageLength, 100, 20000, true], [opts.loreLength, 100, 20000, true]];
                        if (numeric.some(([value, min, max, allowZero]) => !String(value ?? '').trim() || !Number.isSafeInteger(Number(value)) || (!(allowZero && Number(value) === 0) && (Number(value) < min || Number(value) > max)))) {
                            toastr.error(translate('Check the Jev numeric settings and custom prompt.', 'stlo.jev.validation'));
                            return false;
                        }
                        result.jevBudget = normalizeJevBudget(val('stlo-jev-budget'));
                        result.jevProfileId = val('stlo-jev-profile') ?? '';
                        result.jevOptions = normalizeJevOptions(opts);
                        result.jevPromptLibrary = promptState.library;
                        result.characterChoice = val('stlo-jev-character-choice');
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
            toastr.success(translate('Settings saved.', 'stlo.jev.settingsSaved'));
        }
    } catch (error) {
        console.error('[STLO] Error opening Jev settings:', error);
        toastr.error(translate('Failed to open or save Jev settings.', 'stlo.jev.settingsError'));
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
    const report = document.getElementById('stlo-jev-report');
    if (!preset || !target || !reset || !report) return null;
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
        warn: message => toastr.warning(message), isOpen });
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
        syncReadingStatus();
        promptModel.chooseBuiltin('balanced');
        ui.render();
    };
    const onReport = () => { if (!ui.isBusy()) void openJevReport(); };
    for (const [element, event, handler] of [[reset, 'click', onReset], [report, 'click', onReport]]) {
        element.addEventListener(event, handler);
        modalEventListeners.push({ element, event, handler });
    }
    return ui;

}

async function openLorebookSettings(worldName = null) {
    // Use try-finally to ensure modal state is always reset
    try {
        // Atomic lock to prevent race conditions
        if (EXTENSION_STATE.modalOpen) {
            return;
        }

        EXTENSION_STATE.modalOpen = true;

        // Settings opening

        const currentLorebook = worldName || getCurrentLorebookName();
        if (!currentLorebook) {
            EXTENSION_STATE.modalOpen = false;
            toastr.info(
                translate('Create or select a World Info file first.', 'stlo.info.noLorebook'),
                translate('World Info is not set', 'stlo.info.noLorebookTitle'),
                { timeOut: 10000, preventDuplicates: true }
            );
            return;
        }

        // Get current settings
        if (!worldInfoCache.has(currentLorebook)) {
            const loaded = await loadWorldInfo(currentLorebook);
            if (!loaded) throw Error('Could not load the selected lorebook.');
        }
        const currentSettings = await getLorebookSettings(currentLorebook);
        const characterAvatar = getJevCharacterAvatar();
        const characterRecall = getCharacterJevRecall(characterAvatar);
        const showBookJev = HAS_WORLDINFO_SCAN_DONE && (!characterAvatar || characterRecall === true);
        const protectInitially = getProtectAlwaysOn();

        // Create modal HTML - single vertical scrolling content
        const modalHtml = `
            <div class="stlo-modal-ui">
            <div class="world_entry_form_control stlo-section">
                <h3 data-i18n="stlo.modal.title">📚 ST Lorebook Ordering</h3>
                <small class="stlo-scope-name" id="stlo-book-name"></small>
                <div class="stlo-field-heading">
                    <h4 data-i18n="stlo.modal.priority.title">Lorebook Priority</h4>
                    <details class="stlo-info">
                        <summary aria-label="설명 보기">i</summary>
                        <div class="stlo-info-body"><small data-i18n="stlo.modal.priority.help">Higher numbers (4-5) process first. Lower numbers (1-2) process last.</small></div>
                    </details>
                </div>

                <select id="${SELECTORS.LOREBOOK_PRIORITY_SELECT}" class="text_pole textarea_compact">
                    <option value="5" ${currentSettings.priority === 5 ? 'selected' : ''} data-i18n="stlo.modal.priority.option.5">5 - Highest Priority (Processes First)</option>
                    <option value="4" ${currentSettings.priority === 4 ? 'selected' : ''} data-i18n="stlo.modal.priority.option.4">4 - High Priority</option>
                    <option value="null" ${currentSettings.priority === null ? 'selected' : ''} data-i18n="stlo.modal.priority.option.3">3 - Normal (SillyTavern Default)</option>
                    <option value="2" ${currentSettings.priority === 2 ? 'selected' : ''} data-i18n="stlo.modal.priority.option.2">2 - Low Priority</option>
                    <option value="1" ${currentSettings.priority === 1 ? 'selected' : ''} data-i18n="stlo.modal.priority.option.1">1 - Lowest Priority (Processes Last)</option>
                </select>
                <div class="stlo-toggle-block">
                    <div class="stlo-option-line">
                        <label class="checkbox_label stlo-checkrow" for="lorebook-order-adjustment-enabled">
                        <input type="checkbox" id="lorebook-order-adjustment-enabled"
                               ${currentSettings.orderAdjustment !== 0 ? 'checked' : ''}>
                        <span class="checkmark"></span>
                        <span data-i18n="stlo.modal.order.enableLabel">Enable Order Adjustment</span>
                    </label>
                    <details class="stlo-info stlo-info-end">
                        <summary aria-label="설명 보기">i</summary>
                        <div class="stlo-info-body"><small data-i18n="stlo.modal.order.help">Fine-tune processing order within this lorebook's priority level</small></div>
                    </details>
                    </div>
                </div>

                <div class="world_entry_form_control stlo-order-controls" id="lorebook-order-adjustment-container" ${currentSettings.orderAdjustment !== 0 ? '' : 'hidden'}>
                    <div class="stlo-field-heading">
                        <h4 data-i18n="stlo.modal.order.title">Order Adjustment</h4>
                        <details class="stlo-info">
                            <summary aria-label="설명 보기">i</summary>
                            <div class="stlo-info-body"><small data-i18n="stlo.modal.order.explain">Higher values process first. Examples: +250 for slight boost, -500 for lower priority.</small></div>
                        </details>
                    </div>
                    <div class="stlo-inline-number">
                        <input type="number" id="lorebook-order-adjustment" class="text_pole textarea_compact"
                               value="${currentSettings.orderAdjustment}" min="-10000" max="10000" step="1"
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
                                <summary aria-label="설명 보기">i</summary>
                                <div class="stlo-info-body"><small data-i18n="stlo.modal.order.groupOnly.help">Only apply order adjustment during group chats (ignored in single character chats)</small></div>
                            </details>
                        </div>
                    </div>
                </div>
            </div>

            <div class="world_entry_form_control stlo-section">
                ${createBudgetControls('lorebook', currentSettings)}
                <div class="stlo-option-line">
                    <label class="checkbox_label stlo-checkrow" for="stlo_protect_always_on">
                        <input type="checkbox" id="stlo_protect_always_on" ${protectInitially ? 'checked' : ''}>
                        <span class="checkmark"></span>
                        <span data-i18n="stlo.budget.protect">Protect always-on entries first</span>
                    </label>
                    ${infoHelp('stlo.budget.protectHelp', 'Applies to all lorebooks, not just this book.')}
                </div>
            </div>

            <div class="world_entry_form_control stlo-section">
                <div class="stlo-field-heading">
                    <h4>벡터 유사도 임계값</h4>
                    <details class="stlo-info">
                        <summary aria-label="설명 보기">i</summary>
                        <div class="stlo-info-body"><small>0~1 사이의 값을 입력합니다. 비워두면 전역 설정을 사용합니다. 다른 값으로 검색할 때는 요청이 추가되어 비용과 시간이 늘 수 있습니다.</small></div>
                    </details>
                </div>
                <input type="number" id="${SELECTORS.LOREBOOK_VECTOR_THRESHOLD}" class="text_pole textarea_compact"
                       min="0" max="1" step="0.01" placeholder="미입력시 전역 설정 사용"
                       value="${currentSettings.vectorThresholdEnabled === true
                           && typeof currentSettings.vectorThreshold === 'number'
                           ? currentSettings.vectorThreshold : ''}">
            </div>

            ${showBookJev ? `<div class="world_entry_form_control stlo-section">
                <h4 data-i18n="stlo.jev.bookTitle">Jev · this lorebook</h4>
                <div class="stlo-option-line"><label class="checkbox_label stlo-checkrow" for="stlo-jev-exclude"><input type="checkbox" id="stlo-jev-exclude" ${currentSettings.jevExclude === true ? "checked" : ""}><span class="checkmark"></span><span data-i18n="stlo.jev.exclude">Exclude this lorebook from Jev</span></label>${infoHelp('stlo.jev.excludeHelp', 'This book keeps native activation. All-entries mode skips vector retrieval; keywords and always-on rules still apply. Filtered mode also uses configured vector retrieval.')}</div>
                <div class="stlo-legacy-book" ${characterAvatar ? "hidden" : ""}>
                <div class="stlo-option-line"><label class="checkbox_label stlo-checkrow" for="stlo-jev-recall"><input type="checkbox" id="stlo-jev-recall" ${currentSettings.jevRecall === true ? "checked" : ""}><span class="checkmark"></span><span data-i18n="stlo.jev.legacyBook">Use Jev for this book in group chats</span></label>${infoHelp('stlo.jev.legacyBookHelp', 'Applies when using this book in a group chat.')}</div>
                </div>
            </div>` : ''}
            <!-- Group chat controls share one section, without dividers between toggles. -->
            <div class="world_entry_form_control stlo-section stlo-group-section">
                <div class="stlo-toggle-block">
                    <div class="stlo-option-line">
                        <label class="checkbox_label stlo-checkrow" for="lorebook-only-when-speaking">
                        <input type="checkbox" id="lorebook-only-when-speaking"
                               ${currentSettings.onlyWhenSpeaking ? 'checked' : ''}>
                        <span class="checkmark"></span>
                        <span data-i18n="stlo.modal.onlyWhenSpeaking.label">Group chats: Only activate for specific characters (requires character assignments below)</span>
                    </label>
                    <details class="stlo-info stlo-info-end">
                        <summary aria-label="설명 보기">i</summary>
                        <div class="stlo-info-body">
                            <small data-i18n="stlo.modal.onlyWhenSpeaking.help.1">When enabled, this lorebook will only activate when characters assigned in Group Chat Overrides are speaking.</small>
                            <small data-i18n="stlo.modal.onlyWhenSpeaking.help.2">If this box is checked but no characters are assigned below, this lorebook WILL NOT ACTIVATE during group chats.</small>
                        </div>
                    </details>
                    </div>
                </div>

            <!-- Group Chat Overrides -->
            <div class="inline-drawer wide100p world_entry_form_control stlo-advanced-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b data-i18n="stlo.modal.groupOverrides.title">Group Chat Overrides</b>
                    <div class="fa-solid fa-circle-chevron-down inline-drawer-icon down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="stlo-field-heading"><h4><span data-i18n="stlo.modal.groupOverrides.defaultPriority.title">Default Priority:</span> <span id="default-priority-display" data-i18n="stlo.modal.groupOverrides.defaultPriority.value">3 - Normal</span></h4><details class="stlo-info"><summary aria-label="Help">i</summary><div class="stlo-info-body"><small data-i18n="stlo.modal.groupOverrides.info">If a character is selected in here, the priority settings here will override the lorebook's default setting only during that character's speaking turns in a group chat.</small><small data-i18n="stlo.modal.groupOverrides.defaultPriority.help">Characters not specifically listed will use the priority level set above. Single-character chats always use the default.</small></div></details></div>
                    <div id="advanced-priority-sections">
                        <!-- Priority sections will be inserted here -->
                    </div>
                </div>
            </div>
            </div>
            </div>
        `;

        // Show the modal and set up behavior
        const result = await new Promise((resolve) => {
            let modalEventListeners = [];

            // Function to capture current form state
            const captureFormState = () => {
                const prioritySelect = document.getElementById(SELECTORS.LOREBOOK_PRIORITY_SELECT);
                const budgetModeSelect = document.getElementById(SELECTORS.LOREBOOK_BUDGET_MODE);
                const budgetValueInput = document.getElementById(SELECTORS.LOREBOOK_BUDGET_VALUE);
                const orderAdjustmentEnabled = document.getElementById('lorebook-order-adjustment-enabled');
                const orderAdjustmentInput = document.getElementById('lorebook-order-adjustment');
                const orderAdjustmentGroupOnly = document.getElementById('lorebook-order-adjustment-group-only');
                const onlyWhenSpeaking = document.getElementById('lorebook-only-when-speaking');
                const randomTrimEl = document.getElementById(SELECTORS.LOREBOOK_RANDOM_TRIM);
                const vectorThresholdInput = document.getElementById(SELECTORS.LOREBOOK_VECTOR_THRESHOLD);
                const jevRecall = document.getElementById('stlo-jev-recall');

                if (prioritySelect && budgetModeSelect && budgetValueInput && orderAdjustmentEnabled && orderAdjustmentInput && orderAdjustmentGroupOnly && onlyWhenSpeaking) {
                    return {
                        priority: prioritySelect.value,
                        budgetMode: budgetModeSelect.value,
                        budget: budgetValueInput.value,
                        orderAdjustmentEnabled: orderAdjustmentEnabled.checked,
                        orderAdjustment: orderAdjustmentInput.value,
                        orderAdjustmentGroupOnly: orderAdjustmentGroupOnly.checked,
                        onlyWhenSpeaking: onlyWhenSpeaking.checked,
                        randomTrim: Boolean(randomTrimEl?.checked),
                        protectAlwaysOn: document.getElementById('stlo_protect_always_on')?.checked ?? protectInitially,
                        vectorThreshold: vectorThresholdInput?.value ?? '',
                        jevRecall: jevRecall?.checked === true,
                        jevExclude: document.getElementById('stlo-jev-exclude')?.checked === true,
                        timestamp: Date.now()
                    };
                }
                return null;
            };

            // Function to validate and process form data
            const validateAndProcessForm = (formState) => {
                if (!formState) {
                    toastr.error(translate('Settings form not properly loaded. Please try again.', 'stlo.validation.formNotLoaded'));
                    return null;
                }

                const priorityValue = formState.priority;

                // Validate priority parsing
                let validatedPriority = null;
                if (priorityValue !== '' && priorityValue !== 'null') {
                    const parsedPriority = parseInt(priorityValue);
                    if (isNaN(parsedPriority) || parsedPriority < 1 || parsedPriority > 5) {
                        toastr.error(translate('Priority value must be between 1 and 5', 'stlo.validation.priorityRange'), 'Validation Error');
                        return null;
                    }
                    validatedPriority = parsedPriority;
                } else if (priorityValue === 'null') {
                    validatedPriority = null; // Explicitly set to null for default
                }

                // Validate order adjustment
                let validatedOrderAdjustment = 0;
                if (formState.orderAdjustmentEnabled && formState.orderAdjustment !== '') {
                    const parsed = parseInt(formState.orderAdjustment);
                    if (isNaN(parsed) || parsed < -10000 || parsed > 10000) {
                        toastr.error(translate('Order adjustment must be between -10000 and 10000', 'stlo.validation.orderAdjustmentRange'), 'Validation Error');
                        return null;
                    }
                    validatedOrderAdjustment = parsed;
                }

                // Validate character overrides (this may return null if duplicates found)
                const hasRenderedOverrides = Boolean(document.getElementById('advanced-priority-sections')?.childElementCount);
                const characterOverrides = hasRenderedOverrides
                    ? getCharacterOverrides()
                    : currentSettings.characterOverrides || {};
                if (characterOverrides === null) {
                    return null; // Validation failed due to duplicate characters
                }

                // Validate budget settings
                const mode = formState.budgetMode || 'default';
                let validatedBudget = 0;

                if (mode === 'percentage_context' || mode === 'percentage_budget') {
                    const p = parseInt(formState.budget, 10);
                    if (isNaN(p) || p < 1 || p > 100) {
                        toastr.error(translate('Budget percent must be between 1 and 100', 'stlo.validation.budgetPercentRange'), 'Validation Error');
                        return null;
                    }
                    validatedBudget = p;
                } else if (mode === 'fixed') {
                    const v = parseInt(formState.budget, 10);
                    if (isNaN(v) || v <= 0) {
                        toastr.error(translate('Fixed budget must be a positive integer', 'stlo.validation.fixedBudgetPositive'), 'Validation Error');
                        return null;
                    }
                    validatedBudget = v;
                } else {
                    validatedBudget = 0; // default mode
                }

                const rawThreshold = String(formState.vectorThreshold ?? '').trim();
                let validatedThreshold = null;
                if (rawThreshold !== '') {
                    const parsed = Number(rawThreshold);
                    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
                        toastr.error('벡터 임계값은 0부터 1까지 입력해 주세요.', 'Validation Error');
                        return null;
                    }
                    validatedThreshold = parsed;
                }

                const validatedForm = {
                    protectAlwaysOn: formState.protectAlwaysOn,
                    jevRecall: formState.jevRecall,
                    jevExclude: formState.jevExclude,
                    vectorThreshold: validatedThreshold,
                    vectorThresholdEnabled: rawThreshold !== '',
                    priority: validatedPriority,
                    budgetMode: mode,
                    budget: validatedBudget,
                    orderAdjustment: validatedOrderAdjustment,
                    orderAdjustmentGroupOnly: formState.orderAdjustmentGroupOnly || false,
                    characterOverrides: characterOverrides,
                    onlyWhenSpeaking: formState.onlyWhenSpeaking || false,
                    randomTrim: !!formState.randomTrim
                };

                return validatedForm;
            };

            // Function to clean up modal event listeners
            const cleanupModalListeners = () => {
                document.getElementById('stlo-info-popup')?.remove();
                modalEventListeners.forEach(({ element, event, handler, capture }, index) => {
                    try {
                        element.removeEventListener(event, handler, Boolean(capture));
                    } catch (error) {
                        console.error(`Error removing modal event listener ${index}:`, error);
                    }
                    // Null out references immediately after removal
                    modalEventListeners[index].element = null;
                    modalEventListeners[index].handler = null;
                });
                modalEventListeners.length = 0;

                // Cancel pending animation frame if it exists
                if (EXTENSION_STATE.pendingAnimationFrame) {
                    const frameId = EXTENSION_STATE.pendingAnimationFrame;
                    EXTENSION_STATE.pendingAnimationFrame = null;
                    cancelAnimationFrame(frameId);
                }
            };

            // Create popup with onClosing callback to capture form data
            const popup = new Popup(modalHtml, POPUP_TYPE.CONFIRM, '', {
                okButton: translate('Save Settings', 'stlo.modal.save.ok'),
                cancelButton: translate('Cancel', 'stlo.modal.cancel'),
                wide: false,
                large: false,
                allowVerticalScrolling: true,
                onClosing: (popup) => {

                    // Only process form if user clicked OK/Save (POPUP_RESULT.AFFIRMATIVE = 1)
                    if (popup.result === 1) { // POPUP_RESULT.AFFIRMATIVE
                        const formState = captureFormState();
                        const validatedFormData = validateAndProcessForm(formState);


                        if (validatedFormData) {
                            resolve(validatedFormData);
                            cleanupModalListeners();
                            return true; // Allow popup to close
                        } else {
                            return false; // Prevent popup from closing
                        }
                    } else {
                        resolve(null);
                        cleanupModalListeners();
                        return true; // Allow popup to close
                    }
                }
            });

            // Show the popup
            popup.show();

            // Set up modal behavior immediately after popup creation
            // Use requestAnimationFrame to ensure DOM is ready
            EXTENSION_STATE.pendingAnimationFrame = requestAnimationFrame(() => {
                EXTENSION_STATE.pendingAnimationFrame = null;
                const bookName = document.getElementById('stlo-book-name');
                if (bookName) bookName.textContent = currentLorebook;
                setupModalBehavior(modalEventListeners, currentSettings);
            });
        });

        // Save the settings if we got them
        if (result) {
            try {
                // Keep the common toggle in extension settings, never in a book.
                const { protectAlwaysOn, ...bookSettings } = result;
                if (characterAvatar || !showBookJev) delete bookSettings.jevRecall;
                if (!showBookJev) delete bookSettings.jevExclude;
                const saved = await setLorebookSettings(currentLorebook, bookSettings);

                if (saved) {
                    if (protectAlwaysOn !== protectInitially) setProtectAlwaysOn(protectAlwaysOn);
                    toastr.success(tKey('stlo.settings.saved', 'STLO settings saved for ${0}', currentLorebook));
                } else {
                    toastr.error(tKey('stlo.settings.saveFailed', 'Failed to save settings for ${0}. Check console for details.', currentLorebook), 'Save Error');
                }
            } catch (saveError) {
                console.error('Exception during save operation:', saveError);
                toastr.error(tKey('stlo.settings.saveException', 'Failed to save settings for ${0}: ${1}', currentLorebook, saveError.message), 'Save Error');
            }
        }

    } catch (error) {
        console.error('Error opening lorebook settings:', error);
    } finally {
        // Always reset modal state when function exits
        EXTENSION_STATE.modalOpen = false;
    }
}

/**
 * Show only one short help popup at a time. Place it directly inside the
 * native popup <dialog>, outside its clipped/scrollable content. A body-level
 * overlay would render *behind* a modal dialog in the browser's top layer.
 * Placement is clamped to the viewport, including narrow mobile screens.
 */
function setupStloInfoPopups(modalEventListeners) {
    const modal = document.querySelector('.stlo-modal-ui');
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
function setupModalBehavior(modalEventListeners = [], currentSettings = {}) {
    setupStloInfoPopups(modalEventListeners);
    // Set up order adjustment behavior for main settings
    const orderAdjustmentEnabled = document.getElementById('lorebook-order-adjustment-enabled');
    const orderAdjustmentContainer = document.getElementById('lorebook-order-adjustment-container');
    const orderAdjustmentInput = document.getElementById('lorebook-order-adjustment');

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
    setupBudgetControls(modalEventListeners, currentSettings);

    setupPriorityDisplaySync(modalEventListeners);
    setupDrawerBehavior(modalEventListeners, () => setupAdvancedBehavior(modalEventListeners, currentSettings));
}

/**
 * Set up priority display synchronization
 * @param {Array} modalEventListeners - Array to track event listeners for cleanup
 */
function setupPriorityDisplaySync(modalEventListeners = []) {
    const prioritySelect = document.getElementById(SELECTORS.LOREBOOK_PRIORITY_SELECT);
    const priorityDisplay = document.getElementById('default-priority-display');

    if (prioritySelect && priorityDisplay) {
        const updatePriorityDisplay = () => {
            const selectedOption = prioritySelect.options[prioritySelect.selectedIndex];
            if (selectedOption) {
                // Extract just the display text (e.g., "5 - Highest Priority (Processes First)" -> "5 - Highest Priority")
                const displayText = selectedOption.textContent.replace(/ \(.*\)$/, '');
                priorityDisplay.textContent = displayText;
            }
        };

        prioritySelect.addEventListener('change', updatePriorityDisplay);

        // Track listener for cleanup
        modalEventListeners.push(
            { element: prioritySelect, event: 'change', handler: updatePriorityDisplay }
        );

        // Set initial display
        updatePriorityDisplay();
    }
}

/**
 * Set up simple drawer toggle behavior
 * @param {Array} modalEventListeners - Array to track event listeners for cleanup
 */
function setupDrawerBehavior(modalEventListeners = [], mountOverrides) {
    const drawer = document.querySelector('.stlo-advanced-drawer');
    const drawerIcon = drawer?.querySelector('.inline-drawer-icon');
    const drawerToggle = drawer?.querySelector('.inline-drawer-toggle');

    if (drawer && drawerIcon && drawerToggle) {
        const drawerToggleHandler = (e) => {
            e.preventDefault();
            if (drawer.classList.toggle('openDrawer')) mountOverrides();
            drawerIcon.classList.toggle('down');
            drawerIcon.classList.toggle('up');
        };

        drawerToggle.addEventListener('click', drawerToggleHandler);

        // Track listener for cleanup
        modalEventListeners.push(
            { element: drawerToggle, event: 'click', handler: drawerToggleHandler }
        );
    }
}

// Render budget controls (mode + value)
function createBudgetControls(scope, currentSettings = {}) {
    const mode = currentSettings.budgetMode || 'default';
    const value = (typeof currentSettings.budget === 'number' ? currentSettings.budget : (currentSettings.budget || 0));
    return `
        <div class="stlo-field-heading">
            <h4 data-i18n="stlo.budget.title">Budget</h4>
            <details class="stlo-info">
                <summary aria-label="설명 보기">i</summary>
                <div class="stlo-info-body">
                    <small data-i18n="stlo.budget.unifiedHelp">Maximum this book can inject. With Jev, this amount is also prioritized for relevant entries.</small>
                    <small data-i18n="stlo.budget.unifiedTip">Unused capacity is shared. All overall budgets still apply.</small>
                    <small>재귀 검색을 쓰면, 최종 주입에서 빠진 로어도 다른 로어를 불러오는 데 영향을 줄 수 있습니다.</small>
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
                <input type="number" id="${SELECTORS.LOREBOOK_BUDGET_VALUE}" class="text_pole textarea_compact"
                       value="${value || 0}" placeholder="0" style="width: 120px;">
                <details class="stlo-info"><summary aria-label="Help">i</summary><div class="stlo-info-body"><small id="${SELECTORS.LOREBOOK_BUDGET_VALUE_CONTAINER}-hint"></small></div></details>
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
function setupBudgetControls(modalEventListeners = [], currentSettings = {}) {
    const modeSelect = document.getElementById(SELECTORS.LOREBOOK_BUDGET_MODE);
    const valueContainer = document.getElementById(SELECTORS.LOREBOOK_BUDGET_VALUE_CONTAINER);
    const valueInput = document.getElementById(SELECTORS.LOREBOOK_BUDGET_VALUE);
    const hint = document.getElementById(`${SELECTORS.LOREBOOK_BUDGET_VALUE_CONTAINER}-hint`);

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
 * Generate advanced mode priority sections
 * @returns {string} HTML string for priority sections
 */
function generateAdvancedContent() {
    const priorityLevels = [
        { level: 5 },
        { level: 4 },
        { level: 3 },
        { level: 2 },
        { level: 1 }
    ];

    const createPrioritySection = (priority) => `
        <div class="priority-section world_entry_form_control MarginBot10" data-priority="${priority.level}">
            <div class="stlo-field-heading">
                <h4>${priority.level} - ${getPriorityName(priority.level)} ${translate('Priority', 'stlo.priority.label')}</h4>
                <details class="stlo-info"><summary aria-label="Help">i</summary><div class="stlo-info-body"><small>${getPriorityDescription(priority.level)}</small></div></details>
            </div>

            <div class="flex1 range-block MarginTop10">
                <div class="range-block-title">
                    <div class="flex-container justifySpaceBetween">
                        <small data-i18n="stlo.modal.groupOverrides.characters">Characters</small>
                    </div>
                </div>
                <div class="range-block-range">
                    <select class="override-character-filter text_pole textarea_compact"
                            id="priority-${priority.level}-characters"
                            data-priority="${priority.level}"
                            multiple>
                        <option value="" data-i18n="stlo.modal.groupOverrides.placeholderPopulated">-- Characters will be populated --</option>
                    </select>
                </div>
            </div>

            <div class="flex1 MarginTop10">
                <div class="stlo-option-line">
                    <label class="checkbox_label stlo-checkrow" for="override-order-adjustment-enabled-${priority.level}">
                        <input type="checkbox" id="override-order-adjustment-enabled-${priority.level}"
                               class="override-order-adjustment-enabled" data-priority="${priority.level}">
                        <span class="checkmark"></span>
                        <span data-i18n="stlo.modal.order.enableLabel">Enable Order Adjustment</span>
                    </label>
                    <details class="stlo-info"><summary aria-label="Help">i</summary><div class="stlo-info-body"><small data-i18n="stlo.modal.order.help">Fine-tune processing order within this priority level</small></div></details>
                </div>

                <div class="override-order-adjustment-container" data-priority="${priority.level}"
                     style="display: none;">
                    <div class="stlo-field-heading">
                        <h5 data-i18n="stlo.modal.order.title">Order Adjustment</h5>
                        <details class="stlo-info"><summary aria-label="Help">i</summary><div class="stlo-info-body"><small data-i18n="stlo.modal.order.explain">Higher values process first. Example: +250 for slight boost, -500 for lower priority.</small></div></details>
                    </div>
                    <div class="stlo-inline-number">
                        <input type="number" class="text_pole textarea_compact override-order-adjustment"
                               data-priority="${priority.level}" min="-10000" max="10000" step="1"
                               value="0" placeholder="0" style="width: 100px;">
                        <details class="stlo-info"><summary aria-label="Help">i</summary><div class="stlo-info-body"><small style="color: #888;" data-i18n="stlo.modal.order.range">-10k to +10k</small></div></details>
                    </div>
                </div>
            </div>
        </div>
    `;

    return priorityLevels.map(createPrioritySection).join('');
}

/**
 * Set up behavior for advanced mode
 * @param {Array} modalEventListeners - Array to track event listeners for cleanup
 * @param {Object} currentSettings - Current lorebook settings
 */
function setupAdvancedBehavior(modalEventListeners = [], currentSettings = {}) {
    const advancedSectionsContainer = document.getElementById('advanced-priority-sections');
    if (!advancedSectionsContainer || advancedSectionsContainer.childElementCount) return;
    advancedSectionsContainer.innerHTML = generateAdvancedContent();
    applyLocale(advancedSectionsContainer);

    // Set up override behavior for all priority levels
    setupOverrideBehavior(modalEventListeners);

    // Populate character selectors
    populateCharacterSelectors();

    // Initialize Select2
    initializeSelect2();

    // Populate saved character overrides
    populateCharacterOverrides(currentSettings.characterOverrides || {});
}

/**
 * Set up override behavior for character-specific priority settings
 * @param {Array} modalEventListeners - Array to track event listeners for cleanup
 */
function setupOverrideBehavior(modalEventListeners = []) {
    const priorityLevels = [1, 2, 3, 4, 5];

    for (const priority of priorityLevels) {
        // Order adjustment behavior
        const orderAdjustmentEnabled = document.querySelector(`.override-order-adjustment-enabled[data-priority="${priority}"]`);
        const orderAdjustmentContainer = document.querySelector(`.override-order-adjustment-container[data-priority="${priority}"]`);
        const orderAdjustmentInput = document.querySelector(`.override-order-adjustment[data-priority="${priority}"]`);

        if (orderAdjustmentEnabled && orderAdjustmentContainer && orderAdjustmentInput) {
            const orderAdjustmentChangeHandler = () => {
                if (orderAdjustmentEnabled.checked) {
                    orderAdjustmentContainer.style.display = 'block';
                    if (orderAdjustmentInput.value === '' || orderAdjustmentInput.value === '0') {
                        orderAdjustmentInput.value = '0';
                    }
                } else {
                    orderAdjustmentContainer.style.display = 'none';
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
    }
}

/**
 * Populate character selectors with available characters
 */
function populateCharacterSelectors() {
    const context = getContext();
    const characters = context?.characters || [];

    const priorityLevels = [1, 2, 3, 4, 5];

    for (const priority of priorityLevels) {
        const selector = document.querySelector(`.override-character-filter[data-priority="${priority}"]`);
        if (selector) {
            // Clear existing options except the placeholder
            selector.innerHTML = '';

            // Add default option
            if (characters.length === 0) {
                const defaultOption = document.createElement('option');
                defaultOption.value = '';
                defaultOption.textContent = translate('-- No characters found --', 'stlo.modal.groupOverrides.noChars');
                selector.appendChild(defaultOption);
            } else {
                const defaultOption = document.createElement('option');
                defaultOption.value = '';
                defaultOption.textContent = translate('-- Select characters --', 'stlo.modal.groupOverrides.placeholderSelect');
                selector.appendChild(defaultOption);

                // Add character options
                characters.forEach((character) => {
                    const option = document.createElement('option');
                    const name = (character?.avatar?.replace(/\.[^/.]+$/, '') || character?.name || '');
                    option.value = name;
                    option.textContent = name;
                    option.setAttribute('data-type', 'character');
                    selector.appendChild(option);
                });
            }
        }
    }
}

/**
 * Populate character overrides from saved settings
 * @param {Object} characterOverrides - Saved character overrides
 */
function populateCharacterOverrides(characterOverrides = {}) {
    // Iterate through saved overrides and populate the form
    Object.entries(characterOverrides).forEach(([character, settings]) => {
        const priority = settings.priority;
        if (!priority || priority < 1 || priority > 5) return;

        // Find the character selector for this priority level
        const characterSelect = document.querySelector(`.override-character-filter[data-priority="${priority}"]`);
        if (characterSelect) {
            // Add the character to the selection
            $(characterSelect).val([...($(characterSelect).val() || []), character]).trigger('change');

            // Set order adjustment if it exists and is not 0
            if (settings.orderAdjustment !== undefined && settings.orderAdjustment !== 0) {
                const orderAdjustmentEnabled = document.querySelector(`.override-order-adjustment-enabled[data-priority="${priority}"]`);
                const orderAdjustmentInput = document.querySelector(`.override-order-adjustment[data-priority="${priority}"]`);
                const orderAdjustmentContainer = document.querySelector(`.override-order-adjustment-container[data-priority="${priority}"]`);

                if (orderAdjustmentEnabled) {
                    orderAdjustmentEnabled.checked = true;
                    // Trigger change event to update UI
                    orderAdjustmentEnabled.dispatchEvent(new Event('change'));
                }

                if (orderAdjustmentInput) {
                    orderAdjustmentInput.value = settings.orderAdjustment;
                }

                if (orderAdjustmentContainer) {
                    orderAdjustmentContainer.style.display = 'block';
                }
            }
        }
    });
}

/**
 * Initialize Select2 for character selectors in override popup
 */
function initializeSelect2() {
    const priorityLevels = [1, 2, 3, 4, 5];

    for (const priority of priorityLevels) {
        const selector = document.querySelector(`.override-character-filter[data-priority="${priority}"]`);
        if (selector && typeof $ === 'function' && $.fn?.select2 && $(selector).length) {
            $(selector).select2({
                width: '100%',
                placeholder: translate('Select characters for this priority level...', 'stlo.modal.groupOverrides.selectPlaceholder'),
                allowClear: true,
                closeOnSelect: false,
                dropdownParent: $(selector).closest('.popup-content, .popup-body, [role="dialog"]').first()
            });
        }
    }
}

/**
 * Get character overrides from form
 * @returns {Object} Character overrides object
 */
function getCharacterOverrides() {
    const overrides = {};
    const characterAssignments = {}; // Track which priorities each character is assigned to
    const prioritySections = document.querySelectorAll('.priority-section');

    prioritySections.forEach(section => {
        const priority = section.getAttribute('data-priority');
        const characterSelect = section.querySelector('select[data-priority="' + priority + '"].override-character-filter');

        if (characterSelect && characterSelect.value) {
            const selectedChars = $(characterSelect).val() || [];

            selectedChars.forEach(chid => {
                // Track priority assignments for duplicate detection
                if (!characterAssignments[chid]) {
                    characterAssignments[chid] = [];
                }
                characterAssignments[chid].push(parseInt(priority));

                // Get order adjustment values
                const orderAdjustmentEnabled = section.querySelector(`input[data-priority="${priority}"].override-order-adjustment-enabled`);
                const orderAdjustmentInput = section.querySelector(`input[data-priority="${priority}"].override-order-adjustment`);
                const orderAdjustment = (orderAdjustmentEnabled && orderAdjustmentEnabled.checked && orderAdjustmentInput)
                    ? parseInt(orderAdjustmentInput.value) || 0
                    : 0;

                overrides[chid] = {
                    priority: parseInt(priority),
                    orderAdjustment: orderAdjustment
                };
            });
        }
    });

    // Check for duplicates and block saving if found
    const duplicates = Object.entries(characterAssignments).filter(([chid, priorities]) => priorities.length > 1);

    if (duplicates.length > 0) {
        const context = getContext();
        const duplicateMessages = duplicates.map(([chid, priorities]) => {
            const char = context?.characters?.find(c => ((c?.avatar?.replace(/\.[^/.]+$/, '')) || c?.name) === chid);
            const charName = char?.name || chid;
            const priorityNames = priorities.map(p => `${p} - ${getPriorityName(p)}`).join(', ');
            return `• ${charName}: assigned to priorities ${priorityNames}`;
        });

        const errorMessage = `Cannot save: Characters assigned to multiple priority levels.\n\n${duplicateMessages.join('\n')}\n\nPlease assign each character to only one priority level.`;

        toastr.error(errorMessage, 'Duplicate Character Assignments', { timeOut: 8000 });
        return null; // Return null to indicate validation failure
    }

    return overrides;
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
 * Get priority level description for display
 * @param {number} priority - Priority level (1-5)
 * @returns {string} Priority description
 */
function getPriorityDescription(priority) {
    const descriptions = {
        5: translate('Processes first', 'stlo.priority.desc.5'),
        4: translate('High priority processing', 'stlo.priority.desc.4'),
        3: translate('Standard priority (SillyTavern default)', 'stlo.priority.desc.3'),
        2: translate('Lower priority processing', 'stlo.priority.desc.2'),
        1: translate('Processes last', 'stlo.priority.desc.1')
    };
    return descriptions[priority] || 'Unknown';
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
            if (configured(settings?.budgetMode, settings?.budget)
                || Object.values(settings?.characterOverrides || {}).some(override =>
                    configured(override?.budgetMode, override?.budget))) {
                budgetWorlds.add(world);
            }
        }
        EXTENSION_STATE.scanBudgetWorlds = budgetWorlds;
        EXTENSION_STATE.scanHasExplicitBudgets = budgetWorlds.size > 0;

        const processedEntries = [];
        let skippedOnlyWhenSpeaking = 0;

        for (const entry of allEntries) {
            try {
                if (!entry?.world) {
                    const originalOrder = Math.min(entry?.order ?? 100, 9999);
                    entry.order = PRIORITY_LEVELS.DEFAULT * 10000 + originalOrder;
                    processedEntries.push(entry);
                    continue;
                }

                const settings = settingsCache.get(entry.world) || {};

                // FILTERING: onlyWhenSpeaking applies only in group chats (i.e., when a speaker is drafted)
                if (settings.onlyWhenSpeaking && EXTENSION_STATE.currentSpeakingCharacter) {
                    const hasOverride = settings.characterOverrides
                        ? Object.prototype.hasOwnProperty.call(settings.characterOverrides, EXTENSION_STATE.currentSpeakingCharacter)
                        : false;
                    if (!hasOverride) {
                        skippedOnlyWhenSpeaking++;
                        continue;
                    }
                }

                // PRIORITY
                let priority = settings.priority ?? PRIORITY_LEVELS.DEFAULT;
                let orderAdjustment = settings.orderAdjustment ?? 0;

                // Character overrides in group chat
                if (EXTENSION_STATE.currentSpeakingCharacter && settings.characterOverrides) {
                    const override = settings.characterOverrides[EXTENSION_STATE.currentSpeakingCharacter];
                    if (override) {
                        priority = override.priority ?? priority;
                        orderAdjustment = override.orderAdjustment ?? orderAdjustment;
                    }
                }

                // Group-only adjustment
                if (settings.orderAdjustmentGroupOnly && !EXTENSION_STATE.currentSpeakingCharacter) {
                    orderAdjustment = 0;
                }

                const originalOrder = Math.min(entry.order ?? 100, 9999);
                entry.order = priority * 10000 + orderAdjustment + originalOrder;

                processedEntries.push(entry);
            } catch (innerErr) {
                console.warn(`Error setting priority for entry from ${entry?.world}:`, innerErr);
                processedEntries.push(entry);
            }
        }

        // Always-on entries must reserve their place before vector/keyword
        // entries, regardless of their lorebook priority. Keep the relative
        // priority/order of entries within each group unchanged.
        if (getProtectAlwaysOn()) {
            let lowestConstant = Infinity;
            let highestOther = -Infinity;
            for (const entry of processedEntries) {
                if (entry?.constant === true) {
                    lowestConstant = Math.min(lowestConstant, entry.order);
                } else {
                    highestOther = Math.max(highestOther, entry.order);
                }
            }
            if (Number.isFinite(lowestConstant) && Number.isFinite(highestOther)) {
                const boost = Math.max(0, highestOther - lowestConstant + 1);
                if (boost > 0) {
                    for (const entry of processedEntries) {
                        if (entry?.constant === true) entry.order += boost;
                    }
                }
            }
        }

        // Core SillyTavern gives active Sticky entries precedence over Order.
        // Temporarily bypass its early budget check for eligible constants so
        // Sticky cannot use their space first. The scan-done handler enforces
        // the actual total WI budget and original per-book limits afterward.
        // Only scan-local entry clones are touched, never saved lorebook data.
        // Without any Sticky-configured entries, native Order already puts
        // constants first. Avoid bypassing core budgeting unnecessarily.
        const hasStickyCandidates = processedEntries.some(entry =>
            entry?.disable !== true && Number(entry?.sticky) > 0);
        if (HAS_WORLDINFO_SCAN_DONE && getProtectAlwaysOn() && hasStickyCandidates) {
            for (const entry of processedEntries) {
                if (entry?.constant === true && entry.disable !== true && entry.ignoreBudget !== true) {
                    entry.__stloReservedConstant = true;
                    entry.ignoreBudget = true;
                }
            }
        }

        // Sort processed entries by new order (highest first) with deterministic tie-breakers
        processedEntries.sort((a, b) => {
            const ao = (a?.order ?? 100);
            const bo = (b?.order ?? 100);
            if (bo !== ao) return bo - ao;
            const au = (a?.uid ?? 0);
            const bu = (b?.uid ?? 0);
            if (au !== bu) return au - bu;
            const aw = String(a?.world ?? '');
            const bw = String(b?.world ?? '');
            if (aw !== bw) return aw.localeCompare(bw);
            return 0;
        });

        // Rebuild arrays: everything into globalLore
        gl.length = 0;
        cl.length = 0;
        chat.length = 0;
        persona.length = 0;
        gl.push(...processedEntries);

        if (DEBUG_STLO) {
            stloDebug('applyPriorityOrdering summary:', { processed: processedEntries.length, skippedOnlyWhenSpeaking });
        }
    } catch (error) {
        console.error('Error applying priority ordering:', error);
    }
}

/**
 * Budget pre-scan enforcement: disable overflow entries based on total WI budget.
 * Runs at WORLDINFO_ENTRIES_LOADED, before the core scan loop. This allows budget
 * enforcement without modifying base code. Ignores entries with ignoreBudget=true.
 */
async function enforceBudgetPreScan(eventData) {
    try {
        const { globalLore = [], characterLore = [], chatLore = [], personaLore = [] } = eventData || {};
        // After applyPriorityOrdering, everything resides in globalLore; keep defensive support for others.
        const ordered = [
            ...(globalLore || []),
            ...(characterLore || []),
            ...(chatLore || []),
            ...(personaLore || []),
        ];

        const totalBudget = calculateTotalWIBudget();
        if (!(totalBudget > 0)) return;

        let used = 0;
        for (const e of ordered) {
            if (!e) continue;
            if (e.ignoreBudget === true) continue; // keep without consuming budget
            const tokens = await getEntryTokenCountCached(e);
            if ((used + tokens) <= totalBudget) {
                used += tokens;
            } else {
                e.disable = true; // respected by core checkWorldInfo
            }
        }
    } catch (err) {
        console.warn('[STLO] enforceBudgetPreScan error:', err);
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
                console.warn('[STLO] This SillyTavern version lacks WORLDINFO_SCAN_DONE. Per-book budget trimming is unavailable without unsafe prompt edits.');
            }

        } catch (error) {
            console.error('Failed to load STLO extension:', error);
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
        console.warn('[STLO] calculateTotalWIBudget error:', e);
        return 0;
    }
}

// Resolve per-lorebook token budget by mode (default | %budget | %context | fixed)
// Applies character-specific overrides when present
async function calculateLorebookBudget(settings, totalBudget) {
    try {
        const usableContext = Number(typeof getMaxContextSize === 'function' ? getMaxContextSize() : 0);

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
        console.warn('[STLO] calculateLorebookBudget error:', e);
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
        console.warn('[STLO] Failed to register budget reset handlers:', e);
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
                    if (run?.selection && args?.state?.next === 0) recordJevActivated([]);
                    return;
                }

                const protect = getProtectAlwaysOn();
                const jev = jevGeneration?.selection;
                const settingsCache = EXTENSION_STATE.scanWorldSettings;
                let reserved = false;
                let hasUnknownWorld = false;
                for (const entry of entries.values()) {
                    if (entry && Object.hasOwn(entry, '__stloJevInsertionOrder')) {
                        entry.order = entry.__stloJevInsertionOrder;
                        delete entry.__stloJevInsertionOrder;
                    }
                    if (protect && entry?.__stloReservedConstant === true) reserved = true;
                    if (entry?.world && !settingsCache.has(entry.world)) hasUnknownWorld = true;
                }
                if (!reserved && !EXTENSION_STATE.scanHasExplicitBudgets && !hasUnknownWorld && !jev?.accepted.size) {
                    return; // Nothing to trim; no setting lookups, tokenization, or text rewrites.
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
                const discard = ({ key, entry }) => {
                    if (!entries.has(key)) return;
                    entries.delete(key);
                    entry.disable = true; // Keep a dropped entry out of recursion rescans.
                    dropped++;
                };
                const orderDescending = (a, b) => (b.entry.order ?? 100) - (a.entry.order ?? 100);
                const recallOrder = (a, b) => {
                    const aRank = jev?.accepted.get(jevEntryKey(a.entry));
                    const bRank = jev?.accepted.get(jevEntryKey(b.entry));
                    return (aRank ?? -1) - (bRank ?? -1) || orderDescending(a, b);
                };
                const originallyIgnored = e =>
                    e.ignoreBudget === true && e.__stloReservedConstant !== true;

                // Preserve ordinary per-book ordering. Spend the remaining
                // budget on Jev picks in relevance order.
                if (EXTENSION_STATE.scanHasExplicitBudgets || hasUnknownWorld) {
                    for (const [world, list] of byWorld) {
                        if (settingsCache.has(world) && !EXTENSION_STATE.scanBudgetWorlds.has(world)) {
                            continue; // A default-budget book needs no trimming.
                        }
                        const settings = settingsCache.get(world) ?? await getLorebookSettings(world);
                        const perBudget = await calculateLorebookBudget(settings, totalBudget);
                        if (!(perBudget > 0)) continue;

                        const native = [];
                        const selected = [];
                        for (const item of list) {
                            const target = jev?.accepted.has(jevEntryKey(item.entry)) ? selected : native;
                            target.push(item);
                        }
                        let sorted;
                        if (protect) {
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
                            const tokens = await getEntryTokenCountCached(item.entry);
                            if (used + tokens <= perBudget) used += tokens;
                            else discard(item);
                        }
                    }
                }

                // Global budget reconciliation is needed only when this scan
                // actually bypassed core budgeting to protect a constant entry.
                if (reserved && totalBudget > 0) {
                    const timed = args?.timedEffects;
                    // Cache the native Sticky status once per active entry.
                    // Calling isEffectActive inside sort() would repeatedly scan
                    // the sticky-effect buffer for every comparison.
                    const active = [...entries].map(([key, entry]) => {
                        let sticky = 0;
                        if (entry.constant !== true) {
                            try { sticky = timed?.isEffectActive?.('sticky', entry) ? 1 : 0; }
                            catch { /* Keep the original Order fallback. */ }
                        }
                        return { key, entry, sticky };
                    });
                    active.sort((a, b) => {
                        if (a.entry.constant !== b.entry.constant) {
                            return a.entry.constant === true ? -1 : 1;
                        }
                        if (a.entry.constant !== true) {
                            const stickyDiff = b.sticky - a.sticky;
                            if (stickyDiff) return stickyDiff;
                        }
                        return a.entry.constant === true ? orderDescending(a, b) : recallOrder(a, b);
                    });
                    let used = 0;
                    for (const item of active) {
                        if (originallyIgnored(item.entry)) continue;
                        const tokens = await getEntryTokenCountCached(item.entry);
                        if (used + tokens <= totalBudget) used += tokens;
                        else discard(item);
                    }
                }

                if (jev?.accepted.size) {
                    let used = 0;
                    const selected = [];
                    for (const [key, entry] of entries) {
                        if (!jev.worlds.has(entry.world) || entry.outletName || Number(entry.position) === 7) continue;
                        if (entry.constant === true) used += await getEntryTokenCountCached(entry);
                        else if (jev.accepted.has(jevEntryKey(entry))) selected.push({ key, entry });
                    }
                    for (const item of selected.sort(recallOrder)) {
                        const tokens = await getEntryTokenCountCached(item.entry);
                        if (used + tokens <= jev.budget) used += tokens;
                        else discard(item);
                    }
                }

                // The core builds the final prompt from activated.entries.
                // Its recursion buffer was already assembled before this hook,
                // so editing activated.text would not undo a recursion trigger.
                // Leave all text untouched rather than deleting a kept entry
                // or unrelated system instruction that has matching content.
                if (dropped) stloDebug('Trimmed WI entries structurally:', dropped);
                if (run?.selection && args?.state?.next === 0) recordJevActivated([...entries.values()]);
            } catch (e) {
                console.warn('[STLO] per-loop budget trimmer error:', e);
            }
        };

        eventSource.on(event_types.WORLDINFO_SCAN_DONE, onScanDone);
        eventListeners.push({ source: eventSource, event: event_types.WORLDINFO_SCAN_DONE, handler: onScanDone });
    } catch (e) {
        console.warn('[STLO] Failed to register per-loop budget trimmer:', e);
    }
}
