# Sloth notification branding (2.2.4-ambasa.6)

- Baseline: eeaf0f2ca5b1cf6960d0f988b7604977e71d2114
- Scope: 18 existing toast emission sites; preserve all messages, severity, return values and options. Prefix extension-specific console emissions; no global toastr override, polling, UI CSS, data or prompt changes.
- Title: 🦥 STLO (Korean: 🦥 로어북 예산 관리).
- Verification: source syntax parsed after stripping imports and substituting import.meta for parser-only validation, emission count and all title sites checked, locale title checks passed. Real SillyTavern desktop/mobile and full repository tests not run in this environment.
- Rollback: revert this commit (previous version 2.2.4-ambasa.5).
