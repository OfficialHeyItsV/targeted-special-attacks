# Development

## Structure

- `module.json`: unchanged manifest, socket enabled, v0.2.27.
- `scripts/special-attacks.js`: 1,333-line entry point containing rules, targeting, native attack/damage, sockets, effects, chat/sheet DOM, and Argon integration.
- `styles/special-attacks.css`: original styles and historical overrides.
- `tests/baseline.test.cjs`: dependency-free Node tests executing source in a VM with Foundry doubles.
- `AUDIT.md`: findings and proposed fixes awaiting approval.

No framework, build system, runtime dependency or module split was introduced. A later split should begin with constants/rules and pure damage helpers, then socket/application coordination. DOM code should remain unchanged until live fixtures exist. Preserve IDs, namespaces and setting keys.

## Hooks

`init` registers the world setting. `ready` checks D&D5e, exposes the API, registers the socket handler and starts Argon integration.
Top-level hooks: `preCreateChatMessage`, `renderActorSheet`, `renderActorSheetV2`, `renderChatMessageHTML`, `dnd5e.renderChatMessage`, `renderApplicationV2`.
Argon adds `controlToken`, `canvasReady`, `updateToken` and window resize listeners once from ready. Refresh is debounced. Sheet insertion and chat binding have DOM guards.
Target selection temporarily installs pointermove, keydown, contextmenu and targetToken handlers and removes them on ordinary completion/cancel.

The only observer watches an individual chat card for four seconds. Never add a global Argon observer. English header matching and the fixed positioning offsets are intentionally unchanged. Canvas teardown, HUD closure, localization and detached-node behavior require live assessment.

## Current socket protocol

Channel: `module.targeted-special-attacks`; manifest must retain `socket: true`.
Payload: `type`, `gmId`, `requesterId`, `messageId`, `applicationMultiplier`.
Types: `auto-apply-modified-damage` and legacy `apply-modified-damage`.

The sender selects the active GM with the lowest sorted ID. The receiver checks its addressed GM ID, retries message lookup eight times at 75ms, then checks card kind/applied, requester active status, and attacker ownership only for automatic requests. It does not enforce receiver election or the auto setting. Requester identity comes from the payload; this handler does not authenticate its sender. Player-authored flags are not authoritative evidence of an attack.

## Damage flow

Native damage -> tag base chat message -> optional multiplier -> final card with serialized parts -> local GM call or player socket -> resolve targetActorUuid -> Actor.applyDamage -> persist applied flag.
`targetTokenUuid` is stored but not validated against the actor. HP mutation and flag update are separate operations. ACTIVE_DAMAGE_ROLLS only guards concurrent rolling within one client, not application or cross-client rolling.

## Verification

Node 24+, no npm install:

```powershell
node --check scripts/special-attacks.js
node --test --test-isolation=none tests/baseline.test.cjs
git diff baseline-v0.2.27 -- scripts styles module.json
```

Isolation is disabled to avoid sandbox child-process restrictions. KNOWN GAP tests reproduce defects; change their expected outcome when fixing each defect. Passing does not mean duplicate prevention or security is complete. There is no live Foundry or Argon runtime fixture.

## Packaging

Synchronize manifest and MODULE_VERSION to **0.2.28** for the first release-worthy code change. Keep 0.2.27 for this documentation/test pass. After tests and the live matrix, run from this directory:

```powershell
git archive --format=zip --prefix=targeted-special-attacks/ --output=../vs-targeted-attacks-maintenance.zip HEAD
git bundle create ../vs-targeted-attacks-project.bundle --all
```

The archive excludes `.git`. Tests and docs are not loaded by Foundry. The bundle preserves Git history. Restore the baseline in an isolated checkout with `git worktree add ../baseline-review baseline-v0.2.27`; do not reset uncommitted work.

## Compatibility evidence

The supplied package is the behavioral reference. Official reference entry points: [Foundry v14 API](https://foundryvtt.com/api/v14/) and [D&D5e package listing](https://foundryvtt.com/packages/dnd5e). The exact 5.3.2 actor source could not be fetched through the browser in this pass; current-branch APIs were not substituted as compatibility evidence. Native roll, damage, permission and DOM assumptions need exact-version runtime tests.

