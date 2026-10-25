// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CompanyInvitations } from "./CompanyInvitations";

const mocks = vi.hoisted(() => ({
  capabilities: vi.fn(),
  create: vi.fn(),
  preview: vi.fn(),
  accept: vi.fn(),
  revoke: vi.fn(),
  selectSpace: vi.fn(),
  copied: vi.fn(),
}));
vi.mock("../lib/rpc", () => ({
  rpc: { companyInvitations: mocks },
  selectSpace: mocks.selectSpace,
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => `${text}${index ? values[index - 1] : ""}${part}`, ""),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    size: _size,
    variant: _variant,
    ...props
  }: ComponentProps<"button"> & { size?: string; variant?: string }) => <button {...props} />,
  Input: (props: ComponentProps<"input">) => <input {...props} />,
}));
let container: HTMLDivElement;
let root: Root;
const joined = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.capabilities.mockResolvedValue({ canInvite: true });
  mocks.create.mockResolvedValue({
    id: "invite",
    token: "fake-invitation-code",
    expiresAt: "2026-10-26T00:00:00Z",
  });
  mocks.preview.mockResolvedValue({
    organizationName: "Example Company",
    spaceName: "Team",
    expiresAt: "2026-10-26T00:00:00Z",
  });
  mocks.accept.mockResolvedValue({ organizationId: "company", spaceId: "accepted-space" });
  mocks.revoke.mockResolvedValue({ ok: true });
  mocks.selectSpace.mockReturnValue(true);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mocks.copied },
  });
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === label)!;
async function open() {
  await act(async () => root.render(<CompanyInvitations onJoined={joined} />));
  expect(mocks.capabilities).not.toHaveBeenCalled();
  await act(async () => button("Company").click());
}
async function preview() {
  const input = container.querySelector<HTMLInputElement>("input:not([readonly])")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      input,
      "fake-invitation-code",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Preview invitation").click());
}
it("creates, copies and revokes only on explicit actions", async () => {
  await open();
  expect(mocks.create).not.toHaveBeenCalled();
  await act(async () => button("Invite member").click());
  await act(async () => button("Copy invitation").click());
  expect(mocks.copied).toHaveBeenCalledWith("fake-invitation-code");
  await act(async () => button("Revoke invitation").click());
  expect(mocks.revoke).toHaveBeenCalledWith({ invitationId: "invite" });
  expect(container.querySelector("input[readonly]")).toBeNull();
});
it("requires explicit acceptance after preview, then switches space before navigation", async () => {
  await open();
  await preview();
  expect(mocks.accept).not.toHaveBeenCalled();
  await act(async () => button("Join company").click());
  expect(mocks.accept).toHaveBeenCalledExactlyOnceWith({ token: "fake-invitation-code" });
  expect(mocks.selectSpace).toHaveBeenCalledWith("accepted-space");
  expect(mocks.selectSpace.mock.invocationCallOrder[0]).toBeLessThan(
    joined.mock.invocationCallOrder[0]!,
  );
});
it("does not consume an invitation again when space persistence needs retrying", async () => {
  mocks.selectSpace.mockReturnValueOnce(false).mockReturnValue(true);
  await open();
  await preview();
  await act(async () => button("Join company").click());
  expect(joined).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () => button("Open company").click());
  expect(mocks.accept).toHaveBeenCalledOnce();
  expect(joined).toHaveBeenCalledOnce();
});
it("hides invitation creation from members without invite authority", async () => {
  mocks.capabilities.mockResolvedValue({ canInvite: false });
  await open();
  expect(button("Invite member")).toBeUndefined();
  expect(button("Preview invitation")).toBeDefined();
});
