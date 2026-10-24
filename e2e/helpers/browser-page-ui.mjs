import { expect } from "@playwright/test";

/** Open the browser surface through the Space Bunny destination menu. */
export async function openNewWebPage(scope) {
  await scope.locator('button[aria-label="New tab"]').first().click();
  await scope.getByRole("menuitem", { name: "New web page" }).click();
  await expect(scope.locator('[data-testid="browser-surface"]')).toBeVisible();
}
