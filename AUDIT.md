# First-pass audit — v0.2.27

## Scope and outcome

Read all four archive files, including all 1,333 JavaScript lines. Imported them into a new Git repository before edits: baseline commit `17f920c`, tag `baseline-v0.2.27`. Runtime JavaScript, stylesheet and manifest remain byte-for-byte unchanged. Version remains 0.2.27. Only README, development/audit documentation, tests and Git ignore rules changed.

The user's explicit stop condition applies: the fixes below change observable application/permission behavior. They are proposed, not implemented. This is an audit delivery, not a security-hardened release. No new gameplay features were added.

## Architecture

One ES module contains constants/rules, native targeting, DialogV2 plus legacy Dialog fallback, attack activity calls, result cards, native damage capture, modified damage cards, application and effects, socket handling, chat/sheet listeners and Argon DOM integration. CSS layers preserve earlier adjustments. No runtime dependencies or build step. Native rolls are used, but hit/critical interpretation is performed by this module using AC and d20 results.

## Bugs and risks

| Priority | Evidence / area | Finding |
| --- | --- | --- |
| Critical | handleModuleSocket | Legacy apply requests omit source ownership validation. Neither request type verifies source attack linkage, target consistency, damage schema/ranges, message author, or elected receiver. Payload requesterId is trusted. An active-player ID plus a fabricated/modified card can nominate unrelated damage targets; exploit feasibility also depends on Foundry chat creation/update permissions. |
| High | applyModifiedDamage | Applied is checked before awaits, then written after HP changes. Concurrent requests on the same GM can both apply. Multiple GM clients have no shared lock. HP success followed by flag-write failure permits repeat damage. Reproduced with doubles. |
| High | handleModuleSocket | The receiver never checks Automatically Apply Damage. Even a disabled setting does not reject automatic socket requests. Legacy multiplier accepts arbitrary numeric input; zero is coerced to one by the handler. |
| High | rollSpecialDamage / applyEffect | UI disables completed actions but handlers do not check persisted appliedActions before execution. The rolling lock is local only; effects have no in-flight lock. Different clients, stale DOM, or retries can create duplicate cards/effects. |
| High | rollSpecialDamage | Permission accepts message.isAuthor without attacker ownership. Conversely, an owner rolling a differently authored source card may fail to mark it applied, allowing later duplication. |
| Medium | Object branch | GM zero-damage rolls skip automatic application and remain manually actionable, unlike ordinary GM damage. Player automatic Object requests do delegate. Reproduced. |
| Medium | base damage capture | Matching uses message type, actor when present, and time; item/activity IDs are stored but not checked. Missing speaker actor broadens matching. Concurrent native damage can be tagged incorrectly. Post-tagging selects only the latest candidate. A dialog open longer than two minutes can evade capture. |
| Medium | stripNativeDamageApplicationControls | Broad text matching hides spans containing numbers such as 0/1/2 and glyphs, possibly suppressing roll details. The four-second observer may miss controls added later. Hiding controls is presentation protection, not a server-side prohibition. |
| Medium | UUID resolution | targetTokenUuid is stored but application resolves only targetActorUuid. No token-to-actor consistency check; no recovery when actor UUID resolution fails. Synthetic actors require live testing. |
| Medium | damage metadata | serializeDamageParts stores type, types and properties, but application forwards only type and properties. Exact multi-type damage behavior is unverified; do not invent a type-flattening rule. |
| Medium | native roll fallback | A thrown three-argument damage call triggers a second roll attempt. If the first already posted a roll before throwing, chat can duplicate. No source-message transaction ties result and base roll together. |
| Medium | injuries / hit resolution | Effects use changes:[] and are descriptive, not enforced. Eyes Bloodied is informational only. Hit/crit is derived locally from native roll rather than a system adjudication event. These may differ from a reading of the desired rules, but changing them requires approval. |
| Low | targeting | Ordinary cancel/success removes listeners, but no explicit canvas-teardown cancellation exists. Concurrent begin/restore calls could race. openDirect with multiple targets differs from the main API's explicit warning. |
| Low | Argon | English text anchor, broad root selectors, fixed geometry, global document scans on generic render/token events. No global observer; existing scoped observer disconnects after four seconds. No proven permanent observer leak. |
| Low | maintenance | Stale version-history README and CSS override layers; legacy Dialog/no-dialog roll fallbacks; unused shown local, refresh scope parameter and remnants of older floating placement. Retained because removing fallbacks/selectors without runtime evidence adds risk. |

