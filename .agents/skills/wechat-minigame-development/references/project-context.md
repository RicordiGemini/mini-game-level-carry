# 项目接手地图

以下是 2026-10-18 创建 Agent 时通过文件检查得到的导航信息，不是永久状态。每次接手以最新代码、配置和实际执行结果为准。

## 技术基线

- 工程目标：Cocos Creator 3.8 + TypeScript，武器收集 Roguelite 微信小游戏。
- 根目录 `package.json` 目前为测试与类型检查工具配置，含 TypeScript 开发依赖；它本身不能证明是完整 Cocos 工程。
- `tsconfig.json` 通过 `types/cc-stub.d.ts` 提供 `cc` 类型桩；`tools/build-tests.mjs` 编译逻辑并提供测试运行桩。
- 本次检查发现 `tests/` 和测试构建工具实际存在；旧文档有“没有测试”的滞后描述，不能照抄。此检查未运行玩法测试，不声明当前测试通过或断言总数。
- 初始目录未发现 `.scene`、`.prefab`、资源 `.meta`、Cocos `settings/`、微信构建产物 `game.json` 或 `project.config.json`。需要开发可运行工程时先重新检查，再补齐真实引擎工程与资源绑定。

## 从哪里追代码

| 任务 | 入口与边界 |
|---|---|
| 启动与系统接线 | `assets/scripts/GameEntry.ts`；检查 `@property` 对应节点和组件是否实际绑定 |
| 对局流程与结算 | `assets/scripts/core/LevelFlow.ts`；顺着开局、击杀、升级、胜败回调定位 |
| 战斗与攻击 | `battle/BattleWorld.ts`、`BattleTypes.ts`、`AimResolver.ts`、`AttackFactory.ts` |
| 装备与形态 | `core/EquipmentManager.ts`、`ForgeManager.ts`、`FormGraph.ts`、`RunLoadout.ts` |
| 数值和内容配置 | `assets/scripts/data/`；具体添加步骤先查 `docs/10-开发指南.md` |
| UI 与输入 | `assets/scripts/ui/`；渲染和拖动输入与纯战斗逻辑保持分离 |
| 存档与迁移 | `core/SaveManager.ts`、`core/HashUtil.ts`、`data/GameTypes.ts` |
| 广告 | `assets/scripts/ad/AdReward.ts`；检查广告标签的真实调用方、配置与运行环境 |
| 教学与成就 | `core/TutorialManager.ts`、`AchievementManager.ts` 与对应配置/UI |
| 回归与平衡 | `tests/*.test.mjs`、`tests/run.mjs`、`tools/calibrate.mjs` |

表中未写完整路径的条目均相对 `assets/scripts/`。

## 已观察到的交付边界

- `AdReward.ts` 初始配置的广告位 ID 为占位符，含编辑器模拟路径；真实微信调用是否成功须使用有效广告位验证。不要把已有封装视为广告验收通过。
- `GameEntry.ts` 声明多个 Cocos 组件/节点绑定，脚本存在不等于场景已接好。
- `docs/12-缺口与风险.md` 包含已关闭、留档和开放事项，处理前逐项回查代码；不能按旧优先级无差别重做。
- 美术音频、完整引擎工程、平台配置、性能与真机证据需要在具体开发任务中核验；本次 Agent 配置任务不实施这些游戏功能。

## 可用检查

```sh
npm run typecheck
npm test
npm run calibrate
```

先确认依赖与当前脚本内容。第三项仅在战斗输出/数值平衡相关任务中按需运行。测试桩不能验证 Cocos 序列化、节点绑定、资源加载、微信 API 或真机性能。

## 维护约定

现有行为由代码证明；新需求可以改变旧行为。改动后更新对应模块说明；待实现和发布阻塞统一写入 `docs/12-缺口与风险.md`。历史归档只用于解释设计背景。
