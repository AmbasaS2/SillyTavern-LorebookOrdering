# 📚 Lorebook Ordering - Version History

**← [Back to README](README.md)**

## Branding update (2026-11-26)
- Renamed the fork to Lorebook Ordering for Sloths (게으름뱅이를 위한 로어북 예산 관리기). Existing menu labels, settings, identifiers and install URL are unchanged.

## 2.2.4-ambasa.1 — optional WorldInfo Info Jev source display (2026-11-25)
- Reapply only the display receipt to the current multi-source ranked recall implementation; report the copied, applied keys from the real scan to an optional viewer.
- Preserve the current priority, cap, recursion, vector, retry and insertion-order paths; no additional observer, polling, scan, API call or persisted lore changes.
- Node regression suite: 50 passing in isolation, plus paired receiver checks. Real installed ST/Termux/iOS not exercised. Rollback: restore previous extension code only.

## Ambasa fork — opt-in and budget stability (November 25, 2026)
- Always-on budget protection is opt-in; existing explicit settings are retained. Without effective custom ordering, preserve native lorebook source precedence and insertion values. Reserve constant budget only on scan copies and restore temporary flags at final assembly.
- Count only constants fitting applicable ceilings during Jev planning, including caps of other active books. Reserve actual Jev picks for the native scan and enforce all three applicable ceilings, including zero-pick runs and actual native special entries in managed books. Explicit native budget exemptions remain exempt from native/book caps, but not from the managed-book Jev cap. Outlet handling is unchanged.
- Keep native chat/file vectors and excluded-book vectors. In all-entries mode omit only complete Jev-managed World Info collections; retain a whole collection when a special entry needs native vectors. No deletion or rebuilding of stored vector indexes.
- Validate invalid Jev budget values instead of silently resetting. Remove unsafe pre-scan truncation on older hosts lacking the structured scan event. No new UI observers, polling or redraw loops; prompt editor layout and implementation are unchanged.
- Validation: 48 Node tests and isolated Chromium checks at 1024px, 460px, and 360px passed. Native-host scan and vector behavior are simulated; actual installed SillyTavern and NanoGPT live calls remain unverified. Manifest unchanged.

## Ambasa fork — compact Jev settings (November 25, 2026)
- Unify the Jev menu and dialog title as Lorebook Jev Recall (로어북 Jev 호출).
- Use a per-character checkbox and compact, container-width-responsive two-column input groups; stack fields on narrow screens.
- Preserve the prompt editor, model, generation logic, and stored settings. No new observers or redraw loops.
- Validation: 36 Node tests and isolated Chromium checks at 1024px, 460px and 360px passed. Prompt editor markup, CSS and behavior are unchanged. Installed SillyTavern verification remains pending.

## Ambasa fork — multi-lorebook manager (November 25, 2026)
- Open the budget manager directly, with collapsible book cards and live priority/budget summaries. Add linked books by default, or show all books; remove only editor cards without touching lore or connections.
- Move the global always-on protection control to the manager header. Keep per-book advanced and group settings independently scoped with unique control IDs.
- Stage settings until save, validate changes before writing, and merge only changed fields into current books. Verify each native save against persisted values; partial failures stay open for retry without resaving completed cards. Native save notifications are not duplicated.
- Existing generation, Jev, priority and budget engines remain unchanged. Native disclosure controls and event handlers only; no new observers, polling or global redraw loops.
- Validation: Node tests and isolated Chromium multi-card checks at 1024px and 360px passed. Actual installed SillyTavern and live persistence verification remain pending.

## Ambasa fork — character cards (November 25, 2026)
- Replace five priority-group panels with one card per configured character. Add or remove cards without rebuilding the others; prevent duplicate selections.
- Keep each character's saved priority, order adjustment and other stored fields. Unopened drawers preserve overrides; explicitly removing all cards saves an empty map.
- Move the only-when-speaking switch into the group chat drawer. Use native disclosure controls and lazy mount with no observers or polling.
- Validation: 31 Node tests passed; isolated Chromium checks at 1024px and 360px passed, including existing override preservation, independent edits, deletion, cancellation and adjacent Jev/budget controls. Live SillyTavern validation remains pending.

