import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('/Users/zhufan/Code/today-qa/web-e2e/node_modules/playwright');

const ROOT = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..');
const TMP_DIR = path.join(ROOT, 'scripts', '.tmp_assets');
const COVERS_DIR = path.join(ROOT, 'xhs_launch_kit', 'covers');
fs.mkdirSync(path.join(TMP_DIR, 'video1'), { recursive: true });
fs.mkdirSync(path.join(TMP_DIR, 'video2'), { recursive: true });
fs.mkdirSync(COVERS_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json'
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const reqPath = (req.url || '/').split('?')[0];
      const rel = decodeURIComponent(reqPath).replace(/^\/+/, '');
      let filePath = path.resolve(ROOT, rel);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }
      if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end('Not found: ' + filePath);
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

async function auditRoute(browser, baseUrl, routePath, viewport, label) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const externalRequests = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('request', (req) => {
    const u = req.url();
    if (!u.startsWith('http://127.0.0.1') && !u.startsWith('data:') && !u.startsWith('blob:')) {
      externalRequests.push(u);
    }
  });

  const resp = await page.goto(`${baseUrl}${routePath}`, { waitUntil: 'networkidle' });
  assert(resp && resp.status() === 200, `${label} HTTP status !== 200 (got ${resp ? resp.status() : 'null'})`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  assert(!overflow, `${label} horizontal overflow detected`);
  assert(consoleErrors.length === 0, `${label} console errors: ${consoleErrors.join('; ')}`);
  assert(pageErrors.length === 0, `${label} page errors: ${pageErrors.join('; ')}`);
  assert(externalRequests.length === 0, `${label} external requests: ${externalRequests.join('; ')}`);

  await context.close();
  return { label, status: 200, consoleErrors: 0, pageErrors: 0, externalRequests: 0, overflow: false };
}

