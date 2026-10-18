# 当前项目定时波次接口

用户最新规则：每局至少三波、每波 30 秒、波内攻防一致并持续刷怪。此前固定 24 只与 6 批规则已废止。

读取 EncounterConfig.ts、LevelConfig.ts、RunConfig.ts 与 battle/BattleTypes.ts 核对。EncounterConfig 定义 3 波、每波 30 秒，普通首关每秒 12/16/20 只，同屏上限 240；满屏跳过生成，不积压。波次结束后进入下一波，末波结束后清场通关。无固定击杀门槛。

EnemySpawnSpec.waves 通过 duration、spawnInterval、spawnCount、hpMul、atkMul 接入。波内所有类型攻防一致，无精英护盾；首关生命 12、攻击 1，按关卡/难度/复玩和波次倍率缩放。普通前两关无远程，其他关卡保留远程/快速/冲锋行为。每杀角色经验 2、装备经验 3，统一读取 RunConfig 的 CONTINUOUS_ROLE_EXP/CONTINUOUS_FORM_EXP；普通首关基础估算 14 次升级。

生成器 schemaVersion=3，数量为未限流预估，类型为比例估计，不能声称固定配额或实际整关总经验。持续投放优先报告频率、持续时间、同屏上限、预估数量与清场条件。运行时和生成器必须共用 EncounterConfig，修改后重新生成 JSON/CSV。平台与交互验证按 wechat-minigame-development 技能执行。
