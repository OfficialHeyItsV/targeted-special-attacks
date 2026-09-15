import fs from "node:fs";
import vm from "node:vm";
import * as validation from "../scripts/damage-validation.mjs";

export const ID = "targeted-special-attacks";
export const source = fs.readFileSync(new URL("../scripts/special-attacks.js", import.meta.url), "utf8");
const runnable = source.replace(/^import .*?;\s*/u, "");
const clone = value => structuredClone(value);
function setPath(object, path, value) {
  const keys = path.split(".");
  let cursor = object;
  for (const key of keys.slice(0, -1)) cursor = cursor[key] ??= {};
  cursor[keys.at(-1)] = clone(value);
}
class Collection extends Map { [Symbol.iterator]() { return this.values(); } }

// Shared server state and multiple independent client VMs. No real networking,
// rendering, Foundry authorization service, or D&D5e defense calculation is simulated.
export function world({ auto = true } = {}) {
  let sequence = 0;
  const clients = [], messages = new Collection(), settings = new Map(), registrations = new Map();
  const applied = [], effects = [], notifications = [], socketEvents = [];
  const users = [
    {id:"gm", isGM:true, active:true}, {id:"gm2",isGM:true,active:true},
    {id:"player",isGM:false,active:true}, {id:"outsider",isGM:false,active:true}
  ];
  users.get = id => users.find(u => u.id === id);
  const attacker = {id:"source",uuid:"Actor.source",isOwner:true,
    testUserPermission: user => user.isGM || user.id === "player"};
  const target = {uuid:"Scene.scene.Token.target.Actor.target",isOwner:false,
    system:{attributes:{hp:{value:100,max:100,temp:0},ac:{value:10}}},
    applyDamage: async (parts, options) => {
      applied.push({parts,options});
      target.system.attributes.hp.value -= parts.reduce((sum,p) => sum+p.value,0);
    }, createEmbeddedDocuments: async (_type, data) => { effects.push(...data); return data; }};
  const token = {uuid:"Scene.scene.Token.target",actor:target};
  const docs = new Map([[attacker.uuid,attacker],[target.uuid,target],[token.uuid,token]]);
  function emitHook(name, ...args) {
    for (const client of clients) for (const fn of client.hooks.get(name) ?? []) fn(...args);
  }
  async function flush() {
    // Hooks queue work synchronously but do not await promises in Foundry.
    for (let i=0;i<4;i++) await Promise.all(clients.map(c => c.run("COORDINATOR_QUEUE")));
  }
  function disconnect(client) { const index=clients.indexOf(client); if(index>=0)clients.splice(index,1); }
  function client(userId) {
    const user = users.get(userId), hooks = new Map();
    const item = {id:"weapon",uuid:"Actor.source.Item.weapon",name:"Sword",actor:attacker,system:{activities:new Map()}};
    const warnings = [];
    const run = code => vm.runInContext(code, ctx);
    const createMessage = async data => {
      const m = {
        id:`message${++sequence}`,uuid:`ChatMessage.message${sequence}`,author:user,
        flags:clone(data.flags ?? {}),type:data.type ?? "base",timestamp:Date.now(),
        rolls:data.rolls ?? [],speaker:data.speaker ?? {},content:data.content ?? "",
        isAuthor:true,
        update: async patch => { for(const [p,v] of Object.entries(patch)) setPath(m,p,v); }
      };
      messages.set(m.id,m); emitHook("createChatMessage",m,{},user.id); return m;
    };
    const activity = {id:"activity",type:"attack",item,criticalThreshold:20,
      rollAttack: async (config, dialog, message) => {
        activity.lastAttack = {config,dialog,message};
        const roll = {total:20,formula:"1d20 + 5",isCritical:false,terms:[{faces:20,results:[{result:15}]}]};
        await createMessage({ ...message.data, rolls:[roll], flags:{...message.data.flags,dnd5e:{roll:{type:"attack"},item:{uuid:item.uuid},activity:{id:activity.id}}} });
        return [roll];
      },
      rollDamage: async (config, dialog, message) => {
        activity.lastDamage = {config,dialog,message};
        const rolls = [{total:config.isCritical ? 12 : 6,options:{type:"slashing",properties:new Set(["mgc"]),types:new Set()},formula:config.isCritical ? "2d6" : "1d6"}];
        await createMessage({ ...message.data, type:"damage",rolls,speaker:{actor:"source"},
          flags:{...message.data.flags,dnd5e:{roll:{type:"damage"},item:{uuid:item.uuid},activity:{id:activity.id}}} });
        return rolls;
      }
    };
    item.system.activities.set(activity.id,activity);
    const api = {hooks,run,createMessage,activity,item,warnings};
    const ctx = vm.createContext({ ...validation, console:{log(){},debug(){},warn(){},error(){}}, setTimeout, clearTimeout,
      game: {user,users,messages,system:{id:"dnd5e"},modules:new Map(),
        settings:{
          register: (_id,key,definition) => { registrations.set(`${userId}:${key}`,definition); if(!settings.has(key)) settings.set(key,clone(definition.default)); },
          get: (_id,key) => clone(settings.get(key)),
          set: async (_id,key,value) => {
            if (!user.isGM) throw Error("Server denied world setting write");
            if (api.failSetting?.(key,value)) throw Error("Injected setting persistence failure");
            settings.set(key,clone(value));
            for (const c of clients) registrations.get(`${c.user.id}:${key}`)?.onChange?.(clone(value));
            return clone(value);
          }
        },socket:{emit:(channel,payload) => {socketEvents.push(payload); for(const c of clients) c.socket?.(payload);},on:(_channel,fn) => {api.socket=fn;}}},
      Hooks:{on:(name,fn) => {const list=hooks.get(name)??[];list.push(fn);hooks.set(name,list);return list.length;},
        once:(name,fn) => {const list=hooks.get(name)??[];list.push(fn);hooks.set(name,list);}, off:() => {}},
      fromUuid:async uuid => uuid===item.uuid ? item : docs.get(uuid) ?? null,
      foundry:{utils:{deepClone:clone,escapeHTML:s=>String(s),randomID:()=>`random${++sequence}`},
        applications:{api:{DialogV2:{confirm:async () => api.confirm ?? true}}}},
      ChatMessage:{create:createMessage,getSpeaker:()=>({actor:"source"})},
      CONFIG:{DND5E:{damageTypes:{slashing:{label:"Slashing"}},healingTypes:{}}},
      ui:{notifications:Object.fromEntries(["info","warn","error"].map(level=>[level,text=>{notifications.push({level,text});warnings.push(text);}]))},
      Roll:class {
        constructor(formula){this.formula=formula;this.total=Number(formula.match(/d(\d+)/)?.[1]??0)+(formula.endsWith("+1")?1:0);}
        async evaluate(){return this;}
        async toMessage(data){return createMessage({...data,rolls:[this]});}
      }
    });
    api.ctx=ctx; api.user=user;
    clients.push(api); vm.runInContext(runnable,ctx);
    for(const fn of hooks.get("init")??[]) fn();
    settings.set("autoApplyPlayerDamage",auto);
    for(const fn of hooks.get("ready")??[]) fn();
    return api;
  }
  async function attack(client, location="standard", critical=false) {
    const f={kind:"native-attack",attackId:`a${++sequence}`,actorUuid:attacker.uuid,itemUuid:client.item.uuid,
      activityId:client.activity.id,location,targetActorUuid:target.uuid,targetTokenUuid:token.uuid};
    const native=await client.createMessage({flags:{[ID]:f,dnd5e:{roll:{type:"attack"},item:{uuid:client.item.uuid},activity:{id:client.activity.id}}},
      rolls:[{total:critical?25:20,formula:"1d20 + 5",isCritical:critical,terms:[{faces:20,results:[{result:critical?20:15}]}]}]});
    await flush();
    const result=await client.createMessage({flags:{[ID]:{...f,kind:"attack-result",nativeAttackMessageId:native.id,
      attackTotal:critical?25:20,critical,detectedHit:true}}});
    await flush(); return result;
  }
  async function roll(client, result) {
    client.ctx.message=result; await client.run("rollSpecialDamage(message)"); await flush();
    return [...messages].find(m=>m.flags[ID]?.kind==="modified-damage"&&m.flags[ID].sourceMessageId===result.id);
  }
  return {client,disconnect,attack,roll,flush,messages,settings,applied,effects,notifications,socketEvents,users,attacker,target,token,docs};
}