async function runHabitPetFlowAndCapture(browser, baseUrl) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const externalRequests = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('request', (req) => {
    const u = req.url();
    if (!u.startsWith('http://127.0.0.1') && !u.startsWith('data:') && !u.startsWith('blob:')) {
      externalRequests.push(u);
    }
  });

  await page.goto(`${baseUrl}/habit-pet-board/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);

  // Screenshot 1: Initial Stage 1 Egg + Pet Card
  await page.screenshot({ path: path.join(TMP_DIR, 'pet_stage1.png') });

  // Flow 1: Complete tasks -> stars increment & pet evolves
  const initialStage = await page.locator('#petStageTitle').textContent();
  assert(initialStage.includes('Lv.1'), `Expected initial stage Lv.1, got ${initialStage}`);

  // Complete 5 default tasks (3+2+1+2+3 = 11 stars -> evolves to Lv.2!)
  const taskLefts = page.locator('.task-item .task-left');
  const count = await taskLefts.count();
  assert(count === 6, `Expected 6 default tasks, got ${count}`);
  for (let i = 0; i < 5; i++) {
    await taskLefts.nth(i).click();
  }
  await page.waitForTimeout(250);
  let totalStars = Number(await page.locator('#topTotalStars').textContent());
  let stageAfterTasks = await page.locator('#petStageTitle').textContent();
  assert(totalStars === 11, `Expected 11 stars after 5 tasks, got ${totalStars}`);
  assert(stageAfterTasks.includes('Lv.2'), `Expected evolution to Lv.2, got ${stageAfterTasks}`);

  // Add a custom +5 star task & complete across days to reach Lv.3 (30+ stars)
  await page.fill('#newTaskTitle', '坚持练琴 20分钟');
  await page.selectOption('#newTaskStars', '5');
  await page.click('#addTaskForm button[type="submit"]');
  await page.locator('.task-item .task-left').last().click(); // +5 => 16
  await page.click('#advanceDayBtn'); // Day 2
  for (let i = 0; i < 5; i++) {
    await page.locator('.task-item .task-left').nth(i).click(); // +11 => 27
  }
  await page.click('#advanceDayBtn'); // Day 3
  await page.locator('.task-item .task-left').nth(0).click(); // +3 => 30 -> Lv.3!
  await page.locator('.task-item .task-left').nth(1).click(); // +2 => 32
  await page.waitForTimeout(250);

  stageAfterTasks = await page.locator('#petStageTitle').textContent();
  assert(stageAfterTasks.includes('Lv.3'), `Expected evolution to Lv.3, got ${stageAfterTasks}`);

  // Flow 2: Start/Pause/Reset Timer + Complete Focus Session
  await page.click('#timerStartPauseBtn');
  await page.waitForTimeout(1150);
  const clockAfter1s = await page.locator('#timerClock').textContent();
  assert(clockAfter1s !== '05:00', `Timer did not tick down, still ${clockAfter1s}`);
  await page.click('#timerStartPauseBtn'); // Pause
  await page.click('#timerResetBtn');
  assert((await page.locator('#timerClock').textContent()) === '05:00', 'Timer reset failed');
  await page.click('#timerFinishDemoBtn'); // Complete session (+1 star -> 33)
  totalStars = Number(await page.locator('#topTotalStars').textContent());
  assert(totalStars === 33, `Expected 33 stars after timer completion, got ${totalStars}`);

  // Screenshot 2: Evolved Pet & Matrix
  await page.locator('#petSection').scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(TMP_DIR, 'pet_evolved.png') });

  // Flow 3: Wish Shop redemption (deduct spendable, keep totalStarsEarned)
  const spendBefore = Number(await page.locator('#topSpendableStars').textContent());
  await page.locator('.shop-item .redeem-btn').first().click(); // 12 stars
  const spendAfter = Number(await page.locator('#topSpendableStars').textContent());
  assert(spendAfter === spendBefore - 12, `Expected spendable ${spendBefore - 12}, got ${spendAfter}`);
  assert(Number(await page.locator('#topTotalStars').textContent()) === 33, 'Total stars should not drop after redemption');
  const histText = await page.locator('#redeemHistoryList').textContent();
  assert(histText.includes('周末公园放风'), 'Redemption history missing item');

  // Screenshot 3: Wish Shop + Timer view
  await page.locator('#shopSection').scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(TMP_DIR, 'pet_shop_timer.png') });

  // Flow 4: Persistence check across reload
  await page.reload({ waitUntil: 'networkidle' });
  assert(Number(await page.locator('#topTotalStars').textContent()) === 33, 'localStorage persistence failed after reload');

  // Flow 5: PNG Certificate export
  await page.fill('#childNameInput', '星宝同学');
  await page.click('#exportCertBtn');
  await page.waitForTimeout(300);
  const certUrl = await page.evaluate(() => window.__lastCertPngDataUrl || '');
  assert(certUrl.startsWith('data:image/png;base64,') && certUrl.length > 5000, 'Certificate PNG dataUrl invalid or empty');

  // Save the actual 1080x1440 exported certificate PNG for video showcase
  const b64 = certUrl.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(path.join(TMP_DIR, 'pet_cert_1080x1440.png'), Buffer.from(b64, 'base64'));
  await page.screenshot({ path: path.join(TMP_DIR, 'pet_cert_modal.png') });

  assert(consoleErrors.length === 0, `HabitPet console errors: ${consoleErrors.join('; ')}`);
  assert(pageErrors.length === 0, `HabitPet page errors: ${pageErrors.join('; ')}`);
  assert(externalRequests.length === 0, `HabitPet external requests: ${externalRequests.join('; ')}`);

  await context.close();
  return { totalStarsAfterFlow: 33, stageAfterTasks, spendAfter, certBase64Len: b64.length };
}

async function captureOtherProductShots(browser, baseUrl) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();

  // 1. kids-science-lab
  await page.goto(`${baseUrl}/kids-science-lab/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(TMP_DIR, 'science_mobile.png') });

  // 2. focus-parenting-kit
  await page.goto(`${baseUrl}/focus-parenting-kit/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(TMP_DIR, 'focus_mobile.png') });

  // 3. story-adventure
  await page.goto(`${baseUrl}/story-adventure/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(TMP_DIR, 'story_mobile.png') });

  await context.close();
}

