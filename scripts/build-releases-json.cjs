#!/usr/bin/env node
/**
 * 生成并（可选）发布商业版版本历史数据源 releases.json。
 *
 * 背景：打包后的商业版（build target = commercial）不走 GitHub API，而是从
 * `PROFER_UPDATE_FEED_URL`（默认 https://updates.profer.cn/）下取 releases.json，
 * 见 apps/electron/src/main/ipc.ts 的 fetchServerReleases()。该文件此前没有生成脚本，
 * 服务器上长期缺失（404）导致商业版「版本历史」为空。
 *
 * 数据来源：GitHub Releases（与 oss 版列表保持同一事实来源），草稿剔除、预发布保留
 * 并带上 prerelease 标记，按发布时间倒序。
 *
 * 用法：
 *   node scripts/build-releases-json.cjs                 # 只生成到 release-notes/releases.json
 *   node scripts/build-releases-json.cjs --out /tmp/x.json
 *   node scripts/build-releases-json.cjs --upload        # 生成后上传到两台更新服务器
 *   node scripts/build-releases-json.cjs --upload --verify-only
 *
 * 环境变量（与 scripts/push-release.cjs 保持一致）：
 *   PROFER_UPDATE_SSH_HOST / _USER / _PORT / PROFER_UPDATE_DIR        新机（updates.profer.cn）
 *   PROFER_UPDATE_LEGACY_SSH_HOST / _USER / _PORT / PROFER_UPDATE_LEGACY_DIR  旧机
 *   PROFER_UPDATE_SKIP_LEGACY=1                                       只写新机
 */
const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// 与 scripts/push-release.cjs 的 Windows 用法保持一致：发布脚本可能在 Windows(Git Bash) 或
// macOS/Linux 上执行，ssh/scp/curl 通过显式 bash 调用，避免平台默认 shell 的解释差异。
const BASH = process.env.PROFER_BASH || (process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/bash.exe' : '/bin/bash');
const args = process.argv.slice(2);
const UPLOAD = args.includes('--upload');
const VERIFY_ONLY = args.includes('--verify-only');
const outIndex = args.indexOf('--out');
const OUT_FILE = path.resolve(outIndex >= 0 ? args[outIndex + 1] : path.join(ROOT, 'release-notes/releases.json'));
const LIMIT_INDEX = args.indexOf('--limit');
const LIMIT = LIMIT_INDEX >= 0 ? Number(args[LIMIT_INDEX + 1]) : 100;

const GH_REPO = 'Yuan-lai-ru-ci/ProferAI';
const FILE_NAME = 'releases.json';

const TARGETS = [
  {
    label: '新机',
    host: process.env.PROFER_UPDATE_SSH_HOST || '45.114.127.232',
    user: process.env.PROFER_UPDATE_SSH_USER || 'root',
    port: process.env.PROFER_UPDATE_SSH_PORT || '41235',
    dir: process.env.PROFER_UPDATE_DIR || '/var/www/updates.profer.cn',
    url: 'https://updates.profer.cn/releases.json',
  },
];
if (!process.env.PROFER_UPDATE_SKIP_LEGACY) {
  TARGETS.push({
    label: '旧机',
    host: process.env.PROFER_UPDATE_LEGACY_SSH_HOST || '47.109.108.57',
    user: process.env.PROFER_UPDATE_LEGACY_SSH_USER || 'ecs-user',
    port: process.env.PROFER_UPDATE_LEGACY_SSH_PORT || '22',
    dir: process.env.PROFER_UPDATE_LEGACY_DIR || '/usr/share/nginx/html/profer-updates',
    url: 'https://profer.cn/profer-updates/releases.json',
  });
}

/**
 * 只保留客户端类型契约需要的字段，避免把 GitHub 的噪音字段搬上服务器。
 * 字段集合与 packages/shared 的 GitHubRelease 对齐。
 */
function toClientRelease(release) {
  return {
    id: release.id,
    tag_name: release.tag_name,
    name: release.name ?? release.tag_name,
    body: release.body ?? '',
    draft: false,
    prerelease: Boolean(release.prerelease),
    created_at: release.created_at,
    published_at: release.published_at ?? release.created_at,
    html_url: release.html_url ?? `https://github.com/${GH_REPO}/releases/tag/${release.tag_name}`,
  };
}

function fetchReleases() {
  // gh release list 支持的 JSON 字段集比 gh release view 窄（无 id/url/body）。
  const json = execSync(
    `gh release list --repo ${GH_REPO} --limit ${LIMIT} --json tagName,name,isDraft,isPrerelease,createdAt,publishedAt`,
    { cwd: ROOT, encoding: 'utf8' },
  );
  const listed = JSON.parse(json).filter((release) => !release.isDraft);
  // gh release list 不返回 body，逐条取详情；已发布的 Release 数量有限，成本可接受。
  return listed.map((item) => {
    const detail = JSON.parse(
      execSync(`gh release view ${item.tagName} --repo ${GH_REPO} --json id,tagName,name,body,isDraft,isPrerelease,createdAt,publishedAt,url`, {
        cwd: ROOT,
        encoding: 'utf8',
      }),
    );
    return toClientRelease({
      id: detail.id,
      tag_name: detail.tagName,
      name: detail.name,
      body: detail.body,
      draft: detail.isDraft,
      prerelease: detail.isPrerelease,
      created_at: detail.createdAt,
      published_at: detail.publishedAt,
      html_url: detail.url,
    });
  }).sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)));
}

