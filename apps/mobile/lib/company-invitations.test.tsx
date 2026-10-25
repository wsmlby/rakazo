// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CompanyInvitationsScreen from "../app/(settings)/company-invitations";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  selectSpace: vi.fn(),
  replace: vi.fn(),
  dismissAll: vi.fn(),
  copy: vi.fn(),
}));
vi.mock("./api", () => ({ rpc: mocks.rpc, selectSpace: mocks.selectSpace }));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./native", () => ({
  native: { groupedPage: "white" },
  useMobileTokens: () => ({ foreground: "black" }),
}));
vi.mock("./i18n", () => ({
  t: (text: string) => text,
  useI18n: () => ({ t: (text: string) => text }),
}));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ replace: mocks.replace, dismissAll: mocks.dismissAll }),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: mocks.copy }));
vi.mock("react-native", () => ({
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TextInput: ({
    value,
    onChangeText,
    editable,
    accessibilityLabel,
  }: {
    value: string;
    onChangeText: (value: string) => void;
    editable: boolean;
    accessibilityLabel: string;
  }) => (
    <input
      aria-label={accessibilityLabel}
      value={value}
      disabled={!editable}
      onChange={(event) => onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("../components/glass-title", () => ({ glassHeaderOptions: () => ({}) }));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.selectSpace.mockResolvedValue(undefined);
  mocks.rpc.mockImplementation(async (procedure: string) => {
    if (procedure === "companyInvitations/capabilities") return { canInvite: true };
    if (procedure === "companyInvitations/create")
      return { id: "invitation", token: "fake-invitation-code" };
    if (procedure === "companyInvitations/preview")
      return { organizationName: "Example Company", spaceName: "Team" };
    if (procedure === "companyInvitations/accept")
      return { organizationId: "company", spaceId: "accepted-space" };
    return { ok: true };
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
async function preview() {
  await act(async () => root.render(<CompanyInvitationsScreen />));
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      input,
      "fake-invitation-code",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Preview invitation").click());
}
it("creates and revokes invitation codes through native actions", async () => {
  await act(async () => root.render(<CompanyInvitationsScreen />));
  await act(async () => button("Invite member").click());
  await act(async () => button("Copy invitation").click());
  expect(mocks.copy).toHaveBeenCalledWith("fake-invitation-code");
  await act(async () => button("Revoke invitation").click());
  expect(mocks.rpc).toHaveBeenCalledWith("companyInvitations/revoke", {
    invitationId: "invitation",
  });
});
it("previews without accepting and switches to the accepted space before navigation", async () => {
  await preview();
  expect(
    mocks.rpc.mock.calls.some(([procedure]) => procedure === "companyInvitations/accept"),
  ).toBe(false);
  await act(async () => button("Join company").click());
  expect(mocks.rpc).toHaveBeenCalledWith("companyInvitations/accept", {
    token: "fake-invitation-code",
  });
  expect(mocks.selectSpace).toHaveBeenCalledWith("accepted-space");
  expect(mocks.selectSpace.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.replace.mock.invocationCallOrder[0]!,
  );
});
it("retries failed space persistence without replaying an accepted invitation", async () => {
  mocks.selectSpace.mockRejectedValueOnce(new Error("Storage unavailable"));
  await preview();
  await act(async () => button("Join company").click());
  expect(mocks.replace).not.toHaveBeenCalled();
  await act(async () => button("Open company").click());
  expect(
    mocks.rpc.mock.calls.filter(([procedure]) => procedure === "companyInvitations/accept"),
  ).toHaveLength(1);
  expect(mocks.replace).toHaveBeenCalledWith("/");
});