## Ambasa fork — simplified settings (November 25, 2026)
- Restore global always-on protection to the selected lorebook budget dialog. Save it separately from book data; the picker only selects a book.
- Align group priority and order-adjustment help icons with their labels.
- Display the current character on one line; single-character Jev now has On/Off only and defaults to Off when unset. Explicit choices and group book flags are preserved.
- Show three built-in selection styles only; custom prompts remain independently selectable in the prompt library. Display the actual reading-limit status without adding observers or polling.

## Ambasa fork — full-text Jev recall (November 25, 2026)
- Full recent dialogue and candidate text by default; 20 recent messages, optional reading limits. Legacy default 6/1400/960 migrates to 20/0/0; non-default values are retained. Existing custom selection prompts are preserved, with old transport wording adapted at runtime.
- Shared dialogue and ordinary always-on background; one independent question per candidate. Preflight estimates plan batches at 56K/28K; explicit provider size rejection splits further, normal errors require retry/cancel. No partial selection can reach RP.
- Unified book budget: an explicit existing cap also becomes the preferred Jev allocation. Old separate reserve values are left in saved books but no longer used; no new cap is invented.
- Hide per-book Jev controls for characters with Jev disabled; retain hidden settings and legacy/group controls. Move global always-on protection to the book picker. No new observers, polling or redraw loops.
- Expanded latest-run diagnostics: planned/completed batches, unassessed candidates, reading-limit truncation, estimated and reported token usage.

- Validation: 30 Node tests and isolated Chromium UI checks at 1024px and 360px passed. Live NanoGPT and installed SillyTavern validation remain pending. Manifest version unchanged.

## Ambasa fork — review build (November 25, 2026)
- Optional per-book Jev exclusion and preferred budget; unchanged defaults.
- All-entries or native candidate recall, adjustable excerpts and editable decision presets.
- Explicit Jev retry/cancel before RP generation; no automatic retries.
- Event-only latest recall diagnostics and compact help icons.
- Separate book settings and character/global Jev settings into independent menu entries. Explicit On/Off and inherited legacy settings retain the existing per-character storage; book settings no longer write global values. Section dividers and responsive field layout added.
- Use a common book-open menu icon, consistent Jev naming, equal-width injection controls, and horizontal advanced action buttons.
- Add a named Jev prompt library with the Memory Books editor layout: full view, save/rename/save as, JSON import/export and delete. Migrate the active legacy prompt without changing its criteria; stage all changes until Save Settings. Built-in strict/balanced/generous prompts are unchanged.
- Node tests: 25 passing. Isolated Chromium host harness: 1024px and 360px layout, prompt editing/switching/save/cancel passed. Actual installed SillyTavern and live API not exercised. Manifest version retained pending release verification.

## v2.2.4 (September 24, 2026)
- **🪲Bugfix:** Entries removed for budget reasons during recursion returned for rescan each time, causing infinite loops. Fixed.

## v2.2.3 (December 23, 2025)
- **🌐 Internationalization:** Added localisation: French and German.

## v2.2.2 (December 2, 2025)
- **🪲Bugfix:** Checking group chat box should not affect single chats. Fixed.

## v2.2.1 (December 1, 2025)
- **✨Tweak:** Await entry load and re-order properly at WI loaded instead of backgrounding.

## v2.2.0 (November 23, 2025)
- **✨Enhancement:** New setting: "random trim" will randomly trim entries (instead of based on order). Intended for memory lorebooks, random-event lorebooks, world-flavor lorebooks, etc to inject some randomness into recall. When randomTrim is false (default), entries are trimmed based on order (lowest order is trimmed first).

