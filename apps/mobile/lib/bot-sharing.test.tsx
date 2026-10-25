// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, useEffect } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import BotSharingScreen from "../app/bot-sharing";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  dismissTo: vi.fn(),
  alert: vi.fn(),
  foreground: null as ((state: string) => void) | null,
}));
vi.mock("./api", () => ({ rpc: mocks.rpc }));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./native", () => ({
  useMobileTokens: () => ({ background: "white", destructive: "red" }),
}));
vi.mock("./i18n", () => ({
  useI18n: () => ({ t: (text: string) => text }),
}));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ botId: "bot" }),
  useRouter: () => ({ dismissTo: mocks.dismissTo }),
  useFocusEffect: (callback: () => (() => void) | undefined) => useEffect(callback, [callback]),
}));
vi.mock("react-native", () => ({
  Alert: { alert: mocks.alert },
  AppState: {
    addEventListener: (_event: string, callback: (state: string) => void) => {
      mocks.foreground = callback;
      return { remove: vi.fn() };
    },
  },
  RefreshControl: () => null,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../components/glass-title", () => ({ glassHeaderOptions: () => ({}) }));
vi.mock("../components/menu-picker", () => ({
  MenuPicker: ({
    onChange,
    choices,
  }: {
    onChange: (value: string) => void;
    choices: Array<{ key: string; label: string }>;
  }) => (
    <select onChange={(event) => onChange(event.target.value)}>
      {choices.map((choice) => (
        <option key={choice.key} value={choice.key}>
          {choice.label}
        </option>
      ))}
    </select>
  ),
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
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsRow: ({
    title,
    disabled,
    onPress,
  }: {
    title: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {title}
    </button>
  ),
  SettingsSwitch: ({
    label,
    value,
    disabled,
    onChange,
  }: {
    label: string;
    value: boolean;
    disabled?: boolean;
    onChange: (value: boolean) => void;
  }) => (
    <button
      type="button"
      disabled={disabled}
      role="switch"
      aria-label={label}
      aria-checked={value}
      onClick={() => onChange(!value)}
    />
  ),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.rpc.mockImplementation(async (procedure: string) => {
    if (procedure === "bots/get") return { accessRole: "owner" };
    if (procedure === "bots/sharing/get")
      return {
        members: [{ userId: "member", name: "Member", canApprove: false }],
        eligibleMembers: [{ userId: "new-member", name: "New member" }],
      };
    return { ok: true };
  });
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === text)!;

it("does not fetch or render sharing controls for a collaborator deep link", async () => {
  mocks.rpc.mockResolvedValue({ accessRole: "collaborator" });
  await act(async () => root.render(<BotSharingScreen />));
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("bots/get", { botId: "bot" });
  expect(container.querySelector("button")).toBeNull();
});

it("removes stale ownership controls when returning after ownership changes", async () => {
  await act(async () => root.render(<BotSharingScreen />));
  expect(button("Company")).toBeDefined();
  mocks.rpc.mockResolvedValue({ accessRole: "collaborator" });
  await act(async () => mocks.foreground?.("active"));
  expect(container.querySelector("button")).toBeNull();
});

it("uses native membership, approval and transfer actions", async () => {
  await act(async () => root.render(<BotSharingScreen />));
  await act(async () => {
    const select = container.querySelector("select")!;
    select.value = "new-member";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await act(async () => button("Add").click());
  expect(mocks.rpc).toHaveBeenCalledWith("bots/sharing/grant", {
    botId: "bot",
    userId: "new-member",
  });
  await act(async () => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(mocks.rpc).toHaveBeenCalledWith("bots/sharing/grant", {
    botId: "bot",
    userId: "member",
    canApprove: true,
  });
  await act(async () => button("Transfer ownership").click());
  const actions = mocks.alert.mock.calls[0]![2] as Array<{ text: string; onPress?: () => void }>;
  expect(mocks.rpc).not.toHaveBeenCalledWith("bots/sharing/transfer", expect.anything());
  await act(async () => actions.find((action) => action.text === "Transfer")?.onPress?.());
  expect(mocks.rpc).toHaveBeenCalledWith("bots/sharing/transfer", {
    botId: "bot",
    userId: "member",
  });
  expect(mocks.dismissTo).toHaveBeenCalledOnce();
});

it("switches to a private computer only after the owner chooses it", async () => {
  const implementation = mocks.rpc.getMockImplementation()!;
  mocks.rpc.mockImplementation(async (procedure: string, input?: unknown) => {
    if (procedure === "bots/get") return { accessRole: "owner", computerMode: "team" };
    return implementation(procedure, input);
  });
  await act(async () => root.render(<BotSharingScreen />));
  expect(container.querySelector("select")).toBeNull();
  await act(async () => button("Use private computer").click());
  expect(mocks.rpc).toHaveBeenCalledWith("bots/setComputer", { botId: "bot", mode: "dedicated" });
  expect(container.querySelector("select")).not.toBeNull();
});
