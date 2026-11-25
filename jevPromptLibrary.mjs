// Jev's prompt library is staged in the settings dialog. The generation engine
// still consumes the same normalized {preset, prompt} options as before.
import { JEV_PRESETS, normalizeJevOptions } from './jevRecall.mjs';

const BUILTIN = 'builtin';
const validText = text => typeof text === 'string' && !!text.trim();
const validName = name => typeof name === 'string' && !!name.trim() && name.length <= 80 && !/[\r\n]/u.test(name);
const uniqueName = (name, records) => {
    const base = String(name).trim().replace(/[\r\n]+/g, ' ').slice(0, 72);
    let candidate = base;
    for (let i = 2; records.some(r => r.name.toLocaleLowerCase() === candidate.toLocaleLowerCase()); i++) candidate = base + ' (' + i + ')';
    return candidate;
};
const newId = () => 'jev-' + Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join('-');

export function createJevPromptLibrary(rawOptions, stored = {}, labels = {}, makeId = newId) {
    const options = normalizeJevOptions(rawOptions);
    const records = [];
    for (const record of Array.isArray(stored?.presets) ? stored.presets : []) {
        if (typeof record?.id !== 'string' || !record.id || record.id === BUILTIN || !validName(record.name) || !validText(record.text) || records.some(r => r.id === record.id)) continue;
        records.push({ id: record.id, name: record.name, text: record.text });
    }
    const defaultName = labels.defaultName || 'Default prompt';
    const builtin = { id: BUILTIN, name: defaultName, builtin: true };
    let preset = options.preset;
    let selected = BUILTIN;
    const drafts = new Map();
    // The previously applied text is authoritative, even if older code wrote
    // the options directly or a library record no longer matches it.
    if (options.prompt) {
        let record = records.find(r => r.id === stored?.selectedId && r.text.trim() === options.prompt)
            || records.find(r => r.text.trim() === options.prompt);
        if (!record) {
            const id = makeId();
            record = { id, name: uniqueName(labels.previousName || 'Previous prompt', [builtin, ...records]), text: options.prompt };
            records.push(record);
        }
        selected = record.id;
    }
    const current = () => selected === BUILTIN ? { ...builtin, text: JEV_PRESETS[preset] } : records.find(r => r.id === selected);
    const text = () => drafts.get(selected) ?? current().text;
    const nameAvailable = (name, except) => validName(name) && ![builtin, ...records].some(r => r.id !== except && r.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    const choose = id => {
        if (id === BUILTIN || records.some(r => r.id === id)) selected = id;
    };
    const chooseBuiltin = value => { if (Object.hasOwn(JEV_PRESETS, value)) { preset = value; selected = BUILTIN; } };
    const edit = value => { if (selected !== BUILTIN) drafts.set(selected, value); };
    const save = () => {
        if (selected === BUILTIN || !validText(text())) return false;
        current().text = text();
        drafts.delete(selected);
        return true;
    };
    const add = (name, value = text()) => {
        if (!nameAvailable(name) || !validText(value)) return false;
        const id = makeId();
        records.push({ id, name, text: value });
        selected = id;
        return true;
    };
    const rename = name => {
        if (selected === BUILTIN || !nameAvailable(name, selected)) return false;
        current().name = name;
        return true;
    };
    const remove = () => {
        if (selected === BUILTIN) return false;
        records.splice(records.findIndex(r => r.id === selected), 1);
        drafts.delete(selected);
        selected = BUILTIN;
        return true;
    };
    const importRecord = data => {
        if (data?.format !== 'stlo-jev-prompt' || data.version !== 1 || typeof data.name !== 'string' || !data.name.trim() || !validText(data.text)) return false;
        return add(uniqueName(data.name, [builtin, ...records]), data.text);
    };
    const snapshot = () => {
        // Outer Save Settings is the transaction boundary, including edits
        // made to other presets while trying them out. Cancel writes nothing.
        if ([...drafts.values()].some(value => !validText(value))) return null;
        const presets = records.map(r => ({ ...r, text: (drafts.get(r.id) ?? r.text).trim() }));
        return {
            preset, prompt: selected === BUILTIN ? '' : presets.find(r => r.id === selected).text,
            library: { presets, selectedId: selected },
        };
    };
    return { current, text, records: () => [builtin, ...records], selected: () => selected, preset: () => preset,
        dirty: () => text() !== current().text, choose, chooseBuiltin, edit, save, add, rename, remove, importRecord, snapshot };
}

export function mountJevPromptLibrary({ target, model, generosity, Popup, POPUP_TYPE, tr, warn, isOpen }) {
    const $ = id => target.querySelector('#stlo-jev-' + id);
    const choice = $('prompt-choice'), editor = $('prompt'), file = $('prompt-file'), status = $('prompt-status');
    const button = action => target.querySelector('[data-jev-prompt-action="' + action + '"]');
    let busy = false;
    const available = () => !busy && isOpen();
    const sync = () => {
        const builtin = model.current().builtin === true;
        choice.disabled = busy;
        generosity.disabled = busy;
        editor.readOnly = builtin || busy;
        button('save').disabled = busy || builtin || !model.dirty() || !validText(editor.value);
        button('copy').disabled = busy || !validText(editor.value);
        button('rename').disabled = busy || builtin;
        button('delete').disabled = busy || builtin;
        button('export').disabled = busy || model.dirty();
        button('expand').disabled = busy;
        button('import').disabled = busy;
        status.textContent = model.dirty() ? tr('Unsaved edits', 'promptUnsaved') : '';
    };
    const render = () => {
        choice.replaceChildren(...model.records().map(record => new Option(record.name, record.id)));
        choice.value = model.selected();
        generosity.value = model.selected() === BUILTIN ? model.preset() : 'custom';
        editor.value = model.text();
        editor.scrollTop = 0;
        sync();
    };
    const run = async action => {
        if (!available()) return;
        busy = true;
        sync();
        try { await action(); } catch (error) {
            console.warn('[STLO] Jev prompt library:', error);
            if (isOpen()) warn(tr('Could not complete the prompt action.', 'promptError'));
        } finally { busy = false; if (isOpen()) render(); }
    };
    const askName = async (title, initial = '') => {
        const heading = document.createElement('h3');
        heading.textContent = title;
        const popup = new Popup(heading, POPUP_TYPE.INPUT, initial, { okButton: tr('Save', 'promptSave'), cancelButton: tr('Cancel', 'promptCancel') });
        const answer = await popup.show();
        return typeof answer === 'string' ? answer.trim() : null;
    };
    const invalidName = () => warn(tr('Enter a unique name of up to 80 characters.', 'promptNameInvalid'));
    choice.addEventListener('change', () => { if (available()) { model.choose(choice.value); render(); } });
    generosity.addEventListener('change', () => { if (available()) { model.chooseBuiltin(generosity.value); render(); } });
    editor.addEventListener('input', () => { if (available()) { model.edit(editor.value); sync(); } });
    button('save').addEventListener('click', () => { if (available()) { model.save(); sync(); } });
    button('copy').addEventListener('click', () => void run(async () => {
        const name = await askName(tr('Save as new prompt', 'promptSaveAs'));
        if (isOpen() && name !== null && !model.add(name)) invalidName();
    }));
    button('rename').addEventListener('click', () => void run(async () => {
        const name = await askName(tr('Rename prompt', 'promptRename'), model.current().name);
        if (isOpen() && name !== null && !model.rename(name)) invalidName();
    }));
    button('delete').addEventListener('click', () => void run(async () => {
        const panel = document.createElement('div');
        panel.textContent = tr('Delete this prompt?', 'promptDeleteConfirm') + ' ' + model.current().name;
        if (await new Popup(panel, POPUP_TYPE.CONFIRM, '').show() === 1 && isOpen()) model.remove();
    }));
    button('export').addEventListener('click', () => {
        if (!available()) return;
        const record = model.current();
        const data = { format: 'stlo-jev-prompt', version: 1, name: record.name, text: record.text };
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'jev-prompt-' + record.name.replace(/[^\p{L}\p{N}_ -]/gu, '_').slice(0, 65) + '.json';
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    button('expand').addEventListener('click', () => void run(async () => {
        const readonly = model.current().builtin === true;
        const panel = document.createElement('div');
        panel.className = 'stlo-jev-expanded';
        const heading = document.createElement('h3');
        heading.textContent = model.current().name;
        const area = document.createElement('textarea');
        area.className = 'text_pole';
        area.rows = 5;
        area.spellcheck = false;
        area.value = model.text();
        area.readOnly = readonly;
        area.setAttribute('aria-label', model.current().name);
        panel.append(heading, area);
        const popup = new Popup(panel, readonly ? POPUP_TYPE.TEXT : POPUP_TYPE.CONFIRM, '', {
            wide: true, allowVerticalScrolling: true, okButton: readonly ? false : tr('Apply', 'promptApply'),
            cancelButton: readonly ? tr('Close', 'close') : tr('Cancel', 'promptCancel'),
        });
        const fit = () => { area.style.height = ''; area.style.height = (area.scrollHeight + area.offsetHeight - area.clientHeight) + 'px'; };
        area.addEventListener('input', fit);
        const result = popup.show();
        requestAnimationFrame(fit);
        if (await result === 1 && !readonly && isOpen()) model.edit(area.value);
    }));
    button('import').addEventListener('click', () => { if (available()) file.click(); });
    file.addEventListener('change', () => void run(async () => {
        const selected = file.files[0];
        file.value = '';
        if (!selected) return;
        let data;
        try { if (selected.size <= 300000) data = JSON.parse(await selected.text()); } catch { /* handled below */ }
        if (isOpen() && !model.importRecord(data)) warn(tr('Choose a compatible Jev prompt JSON file.', 'promptInvalidFile'));
    }));
    render();
    return { render, isBusy: () => busy };
}
