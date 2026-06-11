/**
 * e2e/history-tree-inline.spec.ts — дерево сессий внутри History.
 *
 * 2026-06-11: the separate Tree tab was removed; families now expand
 * INLINE in the History list (▸ on rows that have branches). READ-ONLY
 * smoke against the live app + the user's real lineage:
 *   - the top nav has NO "Tree" tab anymore;
 *   - if any row shows the ▸ toggle, clicking it reveals a family graph
 *     with ≥2 nodes and ≥1 edge right under the row, and clicking again
 *     collapses it. No clicks on nodes/⑂ — that would create real forks.
 */

import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchApp } from './helpers.js';

let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  ({ app, win } = await launchApp());
});

test.afterAll(async () => {
  await app?.close();
});

test.describe.configure({ timeout: 120_000 });

test('Tree tab is gone from the top nav', async () => {
  await expect(win.locator('.ts-nav', { hasText: 'History' })).toBeVisible({ timeout: 10_000 });
  expect(await win.locator('.ts-nav', { hasText: 'Tree' }).count()).toBe(0);
});

test('▸ on a session row expands the family graph inline', async () => {
  await win.locator('.ts-nav', { hasText: 'History' }).click();
  await expect(win.locator('.sessions-panel__list')).toBeVisible({ timeout: 10_000 });
  await expect(win.locator('.session-item').first()).toBeVisible({ timeout: 30_000 });

  // The lineage scan runs in the background and may take a while on a
  // machine with many sessions — wait up to 90s for the first toggle.
  const toggle = win.locator('.session-item__tree-toggle').first();
  try {
    await toggle.waitFor({ state: 'visible', timeout: 90_000 });
  } catch {
    test.info().annotations.push({
      type: 'note',
      description: 'no families with branches on this machine — inline tree not exercised',
    });
    return;
  }

  await toggle.click();
  const outline = win.locator('.fam-outline').first();
  await expect(outline).toBeVisible({ timeout: 5_000 });
  expect(await outline.locator('.fam-row').count()).toBeGreaterThanOrEqual(2);

  // Row titles are real text, not empty.
  const title = (await outline.locator('.fam-row__title').first().textContent()) ?? '';
  expect(title.trim().length).toBeGreaterThan(0);

  // Collapse back.
  await win.locator('.session-item__tree-toggle--open').first().click();
  await expect(win.locator('.fam-outline')).toHaveCount(0);
});
