import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

test("company invitation requires explicit acceptance and switches space", async ({
  page,
  browser,
}, testInfo) => {
  await signup(page, `company-owner-${Date.now()}@rakazo.test`, "password12", "Company Owner");
  await completeOnboarding(page);
  await openUserSettings(page);
  const company = page.getByTestId("company-invitations");
  await company.getByRole("button", { name: "Company", exact: true }).click();
  await expect(company.getByRole("button", { name: "Invite member", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "company-invitations");
  await company.getByRole("button", { name: "Invite member", exact: true }).click();
  const token = await company
    .getByRole("textbox", { name: "Created invitation code", exact: true })
    .inputValue();
  const ownerNavigation = await rpc<{ current: { id: string; bots: Array<{ id: string }> } }>(
    page,
    "spaces/list",
    {},
  );
  const ownerSpace = ownerNavigation.current.id;

  const recipientContext = await browser.newContext();
  try {
    const recipient = await recipientContext.newPage();
    await signup(
      recipient,
      `company-member-${Date.now()}@rakazo.test`,
      "password12",
      "Company Member",
    );
    await completeOnboarding(recipient);
    await openUserSettings(recipient);
    const recipientCompany = recipient.getByTestId("company-invitations");
    await recipientCompany.getByRole("button", { name: "Company", exact: true }).click();
    await recipientCompany
      .getByRole("textbox", { name: "Invitation code", exact: true })
      .fill(token);
    await recipientCompany.getByRole("button", { name: "Preview invitation", exact: true }).click();
    await expect(
      recipientCompany.getByRole("button", { name: "Join company", exact: true }),
    ).toBeVisible();
    await expect(recipientCompany).toContainText("Bot access is granted separately.");
    await recipientCompany.getByRole("button", { name: "Join company", exact: true }).click();
    await expect(recipient.getByTestId("company-invitations")).not.toBeVisible();
    await expect
      .poll(() => recipient.evaluate(() => localStorage.getItem("rakazo:space-id")))
      .toBe(ownerSpace);
    const navigationResponse = await recipient.request.post("/rpc/spaces/list", {
      headers: { "x-rakazo-space-id": ownerSpace },
      data: { json: {} },
    });
    expect(navigationResponse.ok()).toBe(true);
    const navigation = (await navigationResponse.json()).json as {
      current: { id: string; bots: Array<{ id: string }> };
    };
    expect(navigation.current.id).toBe(ownerSpace);
    expect(
      navigation.current.bots.some((bot) =>
        ownerNavigation.current.bots.some((owned) => owned.id === bot.id),
      ),
    ).toBe(false);
  } finally {
    await recipientContext.close();
  }
});
