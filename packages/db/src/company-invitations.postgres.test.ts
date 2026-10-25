import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { createCompanyInvitations } from "./company-invitations.js";
import { runAsSystem, runAsTenant } from "./row-security.js";

const runtimeUrl = process.env.DATABASE_URL;
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && runtimeUrl && migrationUrl && runtimeUrl !== migrationUrl
    ? describe.sequential
    : describe.skip;

describePostgres("company invitations (PostgreSQL)", () => {
  const suffix = randomUUID();
  const organizationId = `invite-company-${suffix}`;
  const spaceId = `invite-space-${suffix}`;
  const userIds = ["owner", "recipient", "other"].map((role) => `invite-${role}-${suffix}`);
  const owner = { userId: userIds[0]!, spaceId } as Actor;
  const recipient = { userId: userIds[1]!, spaceId: "personal-space" } as Actor;
  const other = { userId: userIds[2]!, spaceId: "other-space" } as Actor;
  let app: ReturnType<typeof createDb>;
  let migration: ReturnType<typeof createDb>;
  let service: ReturnType<typeof createCompanyInvitations>;
  const system = <T>(fn: () => Promise<T>) => runAsSystem("company invitation test fixture", fn);

  beforeAll(async () => {
    app = createDb(runtimeUrl!);
    migration = createDb(migrationUrl!);
    service = createCompanyInvitations(app.prisma);
    await migration.prisma.organization.create({
      data: {
        id: organizationId,
        slug: organizationId,
        name: "Example company",
        createdAt: new Date(),
      },
    });
    for (const id of userIds) {
      await migration.prisma.user.create({
        data: { id, name: "Example member", email: `${id}@example.test`, emailVerified: false },
      });
    }
    await migration.prisma.member.create({
      data: {
        id: randomUUID(),
        organizationId,
        userId: owner.userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    await migration.prisma.space.create({
      data: { id: spaceId, organizationId, name: "Shared space" },
    });
    await migration.prisma.spaceMember.create({
      data: {
        id: randomUUID(),
        spaceId,
        organizationId,
        userId: owner.userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    if (migration) {
      await migration.prisma.organization.deleteMany({ where: { id: organizationId } });
      await migration.prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await migration.prisma.$disconnect();
      await migration.pool.end();
    }
    if (app) {
      await app.prisma.$disconnect();
      await app.pool.end();
    }
  });

  it("denies tenant reads and writes of invitation capabilities", async () => {
    const link = await service.create(owner);
    expect(
      await runAsTenant(owner, () =>
        app.prisma.companyInvitation.count({ where: { id: link.id } }),
      ),
    ).toBe(0);
    await expect(
      runAsTenant(owner, () =>
        app.prisma.companyInvitation.create({
          data: {
            id: randomUUID(),
            organizationId,
            spaceId,
            inviterUserId: owner.userId,
            tokenHash: randomUUID(),
            expiresAt: new Date(Date.now() + 60_000),
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
    const stored = await system(() =>
      app.prisma.companyInvitation.findUniqueOrThrow({ where: { id: link.id } }),
    );
    expect(stored.tokenHash).toHaveLength(64);
    expect(JSON.stringify(stored)).not.toContain(link.token);
  });

  it("requires consent and enrolls an unverified existing account without any bot grant", async () => {
    const link = await service.create(owner);
    await service.preview(link.token);
    const membershipWhere = { organizationId_userId: { organizationId, userId: recipient.userId } };
    expect(await app.prisma.member.findUnique({ where: membershipWhere })).toBeNull();
    await expect(service.accept(recipient, link.token)).resolves.toEqual({
      organizationId,
      spaceId,
    });
    expect(await app.prisma.member.findUnique({ where: membershipWhere })).toMatchObject({
      role: "member",
    });
    expect(
      await app.prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId, userId: recipient.userId } },
      }),
    ).toMatchObject({ role: "member" });
    expect(
      await system(() => app.prisma.botCollaborator.count({ where: { userId: recipient.userId } })),
    ).toBe(0);
    await expect(service.accept(other, link.token)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("preserves existing higher company and space roles", async () => {
    await app.prisma.member.update({
      where: { organizationId_userId: { organizationId, userId: recipient.userId } },
      data: { role: "admin" },
    });
    await app.prisma.spaceMember.update({
      where: { spaceId_userId: { spaceId, userId: recipient.userId } },
      data: { role: "owner" },
    });
    const link = await service.create(owner);
    await service.accept(recipient, link.token);
    expect(
      await app.prisma.member.findUnique({
        where: { organizationId_userId: { organizationId, userId: recipient.userId } },
      }),
    ).toMatchObject({ role: "admin" });
    expect(
      await app.prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId, userId: recipient.userId } },
      }),
    ).toMatchObject({ role: "owner" });
  });

  it("allows exactly one concurrent acceptance", async () => {
    const link = await service.create(owner);
    const results = await Promise.allSettled([
      service.accept(recipient, link.token),
      service.accept(other, link.token),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const stored = await system(() =>
      app.prisma.companyInvitation.findUniqueOrThrow({ where: { id: link.id } }),
    );
    expect([recipient.userId, other.userId]).toContain(stored.acceptedByUserId);
  });

  it("rejects expired or revoked links", async () => {
    const expired = await service.create(owner);
    await system(() =>
      app.prisma.companyInvitation.update({
        where: { id: expired.id },
        data: { expiresAt: new Date(0) },
      }),
    );
    await expect(service.accept(other, expired.token)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const revoked = await service.create(owner);
    await service.revoke(owner, revoked.id);
    await expect(service.accept(other, revoked.token)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
