# 13 · Cocos 工程与验证记录

> 本文记录 Cocos Creator 工程化补齐、编辑器验证和构建状态。功能规则仍以各模块文档和当前 TypeScript 代码为准；本文不把编辑器预览或模拟环境结果写成微信真机结果。

## 1. 本轮范围

本轮将原有 TypeScript 玩法接入可打开的 Cocos Creator 3.8.8 工程，补齐启动场景、UI 面板、预制体、资源 `.meta`、编辑器设置、TypeScript 工程配置和 Web/微信构建入口。

已完成的代码兼容调整包括：

- `GameEntry` 初始化放入 `start()`，避免依赖尚未完成的组件绑定。
- 使用 Cocos 3.8.8 支持的 `Tween.stopAllByTarget()` 替代旧的节点动作 API。
- 使用 `Label.enableWrapText` 替代旧的 `enableWrap` 属性。
- 动态新手引导节点统一设置 `Layers.Enum.UI_2D`。
- 增加 `PanelSurface`，让面板背景在编辑器和运行时都有稳定的绘制组件。
- `GameEntry` 已实现装备、图鉴、成就、锻造和许愿面板的互斥关闭；`Main.scene` 已保存 `gachaPanel` 引用，主菜单许愿按钮绑定 `GachaPanel.openFromMenu`。

## 2. 工程与资源

开发环境：

- Cocos Creator：`E:\cocos\editors\Creator\3.8.8`
- 工程类型：2D
- 设计分辨率：`720 × 1280`
- 屏幕适配：按高度适配（`fitWidth: false`、`fitHeight: true`），避免浏览器窗口较矮或放大后结算按钮被底部裁剪
- 局内成长显示：战斗 HUD 显示 `Lv.等级`、`经验 当前/门槛` 和进度条；只有击杀确认后获得经验并达到门槛才打开三选一
- 详情页关闭：装备、图鉴、成就、锻造、许愿和难度页均保留关闭事件，关闭按钮统一放在面板右上方，避免编辑器预览窗口底部不可见
- 当前启动场景：`db://assets/scenes/Main.scene`
- 启动场景 UUID：`81a705b0-80df-409b-863d-fa293db4570c`

已生成并由 Cocos 编辑器保存的资源：

| 资源 | UUID |
|---|---|
| `assets/scenes/Main.scene` | `81a705b0-80df-409b-863d-fa293db4570c` |
| `assets/prefabs/LevelButton.prefab` | `cc63b318-1d86-4d1d-9be9-fd2f7c9399bc` |
| `assets/prefabs/DifficultyItem.prefab` | `176ab7f9-7e3a-4397-93ad-b662e6d4d875` |
| `assets/prefabs/EquipmentItem.prefab` | `0686bf80-e743-4378-b699-048f2caf0a62` |

工程设置和构建配置位于：

- `settings/v2/packages/engine.json`
- `settings/v2/packages/project.json`
- `settings/v2/packages/preview.json`
- `tsconfig.json`：真实 Cocos 类型检查入口
- `tsconfig.logic.json`：独立逻辑层类型检查入口
- `configs/build/web-mobile.json`
- `configs/build/wechatgame.json`

资源身份检查：

```text
资源 64 项，已有 .meta 64 项，新建 0 项，缺失 0 项。
```

日常检查命令：

```sh
npm run assets:check
npm run test:assets
npm run typecheck
npm run typecheck:cocos
```

## 3. 编辑器扩展与场景维护

`extensions/game-project-tools/` 提供场景和预制体生成、检查及保存入口。它会：

1. 生成 `Main.scene` 和三个 UI 预制体。
2. 给代码绘制的面板补充 `PanelSurface`。
3. 保存已有 UUID，避免重新生成导致引用失效。
4. 修正主菜单许愿按钮为 `GameEntry.openGachaPanel`。
5. 给 `GameEntry.gachaPanel` 写入 `Canvas/GachaPanel` 引用。

修改扩展后，应在 Cocos Creator 中重新加载扩展，再执行场景脚本的 `complete` 方法并保存场景。若编辑器已长时间运行，先重启编辑器使 TypeScript 组件元数据重新加载。

### 3.1 `msg not exist` 排查

如果日志出现以下调用栈：

```text
msg not exist!
...extension/cocos-service/service/pages/index.js...pluginMsg
```

这是 Cocos Creator 3.8.8 内置 `cocos-service` 面板的消息路由错误，不是游戏脚本、场景资源或 TypeScript 编译错误。当前工程的 `game-project-tools` 扩展消息声明符合 Cocos 3.8 扩展模板，且不会调用 `cocos-service.pluginMsg`。

处理顺序：

