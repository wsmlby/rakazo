import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import {
  asSystem,
  createBotSharing,
  createDb,
  createRepos,
  getAccessibleBot,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getSpaceArtifactById } from "./artifacts.js";
import {
  markThreadRead,
  resolveThreadTarget,
  sendThreadMessage,
  stopThreadRuns,
} from "./thread-target.js";

const suite =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe.sequential : describe.skip;

suite("explicit bot collaboration (PostgreSQL)", () => {
  const id = randomUUID();
  const organizationId = `sharing-org-${id}`;
  const spaceId = `sharing-space-${id}`;
  const users = ["owner", "coworker", "peer", "outsider"].map((name) => `sharing-${name}-${id}`);
  const actor = (index: number): Actor => ({
    spaceId,
    userId: users[index]!,
    email: "fixture@example.test",
    isDeploymentOwner: false,
  });
  const owner = actor(0);
  const coworker = actor(1);
  let db: ReturnType<typeof createDb>;
  const fixture = () => asSystem(db.prisma);
  const sharing = () => createBotSharing(db.prisma);
  const within = <T>(who: Actor, fn: () => Promise<T>) => runAsTenant(who, fn);
  const makeBot = (name: string, mode: "dedicated" | "team" = "dedicated") =>
    within(owner, () =>
      createRepos(db.prisma).createBot(owner, {
        name,
        title: "",
        description: "",
        instructions: "",
        notifyOnFinish: true,
        computerMode: mode,
      }),
    );
  const share = (botId: string) =>
    within(owner, () => sharing().grant(owner, { botId, userId: coworker.userId }));
  const events = { notify: vi.fn(async () => {}) };
  const jobs = { enqueue: vi.fn(async () => {}) };

  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    const prisma = fixture();
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: "Sharing fixture",
        slug: organizationId,
        createdAt: new Date(),
      },
    });
    await prisma.space.create({ data: { id: spaceId, organizationId, name: "Fixture" } });
    for (const [index, userId] of users.entries()) {
      await prisma.user.create({
        data: {
          id: userId,
          name: `Fixture ${index}`,
          email: `${userId}@example.test`,
          emailVerified: true,
        },
      });
      if (index === 3) continue;
      await prisma.member.create({
        data: {
          id: `member-${userId}`,
          organizationId,
          userId,
          role: "member",
          createdAt: new Date(),
        },
      });
      await prisma.spaceMember.create({
        data: {
          id: `space-member-${userId}`,
          organizationId,
          spaceId,
          userId,
          createdAt: new Date(),
        },
      });
    }
  });

  afterAll(async () => {
    if (!db) return;
    await fixture().organization.delete({ where: { id: organizationId } });
    await fixture().user.deleteMany({ where: { id: { in: users } } });
    await db.pool.end();
  });

  it("exposes only the shared bot, not the owner's other bots or owner-only repository", async () => {
    const bot = await makeBot("Shared");
    const privateBot = await makeBot("Private");
    await expect(
      within(coworker, () => getAccessibleBot(db.prisma, coworker, bot.id)),
    ).rejects.toThrow();
    await share(bot.id);
    await within(coworker, async () => {
      expect((await getAccessibleBot(db.prisma, coworker, bot.id)).id).toBe(bot.id);
      await expect(createRepos(db.prisma).getBot(coworker, bot.id)).rejects.toThrow();
      const visible = await createRepos(db.prisma).listBots(coworker, { accessible: true });
      expect(visible.map((item) => item.id)).toContain(bot.id);
      expect(visible.map((item) => item.id)).not.toContain(privateBot.id);
      expect(visible.find((item) => item.id === bot.id)).toMatchObject({
        ownerUserId: owner.userId,
        accessRole: "collaborator",
        canApprove: false,
      });
      expect(await db.prisma.bot.findUnique({ where: { id: privateBot.id } })).toBeNull();
      expect(await db.prisma.thread.findUnique({ where: { botId: privateBot.id } })).toBeNull();
      expect(
        await db.prisma.bot.updateMany({ where: { id: bot.id }, data: { name: "Forbidden" } }),
      ).toEqual({ count: 0 });
    });
    const members = await within(owner, () => sharing().get(owner, bot.id));
    expect(members.members).toEqual([
      { userId: coworker.userId, name: "Fixture 1", canApprove: false },
    ]);
    expect(members.eligibleMembers.map((item) => item.userId)).not.toContain(users[3]);
    await expect(within(coworker, () => sharing().get(coworker, bot.id))).rejects.toThrow();
    await expect(
      within(owner, () => sharing().grant(owner, { botId: bot.id, userId: users[3]! })),
    ).rejects.toThrow();
    expect(
      await fixture().member.findUnique({
        where: { organizationId_userId: { organizationId, userId: coworker.userId } },
      }),
    ).toMatchObject({ role: "member" });
  });

  it("rejects non-dedicated, busy and non-exclusive computers", async () => {
    const team = await makeBot("Team", "team");
    await expect(share(team.id)).rejects.toThrow("dedicated");
    const bot = await makeBot("Nonexclusive");
    const other = await makeBot("Other");
    const stored = await fixture().bot.findUniqueOrThrow({ where: { id: bot.id } });
    await fixture().bot.update({
      where: { id: other.id },
      data: { computerId: stored.computerId },
    });
    await expect(share(bot.id)).rejects.toThrow();
    await fixture().bot.update({ where: { id: other.id }, data: { computerId: null } });
    await share(bot.id);
    expect(
      (await fixture().bot.findUniqueOrThrow({ where: { id: bot.id } })).collaborationRestricted,
    ).toBe(true);
  });

  it("preserves requesters and authors while charging/executing as the owner and cancels only own queued requests", async () => {
    const bot = await makeBot("Queue");
    await share(bot.id);
    const send = (who: Actor, text: string) =>
      within(who, async () => {
        const target = await resolveThreadTarget(db.prisma, who, { botId: bot.id });
        return sendThreadMessage(
          { prisma: db.prisma, events: events as never, jobs: jobs as never },
          who,
          target,
          { text },
        );
      });
    const own = await send(owner, "Owner request");
    const colleague = await send(coworker, "Collaborator request");
    const nextColleague = await send(coworker, "Another collaborator request");
    const run = await fixture().run.findUniqueOrThrow({ where: { id: colleague.runId } });
    expect(run).toMatchObject({
      userId: owner.userId,
      requesterUserId: coworker.userId,
      status: "queued",
    });
    expect(await fixture().task.findUnique({ where: { id: run.taskId } })).toMatchObject({
      userId: owner.userId,
      requesterUserId: coworker.userId,
    });
    expect(
      await fixture().message.findUnique({ where: { id: run.sourceMessageId! } }),
    ).toMatchObject({ authorUserId: coworker.userId, authorName: "Fixture 1" });
    await within(coworker, async () => {
      const target = await resolveThreadTarget(db.prisma, coworker, { botId: bot.id });
      const deps = { prisma: db.prisma, events: events as never, sandbox: {} as never };
      await expect(stopThreadRuns(deps, coworker, target, own.runId)).rejects.toThrow();
      await fixture().run.update({ where: { id: colleague.runId }, data: { status: "running" } });
      await expect(stopThreadRuns(deps, coworker, target, colleague.runId)).rejects.toThrow();
      await fixture().run.update({ where: { id: colleague.runId }, data: { status: "queued" } });
      await stopThreadRuns(
        { prisma: db.prisma, events: events as never, sandbox: {} as never },
        coworker,
        target,
        colleague.runId,
      );
    });
    expect(await fixture().run.findUnique({ where: { id: colleague.runId } })).toMatchObject({
      status: "cancelled",
    });
    expect(await fixture().run.findUnique({ where: { id: own.runId } })).toMatchObject({
      status: "queued",
    });
    expect(await fixture().run.findUnique({ where: { id: nextColleague.runId } })).toMatchObject({
      status: "queued",
    });
    await within(owner, () => sharing().revoke(owner, { botId: bot.id, userId: coworker.userId }));
    await expect(
      within(coworker, () => resolveThreadTarget(db.prisma, coworker, { botId: bot.id })),
    ).rejects.toThrow();
    expect(
      await fixture().message.findUnique({ where: { id: run.sourceMessageId! } }),
    ).toMatchObject({ authorUserId: coworker.userId });
  });

  it("keeps read cursors private and revokes queued work without erasing authorship", async () => {
    const bot = await makeBot("Read state");
    await share(bot.id);
    const sent = await within(coworker, async () => {
      const target = await resolveThreadTarget(db.prisma, coworker, { botId: bot.id });
      const result = await sendThreadMessage(
        { prisma: db.prisma, events: events as never, jobs: jobs as never },
        coworker,
        target,
        { text: "Hello" },
      );
      await markThreadRead(db.prisma, coworker, target);
      return result;
    });
    const preferences = await fixture().botUserPreference.findMany({
      where: { botId: bot.id, userId: coworker.userId },
    });
    expect(preferences).toHaveLength(1);
    expect(preferences[0]).toMatchObject({ userId: coworker.userId, lastReadSeq: 0 });
    await within(owner, () => sharing().revoke(owner, { botId: bot.id, userId: coworker.userId }));
    expect(await fixture().run.findUnique({ where: { id: sent.runId } })).toMatchObject({
      status: "cancelled",
    });
    await within(coworker, async () => {
      expect(await db.prisma.message.findMany({ where: { threadId: bot.threadId } })).toEqual([]);
      expect(await db.prisma.botUserPreference.findMany({ where: { botId: bot.id } })).toEqual([]);
    });
  });

  it("transfers ownership explicitly, preserves history and resets account-dependent configuration", async () => {
    const bot = await makeBot("Transfer");
    await share(bot.id);
    await fixture().thread.update({
      where: { id: bot.threadId },
      data: { historyCompactionSummary: "Saved conversation summary" },
    });
    const stored = await fixture().bot.findUniqueOrThrow({ where: { id: bot.id } });
    const routine = await fixture().routine.create({
      data: {
        spaceId,
        botId: bot.id,
        userId: owner.userId,
        name: "Saved routine",
        prompt: "Use bot memory",
        crons: [],
        active: true,
      },
    });
    const skill = await fixture().taughtSkill.create({
      data: {
        spaceId,
        botId: bot.id,
        userId: owner.userId,
        name: "Saved skill",
        goal: "Use bot context",
        status: "saved",
      },
    });
    const file = await fixture().artifact.create({
      data: {
        spaceId,
        botId: bot.id,
        userId: owner.userId,
        name: "bot-context.txt",
        mimeType: "text/plain",
        size: 7,
        hash: "fixture",
        storageKey: `transfer-file-${id}`,
      },
    });
    await fixture().computer.update({
      where: { id: stored.computerId! },
      data: { homeRevision: "fixture-saved-home" },
    });
    await within(owner, () =>
      sharing().grant(owner, { botId: bot.id, userId: coworker.userId, canApprove: true }),
    );
    expect((await within(owner, () => sharing().get(owner, bot.id))).members[0]?.canApprove).toBe(
      true,
    );
    await within(owner, () =>
      sharing().transfer(owner, { botId: bot.id, userId: coworker.userId }),
    );
    await within(coworker, async () => {
      expect(await createRepos(db.prisma).getBot(coworker, bot.id)).toMatchObject({
        userId: coworker.userId,
        computerId: null,
        modelProvider: null,
        collaborationRestricted: true,
      });
      expect(
        await fixture().computer.findUniqueOrThrow({ where: { id: stored.computerId! } }),
      ).toMatchObject({ userId: owner.userId, homeRevision: "fixture-saved-home" });
      expect(
        await fixture().browserProfile.findUniqueOrThrow({ where: { botId: bot.id } }),
      ).toMatchObject({ userId: owner.userId });
      expect(
        await fixture().memoryDocument.findFirstOrThrow({ where: { botId: bot.id, scope: "bot" } }),
      ).toMatchObject({ userId: coworker.userId });
      expect(await fixture().thread.findUniqueOrThrow({ where: { botId: bot.id } })).toMatchObject({
        userId: coworker.userId,
        historyCompactionSummary: "Saved conversation summary",
      });
      expect(
        await fixture().routine.findUniqueOrThrow({ where: { id: routine.id } }),
      ).toMatchObject({ userId: coworker.userId, active: false, prompt: "Use bot memory" });
      expect(
        await fixture().taughtSkill.findUniqueOrThrow({ where: { id: skill.id } }),
      ).toMatchObject({ userId: coworker.userId, status: "saved" });
      expect(await fixture().artifact.findUniqueOrThrow({ where: { id: file.id } })).toMatchObject({
        userId: coworker.userId,
        storageKey: `transfer-file-${id}`,
      });
      await sharing().grant(coworker, { botId: bot.id, userId: users[2]! });
    });
    await within(owner, async () => {
      await expect(createRepos(db.prisma).getBot(owner, bot.id)).rejects.toThrow();
      expect(await getAccessibleBot(db.prisma, owner, bot.id)).toMatchObject({
        userId: coworker.userId,
      });
    });
  });

  it("shares only conversation attachments, not unposted bot files, and revokes their reads", async () => {
    const bot = await makeBot("Attachments");
    await share(bot.id);
    const artifact = await fixture().artifact.create({
      data: {
        spaceId,
        botId: bot.id,
        userId: owner.userId,
        name: "context.txt",
        mimeType: "text/plain",
        size: 7,
        hash: "fixture",
        storageKey: `sharing-file-${id}`,
      },
    });
    const store = { get: vi.fn(async () => new TextEncoder().encode("fixture")) };
    const read = () =>
      within(coworker, () =>
        getSpaceArtifactById({ prisma: db.prisma, artifacts: store as never }, coworker, {
          artifactId: artifact.id,
        }),
      );
    await expect(read()).rejects.toThrow();
    expect(store.get).not.toHaveBeenCalled();
    await fixture().message.create({
      data: {
        threadId: bot.threadId,
        seq: 0,
        role: "bot",
        botId: bot.id,
        blocks: [
          {
            kind: "file",
            artifactId: artifact.id,
            name: artifact.name,
            mimeType: artifact.mimeType,
            size: artifact.size,
          },
        ],
      },
    });
    expect(await read()).toMatchObject({ name: artifact.name });
    await within(owner, () => sharing().revoke(owner, { botId: bot.id, userId: coworker.userId }));
    await expect(read()).rejects.toThrow();
    expect(store.get).toHaveBeenCalledTimes(1);
  });

  it("denies old workers and rejects attaching unrelated bots after sharing", async () => {
    const bot = await makeBot("Rolling deployment");
    const other = await makeBot("Unrelated");
    await share(bot.id);
    const stored = await fixture().bot.findUniqueOrThrow({ where: { id: bot.id } });
    await expect(
      fixture().bot.update({
        where: { id: other.id },
        data: { computerId: stored.computerId },
      }),
    ).rejects.toThrow("unrelated");
    await expect(
      fixture().bot.update({
        where: { id: bot.id },
        data: { collaborationRestricted: false },
      }),
    ).rejects.toThrow("cannot be removed");
    const sent = await within(coworker, async () => {
      const target = await resolveThreadTarget(db.prisma, coworker, { botId: bot.id });
      return sendThreadMessage(
        { prisma: db.prisma, events: events as never, jobs: jobs as never },
        coworker,
        target,
        { text: "Work" },
      );
    });
    const claimed = await fixture().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.rls_version', '2', true)`;
      return tx.run.updateMany({ where: { id: sent.runId }, data: { status: "leased" } });
    });
    expect(claimed.count).toBe(0);
    expect(await fixture().run.findUnique({ where: { id: sent.runId } })).toMatchObject({
      status: "queued",
    });
  });
});
