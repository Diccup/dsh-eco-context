/*
 * ============================================================================
 * 本文件由 AI 辅助生成（AI-generated / AI-assisted）。
 *
 * 免责声明：
 *   本项目不对正确性、稳定性、适销性或特定用途适用性作任何明示或默示担保。
 *   使用本插件造成的任何直接或间接损失，作者与团队均不承担责任。
 *   请自行评估风险，并优先遵守所在地区的法律法规与服务商协议。
 *   完整声明见仓库根目录的 DISCLAIMER.md。
 * ============================================================================
 */
/**
 * 02-project/selftest.mjs — 单跑即绿：node blocks\02-project\selftest.mjs
 *
 * 任务书 A §二·02-project 要求：
 *   临时目录里造 a/b/c.txt、造一个符号链接指向外面（Windows 没权限就跳过并打 skip）；
 *   断言越界被拒、内部通过、sha256('') 的已知值。
 * 临时目录一律落 F:\workspace\LongMem\Temp（红线 5），跑完自删。
 */

import assert from 'node:assert/strict';
import { tempDir as resolveTempDir } from '../../libs/tempdir.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAME, resolveContentDir, isInside, sha256, dbPathFor, walkDirectoryDetailed, init } from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMP_ROOT = resolveTempDir();

let n = 0;
async function ok(label, fn) {
    await fn();
    n++;
    console.log(`  ✓ ${label}`);
}
function skip(label) {
    console.log(`  - skip ${label}`);
}

mkdirSync(TEMP_ROOT, { recursive: true });
const tmp = mkdtempSync(join(TEMP_ROOT, 's9-selftest-02-'));
const outside = mkdtempSync(join(TEMP_ROOT, 's9-selftest-02-outside-'));

