import { event_types, eventSource } from '../../../events.js';
import { getTokenCount } from '../../../tokenizers.js';
import { getStringHash, getCharaFilename } from '../../../utils.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { characters, this_chid, getMaxContextSize, saveSettingsDebounced } from '../../../../script.js';
import { loadWorldInfo, saveWorldInfo, worldInfoCache, world_info, world_info_character_strategy, world_info_insertion_strategy, world_info_budget, world_info_budget_cap, world_names } from '../../../world-info.js';
import { POPUP_TYPE, Popup } from '../../../popup.js';
import { addLocaleData, getCurrentLocale, translate, t, applyLocale } from '../../../i18n.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';

const EXTENSION_NAME = 'stlo';
const SELECTORS = {
    WORLD_EDITOR_SELECT: '#world_editor_select',
    LOREBOOK_PRIORITY_SELECT: 'lorebook_priority_select',
    LOREBOOK_BUDGET_MODE: 'lorebook_budget_mode',
    LOREBOOK_BUDGET_VALUE: 'lorebook_budget_value',
    LOREBOOK_BUDGET_VALUE_CONTAINER: 'lorebook_budget_value_container',
    LOREBOOK_RANDOM_TRIM: 'lorebook_random_trim',
    LOREBOOK_VECTOR_THRESHOLD: 'lorebook_vector_threshold',
    PROTECT_ALWAYS_ON: 'stlo_protect_always_on'
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
    vectorThresholdEnabled: false // opt-in: old saved thresholds must not silently reactivate paid calls
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
    try {
        if (!entry || typeof entry !== 'object') return 0;
        const content = typeof entry.content === 'string' ? entry.content : '';
        const cached = TOKEN_COUNT_CACHE.get(entry);
        if (cached && cached.content === content) return cached.tokens;

        const tokens = Number(getTokenCount(content)) || 0;
        TOKEN_COUNT_CACHE.set(entry, { content, tokens });
        return tokens;
    } catch {
        return 0;
    }
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
        const candidates = [current, base, 'en'];
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

        console.info('[STLO i18n] current locale:', current, 'candidates:', candidates.join(', '));
        for (const code of candidates) {
            try {
                const url = new URL(`./locales/${code}.json`, EXT_BASE_URL);
                console.info('[STLO i18n] trying locale file:', url.href, `(timeout ${TIMEOUT_MS}ms)`);
                const res = await fetchWithTimeout(url, TIMEOUT_MS);
                if (res && res.ok) {
                    const data = await res.json();
                    addLocaleData(current, data);
                    console.info('[STLO i18n] loaded locale data for:', code, 'merged into:', current);
                    // Quick sanity check: this should print the localized value (e.g., Chinese) when locale is zh-cn
                    const sample = translate('Configure STLO Priority & Budget', 'stlo.button.configure');
                    console.info('[STLO i18n] sample stlo.button.configure =', sample);
                    break; // first available wins
                } else {
                    console.info('[STLO i18n] not found or not ok for:', code, 'status:', res?.status);
                }
            } catch (e) {
                if (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR')) {
                    console.info('[STLO i18n] timeout while trying code:', code, '— moving to next candidate');
                } else {
                    console.info('[STLO i18n] error while trying code:', code, e);
                }
                // ignore and try next
            }
        }
        // Re-apply locale so existing DOM picks up newly injected keys
        try {
            applyLocale();
            console.info('[STLO i18n] applyLocale() completed');
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
                console.info('[STLO i18n] window not available to expose stloI18nStatus:', e2);
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

    // Track for cleanup
    eventListeners.push(
        { source: eventSource, event: event_types.WORLDINFO_ENTRIES_LOADED, handler: handler },
        { source: eventSource, event: event_types.CHAT_CHANGED, handler: chatChangedHandler },
        { source: eventSource, event: event_types.GROUP_MEMBER_DRAFTED, handler: groupMemberDraftedHandler }
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
        .stlo-modal-ui .stlo-info > summary { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; box-sizing: border-box; border: 0; border-radius: 50%; font-size: 0; line-height: 1; opacity: .8; list-style: none; cursor: pointer; user-select: none; }
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
            .stlo-modal-ui .stlo-section { gap: 4px; padding-bottom: 8px; }
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
    if (!menu || document.getElementById('stlo_budget_menu_item')) return;
    const container = document.createElement('div');
    container.className = 'extension_container';
    const item = document.createElement('div');
    item.id = 'stlo_budget_menu_item';
    item.className = 'list-group-item flex-container flexGap5';
    const icon = document.createElement('div');
    icon.className = 'fa-solid fa-book extensionsMenuExtensionButton';
    const label = document.createElement('span');
    label.textContent = '로어북 예산 관리';
    item.append(icon, label);
    item.addEventListener('click', openLorebookBudgetFromMenu);
    container.appendChild(item);
    menu.appendChild(container);
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
        // In newer branches (with WORLDINFO_SCAN_DONE), we trim per-loop and skip pre-scan entirely.
        if (!HAS_WORLDINFO_SCAN_DONE) {
            await enforceBudgetPreScan(eventData);
        }
    } catch (error) {
        console.warn('[STLO] handleWorldInfoEntriesLoaded error:', error);
    }
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
            // StructuredCloneMap.get() clones the whole lorebook. Read the
            // underlying Map value without mutating it; only copy STLO settings.
            const worldData = worldInfoCache instanceof Map
                ? Map.prototype.get.call(worldInfoCache, worldName)
                : worldInfoCache.get(worldName);
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
        const currentSettings = await getLorebookSettings(currentLorebook);

        // Create modal HTML - single vertical scrolling content
        const modalHtml = `
            <div class="stlo-modal-ui">
            <div class="world_entry_form_control stlo-section">
                <h3 data-i18n="stlo.modal.title">📚 ST Lorebook Ordering</h3>
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
                        <label class="checkbox_label stlo-checkrow" for="${SELECTORS.PROTECT_ALWAYS_ON}">
                        <input type="checkbox" id="${SELECTORS.PROTECT_ALWAYS_ON}"
                               ${getProtectAlwaysOn() ? 'checked' : ''}>
                        <span class="checkmark"></span>
                        <span>상시 주입 우선 보호</span>
                    </label>
                    <details class="stlo-info stlo-info-end">
                        <summary aria-label="설명 보기">i</summary>
                        <div class="stlo-info-body"><small>모든 로어북에 적용됩니다. 상시 항목을 먼저 넣고, 예산이 부족하면 상시 항목도 순서대로 제외합니다.</small></div>
                    </details>
                    </div>
                </div>
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
                        <small style="color: #888;" data-i18n="stlo.modal.order.range">-10k to +10k</small>
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
                    <div class="info-block warning MarginBot10">
                        <small data-i18n="stlo.modal.groupOverrides.info">If a character is selected in here, the priority settings here will override the lorebook's default setting only during that character's speaking turns in a group chat.</small>
                    </div>
                    <div class="info-block MarginBot10">
                        <h4><span data-i18n="stlo.modal.groupOverrides.defaultPriority.title">Default Priority:</span> <span id="default-priority-display" data-i18n="stlo.modal.groupOverrides.defaultPriority.value">3 - Normal</span></h4>
                        <small data-i18n="stlo.modal.groupOverrides.defaultPriority.help">Characters not specifically listed will use the priority level set above. Single-character chats always use the default.</small>
                    </div>
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
                const protectAlwaysOnInput = document.getElementById(SELECTORS.PROTECT_ALWAYS_ON);

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
                        vectorThreshold: vectorThresholdInput?.value ?? '',
                        protectAlwaysOn: Boolean(protectAlwaysOnInput?.checked),
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
                const characterOverrides = getCharacterOverrides();
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
                setupModalBehavior(modalEventListeners, currentSettings);
            });
        });

        // Save the settings if we got them
        if (result) {
            try {
                const { protectAlwaysOn, ...lorebookSettings } = result;
                const saved = await setLorebookSettings(currentLorebook, lorebookSettings);

                if (saved) {
                    setProtectAlwaysOn(protectAlwaysOn);
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

    // Set up Group Chat Overrides behavior
    setupAdvancedBehavior(modalEventListeners, currentSettings);
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
function setupDrawerBehavior(modalEventListeners = []) {
    const drawer = document.querySelector('.inline-drawer');
    const drawerIcon = document.querySelector('.inline-drawer-icon');
    const drawerToggle = document.querySelector('.inline-drawer-toggle');

    if (drawer && drawerIcon && drawerToggle) {
        const drawerToggleHandler = (e) => {
            e.preventDefault();
            drawer.classList.toggle('openDrawer');
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
                    <small data-i18n="stlo.budget.help">Control how much of the context or World Info budget this lorebook may use.</small>
                    <small data-i18n="stlo.budget.tip">Tip: default (0) lets ST decide; Fixed with 1 effectively chokes off this lorebook.</small>
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
                <small id="${SELECTORS.LOREBOOK_BUDGET_VALUE_CONTAINER}-hint"></small>
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
            <h4>${priority.level} - ${getPriorityName(priority.level)} ${translate('Priority', 'stlo.priority.label')}</h4>
            <small>${getPriorityDescription(priority.level)}</small>

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
                <label class="checkbox_label" for="override-order-adjustment-enabled-${priority.level}">
                    <input type="checkbox" id="override-order-adjustment-enabled-${priority.level}"
                           class="override-order-adjustment-enabled" data-priority="${priority.level}">
                    <span class="checkmark"></span>
                    <span data-i18n="stlo.modal.order.enableLabel">Enable Order Adjustment</span>
                </label>
                <small data-i18n="stlo.modal.order.help">Fine-tune processing order within this priority level</small>

                <div class="override-order-adjustment-container" data-priority="${priority.level}"
                     style="display: none;">
                    <h5 data-i18n="stlo.modal.order.title">Order Adjustment</h5>
                    <div class="stlo-inline-number">
                        <input type="number" class="text_pole textarea_compact override-order-adjustment"
                               data-priority="${priority.level}" min="-10000" max="10000" step="1"
                               value="0" placeholder="0" style="width: 100px;">
                        <small style="color: #888;" data-i18n="stlo.modal.order.range">-10k to +10k</small>
                    </div>
                    <small data-i18n="stlo.modal.order.explain">Higher values process first. Example: +250 for slight boost, -500 for lower priority.</small>
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
    // Generate and insert advanced content first
    const advancedSectionsContainer = document.getElementById('advanced-priority-sections');
    if (advancedSectionsContainer) {
        advancedSectionsContainer.innerHTML = generateAdvancedContent();
    }

    // Set up priority display sync
    setupPriorityDisplaySync(modalEventListeners);

    // Set up drawer behavior
    setupDrawerBehavior(modalEventListeners);

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
            const tokens = getEntryTokenCountCached(e);
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
function calculateTotalWIBudget() {
    try {
        const usableContext = Number(typeof getMaxContextSize === 'function' ? getMaxContextSize() : 0);
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
                const entries = args?.activated?.entries;
                if (!(entries instanceof Map) || entries.size === 0) return;

                const protect = getProtectAlwaysOn();
                const settingsCache = EXTENSION_STATE.scanWorldSettings;
                let reserved = false;
                let hasUnknownWorld = false;
                for (const entry of entries.values()) {
                    if (protect && entry?.__stloReservedConstant === true) reserved = true;
                    if (entry?.world && !settingsCache.has(entry.world)) hasUnknownWorld = true;
                    if (reserved && hasUnknownWorld) break;
                }
                if (!reserved && !EXTENSION_STATE.scanHasExplicitBudgets && !hasUnknownWorld) {
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
                const originallyIgnored = e =>
                    e.ignoreBudget === true && e.__stloReservedConstant !== true;

                // Preserve existing per-book modes, including character overrides
                // and randomTrim, but consume budget from constants first if ON.
                if (EXTENSION_STATE.scanHasExplicitBudgets || hasUnknownWorld) {
                    for (const [world, list] of byWorld) {
                        if (settingsCache.has(world) && !EXTENSION_STATE.scanBudgetWorlds.has(world)) {
                            continue; // A default-budget book needs no trimming.
                        }
                        const settings = settingsCache.get(world) ?? await getLorebookSettings(world);
                        const perBudget = await calculateLorebookBudget(settings, totalBudget);
                        if (!(perBudget > 0)) continue;

                        let sorted;
                        if (protect) {
                            const always = list.filter(x => x.entry.constant === true).sort(orderDescending);
                            const optional = list.filter(x => x.entry.constant !== true);
                            if (settings.randomTrim) shuffleInPlace(optional);
                            else optional.sort(orderDescending);
                            sorted = [...always, ...optional];
                        } else {
                            sorted = list.slice();
                            if (settings.randomTrim) shuffleInPlace(sorted);
                            else sorted.sort(orderDescending);
                        }

                        let used = 0;
                        for (const item of sorted) {
                            if (originallyIgnored(item.entry)) continue;
                            const tokens = getEntryTokenCountCached(item.entry);
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
                        return orderDescending(a, b);
                    });
                    let used = 0;
                    for (const item of active) {
                        if (originallyIgnored(item.entry)) continue;
                        const tokens = getEntryTokenCountCached(item.entry);
                        if (used + tokens <= totalBudget) used += tokens;
                        else discard(item);
                    }
                }

                // The core builds the final prompt from activated.entries.
                // Its recursion buffer was already assembled before this hook,
                // so editing activated.text would not undo a recursion trigger.
                // Leave all text untouched rather than deleting a kept entry
                // or unrelated system instruction that has matching content.
                if (dropped) stloDebug('Trimmed WI entries structurally:', dropped);
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
