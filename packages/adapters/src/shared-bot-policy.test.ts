import { describe, expect, it } from "vitest";
import {
  sharedBotTaughtSkill,
  sharedBotToolAllowed,
  sharedBotToolError,
  sharedBotWorkstationError,
} from "./shared-bot-policy.js";

describe("shared bot tool boundary", () => {
  it.each([
    "shell",
    "browser_act",
    "read_file",
    "write_file",
    "remember",
    "recall_memory",
    "save_memory",
    "scratchpad_add",
    "schedule_list",
    "task_catalog",
    "list_secrets",
    "secret_request",
    "ask_user",
  ])("retains bot work through %s", (name) => {
    expect(sharedBotToolAllowed(name)).toBe(true);
    expect(sharedBotToolError(name, {}, "bot-1")).toBeUndefined();
  });

  it.each([
    "save_shared_memory",
    "forget_memory",
    "skill_update",
    "search_history",
    "read_history",
    "list_fleet",
    "board_tickets",
    "cloud_agent_launch",
    "connect_app",
    "add_mcp_server",
    "request_secret",
    "forget_secret",
    "propose_instructions_update",
    "schedule_create",
    "schedule_cancel",
    "run_subagent",
    "message_bot",
    "unknown_connector_tool",
  ])("fails closed for %s at exposure and dispatch", (name) => {
    expect(sharedBotToolAllowed(name)).toBe(false);
    expect(sharedBotToolError(name, {}, "bot-1")).toBeDefined();
  });

  it.each([
    { scope: "user" },
    { scope: "shared" },
    { scope: "bot" },
    { botId: "other-bot" },
    { bot_id: "other-bot" },
    { userId: "owner" },
    { user_id: "owner" },
    { spaceId: "other-space" },
  ])("rejects caller-selected resource scopes %j", (args) => {
    expect(sharedBotToolError("remember", args, "bot-1")).toBeDefined();
  });

  it("accepts only the bot's exclusive non-host computer", () => {
    const owner = { userId: "owner", spaceId: "space" };
    const computer = { scope: "dedicated", kind: "e2b", ...owner };
    expect(sharedBotWorkstationError(computer, ["bot-1"], "bot-1", owner)).toBeUndefined();
    expect(sharedBotWorkstationError(computer, ["bot-1", "bot-2"], "bot-1", owner)).toBeDefined();
    expect(sharedBotWorkstationError(computer, ["bot-2"], "bot-1", owner)).toBeDefined();
    expect(
      sharedBotWorkstationError({ ...computer, kind: "desktop" }, ["bot-1"], "bot-1", owner),
    ).toBeDefined();
    expect(
      sharedBotWorkstationError({ ...computer, scope: "shared" }, ["bot-1"], "bot-1", owner),
    ).toBeDefined();
    expect(
      sharedBotWorkstationError({ ...computer, userId: "old-owner" }, ["bot-1"], "bot-1", owner),
    ).toBeDefined();
    expect(
      sharedBotWorkstationError({ ...computer, spaceId: "other-space" }, ["bot-1"], "bot-1", owner),
    ).toBeDefined();
    expect(sharedBotWorkstationError(null, [], "bot-1", owner)).toBeDefined();
  });

  it("resolves taught skills only from this bot's scoped records", () => {
    const skills = [{ id: "taught-1", name: "prepare report", playbook: { steps: [] } }];
    expect(sharedBotTaughtSkill(skills, { skillId: "taught-1" })).toBe(skills[0]);
    expect(sharedBotTaughtSkill(skills, { name: "prepare report" })).toBe(skills[0]);
    expect(sharedBotTaughtSkill(skills, { skillId: "personal-skill" })).toBeUndefined();
    expect(
      sharedBotTaughtSkill(skills, { skillId: "personal-skill", name: "prepare report" }),
    ).toBeUndefined();
  });

  it("fails closed for connector routes until their execution is bot-isolated", () => {
    expect(sharedBotToolAllowed("assigned_tool", { connectorId: "mcp" })).toBe(false);
    expect(sharedBotToolAllowed("shell", { connectorId: "installed" })).toBe(false);
    expect(sharedBotToolAllowed("assigned_tool", { connectorId: "composio" })).toBe(false);
    expect(
      sharedBotToolError("assigned_tool", { scope: "remote-resource" }, "bot-1", {
        connectorId: "mcp",
      }),
    ).toBeDefined();
  });
});
