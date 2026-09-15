import { validateParts, sameParts, validMultiplier, attackMatches } from "./damage-validation.mjs";

const MODULE_ID = "targeted-special-attacks";
const MODULE_TITLE = "V\'s Targeted Attacks";
const MODULE_VERSION = "0.2.28";

// Prevent duplicate chat-render hooks or rapid double-clicks from launching the same action twice.
const AUTO_APPLY_PLAYER_DAMAGE_SETTING = "autoApplyPlayerDamage";

const ACTIVE_DAMAGE_ROLLS = new Set();
const LEDGER_SETTING = "damageLedger";
const COORDINATOR_SETTING = "damageCoordinator";
const MANUAL_REQUEST_SETTING = "manualApplicationRequest";
let COORDINATOR_QUEUE = Promise.resolve();
const UNCERTAIN_APPLICATIONS = new Set();

// While a targeted damage roll is in progress, capture the native D&D5e
// damage ChatMessage at creation time and tag it as display-only. This is
// more reliable in D&D5e 5.3.x than relying only on message flags passed to
// DamageRoll.build(), because some native roll paths rebuild message data.
const PENDING_BASE_DAMAGE_CAPTURES = [];

const RULES = {
  standard: {
    label: "Standard", attack: 0, damage: null, standard: true,
    hit: null, bloodied: null, critical: null
  },
  eyes: {
    label: "Eyes", attack: -6, damage: "1d3+1",
    hit: { name: "Bloodied (1 turn)", description: "Target is Bloodied for 1 turn.", temporary: true },
    bloodied: { name: "Eye Crippled", description: "Disadvantage on Wisdom (Perception) checks that rely on sight and on ranged attack rolls. If all eyes are crippled, the creature is Blinded." },
    critical: { name: "Eye Lost", description: "Disadvantage on Wisdom (Perception) checks that rely on sight and on ranged attack rolls. If all eyes are lost, the creature is permanently Blinded." }
  },
  head: {
    label: "Head", attack: -4, damage: "1d2+1",
    hit: { name: "Disadvantage on rolls (1 turn)", description: "Disadvantage on rolls for 1 turn.", temporary: true },
    bloodied: { name: "Head Crippled", description: "At the start of each turn, make a DC 16 Constitution saving throw. On a failure, the creature can take only one action, one bonus action, or one movement that turn." },
    critical: { name: "Head Lost", description: "The creature dies if it cannot live without its head." }
  },
  arm: {
    label: "Arm", attack: -3, damage: "1d2",
    hit: { name: "Disadvantage on attacks (1 turn)", description: "Disadvantage on attacks for 1 turn.", temporary: true },
    bloodied: { name: "Arm Crippled", description: "The creature takes 2d4 damage if it uses the crippled arm." },
    critical: { name: "Arm Lost", description: "The creature can no longer hold anything with two hands and can only hold a single object at a time." }
  },
  object: {
    label: "Object", attack: -3, damage: "0",
    hit: null,
    bloodied: { name: "Object Launched", description: "The object is launched (1d6 × 5) feet away." },
    critical: { name: "Object Destroyed", description: "The object is destroyed if it can be destroyed." }
  },
  torso: {
    label: "Torso", attack: -1, damage: null,
    hit: null,
    bloodied: { name: "Torso Crippled", description: "The creature takes 1d4−1 damage each time it makes an action." },
    critical: { name: "Internal Wound", description: "The creature takes 1d10 damage at the end of its turn until fully healed, and takes 1d4−1 damage each time it makes an action." }
  },
  groin: {
    label: "Groin", attack: -3, damage: "1d3",
    hit: null,
    bloodied: { name: "Gripping Pain", description: "The creature can only take one action, one bonus action, or one movement this turn." },
    critical: { name: "Intense Agony", description: "The creature takes 1d10 damage at the end of its turn until fully healed and becomes Paralyzed for 1d4 rounds." }
  },
  leg: {
    label: "Leg", attack: -2, damage: "1d2",
    hit: { name: "Can't Dash (1 turn)", description: "The creature can't take the Dash action for 1 turn.", temporary: true },
    bloodied: { name: "Leg Crippled", description: "The creature takes 1d4 damage for every 10 feet it moves." },
    critical: { name: "Leg Lost", description: "Walking speed is halved. The creature has disadvantage on Dexterity checks and saves made to balance, must use a cane or crutch to move, and falls Prone if it takes the Dash action." }
  }
};

function esc(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function actorFromContext() {
  const controlled = canvas?.tokens?.controlled ?? [];
  if (controlled.length === 1) return controlled[0].actor;
  if (controlled.length > 1) {
    ui.notifications.warn(`${MODULE_TITLE}: Select only one of your tokens.`);
    return null;
  }
  return game.user.character ?? null;
}

function getTarget() {
  const targets = Array.from(game.user.targets ?? []);
  return targets.length === 1 ? targets[0] : null;
}

function getAttackActivities(actor) {
  const rows = [];
  for (const item of actor.items ?? []) {
    const activities = item.system?.activities;
    if (!activities) continue;
    const list = typeof activities.filter === "function"
      ? activities.filter(a => a.type === "attack")
      : Array.from(activities).filter(a => a.type === "attack");
    for (const activity of list) rows.push({ item, activity });
  }
  return rows;
}

async function dialogChoice(actor, attacks) {
  const options = attacks.map(({item, activity}, i) => {
    const toHit = activity.labels?.toHit ?? activity.labels?.modifier ?? "";
    const activityName = activity.name && activity.name !== item.name ? ` — ${activity.name}` : "";
    return `<option value="${i}">${esc(item.name)}${esc(activityName)} ${toHit ? `(${esc(toHit)})` : ""}</option>`;
  }).join("");

  const bodyButtons = Object.entries(RULES).map(([key, r]) =>
    `<label class="tsa-location"><input type="radio" name="location" value="${key}" ${key === "standard" ? "checked" : ""}>
      <span><strong>${esc(r.label)}</strong><small>Attack ${r.attack >= 0 ? "+" : ""}${r.attack}${r.damage === "0" ? " · 0 damage" : r.damage ? ` · Damage ×(${esc(r.damage)})` : " · Normal damage"}</small></span>
    </label>`
  ).join("");

  const content = `<form class="tsa-dialog">
    <p><strong>${esc(actor.name)}</strong> — choose an attack and target location.</p>
    <div class="form-group"><label>Attack</label><select name="attackIndex">${options}</select></div>
    <div class="tsa-grid">${bodyButtons}</div>
    <p class="notes"><i class="fa-solid fa-circle-info"></i> Targeted locations insert their accuracy penalty into the native D&D5e attack roll. Standard uses the unmodified native attack formula.</p>
  </form>`;

  const DialogV2 = foundry.applications?.api?.DialogV2;
  if (DialogV2?.wait) {
    return DialogV2.wait({
      window: { title: "Targeted Attack" },
      content,
      buttons: [
        { action: "cancel", label: "Cancel" },
        {
          action: "attack", label: "Make Targeted Attack", icon: "<i class='fa-solid fa-crosshairs'></i>", default: true,
          callback: (_event, _button, dialog) => {
            const form = dialog.element.querySelector("form");
            const fd = new FormData(form);
            return { attackIndex: Number(fd.get("attackIndex")), location: fd.get("location") };
          }
        }
      ],
      close: () => null
    });
  }

  return new Promise(resolve => {
    new Dialog({
      title: "Targeted Attack",
      content,
      buttons: {
        cancel: { label: "Cancel", callback: () => resolve(null) },
        attack: { label: "Make Targeted Attack", callback: html => {
          const root = html?.[0] ?? html;
          const fd = new FormData(root.querySelector("form"));
          resolve({ attackIndex: Number(fd.get("attackIndex")), location: fd.get("location") });
        }}
      },
      default: "attack",
      close: () => resolve(null)
    }).render(true);
  });
}

function normalizeRollResult(result) {
  if (!result) return null;
  if (Array.isArray(result)) return result[0] ?? null;
  if (Array.isArray(result.rolls)) return result.rolls[0] ?? null;
  if (result.roll) return result.roll;
  return result.total !== undefined ? result : null;
}

function naturalD20(roll) {
  try {
    for (const term of roll.terms ?? []) {
      if (term.faces === 20 && Array.isArray(term.results)) {
        const active = term.results.filter(r => r.active !== false && r.discarded !== true);
        if (active.length) return active[active.length - 1].result;
      }
    }
  } catch (_) {}
  return null;
}

function criticalThreshold(activity) {
  return Number(activity.criticalThreshold ?? activity.attack?.critical?.threshold ?? 20) || 20;
}

/**
 * Roll through D&D5e's native AttackActivity API while injecting the targeted
 * penalty as a real D20 roll part. D&D5e 5.3.2 merges config.rolls[0].parts
 * with the activity's own attack parts in _buildAttackConfig, so the penalty
 * is visible in the native formula and is included in the total.
 */
async function rollNativeAttack(activity, penalty, locationLabel, context = null) {
  if (typeof activity.rollAttack !== "function") throw new Error("Attack activity does not expose rollAttack().");

  const penaltyPart = String(Number(penalty) || 0);
  const config = {
    rolls: [{ parts: [penaltyPart], data: {}, options: {} }]
  };
  const dialog = { configure: true };
  const message = {
    create: true,
    data: {
      flavor: `${activity.item.name} — Targeted Attack: ${locationLabel} (${penalty >= 0 ? "+" : ""}${penalty})`,
      ...(context ? { flags: { [MODULE_ID]: { kind: "native-attack", ...context } } } : {})
    }
  };

  return activity.rollAttack(config, dialog, message);
}

let TARGETING_SESSION = null;

function removeTargetingIndicator() {
  document.querySelectorAll(".tsa-targeting-indicator").forEach(el => el.remove());
}

async function restoreSceneControl(session) {
  if (!session?.previousControl || !ui.controls?.activate) return;
  try {
    await ui.controls.activate({
      control: session.previousControl,
      tool: session.previousTool || undefined
    });
  } catch (err) {
    console.debug(`${MODULE_TITLE} | Could not restore previous canvas tool.`, err);
  }
}

async function endTargetingSession({ restore = true } = {}) {
  const session = TARGETING_SESSION;
  if (!session) return;
  TARGETING_SESSION = null;
  removeTargetingIndicator();
  document.removeEventListener("pointermove", session.onPointerMove, true);
  document.removeEventListener("keydown", session.onKeyDown, true);
  document.removeEventListener("contextmenu", session.onContextMenu, true);
  if (session.targetHookId != null) Hooks.off("targetToken", session.targetHookId);
  if (restore) await restoreSceneControl(session);
}

function moveTargetingIndicator(event) {
  const indicator = document.querySelector(".tsa-targeting-indicator");
  if (!indicator) return;
  const pad = 18;
  let left = Number(event.clientX ?? 0) + pad;
  let top = Number(event.clientY ?? 0) + pad;
  const rect = indicator.getBoundingClientRect();
  left = Math.min(left, Math.max(4, window.innerWidth - rect.width - 8));
  top = Math.min(top, Math.max(4, window.innerHeight - rect.height - 8));
  indicator.style.left = `${Math.max(4, left)}px`;
  indicator.style.top = `${Math.max(4, top)}px`;
}

function createTargetingIndicator() {
  removeTargetingIndicator();
  const indicator = document.createElement("div");
  indicator.className = "tsa-targeting-indicator";
  indicator.innerHTML = '<i class="fa-solid fa-crosshairs"></i><span>0/1 Targets</span>';
  document.body.append(indicator);
  return indicator;
}

async function beginTargetSelection(actor) {
  if (TARGETING_SESSION) await endTargetingSession();
  if (!canvas?.ready || !ui.controls?.activate) {
    ui.notifications.warn(`${MODULE_TITLE}: The canvas must be ready to select a target.`);
    return;
  }

  const previousControl = ui.controls.control?.name ?? "tokens";
  const previousTool = ui.controls.tool?.name ?? "select";
  const indicator = createTargetingIndicator();

  const session = { actor, previousControl, previousTool, targetHookId: null };
  session.onPointerMove = event => moveTargetingIndicator(event);
  session.onKeyDown = event => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    endTargetingSession();
    ui.notifications.info(`${MODULE_TITLE}: Target selection cancelled.`);
  };
  session.onContextMenu = event => {
    // A simple right-click cancels this one-shot targeting state, matching
    // Foundry's general canvas interaction convention. Do not suppress drags.
    if (event.button !== 2) return;
    endTargetingSession();
  };
  session.targetHookId = Hooks.on("targetToken", async (user, token, targeted) => {
    if (TARGETING_SESSION !== session) return;
    if (user?.id !== game.user.id || !targeted || !token) return;

    const label = indicator?.querySelector("span");
    if (label) label.textContent = "1/1 Targets";

    // End the one-shot targeting mode before opening the attack dialog. The
    // target remains selected; only the active canvas tool is restored.
    await endTargetingSession();
    await openTargetedAttack(actor);
  });

  TARGETING_SESSION = session;
  document.addEventListener("pointermove", session.onPointerMove, true);
  document.addEventListener("keydown", session.onKeyDown, true);
  document.addEventListener("contextmenu", session.onContextMenu, true);

  try {
    // Foundry V14's native Select Targets tool already provides the correct
    // token hit-testing and targeting behavior. We activate it rather than
    // duplicating canvas interaction logic.
    await ui.controls.activate({ control: "tokens", tool: "target" });
    ui.notifications.info(`${MODULE_TITLE}: Click one creature to target it. Press Esc to cancel.`);
  } catch (err) {
    console.error(`${MODULE_TITLE} | Could not activate Foundry target tool.`, err);
    await endTargetingSession({ restore: false });
    ui.notifications.error(`${MODULE_TITLE}: Could not enter targeting mode. Check F12 console.`);
  }
}

