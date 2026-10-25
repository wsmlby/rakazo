// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BotSharing } from "./bot-sharing";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  grant: vi.fn(async () => ({ ok: true })),
  revoke: vi.fn(async () => ({ ok: true })),
  transfer: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../../lib/rpc", () => ({ rpc: { bots: { sharing: mocks } } }));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => `${text}${index ? values[index - 1] : ""}${part}`, ""),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<"button"> & { variant?: string; size?: string }) => <button {...props} />,
  NativeSelect: (props: ComponentProps<"select">) => <select {...props} />,
  NativeSelectOption: (props: ComponentProps<"option">) => <option {...props} />,
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange: (value: boolean) => void;
  } & ComponentProps<"button">) => (
    <button
      {...props}
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));

let root: Root;
let container: HTMLDivElement;
const transferred = vi.fn(async () => undefined);
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.get.mockResolvedValue({
    members: [{ userId: "member", name: "Team Member", canApprove: false }],
    eligibleMembers: [{ userId: "new-member", name: "New Member" }],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function button(label: string) {
  return [...container.querySelectorAll("button")].find(
    (element) => element.textContent === label,
  )!;
}
async function open() {
  await act(async () => root.render(<BotSharing botId="bot" onChanged={transferred} />));
  expect(mocks.get).not.toHaveBeenCalled();
  await act(async () => button("Sharing").click());
}

it("loads sharing only when opened and sends membership and approval changes", async () => {
  await open();
  const select = container.querySelector("select")!;
  await act(async () => {
    select.value = "new-member";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button("Add").click());
  expect(mocks.grant).toHaveBeenCalledWith({ botId: "bot", userId: "new-member" });
  await act(async () => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(mocks.grant).toHaveBeenCalledWith({ botId: "bot", userId: "member", canApprove: true });
  await act(async () => button("Remove").click());
  expect(mocks.revoke).toHaveBeenCalledWith({ botId: "bot", userId: "member" });
});

it("requires confirmation before transferring and refreshes access afterwards", async () => {
  await open();
  await act(async () => button("Transfer ownership").click());
  expect(mocks.transfer).not.toHaveBeenCalled();
  await act(async () => button("Transfer").click());
  expect(mocks.transfer).toHaveBeenCalledWith({ botId: "bot", userId: "member" });
  expect(transferred).toHaveBeenCalledOnce();
});

it("requires an explicit private computer switch before offering new members", async () => {
  const usePrivateComputer = vi.fn(async () => undefined);
  await act(async () =>
    root.render(
      <BotSharing
        botId="bot"
        computerMode="team"
        onUsePrivateComputer={usePrivateComputer}
        onChanged={transferred}
      />,
    ),
  );
  await act(async () => button("Sharing").click());
  expect(container.querySelector("select")).toBeNull();
  await act(async () => button("Use private computer").click());
  expect(usePrivateComputer).toHaveBeenCalledOnce();
  expect(mocks.grant).not.toHaveBeenCalled();
});

it("keeps a failed mutation visible without claiming success", async () => {
  mocks.revoke.mockRejectedValueOnce(new Error("Denied"));
  await open();
  await act(async () => button("Remove").click());
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.textContent).toContain("Team Member");
});
