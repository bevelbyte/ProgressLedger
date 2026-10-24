import { test, _electron as electron } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

async function launchApp() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'cf-e2e-explore-'));
  const app = await electron.launch({
    args: [projectRoot, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      PROGRESSLEDGER_V2_E2E: '1',
    },
  });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win };
}

test.describe('Explore Progress Ledger UI Structure', () => {
  let app;
  let win;

  test.beforeAll(async () => {
    const launched = await launchApp();
    app = launched.app;
    win = launched.win;
    await win.waitForLoadState('domcontentloaded');
    await win.waitForLoadState('networkidle');
  });

  test.afterAll(async () => {
    await app.close();
  });

  test('Explore UI structure - dump all visible elements', async () => {
    await win.waitForLoadState('networkidle');
    await win.waitForTimeout(3000);
    
    // Get all visible buttons and their text
    const buttons = await win.locator('button').all();
    console.log(`\n=== BUTTONS (${buttons.length}) ===`);
    for (const btn of buttons) {
      const text = await btn.textContent();
      const classes = await btn.getAttribute('class');
      const disabled = await btn.isDisabled();
      const visible = await btn.isVisible();
      console.log(`Button: "${text}" | class="${classes}" | disabled=${disabled} | visible=${visible}`);
    }
    
    // Get all elements with text content
    const allTextElements = await win.locator('*').all();
    console.log(`\n=== ALL TEXT ELEMENTS (${allTextElements.length}) ===`);
    for (const el of allTextElements.slice(0, 100)) {
      const text = await el.textContent();
      const tag = await el.evaluate(e => e.tagName.toLowerCase());
      const classes = await el.getAttribute('class');
      if (text && text.trim().length > 0 && text.trim().length < 50) {
        console.log(`  ${tag}.${classes || ''}: "${text.trim()}"`);
      }
    }
    
    // Look for Browser-related elements
    console.log('\n=== BROWSER-RELATED ELEMENTS ===');
    const browserElements = await win.locator('*').filter({ hasText: /browser/i }).all();
    for (const el of browserElements) {
      const text = await el.textContent();
      const tag = await el.evaluate(e => e.tagName.toLowerCase());
      const classes = await el.getAttribute('class');
      if (text && text.trim().length > 0) {
        console.log(`  ${tag}.${classes || ''}: "${text.trim()}"`);
      }
    }
    
    // Look for profile-related elements
    console.log('\n=== PROFILE-RELATED ELEMENTS ===');
    const profileElements = await win.locator('*').filter({ hasText: /profile/i }).all();
    for (const el of profileElements) {
      const text = await el.textContent();
      const tag = await el.evaluate(e => e.tagName.toLowerCase());
      const classes = await el.getAttribute('class');
      if (text && text.trim().length > 0) {
        console.log(`  ${tag}.${classes || ''}: "${text.trim()}"`);
      }
    }
    
    // Look for Donut-related elements
    console.log('\n=== DONUT-RELATED ELEMENTS ===');
    const donutElements = await win.locator('*').filter({ hasText: /donut/i }).all();
    for (const el of donutElements) {
      const text = await el.textContent();
      const tag = await el.evaluate(e => e.tagName.toLowerCase());
      const classes = await el.getAttribute('class');
      if (text && text.trim().length > 0) {
        console.log(`  ${tag}.${classes || ''}: "${text.trim()}"`);
      }
    }
    
    // Get the full body HTML for manual inspection
    const bodyHTML = await win.locator('body').innerHTML();
    console.log('\n=== FULL BODY HTML (first 10000 chars) ===');
    console.log(bodyHTML.substring(0, 10000));
  });
});

export default test;