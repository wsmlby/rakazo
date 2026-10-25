import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "./router.js";
import { createRouter } from "./router.js";

const actor = { userId: "recipient", spaceId: "personal-space" } as Actor;
const token = "a".repeat(43);

function harness() {
  const tx = {
    companyInvitation: { findUnique: vi.fn(async () => null) },
    space: {
      findUnique: vi.fn(async () => ({
        id: "personal-space",
        organizationId: "company",
        deletingAt: null,
      })),
    },
    member: { findUnique: vi.fn(async () => ({ role: "member" })) },
  };
  const transaction = vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
    callback(tx),
  );
  const deps = {
    prisma: { $transaction: transaction } as unknown as PrismaClient,
    env: {},
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  async function call(procedure: string, input: unknown, signedIn = true) {
    const result = await handler.handle(
      new Request(`http://localhost/rpc/companyInvitations/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor: signedIn ? actor : null } },
    );
    return result.response;
  }
  return { tx, transaction, call };
}

describe("company invitation RPC", () => {
  it.each([
    ["capabilities", undefined],
    ["create", {}],
    ["preview", { token }],
    ["accept", { token }],
    ["revoke", { invitationId: "invitation" }],
  ])("requires authentication for %s", async (procedure, input) => {
    const { call, transaction } = harness();
    expect((await call(procedure as string, input, false))?.status).toBe(401);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("hides the invite affordance from ordinary company members", async () => {
    const { call } = harness();
    const response = await call("capabilities", undefined);
    expect(response?.status).toBe(200);
    await expect(response!.json()).resolves.toEqual({ json: { canInvite: false } });
  });

  it.each(["preview", "accept"])(
    "validates the %s capability before querying",
    async (procedure) => {
      const { call, transaction } = harness();
      expect((await call(procedure, { token: "invalid" }))?.status).toBe(400);
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it.each(["preview", "accept"])(
    "returns a safe unavailable error for unknown %s links",
    async (procedure) => {
      const { call, tx } = harness();
      const response = await call(procedure, { token });
      expect(response?.status).toBe(404);
      const text = await response!.text();
      expect(text).toContain("Invitation unavailable");
      expect(text).not.toContain(token);
      expect(tx.companyInvitation.findUnique).toHaveBeenCalled();
    },
  );

  it("maps owner/admin authorization failures without creating an invitation", async () => {
    const { call, tx } = harness();
    expect((await call("create", {}))?.status).toBe(403);
    expect(tx.member.findUnique).toHaveBeenCalledWith({
      where: { organizationId_userId: { organizationId: "company", userId: "recipient" } },
    });
  });
});