async function requestTargetedAttack(actor = null) {
  actor ??= actorFromContext();
  if (!actor) {
    ui.notifications.warn(`${MODULE_TITLE}: Select one token, or assign yourself a character.`);
    return;
  }
  if (!actor.isOwner && !game.user.isGM) {
    ui.notifications.error(`${MODULE_TITLE}: You do not own this actor.`);
    return;
  }

  const targets = Array.from(game.user.targets ?? []);
  if (targets.length === 0) return beginTargetSelection(actor);
  if (targets.length > 1) {
    ui.notifications.warn(`${MODULE_TITLE}: Target exactly one creature before making a targeted attack.`);
    return;
  }
  return openTargetedAttack(actor);
}

async function openTargetedAttack(actor = null) {
  actor ??= actorFromContext();
  if (!actor) {
    ui.notifications.warn(`${MODULE_TITLE}: Select one token, or assign yourself a character.`);
    return;
  }
  if (!actor.isOwner && !game.user.isGM) {
    ui.notifications.error(`${MODULE_TITLE}: You do not own this actor.`);
    return;
  }
  const target = getTarget();
  if (!target) {
    return beginTargetSelection(actor);
  }
  const attacks = getAttackActivities(actor);
  if (!attacks.length) {
    ui.notifications.warn(`${MODULE_TITLE}: ${actor.name} has no D&D5e Attack activities.`);
    return;
  }

  const choice = await dialogChoice(actor, attacks);
  if (!choice) return;
  const selected = attacks[choice.attackIndex];
  const rule = RULES[choice.location];
  if (!selected || !rule) return;

  const targetHp = target.actor?.system?.attributes?.hp;
  const hpValue = Number(targetHp?.value ?? 0);
  const hpMax = Number(targetHp?.max ?? 0);
  const bloodiedBefore = hpMax > 0 && hpValue <= (hpMax / 2);
  const targetAc = Number(target.actor?.system?.attributes?.ac?.value ?? NaN);

  ui.notifications.info(rule.standard
    ? `${MODULE_TITLE}: Standard attack — using the native attack formula with no targeted modifier.`
    : `${MODULE_TITLE}: ${rule.label} attack — native attack formula includes ${rule.attack}.`);
  let attackResult;
  const attackContext = {
    attackId: foundry.utils.randomID(), actorUuid: actor.uuid, itemUuid: selected.item.uuid,
    activityId: selected.activity.id, location: choice.location,
    targetActorUuid: target.actor?.uuid, targetTokenUuid: target.document?.uuid ?? target.uuid
  };
  try {
    attackResult = await rollNativeAttack(selected.activity, rule.attack, rule.label, attackContext);
  } catch (err) {
    console.error(`${MODULE_TITLE} | Native targeted attack failed`, err);
    ui.notifications.error(`${MODULE_TITLE}: Could not roll this attack. Check the browser console (F12).`);
    return;
  }

  const roll = normalizeRollResult(attackResult);
  if (!roll) {
    ui.notifications.warn(`${MODULE_TITLE}: The native attack workflow did not return a roll.`);
    return;
  }

  const total = Number(roll.total ?? 0);
  const nat = naturalD20(roll);
  const crit = Boolean(roll.isCritical) || (nat !== null && nat >= criticalThreshold(selected.activity));
  const fumble = nat === 1;
  const detectedHit = !fumble && (crit || !Number.isFinite(targetAc) || total >= targetAc);

  const flags = {
    kind: "attack-result",
    nativeAttackMessageId: Array.from(game.messages).find(m =>
      m.flags?.[MODULE_ID]?.kind === "native-attack"
      && m.flags[MODULE_ID].attackId === attackContext.attackId)?.id ?? null,
    actorUuid: actor.uuid,
    targetActorUuid: target.actor?.uuid ?? null,
    targetTokenUuid: target.document?.uuid ?? target.uuid ?? null,
    itemUuid: selected.item.uuid,
    activityId: selected.activity.id,
    location: choice.location,
    attackPenalty: rule.attack,
    attackTotal: total,
    attackFormula: roll.formula ?? null,
    natural: nat,
    critical: crit,
    detectedHit,
    bloodiedBefore
  };

  await postResultCard(flags, { actor, target, item: selected.item, rule, targetAc });
}

async function postResultCard(flags, {actor, target, item, rule, targetAc}) {
  const status = flags.critical ? "CRITICAL HIT" : flags.detectedHit ? "HIT" : "MISS";
  const statusClass = flags.critical ? "crit" : flags.detectedHit ? "hit" : "miss";
  const damageText = rule.standard ? "Normal native damage" : rule.damage === "0" ? "0 damage" : rule.damage ? `Native damage × (${rule.damage})` : "Normal native damage";
  const acText = Number.isFinite(targetAc) ? ` vs AC ${targetAc}` : "";

  const gmButtons = [];
  // Bloodied is informational for targeted attacks; it is not manually applied from this card.
  // Other hit-effect buttons remain available (for example Arm disadvantage or Leg no-Dash).
  if (flags.detectedHit && rule.hit && !/^Bloodied\b/i.test(rule.hit.name)) {
    gmButtons.push(`<button type="button" data-tsa-action="apply-effect" data-kind="hit"><i class="fa-solid fa-wand-magic-sparkles"></i> Apply ${esc(rule.hit.name)}</button>`);
  }
  if (flags.detectedHit && rule.bloodied) gmButtons.push(`<button type="button" data-tsa-action="apply-effect" data-kind="bloodied"><i class="fa-solid fa-droplet"></i> Apply ${esc(rule.bloodied.name)}</button>`);
  if (flags.critical && rule.critical) gmButtons.push(`<button type="button" data-tsa-action="apply-effect" data-kind="critical"><i class="fa-solid fa-skull"></i> Apply ${esc(rule.critical.name)}</button>`);

  const damageButton = flags.detectedHit
    ? `<button type="button" data-tsa-action="roll-damage"><i class="fa-solid fa-dice-d6"></i> ${rule.standard ? "Roll Damage" : rule.damage === "0" ? "Resolve 0 Damage" : "Roll Special Damage"}</button>` : "";

  const content = `<div class="tsa-card">
    <header><i class="fa-solid fa-crosshairs"></i><div><strong>Targeted Attack — ${esc(rule.label)}</strong><small>${esc(actor.name)} → ${esc(target.name)}</small></div></header>
    <div class="tsa-result ${statusClass}">${status}</div>
    <dl>
      <dt>Weapon</dt><dd>${esc(item.name)}</dd>
      <dt>Attack</dt><dd>${flags.attackTotal}${acText}${rule.standard ? "" : ` <span class="muted">(${rule.attack} is already included in the native roll)</span>`}</dd>
      ${flags.attackFormula ? `<dt>Formula</dt><dd><code>${esc(flags.attackFormula)}</code></dd>` : ""}
      <dt>Damage</dt><dd>${esc(damageText)}</dd>
      <dt>Target Bloodied before attack?</dt><dd>${flags.bloodiedBefore ? "Yes" : "No"}</dd>
    </dl>
    ${flags.detectedHit && rule.hit ? `<p><strong>Hit effect:</strong> ${esc(rule.hit.name)}</p>` : ""}
    ${flags.detectedHit && rule.bloodied ? `<p><strong>Bloodied hit:</strong> ${esc(rule.bloodied.name)} <span class="muted">(apply if already Bloodied or becomes Bloodied from this attack)</span></p>` : ""}
    ${flags.critical && rule.critical ? `<p><strong>Critical effect:</strong> ${esc(rule.critical.name)}</p>` : ""}
    <div class="tsa-actions">${damageButton}${gmButtons.join("")}</div>
    <footer>${rule.standard ? "Standard uses the normal D&D5e attack and damage formulas with no targeted modifiers." : "The targeted accuracy penalty is part of the native attack formula. Permanent/crippling effects still require GM confirmation."}</footer>
  </div>`;

  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content,
    flags: { [MODULE_ID]: flags }
  });
}

