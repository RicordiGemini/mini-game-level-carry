'use strict';
const { join } = require('node:path');
module.paths.push(join(Editor.App.path, 'node_modules'));
const cc = require('cc');
const fs = require('node:fs');
const color = (r, g, b, a = 255) => new cc.Color(r, g, b, a);
const background = color(18, 25, 42);
const surface = color(31, 44, 68);
const accent = color(62, 125, 189);

function node(name, parent, width = 640, height = 90, x = 0, y = 0) {
  const result = new cc.Node(name);
  result.layer = cc.Layers.Enum.UI_2D;
  result.addComponent(cc.UITransform).setContentSize(width, height);
  result.setPosition(x, y);
  if (parent) parent.addChild(result);
  return result;
}

function box(target, fill = surface) {
  const size = target.getComponent(cc.UITransform).contentSize;
  const graphics = target.addComponent(cc.Graphics);
  graphics.fillColor = fill;
  graphics.roundRect(-size.width / 2, -size.height / 2, size.width, size.height, 14);
  graphics.fill();
  const surface = component(target, 'PanelSurface');
  surface.fillColor = fill;
  return graphics;
}

function label(name, parent, text = '', width = 600, height = 75, x = 0, y = 0, fontSize = 24) {
  const target = node(name, parent, width, height, x, y);
  const result = target.addComponent(cc.Label);
  result.string = text;
  result.fontSize = fontSize;
  result.lineHeight = fontSize + 7;
  result.color = color(233, 240, 249);
  result.enableWrapText = true;
  result.overflow = cc.Label.Overflow.SHRINK;
  result.verticalAlign = cc.Label.VerticalAlign.CENTER;
  return result;
}

function button(name, parent, text, width = 280, height = 64, x = 0, y = 0) {
  const target = node(name, parent, width, height, x, y);
  box(target, accent);
  target.addComponent(cc.Button).transition = cc.Button.Transition.SCALE;
  label('Label', target, text, width - 16, height - 8, 0, 0, 23);
  return target;
}

function component(target, name) {
  const type = cc.js.getClassByName(name);
  if (!type) throw new Error(`组件未编译完成：${name}`);
  return target.addComponent(type);
}

function scroll(parent, name, width, height, y, spacing = 16) {
  const root = node(name, parent, width, height, 0, y);
  const viewport = node('View', root, width, height);
  viewport.addComponent(cc.Mask).type = cc.Mask.Type.GRAPHICS_RECT;
  const content = node('Content', viewport, width, 1, 0, height / 2);
  content.getComponent(cc.UITransform).setAnchorPoint(0.5, 1);
  const layout = content.addComponent(cc.Layout);
  layout.type = cc.Layout.Type.VERTICAL;
  layout.resizeMode = cc.Layout.ResizeMode.CONTAINER;
  layout.spacingY = spacing;
  const view = root.addComponent(cc.ScrollView);
  view.content = content;
  view.horizontal = false;
  view.vertical = true;
  return content;
}

async function store(url, asset) {
  const json = EditorExtends.serialize(asset);
  const text = typeof json === 'string' ? json : JSON.stringify(json, null, 2);
  await Editor.Message.request('asset-db', 'create-asset', url, text, { overwrite: false });
  const uuid = await Editor.Message.request('asset-db', 'query-uuid', url);
  if (!uuid) throw new Error(`资源导入失败：${url}`);
  return uuid;
}

async function prefab(name, build) {
  const url = `db://assets/prefabs/${name}.prefab`;
  let uuid = await Editor.Message.request('asset-db', 'query-uuid', url);
  if (!uuid) {
    const root = build();
    const asset = new cc.Prefab();
    asset.name = name;
    asset.data = root;
    uuid = await store(url, asset);
    root.destroy();
  }
  return new Promise((resolve, reject) => cc.assetManager.loadAny(uuid, (error, asset) => error ? reject(error) : resolve(asset)));
}

function panel(canvas, name, labels, buttons) {
  const root = node(name, canvas, 720, 1280);
  box(root, background);
  const script = component(root, name);
  const fields = labels.map(([field, text, height = 95]) => ({ field, text, height }));
  const available = 1030 - Math.ceil(buttons.length / 2) * 78;
  const content = scroll(root, 'Details', 660, available, 510 - available / 2);
  for (const field of fields) {
    script[field.field] = label(field.field, content, field.text, 630, field.height, 0, 0, field.field === 'titleLabel' ? 30 : 23);
  }
  buttons.forEach(([field, text], index) => {
    const target = button(field, root, text, 300, 64, index % 2 ? 164 : -164, -510 + Math.floor(index / 2) * 78);
    if (field === 'closeBtn') target.setPosition(250, 560);
    script[field] = target;
  });
  return script;
}

