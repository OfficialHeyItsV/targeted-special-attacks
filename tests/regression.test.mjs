import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ID, source, world } from "./harness.mjs";
import { validateParts, validMultiplier } from "../scripts/damage-validation.mjs";

test("manifest, import paths, socket and synchronized 0.2.28 versions", () => {
  const manifest=JSON.parse(fs.readFileSync(new URL("../module.json",import.meta.url)));
  assert.equal(manifest.id,ID); assert.equal(manifest.socket,true); assert.equal(manifest.version,"0.2.28");
  assert.equal(source.match(/MODULE_VERSION = "([^"]+)"/)[1],manifest.version);
  for(const path of [...manifest.esmodules,...manifest.styles,"scripts/damage-validation.mjs"])
    assert.ok(fs.existsSync(new URL(`../${path}`,import.meta.url)));
});

test("all baseline rules and standard default are preserved", () => {
  const w=world(),gm=w.client("gm");
  assert.deepEqual(JSON.parse(gm.run("JSON.stringify(Object.values(RULES).map(r=>[r.attack,r.damage]))")),
    [[0,null],[-6,"1d3+1"],[-4,"1d2+1"],[-3,"1d2"],[-3,"0"],[-1,null],[-3,"1d3"],[-2,"1d2"]]);
  assert.match(source,/key === "standard" \? "checked"/);
});

for(const location of ["standard","eyes","head","arm","object","torso","groin","leg"])
for(const critical of [false,true]) {
  test(`${location}, critical=${critical}: native typed damage and single automatic application`,async()=>{
    const w=world(),gm=w.client("gm"),p=w.client("player");
    const result=await w.attack(p,location,critical),card=await w.roll(p,result);
    assert.ok(card); assert.equal(card.flags[ID].applied,true);
    assert.equal(w.applied.length,location==="object"?0:1);
    if(location!=="object") {
      assert.equal(p.activity.lastDamage.config.isCritical,critical);
      assert.equal(w.applied[0].parts[0].type,"slashing");
      assert.equal(w.applied[0].parts[0].properties.has("mgc"),true);
      assert.equal(w.applied[0].options.multiplier,1);
      assert.equal(card.flags[ID].finalTotal,(critical?12:6)*card.flags[ID].multiplier);
    }
    gm.ctx.card=card;
    await Promise.all([gm.run("handleModuleSocket({type:'auto-apply-modified-damage',gmId:'gm',messageId:card.id})"),
      gm.run("handleModuleSocket({type:'auto-apply-modified-damage',gmId:'gm',messageId:card.id})")]);
    await w.flush(); assert.equal(w.applied.length,location==="object"?0:1);
    assert.equal(w.notifications.filter(n=>n.level==="info").length,0);
  });
}

for(const user of ["gm","player"]) for(const auto of [true,false]) for(const location of ["standard","object"]) {
  test(`auto/manual matrix: ${user}, auto=${auto}, ${location}`,async()=>{
    const w=world({auto}),gm=w.client("gm"),c=user==="gm"?gm:w.client(user);
    const result=await w.attack(c,location),card=await w.roll(c,result);
    assert.equal(Boolean(card.flags[ID].applied),auto);
    if(!auto){gm.ctx.card=card;await gm.run("applyModifiedDamage(card,1)");await w.flush();}
    assert.equal(card.flags[ID].applied,true);
    assert.equal(w.applied.length,location==="object"?0:1);
  });
}

test("native penalty and discarded d20 handling",async()=>{
  const w=world(),gm=w.client("gm");gm.ctx.activity=gm.activity;
  await gm.run("rollNativeAttack(activity,-6,'Eyes')");
  assert.equal(gm.activity.lastAttack.config.rolls[0].parts[0],"-6");
  assert.equal(gm.run("naturalD20({terms:[{faces:20,results:[{result:1,discarded:true},{result:20}]}]})"),20);
});

test("multiple GMs route manual approval to one coordinator; duplicate finals share application key",async()=>{
  const w=world({auto:false}),gm=w.client("gm"),gm2=w.client("gm2"),p=w.client("player");
  const result=await w.attack(p),card=await w.roll(p,result);
  const duplicate=await p.createMessage({flags:structuredClone(card.flags)});
  gm.ctx.card=card;gm2.ctx.card=duplicate;
  await Promise.all([gm.run("applyModifiedDamage(card,1)"),gm2.run("applyModifiedDamage(card,1)")]);
  await w.flush();assert.equal(w.applied.length,1);
  assert.equal(card.flags[ID].applied,true);assert.equal(duplicate.flags[ID].applied,true);
});