1. 关闭右侧 `Service/Cocos Service` 面板，切回 `Inspector` 或 `Hierarchy`。
2. 不要在未登录或服务插件未安装时点击 Service 面板中的服务卡片；小游戏本地开发不依赖该面板。
3. 若错误仍持续，退出所有 Cocos Creator 窗口后只启动一个工程实例，再打开 `Main.scene`。
4. 只有在点击“项目工具 → 补齐启动场景与预制体”时才报错，才需要重新加载 `extensions/game-project-tools`；该菜单应只发送 `generate` 消息。

该错误不影响本工程的 Web/微信小游戏构建。确认方式是查看 `temp/logs/project.log` 的最新时间：关闭 Service 面板后不再新增同一栈，即可继续进行场景预览和构建验证。

### 3.2 新增脚本提示模块不存在

2026-10-18 曾出现 `Module "./ui/DefeatPanel" not found`。当时源文件和 `.meta` 已存在，但 `temp/programming/packer-driver/targets/` 下的编辑器与预览模块解析结果仍缓存着文件创建前的错误。

本次激活编辑器并更新 `DefeatPanel.ts`、`GameEntry.ts` 的文件修改时间，触发资源扫描和脚本重编译后，两个目标的 `resolution-detail-map.json` 均恢复为空，导入映射已包含 `DefeatPanel.ts`。无需给 TypeScript 导入路径添加 `.ts` 扩展名，也无需清档。

随后使用当前 Cocos 预览服务进行独立浏览器验证：启动并进入第 1 关、触发战败、等待 2.6 秒仍显示战败选择面板，再点击“返回关卡选择”成功返回；页面与控制台脚本错误均为零。该结果为浏览器预览验证，未进行微信工具或真机验证。若原预览标签页仍显示旧错误，重新加载该标签页即可；资源未更新时先在编辑器刷新资源再预览。

## 4. 已执行验证

本次文档与提交整理的检查范围为 `npm test`（11 个套件）、`npm run typecheck`、`npm run typecheck:cocos`、`npm run assets:check`、`npm run calibrate` 和差异格式检查。类型桩测试、引擎类型检查、历史浏览器验证与真机验收分别记录，不将历史断言总数当作当前覆盖率。

### 4.1 当前定时波次版本（2026-10-18）

武器五次强化＋配套辅助进化版本：全量逻辑测试、两类类型检查与 64/64 资源检查通过。新增覆盖四次强化不可进化、五次缺辅助/错误辅助不可进化、辅助进阶分支、合法路线、每次实际增伤、进化保留强化收益、旧待选卡转换和单局/通关继承；首关集中培养模拟确认三波内可完成进化。当前未验证这套规则的编辑器界面或真机操作。calibrate 执行成功，既有模型偏差仍为中位约 50%、最大约 296%。

每局 3 × 30 秒持续投放版本已通过逻辑/Cocos 类型检查、64/64 资源身份检查。逻辑测试覆盖 90 秒持续投放、同屏上限、波内统一攻防、清场、受击保护、存档/复活/重试。按最新降速经验（角色 2/装备 3），初始铁剑使用真实武器伤害、逐级选卡和移动逻辑模拟，约 11.8 秒首次升级、90 秒通关、1440 次击杀、14 次选卡；此前 33 次选卡为降速前记录。这是 Node 战斗模拟样本，不是浏览器或真机手感结果。

最新浏览器预览尚未通过：当前 Cocos 预览缓存混用新 EncounterConfig 与旧 LevelConfig/BattleWorld；缓存仍为基础生命 55、攻击 6，且没有最新受击保护，与当前源码生命 12、攻击 1 不一致。激活编辑器、更新文件修改时间未能使全部模块重新导入；未强制关闭编辑器以免丢失未保存场景。需保存场景后重新打开工程、等待资源导入并重新预览，再验证三波与选卡。240 只同屏性能及微信工具/真机尚未验证。数值校准已执行，但既有武器模型偏差仍需后续处理。

### 4.2 之前版本的历史验证

以下结果对应此前固定数量版本及已有工程接入，不能作为当前定时波次版本的预览、构建或真机验收依据。

2026-10-18 首关节奏复测（Cocos 3.8.8 浏览器预览，独立浏览器存档）：普通第 1 关实际配置 24 只、每批 4 只、间隔 6 秒；第 2 次击杀在战斗计时约 11.3 秒打开首张三选一，包含阔刃剑与淬锋剑两条进化选择，当时剩余 22 只。实战共完成 6 次选卡，武器由铁剑进化为阔刃剑、环刃剑，约 38.7 秒清理全部 24 只并进入结算；页面及控制台脚本错误为零。该时长是本次固定站位与选卡的预览样本，不包含选卡暂停，不代表真机统计。测试、两类类型检查和 64/64 资源身份检查通过；数值校准已运行，仍存在原有武器模型与战斗实测偏差。微信工具、真机和后段关卡手感尚未复测。

