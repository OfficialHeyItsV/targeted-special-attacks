# V's Targeted Attacks

Runtime version: **0.2.28**. Internal ID: `targeted-special-attacks`.
This maintenance release hardens damage application while retaining the original location rules, native rolls and Argon positioning. The original package remains restorable from Git tag `baseline-v0.2.27`.

## Compatibility and installation

Target environment: Foundry VTT v14 Build 367, D&D5e 5.3.2, D&D 2024 / 5.5e, and optional Argon Combat HUD DND5E 5.2.2 with Argon CORE. The inherited manifest declares Foundry 14 (verified 14.367) and D&D5e 5.3.2–5.3.3. These declarations were not reverified in a live world.

Back up your world and existing module. Copy this folder to `Data/modules/targeted-special-attacks`, restart Foundry, and enable it. Keep the folder and internal ID unchanged. No hosted manifest/download URL is supplied; installation uses folder copy.

## Use

Select your actor token and click **Targeted Attack** on its sheet or Argon HUD. With no target, native token targeting starts with a cursor-following **0/1 Targets** indicator. The first target opens the dialog. Escape or right-click cancels. Exactly one target is required. Standard is selected by default.

Macro: `TargetedSpecialAttacks.open()`.

Location penalties enter the native attack formula. The module uses the returned native roll and target AC to display hit/critical status. Roll damage from the result card: **Roll Damage** for Standard, **Roll Special Damage** for targeted locations, or **Resolve 0 Damage** for Object.

## Rules

| Location | Attack | Damage | Hit | Bloodied | Critical |
| --- | ---: | --- | --- | --- | --- |
| Standard | 0 | Native | None | None | None |
| Eyes | -6 | ×(1d3+1) | Bloodied, 1 turn | Eye Crippled | Eye Lost |
| Head | -4 | ×(1d2+1) | Disadvantage on rolls, 1 turn | Head Crippled | Head Lost |
| Arm | -3 | ×1d2 | Disadvantage on attacks, 1 turn | Arm Crippled | Arm Lost |
| Object | -3 | 0 | None | Object Launched | Object Destroyed |
| Torso | -1 | Native | None | Torso Crippled | Internal Wound |
| Groin | -3 | ×1d3 | None | Gripping Pain | Intense Agony |
| Leg | -2 | ×1d2 | Cannot Dash, 1 turn | Leg Crippled | Leg Lost |

Injuries are descriptive ActiveEffects with empty mechanical changes. The GM decides when to apply them and adjudicates their consequences. Eyes' Bloodied hit is informational, with no Apply button. Bloodied eligibility is GM-adjudicated, including crossing half HP after damage. Temporary effects store one round; automated expiry/enforcement is not verified.

## Damage and permissions

**Automatically Apply Damage** is a world setting, enabled by default. Its saved key remains `autoApplyPlayerDamage`.

- Enabled: GM and player rolls, including Object, are processed by one designated GM. Player requests use the module socket. Successful application is silent and the card becomes **APPLIED**.
- Disabled: a GM clicks **Apply**. Players never receive manual HP application controls; their completed cards show a read-only APPLIED label.
- Only the GM or an owner of the attacking actor may roll its damage. Message authorship alone does not grant this permission.
- The module records attack and roll evidence when the designated GM receives document creation events. Edited, unrelated, malformed, or unverified final cards cannot be applied automatically.
- With no coordinator available, damage stays in chat for review. A GM can explicitly approve older cards or attacks made without a recording GM. These approvals do not reconstruct missing evidence.
- A pending application is saved before HP changes. Duplicate requests and final cards for the same recorded attack reuse one application record. An ambiguous interruption blocks further application until reviewed.

### Interrupted applications and GM handoff

A final card left pending has a GM-only **Review interrupted application** button. Check HP and the combat log first. Choose **Already applied** to complete its record without touching HP, or **Not applied — allow retry** only when certain HP did not change. Cancel if uncertain. Confirmed completed records cannot be reset by a stale review dialog.

The first elected GM remains the coordinator across reloads. When that GM goes offline, another GM must explicitly take over after ensuring the previous client is closed and its work has stopped. Run this GM macro:

```js
TargetedSpecialAttacks.takeOverDamage();
```

Pending work is not automatically retried after takeover. See DEVELOPMENT.md for recovery macros, including injury reconciliation.

Native damage remains visible in chat, with its application controls suppressed. A separate multiplier roll is made where applicable, followed by a final modified card (Standard uses a Standard Damage card). Typed damage and physical properties go through D&D5e `Actor.applyDamage`, leaving defenses and temporary HP to the system. Exact-version integration still requires live verification.

## Argon and limitations

The button anchors to the English **SAVES / SKILLS / TOOLS** header above the equipment/portrait area. Refresh uses debounced lifecycle hooks and resize events. No global MutationObserver exists. A four-second observer is scoped to each tagged native damage card.

The regression suite uses independent client VMs and shared test data; it does not certify live Foundry/Argon compatibility. Test this release in a world copy before using it in a session. Existing DOM fallbacks and multi-type damage interpretation still need exact-version runtime testing. The ledger prevents automatic replay of ambiguous work, but is not an atomic server transaction or an anti-cheat system: Foundry rolls originate on clients. GM/world-setting administrators are trusted. See [DEVELOPMENT.md](DEVELOPMENT.md) and [CHANGELOG.md](CHANGELOG.md).

