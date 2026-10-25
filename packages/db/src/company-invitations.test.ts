import { createHash } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { CompanyInvitationError, createCompanyInvitations } from "./company-invitations.js";
import { currentDbContext } from "./row-security.js";

const owner = { userId: "owner", spaceId: "space" } as Actor;
const recipient = { userId: "recipient", spaceId: "personal-space" } as Actor;
const now = new Date("2026-10-25T12:00:00Z");
const token = "a".repeat(43);
const initialInvitation = () => ({
  id: "invitation",
  organizationId: "company",
  spaceId: "space",
  inviterUserId: "owner",
  tokenHash: createHash("sha256").update(token).digest("hex"),
  expiresAt: new Date(now.getTime() + 86_400_000),
  acceptedAt: null as Date | null,
  acceptedByUserId: null as string | null,
  revokedAt: null as Date | null,
});

function harness() {
  const state = {
    invitation: initialInvitation(),
    inviterRole: "owner" as string | null,
    recipientCompanyRole: null as string | null,
    recipientSpaceRole: null as string | null,
    deletingAt: null as Date | null,
    pending: 0,
    creatorSpaceMember: true,
  };
  const tx = {
    space: {
      findUnique: vi.fn(async () => ({
        id: "space",
        organizationId: "company",
        name: "Shared space",
        deletingAt: state.deletingAt,
      })),
    },
    organization: { findUnique: vi.fn(async () => ({ name: "Example company" })) },
    member: {
      findUnique: vi.fn(async () =>
        state.inviterRole === null ? null : { role: state.inviterRole },
      ),
      upsert: vi.fn(async (args: { create: { role: string } }) => {
        state.recipientCompanyRole ??= args.create.role;
      }),
    },
    spaceMember: {
      findUnique: vi.fn(async () => (state.creatorSpaceMember ? { id: "membership" } : null)),
      upsert: vi.fn(async (args: { create: { role: string } }) => {
        state.recipientSpaceRole ??= args.create.role;
      }),
    },
    companyInvitation: {
      count: vi.fn(async () => state.pending),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => args.data),
      findUnique: vi.fn(async (args: { where: { tokenHash: string } }) =>
        args.where.tokenHash === state.invitation.tokenHash ? state.invitation : null,
      ),
      updateMany: vi.fn(
        async (args: {
          where: { id: string; spaceId?: string };
          data: { acceptedAt?: Date; acceptedByUserId?: string; revokedAt?: Date };
        }) => {
          if (
            args.where.id !== state.invitation.id ||
            (args.where.spaceId && args.where.spaceId !== state.invitation.spaceId) ||
            state.invitation.acceptedAt ||
            state.invitation.revokedAt ||
            state.invitation.expiresAt <= now
          ) {
            return { count: 0 };
          }
          Object.assign(state.invitation, args.data);
          return { count: 1 };
        },
      ),
    },
  };
  const transaction = vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => {
    expect(currentDbContext()?.kind).toBe("system");
    const snapshot = structuredClone(state);
    try {
      return await callback(tx);
    } catch (error) {
      Object.assign(state, snapshot);
      throw error;
    }
  });
  const prisma = { $transaction: transaction } as unknown as PrismaClient;
  return { state, tx, transaction, service: createCompanyInvitations(prisma) };
}

