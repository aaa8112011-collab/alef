import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const root = new URL('../', import.meta.url);

/** Start the real DOM adapter against the isolated local fixture, without website credentials. */
export async function createBrowserHarness({ scenario = '' } = {}) {
  const fixture = await readFile(new URL('test/fixtures/alef.html', root));
  const contentScript = await readFile(new URL('extension/content.js', root), 'utf8');
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(fixture);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let browser;
  try {
    browser = await chromium.launch({
      ...(process.env.CHROMIUM_PATH || existsSync('/usr/bin/chromium')
        ? { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' }
        : {}),
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage({ locale: 'ar-AE' });
    await page.goto(`http://127.0.0.1:${server.address().port}/?scenario=${encodeURIComponent(scenario)}`);
    await page.evaluate(() => {
      window.__extensionListeners = [];
      window.chrome = {
        runtime: {
          id: 'fixture-extension',
          onMessage: { addListener(listener) { window.__extensionListeners.push(listener); } },
          sendMessage() { return Promise.resolve(); },
        },
      };
      window.__dispatchExtension = async message => {
        for (const listener of window.__extensionListeners) {
          let replied = false;
          let resolveReply;
          const reply = new Promise(resolve => { resolveReply = resolve; });
          const returned = listener(message, { id: 'fixture-extension', tab: { id: 1 } }, value => {
            replied = true;
            resolveReply(value);
          });
          if (returned === true) return await Promise.race([
            reply,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Content message timed out: ' + message.type)), 7000)),
          ]);
          if (returned && typeof returned.then === 'function') return await returned;
          if (replied) return await reply;
        }
        throw new Error('No content-script handler accepted ' + message.type);
      };
    });
    await page.addScriptTag({ content: contentScript });
    return {
      page,
      contentScript,
      send(message) { return page.evaluate(value => window.__dispatchExtension(value), message); },
      async close() {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
      },
    };
  } catch (error) {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const child = spawn(process.execPath, ['--test', 'test/extension.test.mjs'], {
    cwd: fileURLToPath(root),
    stdio: 'inherit',
    env: process.env,
  });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
