import type {
  AdapterContext,
  ConnectorCall,
  ConnectorEvent,
  ConnectorProvider,
  ConnectorTool,
} from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { ConnectorRegistry, createConnectorStack } from "./composio-connector.js";

class StubConnector implements ConnectorProvider {
  calls: ConnectorCall[] = [];

  constructor(
    private readonly id: string,
    private readonly tools: ConnectorTool[],
  ) {}

  describe() {
    return {
      id: this.id,
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { discover: true, oauth: false, secretsBrokered: false },
    };
  }

  async discoverTools() {
    return this.tools;
  }

  async *execute(call: ConnectorCall): AsyncIterable<ConnectorEvent> {
    this.calls.push(call);
    yield { type: "result", data: { connector: this.id, tool: call.tool } };
  }
}

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};

describe("ConnectorRegistry", () => {
  it("never discovers, resolves, or executes owner-wide providers for shared bots", async () => {
    const personal = new StubConnector("installed", [tool("private_tool")]);
    const discoverPersonal = vi.spyOn(personal, "discoverTools");
    const mcp = new StubConnector("mcp", [tool("assigned_tool")]);
    const discoverMcp = vi.spyOn(mcp, "discoverTools");
    const registry = new ConnectorRegistry([personal, mcp]);
    const sharedContext = { ...context, botId: "bot-1", collaborationRestricted: true };
    const tools = await registry.discoverTools(sharedContext);
    expect(tools).toEqual([]);
    expect(discoverPersonal).not.toHaveBeenCalled();
    expect(discoverMcp).not.toHaveBeenCalled();
    const call = {
      tool: "private_tool",
      args: {},
      executionId: "call-1",
      route: { connectorId: "installed", toolName: "private_tool" },
    };
    const events = [];
    for await (const event of registry.execute(call, sharedContext)) events.push(event);
    expect(events).toEqual([{ type: "error", message: expect.any(String) }]);
    expect(personal.calls).toEqual([]);
    await expect(registry.resolveCall(call, sharedContext)).rejects.toThrow();
    for await (const _event of registry.execute(
      { ...call, tool: "assigned_tool", route: { connectorId: "mcp", toolName: "assigned_tool" } },
      sharedContext,
    )) {
      /* drain */
    }
    expect(mcp.calls).toHaveLength(0);
  });
  it("preserves every colliding tool and routes through hidden source metadata", async () => {
    const first = new StubConnector("first", [tool("shared.tool")]);
    const second = new StubConnector("second", [tool("shared.tool")]);
    const registry = new ConnectorRegistry([first, second]);

    const external = await registry.discoverTools(context);
    expect(external.map((entry) => entry.name)).toEqual(["shared.tool", "second.shared.tool"]);

    const selected = external[1]!;
    const results: unknown[] = [];
    for await (const event of registry.execute(
      {
        tool: selected.name,
        args: {},
        executionId: "execution",
        route: selected.route,
      },
      context,
    )) {
      if (event.type === "result") results.push(event.data);
    }
    expect(results).toEqual([{ connector: "second", tool: "shared.tool" }]);
    expect(first.calls).toHaveLength(0);
    expect(second.calls).toHaveLength(1);
  });

  it("registers only the providers it is given", async () => {
    const stack = createConnectorStack(undefined, [new StubConnector("first", [tool("a")])]);

    await expect(stack.connector.discoverTools(context)).resolves.toEqual([
      expect.objectContaining({ name: "a", route: { connectorId: "first", toolName: "a" } }),
    ]);
    const events: ConnectorEvent[] = [];
    for await (const event of stack.connector.execute(
      { tool: "destination.write", args: {}, executionId: "execution" },
      context,
    )) {
      events.push(event);
    }
    expect(events).toEqual([{ type: "error", message: "unknown connector composio" }]);
  });
});

function tool(name: string): ConnectorTool {
  return { name, description: name, inputSchema: { type: "object", properties: {} } };
}
