import type { Actor } from "@rakazo/contracts";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { runAsSystemInTransaction } from "./row-security.js";
import { IsolationError } from "./scope.js";

type Client = PrismaClient | Prisma.TransactionClient;

export function accessibleBotWhere(actor: Pick<Actor, "spaceId" | "userId">) {
  return {
    spaceId: actor.spaceId,
    OR: [
      { userId: actor.userId },
      { collaborators: { some: { userId: actor.userId, spaceId: actor.spaceId } } },
    ],
    space: {
      memberships: { some: { userId: actor.userId } },
    },
  };
}

/** Unlike getBot, this grants conversation access only, never settings or computer access. */
export async function getAccessibleBot(
  prisma: Client,
  actor: Actor,
  botId: string,
  options: { includeArchived?: boolean } = {},
) {
  const owned = await prisma.bot.findFirst({
    where: {
      id: botId,
      spaceId: actor.spaceId,
      userId: actor.userId,
      ...(options.includeArchived ? {} : { archivedAt: null }),
    },
    include: { thread: true, computer: true },
  });
  if (owned) return owned;
  const bot = await prisma.bot.findFirst({
    where: {
      id: botId,
      ...accessibleBotWhere(actor),
      ...(options.includeArchived ? {} : { archivedAt: null }),
    },
    include: { thread: true, computer: true },
  });
  if (!bot) throw new IsolationError();
  return bot;
}

