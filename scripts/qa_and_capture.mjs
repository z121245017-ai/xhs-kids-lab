import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '..');
const TMP_DIR = path.join(ROOT, 'scripts', '.tmp_assets');
const COVERS_DIR = path.join(ROOT, 'xhs_launch_kit', 'covers');
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const QA_ONLY = process.argv.includes('--qa-only');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json'
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

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

class CDPClient {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      } else if (msg.method) {
        const list = this.listeners.get(msg.method);
        if (list) for (const fn of list) fn(msg.params);
      }
    });
  }

  static async connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => reject(new Error(`CDP connect timeout: ${wsUrl}`)), 10000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CDPClient(ws));
      });
      ws.addEventListener('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function launchChrome() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-qa-chrome-'));
  const port = 19222 + Math.floor(Math.random() * 10000);
  const proc = spawn(CHROME_PATH, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--metrics-recording-only',
    '--mute-audio',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank'
  ], { stdio: 'ignore' });

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${base}/json/version`);
      if (res.ok) { ready = true; break; }
    } catch {}
    await sleep(150);
  }
  if (!ready) {
    proc.kill('SIGKILL');
    fs.rmSync(userDataDir, { recursive: true, force: true });
    throw new Error('Headless Chrome CDP failed to start');
  }

  return {
    base,
    async newPage({ width, height, deviceScaleFactor = 2 }) {
      const target = await (await fetch(`${base}/json/new?about:blank`, { method: 'PUT' })).json();
      const cdp = await CDPClient.connect(target.webSocketDebuggerUrl);
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Network.enable');
      await cdp.send('Log.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor,
        mobile: width <= 500
      });

      const consoleErrors = [];
      const pageErrors = [];
      const externalRequests = [];
      let mainStatus = null;

      cdp.on('Runtime.consoleAPICalled', (p) => {
        if (p.type === 'error') {
          const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
          consoleErrors.push(text);
        }
      });
      cdp.on('Runtime.exceptionThrown', (p) => {
        pageErrors.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || 'exception');
      });
      cdp.on('Log.entryAdded', (p) => {
        if (p.entry?.level === 'error') consoleErrors.push(p.entry.text || 'log error');
      });
      cdp.on('Network.requestWillBeSent', (p) => {
        const u = p.request?.url || '';
        if (u && !u.startsWith('http://127.0.0.1') && !u.startsWith('data:') && !u.startsWith('blob:') && !u.startsWith('about:')) {
          externalRequests.push(u);
        }
      });
      cdp.on('Network.responseReceived', (p) => {
        if (p.type === 'Document' && mainStatus === null) {
          mainStatus = p.response?.status ?? null;
        }
      });

      return {
        cdp,
        targetId: target.id,
        consoleErrors,
        pageErrors,
        externalRequests,
        getMainStatus: () => mainStatus,
        async goto(url) {
          mainStatus = null;
          let loaded = false;
          const loadPromise = new Promise((res) => {
            cdp.on('Page.loadEventFired', () => {
              if (!loaded) { loaded = true; res(); }
            });
          });
          await cdp.send('Page.navigate', { url });
          await Promise.race([loadPromise, sleep(8000)]);
          await sleep(250);
          return mainStatus;
        },
        async eval(expr) {
          const r = await cdp.send('Runtime.evaluate', {
            expression: `(async () => { return (${expr}); })()`,
            awaitPromise: true,
            returnByValue: true
          });
          if (r.exceptionDetails) {
            throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
          }
          return r.result?.value;
        },
        async screenshot(outPath) {
          const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
          fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
        },
        async setContent(html) {
          const { frameTree } = await cdp.send('Page.getFrameTree');
          await cdp.send('Page.setDocumentContent', { frameId: frameTree.frame.id, html });
          await sleep(200);
        },
        async close() {
          cdp.close();
          try { await fetch(`${base}/json/close/${target.id}`); } catch {}
        }
      };
    },
    async close() {
      proc.kill('SIGTERM');
      await sleep(200);
      try { proc.kill('SIGKILL'); } catch {}
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  };
}

async function auditRoute(browser, baseUrl, routePath, viewport, label) {
  const page = await browser.newPage({ ...viewport, deviceScaleFactor: 2 });
  try {
    const status = await page.goto(`${baseUrl}${routePath}`);
    assert(status === 200, `${label} HTTP status !== 200 (got ${status})`);
    const overflow = await page.eval('document.documentElement.scrollWidth > window.innerWidth + 2');
    assert(!overflow, `${label} horizontal overflow detected`);
    assert(page.consoleErrors.length === 0, `${label} console errors: ${page.consoleErrors.join('; ')}`);
    assert(page.pageErrors.length === 0, `${label} page errors: ${page.pageErrors.join('; ')}`);
    assert(page.externalRequests.length === 0, `${label} external requests: ${page.externalRequests.join('; ')}`);
    return { label, status: 200, consoleErrors: 0, pageErrors: 0, externalRequests: 0, overflow: false };
  } finally {
    await page.close();
  }
}

async function runHabitPetFlow(browser, baseUrl, captureShots) {
  const page = await browser.newPage({ width: 390, height: 844, deviceScaleFactor: 2 });
  try {
    await page.goto(`${baseUrl}/habit-pet-board/`);
    await page.eval('localStorage.clear()');
    await page.goto(`${baseUrl}/habit-pet-board/`);
    await sleep(250);
    if (captureShots) await page.screenshot(path.join(TMP_DIR, 'pet_stage1.png'));

    const initialStage = await page.eval('document.querySelector("#petStageTitle")?.textContent || ""');
    assert(initialStage.includes('Lv.1'), `Expected initial stage Lv.1, got ${initialStage}`);

    const taskCount = await page.eval('document.querySelectorAll(".task-item .task-left").length');
    assert(taskCount === 6, `Expected 6 default tasks, got ${taskCount}`);

    await page.eval(`(() => {
      const items = document.querySelectorAll('.task-item .task-left');
      for (let i = 0; i < 5; i++) items[i].click();
    })()`);
    await sleep(200);
    let totalStars = await page.eval('Number(document.querySelector("#topTotalStars").textContent)');
    let stage = await page.eval('document.querySelector("#petStageTitle").textContent');
    assert(totalStars === 11, `Expected 11 stars after 5 tasks, got ${totalStars}`);
    assert(stage.includes('Lv.2'), `Expected Lv.2, got ${stage}`);

    await page.eval(`(() => {
      document.querySelector('#newTaskTitle').value = '坚持练琴 20分钟';
      document.querySelector('#newTaskStars').value = '5';
      document.querySelector('#addTaskForm button[type="submit"]').click();
      const all = document.querySelectorAll('.task-item .task-left');
      all[all.length - 1].click();
      document.querySelector('#advanceDayBtn').click();
      for (let i = 0; i < 5; i++) document.querySelectorAll('.task-item .task-left')[i].click();
      document.querySelector('#advanceDayBtn').click();
      document.querySelectorAll('.task-item .task-left')[0].click();
      document.querySelectorAll('.task-item .task-left')[1].click();
    })()`);
    await sleep(200);
    stage = await page.eval('document.querySelector("#petStageTitle").textContent');
    assert(stage.includes('Lv.3'), `Expected Lv.3, got ${stage}`);

    await page.eval('document.querySelector("#timerStartPauseBtn").click()');
    await sleep(1150);
    const clockAfter1s = await page.eval('document.querySelector("#timerClock").textContent');
    assert(clockAfter1s !== '05:00', `Timer did not tick down, still ${clockAfter1s}`);
    await page.eval(`(() => {
      document.querySelector('#timerStartPauseBtn').click();
      document.querySelector('#timerResetBtn').click();
    })()`);
    assert((await page.eval('document.querySelector("#timerClock").textContent')) === '05:00', 'Timer reset failed');
    await page.eval('document.querySelector("#timerFinishDemoBtn").click()');
    totalStars = await page.eval('Number(document.querySelector("#topTotalStars").textContent)');
    assert(totalStars === 33, `Expected 33 stars after timer completion, got ${totalStars}`);

    if (captureShots) {
      await page.eval('document.querySelector("#petSection").scrollIntoView()');
      await sleep(200);
      await page.screenshot(path.join(TMP_DIR, 'pet_evolved.png'));
    }

    const spendBefore = await page.eval('Number(document.querySelector("#topSpendableStars").textContent)');
    await page.eval('document.querySelector(".shop-item .redeem-btn").click()');
    const spendAfter = await page.eval('Number(document.querySelector("#topSpendableStars").textContent)');
    assert(spendAfter === spendBefore - 12, `Expected spendable ${spendBefore - 12}, got ${spendAfter}`);
    assert((await page.eval('Number(document.querySelector("#topTotalStars").textContent)')) === 33, 'Total stars dropped after redemption');
    const histText = await page.eval('document.querySelector("#redeemHistoryList").textContent');
    assert(histText.includes('周末公园放风'), 'Redemption history missing item');

    if (captureShots) {
      await page.eval('document.querySelector("#shopSection").scrollIntoView()');
      await sleep(200);
      await page.screenshot(path.join(TMP_DIR, 'pet_shop_timer.png'));
    }

    // Reload persistence
    await page.goto(`${baseUrl}/habit-pet-board/`);
    assert((await page.eval('Number(document.querySelector("#topTotalStars").textContent)')) === 33, 'localStorage persistence failed');

    // PNG Certificate export
    await page.eval(`(() => {
      document.querySelector('#childNameInput').value = '星宝同学';
      document.querySelector('#exportCertBtn').click();
    })()`);
    await sleep(300);
    const certUrl = await page.eval('window.__lastCertPngDataUrl || ""');
    assert(certUrl.startsWith('data:image/png;base64,') && certUrl.length > 5000, 'Certificate PNG dataUrl invalid');

    const b64 = certUrl.replace(/^data:image\/png;base64,/, '');
    if (captureShots) {
      fs.writeFileSync(path.join(TMP_DIR, 'pet_cert_1080x1440.png'), Buffer.from(b64, 'base64'));
      await page.screenshot(path.join(TMP_DIR, 'pet_cert_modal.png'));
    }

    assert(page.consoleErrors.length === 0, `HabitPet console errors: ${page.consoleErrors.join('; ')}`);
    assert(page.pageErrors.length === 0, `HabitPet page errors: ${page.pageErrors.join('; ')}`);
    assert(page.externalRequests.length === 0, `HabitPet external requests: ${page.externalRequests.join('; ')}`);
    return { totalStarsAfterFlow: 33, stageAfterTasks: stage, spendAfter, certBase64Len: b64.length };
  } finally {
    await page.close();
  }
}

async function runFocusParentingExportFlow(browser, baseUrl) {
  const page = await browser.newPage({ width: 390, height: 844, deviceScaleFactor: 2 });
  try {
    await page.goto(`${baseUrl}/focus-parenting-kit/`);
    const result = await page.eval(`(() => {
      const assessTab = Array.from(document.querySelectorAll('.tab-btn')).find(b => b.dataset.tab === 'assess');
      if (assessTab) assessTab.click();
      document.querySelectorAll('.q-item').forEach((card, idx) => {
        const opts = card.querySelectorAll('.likert-btn');
        if (opts.length) opts[idx % opts.length].click();
      });
      document.querySelector('#submitAssessBtn').click();
      document.querySelector('#exportLongBtn').click();
      const src = document.querySelector('#longReportImg')?.src || '';
      return {
        qCount: document.querySelectorAll('.q-item').length,
        reportVisible: document.querySelector('#reportWrap')?.classList.contains('show') === true,
        longPreviewVisible: document.querySelector('#longPreviewWrap')?.style.display === 'block',
        pngValid: src.startsWith('data:image/png;base64,') && src.length > 10000,
        pngLen: src.length
      };
    })()`);
    assert(result.qCount === 24, `Expected 24 assessment questions, got ${result.qCount}`);
    assert(result.reportVisible, 'Focus assessment report not shown');
    assert(result.longPreviewVisible && result.pngValid, `Focus long PNG export failed: ${JSON.stringify(result)}`);
    assert(page.consoleErrors.length === 0, `Focus console errors: ${page.consoleErrors.join('; ')}`);
    assert(page.pageErrors.length === 0, `Focus page errors: ${page.pageErrors.join('; ')}`);
    assert(page.externalRequests.length === 0, `Focus external requests: ${page.externalRequests.join('; ')}`);
    return result;
  } finally {
    await page.close();
  }
}

async function main() {
  if (!QA_ONLY) {
    fs.mkdirSync(path.join(TMP_DIR, 'video1'), { recursive: true });
    fs.mkdirSync(path.join(TMP_DIR, 'video2'), { recursive: true });
    fs.mkdirSync(COVERS_DIR, { recursive: true });
  }

  const { server, port } = await startServer();
  const baseUrl = `http://127.0.0.1:${port}`;
  const browser = await launchChrome();

  try {
    const audits = [];
    audits.push(await auditRoute(browser, baseUrl, '/', { width: 1440, height: 900 }, 'index desktop'));
    audits.push(await auditRoute(browser, baseUrl, '/', { width: 390, height: 844 }, 'index mobile'));
    audits.push(await auditRoute(browser, baseUrl, '/habit-pet-board/', { width: 1440, height: 900 }, 'habit-pet-board desktop'));
    audits.push(await auditRoute(browser, baseUrl, '/habit-pet-board/', { width: 390, height: 844 }, 'habit-pet-board mobile'));
    audits.push(await auditRoute(browser, baseUrl, '/kids-science-lab/', { width: 390, height: 844 }, 'kids-science-lab mobile'));
    audits.push(await auditRoute(browser, baseUrl, '/focus-parenting-kit/', { width: 390, height: 844 }, 'focus-parenting-kit mobile'));
    audits.push(await auditRoute(browser, baseUrl, '/story-adventure/', { width: 390, height: 844 }, 'story-adventure mobile'));
    audits.push(await auditRoute(browser, baseUrl, '/docs/', { width: 390, height: 844 }, 'docs/index mobile'));
    audits.push(await auditRoute(browser, baseUrl, '/docs/focus-parenting-kit/', { width: 390, height: 844 }, 'docs/focus-parenting-kit mobile'));

    const flowResult = await runHabitPetFlow(browser, baseUrl, !QA_ONLY);
    const focusExportResult = await runFocusParentingExportFlow(browser, baseUrl);

    console.log(JSON.stringify({ ok: true, mode: QA_ONLY ? 'qa-only' : 'qa+shots', audits, flowResult, focusExportResult }, null, 2));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