async function markSourceActionApplied(message, actionKey) {
  if (!message || !actionKey) return;
  const current = message.flags?.[MODULE_ID]?.appliedActions ?? {};
  if (current[actionKey]) return;
  await message.update({
    [`flags.${MODULE_ID}.appliedActions.${actionKey}`]: {
      applied: true,
      userId: game.user.id,
      at: Date.now()
    }
  });
}

function normalizeDamageRolls(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.rolls)) return result.rolls;
  return [result];
}

function serializeDamageParts(rolls, multiplier) {
  return rolls.map(roll => {
    const base = Number(roll.total) || 0;
    const options = roll.options ?? {};
    return {
      base,
      value: base * multiplier,
      type: options.type ?? null,
      types: Array.from(options.types ?? []),
      properties: Array.from(options.properties ?? [])
    };
  });
}

function damageTypeLabel(type) {
  if (!type) return "untyped";
  return CONFIG.DND5E.damageTypes?.[type]?.label ?? CONFIG.DND5E.healingTypes?.[type]?.label ?? type;
}

async function postModifiedDamageCard(sourceFlags, rule, rolls, multiplierRoll, multiplier, evidence = {}) {
  const parts = serializeDamageParts(rolls, multiplier);
  const baseTotal = parts.reduce((sum, p) => sum + p.base, 0);
  const finalTotal = parts.reduce((sum, p) => sum + p.value, 0);
  const breakdown = parts.map(p => `${p.value} ${esc(damageTypeLabel(p.type))}`).join(" + ") || `${finalTotal}`;
  const multiplierText = rule.damage ? `${esc(rule.damage)} → ${multiplier}` : "×1";
  const damageTitle = rule.standard ? "Standard Damage" : `Modified Targeted Damage — ${esc(rule.label)}`;
  const damageSubtitle = rule.standard ? `Native damage ${baseTotal}` : `Base ${baseTotal} · Multiplier ${multiplierText}`;

  const flags = {
    kind: "modified-damage",
    ...evidence,
    sourceActorUuid: sourceFlags.actorUuid ?? null,
    targetActorUuid: sourceFlags.targetActorUuid,
    targetTokenUuid: sourceFlags.targetTokenUuid,
    location: sourceFlags.location,
    multiplier,
    baseTotal,
    finalTotal,
    damageParts: parts
  };

  const content = `<div class="tsa-card tsa-modified-damage">
    <header><i class="fa-solid fa-burst"></i><div><strong>${damageTitle}</strong><small>${damageSubtitle}</small></div></header>
    <div class="tsa-modified-total">${finalTotal}</div>
    <p class="tsa-damage-types">${breakdown}</p>
    <div class="damage-application tsa-modified-application">
      <button type="button" data-tsa-action="apply-damage" data-multiplier="1"><i class="fa-solid fa-heart"></i> APPLY</button>
    </div>
    <footer>Apply sends the ${rule.standard ? "native" : "modified"} typed damage through D&D5e's Actor.applyDamage workflow, so resistances, vulnerabilities, immunities, and temporary HP are still calculated by the system.</footer>
  </div>`;

  const damageMessage = await ChatMessage.create({
    content,
    flags: { [MODULE_ID]: flags }
  });

  if (multiplierRoll) {
    console.log(`${MODULE_TITLE} | Targeted multiplier roll`, multiplierRoll);
  }
  return damageMessage;
}


function isLikelyNativeDamageMessage(message, capture) {
  if (!message) return false;
  const native = message.flags?.dnd5e ?? {};
  const isDamage = message.type === "damage"
    || native.roll?.type === "damage"
    || (native.messageType === "roll" && native.roll?.type === "damage");
  if (!isDamage) return false;
  if (capture?.authorId && documentAuthor(message)?.id !== capture.authorId) return false;
  const captured = message.flags?.[MODULE_ID]?.captureId;
  if (captured && captured !== capture?.id) return false;
  if (native?.item?.uuid && native.item.uuid !== capture?.itemUuid) return false;
  if (native?.activity?.id && native.activity.id !== capture?.activityId) return false;
  const speakerActor = message.speaker?.actor ?? null;
  if (capture?.actorId && speakerActor && capture.actorId !== speakerActor) return false;
  if (!captured && !native?.item?.uuid && (!speakerActor || speakerActor !== capture?.actorId)) return false;
  const created = Number(message.timestamp ?? message._source?.timestamp ?? Date.now());
  if (capture?.startedAt && Math.abs(created - capture.startedAt) > 120000) return false;
  return true;
}

async function ensureBaseDamageMessageTagged(capture, beforeIds = new Set()) {
  // D&D5e 5.3.x does not always preserve custom flags passed through
  // Activity#rollDamage. After the native roll completes, locate the newly
  // created damage message and explicitly tag it so its Apply tray can be
  // suppressed while keeping the roll card itself visible.
  const candidates = Array.from(game.messages ?? []).filter(m =>
    !beforeIds.has(m.id) && isLikelyNativeDamageMessage(m, capture)
  );
  const exact = candidates.filter(m => m.flags?.[MODULE_ID]?.captureId === capture.id);
  const matches = exact.length ? exact : candidates;
  const message = matches.length === 1 ? matches[0] : null;
  if (!message) return null;

  if (message.flags?.[MODULE_ID]?.kind !== "base-damage"
    || message.flags?.[MODULE_ID]?.sourceMessageId !== capture.sourceMessageId) {
    try {
      await message.update({
        [`flags.${MODULE_ID}.kind`]: "base-damage",
        [`flags.${MODULE_ID}.captureId`]: capture.id,
        [`flags.${MODULE_ID}.sourceMessageId`]: capture.sourceMessageId
      });
    } catch (err) {
      console.warn(`${MODULE_TITLE} | Could not post-tag native base damage message.`, err);
    }
  }
  return message;
}

async function rollSpecialDamage(message) {
  const flags = message.flags?.[MODULE_ID];
  if (!flags || flags.appliedActions?.["roll-damage"]?.applied) return;
  if (Array.from(game.messages).some(m => m.flags?.[MODULE_ID]?.kind === "modified-damage"
    && m.flags[MODULE_ID].sourceMessageId === message.id)) return;

  // Players who own the attacking actor may roll their own damage even when
  // Foundry/D&D5e attributes the result chat card to a different user. This is
  // common with HUD-driven workflows and avoids unnecessarily GM-locking damage.
  let sourceActor = null;
  try {
    sourceActor = flags.actorUuid ? await fromUuid(flags.actorUuid) : null;
  } catch (err) {
    console.warn(`${MODULE_TITLE} | Could not resolve source actor for damage permission check.`, err);
  }
  const canRollDamage = Boolean(game.user.isGM || sourceActor?.isOwner);
  if (!canRollDamage) {
    ui.notifications.warn(`${MODULE_TITLE}: You must own the attacking character to roll this damage.`);
    return;
  }

  // Foundry/D&D5e can render the same chat message through more than one hook.
  // This lock prevents concurrent native damage workflows on this client.
  const rollKey = message.uuid ?? message.id;
  if (ACTIVE_DAMAGE_ROLLS.has(rollKey)) return;
  ACTIVE_DAMAGE_ROLLS.add(rollKey);

  try {
    const rule = RULES[flags.location];
    if (!rule) return;

    if (rule.damage === "0") {
      const damageMessage = await postModifiedDamageCard(flags, rule, [], null, 0, { sourceMessageId: message.id });
      await finishDamageRoll(message, damageMessage);
      return;
    }

  const item = await fromUuid(flags.itemUuid);
  const activity = item?.system?.activities?.get?.(flags.activityId);
  if (!activity || typeof activity.rollDamage !== "function") {
    ui.notifications.error(`${MODULE_TITLE}: Could not find the original damage activity.`);
    return;
  }

  const damageConfig = { isCritical: Boolean(flags.critical) };
  let result;
  const capture = {
    id: foundry.utils.randomID(),
    actorId: item.actor?.id ?? null,
    authorId: game.user.id,
    sourceMessageId: message.id,
    itemUuid: item.uuid,
    activityId: activity.id,
    startedAt: Date.now()
  };
  const beforeDamageMessageIds = new Set(Array.from(game.messages ?? []).map(m => m.id));
  PENDING_BASE_DAMAGE_CAPTURES.push(capture);
  try {
    try {
      result = await activity.rollDamage(damageConfig, { configure: true }, {
        create: true,
        data: { flags: { [MODULE_ID]: { kind: "base-damage", captureId: capture.id, sourceMessageId: message.id } } }
      });
    } catch (err) {
      if (Array.from(game.messages).some(m => !beforeDamageMessageIds.has(m.id) && isLikelyNativeDamageMessage(m, capture))) {
        throw new Error("Native damage was posted before the roll failed. Review chat before retrying.", { cause: err });
      }
      console.warn(`${MODULE_TITLE} | Native 3-argument damage call failed, trying no-dialog fallback.`, err);
      try {
        result = await activity.rollDamage(damageConfig, { configure: false }, {
          create: true,
          data: { flags: { [MODULE_ID]: { kind: "base-damage", captureId: capture.id, sourceMessageId: message.id } } }
        });
      } catch (err2) {
        console.error(`${MODULE_TITLE} | Native damage roll failed.`, err2);
        ui.notifications.error(`${MODULE_TITLE}: Native damage roll failed. Check F12 console.`);
        return;
      }
    }
  } finally {
    const index = PENDING_BASE_DAMAGE_CAPTURES.findIndex(c => c.id === capture.id);
    if (index >= 0) PENDING_BASE_DAMAGE_CAPTURES.splice(index, 1);
  }

  // Explicitly tag the actual native message even if D&D5e discarded the
  // flags supplied in the rollDamage options. Updating the message causes
  // Foundry to re-render it with our base-damage presentation rules.
  const baseMessage = await ensureBaseDamageMessageTagged(capture, beforeDamageMessageIds);

  const rolls = normalizeDamageRolls(result).filter(r => Number.isFinite(Number(r?.total)));
  if (!rolls.length) {
    ui.notifications.warn(`${MODULE_TITLE}: Native damage roll returned no damage rolls.`);
    return;
  }

  let multiplier = 1;
  let multiplierRoll = null;
  let multiplierMessage = null;
  if (rule.damage) {
    multiplierRoll = await (new Roll(rule.damage)).evaluate();
    multiplier = Number(multiplierRoll.total ?? 1);
    multiplierMessage = await multiplierRoll.toMessage({
      flavor: `${rule.label} targeted damage multiplier`,
      flags: { [MODULE_ID]: { kind: "multiplier", sourceMessageId: message.id } }
    });
  }

    const damageMessage = await postModifiedDamageCard(flags, rule, rolls, multiplierRoll, multiplier, {
      sourceMessageId: message.id, nativeDamageMessageId: baseMessage?.id ?? null,
      captureId: capture.id, multiplierMessageId: multiplierMessage?.id ?? null
    });
    await finishDamageRoll(message, damageMessage);
  } catch (err) {
    console.error(`${MODULE_TITLE} | Damage roll failed`, err);
    ui.notifications.error(`${MODULE_TITLE}: ${err.message}`);
  } finally {
    ACTIVE_DAMAGE_ROLLS.delete(rollKey);
  }
}