async function lockOwnedBot(tx: Prisma.TransactionClient, actor: Actor, botId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM bots WHERE id = ${botId} AND "spaceId" = ${actor.spaceId}
      AND "userId" = ${actor.userId} FOR UPDATE`;
  if (rows.length !== 1) throw new IsolationError();
  const bot = await tx.bot.findUniqueOrThrow({
    where: { id: botId },
    include: { computer: true, thread: true },
  });
  return bot;
}

async function eligibleMember(tx: Client, actor: Actor, userId: string) {
  const member = await tx.spaceMember.findFirst({
    where: {
      spaceId: actor.spaceId,
      userId,
      space: { memberships: { some: { userId: actor.userId } } },
    },
    include: { member: { include: { user: { select: { name: true } } } } },
  });
  if (!member) throw new IsolationError();
  return member;
}

export function createBotSharing(prisma: PrismaClient) {
  return {
    async get(actor: Actor, botId: string) {
      const bot = await getAccessibleBot(prisma, actor, botId, { includeArchived: true });
      if (bot.userId !== actor.userId) throw new IsolationError();
      const [members, eligible] = await Promise.all([
        prisma.botCollaborator.findMany({ where: { botId, spaceId: actor.spaceId } }),
        prisma.spaceMember.findMany({
          where: { spaceId: actor.spaceId, userId: { not: bot.userId } },
          include: { member: { include: { user: { select: { name: true } } } } },
        }),
      ]);
      const names = new Map(eligible.map((item) => [item.userId, item.member.user.name]));
      return {
        members: members
          .filter((item) => names.has(item.userId))
          .map((item) => ({
            userId: item.userId,
            name: names.get(item.userId)!,
            canApprove: item.canApprove,
          })),
        eligibleMembers: eligible.map((item) => ({
          userId: item.userId,
          name: item.member.user.name,
        })),
      };
    },

    async grant(actor: Actor, input: { botId: string; userId: string; canApprove?: boolean }) {
      await prisma.$transaction(async (tx) => {
        const bot = await lockOwnedBot(tx, actor, input.botId);
        if (bot.thread)
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${bot.thread.id} FOR UPDATE`;
        if (bot.userId === input.userId || bot.archivedAt) throw new IsolationError();
        await eligibleMember(tx, actor, input.userId);
        // A shared conversation must never expose another bot's machine or a host account.
        if (
          bot.computer &&
          (bot.computer.scope !== "dedicated" ||
            bot.computer.kind === "desktop" ||
            bot.computer.homeKey !== bot.id ||
            bot.computer.userId !== actor.userId ||
            bot.computer.spaceId !== actor.spaceId)
        )
          throw new IsolationError("Sharing requires a dedicated bot computer");
        if (!bot.computer && !bot.collaborationRestricted)
          throw new IsolationError("Sharing requires a dedicated bot computer");
        if (bot.computer)
          await tx.$queryRaw`SELECT id FROM computers WHERE id = ${bot.computer.id} FOR UPDATE`;
        const unrelated = bot.computer
          ? await runAsSystemInTransaction(tx, "check shared bot computer isolation", () =>
              tx.bot.count({ where: { computerId: bot.computer!.id, id: { not: bot.id } } }),
            )
          : 0;
        const active = await tx.run.count({
          where: {
            botId: bot.id,
            status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
          },
        });
        if (unrelated || active || bot.computerSwitching)
          throw new IsolationError("Finish active work before sharing a dedicated bot");
        await tx.bot.update({
          where: { id: bot.id },
          data: { collaborationRestricted: true, memoryScope: "isolated" },
        });
        await tx.botUserPreference.upsert({
          where: { botId_userId: { botId: bot.id, userId: actor.userId } },
          create: {
            botId: bot.id,
            userId: actor.userId,
            spaceId: actor.spaceId,
            pinned: bot.pinned,
            sectionId: bot.sectionId,
            notifyOnFinish: bot.notifyOnFinish,
            autoSpeak: bot.autoSpeak,
            lastReadSeq: bot.thread?.lastReadSeq ?? -1,
            manualUnread: bot.thread?.unread ?? false,
          },
          update: {},
        });
        await tx.botCollaborator.upsert({
          where: { botId_userId: { botId: bot.id, userId: input.userId } },
          create: {
            botId: bot.id,
            spaceId: actor.spaceId,
            userId: input.userId,
            canApprove: input.canApprove ?? false,
          },
          update: input.canApprove === undefined ? {} : { canApprove: input.canApprove },
        });
      });
    },

    async revoke(actor: Actor, input: { botId: string; userId: string }) {
      return prisma.$transaction(async (tx) => {
        const bot = await lockOwnedBot(tx, actor, input.botId);
        if (bot.thread)
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${bot.thread.id} FOR UPDATE`;
        await tx.botCollaborator.deleteMany({ where: { botId: bot.id, userId: input.userId } });
        const queued = await tx.run.findMany({
          where: { botId: bot.id, requesterUserId: input.userId, status: "queued" },
          select: { id: true, taskId: true, userId: true, spaceId: true },
        });
        await cancelRunsInTransaction(tx, queued, new Date());
        let eventSeq: number | null = null;
        if (bot.thread) {
          for (const run of queued) {
            const event = await appendEventInTransaction(tx, {
              spaceId: actor.spaceId,
              botId: bot.id,
              threadId: bot.thread.id,
              runId: run.id,
              type: "run.cancelled",
              payload: {},
            });
            eventSeq = event.seq;
          }
        }
        // Delete queued inputs, not messages: authorship is permanent history.
        await tx.steeringMessage.deleteMany({
          where: { botId: bot.id, userId: input.userId, claimedAt: null },
        });
        return { threadId: bot.thread?.id, eventSeq };
      });
    },

    async transfer(actor: Actor, input: { botId: string; userId: string }) {
      await prisma.$transaction(async (tx) => {
        const bot = await lockOwnedBot(tx, actor, input.botId);
        if (input.userId === bot.userId) return;
        if (bot.thread)
          await tx.$queryRaw`SELECT id FROM threads WHERE id = ${bot.thread.id} FOR UPDATE`;
        await eligibleMember(tx, actor, input.userId);
        const active = await tx.run.count({
          where: {
            botId: bot.id,
            status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
          },
        });
        if (!bot.collaborationRestricted || active || bot.computerSwitching)
          throw new IsolationError("Transfer requires an idle shared bot");
        await tx.botCollaborator.upsert({
          where: { botId_userId: { botId: bot.id, userId: actor.userId } },
          create: { botId: bot.id, userId: actor.userId, spaceId: actor.spaceId },
          update: { canApprove: false },
        });
        await tx.botCollaborator.deleteMany({ where: { botId: bot.id, userId: input.userId } });
        // Ownership changes need no account-resource access, and never move credentials.
        await runAsSystemInTransaction(
          tx,
          "transfer explicitly authorized shared bot ownership",
          async () => {
            await tx.botMcpServer.deleteMany({ where: { botId: bot.id } });
            await tx.botSecret.deleteMany({ where: { botId: bot.id } });
            await tx.routine.updateMany({
              where: { botId: bot.id },
              data: {
                userId: input.userId,
                active: false,
                webhookEnabled: false,
                githubEnabled: false,
                nextRunAt: null,
                modelProvider: null,
                modelId: null,
                thinkingLevel: null,
                messageProvider: null,
              },
            });
            await tx.bot.update({
              where: { id: bot.id },
              data: {
                userId: input.userId,
                computerId: null,
                sectionId: null,
                parentBotId: null,
                spawnKey: null,
                modelProvider: null,
                modelId: null,
                thinkingLevel: null,
                webhookSecretId: null,
                teamChatAmbientEnabled: false,
                crossSpaceCommunication: false,
                fleetManagement: false,
              },
            });
            if (bot.thread)
              await tx.thread.update({
                where: { id: bot.thread.id },
                data: {
                  userId: input.userId,
                  historyCompactionSummary: bot.thread.historyCompactionSummary,
                },
              });
            const documents = await tx.memoryDocument.findMany({
              where: { botId: bot.id, scope: "bot" },
            });
            for (const document of documents)
              await tx.memoryDocument.update({
                where: { id: document.id },
                data: { userId: input.userId, content: document.content },
              });
            await tx.taughtSkill.updateMany({
              where: { botId: bot.id },
              data: { userId: input.userId },
            });
            await tx.scratchpadItem.updateMany({
              where: { botId: bot.id },
              data: { userId: input.userId },
            });
            await tx.artifact.updateMany({
              where: { botId: bot.id, groupId: null },
              data: { userId: input.userId },
            });
          },
        );
      });
    },
  };
}
