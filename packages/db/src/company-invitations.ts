import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "./client.js";
import type { Prisma } from "./generated/prisma/client.js";
import { runAsSystem } from "./row-security.js";
import { withTransactionRetry } from "./transaction-retry.js";

export class CompanyInvitationError extends Error {
  constructor(public readonly code: "FORBIDDEN" | "NOT_FOUND" | "TOO_MANY_REQUESTS") {
    super(
      code === "FORBIDDEN"
        ? "Only company owners and admins can invite members"
        : code === "TOO_MANY_REQUESTS"
          ? "Too many pending invitations"
          : "Invitation unavailable",
    );
  }
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const isAdmin = (role: string) =>
  role.split(",").some((value) => value.trim() === "owner" || value.trim() === "admin");

async function requireAdmin(tx: Prisma.TransactionClient, organizationId: string, userId: string) {
  const member = await tx.member.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
  if (!member || !isAdmin(member.role)) throw new CompanyInvitationError("FORBIDDEN");
}

async function activeSpace(tx: Prisma.TransactionClient, spaceId: string) {
  const space = await tx.space.findUnique({ where: { id: spaceId } });
  if (!space || space.deletingAt) throw new CompanyInvitationError("NOT_FOUND");
  return space;
}

export function createCompanyInvitations(prisma: PrismaClient) {
  const transaction = <T>(reason: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    runAsSystem(reason, () =>
      withTransactionRetry(() => prisma.$transaction(fn, { isolationLevel: "Serializable" })),
    );

  async function available(tx: Prisma.TransactionClient, token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new CompanyInvitationError("NOT_FOUND");
    const invitation = await tx.companyInvitation.findUnique({
      where: { tokenHash: tokenHash(token) },
    });
    if (
      !invitation ||
      invitation.acceptedAt ||
      invitation.revokedAt ||
      invitation.expiresAt <= new Date()
    ) {
      throw new CompanyInvitationError("NOT_FOUND");
    }
    const space = await activeSpace(tx, invitation.spaceId);
    if (space.organizationId !== invitation.organizationId) {
      throw new CompanyInvitationError("NOT_FOUND");
    }
    // Removing an inviter's authority invalidates their outstanding links.
    try {
      await requireAdmin(tx, invitation.organizationId, invitation.inviterUserId);
    } catch (error) {
      if (error instanceof CompanyInvitationError) throw new CompanyInvitationError("NOT_FOUND");
      throw error;
    }
    return { invitation, space };
  }

  return {
    capabilities: (actor: Actor) =>
      transaction("check company invitation capability for authenticated member", async (tx) => {
        try {
          const space = await activeSpace(tx, actor.spaceId);
          await requireAdmin(tx, space.organizationId, actor.userId);
          const membership = await tx.spaceMember.findUnique({
            where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
          });
          return { canInvite: Boolean(membership) };
        } catch (error) {
          if (error instanceof CompanyInvitationError) return { canInvite: false };
          throw error;
        }
      }),

    create: (actor: Actor) =>
      transaction("issue company invitation after owner/admin authorization", async (tx) => {
        const space = await activeSpace(tx, actor.spaceId);
        await requireAdmin(tx, space.organizationId, actor.userId);
        const membership = await tx.spaceMember.findUnique({
          where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
        });
        if (!membership) throw new CompanyInvitationError("FORBIDDEN");
        const now = new Date();
        const pending = await tx.companyInvitation.count({
          where: {
            spaceId: space.id,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: now },
          },
        });
        if (pending >= 100) throw new CompanyInvitationError("TOO_MANY_REQUESTS");
        const token = randomBytes(32).toString("base64url");
        const invitation = await tx.companyInvitation.create({
          data: {
            id: randomUUID(),
            organizationId: space.organizationId,
            spaceId: space.id,
            inviterUserId: actor.userId,
            tokenHash: tokenHash(token),
            expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
          },
        });
        return { id: invitation.id, token, expiresAt: invitation.expiresAt.toISOString() };
      }),

    preview: (token: string) =>
      transaction("preview a company invitation verified by its capability", async (tx) => {
        const { invitation, space } = await available(tx, token);
        const organization = await tx.organization.findUnique({
          where: { id: invitation.organizationId },
        });
        if (!organization) throw new CompanyInvitationError("NOT_FOUND");
        return {
          organizationName: organization.name,
          spaceName: space.name,
          expiresAt: invitation.expiresAt.toISOString(),
        };
      }),

    accept: (actor: Actor, token: string) =>
      transaction("accept company invitation with authenticated recipient consent", async (tx) => {
        const { invitation } = await available(tx, token);
        const now = new Date();
        const consumed = await tx.companyInvitation.updateMany({
          where: {
            id: invitation.id,
            acceptedAt: null,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          data: { acceptedAt: now, acceptedByUserId: actor.userId },
        });
        if (consumed.count !== 1) throw new CompanyInvitationError("NOT_FOUND");
        await tx.member.upsert({
          where: {
            organizationId_userId: {
              organizationId: invitation.organizationId,
              userId: actor.userId,
            },
          },
          create: {
            id: randomUUID(),
            organizationId: invitation.organizationId,
            userId: actor.userId,
            role: "member",
            createdAt: now,
          },
          update: {},
        });
        await tx.spaceMember.upsert({
          where: { spaceId_userId: { spaceId: invitation.spaceId, userId: actor.userId } },
          create: {
            id: randomUUID(),
            organizationId: invitation.organizationId,
            spaceId: invitation.spaceId,
            userId: actor.userId,
            role: "member",
            createdAt: now,
          },
          update: {},
        });
        return { organizationId: invitation.organizationId, spaceId: invitation.spaceId };
      }),

    revoke: (actor: Actor, invitationId: string) =>
      transaction("revoke company invitation after owner/admin authorization", async (tx) => {
        const space = await activeSpace(tx, actor.spaceId);
        await requireAdmin(tx, space.organizationId, actor.userId);
        await tx.companyInvitation.updateMany({
          where: {
            id: invitationId,
            spaceId: space.id,
            organizationId: space.organizationId,
            acceptedAt: null,
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        });
        return { ok: true as const };
      }),
  };
}
