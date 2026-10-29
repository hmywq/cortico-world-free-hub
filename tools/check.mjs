#!/usr/bin/env node
/**
 * tools/check.mjs —— 上架前自检（替代官方 `pnpm check:extension`）
 *
 * 官方的 check:extension 要在 Cortico 源码仓库里跑（我们是装在用户机器上的 Coo，
 * 只有 app.asar 解出来的 build 源，跑不了那个脚本）。这里把它最关键的几项自己核一遍：
 *
 *   1. manifest 形状（type/kind/api/keywords/main/exports/webUiClient/webUiStyle/describe）
 *   2. 入口能 import 出 WorldDefinition（id/label/defaults/create）
 *   3. create() 出来的实例有 start/stop/tools/envPromptVars，且 tools 名字与 describe.json 一致
 *   4. 面板产物文件存在、能被取到
 *   5. 源码/产物里**没有个人绝对路径**（C:/Users/<名>、/home/<名>）
 *   6. LICENSE / CHANGELOG（含当前版本段）/ README 存在
 *
 * 用法：node tools/check.mjs        （退出码 0 = 全过）
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));
const fails = [];
const warns = [];
const ok = (m) => console.log('  ✅ ' + m);
const bad = (m) => {
  fails.push(m);
  console.log('  ❌ ' + m);
};
const warn = (m) => {
  warns.push(m);
  console.log('  ⚠️  ' + m);
};

console.log('== 1. manifest ==');
const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
const c = pkg.cortico || {};
if (pkg.type === 'module') ok('type = module');
else bad('package.json 缺 "type": "module"');
if (c.kind === 'world') ok('cortico.kind = world');
else bad('cortico.kind 必须是 world，现在是 ' + c.kind);
if (c.api === 6) ok('cortico.api = 6');
else bad('cortico.api 必须是 6，现在是 ' + c.api);
if ((pkg.keywords || []).includes('cortico-world')) ok('keywords 含 cortico-world');
else bad('keywords 缺 cortico-world（npm 搜索按它归类）');
for (const f of ['main', 'exports']) if (pkg[f]) ok(`有 ${f}`);
if (pkg.main && !existsSync(join(PKG, pkg.main))) bad('main 指向的文件不存在：' + pkg.main);
if (c.webUiClient && existsSync(join(PKG, c.webUiClient))) ok('webUiClient 产物存在：' + c.webUiClient);
else bad('webUiClient 缺失或文件不存在');
if (c.webUiStyle && existsSync(join(PKG, c.webUiStyle))) ok('webUiStyle 产物存在：' + c.webUiStyle);
else warn('webUiStyle 缺失（可选，但面板会没有样式）');
if (c.describe && existsSync(join(PKG, c.describe))) ok('cortico.describe 指向 ' + c.describe);
else bad('cortico.describe 缺失（市场索引要读它）');

console.log('\n== 2. 入口定义 ==');
let def = null;
try {
  const mod = await import(pathToFileURL(join(PKG, pkg.main || 'src/index.ts')).href);
  def = mod.default ?? mod.WORLD;
  if (def && def.id && def.label && typeof def.defaults === 'function' && typeof def.create === 'function') {
    ok(`WorldDefinition 完整：id=${def.id} label=${def.label}`);
  } else bad('入口导出的不是完整 WorldDefinition');
} catch (err) {
  bad('入口 import 失败：' + (err?.message || err));
}

console.log('\n== 3. 实例与工具 ==');
let inst = null;
if (def) {
  try {
    inst = def.create({ cfg: { ...def.defaults(), enabled: true }, secret: () => '' });
    for (const m of ['start', 'stop', 'tools', 'envPromptVars']) {
      if (typeof inst[m] === 'function') ok('实例有 ' + m + '()');
      else bad('实例缺 ' + m + '()');
    }
    const tools = typeof inst.tools === 'function' ? inst.tools() : [];
    const names = tools.map((t) => t.name).sort();
    ok('工具：' + names.join(', '));
    const desc = JSON.parse(readFileSync(join(PKG, c.describe || 'describe.json'), 'utf8'));
    const descNames = (desc.tools || []).map((t) => t.name).sort();
    if (JSON.stringify(names) === JSON.stringify(descNames)) ok('describe.json 与 tools() 一致');
    else bad(`describe.json 与 tools() 不一致：代码 ${names} / 文件 ${descNames}`);
    for (const t of tools) {
      if (!t.description || !t.parameters) bad(`工具 ${t.name} 缺 description/parameters`);
    }
    const ui = typeof inst.webUi === 'function' ? inst.webUi('zh') : null;
    if (ui && Array.isArray(ui.panels) && ui.panels.length) ok('webUi() 声明了面板：' + ui.panels.map((p) => p.id).join(','));
    else warn('webUi() 没声明面板（页面上会是空的）');
  } catch (err) {
    bad('实例化/调用失败：' + (err?.message || err));
  }
}

console.log('\n== 4. 个人绝对路径 ==');
const pathRe = /(C:[\\/]Users[\\/][^\\/'"\s]+|\/home\/[^\/'"\s]+|\/Users\/[^\/'"\s]+)/g;
let leaked = 0;
for (const rel of ['src/index.ts', 'src/world.ts', 'src/channels.ts', 'src/creds.ts', 'dist/webui.js', 'dist/webui.css', 'describe.json']) {
  const p = join(PKG, rel);
  if (!existsSync(p)) continue;
  const text = readFileSync(p, 'utf8');
  const hits = [...text.matchAll(pathRe)].map((m) => m[0]);
  if (hits.length) {
    leaked += hits.length;
    bad(`${rel} 里有个人绝对路径：${[...new Set(hits)].join(', ')}`);
  }
}
if (!leaked) ok('源码与产物里没有个人绝对路径');

console.log('\n== 5. 上架材料 ==');
for (const f of ['LICENSE', 'CHANGELOG.md', 'README.md']) {
  if (existsSync(join(PKG, f))) ok('有 ' + f);
  else bad('缺 ' + f);
}
const changelog = existsSync(join(PKG, 'CHANGELOG.md')) ? readFileSync(join(PKG, 'CHANGELOG.md'), 'utf8') : '';
if (changelog.includes('## ' + pkg.version)) ok('CHANGELOG 有当前版本段（## ' + pkg.version + '）');
else bad('CHANGELOG 里找不到「## ' + pkg.version + '」这一节');

console.log('\n== 结果 ==');
if (!fails.length) {
  console.log(`✅ 全过（${warns.length} 条提醒）—— 代码层面可以打包上架`);
  console.log('   剩余外部步骤：官方索引仓提 issue（需要能上 GitHub）');
  process.exit(0);
}
console.log(`❌ ${fails.length} 项未过：`);
for (const f of fails) console.log('   - ' + f);
process.exit(1);