async function finishDamageRoll(source, damageMessage) {
  // Marking someone else's source card is a GM task; the final card also guards rerolls.
  if (game.user.isGM || source.isAuthor) await markSourceActionApplied(source, "roll-damage");
  if (game.settings.get(MODULE_ID, AUTO_APPLY_PLAYER_DAMAGE_SETTING)) {
    await requestGMAutoDamageApplication(damageMessage);
  }
}

function primaryActiveGM() {
  return game.users
    ?.filter(user => user.isGM && user.active)
    ?.sort((a, b) => String(a.id).localeCompare(String(b.id)))?.[0] ?? null;
}

function documentAuthor(message) {
  return message?.author ?? game.users.get(message?.user?.id ?? message?.user);
}

function ledgerData() {
  return foundry.utils.deepClone(game.settings.get(MODULE_ID, LEDGER_SETTING) ?? { attacks: {}, applications: {} });
}

function coordinator() {
  const id = game.settings.get(MODULE_ID, COORDINATOR_SETTING);
  return id ? game.users.get(id) : primaryActiveGM();
}

function isCoordinator() {
  return Boolean(game.user.isGM && coordinator()?.id === game.user.id && game.user.active);
}

function queueCoordinator(task) {
  // One queue serializes ledger writes as well as HP/effect mutations.
  const result = COORDINATOR_QUEUE.then(async () => {
    if (!isCoordinator()) return;
    if (!game.settings.get(MODULE_ID, COORDINATOR_SETTING)) {
      await game.settings.set(MODULE_ID, COORDINATOR_SETTING, game.user.id);
    }
    if (!isCoordinator()) return;
    return task();
  });
  COORDINATOR_QUEUE = result.catch(err => {
    console.error(`${MODULE_TITLE} | Coordinator`, err);
    ui.notifications.error(`${MODULE_TITLE}: ${err.message}`);
  });
  return COORDINATOR_QUEUE;
}

async function saveLedger(ledger) {
  if (!isCoordinator()) throw new Error("Damage coordinator changed. Review pending applications before continuing.");
  await game.settings.set(MODULE_ID, LEDGER_SETTING, ledger);
  if (!isCoordinator()) throw new Error("Damage coordinator changed during persistence.");
}

async function resolveDamageTarget(flags) {
  const actor = flags.targetActorUuid ? await fromUuid(flags.targetActorUuid) : null;
  const token = flags.targetTokenUuid ? await fromUuid(flags.targetTokenUuid) : null;
  if (!actor || !token?.actor || token.actor.uuid !== actor.uuid) {
    throw new Error("Target token and actor could not be resolved consistently.");
  }
  return token.actor;
}

async function recordNativeAttack(message, creatorId) {
  const flags = message.flags?.[MODULE_ID];
  if (flags?.kind !== "native-attack") return;
  const ledger = ledgerData();
  if (Object.hasOwn(ledger.attacks, message.id)) return;
  const author = game.users.get(creatorId);
  const actor = await fromUuid(flags.actorUuid);
  const item = await fromUuid(flags.itemUuid);
  const rule = RULES[flags.location];
  if (!author || !actor || !rule || (!author.isGM && !actor.testUserPermission(author, "OWNER"))) return;
  if (item?.actor?.uuid !== actor.uuid || !item.system?.activities?.get(flags.activityId)) return;
  const native = message.flags?.dnd5e;
  if (native?.roll?.type !== "attack" || native.item?.uuid !== item.uuid || native.activity?.id !== flags.activityId) return;
  const target = await resolveDamageTarget(flags);
  const roll = message.rolls?.[0];
  if (!roll || !Number.isFinite(roll.total)) return;
  const nat = naturalD20(roll);
  const activity = item.system.activities.get(flags.activityId);
  const critical = Boolean(roll.isCritical) || (nat !== null && nat >= criticalThreshold(activity));
  const ac = Number(target.system?.attributes?.ac?.value ?? NaN);
  ledger.attacks[message.id] = {
    actorUuid: actor.uuid, itemUuid: item.uuid, activityId: flags.activityId,
    location: flags.location, targetActorUuid: target.uuid, targetTokenUuid: flags.targetTokenUuid,
    attackTotal: roll.total, critical,
    detectedHit: nat !== 1 && (critical || !Number.isFinite(ac) || roll.total >= ac),
    authorId: author.id, at: Date.now(), sourceMessageId: null
  };
  await saveLedger(ledger);
}

async function bindSourceMessage(message, creatorId) {
  const flags = message.flags?.[MODULE_ID];
  if (flags?.kind !== "attack-result" || !flags.nativeAttackMessageId) return;
  const ledger = ledgerData();
  const attack = ledger.attacks[flags.nativeAttackMessageId];
  if (!attack || attack.sourceMessageId || !attackMatches(attack, flags)) return;
  if (creatorId !== attack.authorId || flags.attackTotal !== attack.attackTotal
    || flags.critical !== attack.critical || flags.detectedHit !== attack.detectedHit) return;
  attack.sourceMessageId = message.id;
  await saveLedger(ledger);
}

async function recordDamageEvidence(message, creatorId) {
  const flags = message.flags?.[MODULE_ID];
  if (!["base-damage", "multiplier"].includes(flags?.kind) || !message.rolls?.length) return;
  if (message.rolls.some(r => !Number.isFinite(r.total))) return;
  const ledger = ledgerData();
  ledger.rolls ??= {};
  if (Object.hasOwn(ledger.rolls, message.id)) return;
  ledger.rolls[message.id] = {
    flags: foundry.utils.deepClone(flags), native: foundry.utils.deepClone(message.flags?.dnd5e ?? {}),
    authorId: creatorId,
    parts: serializeDamageParts(message.rolls, 1), formula: message.rolls[0].formula,
    total: message.rolls[0].total
  };
  await saveLedger(ledger);
}

function damageSignature(flags) {
  return JSON.stringify([flags.sourceMessageId, flags.sourceActorUuid, flags.targetActorUuid,
    flags.targetTokenUuid, flags.location, flags.multiplier, flags.baseTotal, flags.finalTotal,
    flags.damageParts, flags.nativeDamageMessageId, flags.captureId, flags.multiplierMessageId]);
}

async function recordFinalCard(message, creatorId) {
  const ledger = ledgerData();
  ledger.cards ??= {};
  if (Object.hasOwn(ledger.cards, message.id)) return;
  ledger.cards[message.id] = { creatorId, signature: damageSignature(message.flags[MODULE_ID]) };
  await saveLedger(ledger);
  // The source can be authored by another user. Only the GM writes its completion flag.
  try {
    const result = await validateFinalDamage(message, ledger, false);
    if (result.source) await markSourceActionApplied(result.source, "roll-damage");
  } catch (err) {
    console.debug(`${MODULE_TITLE} | Final card awaits validation or manual review.`, err.message);
  }
}