test("players cannot manually apply even owned targets or author-only source messages",async()=>{
  const w=world({auto:false});w.client("gm");const p=w.client("player");
  const result=await w.attack(p),card=await w.roll(p,result);w.target.isOwner=true;
  p.ctx.card=card;await p.run("applyModifiedDamage(card,1)");await w.flush();assert.equal(w.applied.length,0);
  const outsider=w.client("outsider");w.attacker.isOwner=false;
  const other=await outsider.createMessage({flags:{[ID]:{...result.flags[ID],appliedActions:{}}}});
  outsider.ctx.message=other;await outsider.run("rollSpecialDamage(message)");
  assert.equal([...w.messages].filter(m=>m.flags[ID]?.kind==="modified-damage").length,1);
  await assert.rejects(p.ctx.game.settings.set(ID,"manualApplicationRequest",{action:"damage",messageId:card.id}),/denied/);
});

test("disabled automatic setting, legacy socket, arbitrary multiplier and wrong GM are rejected",async()=>{
  const w=world({auto:false}),gm=w.client("gm"),gm2=w.client("gm2"),p=w.client("player");
  const card=await w.roll(p,await w.attack(p));gm.ctx.card=card;gm2.ctx.card=card;
  await gm.run("handleModuleSocket({type:'auto-apply-modified-damage',gmId:'gm',messageId:card.id,requesterId:'gm'})");
  w.settings.set("autoApplyPlayerDamage",true);
  await gm.run("handleModuleSocket({type:'apply-modified-damage',gmId:'gm',messageId:card.id,requesterId:'gm'})");
  await gm.run("handleModuleSocket({type:'auto-apply-modified-damage',gmId:'gm',messageId:card.id,applicationMultiplier:5})");
  await gm2.run("handleModuleSocket({type:'auto-apply-modified-damage',gmId:'gm2',messageId:card.id})");
  await w.flush();assert.equal(w.applied.length,0);
});

for(const mutation of ["target","amount","native roll edit","source link","token mismatch","multiplier"]) {
  test(`rejects altered evidence: ${mutation}`,async()=>{
    const w=world({auto:false}),gm=w.client("gm"),p=w.client("player");
    const result=await w.attack(p,"eyes"),card=await w.roll(p,result),f=card.flags[ID];
    if(mutation==="target") f.targetActorUuid="Actor.unrelated";
    if(mutation==="amount") {f.damageParts[0].value=999;f.finalTotal=999;}
    if(mutation==="native roll edit") {w.messages.get(f.nativeDamageMessageId).rolls[0].total=100;f.damageParts[0].base=100;f.damageParts[0].value=400;f.finalTotal=400;}
    if(mutation==="source link") f.sourceMessageId="missing";
    if(mutation==="token mismatch") w.token.actor={uuid:"Actor.other"};
    if(mutation==="multiplier") f.multiplier=99;
    w.settings.set("autoApplyPlayerDamage",true);gm.ctx.card=card;
    await gm.run("handleModuleSocket({type:'auto-apply-modified-damage',gmId:'gm',messageId:card.id,requesterId:'player'})");
    await w.flush();assert.equal(w.applied.length,0);
  });
}

test("NaN, infinity, malformed arrays and fractional/out-of-range multipliers rejected",()=>{
  for(const number of [NaN,Infinity,-Infinity]) assert.throws(()=>validateParts([{base:1,value:number,types:[],properties:[]}],number));
  assert.throws(()=>validateParts([{base:1,value:1,types:[],properties:"mgc"}],1));
  for(const number of [0,1.5,4,Infinity]) assert.equal(validMultiplier({damage:"1d3"},number),false);
});

test("HP success then chat failure does not repeat damage",async()=>{
  const w=world({auto:false}),gm=w.client("gm"),p=w.client("player");
  const card=await w.roll(p,await w.attack(p));const update=card.update;
  card.update=async patch=>{if(patch[`flags.${ID}.applied`])throw Error("Chat write lost");return update(patch);};
  gm.ctx.card=card;await gm.run("applyModifiedDamage(card,1)");await w.flush();assert.equal(w.applied.length,1);
  card.update=update;await gm.run("applyModifiedDamage(card,1)");await w.flush();assert.equal(w.applied.length,1);
  assert.equal(card.flags[ID].applied,true);
});