try {
    console.log(`[selftest] ${NAME}`);

    // 夹具：tmp/a/b/c.txt + tmp/ok.txt + 根外 evil.txt（越界用例的靶子）
    mkdirSync(join(tmp, 'a', 'b'), { recursive: true });
    writeFileSync(join(tmp, 'a', 'b', 'c.txt'), 'hello');
    writeFileSync(join(tmp, 'ok.txt'), 'x');
    writeFileSync(join(outside, 'evil.txt'), 'evil');

    await ok('resolveContentDir 三态：opts > env > 兜底', () => {
        const got = join(tmp, 'given');
        const viaOpts = resolveContentDir({ contentDir: got });
        assert.equal(viaOpts, resolve(got));
        // env 态
        const prev = process.env.CONTEXT_MODE_DIR;
        try {
            process.env.CONTEXT_MODE_DIR = join(tmp, 'from-env');
            assert.equal(resolveContentDir({}), resolve(join(tmp, 'from-env')));
            // opts 赢 env
            assert.equal(resolveContentDir({ contentDir: got }), resolve(got));
        } finally {
            if (prev === undefined) delete process.env.CONTEXT_MODE_DIR;
            else process.env.CONTEXT_MODE_DIR = prev;
        }
        // 兜底态：绝对路径 + 落在 engine/.content
        const prev2 = process.env.CONTEXT_MODE_DIR;
        try {
            delete process.env.CONTEXT_MODE_DIR;
            const fb = resolveContentDir({});
            assert.ok(!fb.includes('undefined'));
            assert.match(fb.replace(/\\/g, '/'), /engine\/\.content$/);
        } finally {
            if (prev2 !== undefined) process.env.CONTEXT_MODE_DIR = prev2;
        }
        // 相对路径当 contentDir → throw（围栏根不许随 cwd 漂移）
        assert.throws(() => resolveContentDir({ contentDir: 'relative/dir' }), (e) => e.code === 'DENIED_PATH');
    });

    await ok('isInside：根内文件/目录/根自身都通过', () => {
        assert.equal(isInside(tmp, 'ok.txt'), true);
        assert.equal(isInside(tmp, 'a/b/c.txt'), true);
        assert.equal(isInside(tmp, '.'), true);
        assert.equal(isInside(tmp, tmp), true); // 绝对形态的同路径
    });

    await ok('isInside：.. 穿越 / 绝对越界 / 带分隔符前缀伪冒 全部 DENIED_PATH', () => {
        assert.throws(() => isInside(tmp, '../outside.txt'), (e) => e.code === 'DENIED_PATH');
        assert.throws(() => isInside(tmp, join(outside, 'evil.txt')), (e) => e.code === 'DENIED_PATH');
        // 关键用例：兄弟目录名以本目录名为前缀时，朴素 startsWith 会误判 inside
        const sibling = tmp + '-evil';
        mkdirSync(sibling, { recursive: true });
        try {
            assert.throws(() => isInside(tmp, join(sibling, 'x.txt')), (e) => e.code === 'DENIED_PATH');
        } finally {
            rmSync(sibling, { recursive: true, force: true });
        }
        assert.throws(() => isInside('', 'x'), (e) => e.code === 'DENIED_PATH');
    });

    await ok('isInside：符号链接逃逸被 realpath 闸拒绝（没权限造链接则 skip）', () => {
        const linkPath = join(tmp, 'escape-link');
        const linkDir = join(tmp, 'escape-dir');
        try {
            symlinkSync(outside, linkPath, 'file');
            symlinkSync(outside, linkDir, 'dir');
        } catch (e) {
            skip(`无符号链接创建权限（${e.code}），跳过 symlink 用例 — 判定逻辑本身已由上两条覆盖`);
            return;
        }
        try {
            // 链接在根内、目标在根外：词法闸放行，realpath 闸必须拦下
            // ★ 判"是不是围栏外"要看 e.details.why（"围栏外"三个字在 why 里，
            //   不在 e.message 里 —— e.message 第一行是通用 fix 文案）。
            //   本机没权限建 symlink 时这条会 skip，所以本地跑不到；CI runner 有权限，
            //   会真跑到 —— 判据写不对就在别人机器上才暴露。
            const isFenceEscaped = (e) => e.code === 'DENIED_PATH'
                && /围栏外/.test(String(e.message ?? '') + String(e.details?.why ?? ''));
            assert.throws(() => isInside(tmp, 'escape-link'), isFenceEscaped);
            assert.throws(() => isInside(tmp, 'escape-dir'), isFenceEscaped);
            // 指向根内的链接必须放行（别把正常软链也杀了）
            const innerLink = join(tmp, 'inner-link');
            symlinkSync(join(tmp, 'ok.txt'), innerLink, 'file');
            assert.equal(isInside(tmp, 'inner-link'), true);
        } finally {
            for (const p of [linkPath, linkDir, join(tmp, 'inner-link')]) {
                try {
                    rmSync(p, { force: true });
                } catch { /* ignore */ }
            }
        }
    });

    await ok('isInside：路径尚不存在时按词法判定放行（创建中的文件可用）', () => {
        assert.equal(isInside(tmp, join('a', 'b', 'not-yet.txt')), true);
        assert.throws(() => isInside(tmp, join('..', 'not-yet.txt')), (e) => e.code === 'DENIED_PATH');
    });

    await ok('sha256：已知值完整节核对', () => {
        assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
        assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        assert.equal(sha256('中文'), sha256(Buffer.from('中文', 'utf8').toString('utf8')));
        assert.equal(sha256('中文').length, 64);
    });

    await ok('dbPathFor：content 哈希名 / memory 固定名 / tmp 带 pid / 非法 kind throw', () => {
        const c1 = dbPathFor(tmp, 'content', 'label-A');
        const c2 = dbPathFor(tmp, 'content', 'label-B');
        assert.match(c1, new RegExp('^' + tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\\\/][0-9a-f]{16}\\.db$'));
        assert.notEqual(c1, c2);
        assert.equal(c1, dbPathFor(tmp, 'content', 'label-A')); // 同 id 同名 = 幂等
        assert.equal(dbPathFor(tmp, 'memory'), join(tmp, 'memory.persistent.db'));
        assert.match(dbPathFor(tmp, 'tmp'), new RegExp('tmp-' + process.pid + '\\.db$'));
        assert.throws(() => dbPathFor(tmp, 'nope'), (e) => e.code === 'DENIED_PATH');
        assert.throws(() => dbPathFor(tmp, 'content'), (e) => e.code === 'DENIED_PATH');
        assert.throws(() => dbPathFor('relative/dir', 'memory'), (e) => e.code === 'DENIED_PATH');
        // contentDir 自身必须在围栏内（双库不许写到根外）
        assert.equal(isInside(dirname(c1), c1), true);
    });

    await ok('isInside：junction（mklink /J）逃逸被 realpath.native 闸拒绝', () => {
        // Windows 专属：junction 创建不需要管理员权限，且 fs.realpathSync 解不开它
        // （实测原样返回词法路径），只有 realpathSync.native 会解析 → 这条同时验证
        // "围栏必须用 .native" 这个实现选择，不是摆设。
        if (process.platform !== 'win32') {
            skip('非 Windows，跳过 junction 用例');
            return;
        }
        const jn = join(tmp, 'jn-escape');
        try {
            execFileSync('cmd.exe', ['/c', 'mklink', '/J', jn, outside], { stdio: 'ignore' });
        } catch (e) {
            skip(`mklink /J 失败（${e.status ?? e.code}），跳过 junction 用例`);
            return;
        }
        try {
            // 前置事实核对（**仅供参考，不作断言**）：libuv 版 realpath 是否解得开 junction
            // 取决于 libuv 版本/平台 —— 换台机器就可能变。把它写成硬断言会把"环境巧合"
            // 当成产品契约，2026-11-03 在本机就误报了一次（.native 与 libuv 结果相同）。
            // 真正的契约在下面三行：**不管谁解得开，围栏必须拦下 junction 逃逸**。
            const libuv = realpathSync(jn);
            const native = (realpathSync.native ?? realpathSync)(jn);
            if (libuv !== native) {
                console.log(`    （情报）libuv realpath 未解析 junction，.native 解析到 ${native}`);
            }
            else {
                console.log(`    （情报）本机 libuv realpath 已能解析 junction（${libuv}），.native 兜底仍保留`);
            }
            // ★ 判据改成**语义等價**而不是字符串全等（2026-11-16 发布版修）：
            //   同一目录，libuv realpath 与 .native realpath 可能给出**不同字符串形态**
            //   —— Windows 上 8.3 短路径（`C:\Users\RUNNER~1\...`）与长路径
            //   （`C:\Users\runneradmin\...`）指向同一个目录，GitHub Actions runner 上
            //   实测就是这样。字符串全等把"环境形态差异"当成了契约失败。
            //   真正的契约是：junction 解析到的目录 = 根外那个夹具目录。
            //   验法：把两边都归一（转小写 + 反斜杠换正斜杠）后比较。
            const normPath = (s) => String(s).replace(/\\/g, '/').toLowerCase();
            assert.equal(
                normPath(native),
                normPath(realpathSync(outside)),
                'junction 应解析到根外夹具目录',
            );
            // 关键断言：目标文件真实存在于根外，围栏必须拦下
            assert.equal(existsSync(join(outside, 'evil.txt')), true);
            assert.throws(() => isInside(tmp, 'jn-escape'), (e) => e.code === 'DENIED_PATH'
                && /围栏外/.test(String(e.message ?? '') + String(e.details?.why ?? '')));
            assert.throws(() => isInside(tmp, join('jn-escape', 'evil.txt')), (e) => e.code === 'DENIED_PATH');
            // 遍历侧：junction 目录不得被收进结果
            const w = walkDirectoryDetailed(tmp, { extensions: ['.txt'] });
            assert.ok(!w.files.some((p) => p.includes('jn-escape')), 'walk 漏过了 junction 逃逸');
        } finally {
            // 只删链接本身：对 junction 用 rmSync -r 会递归进目标目录，
            // `cmd /c rmdir` 是无条件安全的那条路。
            try {
                execFileSync('cmd.exe', ['/c', 'rmdir', '/Q', jn], { stdio: 'ignore' });
            } catch { /* ignore */ }
        }
    });

    await ok('walkDirectoryDetailed：夹具遍历 + capped + 逃逸软链跳过', () => {
        const r = walkDirectoryDetailed(tmp, { maxDepth: 5, maxFiles: 200 });
        const rootReal = (realpathSync.native ?? realpathSync)(tmp);
        const rel = r.files.map((p) => p.slice(rootReal.length + 1).replace(/\\/g, '/')).sort();
        assert.deepEqual(rel, ['a/b/c.txt', 'ok.txt'].sort());
        assert.equal(r.capped, false);
        assert.equal(r.totalSeen, 2);
        // 截断：maxFiles=1 必须 capped 且只留 1 条
        const t = walkDirectoryDetailed(tmp, { maxFiles: 1 });
        assert.equal(t.files.length, 1);
        assert.equal(t.capped, true);
        // 扩展名过滤：只收 .md → 0 条
        assert.equal(walkDirectoryDetailed(tmp, { extensions: ['.md'] }).files.length, 0);
        // .gitignore 生效
        writeFileSync(join(tmp, '.gitignore'), 'ignored/\n');
        mkdirSync(join(tmp, 'ignored'), { recursive: true });
        writeFileSync(join(tmp, 'ignored', 'g.txt'), 'g');
        const g = walkDirectoryDetailed(tmp, { extensions: ['.txt'] });
        assert.ok(!g.files.some((p) => p.includes('ignored')));
        rmSync(join(tmp, '.gitignore'), { force: true });
        rmSync(join(tmp, 'ignored'), { recursive: true, force: true });
        // 不存在的根：空结果不 throw
        assert.deepEqual(walkDirectoryDetailed(join(tmp, 'no-such-dir')), { files: [], capped: false, totalSeen: 0 });
    });

    await ok('init(ctx)：把 contentDir 解析结果挂回 ctx', async () => {
        const ctx = { contentDir: tmp };
        const r = await init(ctx);
        assert.equal(r.name, 'project');
        assert.equal(ctx.contentDir, resolve(tmp));
        assert.ok(ctx.project && typeof ctx.project.isInside === 'function');
    });

    // ─────────────────────────────────────────────────────────
    // ★★ 2026-11-14（项目 07）：`.gitignore` 逐层 + 反选（对齐第三方 /walk.ts）
    //    修前三处错：只读根层 / `!` 整行丢掉 / `/`·`dir/`·`\x` 不认。
    // ─────────────────────────────────────────────────────────
    await ok('[07-A8] .gitignore 反选 `!` 生效（*.log + !keep.log）', () => {
        const root = join(tmp, 'gi-neg');
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, '.gitignore'), '*.log\n!keep.log\n');
        writeFileSync(join(root, 'a.log'), 'a');
        writeFileSync(join(root, 'keep.log'), 'keep');
        writeFileSync(join(root, 'b.txt'), 'b');
        const names = walkDirectoryDetailed(root, { extensions: ['.log', '.txt'] }).files.map((p) => p.split(/[/\\]/).pop()).sort();
        // ★ 判据：a.log 被排、keep.log 被反选放出来、b.txt 不受影响
        assert.deepEqual(names, ['b.txt', 'keep.log'], `实际：${names}`);
    });

    await ok('[07-A8] 子目录 .gitignore 逐层生效（且反选只作用于本子树）', () => {
        const root = join(tmp, 'gi-nested');
        mkdirSync(join(root, 'sub'), { recursive: true });
        writeFileSync(join(root, '.gitignore'), '*.tmp\n');
        writeFileSync(join(root, 'sub', '.gitignore'), '!*.tmp\n');   // 子目录把 tmp 放回来
        writeFileSync(join(root, 'x.tmp'), 'x');
        writeFileSync(join(root, 'sub', 'y.tmp'), 'y');
        writeFileSync(join(root, 'sub', 'z.md'), 'z');
        const got = walkDirectoryDetailed(root, { extensions: ['.tmp', '.md'] });
        const rel = got.files.map((p) => p.split(/[/\\]/).slice(-2).join('/')).sort();
        // 根层 *.tmp 排掉 x.tmp；子目录的 !*.tmp 把 y.tmp 放回来
        assert.ok(!rel.some((r) => r === 'gi-nested/x.tmp'), `根的 x.tmp 没被排：${rel}`);
        assert.ok(rel.some((r) => r === 'sub/y.tmp'), `子目录反选没生效：${rel}`);
    });

    await ok('[07-A8] `/` 锚定 vs 非锚定；`dir/` 只排目录；`**` 段语义', () => {
        const root = join(tmp, 'gi-anchor');
        mkdirSync(join(root, 'deep', 'nest'), { recursive: true });
        mkdirSync(join(root, 'build'), { recursive: true });
        // /root.md 只排根层同名；非锚定的 nest.md 排任意深度同名
        writeFileSync(join(root, '.gitignore'), '/root.md\nnest.md\nbuild/\n!build/keep.md\nlogs/**\n');
        writeFileSync(join(root, 'root.md'), 'r');
        writeFileSync(join(root, 'deep', 'root.md'), 'r2');       // 非根层 → 不该被 /root.md 排
        writeFileSync(join(root, 'deep', 'nest', 'nest.md'), 'n');
        writeFileSync(join(root, 'build', 'keep.md'), 'k');        // build/ 排目录 → 进不去 → keep.md 也拿不到（git 同款）
        const rel = walkDirectoryDetailed(root, { extensions: ['.md'] }).files
            .map((p) => p.split(/[/\\]/).slice(-3).join('/')).sort();
        assert.ok(!rel.some((r) => r.endsWith('gi-anchor/root.md')), `根层 root.md 没被排：${rel}`);
        assert.ok(rel.some((r) => r.endsWith('deep/root.md')), `/root.md 错误地排了子目录同名文件：${rel}`);
        assert.ok(!rel.some((r) => r.includes('nest.md')), `非锚定 nest.md 没排掉任意深度的同名：${rel}`);
        // ★ git 规范：父目录被排除时，里面的文件无法用 ! 拉回
        assert.ok(!rel.some((r) => r.includes('build/keep')), `build/ 被排却还能进去：${rel}`);
    });

    console.log(`[selftest] ${NAME} — ${n} 条断言全绿 ✅`);
} finally {
    for (const p of [tmp, outside]) {
        try {
            rmSync(p, { recursive: true, force: true });
        } catch { /* ignore */ }
        if (existsSync(p)) throw new Error(`临时目录未清干净：${p}`);
    }
}