async function validateFinalDamage(message, ledger, manual) {
  const flags = foundry.utils.deepClone(message.flags?.[MODULE_ID]);
  if (flags?.kind !== "modified-damage") throw new Error("Not a final damage card.");
  const receipt = ledger.cards?.[message.id];
  if (receipt && receipt.signature !== damageSignature(flags)) throw new Error("Damage card changed after its creation. Review it rather than applying edited data.");
  const source = game.messages.get(flags.sourceMessageId);
  const sourceFlags = foundry.utils.deepClone(source?.flags?.[MODULE_ID]);
  const attackId = sourceFlags?.nativeAttackMessageId;
  const attack = ledger.attacks[attackId];
  if (!attack || attack.sourceMessageId !== source?.id) {
    // Old/offline-GM cards require an explicit manual review, never socket approval.
    if (!manual) throw new Error("No GM-recorded attack evidence. A GM must review and apply this card manually.");
    validateParts(flags.damageParts, flags.finalTotal);
    await resolveDamageTarget(flags);
    return { key: attackId ? `attack:${attackId}` : `legacy:${source?.id ?? message.id}`, parts: flags.damageParts, target: flags, source };
  }
  const author = game.users.get(receipt?.creatorId);
  const actor = await fromUuid(attack.actorUuid);
  if (!author || !actor || (!author.isGM && !actor.testUserPermission(author, "OWNER"))) throw new Error("Damage author does not own the attacker.");
  if (!attack.detectedHit || !attackMatches(attack, sourceFlags)
    || flags.sourceActorUuid !== attack.actorUuid || flags.location !== attack.location
    || flags.targetActorUuid !== attack.targetActorUuid || flags.targetTokenUuid !== attack.targetTokenUuid) {
    throw new Error("Damage card does not match the GM-recorded attack.");
  }
  const rule = RULES[attack.location];
  if (!validMultiplier(rule, flags.multiplier)) throw new Error("Invalid targeted multiplier.");
  let expected = [];
  if (rule.damage !== "0") {
    const base = ledger.rolls?.[flags.nativeDamageMessageId];
    const baseFlags = base?.flags;
    const native = base?.native;
    if (!base || base.authorId !== author.id || baseFlags?.kind !== "base-damage"
      || baseFlags.sourceMessageId !== source.id || baseFlags.captureId !== flags.captureId
      || native?.roll?.type !== "damage" || native.item?.uuid !== attack.itemUuid
      || native.activity?.id !== attack.activityId || !base.parts?.length) {
      throw new Error("Native damage evidence is missing or belongs to another attack.");
    }
    expected = base.parts.map(p => ({ ...p, value: p.base * flags.multiplier }));
    if (rule.damage) {
      const multiplier = ledger.rolls?.[flags.multiplierMessageId];
      if (multiplier?.authorId !== author.id || multiplier?.flags?.kind !== "multiplier"
        || multiplier.flags.sourceMessageId !== source.id
        || multiplier.formula?.replace(/\s/g, "") !== rule.damage
        || multiplier.total !== flags.multiplier) throw new Error("Multiplier roll evidence does not match.");
    }
  }
  validateParts(flags.damageParts, flags.finalTotal);
  if (flags.baseTotal !== expected.reduce((sum, p) => sum + p.base, 0)) throw new Error("Base damage total does not match native evidence.");
  if (!sameParts(expected, flags.damageParts)) throw new Error("Final damage differs from native roll evidence.");
  return { key: `attack:${attackId}`, parts: expected, target: attack, source };
}

async function applyFinalDamage(message, { manual = false } = {}) {
  if (!isCoordinator()) return;
  if (message.flags?.[MODULE_ID]?.applied) return;
  if (!manual && !game.settings.get(MODULE_ID, AUTO_APPLY_PLAYER_DAMAGE_SETTING)) return;
  const ledger = ledgerData();
  const result = await validateFinalDamage(message, ledger, manual);
  const previous = ledger.applications[result.key];
  if (previous?.state === "applied") {
    await markDamageApplied(message);
    return;
  }
  if (previous || UNCERTAIN_APPLICATIONS.has(result.key)) {
    await message.update({ [`flags.${MODULE_ID}.applicationState`]: "pending" });
    throw new Error("Application outcome needs GM reconciliation; damage was not retried.");
  }
  const actor = await resolveDamageTarget(result.target);
  // Save a write-ahead record BEFORE HP. Never retry an ambiguous outcome.
  ledger.applications[result.key] = {
    state: "pending", messageId: message.id, targetActorUuid: actor.uuid,
    sourceMessageId: result.source?.id ?? null, at: Date.now(), gmId: game.user.id,
    parts: result.parts
  };
  UNCERTAIN_APPLICATIONS.add(result.key);
  try { await saveLedger(ledger); }
  catch (err) {
    // HP has not been touched. A persisted pending record still blocks retries,
    // but a rejected write must not leave an unrecoverable memory-only lock.
    UNCERTAIN_APPLICATIONS.delete(result.key);
    throw err;
  }
  if (!isCoordinator()) return;
  if (!manual && !game.settings.get(MODULE_ID, AUTO_APPLY_PLAYER_DAMAGE_SETTING)) {
    // No HP call occurred, so this particular cancellation is safe to release.
    delete ledger.applications[result.key];
    await saveLedger(ledger);
    UNCERTAIN_APPLICATIONS.delete(result.key);
    return;
  }
  await message.update({ [`flags.${MODULE_ID}.applicationState`]: "pending" });
  if (!isCoordinator()) return;
  if (!manual && !game.settings.get(MODULE_ID, AUTO_APPLY_PLAYER_DAMAGE_SETTING)) {
    delete ledger.applications[result.key];
    await saveLedger(ledger);
    UNCERTAIN_APPLICATIONS.delete(result.key);
    await message.update({ [`flags.${MODULE_ID}.applicationState`]: "reviewed" });
    return;
  }
  if (result.parts.length) {
    await actor.applyDamage(result.parts.map(p => ({ value: p.value, type: p.type ?? undefined,
      properties: new Set(p.properties) })), { multiplier: 1, originatingMessage: message });
  }
  ledger.applications[result.key].state = "applied";
  ledger.applications[result.key].completedAt = Date.now();
  await saveLedger(ledger);
  UNCERTAIN_APPLICATIONS.delete(result.key);
  await markDamageApplied(message);
  if (result.source) await markSourceActionApplied(result.source, "roll-damage");
}

async function markDamageApplied(message) {
  await message.update({
    [`flags.${MODULE_ID}.applied`]: true, [`flags.${MODULE_ID}.applicationState`]: "applied",
    [`flags.${MODULE_ID}.appliedBy`]: game.user.id, [`flags.${MODULE_ID}.appliedAt`]: Date.now()
  });
}

async function requestGMAutoDamageApplication(message) {
  if (!message || !game.settings.get(MODULE_ID, AUTO_APPLY_PLAYER_DAMAGE_SETTING)) return;
  const gm = coordinator();
  if (!gm?.active) {
    console.warn(`${MODULE_TITLE} | Damage coordinator unavailable; a GM must review the card.`);
    return;
  }
  if (isCoordinator()) return queueCoordinator(() => applyFinalDamage(message));
  game.socket.emit(`module.${MODULE_ID}`, {
    type: "auto-apply-modified-damage", gmId: gm.id, messageId: message.id
  });
}

async function applyModifiedDamage(message, applicationMultiplier) {
  if (!game.user.isGM || applicationMultiplier !== 1) return;
  const approvedSignature = damageSignature(message.flags?.[MODULE_ID] ?? {});
  const ledger = ledgerData();
  const source = game.messages.get(message.flags?.[MODULE_ID]?.sourceMessageId);
  const known = ledger.attacks[source?.flags?.[MODULE_ID]?.nativeAttackMessageId]?.sourceMessageId === source?.id && Boolean(source);
  if (!known) {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Review legacy / unverified damage" },
      content: "<p>This card has no GM-recorded attack evidence. Verify its target and damage in chat before approving.</p>"
    });
    if (!confirmed) return;
  }
  return submitGMAction({ action: "damage", messageId: message.id,
    signature: approvedSignature });
}

async function submitGMAction(request) {
  if (!game.user.isGM) return;
  if (!coordinator()?.active) {
    ui.notifications.warn(`${MODULE_TITLE}: Coordinator offline. Use TargetedSpecialAttacks.takeOverDamage() after reviewing pending work.`);
    return;
  }
  // This world setting is GM-write-only. Socket payloads cannot impersonate approval.
  await game.settings.set(MODULE_ID, MANUAL_REQUEST_SETTING, { ...request, nonce: foundry.utils.randomID() });
}

function handleGMAction(request) {
  if (!isCoordinator()) return;
  return queueCoordinator(async () => {
    const message = game.messages.get(request.messageId);
    if (!message) return;
    if (request.action === "damage") {
      if (request.signature !== damageSignature(message.flags?.[MODULE_ID] ?? {})) throw new Error("Damage changed after GM approval.");
      await applyFinalDamage(message, { manual: true });
    }
    else if (request.action === "effect") {
      if (request.signature !== effectSignature(message.flags?.[MODULE_ID] ?? {})) throw new Error("Injury target changed after GM approval.");
      await applyEffectOnce(message, request.kind);
    }
    else if (request.action === "reconcile") await reconcileApplication(message, request.outcome, request.kind ?? null);
  });
}

async function takeOverDamage() {
  if (!game.user.isGM || coordinator()?.active) return;
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Take over damage coordination" },
    content: "<p>Ensure the previous GM client is closed and any in-flight work has stopped. Pending applications will remain blocked for reconciliation. Take over?</p>"
  });
  if (!confirmed) return;
  await game.settings.set(MODULE_ID, COORDINATOR_SETTING, game.user.id);
}

async function reconcileApplication(message, outcome, kind = null) {
  if (!["applied", "not-applied"].includes(outcome)) return;
  const ledger = ledgerData();
  const flags = message.flags?.[MODULE_ID] ?? {};
  const receipt = ledger.cards?.[message.id];
  if (!kind && receipt && receipt.signature !== damageSignature(flags)) throw new Error("Damage card changed; review the original application card.");
  const entry = Object.entries(ledger.applications).find(([, r]) => (r.messageId === message.id
    || (!kind && r.sourceMessageId && r.sourceMessageId === flags.sourceMessageId))
    && (r.kind ?? null) === kind && ["pending", "applied"].includes(r.state));
  if (!entry) return;
  const [key, record] = entry;
  if (record.state === "applied") {
    // A confirmed completion is never cleared, even if a stale review dialog
    // reports not-applied. Repair presentation without touching HP/effects.
    if (kind) await markSourceActionApplied(message, `apply-effect:${kind}`);
    else {
      await markDamageApplied(message);
      const original = game.messages.get(record.messageId);
      if (original && original.id !== message.id) await markDamageApplied(original);
    }
    return;
  }
  ledger.reconciliations ??= [];
  ledger.reconciliations.push({ key, outcome, by: game.user.id, at: Date.now() });
  if (outcome === "applied") record.state = "applied";
  else delete ledger.applications[key];
  await saveLedger(ledger);
  UNCERTAIN_APPLICATIONS.delete(key);
  if (kind) {
    if (outcome === "applied") await markSourceActionApplied(message, `apply-effect:${kind}`);
  } else if (outcome === "applied") {
    await markDamageApplied(message);
    const original = game.messages.get(record.messageId);
    if (original && original.id !== message.id) await markDamageApplied(original);
  }
  else await message.update({ [`flags.${MODULE_ID}.applicationState`]: "reviewed" });
}