| 验证项 | 状态 | 结果 |
|---|---|---|
| 逻辑类型检查 | ✅ | `npm run typecheck` 通过 |
| Cocos 类型检查 | ✅ | `npm run typecheck:cocos` 通过 |
| Node 逻辑测试 | ✅ | `npm test` 通过，形态、品阶、属性、存档、教学、平衡套件均通过 |
| `.meta` 检查 | ✅ | `npm run assets:check` 通过，62/62 |
| Cocos 编辑器打开 | ✅ | 已用 Cocos Creator 3.8.8 打开工程和启动场景 |
| 浏览器预览 | ✅ | 已验证启动、教学、自动进入第 1 关、战斗和拖动移动；按高度适配修改后需重新加载 `Main.scene` 再复测结算页按钮 |
| 三选一选择后阶段同步 | ✅（代码修复，待编辑器回归） | 每帧先同步 `LevelFlow.phase` 与界面显隐；普通奖励选择后关闭三选一并恢复战斗，合成奖励继续显示补选，补选完成后恢复战斗 |
| Web 构建 | ✅ | 已生成 `build/web-mobile/`；适配设置修改后需在 Cocos 中重新构建才能带入产物 |
| 微信小游戏构建 | ✅ | 已生成 `build/wechatgame/`；适配设置修改后需在 Cocos 中重新构建才能带入产物 |
| 许愿面板互斥场景回归 | ✅ | `Main.scene` 已保存 `gachaPanel` 引用和许愿入口事件 |
| 微信开发者工具导入 | ⏳ | 尚未执行 |
| 真机运行 | ⏳ | 尚未执行 |
| 正式 AppID、广告位和云环境 | ⏳ | 尚未配置 |

## 5. 构建和发布边界

`configs/build/wechatgame.json` 中的 `appid` 保持为空，不能填入示例值。正式构建前需要填写用户自己的微信小游戏 AppID，并在微信开发者工具中重新导入验证。

构建成功只证明 Cocos 导出产物生成；它不代表微信开发者工具兼容、真机性能、广告回调、隐私合规、提审或正式发布已经完成。AppSecret、私钥和服务端密钥不得写入客户端工程或版本库。

下一步验收顺序：

1. 在 Cocos 编辑器中确认 `GameEntry` 的全部节点引用，重点检查 `gachaPanel`。
2. 预览主菜单五个工具面板，确认打开一个面板会关闭其他面板。
3. 用真实 AppID 导入微信开发者工具，检查启动场景、包体和平台 API。
4. 在至少一台目标 Android 和 iOS 设备上验证触摸、存档恢复、战斗帧率和内存。
5. 完成广告、隐私、资质和提审材料后再提交审核。

## 6. 运行查看当前效果

### 6.1 Cocos 编辑器预览（最快）

1. 启动 `E:\cocos\editors\Creator\3.8.8\CocosCreator.exe`。
2. 打开项目目录 `E:/project/mini-game-level-carry`。
3. 在 Assets 中展开 `scenes`，双击 `Main.scene`。不要运行自动生成的空场景 `scene-2d`。
4. 点击顶部预览目标，选择 `Preview in Browser`，再点击播放/预览按钮。
5. 浏览器打开后即可操作当前效果：新手引导、关卡选择、战斗拖动、装备、图鉴、成就、锻造和许愿入口。

如果打开的是空场景或旧界面，先关闭并重新打开 `Main.scene`；修改脚本或工程适配设置后需要等待 Cocos 完成 TypeScript 编译，再重新预览。浏览器缩放建议恢复到 100%；若窗口高度不足，按高度适配会缩小画面以保持结算页的 `再次挑战`、`返回关卡` 按钮可见。预览时不要打开右侧 `Service/Cocos Service` 面板，该面板与游戏运行无关。

### 6.2 查看 Web 构建产物

在 Cocos 的构建面板选择 Web Desktop/Web Mobile，输出目录使用 `build/web-mobile/`，点击构建后再运行预览。不要直接双击 `build/web-mobile/index.html`，优先使用 Cocos 预览或本地静态服务器，以免浏览器阻止脚本和资源加载。

### 6.3 查看微信小游戏效果

1. 在 Cocos 构建面板选择微信小游戏，输出目录使用 `build/wechatgame/`。
2. 如果只是检查导出文件，可保持 AppID 为空进行本地构建。
3. 使用真实 AppID 时，将 `build/wechatgame/` 导入微信开发者工具。
4. 在微信开发者工具中点击编译/预览；真机扫码验证触摸、存档和性能。

当前工程没有配置正式 AppID，因此 Cocos 浏览器预览是查看玩法效果的首选方式；微信开发者工具和真机结果需要单独记录，不能用浏览器预览代替。
