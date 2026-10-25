import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { provisionComputer } from "./computer-lifecycle.js";

const context: AdapterContext = {
  operationId: "run-1",
  traceId: "run-1",
  runId: "run-1",
  botId: "bot-1",
  userId: "owner",
  spaceId: "space-1",
  collaborationRestricted: true,
  signal: new AbortController().signal,
};

describe("shared computer provisioning boundary", () => {
  it("rejects a host provider before accessing the attached computer's home", async () => {
    const findFirst = vi.fn();
    const provision = vi.fn();
    await expect(
      provisionComputer(
        {
          prisma: { computer: { findFirst } },
          sandbox: { provisionKind: async () => "desktop", provision },
        } as unknown as Parameters<typeof provisionComputer>[0],
        "computer-1",
        context,
      ),
    ).rejects.toThrow("Shared bot computer access is no longer valid.");
    expect(findFirst).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it("rejects a detached or invalid computer before reading its home or contacting a provider", async () => {
    const findFirst = vi.fn(async () => null);
    const findUniqueOrThrow = vi.fn();
    const provision = vi.fn();
    const homeRead = vi.fn();
    await expect(
      provisionComputer(
        {
          prisma: { computer: { findFirst, findUniqueOrThrow } },
          sandbox: { provision },
          home: { read: homeRead },
        } as unknown as Parameters<typeof provisionComputer>[0],
        "previous-computer",
        context,
      ),
    ).rejects.toThrow("Shared bot computer access is no longer valid.");
    expect(findFirst).toHaveBeenCalledExactlyOnceWith({
      where: {
        id: "previous-computer",
        userId: "owner",
        spaceId: "space-1",
        scope: "dedicated",
        kind: { not: "desktop" },
        bots: {
          some: { id: "bot-1", userId: "owner", spaceId: "space-1", archivedAt: null },
          none: { id: { not: "bot-1" } },
        },
      },
    });
    expect(findUniqueOrThrow).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(homeRead).not.toHaveBeenCalled();
  });
});