async function requestReconciliation(messageId, outcome, kind = null) {
  if (!game.user.isGM || !["applied", "not-applied"].includes(outcome)) return;
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Reconcile damage outcome" },
    content: `<p>After checking the target HP and combat log, record this application as ${esc(outcome)}? This does not change HP. Choosing not-applied permits another GM Apply click.</p>`
  });
  if (confirmed) await submitGMAction({ action: "reconcile", messageId, outcome, kind });
}

async function reviewDamage(message) {
  if (!game.user.isGM) return;
  const outcome = await foundry.applications.api.DialogV2.wait({
    window: { title: "Review interrupted damage" },
    content: "<p>Check the target's HP and combat log. Has this damage already been applied? If uncertain, cancel. This review does not change HP.</p>",
    buttons: [
      { action: "cancel", label: "Cancel", default: true, callback: () => null },
      { action: "applied", label: "Already applied", callback: () => "applied" },
      { action: "not-applied", label: "Not applied — allow retry", callback: () => "not-applied" }
    ], close: () => null
  });
  if (["applied", "not-applied"].includes(outcome)) await submitGMAction({ action: "reconcile", messageId: message.id, outcome });
}

function damageStatus(messageId = null) {
  if (!game.user.isGM) return null;
  return { coordinatorId: coordinator()?.id ?? null, coordinatorActive: Boolean(coordinator()?.active),
    applications: Object.entries(ledgerData().applications).filter(([, r]) => messageId ? r.messageId === messageId : r.state === "pending") };
}

async function applyEffect(message, kind) {
  if (!game.user.isGM || !["hit", "bloodied", "critical"].includes(kind)) return;
  return submitGMAction({ action: "effect", messageId: message.id, kind,
    signature: effectSignature(message.flags?.[MODULE_ID] ?? {}) });
}

function effectSignature(flags) {
  return JSON.stringify([flags.nativeAttackMessageId, flags.actorUuid, flags.itemUuid, flags.activityId,
    flags.location, flags.targetActorUuid, flags.targetTokenUuid]);
}

async function applyEffectOnce(message, kind) {
  if (!game.user.isGM) {
    ui.notifications.warn(`${MODULE_TITLE}: Only the GM can apply targeted injuries.`);
    return;
  }
  const flags = foundry.utils.deepClone(message.flags?.[MODULE_ID]);
  if (!["hit", "bloodied", "critical"].includes(kind) || flags?.appliedActions?.[`apply-effect:${kind}`]?.applied) return;
  const rule = RULES[flags?.location];
  const effect = rule?.[kind];
  if (!effect) return;
  const actor = await resolveDamageTarget(flags);
  if (!actor) {
    ui.notifications.error(`${MODULE_TITLE}: Target actor could not be resolved.`);
    return;
  }

  const ledger = ledgerData();
  const attack = ledger.attacks[flags.nativeAttackMessageId];
  if (attack && (!attackMatches(attack, flags) || attack.sourceMessageId !== message.id)) {
    throw new Error("Injury card no longer matches the recorded attack.");
  }
  const key = `effect:${flags.nativeAttackMessageId ?? message.id}:${kind}`;
  if (ledger.applications[key]?.state === "applied") {
    await markSourceActionApplied(message, `apply-effect:${kind}`);
    return;
  }
  if (ledger.applications[key] || UNCERTAIN_APPLICATIONS.has(key)) {
    throw new Error("Injury outcome needs GM reconciliation; it was not retried.");
  }
  const effectData = {
    name: effect.name,
    img: kind === "critical" ? "icons/svg/skull.svg" : kind === "bloodied" ? "icons/svg/blood.svg" : "icons/svg/daze.svg",
    description: `<p>${esc(effect.description)}</p><p><em>Applied by ${MODULE_TITLE}.</em></p>`,
    disabled: false,
    transfer: false,
    changes: [],
    flags: { [MODULE_ID]: { location: flags.location, kind, sourceMessage: message.uuid } }
  };
  if (effect.temporary) effectData.duration = { rounds: 1 };

  ledger.applications[key] = { state: "pending", messageId: message.id, kind, at: Date.now(), gmId: game.user.id };
  UNCERTAIN_APPLICATIONS.add(key);
  try { await saveLedger(ledger); }
  catch (err) { UNCERTAIN_APPLICATIONS.delete(key); throw err; }
  if (!isCoordinator()) return;
  await actor.createEmbeddedDocuments("ActiveEffect", [effectData]);
  ledger.applications[key].state = "applied";
  await saveLedger(ledger);
  UNCERTAIN_APPLICATIONS.delete(key);
  await markSourceActionApplied(message, `apply-effect:${kind}`);
  ui.notifications.info(`${MODULE_TITLE}: Applied ${effect.name} to ${actor.name}.`);
}

function tagCapturedBaseDamageMessage(document, data) {
  if (!PENDING_BASE_DAMAGE_CAPTURES.length) return;

  const source = data ?? document?._source ?? {};
  const type = source.type ?? document?.type;
  // D&D5e v5.3.x commonly uses a generic ChatMessage type and identifies the
  // roll as dnd5e.messageType=roll with dnd5e.roll.type=damage.
  const nativeRoll = source.flags?.dnd5e ?? document?.flags?.dnd5e ?? {};
  if (type !== "damage" && nativeRoll.roll?.type !== "damage") return;

  const speakerActor = source.speaker?.actor ?? document?.speaker?.actor ?? null;
  const now = Date.now();
  const native = source.flags?.dnd5e ?? document?.flags?.dnd5e;
  const captureIndex = PENDING_BASE_DAMAGE_CAPTURES.findIndex(c =>
    (now - c.startedAt) < 120000 && c.authorId === game.user.id
    && (!native?.item?.uuid || native.item.uuid === c.itemUuid)
    && (!native?.activity?.id || native.activity.id === c.activityId)
    && ((speakerActor && speakerActor === c.actorId) || native?.item?.uuid === c.itemUuid)
  );
  if (captureIndex < 0) return;

  const capture = PENDING_BASE_DAMAGE_CAPTURES[captureIndex];
  const patch = {
    [`flags.${MODULE_ID}.kind`]: "base-damage",
    [`flags.${MODULE_ID}.captureId`]: capture.id,
    [`flags.${MODULE_ID}.sourceMessageId`]: capture.sourceMessageId
  };

  // updateSource is the canonical way to mutate a document during preCreate.
  if (typeof document?.updateSource === "function") document.updateSource(patch);
  else {
    source.flags ??= {};
    source.flags[MODULE_ID] = { ...(source.flags[MODULE_ID] ?? {}), kind: "base-damage",
      captureId: capture.id, sourceMessageId: capture.sourceMessageId };
  }
}

function stripNativeDamageApplicationControls(message, root) {
  const flags = message.flags?.[MODULE_ID];
  if (flags?.kind !== "base-damage") return;

  // Keep the native D&D5e damage roll card intact. Only remove controls that
  // can change/apply the base damage. Never hide an ancestor based on its
  // contents; doing that can accidentally remove the entire roll card.
  root.classList.add("tsa-base-damage-message");

  const hide = el => {
    if (!el) return;
    el.style.setProperty("display", "none", "important");
    el.setAttribute("aria-hidden", "true");
  };

  // Stable selectors exposed by various D&D5e 5.3.x render paths.
  root.querySelectorAll([
    "[data-action='applyDamage']",
    "[data-action='apply-damage']",
    "[data-action*='apply' i][data-multiplier]",
    "[data-action*='damage' i][data-multiplier]",
    "[data-multiplier]"
  ].join(", ")).forEach(hide);

  // The native tray also renders a standalone multiplication glyph at the
  // far left. Once the multiplier buttons are hidden this can otherwise remain
  // as the tiny stray “×” visible below the target portrait.
  const multiplierLabels = new Set(["×", "x", "✕", "-1", "0", "¼", "1/4", "½", "1/2", "1", "2"]);
  const candidates = Array.from(root.querySelectorAll(
    "button, a, [role='button'], label, input[type='button'], input[type='radio'], span"
  ));

  for (const el of candidates) {
    const text = (el.textContent ?? el.value ?? "").trim().replace(/\s+/g, " ");
    const action = (el.dataset?.action ?? "").toLowerCase();
    const isApply = /^apply(?: damage)?$/i.test(text) || action === "applydamage" || action === "apply-damage";
    const isMultiplier = multiplierLabels.has(text);
    if (isApply || isMultiplier) {
      hide(el);
      // Radio/checkbox inputs often have a sibling label containing the visible value.
      if (el.matches?.("input")) {
        const id = el.id;
        if (id) root.querySelectorAll(`label[for="${CSS.escape(id)}"]`).forEach(hide);
        if (el.nextElementSibling?.tagName === "LABEL") hide(el.nextElementSibling);
      }
    }
  }

  // Hide exact standalone APPLY labels left behind by D&D5e, but do not hide
  // their parent container since that parent can also own the roll display.
  for (const el of Array.from(root.querySelectorAll("div, span, strong, label"))) {
    const text = (el.textContent ?? "").trim().replace(/\s+/g, " ");
    if (/^apply$/i.test(text) && el.children.length <= 2) hide(el);
  }

  // D&D5e 5.3.x can leave the multiplier tray's close/multiply glyph as a
  // bare text node rather than a button/span. Remove only leaf wrappers whose
  // entire visible content is the stray ×/x glyph, preserving the target row.
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (el.children.length) continue;
    const text = (el.textContent ?? "").trim();
    if (/^[×✕x]$/i.test(text)) hide(el);
  }

  // Final fallback for a naked text node. This is intentionally scoped to the
  // tagged base-damage card and only removes a node whose whole value is ×/x.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const removeNodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (/^[\s]*[×✕x][\s]*$/i.test(node.nodeValue ?? "")) removeNodes.push(node);
  }
  for (const node of removeNodes) node.remove();
}