function imgDataUri(filePath) {
  const buf = fs.readFileSync(filePath);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

async function renderHtmlPng(browser, html, width, height, outPath) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForTimeout(150);
  await page.screenshot({ path: outPath });
  await context.close();
}

async function generateCoversAndVideoFrames(browser) {
  const s1 = imgDataUri(path.join(TMP_DIR, 'pet_stage1.png'));
  const sEvo = imgDataUri(path.join(TMP_DIR, 'pet_evolved.png'));
  const sShop = imgDataUri(path.join(TMP_DIR, 'pet_shop_timer.png'));
  const sCert = imgDataUri(path.join(TMP_DIR, 'pet_cert_1080x1440.png'));
  const sSci = imgDataUri(path.join(TMP_DIR, 'science_mobile.png'));
  const sFoc = imgDataUri(path.join(TMP_DIR, 'focus_mobile.png'));
  const sSto = imgDataUri(path.join(TMP_DIR, 'story_mobile.png'));

  const baseCss = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      overflow: hidden;
    }
    .phone {
      background: #0f172a;
      border-radius: 42px;
      padding: 12px;
      box-shadow: 0 28px 64px rgba(15, 23, 42, 0.36);
      border: 4px solid rgba(255,255,255,0.28);
    }
    .phone img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: cover;
      object-position: top center;
      border-radius: 30px;
    }
  `;

  // Cover 07: habit-pet-board main (1080x1440)
  await renderHtmlPng(browser, `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    ${baseCss}
    body {
      width: 1080px; height: 1440px;
      background: linear-gradient(155deg, #312e81 0%, #5b21b6 48%, #d97706 100%);
      color: #fff; padding: 54px 52px; display: flex; flex-direction: column; justify-content: space-between;
    }
    .pill { display: inline-block; background: #fde047; color: #78350f; font-size: 26px; font-weight: 900; padding: 10px 26px; border-radius: 999px; margin-bottom: 18px; }
    h1 { font-size: 70px; font-weight: 900; line-height: 1.15; letter-spacing: -1px; text-shadow: 0 6px 18px rgba(0,0,0,0.25); }
    .sub { margin-top: 16px; font-size: 31px; color: #fef3c7; font-weight: 700; }
    .stage-row { display: flex; gap: 14px; margin-top: 24px; }
    .chip { background: rgba(255,255,255,0.16); border: 1.5px solid rgba(255,255,255,0.32); border-radius: 18px; padding: 12px 18px; font-size: 24px; font-weight: 800; }
    .showcase { display: flex; gap: 28px; align-items: center; justify-content: center; margin: 18px 0; }
    .phone-main { width: 455px; height: 820px; transform: rotate(-2deg); }
    .side-col { display: flex; flex-direction: column; gap: 22px; width: 470px; }
    .cert-card { background: #fff; padding: 12px; border-radius: 26px; box-shadow: 0 22px 46px rgba(0,0,0,0.28); transform: rotate(2deg); }
    .cert-card img { width: 100%; height: 480px; object-fit: cover; border-radius: 16px; }
    .feat-box { background: rgba(15, 23, 42, 0.45); border: 2px solid rgba(253, 224, 71, 0.5); border-radius: 24px; padding: 22px 24px; font-size: 25px; line-height: 1.55; font-weight: 700; }
    .footer-bar { background: #fff; color: #1e293b; border-radius: 24px; padding: 20px 28px; display: flex; justify-content: space-between; align-items: center; font-size: 27px; font-weight: 900; }
    .price { background: #e11d48; color: #fff; padding: 10px 26px; border-radius: 999px; font-size: 32px; }
  </style></head><body>
    <div>
      <span class="pill">🔥 4-12岁催作业救星 · 纯离线单文件HTML</span>
      <h1>21天自律小怪兽<br>打卡进化积分墙 👾</h1>
      <div class="sub">写作业攒星星 · 5阶进化银河星龙 · 愿望商店兑换</div>
      <div class="stage-row">
        <div class="chip">🥚5阶神兽进化</div>
        <div class="chip">⏱️专注倒计时</div>
        <div class="chip">🏆奖状PNG导出</div>
      </div>
    </div>
    <div class="showcase">
      <div class="phone phone-main"><img src="${sEvo}"></div>
      <div class="side-col">
        <div class="cert-card"><img src="${sCert}"></div>
        <div class="feat-box">
          ✅ 6大好习惯 + 家长自定义星值<br>
          ✅ 消费积分兑换不降进化等级<br>
          ✅ 断网可用 · 无广告 · 本地保存
        </div>
      </div>
    </div>
    <div class="footer-bar">
      <span>📱 手机 / iPad / 电脑 点开浏览器秒用</span>
      <span class="price">单品仅 ¥9.9</span>
    </div>
  </body></html>`, 1080, 1440, path.join(COVERS_DIR, 'cover_07_habit_pet_main.png'));

  // Cover 08: 4-in-1 bundle (1080x1440)
  await renderHtmlPng(browser, `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    ${baseCss}
    body {
      width: 1080px; height: 1440px;
      background: linear-gradient(155deg, #0f172a 0%, #1e1b4b 45%, #0f766e 100%);
      color: #fff; padding: 50px 48px; display: flex; flex-direction: column; justify-content: space-between;
    }
    .pill { display: inline-block; background: linear-gradient(90deg, #f59e0b, #ef4444); color: #fff; font-size: 26px; font-weight: 900; padding: 10px 26px; border-radius: 999px; margin-bottom: 14px; }
    h1 { font-size: 64px; font-weight: 900; line-height: 1.15; }
    .sub { margin-top: 12px; font-size: 29px; color: #fde68a; font-weight: 700; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; margin: 18px 0; }
    .tile { background: rgba(255,255,255,0.1); border: 2px solid rgba(255,255,255,0.22); border-radius: 28px; padding: 18px; display: flex; flex-direction: column; gap: 12px; }
    .tile-title { font-size: 26px; font-weight: 900; color: #fff; }
    .tile-sub { font-size: 20px; color: #cbd5e1; font-weight: 600; }
    .tile img { width: 100%; height: 340px; object-fit: cover; object-position: top center; border-radius: 18px; border: 2px solid rgba(255,255,255,0.28); }
    .price-banner { background: linear-gradient(135deg, #fffbeb, #fef3c7); color: #78350f; border: 4px solid #f59e0b; border-radius: 28px; padding: 22px 28px; display: flex; justify-content: space-between; align-items: center; }
    .p-left strong { display: block; font-size: 32px; font-weight: 900; }
    .p-left span { font-size: 22px; font-weight: 700; color: #92400e; }
    .p-badge { background: #b45309; color: #fff; padding: 14px 28px; border-radius: 18px; font-size: 34px; font-weight: 900; }
  </style></head><body>
    <div>
      <span class="pill">🎁 4-12岁家庭成长全套 · 永久离线买断</span>
      <h1>科普·专注·双语·自律<br>四合一互动数字全家桶</h1>
      <div class="sub">4个纯离线单文件 HTML · 零广告零会员 · 手机/iPad秒开</div>
    </div>
    <div class="grid">
      <div class="tile">
        <div><div class="tile-title">👾 21天自律小怪兽</div><div class="tile-sub">5阶进化 + 倒计时 + 愿望商店</div></div>
        <img src="${sEvo}">
      </div>
      <div class="tile">
        <div><div class="tile-title">🚀 星际小科学家</div><div class="tile-sub">太阳系 + 心脏双循环 + 齿轮</div></div>
        <img src="${sSci}">
      </div>
      <div class="tile">
        <div><div class="tile-title">🎯 舒尔特 + 24题测评</div><div class="tile-sub">专注力评级 + 7天教养方案</div></div>
        <img src="${sFoc}">
      </div>
      <div class="tile">
        <div><div class="tile-title">🧭 双语思维冒险</div><div class="tile-sub">15分支抉择 + 4大结局 + 伴读</div></div>
        <img src="${sSto}">
      </div>
    </div>
    <div class="price-banner">
      <div class="p-left">
        <strong>单品 ¥9.9 ｜ 三合一 ¥19.9 ｜ VIP定制 ¥39.9</strong>
        <span>原价 ¥39.6 四套全打包，今天一次全部带回家！</span>
      </div>
      <div class="p-badge">四合一 ¥24.9</div>
    </div>
  </body></html>`, 1080, 1440, path.join(COVERS_DIR, 'cover_08_bundle_4in1.png'));

  // Video 1 Scenes (1080x1920): 6 scenes
  const v1Scenes = [
    {
      badge: '🔥 宝妈带娃自救神器',
      title: '戒掉吼娃催写作业！<br>把自律做成养怪兽游戏',
      desc: '4-12岁专用 · 21天自律小怪兽打卡积分墙',
      bg: 'linear-gradient(160deg, #312e81 0%, #6d28d9 60%, #d97706 100%)',
      img: s1,
      caption: '✨ 完成作业攒星星，唤醒神秘星光蛋！'
    },
    {
      badge: 'STEP 1 · 每日习惯任务板',
      title: '6大好习惯 + 自定义星值<br>写完作业自己主动勾',
      desc: '作业专注 / 自主阅读 / 刷牙 / 整理书包 / 运动 / 复盘',
      bg: 'linear-gradient(160deg, #1e1b4b 0%, #4338ca 65%, #0ea5e9 100%)',
      img: s1,
      caption: '✅ 每项奖励 +1 到 +5 颗星，音效超治愈'
    },
    {
      badge: 'STEP 2 · 5阶神兽自动进化',
      title: '累计星力自动进化！<br>一路升级成银河星龙王',
      desc: '星光蛋 → 萌芽兽 → 花蕾兽 → 星盾兽 → 银河星龙',
      bg: 'linear-gradient(160deg, #4c1d95 0%, #7c3aed 55%, #f59e0b 100%)',
      img: sEvo,
      caption: '🐉 消费积分兑礼物，绝不降进化等级！'
    },
    {
      badge: 'STEP 3 · 倒计时 + 愿望商店',
      title: '自带 5/15/25 分钟倒计时<br>攒星星换公园放风/盲盒',
      desc: '倒计时结束自动发星 · 兑换记录清晰可查',
      bg: 'linear-gradient(160deg, #065f46 0%, #0d9488 55%, #4f46e5 100%)',
      img: sShop,
      caption: '🎁 让孩子真正懂得延迟满足与目标管理'
    },
    {
      badge: 'STEP 4 · 晒圈荣誉奖状',
      title: '21天连续打卡矩阵<br>一键导出高清荣誉奖状',
      desc: '1080×1440 高清红印章 PNG · 发家族群超有面子',
      bg: 'linear-gradient(160deg, #78350f 0%, #d97706 55%, #4f46e5 100%)',
      img: sCert,
      caption: '🏆 支持手机保存相册 & A4 直接打印'
    },
    {
      badge: '📦 100% 纯离线单文件 HTML',
      title: '不用下 App · 无广告<br>手机 iPad 电脑断网秒开',
      desc: '单品 ¥9.9 · 四合一全家桶 ¥24.9 · VIP定制 ¥39.9',
      bg: 'linear-gradient(160deg, #0f172a 0%, #312e81 55%, #7c3aed 100%)',
      img: sEvo,
      caption: '👇 评论区扣【小怪兽】或进店直接带走'
    }
  ];

  for (let i = 0; i < v1Scenes.length; i++) {
    const sc = v1Scenes[i];
    await renderHtmlPng(browser, `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      ${baseCss}
      body {
        width: 1080px; height: 1920px; background: ${sc.bg}; color: #fff;
        padding: 120px 64px 110px; display: flex; flex-direction: column; justify-content: space-between; align-items: center; text-align: center;
      }
      .badge { display: inline-block; background: #fde047; color: #78350f; font-size: 30px; font-weight: 900; padding: 12px 30px; border-radius: 999px; margin-bottom: 24px; }
      h1 { font-size: 64px; font-weight: 900; line-height: 1.22; text-shadow: 0 8px 24px rgba(0,0,0,0.28); }
      .desc { margin-top: 18px; font-size: 30px; color: #fef3c7; font-weight: 700; }
      .frame-wrap { width: 590px; height: 1060px; display: flex; align-items: center; justify-content: center; }
      .phone-box { width: 560px; height: 1040px; }
      .caption { background: rgba(15, 23, 42, 0.56); border: 2px solid rgba(255,255,255,0.3); border-radius: 24px; padding: 22px 34px; font-size: 32px; font-weight: 800; color: #fff; width: 100%; }
    </style></head><body>
      <div>
        <span class="badge">${sc.badge}</span>
        <h1>${sc.title}</h1>
        <div class="desc">${sc.desc}</div>
      </div>
      <div class="frame-wrap"><div class="phone phone-box"><img src="${sc.img}"></div></div>
      <div class="caption">${sc.caption}</div>
    </body></html>`, 1080, 1920, path.join(TMP_DIR, 'video1', `scene_${i + 1}.png`));
  }

  // Video 2 Scenes (1080x1920): 6 scenes (4-in-1 Bundle Tour)
  const v2Scenes = [
    {
      badge: '🎁 4-12岁宝妈省钱指南',
      title: '别再每年几百充会员！<br>四合一纯离线神器打包带走',
      desc: '科学启蒙 × 专注力 × 双语冒险 × 21天自律',
      bg: 'linear-gradient(160deg, #0f172a 0%, #312e81 55%, #0f766e 100%)',
      img: sSci,
      caption: '📦 4个独立单文件 HTML，永久存自己设备！'
    },
    {
      badge: '第 1 套 · 《星际小科学家》',
      title: '太阳系八大行星公转<br>心脏双循环 + 机械齿轮',
      desc: '自带中文语音播报 + 10题闯关领红印章奖状',
      bg: 'linear-gradient(160deg, #1e1b4b 0%, #4f46e5 65%, #0284c7 100%)',
      img: sSci,
      caption: '🚀 替代吃灰实体实验箱，边点边听超直观'
    },
    {
      badge: '第 2 套 · 《专注力与亲子测评》',
      title: '色彩干扰舒尔特方格<br>24题教养雷达 + 7天方案',
      desc: '按年龄自动 S/A/B/C 评级 + 一键导出长图报告',
      bg: 'linear-gradient(160deg, #115e59 0%, #0d9488 65%, #0284c7 100%)',
      img: sFoc,
      caption: '🎯 每天3分钟热身，告别写作业走神拖拉'
    },
    {
      badge: '第 3 套 · 《双语思维冒险》',
      title: '15个高情商与逻辑分支<br>中英秒切换 + 4大结局',
      desc: '好奇心/共情力/逻辑力实时记录 + 语音伴读',
      bg: 'linear-gradient(160deg, #78350f 0%, #d97706 60%, #e11d48 100%)',
      img: sSto,
      caption: '🧭 孩子当主角拍板剧情，每晚主动求共读'
    },
    {
      badge: '第 4 套 · 《21天自律小怪兽》',
      title: '写作业攒星进化银河龙<br>倒计时 + 愿望商店 + 奖状',
      desc: '每日打卡全自动记录，让自律变成孩子期待的游戏',
      bg: 'linear-gradient(160deg, #4c1d95 0%, #7c3aed 60%, #f59e0b 100%)',
      img: sEvo,
      caption: '👾 高频每日留存，真正治好陪读内耗！'
    },
    {
      badge: '🔥 限时阶梯特惠 · 买断永久用',
      title: '单品 ¥9.9 · 三合一 ¥19.9<br>四合一全家桶仅 ¥24.9！',
      desc: '另有 VIP 家庭伴学定制版 ¥39.9（含专属署名）',
      bg: 'linear-gradient(160deg, #1e1b4b 0%, #92400e 55%, #b45309 100%)',
      img: sCert,
      caption: '👇 评论区扣【四合一】或进店下单秒发教程'
    }
  ];

  for (let i = 0; i < v2Scenes.length; i++) {
    const sc = v2Scenes[i];
    await renderHtmlPng(browser, `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      ${baseCss}
      body {
        width: 1080px; height: 1920px; background: ${sc.bg}; color: #fff;
        padding: 120px 64px 110px; display: flex; flex-direction: column; justify-content: space-between; align-items: center; text-align: center;
      }
      .badge { display: inline-block; background: #fde047; color: #78350f; font-size: 30px; font-weight: 900; padding: 12px 30px; border-radius: 999px; margin-bottom: 24px; }
      h1 { font-size: 62px; font-weight: 900; line-height: 1.22; text-shadow: 0 8px 24px rgba(0,0,0,0.28); }
      .desc { margin-top: 18px; font-size: 30px; color: #fef3c7; font-weight: 700; }
      .frame-wrap { width: 590px; height: 1060px; display: flex; align-items: center; justify-content: center; }
      .phone-box { width: 560px; height: 1040px; }
      .caption { background: rgba(15, 23, 42, 0.56); border: 2px solid rgba(255,255,255,0.3); border-radius: 24px; padding: 22px 34px; font-size: 32px; font-weight: 800; color: #fff; width: 100%; }
    </style></head><body>
      <div>
        <span class="badge">${sc.badge}</span>
        <h1>${sc.title}</h1>
        <div class="desc">${sc.desc}</div>
      </div>
      <div class="frame-wrap"><div class="phone phone-box"><img src="${sc.img}"></div></div>
      <div class="caption">${sc.caption}</div>
    </body></html>`, 1080, 1920, path.join(TMP_DIR, 'video2', `scene_${i + 1}.png`));
  }
}

async function main() {
  const { server, port } = await startServer();
  const baseUrl = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true
  });

  try {
    const audits = [];
    audits.push(await auditRoute(browser, baseUrl, '/', { width: 1440, height: 900 }, 'index desktop'));
    audits.push(await auditRoute(browser, baseUrl, '/', { width: 390, height: 844 }, 'index mobile'));
    audits.push(await auditRoute(browser, baseUrl, '/habit-pet-board/', { width: 1440, height: 900 }, 'habit-pet-board desktop'));
    audits.push(await auditRoute(browser, baseUrl, '/habit-pet-board/', { width: 390, height: 844 }, 'habit-pet-board mobile'));
    audits.push(await auditRoute(browser, baseUrl, '/kids-science-lab/', { width: 390, height: 844 }, 'kids-science-lab mobile'));
    audits.push(await auditRoute(browser, baseUrl, '/focus-parenting-kit/', { width: 390, height: 844 }, 'focus-parenting-kit mobile'));
    audits.push(await auditRoute(browser, baseUrl, '/story-adventure/', { width: 390, height: 844 }, 'story-adventure mobile'));

    const flowResult = await runHabitPetFlowAndCapture(browser, baseUrl);
    await captureOtherProductShots(browser, baseUrl);
    await generateCoversAndVideoFrames(browser);

    console.log(JSON.stringify({ ok: true, audits, flowResult }, null, 2));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
