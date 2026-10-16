/**
 * 断言库 —— 不引第三方测试框架。
 *
 * 为什么自己写：项目零依赖起步，测试基础设施不该反过来引入构建负担。
 * 需要的断言只有这几种，且失败信息比通用框架更直白（能直接显示"缺哪条错误"）。
 *
 * 【设计】用 `createSuite()` 拿一个独立命名空间，而不是全局计数器 ——
 * 这样多个套件可以同进程运行而不互相污染计数。
 */

export function createSuite(title) {
  let passed = 0;
  let failed = 0;
  const failures = [];
  let currentSection = '';

  function record(ok, name, detail) {
    if (ok) {
      passed++;
    } else {
      failed++;
      failures.push({ section: currentSection, name, detail });
    }
  }

  const api = {
    section(name) {
      currentSection = name;
    },

    ok(cond, name, detail = '条件为假') {
    record(!!cond, name, detail);
    },

    eq(actual, expected, name) {
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      record(a === e, name, `实际 ${a} ≠ 期望 ${e}`);
    },

    /**
     * 断言"校验器必须报出某类错误"。
     *
     * 这是本套件的核心断言形态 —— 不是验证"当前配置是对的"，
     * 而是**故意喂坏数据、确认校验器抓得住**。
     * 只验前者的话，校验逻辑写错了也测不出来。
     */
    expectError(errors, fragment, name) {
   const hit = errors.some((e) => e.includes(fragment));
      record(hit, name,
        hit ? '' : `未找到含「${fragment}」的错误；实际：${JSON.stringify(errors)}`);
    },

    /** 断言"不该报任何错误" */
    expectClean(errors, name) {
      record(errors.length === 0, name,
   errors.length === 0 ? '' : `期望无错，实际：${JSON.stringify(errors)}`);
    },

    /** 断言错误条数（用于"这一处畸形只应报 1 条"） */
    expectCount(errors, n, name) {
      record(errors.length === n, name,
     `期望 ${n} 条，实际 ${errors.length} 条：${JSON.stringify(errors)}`);
    },

    report() {
 const line = '='.repeat(62);
      console.log('\n' + line);
      console.log(title);
      console.log(line);
      if (failures.length === 0) {
      console.log(`\n✅ 全部通过：${passed} 项断言`);
      } else {
        console.log(`\n❌ ${failed} 项失败 / 共 ${passed + failed} 项\n`);
        for (const f of failures) {
   console.log(`  ✗ [${f.section}] ${f.name}`);
    console.log(`      ${f.detail}`);
        }
    }
      console.log(line + '\n');
      return { passed, failed, failures };
    },
  };

  return api;
}