test("HP success then ledger failure persists pending and blocks retries and takeover",async()=>{
  const w=world({auto:false}),gm=w.client("gm"),gm2=w.client("gm2"),p=w.client("player");
  const card=await w.roll(p,await w.attack(p));
  gm.failSetting=(key,value)=>key==="damageLedger"&&Object.values(value.applications).some(r=>r.state==="applied");
  gm.ctx.card=card;await gm.run("applyModifiedDamage(card,1)");await w.flush();assert.equal(w.applied.length,1);
  gm.failSetting=null;await gm.run("applyModifiedDamage(card,1)");await w.flush();assert.equal(w.applied.length,1);
  w.users.get("gm").active=false;await gm2.run("takeOverDamage()");gm2.ctx.card=card;
  await gm2.run("applyModifiedDamage(card,1)");await w.flush();assert.equal(w.applied.length,1);
  await gm2.run("requestReconciliation(card.id,'applied')");await w.flush();assert.equal(card.flags[ID].applied,true);
});

test("failure before HP leaves pending; explicit not-applied reconciliation allows one retry",async()=>{
  const w=world({auto:false}),gm=w.client("gm"),p=w.client("player");
  const card=await w.roll(p,await w.attack(p));const update=card.update;
  card.update=async()=>{throw Error("Pre-HP flag failure");};gm.ctx.card=card;
  await gm.run("applyModifiedDamage(card,1)");await w.flush();assert.equal(w.applied.length,0);
  card.update=update;await gm.run("requestReconciliation(card.id,'not-applied')");await w.flush();
  await gm.run("applyModifiedDamage(card,1)");await w.flush();assert.equal(w.applied.length,1);
});

test("repeated effect clicks across GMs create one effect",async()=>{
  const w=world(),gm=w.client("gm"),gm2=w.client("gm2"),p=w.client("player");
  const result=await w.attack(p,"arm");gm.ctx.message=result;gm2.ctx.message=result;
  await Promise.all([gm.run("applyEffect(message,'hit')"),gm2.run("applyEffect(message,'hit')")]);await w.flush();
  assert.equal(w.effects.length,1);assert.equal(result.flags[ID].appliedActions["apply-effect:hit"].applied,true);
});

test("completed source action and existing final cards block rerolls",async()=>{
  const w=world(),gm=w.client("gm"),p=w.client("player");const result=await w.attack(p);
  await w.roll(p,result);await w.roll(p,result);assert.equal(w.applied.length,1);
  assert.equal([...w.messages].filter(m=>m.flags[ID]?.kind==="modified-damage").length,1);
});

test("no GM leaves card unapplied; legacy manual review is explicit",async()=>{
  const w=world(),p=w.client("player");w.users.get("gm").active=false;w.users.get("gm2").active=false;
  const result=await w.attack(p,"object"),card=await w.roll(p,result);assert.equal(Boolean(card.flags[ID].applied),false);
  w.users.get("gm").active=true;const gm=w.client("gm");gm.ctx.card=card;gm.confirm=false;
  await gm.run("applyModifiedDamage(card,1)");await w.flush();assert.equal(Boolean(card.flags[ID].applied),false);
  gm.confirm=true;await gm.run("applyModifiedDamage(card,1)");await w.flush();assert.equal(card.flags[ID].applied,true);
});