## Proposed changes requiring approval

1. Restrict HP application to a designated GM coordinator for both automatic and manual actions; validate the setting for automatic requests, source ownership, source/result/native-message linkage, target UUID consistency, finite typed damage and fixed application multiplier. Preserve player rolling and GM-only application buttons. Do not trust client-supplied requester IDs or player-authored flags as independent proof. Evaluate a GM-owned attack record before enabling stronger automatic authorization; adding a new handshake changes failure/latency behavior and needs a protocol design first.
2. Add synchronous in-flight guards and persistent workflow states keyed by source attack/application. Recheck persisted completion on all action handlers. Address GM handoff and partial failures explicitly. HP and chat updates are not atomic; no local Set can guarantee exactly-once across crashes. An ambiguous HP-write/flag-write outcome should require GM reconciliation before retry, which changes the UI/error workflow and needs approval.
3. Complete GM Object auto-application without an HP call, so its card becomes APPLIED. This is a small visible correction but still falls under the requested stop condition.
4. After those changes are reviewed, narrow base-card capture and DOM stripping using exact-version fixtures. Only then split pure rules/helpers and the application coordinator into modules. Preserve Argon position and avoid global observers.

## Verification performed

The Node suite checks manifest validity/paths/socket/version, syntax, rule values, typed serialization, native attack penalty arguments, active/discarded d20 handling, top-level hook uniqueness, stored actor UUID resolution, sequential applied protection, concurrent duplicate reproduction, Object GM/player auto/manual branches, player non-owner delegation, socket ownership/recipient rejection and bypasses, partial-failure duplication, and Standard critical GM/player auto/manual branches.

Tests explicitly reproduce baseline defects; their passing assertions do not mean those defects are fixed. No undefined internal helper was found by code review; the VM tests exercise selected branches, not every global/DOM integration. No runtime event registration changed. Tests do not simulate server authorization, actual resistances/immunities/vulnerabilities, Argon layout, target-mode interaction, D&D5e roll internals, or cross-client document synchronization.

## Required live verification before a code release

Use the specified Foundry 14.367 / D&D5e 5.3.2 / Argon 5.2.2 world copy:

- Standard plus all seven locations, normal hit/miss/critical, advantage/disadvantage and native damage cancellation.
- Every multiplier and 0-damage Object, native typed damage and physical properties, resistance/immunity/vulnerability/temp HP, mixed damage types.
- GM and owner-player rolling with auto on/off; no active GM; differently authored source message; non-owned NPC; linked/unlinked tokens and deleted/mismatched UUIDs.
- Two GMs, two player clients, repeated socket delivery, rapid clicks, rerenders, delayed message delivery, GM reconnect/handoff, HP success with flag update failure. Verify HP changes at most once or recovery is explicitly required.
- Native base card remains readable with no actionable application tray; final APPLIED status propagates; players never get manual HP controls.
- First-target selection, Escape/right-click, canvas switch; sheet rerenders; repeated Argon token changes, HUD close/open and window resize with no freeze or button drift.

## Files changed and intentional deferrals

README replaces contradictory historical installation/workflow claims with current behavior and limitations. DEVELOPMENT describes structure, hooks, socket protocol, packaging and verification. AUDIT records evidence and proposed fixes. Tests characterize unchanged runtime behavior. .gitignore excludes archives/logs and OS files.

No gameplay, sockets, native APIs, ID/flag/setting keys, version numbers, CSS, injury automation, selectors, Argon positioning, hooks or fallback behavior were changed. No release v0.2.28 is claimed. Recommended next step: approve the application/security design above, implement small reviewed patches, then run the exact-version multi-client matrix before packaging 0.2.28.