function uploadTo(target, localFile) {
  const sudo = target.user === 'root' ? '' : 'sudo ';
  const remoteTmp = `/tmp/${FILE_NAME}`;
  run(`scp -o StrictHostKeyChecking=yes -P ${target.port} ${JSON.stringify(localFile)} ${target.user}@${target.host}:${remoteTmp}`);
  run(`ssh -o StrictHostKeyChecking=yes -p ${target.port} ${target.user}@${target.host} ${JSON.stringify(`${sudo}mkdir -p ${target.dir} && ${sudo}cp ${remoteTmp} ${target.dir}/${FILE_NAME} && ${sudo}chmod 644 ${target.dir}/${FILE_NAME} && rm -f ${remoteTmp}`)}`);
  console.log(`  已写入 ${target.label} ${target.user}@${target.host}:${target.dir}/${FILE_NAME}`);
}

function run(command) {
  const result = spawnSync(BASH, ['-c', command], { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
  if (result.error) throw new Error(`无法启动 ${BASH}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${command} 失败 (exit ${result.status})\n${(result.stderr || '').trim()}`);
  }
  return (result.stdout || '').trim();
}

function verify(target) {
  // 远端文件 + 公网可达性都要对得上：先看服务器上的文件，再走 HTTPS 抓一次。
  const remoteSize = run(`ssh -o StrictHostKeyChecking=yes -p ${target.port} ${target.user}@${target.host} ${JSON.stringify(`stat -c %s ${target.dir}/${FILE_NAME}`)}`);
  const localSize = fs.statSync(OUT_FILE).size;
  if (Number(remoteSize) !== localSize) {
    throw new Error(`${target.label} ${FILE_NAME} 大小不一致: remote=${remoteSize} local=${localSize}`);
  }
  const url = `${target.url}?t=${Date.now()}`;
  const head = run(`curl -s -o /dev/null -w '%{http_code}' -m 20 ${JSON.stringify(url)}`);
  if (head !== '200') throw new Error(`${target.label} ${target.url} 返回 ${head}`);
  console.log(`  ${target.label} 校验通过: ${url.split('?')[0]} 200（${localSize} bytes）`);
}

(async () => {
  if (!VERIFY_ONLY) {
    console.log(`=== 生成 ${FILE_NAME}（来源 ${GH_REPO}）===`);
    const releases = fetchReleases();
    if (releases.length === 0) throw new Error('GitHub 未返回任何已发布 Release；拒绝写入空清单。');
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, `${JSON.stringify(releases, null, 2)}\n`, 'utf8');
    console.log(`  写入 ${path.relative(ROOT, OUT_FILE)}：${releases.length} 条，最新 ${releases[0].tag_name}（${releases[0].published_at}）`);
  } else if (!fs.existsSync(OUT_FILE)) {
    throw new Error(`--verify-only 需要已存在的 ${OUT_FILE}`);
  }

  if (UPLOAD) {
    console.log(`=== 上传 ${FILE_NAME} ===`);
    if (!VERIFY_ONLY) for (const target of TARGETS) uploadTo(target, OUT_FILE);
  }

  // 只在真的写了服务器（上传）或显式要求校验时才验证，纯生成不该因为远端还没有文件而报错。
  if (UPLOAD || VERIFY_ONLY) {
    console.log(`=== 校验 ${FILE_NAME} ===`);
    for (const target of TARGETS) verify(target);
  }
  console.log(`${FILE_NAME} 处理完成`);
})().catch((error) => {
  console.error(`${FILE_NAME} 处理失败：${error.message}`);
  process.exit(1);
});
