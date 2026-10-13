/**
 * 离线冒烟的隔离入口。
 *
 * 直接 `pnpm smoke` 会经过这里：在临时目录里搭一份只有 raw/ 与 schema/ 的副本，
 * 通过 MY_WIKI_ROOT 把整条流水线重定向过去，跑完即删。这样**绝不会擦掉或改写**
 * 用户真实的 wiki/ 与 .state/——离线冒烟之前就发生过「还原逻辑有 bug → 真实产物
 * 被清空」的事故，隔离是从根上消除这个风险。
 *
 * 用法与 offline-smoke.ts 一致：
 *   pnpm smoke            隔离跑一遍，结束不留痕
 *   pnpm smoke --keep     把隔离副本里的产物拷回项目，便于人工检查 wiki/
 */
import { existsSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function bootstrap(): Promise<void> {
  if (process.env['MY_WIKI_ROOT']) return; // 已被外层设置过，兜底跳过

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'my-wiki-smoke-'));
  // 流水线只依赖这两份只读输入，拷过去即可；wiki/ 与 .state/ 会在运行时新建
  for (const sub of ['raw', 'schema']) {
    if (existsSync(sub)) await cp(sub, path.join(tmp, sub), { recursive: true });
  }
  process.env['MY_WIKI_ROOT'] = tmp;

  const { main } = await import('./offline-smoke.js');
  await main();

  const keep = process.argv.includes('--keep');
  if (keep) {
    for (const sub of ['wiki', '.state']) {
      const src = path.join(tmp, sub);
      if (existsSync(src)) {
        await rm(sub, { recursive: true, force: true });
        await cp(src, sub, { recursive: true });
      }
    }
    console.log(`\n[smoke] --keep：产物已拷回项目（wiki/ 与 .state/），隔离目录 ${tmp} 保留。`);
  } else {
    await rm(tmp, { recursive: true, force: true });
  }
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
