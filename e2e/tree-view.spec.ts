/**
 * e2e/tree-view.spec.ts — вкладка Tree (вариант 1В).
 *
 * READ-ONLY smoke against the live app + the user's real session
 * lineage: the Tree nav opens the view, and it either renders ≥1
 * family graph (each with ≥2 nodes — singletons are excluded by the
 * main process) or the honest empty state. No clicks on nodes/⑂ —
 * that would create real forks in the user's data.
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

test('Tree tab renders family graphs or the empty state', async () => {
  await win.locator('.ts-nav', { hasText: 'Tree' }).click();
  await expect(win.locator('.tree-view')).toBeVisible({ timeout: 5_000 });

  // Lineage reconstruction reads every JSONL head — give it time.
  await win
    .locator('.tree-family, .tree-view__empty')
    .first()
    .waitFor({ state: 'visible', timeout: 90_000 });

  const families = win.locator('.tree-family');
  const count = await families.count();
  if (count === 0) {
    await expect(win.locator('.tree-view__empty')).toBeVisible();
    test.info().annotations.push({ type: 'note', description: 'no families on this machine' });
    return;
  }

  // Every family graph must have at least 2 nodes (root + a branch) and
  // at least 1 edge connecting them.
  const first = families.first();
  expect(await first.locator('.tree-node').count()).toBeGreaterThanOrEqual(2);
  expect(await first.locator('.tree-edge').count()).toBeGreaterThanOrEqual(1);

  // Node labels are real text, not raw uuids only.
  const label = (await first.locator('.tree-node__label').first().textContent()) ?? '';
  expect(label.trim().length).toBeGreaterThan(0);

  // Search narrows the list (type something that matches nothing).
  await win.locator('.tree-view__search').fill('zzz-no-such-family-xyz');
  await win.waitForTimeout(300);
  expect(await win.locator('.tree-family').count()).toBe(0);
  await win.locator('.tree-view__search').fill('');
});