test("hooks register once per client and player chat removes manual application controls",()=>{
  const w=world(),p=w.client("player");for(const [name,handlers] of p.hooks) assert.equal(handlers.length,1,name);
  // Static constraint on unchanged DOM integration; a live DOM test is still needed.
  assert.match(source,/if \(!game.user.isGM\) \{\s*root.querySelectorAll\('\[data-tsa-action="apply-damage"\]'\).forEach\(button => button.remove\(\)\)/);
  assert.equal((source.match(/new MutationObserver/g)??[]).length,1);
});

test("socket requesterId and edited author cannot impersonate a document creator",async()=>{
  const w=world({auto:false}),gm=w.client("gm"),p=w.client("player"),outsider=w.client("outsider");
  const card=await w.roll(p,await w.attack(p));
  const forged=await outsider.createMessage({flags:structuredClone(card.flags)});forged.author=w.users.get("gm");
  await w.flush();w.settings.set("autoApplyPlayerDamage",true);gm.ctx.card=forged;
  await gm.run("handleModuleSocket({type:'auto-apply-modified-damage',gmId:'gm',requesterId:'player',messageId:card.id})");
  await w.flush();assert.equal(w.applied.length,0);
});

test("source author mismatch still allows its owning player to roll",async()=>{
  const w=world(),gm=w.client("gm"),p=w.client("player");
  const result=await w.attack(p);result.author=w.users.get("gm");result.isAuthor=false;
  const card=await w.roll(p,result);assert.equal(card.flags[ID].applied,true);
  assert.equal(result.flags[ID].appliedActions["roll-damage"].applied,true);
});

test("persisted application survives a fresh client VM",async()=>{
  const w=world({auto:false}),gm=w.client("gm"),p=w.client("player");const card=await w.roll(p,await w.attack(p));
  gm.ctx.card=card;await gm.run("applyModifiedDamage(card,1)");await w.flush();
  w.disconnect(gm);card.flags[ID].applied=false;const reloaded=w.client("gm");reloaded.ctx.card=card;
  await reloaded.run("applyModifiedDamage(card,1)");await w.flush();assert.equal(w.applied.length,1);
  assert.equal(card.flags[ID].applied,true);
});

test("initial ledger-write failure cannot change HP and does not leave a memory-only lock",async()=>{
  const w=world({auto:false}),gm=w.client("gm"),p=w.client("player");const card=await w.roll(p,await w.attack(p));
  gm.failSetting=(key,value)=>key==="damageLedger"&&Object.keys(value.applications).length>0;
  gm.ctx.card=card;await gm.run("applyModifiedDamage(card,1)");await w.flush();assert.equal(w.applied.length,0);
  gm.failSetting=null;await gm.run("applyModifiedDamage(card,1)");await w.flush();assert.equal(w.applied.length,1);
});

test("auto setting disabled during pre-HP update cancels application",async()=>{
  const w=world({auto:false}),gm=w.client("gm"),p=w.client("player");const card=await w.roll(p,await w.attack(p));
  const update=card.update;card.update=async patch=>{await update(patch);if(patch[`flags.${ID}.applicationState`]==="pending")w.settings.set("autoApplyPlayerDamage",false);};
  w.settings.set("autoApplyPlayerDamage",true);gm.ctx.card=card;
  await gm.run("handleModuleSocket({type:'auto-apply-modified-damage',gmId:'gm',messageId:card.id})");await w.flush();
  assert.equal(w.applied.length,0);assert.equal(card.flags[ID].applicationState,"reviewed");
});

test("repeated concurrent source roll entry produces one final",async()=>{
  const w=world(),gm=w.client("gm"),p=w.client("player");p.ctx.message=await w.attack(p);
  await p.run("Promise.all([rollSpecialDamage(message),rollSpecialDamage(message)])");await w.flush();
  assert.equal([...w.messages].filter(m=>m.flags[ID]?.kind==="modified-damage").length,1);assert.equal(w.applied.length,1);
});

test("native capture does not match another item, creator or capture",async()=>{
  const w=world(),gm=w.client("gm");
  gm.ctx.capture={id:"capture",authorId:"player",itemUuid:"Item.a",activityId:"a",actorId:"actor"};
  gm.ctx.native={type:"damage",author:w.users.get("player"),speaker:{actor:"actor"},flags:{dnd5e:{item:{uuid:"Item.b"}}}};
  assert.equal(gm.run("isLikelyNativeDamageMessage(native,capture)"),false);
  gm.ctx.native.flags={};gm.ctx.native.author=w.users.get("outsider");assert.equal(gm.run("isLikelyNativeDamageMessage(native,capture)"),false);
  gm.ctx.native.author=w.users.get("player");gm.ctx.native.flags={[ID]:{captureId:"other"}};assert.equal(gm.run("isLikelyNativeDamageMessage(native,capture)"),false);
});

test("D&D5e generic ChatMessage with dnd5e damage metadata is captured", async()=>{
  const w=world(),gm=w.client("gm");
  gm.ctx.capture={id:"capture",authorId:"player",itemUuid:gm.item.uuid,activityId:gm.activity.id,actorId:"source",sourceMessageId:"source"};
  gm.ctx.native={type:"other",author:w.users.get("player"),speaker:{actor:"source"},flags:{dnd5e:{messageType:"roll",roll:{type:"damage"},item:{uuid:gm.item.uuid},activity:{id:gm.activity.id}}}};
  assert.equal(gm.run("isLikelyNativeDamageMessage(native,capture)"),true);
});

test("native damage cancellation releases roll lock without posting a final",async()=>{
  const w=world(),gm=w.client("gm"),p=w.client("player");const result=await w.attack(p);
  p.activity.rollDamage=async()=>null;await w.roll(p,result);
  assert.equal(p.run("ACTIVE_DAMAGE_ROLLS.size"),0);
  assert.equal([...w.messages].filter(m=>m.flags[ID]?.kind==="modified-damage").length,0);
});

test("native damage exception after posting does not launch a fallback roll",async()=>{
  const w=world(),gm=w.client("gm"),p=w.client("player");const result=await w.attack(p);
  const native=p.activity.rollDamage;let calls=0;
  p.activity.rollDamage=async(...args)=>{calls++;await native(...args);throw Error("failure after posting");};
  await w.roll(p,result);assert.equal(calls,1);assert.equal(w.applied.length,0);
});

