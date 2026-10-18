import assert from 'node:assert/strict';
import { emptyLoadout, createRunLoadout, applyReward, migrateWeaponUpgrades } from '../.test-build/core/RunLoadout.js';
import { readyEvolutions, isReadyToEvolve, weaponUpgradeCount } from '../.test-build/core/FormGraph.js';
import { pickRewards } from '../.test-build/core/RewardPicker.js';
import { getLevelConfig, buildLoadout } from '../.test-build/data/LevelConfig.js';
import { WEAPON_EVOLUTION_AUX } from '../.test-build/data/RunConfig.js';
import { ALL_FORMS, getForm } from '../.test-build/data/FormConfig.js';
import { EquipmentManager } from '../.test-build/core/EquipmentManager.js';
import { LevelFlow } from '../.test-build/core/LevelFlow.js';
import { SaveManager } from '../.test-build/core/SaveManager.js';
import { sys } from '../.test-build/cc-stub.mjs';
const caps = { weaponCap: 6, auxCap: 6 };
const lo = createRunLoadout(['blade']);
const st = lo.weapons[0]; st.exp = 99999;
const ctx = level => ({loadout:lo,allowAdvanced:false,weaponCap:6,auxCap:6,level,ownedEquipIds:[],seenForms:[],rng:()=>.4});
const evolve = {kind:'weapon_evolve',formId:'blade_edge',slotIndex:0};
assert.equal(isReadyToEvolve(st,lo),false,'击杀经验不能代替强化');
assert.ok(pickRewards(ctx(2)).some(o=>o.kind==='weapon_upgrade'));
assert.ok(pickRewards(ctx(2)).some(o=>o.kind==='aux_new' && o.formId==='aux_blood'),'武器轮提供配套辅助');
const damage = () => EquipmentManager.buildWeapons(lo,{}, {atkPct:0,atkSpeedPct:0,critRate:0,critMul:2,lifesteal:0,rangePct:0,extraShots:0,maxHpFlat:0,shield:0,thorns:0,moveSpeedPct:0,expPct:0,pierceResist:0,highHpDmg:0,chainBonus:0})[0].damage;
let before = damage();
for(let i=0;i<5;i++) {
  if (i === 4) {
    lo.auxes.push({id:'aux_blood',formId:'aux_blood',kind:'aux',stage:0,exp:0});
    assert.equal(applyReward(lo,evolve,caps).ok,false,'四次强化即使有配套辅助也不能进化');
    lo.auxes.pop();
  }
  assert.equal(applyReward(lo,evolve,caps).ok,false);
  assert.equal(applyReward(lo,{kind:'weapon_upgrade',slotIndex:0,formId:'blade'},caps).ok,true);
  assert.ok(damage()>before,'每次强化实际增伤'); before=damage();
}
assert.equal(weaponUpgradeCount(st),5);
assert.equal(applyReward(lo,{kind:'weapon_upgrade',slotIndex:0,formId:'blade'},caps).ok,false);
assert.equal(applyReward(lo,evolve,caps).ok,false,'五次强化但缺配套辅助不得进化');
lo.auxes.push({id:'aux_scope',formId:'aux_scope',kind:'aux',stage:0,exp:0});
assert.equal(applyReward(lo,evolve,caps).ok,false,'错误辅助不能解锁');
lo.auxes.push({id:'aux_blood',formId:'aux_blood_deep',kind:'aux',stage:1,exp:0});
assert.ok(readyEvolutions(lo,false).some(m=>m.edge.to==='blade_edge'),'辅助进阶分支也能配对');
assert.equal(applyReward(lo,{...evolve,formId:'blade_genesis'},caps).ok,false,'不能跳级或伪造路线');
assert.equal(applyReward(lo,evolve,caps).ok,true);
assert.ok(damage()>=before,'进化保留已强化攻击收益');
assert.equal(st.upgrades,0);
assert.equal(lo.auxes.length,2,'进化不消耗辅助');
assert.equal(readyEvolutions(lo,false).filter(m=>m.kind==='weapon').length,0,'进化后重新强化');

// 旧面板转换保留奖励机会与形态；新版存档保留当前候选。
const old=emptyLoadout(); delete old.weaponUpgradeVersion;
old.weapons=[{...st,upgrades:undefined}];old.pending=[evolve];old.pendingLevelUps=[2];
migrateWeaponUpgrades(old);assert.equal(old.weapons[0].upgrades,0);assert.deepEqual(old.pendingLevelUps,[2]);assert.deepEqual(old.pending,[]);
old.pending=[{kind:'weapon_upgrade',formId:'blade_edge',slotIndex:0}];
migrateWeaponUpgrades(old);assert.equal(old.pending.length,1);

// 强化进度经真实单局保存、重启及通关继承保留。
sys.__storage.clear(); SaveManager.profileCache=null;
const f=new LevelFlow();f._phase='PLAYING';
f._state={levelId:1,difficulty:1,runId:'weapon-test',resources:{},stats:{hp:100},loadout:lo,replay:{enabled:false,percent:0},score:0,elapsed:0,kills:1,cleared:false,carried:false,carrySource:'none',updatedAt:0};
st.upgrades=4; SaveManager.saveLevel(f.current);
const resumed=new LevelFlow(); resumed.boot();assert.equal(resumed.current.loadout.weapons[0].upgrades,4);
const archived=buildLoadout(f.current);
const inherited=createRunLoadout(['blade'],archived.equipment);
assert.equal(inherited.weapons[0].upgrades,4);assert.equal(inherited.weapons[0].evolvedUpgradeAtkPct,.75);
delete f.current.loadout.weaponUpgradeVersion;
f.current.loadout.pending=[evolve]; f.current.loadout.pendingLevelUps=[2];
SaveManager.saveLevel(f.current);
const oldResume = new LevelFlow(); oldResume.boot();
assert.equal(oldResume.phase,'REWARD');
assert.deepEqual(oldResume.current.loadout.pendingLevelUps,[2]);
assert.ok(oldResume.getPendingRewards().some(o=>o.kind==='weapon_upgrade'),'旧进化面板转换成符合当前规则的奖励');
for(const form of ALL_FORMS.filter(f=>f.kind==='weapon'&&f.evolveTo.some(e=>e.type==='upgrade'))) {
  for(const root of form.sources) assert.equal(getForm(WEAPON_EVOLUTION_AUX[root])?.kind,'aux',root+' 必须有有效辅助配对');
}
console.log('✅ 武器五次强化、辅助配对、进化防绕过、实际增伤与存档继承通过');
