// 构建 DSH 工作台客户端：把 src/client.jsx 打成单文件 lib/client.js。
// 用法：node scripts/build-client.mjs（package.json 的 build 脚本就是这么调的）。
// 优先用 bun build（bun 1.4.4 可用）；bun 不可用或打包失败时，改用 npx esbuild 同等参数。
// 不依赖 pnpm。构建产物 lib/client.js 用 window.__ModuleLoader__.load 包装，
// 与跨平台账号看板参考实现（src/client.js）的包装形式一致。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'src', 'client.jsx');
const tmpOut = join(root, 'lib', 'app.cjs');
const finalOut = join(root, 'lib', 'client.js');
const MODULE_ID = 'dsh-workbench-xiaohongshu-ops';

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r;
}

function buildWithBun() {
  // 注意：bun 的 external 写法是 -e react（或 --external=react），
  // 不是 --external:react（冒号写法 bun 不认，会报无法解析 react）。
  // 客户端用 React.createElement 手写，不含 JSX 语法，因此不会引入 react/jsx-runtime。
  const r = run('bun', ['build', 'src/client.jsx', '-e', 'react', '-e', 'react-dom', '--format=cjs', '--outfile=lib/app.cjs']);
  return r.status === 0 && existsSync(tmpOut);
}

function buildWithEsbuild() {
  // esbuild 的 external 写法是 --external:react（冒号形式）。
  const r = run('npx', ['--yes', 'esbuild', 'src/client.jsx', '--bundle', '--external:react', '--external:react-dom', '--format=cjs', '--outfile=lib/app.cjs']);
  return r.status === 0 && existsSync(tmpOut);
}

if (!existsSync(entry)) {
  console.error('入口不存在：' + entry);
  process.exit(1);
}

let ok = false;
let builder = '';
try {
  ok = buildWithBun();
  builder = 'bun';
} catch (e) {
  console.error('bun build 异常：' + (e && e.message ? e.message : String(e)));
}
if (!ok) {
  console.error('bun build 不可用或失败，改用 npx esbuild。');
  try {
    ok = buildWithEsbuild();
    builder = 'esbuild';
  } catch (e) {
    console.error('esbuild 也失败：' + (e && e.message ? e.message : String(e)));
  }
}
if (!ok) {
  console.error('构建失败：bun 与 esbuild 均未产出 lib/app.cjs。');
  process.exit(1);
}

const bundled = readFileSync(tmpOut, 'utf8');
const wrapped =
  "window.__ModuleLoader__.load({id:'" + MODULE_ID + "', factory(require){ const module={exports:{}}; const exports=module.exports;\n" +
  bundled +
  "\n return module.exports; }});\n";
writeFileSync(finalOut, wrapped, 'utf8');
rmSync(tmpOut, { force: true });

// 校验：必须含 ModuleLoader 包装与注册调用，且不含 ESM 的 from 'react' 残留与 jsx-runtime。
const out = readFileSync(finalOut, 'utf8');
const checks = [
  ['包含 window.__ModuleLoader__.load', out.includes('window.__ModuleLoader__.load')],
  ['包含 desktopWorkbenches.register', out.includes('desktopWorkbenches.register')],
  ['包含 customFrame:true', out.includes('customFrame:true') || out.includes('customFrame: true')],
  ['不含 ESM 的 from \'react\'', !/from\s+['"]react['"]/.test(out)],
  ['不含 react/jsx-runtime', !out.includes('react/jsx-runtime')],
  ['不含 react/jsx-dev-runtime', !out.includes('react/jsx-dev-runtime')],
];
let failed = false;
for (const [name, pass] of checks) {
  console.log((pass ? '通过' : '失败') + '：' + name);
  if (!pass) failed = true;
}
if (failed) {
  console.error('校验失败，产物保留在 ' + finalOut + ' 供检查。');
  process.exit(1);
}
console.log('构建成功（' + builder + '）：' + finalOut + '（' + Buffer.byteLength(out) + ' 字节，单文件）');