async function generate() {
  const scenePath = join(Editor.Project.path, 'assets/scenes/Main.scene');
  if (fs.existsSync(scenePath)) throw new Error('Main.scene 已存在，为保留手工编辑，本工具不覆盖场景。');
  for (const folder of ['scenes', 'prefabs']) {
    if (!fs.existsSync(join(Editor.Project.path, 'assets', folder))) {
      await Editor.Message.request('asset-db', 'create-asset', `db://assets/${folder}`, null);
    }
  }
  const levelPrefab = await prefab('LevelButton', () => {
    const root = button('LevelButton', null, '', 630, 150);
    label('NumLabel', root, '1', 90, 70, -240, 0, 38);
    label('StateLabel', root, '等待挑战', 430, 105, 65, 0, 24);
    label('LockIcon', root, '锁定', 80, 45, 245, 45, 18);
    return root;
  });
  const difficultyPrefab = await prefab('DifficultyItem', () => {
    const root = button('DifficultyItem', null, '', 630, 255);
    for (const [name, y, height] of [['NameLabel', 90, 42], ['DescLabel', 35, 64], ['RecordLabel', -35, 60], ['RewardLabel', -95, 60]]) {
      label(name, root, '', 595, height, 0, y, 22);
    }
    label('LockIcon', root, '锁定', 70, 35, 265, 100, 18);
    return root;
  });
  const equipmentPrefab = await prefab('EquipmentItem', () => {
    const root = node('EquipmentItem', null, 630, 280);
    box(root);
    label('NameLabel', root, '', 595, 42, 0, 108, 25);
    label('LevelLabel', root, '', 595, 44, 0, 60, 22);
    label('EvolveLabel', root, '', 595, 80, 0, -5, 20);
    const upgrade = button('UpgradeBtn', root, '', 285, 62, -152, -100);
    label('CostLabel', upgrade, '', 270, 56, 0, 0, 19);
    const select = button('SelectBtn', root, '', 285, 62, 152, -100);
    label('StateLabel', select, '', 270, 56, 0, 0, 21);
    return root;
  });
  const scene = new cc.Scene('Main');
  scene.autoReleaseAssets = true;
  const canvas = node('Canvas', scene, 720, 1280, 360, 640);
  const canvasComponent = canvas.addComponent(cc.Canvas);
  const widget = canvas.addComponent(cc.Widget);
  widget.isAlignTop = widget.isAlignBottom = widget.isAlignLeft = widget.isAlignRight = true;
  widget.top = widget.bottom = widget.left = widget.right = 0;
  const cameraNode = new cc.Node('UICamera');
  canvas.addChild(cameraNode);
  cameraNode.setPosition(0, 0, 1000);
  const camera = cameraNode.addComponent(cc.Camera);
  camera.projection = cc.Camera.ProjectionType.ORTHO;
  camera.orthoHeight = 640;
  camera.near = 0;
  camera.far = 2000;
  camera.visibility = cc.Layers.Enum.UI_2D;
  camera.clearFlags = cc.Camera.ClearFlag.SOLID_COLOR;
  camera.clearColor = background;
  canvasComponent.cameraComponent = camera;
  const selectRoot = node('LevelSelectPanel', canvas, 720, 1280);
  box(selectRoot, background);
  label('Title', selectRoot, '武器远征', 640, 90, 0, 540, 44);
  const select = component(selectRoot, 'LevelSelectPanel');
  select.tipLabel = label('TipLabel', selectRoot, '', 630, 130, 0, 435, 23);
  select.content = scroll(selectRoot, 'Levels', 650, 610, 55);
  select.levelButtonPrefab = levelPrefab;
  const difficulty = panel(canvas, 'DifficultyPanel', [['titleLabel', '选择难度'], ['elementLabel', '', 100]], [['closeBtn', '返回关卡']]);
  difficulty.list = scroll(difficulty.node, 'DifficultyList', 650, 810, -100);
  difficulty.itemPrefab = difficultyPrefab;
  const equip = panel(canvas, 'EquipPanel', [['goldLabel', '装备'], ['slotLabel', '', 80]], [['closeBtn', '返回']]);
  equip.list = scroll(equip.node, 'EquipmentList', 650, 800, -110);
  equip.itemPrefab = equipmentPrefab;
  const battleRoot = node('BattleLayer', canvas, 720, 1280);
  const arena = node('Arena', battleRoot, 720, 1280);
  const battle = component(battleRoot, 'BattleLayer');
  battle.gfx = arena.addComponent(cc.Graphics);
  battle.dragInput = component(arena, 'DragInput');
  battle.dragInput.inputArea = arena;
  const hud = label('HudLabel', battleRoot, '', 675, 280, 0, 460, 19);
  hud.verticalAlign = cc.Label.VerticalAlign.TOP;
  const loadout = panel(canvas, 'LoadoutPanel', [
    ['titleLabel', '准备出发'], ['equipLabel', '', 190], ['loadoutLabel', '', 140], ['recordLabel', ''],
    ['carryTipLabel', '', 110], ['freshTipLabel', '', 110],
  ], [['carryBtn', '看视频继承'], ['freshBtn', '重新开始']]);
  const result = panel(canvas, 'ResultPanel', [
    ['titleLabel', '远征结果'], ['scoreLabel', ''], ['timeLabel', ''], ['equipLabel', '', 200],
    ['rewardLabel', ''], ['replayTipLabel', '', 150], ['growthLabel', '', 150], ['achievementLabel', '', 150], ['dropLabel', '', 150],
  ], [['nextTierBtn', '挑战更高难度'], ['nextBtn', '下一关'], ['replayBtn', '再次挑战'], ['selectBtn', '返回关卡'], ['boostBtn', '看视频加速材料']]);
  const reward = panel(canvas, 'RewardPanel', [['titleLabel', '选择成长'], ['slotLabel', ''], ['affinityLabel', '']], []);
  reward.cards = [0, 1, 2].map(index => {
    const card = button(`Card${index}`, reward.node, '', 630, 230, 0, 150 - index * 250);
    [['RarityLabel', 82, 35], ['NameLabel', 42, 45], ['SubTitleLabel', -4, 44], ['DescLabel', -52, 55], ['TagLabel', -95, 32]].forEach(([name, y, height]) => label(name, card, '', 600, height, 0, y, 21));
    return card;
  });
  const replay = panel(canvas, 'ReplayEnhancePanel', [['titleLabel', '再次挑战'], ['subTitleLabel', '', 150], ['previewLabel', '', 200]], [['startBtn', '开始挑战'], ['skipBtn', '按基础难度']]);
  replay.stepButtons = [0, 10, 20, 30].map((value, index) => button(`Boost${index}`, replay.node, `+${value}%`, 135, 70, -222 + index * 148, -190));
  const tree = panel(canvas, 'TreePanel', [['titleLabel', '进化图鉴'], ['bodyLabel', '', 650], ['fusionTitleLabel', '', 75], ['fusionLabel', '', 350]], [['prevBtn', '上一页'], ['nextBtn', '下一页'], ['closeBtn', '返回']]);
  const achievement = panel(canvas, 'AchievementPanel', [['titleLabel', '成就'], ['doneLabel', ''], ['bodyLabel', '', 1300]], [['closeBtn', '返回']]);
  const forge = panel(canvas, 'ForgePanel', [
    ['titleLabel', '锻造'], ['weaponTitleLabel', '', 100], ['weaponBodyLabel', '', 350], ['shardTitleLabel', ''],
    ['shardLabel', '', 200], ['armorTitleLabel', ''], ['armorLabel', '', 900], ['omniLineLabel', '', 200],
  ], [['rankBtn', '突破'], ['upgradeBtn', '升阶'], ['prevBtn', '上一武器'], ['nextBtn', '下一武器'], ['craftBtn', '合成材料'], ['omniBtn', '万能材料'], ['prevElBtn', '上一属性'], ['nextElBtn', '下一属性'], ['omniLineBtn', '万能进阶'], ['closeBtn', '返回']]);
  forge.omniLineRoot = forge.omniLineLabel.node;
  const counterRoot = node('CounterPanel', battleRoot, 660, 200, 0, -480);
  const counter = component(counterRoot, 'CounterPanel');
  counter.levelLabel = label('LevelLabel', counterRoot, '', 650, 60, 0, 65, 18);
  counter.socketLabel = label('SocketLabel', counterRoot, '', 650, 90, 0, 0, 18);
  counter.breakLabel = label('BreakLabel', counterRoot, '', 650, 50, 0, -65, 18);
  const gacha = panel(canvas, 'GachaPanel', [
    ['titleLabel', '许愿'], ['crystalLabel', ''], ['pityLabel', '', 90], ['listLabel', '', 850], ['resultLabel', '', 350],
    ['auxTitleLabel', ''], ['auxLabel', '', 300], ['blessingLabel', ''], ['exchangeTitleLabel', ''], ['exchangeLabel', '', 300],
  ], [['weaponTabBtn', '武器'], ['auxTabBtn', '辅助'], ['armorTabBtn', '防具'], ['singleBtn', '许愿一次'], ['batchBtn', '许愿十次'], ['rankUpBtn', '辅助升阶'], ['adBtn', '视频水晶'], ['sacrificeBtn', '水晶祝福'], ['blessAdBtn', '视频祝福'], ['exchangeBtn', '碎片兑换'], ['nextExchangeBtn', '切换兑换'], ['closeBtn', '返回']]);
  const toast = label('EvolveToast', canvas, '', 640, 220, 0, 110, 30);
  toast.node.active = false;
  const entryNode = node('GameEntry', canvas, 1, 1);
  const entry = component(entryNode, 'GameEntry');
  Object.assign(entry, {
    hudLabel: hud, levelSelectPanel: selectRoot, difficultyPanel: difficulty.node, equipPanel: equip.node,
    battleLayer: battleRoot, battle, evolveToast: toast, loadoutPanel: loadout.node, resultPanel: result.node,
    rewardPanel: reward.node, replayPanel: replay.node, treePanel: tree.node, achievementPanel: achievement.node,
    forgePanel: forge.node, gachaPanel: gacha.node, counterPanel: counterRoot,
  });
  const menu = [
    ['装备', 'openEquipPanel'], ['图鉴', 'openTreePanel'], ['成就', 'openAchievementPanel'],
    ['锻造', 'openForgePanel'], ['许愿', 'openFromMenu'],
  ];
  menu.forEach(([text, method], index) => {
    const target = button(`Menu${index}`, selectRoot, text, 112, 72, -256 + index * 128, -435);
    const event = new cc.EventHandler();
    event.target = entryNode;
    event.component = 'GameEntry';
    event.handler = index === 4 ? 'openGachaPanel' : method;
    target.getComponent(cc.Button).clickEvents.push(event);
  });
  const asset = new cc.SceneAsset();
  asset.name = 'Main';
  asset.scene = scene;
  const uuid = await store('db://assets/scenes/Main.scene', asset);
  scene.destroy();
  return { scene: uuid, prefabs: [levelPrefab.uuid, difficultyPrefab.uuid, equipmentPrefab.uuid] };
}
exports.load = function () {};
exports.unload = function () {};
exports.methods = {
  generate,
  async complete() {
    const scene = cc.director.getScene();
    if (scene?.name !== 'Main') throw new Error('请先打开 Main 场景');
    const decorate = root => {
      for (const graphics of root.getComponentsInChildren(cc.Graphics)) {
        if (graphics.node.name === 'Arena' || graphics.node.getComponent(cc.Mask)) continue;
        if (!graphics.node.getComponent('PanelSurface')) {
          const surface = component(graphics.node, 'PanelSurface');
          surface.fillColor = graphics.fillColor.clone();
        }
      }
    };
    decorate(scene);
    const menu = cc.find('Canvas/LevelSelectPanel/Menu4', scene);
    const event = menu?.getComponent(cc.Button)?.clickEvents?.[0];
    if (event) {
      event.target = cc.find('Canvas/GameEntry', scene);
      event.component = 'GameEntry';
      event.handler = 'openGachaPanel';
    }
    const entry = cc.find('Canvas/GameEntry', scene)?.getComponent('GameEntry');
    if (entry) entry.gachaPanel = cc.find('Canvas/GachaPanel', scene);
    for (const name of ['LevelButton', 'DifficultyItem', 'EquipmentItem']) {
      const asset = await prefab(name);
      decorate(asset.data);
      await Editor.Message.request('asset-db', 'save-asset', `db://assets/prefabs/${name}.prefab`, EditorExtends.serialize(asset));
    }
    const asset = new cc.SceneAsset();
    asset.name = 'Main';
    asset.scene = scene;
    await Editor.Message.request('asset-db', 'save-asset', 'db://assets/scenes/Main.scene', EditorExtends.serialize(asset));
    return '已保留原 UUID，补齐界面绘制组件';
  },
  inspect() {
    return {
      serialize: typeof EditorExtends.serialize,
      classes: ['GameEntry', 'LevelSelectPanel', 'BattleLayer'].map(name => [name, !!cc.js.getClassByName(name)]),
      scene: cc.director.getScene()?.name,
    };
  },
};