describe("company invitation capabilities", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  it("reveals invitation capability only to company admins belonging to this space", async () => {
    const { service, state, tx } = harness();
    await expect(service.capabilities(owner)).resolves.toEqual({ canInvite: true });
    state.inviterRole = "member";
    await expect(service.capabilities(owner)).resolves.toEqual({ canInvite: false });
    state.inviterRole = "admin";
    state.creatorSpaceMember = false;
    await expect(service.capabilities(owner)).resolves.toEqual({ canInvite: false });
    state.creatorSpaceMember = true;
    state.deletingAt = now;
    await expect(service.capabilities(owner)).resolves.toEqual({ canInvite: false });
    expect(tx.companyInvitation.create).not.toHaveBeenCalled();
  });

  it("creates an expiring random link and persists only its hash", async () => {
    const { service, tx, transaction } = harness();
    const before = Date.now();
    const result = await service.create(owner);
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tx.companyInvitation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: "company",
        spaceId: "space",
        inviterUserId: "owner",
        tokenHash: createHash("sha256").update(result.token).digest("hex"),
      }),
    });
    expect(JSON.stringify(tx.companyInvitation.create.mock.calls)).not.toContain(result.token);
    expect(Date.parse(result.expiresAt)).toBeGreaterThanOrEqual(before + 86_400_000);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    const second = await service.create(owner);
    expect(second.token).not.toBe(result.token);
  });

  it.each(["member", "admin-not", ""])("rejects invitation creation for role %s", async (role) => {
    const { service, state, tx } = harness();
    state.inviterRole = role;
    await expect(service.create(owner)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx.companyInvitation.create).not.toHaveBeenCalled();
  });

  it.each(["admin", "member,admin", "owner"])("accepts company admin role %s", async (role) => {
    const { service, state } = harness();
    state.inviterRole = role;
    await expect(service.create(owner)).resolves.toHaveProperty("token");
  });

  it("requires the inviter to belong to the target space", async () => {
    const { service, state } = harness();
    state.creatorSpaceMember = false;
    await expect(service.create(owner)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("bounds the number of pending links", async () => {
    const { service, state } = harness();
    state.pending = 100;
    await expect(service.create(owner)).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("previews the company and space without enrolling the recipient", async () => {
    const { service, tx } = harness();
    await expect(service.preview(token)).resolves.toEqual({
      organizationName: "Example company",
      spaceName: "Shared space",
      expiresAt: initialInvitation().expiresAt.toISOString(),
    });
    expect(tx.member.upsert).not.toHaveBeenCalled();
    expect(tx.spaceMember.upsert).not.toHaveBeenCalled();
    expect(tx.companyInvitation.updateMany).not.toHaveBeenCalled();
  });

  it("grants only company and space membership to the authenticated recipient", async () => {
    const { service, state, tx } = harness();
    await expect(service.accept(recipient, token)).resolves.toEqual({
      organizationId: "company",
      spaceId: "space",
    });
    expect(state.recipientCompanyRole).toBe("member");
    expect(state.recipientSpaceRole).toBe("member");
    expect(state.invitation.acceptedByUserId).toBe("recipient");
    expect(tx.member.upsert).toHaveBeenCalledWith({
      where: { organizationId_userId: { organizationId: "company", userId: "recipient" } },
      create: expect.objectContaining({ userId: "recipient", role: "member" }),
      update: {},
    });
    await expect(service.accept(owner, token)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(tx.member.upsert).toHaveBeenCalledTimes(1);
  });

  it("does not downgrade existing company or space roles", async () => {
    const { service, state, tx } = harness();
    state.recipientCompanyRole = "admin";
    state.recipientSpaceRole = "owner";
    await service.accept(recipient, token);
    expect(state.recipientCompanyRole).toBe("admin");
    expect(state.recipientSpaceRole).toBe("owner");
    expect(tx.spaceMember.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: {} }));
  });

  it.each(["expired", "accepted", "revoked", "demoted", "removed", "deleting"])(
    "rejects %s invitations before membership writes",
    async (condition) => {
      const { service, state, tx } = harness();
      if (condition === "expired") state.invitation.expiresAt = new Date(0);
      if (condition === "accepted") state.invitation.acceptedAt = now;
      if (condition === "revoked") state.invitation.revokedAt = now;
      if (condition === "demoted") state.inviterRole = "member";
      if (condition === "removed") state.inviterRole = null;
      if (condition === "deleting") state.deletingAt = now;
      await expect(service.accept(recipient, token)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(tx.member.upsert).not.toHaveBeenCalled();
      expect(tx.spaceMember.upsert).not.toHaveBeenCalled();
    },
  );

  it.each(["", "not-a-token", "b".repeat(43)])("rejects an unknown capability", async (value) => {
    const { service } = harness();
    await expect(service.accept(recipient, value)).rejects.toBeInstanceOf(CompanyInvitationError);
  });

  it("rejects a claim lost to another recipient", async () => {
    const { service, tx } = harness();
    tx.companyInvitation.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(service.accept(recipient, token)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(tx.member.upsert).not.toHaveBeenCalled();
  });

  it("rolls back consumption and company membership if space enrollment fails", async () => {
    const { service, tx, state } = harness();
    tx.spaceMember.upsert.mockRejectedValueOnce(new Error("write failed"));
    await expect(service.accept(recipient, token)).rejects.toThrow("write failed");
    expect(state.invitation.acceptedAt).toBeNull();
    expect(state.recipientCompanyRole).toBeNull();
    await expect(service.accept(recipient, token)).resolves.toHaveProperty("spaceId", "space");
  });

  it("retries serialization conflicts", async () => {
    const { service, transaction } = harness();
    transaction.mockRejectedValueOnce({ code: "P2034" });
    await expect(service.accept(recipient, token)).resolves.toHaveProperty("spaceId", "space");
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("allows an administrator to revoke only links in their current space", async () => {
    const { service, state } = harness();
    await expect(service.revoke(owner, "invitation")).resolves.toEqual({ ok: true });
    expect(state.invitation.revokedAt).not.toBeNull();
    await expect(service.accept(recipient, token)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects revocation by a company member", async () => {
    const { service, state, tx } = harness();
    state.inviterRole = "member";
    await expect(service.revoke(owner, "invitation")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(tx.companyInvitation.updateMany).not.toHaveBeenCalled();
  });
});
