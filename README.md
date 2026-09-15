# V's Targeted Attacks v0.2.14

Targeted attack module for Foundry VTT 14 / D&D5e 5.3.2.

## v0.2.14
- Fixes Argon Combat HUD integration placing Targeted Attack on every action.
- Argon integration now injects at most one Targeted Attack button.
- Only dedicated Special-action containers are used for inline placement.
- If Argon exposes no safe Special container, the module uses the single floating fallback instead of altering action cells.
- Keeps the safer debounced integration from v0.2.13.

# V's Targeted Attacks v0.2.8

Target: Foundry VTT v14 Build 367 + D&D5e 5.3.2 (2024 / modern rules).

## What changed in v0.2.0

- Target-location attack penalties are now injected into the **native D&D5e attack roll parts**. The penalty therefore changes the actual attack total and appears in the native roll formula/details.
- The targeted result card also records the resulting native attack formula for verification.
- Special damage still rolls the original weapon damage through D&D5e first.
- The location multiplier is then applied per damage component while preserving damage type and physical properties.
- A new **Modified Targeted Damage** card provides `-1 / 0 / 1/4 / 1/2 / 1 / 2` application buttons similar to D&D5e's native damage controls.
- Those buttons call D&D5e's `Actor.applyDamage()` workflow, so target resistance, vulnerability, immunity, and temporary HP remain system-controlled.

## Macro

```js
TargetedSpecialAttacks.open();
```

## Install

Replace the old `Data/modules/targeted-special-attacks` folder with the folder in this archive, restart Foundry, then verify the module reports version 0.2.1.


## v0.2.5
- Modified Targeted Damage now has one **Apply** button only.
- Removed the -1, 0, 1/4, 1/2, 1, and 2 multiplier controls from the modified card.
- The modified damage card deletes itself after a successful application to prevent accidental double application.
- Native base-damage chat cards remain visible for the roll, but their Apply button and damage-application multipliers are hidden.


## v0.2.5
- Tags the native base-damage chat card on the primary damage-roll path so its Apply and multiplier controls are actually hidden.
- Restyles the modified-damage Apply control to match D&D5e’s native full-width Apply button.


## v0.2.5
- Modified damage cards remain in chat after damage is applied.
- Apply changes to a disabled, grey APPLIED button after successful application.
- Added a persistent applied flag to prevent duplicate damage application.


## v0.2.8
- Fixes native base-damage cards still showing D&D5e Apply and damage multiplier controls.
- Captures and tags the native D&D5e damage ChatMessage during `preCreateChatMessage`, which is reliable across D&D5e 5.3.x roll paths.
- Native base damage remains visible as a roll record, but only the modified targeted-damage card can apply HP damage.


## v0.2.8
- Keeps the native D&D5e base-damage roll visible while reliably removing its Apply tray and multiplier controls.
- Adds post-roll tagging for D&D5e 5.3.x, which can discard custom chat flags supplied to `rollDamage()`.
- Adds a structural DOM fallback so the Apply tray is removed even if D&D5e changes the tray CSS classes.


## v0.2.8
- Removes the remaining native D&D5e damage multiplier strip from targeted base-damage cards.
- Adds a short-lived DOM watcher because D&D5e 5.3.x may append those controls after the initial chat render hook.


## v0.2.12
- Keeps the native base damage roll visible while removing only its Apply/multiplier controls.
- Targeted Attack action buttons become disabled and gain `(APPLIED)` after successful use.


## v0.2.12
- Object/0-damage Apply now persists as greyed-out APPLIED instead of staying clickable.
- Removed the stray native multiplication × glyph left below the target portrait on display-only base-damage cards.


## v0.2.12 changes
- Removes the manual **Apply Bloodied** button from the targeted-attack result card.
- Removes the last stray `×` glyph from display-only native damage cards.
- Adds an optional **Targeted Attack** button inside Argon Combat HUD when both Argon CORE and Argon DND5E are active. Tested/targeted for Argon DND5E 5.2.2 on Foundry v14.
- The character-sheet button and macro API remain available.


## v0.2.12
- Reworked Argon Combat HUD detection for Foundry v14 AppV2.
- Adds a visible fallback Targeted Attack control whenever Argon CORE + DND5E are active and no stable HUD insertion point can be detected.


## v0.2.13 hotfix
- Fixes a Foundry freeze that could occur when selecting a token with Argon integration enabled.
- Removed the global document MutationObserver used by the Argon integration.
- Argon integration now refreshes only from Foundry render/token lifecycle hooks with debouncing.
- Prevents V's Targeted Attacks from ever detecting its own injected Argon controls as an Argon HUD root.
- If a native Argon insertion point cannot be found, the safe floating Targeted Attack fallback remains available.


## v0.2.18
- Repositions the Argon Targeted Attack control beside the **SAVES / SKILLS / TOOLS** drawer header.
- Removes the generic Argon fallback placement that could put the button in the dice/chat roll text box.
- Repositions the control safely when the HUD rerenders or the browser window is resized.


## v0.2.18
- If Targeted Attack is pressed with no current target, the module enters Foundry V14's native **Select Targets** tool.
- A `0/1 Targets` indicator follows the cursor while waiting for a creature selection.
- Clicking the first target completes the one-shot targeting state, restores the previous canvas tool, and automatically opens the Targeted Attack dialog.
- Press **Esc** or right-click to cancel target selection.
- Existing behavior is unchanged when exactly one creature is already targeted.


## v0.2.18
- Moves the Argon Targeted Attack button above the equipment-slot row at the top of the portrait/drawer.
- Adds a **Standard** attack option with no attack penalty, no special damage multiplier, and no injury effects.
- Standard attacks use **Roll Damage** rather than **Roll Special Damage** and do not create a multiplier roll.


## v0.2.18
- Raised the Argon Combat HUD Targeted Attack button by 12 px so it clears the equipment boxes.


## v0.2.21
- Players who own the attacking character can roll Standard or Special damage from the module chat card.
- Preserves the additional 6 px Argon HUD button clearance from v0.2.20.


## v0.2.27
- Players who own the attacking character can now click **Apply** on their modified/standard damage card even when they do not own the target NPC.
- For non-owned targets, the module sends a one-time request to an active GM client, which applies the typed damage through D&D5e's native `Actor.applyDamage()` workflow.
- The damage card remains in chat and changes to **APPLIED** after the GM client completes the application.
- A GM must be connected for a player to apply damage to an NPC they do not own.


## v0.2.27
- Players can still roll Standard and Special damage from their targeted attack cards.
- Modified Targeted Damage cards no longer show an Apply button on player clients; the Apply control is visible only to GMs.


## v0.2.27
- Added a world setting: **Auto-Apply Player Damage** (enabled by default).
- When a player rolls Standard or Special damage through the module, the completed damage card is silently sent to one active GM client for immediate application to the target.
- The GM does not need to click Apply when auto-apply is enabled.
- The damage card remains in chat and transitions to **APPLIED** after the GM client completes the application.
- Disable the setting under Module Settings to return to manual GM Apply.
- Auto-apply requests are validated against ownership of the attacking actor.


## v0.2.27
- Enables the Foundry module socket channel in `module.json`, allowing player auto-apply requests to actually reach the connected GM client.
- Keeps player damage rolling and GM-side silent application behavior from v0.2.25.


## v0.2.27
- The world setting is now labeled **Automatically Apply Damage** and remains enabled by default.
- With automatic mode enabled, GM damage rolls are applied immediately on the GM client.
- Player damage rolls continue to be silently applied through a connected GM client.
- Disable **Automatically Apply Damage** to return to manual GM Apply buttons for all damage cards.

