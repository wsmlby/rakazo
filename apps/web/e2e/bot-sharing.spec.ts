import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, createNamedBot, signup } from "./helpers";

test("owner opens bot sharing", async ({ page }, testInfo) => {
  await signup(page, `bot-sharing-${Date.now()}@rakazo.test`, "password12", "Sharing Owner");
  await completeOnboarding(page);
  const name = "Shared helper";
  await createNamedBot(page, name);
  await page.getByTestId("bot-settings-trigger").click();
  const sharing = page.getByTestId("bot-sharing");
  await expect(sharing).toBeVisible();
  await sharing.getByRole("button", { name: "Sharing", exact: true }).click();
  await expect(sharing.getByRole("button", { name: "Sharing", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(sharing).toContainText("Members can read all past and future messages");
  await captureScreenshot(page, testInfo, "bot-sharing");
});