function watchNativeDamageApplicationControls(message, root) {
  if (message.flags?.[MODULE_ID]?.kind !== "base-damage") return;
  if (root.dataset.tsaDamageWatcher === "1") return;
  root.dataset.tsaDamageWatcher = "1";

  // D&D5e can append the multiplier strip after renderChatMessage has already
  // fired. Re-run the cleanup whenever children are added for a short period.
  const observer = new MutationObserver(() => stripNativeDamageApplicationControls(message, root));
  observer.observe(root, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 4000);
}

function installChatListeners(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;

  // During a targeted damage roll the native D&D5e card may render before its
  // custom flag is persisted. Treat a matching damage message as base damage
  // immediately so the Apply tray never flashes or remains visible.
  const pendingCapture = PENDING_BASE_DAMAGE_CAPTURES.find(c => isLikelyNativeDamageMessage(message, c));
  if (pendingCapture && message.flags?.[MODULE_ID]?.kind !== "base-damage") {
    root.classList.add("tsa-base-damage-message");
    const faux = { flags: { [MODULE_ID]: { kind: "base-damage" } } };
    stripNativeDamageApplicationControls(faux, root);
    watchNativeDamageApplicationControls(faux, root);
  } else {
    stripNativeDamageApplicationControls(message, root);
    watchNativeDamageApplicationControls(message, root);
  }

  if (!message.flags?.[MODULE_ID]) return;

  // Persist completed actions on the targeted-attack card. A completed button
  // remains visible as a combat log entry, but is greyed out and cannot be used again.
  const appliedActions = message.flags?.[MODULE_ID]?.appliedActions ?? {};
  root.querySelectorAll('[data-tsa-action="roll-damage"], [data-tsa-action="apply-effect"]').forEach(button => {
    const action = button.dataset.tsaAction;
    const actionKey = action === "apply-effect" ? `apply-effect:${button.dataset.kind}` : action;
    if (!appliedActions[actionKey]?.applied) return;
    button.disabled = true;
    button.classList.add("tsa-applied-action");
    if (!/\(APPLIED\)\s*$/i.test(button.textContent ?? "")) {
      button.append(document.createTextNode(" (APPLIED)"));
    }
    button.setAttribute("aria-disabled", "true");
    button.title = "This action has already been applied.";
  });

  // Modified damage remains in chat after application. The Apply control is
  // GM-only: players can roll their own targeted damage, but only the GM sees
  // the button which changes the target actor's HP. This avoids presenting a
  // control on player clients that they cannot directly execute.
  if (message.flags?.[MODULE_ID]?.kind === "modified-damage") {
    if (message.flags[MODULE_ID].applicationState !== "pending" || message.flags[MODULE_ID].applied || !game.user.isGM) {
      root.querySelectorAll('[data-tsa-action="review-damage"]').forEach(button => button.remove());
    }
    if (!game.user.isGM) {
      root.querySelectorAll('[data-tsa-action="apply-damage"]').forEach(button => button.remove());
      if (message.flags[MODULE_ID].applied) {
        const controls = root.querySelector(".tsa-modified-application");
        if (controls && !controls.querySelector(".tsa-application-status")) {
          const status = document.createElement("span");
          status.className = "tsa-application-status";
          status.textContent = "APPLIED";
          controls.append(status);
        }
      }
    } else if (message.flags?.[MODULE_ID]?.applied) {
      root.querySelectorAll('[data-tsa-action="apply-damage"]').forEach(button => {
        button.disabled = true;
        button.classList.add("tsa-applied");
        button.innerHTML = '<i class="fa-solid fa-check"></i> APPLIED';
        button.setAttribute("aria-disabled", "true");
        button.title = "This modified damage has already been applied.";
      });
    } else if (message.flags[MODULE_ID].applicationState === "pending") {
      root.querySelectorAll('[data-tsa-action="apply-damage"]').forEach(button => {
        button.disabled = true;
        button.textContent = "PENDING — REVIEW IF INTERRUPTED";
        button.title = "Check target HP before reconciling an interrupted application.";
      });
      const controls = root.querySelector(".tsa-modified-application");
      if (controls && !controls.querySelector('[data-tsa-action="review-damage"]')) {
        const review = document.createElement("button");
        review.type = "button";
        review.dataset.tsaAction = "review-damage";
        review.textContent = "Review interrupted application";
        controls.append(review);
      }
    }
  }

  root.querySelectorAll("[data-tsa-action]").forEach(button => {
    // Both Foundry's generic chat hook and D&D5e's chat hook may fire for the
    // same DOM node. Mark bound controls so we never attach duplicate handlers.
    if (button.dataset.tsaBound === "true") return;
    button.dataset.tsaBound = "true";
    button.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      const action = button.dataset.tsaAction;
      if (action === "roll-damage") return rollSpecialDamage(message);
      if (action === "apply-effect") return applyEffect(message, button.dataset.kind);
      if (action === "apply-damage") return applyModifiedDamage(message, Number(button.dataset.multiplier));
      if (action === "review-damage") return reviewDamage(message);
    });
  });
  if (!game.user.isGM) {
    root.querySelectorAll('[data-tsa-action="apply-effect"]').forEach(b => b.disabled = true);
  }
}

function addSheetButton(app, html) {
  const actor = app.actor ?? app.document;
  if (!(actor instanceof Actor) || !["character", "npc"].includes(actor.type)) return;
  if (!actor.isOwner && !game.user.isGM) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector(".tsa-sheet-button")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "tsa-sheet-button";
  button.innerHTML = '<i class="fa-solid fa-crosshairs"></i> Targeted Attack';
  button.addEventListener("click", ev => { ev.preventDefault(); requestTargetedAttack(actor); });

  const candidates = [
    root.querySelector(".window-header .window-title"),
    root.querySelector("header.sheet-header"),
    root.querySelector(".sheet-header")
  ].filter(Boolean);
  const anchor = candidates[0];
  if (anchor) anchor.insertAdjacentElement("afterend", button);
}


// ---------------------------------------------------------------------------
// Optional Argon Combat HUD integration (Argon DND5E 5.2.2 / Foundry v14)
// ---------------------------------------------------------------------------
function argonIsActive() {
  return Boolean(game.modules.get("enhancedcombathud")?.active
    && game.modules.get("enhancedcombathud-dnd5e")?.active);
}

function looksLikeArgonElement(el) {
  if (!(el instanceof Element)) return false;
  // Never treat this module's own Argon button/fallback as an Argon HUD root.
  // v0.2.12 could recursively rediscover its own injected controls.
  if (el.matches?.(".tsa-argon-button-wrap, .tsa-argon-button") || el.closest?.(".tsa-argon-button-wrap")) return false;
  const id = String(el.id ?? "").toLowerCase();
  const cls = String(el.className ?? "").toLowerCase();
  const dataApp = String(el.dataset?.applicationPart ?? "").toLowerCase();
  const haystack = `${id} ${cls} ${dataApp}`;
  return haystack.includes("enhancedcombathud")
    || haystack.includes("argon")
    || haystack.includes("combat-hud")
    || haystack.includes("combat hud")
    || /(^|\s)ech([\s_-]|$)/.test(haystack)
    || haystack.includes("ech-");
}

function findArgonRoots(scope = document) {
  const roots = new Set();
  const selectors = [
    "#enhancedcombathud",
    ".enhancedcombathud",
    "[id*='enhancedcombathud' i]",
    "[class*='enhancedcombathud' i]",
    "[id*='argon' i]",
    "[class*='argon' i]",
    "[id*='combat-hud' i]",
    "[class*='combat-hud' i]",
    "[class*='ech-' i]",
    "[id*='ech-' i]"
  ];

  if (scope instanceof Element && looksLikeArgonElement(scope)) roots.add(scope);
  for (const sel of selectors) {
    try { scope.querySelectorAll?.(sel).forEach(el => roots.add(el)); } catch (_) {}
  }

  // AppV2 can put identifying classes on an ancestor rather than the rendered part.
  for (const el of Array.from(roots)) {
    const app = el.closest?.(".application, [data-appid], [data-application-part]");
    if (app && looksLikeArgonElement(app)) roots.add(app);
  }
  return Array.from(roots).filter(el =>
    el.isConnected !== false
    && !el.matches?.(".tsa-argon-button-wrap, .tsa-argon-button")
    && !el.closest?.(".tsa-argon-button-wrap")
  );
}

function argonActorFromHud() {
  const controlled = canvas?.tokens?.controlled ?? [];
  if (controlled.length === 1) return controlled[0].actor;
  return game.user.character ?? null;
}

function makeArgonButton({ floating = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = `tsa-argon-button-wrap${floating ? " tsa-argon-floating" : ""}`;
  wrap.dataset.tooltip = "V's Targeted Attacks";
  wrap.dataset.tsaArgon = "1";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "tsa-argon-button";
  button.innerHTML = '<i class="fa-solid fa-crosshairs"></i><span>Targeted Attack</span>';
  button.title = "Targeted Attack";
  button.addEventListener("click", ev => {
    ev.preventDefault();
    ev.stopPropagation();
    requestTargetedAttack(argonActorFromHud());
  });
  wrap.append(button);
  return wrap;
}

function choosePrimaryArgonRoot(roots) {
  const usable = roots.filter(el => el instanceof HTMLElement && el.isConnected);
  if (!usable.length) return null;

  // Argon puts many of the same identifying classes on its action cells. In
  // v0.2.13 that caused us to inject a button into every action. Select only
  // one HUD-level root: prefer an outer candidate, then the largest visible
  // candidate as a fallback.
  const outer = usable.filter(el => !usable.some(other => other !== el && other.contains(el)));
  const pool = outer.length ? outer : usable;
  return pool.sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return (br.width * br.height) - (ar.width * ar.height);
  })[0] ?? null;
}