## v2.1.0 (November 23, 2025)
- **✨Enhancement:** THANK YOU @Wolfsblvt for [this PR](https://github.com/SillyTavern/SillyTavern/pull/4797#issuecomment-3568450453) which added the `WORLDINFO_SCAN_DONE` event! 💖 That enabled us to SIGNIFICANTLY speed up STLO. 💖💖💖 This extension is backwards compatible, but you will need the above PR (currently in ST staging, hopefully will be in ST 1.15.0 release) in order to see the speed improvements.

## v2.0.1 (November 8, 2025)
- **🪲Bugfix:** Guard crashing on chat load

## v2.0.0 (November 7, 2025)
- **BREAKING CHANGE:** Removed check for insertion strategy. If STLO is on, it will work.  Strategy no longer matters.
  - early empty of chat lore and persona lore to move them to global to stop ST from reading chat/persona first despite order.

## v1.8.0 (October 26, 2025)
- **✨Enhancement:** Added slash command `/stlo`. 

## v1.7.0 (October 20, 2025)
- **🌐 Internationalization:** Added localisation. 
  - Simplified/Traditional Chinese
  - Japanese
  - Korean
  - Russian
  - Malay
  - Indonesian
  - Spanish

## v1.6.4 (October 16, 2025)
- **🪲Bugfix:** Removed dead code

## v1.6.3 (October 11, 2025)
- **🪲Bugfix:** Refresh LB after save

## v1.6.2 (October 13, 2025)
- **🪲Bugfix:** Additional bugfixes and improvements
- **🔧Optimization:** Log trimmed entries for better performance

## v1.6.1 (October 11, 2025)
- **🪲Bugfix:** Fix max context retrieval

## v1.6.0 (October 11, 2025)
- **⚙️Reimplement Budgets:** Reimplemented budgeting system

## v1.5.0 (October 11, 2025)
- **❗Refactor:** Refactored to read from worldInfoCache instead of loadWorldInfo.

## v1.4.1 (September 29, 2025)
- **🔧 Fix name/avatar name mismatch:** Fixed priority mismatch in name/avatar name clash resolution
  - if avatar name and char name differed, storage vs detection methods differed 
  - fixed to be the same methods

## v1.4.0 (September 29, 2025)
- ****🎭 Group Chat Character Overrides:** added feature for group chats
  - added on/off toggle for group chats that will only activate a lorebook when the assign character is speaking
  - if box is checked but no characters are assigned, the lorebook does not activate

## v1.3.0 (September 29, 2025)
- **🔧 Simplified Architecture:** Removed budget management system
  - Removed complex budget allocation modes that caused more problems than they solved
  - Focus now entirely on priority-based lorebook ordering

## v1.2.0 (September 26, 2025)
- **📊 Order Adjustment System:** New fine-tuning feature for lorebook entry processing order
  - Add custom order adjustment values (-10,000 to +10,000) on top of priority levels
  - Example: Priority 3 + adjustment +250 = final order +30,250 for precise control
  - Available in both main lorebook settings and character overrides
  - "Group Chats Only" option allows order adjustment to be applied selectively

## v1.1.1 (September 25, 2025)
- **🔧 Settings Persistence Fix:** Fixed bug where settings would not reload properly in UI
  - Removed unreliable JSON comparison verification that caused false save failures
  - Fixed character overrides not populating in Group Chat Overrides section
  - Settings now persist and load correctly in all scenarios

## v1.1.0 (September 24, 2025)
- **🎭 Group Chat Character Overrides:** Major new feature for per-character lorebook behavior
  - Different characters can now have different lorebook priorities during their turns in group chats
  - Character-specific budget overrides allow fine-tuned resource allocation
  - Seamless integration with existing lorebook settings - no breaking changes

## v1.0.0 (September 2025)
- **Initial Release:** Complete lorebook priority and budget management system for SillyTavern
- **Priority Control System:** Five-level priority system for lorebooks
  - Highest (5): Maximum priority for critical world information
  - High (4): Above-average priority for important lorebooks
  - Default (3): Standard SillyTavern behavior (no modification)
  - Low (2): Below-average priority for supplementary information
  - Lowest (1): Minimum priority for background/optional content
- **Advanced Budget Management:** Four distinct budget allocation modes
  - Default mode: Uses SillyTavern's standard budget allocation
  - Percentage of Context: Allocate specific percentage of total context window
  - Percentage of Budget: Allocate specific percentage of World Info budget
  - Fixed Tokens: Set exact token limits for precise control
- **Evenly Strategy Integration:** Seamless integration with SillyTavern's "evenly" World Info insertion strategy
  - Real-time strategy validation during generation
  - Smart warnings only during user-initiated generation (not automatic greetings)
  - Graceful fallback when strategy requirements aren't met
- **Intelligent Warning System:** Context-aware notifications and user choices
  - Strategy compatibility detection with actionable options
  - User can choose to switch strategy, stop generation, or disable STLO
  - Generation state tracking to avoid spam notifications
- **Per-Lorebook Configuration:** Individual settings management
  - Settings automatically saved per lorebook
  - Persistent configuration across SillyTavern sessions
  - Clean UI with dropdown selection and real-time updates

**← [Back to README](README.md)**

---

*This version history is maintained alongside active development. For the most up-to-date features and configuration options, see the main [README](README.md).*
