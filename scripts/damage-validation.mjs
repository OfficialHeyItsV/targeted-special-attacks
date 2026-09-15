// Pure validation of persisted roll evidence. Never treat socket data as damage.
export function validateParts(parts, total) {
  if (!Array.isArray(parts) || !Number.isFinite(total)) throw new Error("Invalid damage data.");
  for (const part of parts) {
    if (!Number.isFinite(part.base) || !Number.isFinite(part.value)
      || (part.type != null && typeof part.type !== "string")
      || !Array.isArray(part.properties) || part.properties.some(p => typeof p !== "string")
      || !Array.isArray(part.types) || part.types.some(t => typeof t !== "string")) {
      throw new Error("Invalid typed damage component.");
    }
  }
  if (parts.reduce((sum, p) => sum + p.value, 0) !== total) throw new Error("Damage total does not match its components.");
  return parts;
}

export function sameParts(left, right) {
  const normalize = parts => parts.map(p => ({
    base: p.base, value: p.value, type: p.type ?? null,
    types: [...(p.types ?? [])].sort(), properties: [...(p.properties ?? [])].sort()
  }));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export function validMultiplier(rule, value) {
  if (!Number.isInteger(value)) return false;
  if (!rule.damage) return value === 1;
  if (rule.damage === "0") return value === 0;
  const match = /^1d([23])(?:\+1)?$/.exec(rule.damage);
  if (!match) return false;
  const bonus = rule.damage.endsWith("+1") ? 1 : 0;
  return value >= 1 + bonus && value <= Number(match[1]) + bonus;
}

export function attackMatches(snapshot, flags) {
  return ["actorUuid", "itemUuid", "activityId", "location", "targetActorUuid", "targetTokenUuid"]
    .every(key => typeof snapshot[key] === "string" && snapshot[key] === flags[key]);
}