function findArgonDrawerHeader(root) {
  if (!(root instanceof HTMLElement)) return null;

  // Argon labels the drawer at the top-left of the HUD as
  // "SAVES / SKILLS / TOOLS".  Anchor to that visible label rather than to
  // generic action-panel classes, which can also appear in the chat/dice UI.
  const normalize = value => String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

  const wanted = "SAVES / SKILLS / TOOLS";
  const candidates = [root, ...root.querySelectorAll("div, span, header, section, button")];
  let label = candidates.find(el => normalize(el.textContent) === wanted);
  if (!label) {
    label = candidates.find(el => normalize(el.textContent).includes(wanted));
  }
  if (!(label instanceof HTMLElement)) return null;

  // Prefer the narrow header bar containing the label, not the whole portrait
  // panel.  Walk upward only while the parent remains header-sized.
  let header = label;
  for (let i = 0; i < 4; i++) {
    const parent = header.parentElement;
    if (!(parent instanceof HTMLElement) || !root.contains(parent)) break;
    const rect = parent.getBoundingClientRect();
    if (rect.height > 46 || rect.width > 500) break;
    header = parent;
  }
  return header;
}

function positionArgonDrawerButton(wrap, header) {
  if (!(wrap instanceof HTMLElement) || !(header instanceof HTMLElement)) return false;
  const rect = header.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;

  // v0.2.17: place the button above Argon's equipment-slot row, aligned
  // with the left edge of the portrait/drawer. The SAVES / SKILLS / TOOLS
  // header is a stable anchor; Argon's equipment row sits immediately above
  // it, so a fixed vertical offset puts the control neatly above those boxes
  // without modifying Argon's own grid/flex layout.
  const buttonHeight = 28;
  const equipmentRowHeight = 44;
  // v0.2.19: move the Argon button another 6px upward for clearance.
  // v0.2.20: moved another 6px upward.
  const extraClearance = 24;
  const gap = 6;
  wrap.style.left = `${Math.round(rect.left)}px`;
  wrap.style.top = `${Math.max(4, Math.round(rect.top - equipmentRowHeight - buttonHeight - gap - extraClearance))}px`;
  wrap.style.height = `${buttonHeight}px`;
  wrap.style.width = `150px`;
  return true;
}

function addArgonTargetedAttackButton(root) {
  if (!(root instanceof HTMLElement) || !root.isConnected) return false;

  const header = findArgonDrawerHeader(root);
  if (!(header instanceof HTMLElement)) return false;

  let wrap = document.querySelector(".tsa-argon-drawer-button");
  if (!wrap) {
    // Remove buttons from older builds/fallback positions before adding the
    // single drawer-adjacent button requested for v0.2.15.
    document.querySelectorAll(".tsa-argon-button-wrap").forEach(el => el.remove());
    wrap = makeArgonButton();
    wrap.classList.add("tsa-argon-drawer-button");
    document.body.append(wrap);
  }
  return positionArgonDrawerButton(wrap, header);
}

function removeArgonFallback() {
  document.querySelectorAll(".tsa-argon-floating").forEach(el => el.remove());
}

function ensureArgonFallback() {
  // Deliberately do not inject into generic HUD/chat containers anymore.  If
  // the drawer header is not present yet, the next Argon render/control-token
  // hook will try again.  This prevents the button from appearing in the dice
  // roll text box or on top of action cells.
  removeArgonFallback();
}

function refreshArgonIntegration(scope = document) {
  if (!argonIsActive()) return;

  const roots = findArgonRoots(document);
  const primary = choosePrimaryArgonRoot(roots);
  const placed = primary ? addArgonTargetedAttackButton(primary) : false;

  if (!placed) {
    document.querySelectorAll(".tsa-argon-drawer-button").forEach(el => el.remove());
    ensureArgonFallback();
  }
}

let ARGON_REFRESH_TIMER = null;

function scheduleArgonRefresh(delay = 100) {
  if (!argonIsActive()) return;
  if (ARGON_REFRESH_TIMER) clearTimeout(ARGON_REFRESH_TIMER);
  ARGON_REFRESH_TIMER = setTimeout(() => {
    ARGON_REFRESH_TIMER = null;
    try {
      refreshArgonIntegration(document);
    } catch (err) {
      console.warn(`${MODULE_TITLE} | Argon refresh failed safely.`, err);
    }
  }, delay);
}

function startArgonIntegration() {
  if (!argonIsActive()) return;

  // IMPORTANT: Do not observe the entire document with MutationObserver here.
  // Argon rebuilds large portions of its HUD when a token is selected. A global
  // observer which also injects DOM can trigger itself repeatedly and freeze the
  // Foundry client. v0.2.13 only refreshes from Foundry lifecycle/token hooks.
  scheduleArgonRefresh(300);

  Hooks.on("controlToken", () => scheduleArgonRefresh(150));
  Hooks.on("canvasReady", () => scheduleArgonRefresh(300));
  Hooks.on("updateToken", () => scheduleArgonRefresh(150));
  window.addEventListener("resize", () => scheduleArgonRefresh(75), { passive: true });
}

async function handleModuleSocket(payload) {
  // Module sockets carry no authenticated sender. They may only nudge a fully
  // validated automatic workflow; legacy/manual socket approval is rejected.
  if (payload?.type !== "auto-apply-modified-damage" || typeof payload.messageId !== "string") return;
  if (!isCoordinator() || payload.gmId !== game.user.id) return;
  if (!game.settings.get(MODULE_ID, AUTO_APPLY_PLAYER_DAMAGE_SETTING)) return;
  if (payload.applicationMultiplier !== undefined && payload.applicationMultiplier !== 1) return;

  // A newly-created chat message normally reaches all clients before this socket
  // event. Retry briefly anyway so auto-apply is resilient on slower connections.
  let message = game.messages.get(payload.messageId);
  for (let attempt = 0; !message && attempt < 8; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 75));
    message = game.messages.get(payload.messageId);
  }
  if (!message) return;

  const flags = message.flags?.[MODULE_ID];
  if (flags?.kind !== "modified-damage" || flags.applied) return;

  return queueCoordinator(() => applyFinalDamage(message));
}

Hooks.once("init", () => {
  console.log(`${MODULE_TITLE} | Initializing v${MODULE_VERSION}`);
  game.settings.register(MODULE_ID, AUTO_APPLY_PLAYER_DAMAGE_SETTING, {
    name: "Automatically Apply Damage",
    hint: "Enabled by default. When enabled, damage rolled through V's Targeted Attacks is applied automatically: GM rolls apply immediately and player rolls are silently applied by a connected GM client. Disable this setting to use manual GM Apply buttons instead.",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, LEDGER_SETTING, {
    scope: "world", config: false, type: Object, default: { attacks: {}, applications: {} }
  });
  game.settings.register(MODULE_ID, COORDINATOR_SETTING, {
    scope: "world", config: false, type: String, default: ""
  });
  game.settings.register(MODULE_ID, MANUAL_REQUEST_SETTING, {
    scope: "world", config: false, type: Object, default: {}, onChange: handleGMAction
  });
});

Hooks.once("ready", () => {
  if (game.system.id !== "dnd5e") {
    ui.notifications.error(`${MODULE_TITLE} requires the D&D5e system.`);
    return;
  }
  const api = { open: requestTargetedAttack, openDirect: openTargetedAttack, rules: RULES,
    takeOverDamage, reconcileDamage: requestReconciliation, damageStatus };
  const mod = game.modules.get(MODULE_ID);
  if (mod) mod.api = api;
  globalThis.TargetedSpecialAttacks = api;
  game.socket.on(`module.${MODULE_ID}`, handleModuleSocket);
  console.log(`${MODULE_TITLE} | Ready v${MODULE_VERSION}. Macro API: TargetedSpecialAttacks.open()`);
  startArgonIntegration();
});

Hooks.on("preCreateChatMessage", tagCapturedBaseDamageMessage);
Hooks.on("createChatMessage", (message, _options, userId) => {
  if (!isCoordinator()) return;
  const kind = message.flags?.[MODULE_ID]?.kind;
  if (!["native-attack", "attack-result", "base-damage", "multiplier", "modified-damage"].includes(kind)) return;
  // Freeze event data before waiting for other ledger writes. Later document
  // updates must not change the evidence this GM actually observed at creation.
  const observed = { id: message.id, flags: foundry.utils.deepClone(message.flags),
    rolls: Array.from(message.rolls ?? [], r => ({ total: r.total, formula: r.formula,
      isCritical: r.isCritical, options: { type: r.options?.type,
        types: Array.from(r.options?.types ?? []), properties: Array.from(r.options?.properties ?? []) },
      terms: Array.from(r.terms ?? [], t => ({ faces: t.faces,
        results: t.results ? Array.from(t.results, result => ({ ...result })) : [] })) })) };
  // userId is supplied by Foundry's completed document operation, not a module
  // socket or the editable message author field. Capture it at creation only.
  if (kind === "native-attack") return queueCoordinator(() => recordNativeAttack(observed, userId));
  if (kind === "attack-result") return queueCoordinator(() => bindSourceMessage(observed, userId));
  if (["base-damage", "multiplier"].includes(kind)) return queueCoordinator(() => recordDamageEvidence(observed, userId));
  if (kind === "modified-damage") return queueCoordinator(() => recordFinalCard(observed, userId));
});
Hooks.on("renderActorSheet", addSheetButton);
Hooks.on("renderActorSheetV2", addSheetButton);
Hooks.on("renderChatMessageHTML", installChatListeners);
Hooks.on("dnd5e.renderChatMessage", installChatListeners);

Hooks.on("renderApplicationV2", () => {
  // Argon can render many nested ApplicationV2 parts. Debounce a single global
  // scan rather than trying to inject into each rendered part.
  scheduleArgonRefresh(100);
});


