import type { AgentRunRequest, ComputerRef } from "@rakazo/adapter-kit";
import { SandboxRateLimitError } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { createLogger, createTestSink, installLogger } from "@rakazo/logging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";

const sink = createTestSink();

const provisionComputer = vi.hoisted(() => vi.fn());

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  acquireDedicatedScreenLeaseFence: async () => null,
  provisionComputer,
}));

const COMPUTER: ComputerRef = {
  id: "sandbox-1",
  botId: "home-1",
  kind: "e2b",
  providerRef: "sandbox-1",
};

/** A routine run whose model makes the given tool calls, then answers. */
async function runRoutine(
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>,
  options: {
    takeover?: boolean;
    native?: boolean;
    nativeUnavailable?: boolean;
    toolFailure?: "abort" | "recover";
    attachments?: "file" | "image";
    steering?: boolean;
    steeringAfterFirst?: boolean;
    copyFailureOnce?: boolean;
    parallel?: boolean;
    priorSetupFailures?: number;
    exportError?: Error;
    setupError?: Error;
    onRunStarted?: () => void;
    shared?: boolean;
    sharedOwner?: boolean;
    revoked?: boolean;
    revokedMembership?: boolean;
    scripted?: boolean;
    executionUserId?: string;
    otherComputerBot?: boolean;
    taughtSkills?: boolean;
    semanticMemory?: boolean;
    approvedShell?: boolean;
    noComputer?: boolean;
    computerOwner?: string;
    computerSpace?: string;
    teamComputer?: boolean;
    botCommandSecret?: boolean;
    revokeAfterFirst?: boolean;
    detachAfterFirst?: boolean;
    browser?: boolean;
  } = {},
) {
  const attachment: Extract<MessageBlock, { kind: "file" | "image" }> = {
    kind: options.attachments ?? "file",
    artifactId: "artifact-1",
    name: "private-upload.png",
    mimeType: options.attachments === "image" ? "image/png" : "text/plain",
    size: 4,
  };
  const run = {
    id: "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: options.executionUserId ?? "user-1",
    requesterUserId: options.shared ? (options.sharedOwner ? "user-1" : "coworker") : undefined,
    status: "queued",
    trigger: options.attachments && !options.steering ? "user" : "routine",
    sourceMessageId: options.attachments && !options.steering ? "message-1" : null,
    routineId: "routine-1",
    retryOfRunId: null,
    leaseFence: 0,
  };
  const toolResults: unknown[] = [];
  const approvedShellEffect = {
    id: "shell-effect",
    runId: run.id,
    spaceId: run.spaceId,
    kind: "shell",
    status: "approved",
    idempotencyKey: "approved-shell",
    request: { command: "printf bot-work" },
  };
  const steeringInputs: unknown[] = [];
  let revoked = options.revoked;
  let noComputer = options.noComputer;
  const runtimeRun = vi.fn(async function* (request: AgentRunRequest) {
    if (options.steering && !options.steeringAfterFirst) {
      steeringInputs.push(...((await request.claimSteering?.([])) ?? []));
    }
    const execute = async (call: (typeof toolCalls)[number], index: number) => {
      try {
        toolResults.push(await request.executeTool?.(call.name, call.args, `exec-${index}`));
      } catch (error) {
        if (!options.toolFailure) throw error;
      }
      if (index === 0 && options.steeringAfterFirst) {
        steeringInputs.push(...((await request.claimSteering?.([])) ?? []));
      }
      if (index === 0 && options.revokeAfterFirst) revoked = true;
      if (index === 0 && options.detachAfterFirst) noComputer = true;
      if (options.toolFailure === "abort") throw new DOMException("Aborted", "AbortError");
    };
    if (options.parallel) await Promise.all(toolCalls.map(execute));
    else for (const [index, call] of toolCalls.entries()) await execute(call, index);
    if (options.takeover) {
      yield { type: "takeover" as const, reason: "Sign in to the inbox." };
      return;
    }
    yield { type: "text-delta" as const, text: "Inbox is clear." };
    yield { type: "done" as const, text: "Inbox is clear." };
  });
  const prisma = {
    run: {
      findUnique: vi.fn(async () => run),
      findUniqueOrThrow: vi.fn(async () => run),
      findFirst: vi.fn(async () => ({
        bot: { notifyOnFinish: false },
        thread: { groupId: null },
      })),
      updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    routine: { findUnique: vi.fn(async () => ({ notify: false, nextRunAt: null })) },
    event: { count: vi.fn(async () => 0) },
    bot: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.botId,
        userId: "user-1",
        spaceId: "space-1",
        homeKey: "previous-owner-home",
        collaborationRestricted: options.shared ?? false,
        name: "Assistant",
        title: "Assistant",
        description: "Test assistant",
        modelProvider: null,
        modelId: null,
        thinkingLevel: null,
        computerId: noComputer ? null : "computer-1",
        computerSwitching: false,
        memoryScope: null,
        computer: noComputer
          ? null
          : {
              id: "computer-1",
              scope: options.teamComputer ? "team" : "dedicated",
              kind: options.native ? "desktop" : "e2b",
              homeKey: "home-1",
              userId: options.computerOwner ?? "user-1",
              spaceId: options.computerSpace ?? "space-1",
            },
      })),
      findUnique: vi.fn(async () => ({ name: "Assistant" })),
      findMany: vi.fn(async () =>
        options.shared
          ? [{ id: run.botId }, ...(options.otherComputerBot ? [{ id: "other-bot" }] : [])]
          : [],
      ),
    },
    attempt: {
      create: vi.fn(async () => ({ id: "attempt-1" })),
      findMany: vi.fn(async () =>
        Array.from({ length: options.priorSetupFailures ?? 0 }, () => ({
          status: "setup_failed",
          error: "Run setup failed; retrying",
        })),
      ),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: {
      findUniqueOrThrow: vi.fn(async () => ({
        id: run.threadId,
        groupId: null,
        historyCompactionSummary: null,
        historyCompactedUpToSeq: null,
        nextMessageSeq: 1,
      })),
    },
    message: {
      findMany: vi.fn(async () =>
        options.attachments && !options.steering
          ? [
              {
                id: "message-1",
                role: "user",
                runId: run.id,
                seq: 1,
                blocks: [attachment],
              },
            ]
          : [],
      ),
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
    botCollaborator: {
      findFirst: vi.fn(async () => (revoked ? null : { userId: "coworker" })),
    },
    spaceMember: {
      findUnique: vi.fn(async () => (options.revokedMembership ? null : { id: "membership-1" })),
    },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({ id: run.taskId, prompt: "Sweep the inbox" })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
    connection: { findMany: vi.fn(async () => []) },
    spaceModelPreference: { findFirst: vi.fn(async () => null) },
    secret: { findFirst: vi.fn(async () => null) },
    userModelCredential: { findFirst: vi.fn(async () => null) },
    spaceBackupModel: { findMany: vi.fn(async () => []) },
    deploymentSettings: {
      findUnique: vi.fn(async () => ({
        defaultModelProvider: "openrouter",
        defaultModelId: "deepseek/deepseek-v4-flash-0731",
      })),
    },
    taughtSkill: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () =>
        options.taughtSkills
          ? [
              {
                id: "taught-1",
                name: "Export report",
                goal: "Export report",
                playbook: { steps: [] },
              },
            ]
          : [],
      ),
    },
    agentSecret: { findMany: vi.fn(async () => []) },
    botSecret: {
      findMany: vi.fn(async () =>
        options.botCommandSecret
          ? [
              {
                id: "bot-secret-1",
                name: "bot-token",
                auth: { type: "command" },
                ciphertext: "fake-bot-ciphertext",
              },
            ]
          : [],
      ),
    },
    agentSkill: { findMany: vi.fn(async () => []) },
    scratchpadItem: { findMany: vi.fn(async () => []) },
    externalEffect: {
      findMany: vi.fn(async (query?: { where?: { status?: unknown } }) =>
        options.approvedShell && query?.where?.status === "approved" ? [approvedShellEffect] : [],
      ),
      findUnique: vi.fn(async () => (options.approvedShell ? approvedShellEffect : null)),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "effect-1",
        ...data,
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    artifact: {
      findMany: vi.fn(async () =>
        options.attachments
          ? [
              {
                id: "artifact-1",
                storageKey: "private-storage-key",
                name: attachment.name,
                mimeType: attachment.mimeType,
                size: 4,
              },
            ]
          : [],
      ),
    },
  };
  const sandbox = {
    describe: () => ({ id: "e2b", capabilities: { graphical: options.browser ?? false } }),
    environment: options.native
      ? vi.fn(async () => {
          if (options.nativeUnavailable) throw new Error("native app is closed");
          return { platform: "win32", home: "C:\\Users\\example", shell: "powershell.exe" };
        })
      : undefined,
    listFiles: vi.fn(async () => [{ path: "notes.txt", kind: "file", size: 4 }]),
    execute: vi.fn(async function* () {
      yield { type: "stdout" as const, data: "bot-work" };
      yield { type: "exit" as const, code: 0 };
    }),
    writeFile: vi.fn(async () => undefined),
    releaseScreen: vi.fn(async () => undefined),
    exportWorkspace: vi.fn(async function* () {
      if (options.exportError) throw options.exportError;
      yield* [];
    }),
  };
  if (options.copyFailureOnce)
    sandbox.writeFile.mockRejectedValueOnce(new Error("temporary copy failure"));
  const finalizeRun = vi.fn(async () => ({ continuationRunId: null }));
  const enqueue = vi.fn(async () => undefined);
  const memoryRead = vi.fn(async (_input: { scope: string }) => ({ documents: [] }));
  const memoryCommit = vi.fn(async () => ({ revision: 1 }));
  const semanticMemory = {
    recall: vi.fn(async () => ({ ok: true, value: [] })),
    save: vi.fn(async () => ({ ok: true, value: { id: "fact-1" } })),
  };
  const discoverTools = vi.fn(async () => []);
  const secretLoad = vi.fn(async (_ciphertext: string) => "fake-bot-command-value");
  const browser = {
    describe: () => ({ capabilities: { page: true } }),
    snapshot: vi.fn(async () => ({
      url: "https://example.test",
      title: "Bot page",
      tree: "page",
      elements: [],
    })),
  };
  const executor = createRunExecutor({
    prisma: withEmptyModels(prisma),
    deploymentModelKey: "fake-deployment-key",
    runtime: {
      describe: () => ({ capabilities: { scripted: options.scripted ?? false } }),
      run: runtimeRun,
    },
    sandbox,
    ...(options.browser ? { browser } : {}),
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: memoryRead, commit: memoryCommit },
    memoryProviders: {
      resolve: async () => {
        if (options.setupError) throw options.setupError;
        return options.semanticMemory ? { defaultScope: "shared", provider: semanticMemory } : null;
      },
    },
    artifacts: { get: vi.fn(async () => new Uint8Array([1, 2, 3, 4])) },
    events: {
      append: vi.fn(async () => undefined),
      claimSteering: vi.fn(async () => [
        { id: "steering-1", messageId: "message-2", text: "Look at this", blocks: [attachment] },
      ]),
      finalizeRun,
      pauseRunForTakeover: vi.fn(async () => false),
    },
    jobs: { enqueue },
    notifications: { send: vi.fn(async () => undefined) },
    secrets: [],
    secretStore: { load: secretLoad },
    connector: {
      describe: () => ({ id: "connector-registry" }),
      discoverTools,
    },
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  await executor.continueRun(
    run.id,
    "worker-1",
    options.onRunStarted
      ? () => {
          expect(run.status).toBe("running");
          options.onRunStarted!();
        }
      : undefined,
  );
  const sleepJobs = enqueue.mock.calls
    .map((call) => (call as unknown[])[0] as { name: string })
    .filter((job) => job.name === "computer.sleep");
  return {
    finalizeRun,
    sandbox,
    sleepJobs,
    toolResults,
    enqueue,
    runtimeRun,
    steeringInputs,
    prisma,
    run,
    memoryRead,
    memoryCommit,
    semanticMemory,
    discoverTools,
    secretLoad,
    browser,
  };
}

beforeEach(() => {
  sink.events.length = 0;
  installLogger(createLogger({ service: "test", sinks: [sink] }));
  provisionComputer.mockReset();
  provisionComputer.mockResolvedValue(COMPUTER);
});

it.each([false, true])("restores dedicated browser tools (owner: %s)", async (sharedOwner) => {
  const { runtimeRun, browser, toolResults, finalizeRun } = await runRoutine(
    [{ name: "browser_snapshot", args: {} }],
    { shared: true, sharedOwner, browser: true },
  );
  expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
  expect(runtimeRun.mock.calls[0]?.[0].tools?.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(["browser_navigate", "browser_snapshot", "browser_act"]),
  );
  expect(toolResults[0]).toEqual(expect.objectContaining({ title: "Bot page" }));
  expect(browser.snapshot).toHaveBeenCalledWith(
    COMPUTER,
    expect.any(Object),
    expect.objectContaining({ collaborationRestricted: true }),
  );
});

afterEach(() => {
  vi.clearAllMocks();
  installLogger(createLogger({ service: "test", level: "off", sinks: [] }));
});

describe("run computer provisioning", () => {
  it.each([false, true])("isolates shared requests (owner: %s)", async (sharedOwner) => {
    const { runtimeRun, finalizeRun, prisma, memoryRead, discoverTools } = await runRoutine([], {
      shared: true,
      sharedOwner,
    });
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    const tools = runtimeRun.mock.calls[0]?.[0].tools?.map((tool) => tool.name);
    expect(tools).toEqual(
      expect.arrayContaining(["list_files", "shell", "remember", "skill_read"]),
    );
    expect(tools).not.toContain("save_shared_memory");
    expect(tools).not.toContain("skill_update");
    expect(prisma.connection.findMany).not.toHaveBeenCalled();
    expect(prisma.agentSecret.findMany).not.toHaveBeenCalled();
    expect(prisma.agentSkill.findMany).not.toHaveBeenCalled();
    expect(discoverTools).not.toHaveBeenCalled();
    expect(prisma.bot.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { computerId: "computer-1" },
      select: { id: true },
    });
    expect(memoryRead).toHaveBeenCalledTimes(1);
    expect(memoryRead.mock.calls[0]?.[0]).toEqual({ scope: "bot", botId: "bot-1" });
    expect(provisionComputer).not.toHaveBeenCalled();
  });

  it.each([
    "save_shared_memory",
    "list_fleet",
    "board_tickets",
    "search_history",
    "read_history",
    "connect_app",
    "skill_update",
    "cloud_agent_launch",
    "message_bot",
    "catalog_execute",
    "mcp__assigned__echo",
  ])("rejects hidden %s even if a runtime calls it", async (name) => {
    const { finalizeRun, sandbox, toolResults } = await runRoutine(
      [{ name, args: { path: "MEMORY.md", content: "forbidden" } }],
      { shared: true },
    );
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(toolResults).toEqual([{ error: expect.any(String) }]);
    expect(sandbox.writeFile).not.toHaveBeenCalled();
    expect(provisionComputer).not.toHaveBeenCalled();
  });

  it.each([false, true])("runs bot files/memory (owner: %s)", async (sharedOwner) => {
    const { finalizeRun, sandbox, memoryRead, memoryCommit, toolResults } = await runRoutine(
      [
        { name: "list_files", args: { path: "" } },
        { name: "write_file", args: { path: "notes.txt", content: "bot output" } },
        { name: "remember", args: { path: "MEMORY.md", content: "bot fact" } },
      ],
      { shared: true, sharedOwner },
    );
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(sandbox.listFiles).toHaveBeenCalledOnce();
    expect(sandbox.writeFile).toHaveBeenCalledOnce();
    expect(memoryCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "bot",
        botId: "bot-1",
        path: "MEMORY.md",
      }),
      expect.objectContaining({ collaborationRestricted: true, botId: "bot-1" }),
    );
    expect(toolResults).toHaveLength(3);
    expect(memoryRead.mock.calls.every(([request]) => request.scope === "bot")).toBe(true);
  });

  it("reads only bot-taught skills, never arbitrary personal skill IDs", async () => {
    const { toolResults, prisma } = await runRoutine(
      [
        { name: "skill_read", args: { skillId: "taught-1" } },
        { name: "skill_read", args: { skillId: "owner-personal-skill" } },
      ],
      { shared: true, taughtSkills: true },
    );
    expect(toolResults[0]).toEqual(expect.objectContaining({ id: "taught-1" }));
    expect(toolResults[1]).toEqual({ error: expect.any(String) });
    expect(prisma.agentSkill.findMany).not.toHaveBeenCalled();
  });

  it.each([false, true])("isolates semantic memory (owner: %s)", async (sharedOwner) => {
    const { semanticMemory, toolResults } = await runRoutine(
      [
        { name: "save_memory", args: { content: "bot fact" } },
        { name: "recall_memory", args: { query: "bot fact" } },
        { name: "save_memory", args: { content: "not allowed", scope: "shared" } },
      ],
      { shared: true, sharedOwner, semanticMemory: true },
    );
    expect(semanticMemory.save).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ botId: "bot-1", scope: "isolated", content: "bot fact" }),
      expect.objectContaining({ collaborationRestricted: true }),
    );
    expect(semanticMemory.recall).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ botId: "bot-1", scope: "isolated" }),
      expect.objectContaining({ collaborationRestricted: true }),
    );
    expect(toolResults[2]).toEqual({ error: expect.any(String) });
  });

  it.each([false, true])("uses only bot secrets (owner: %s)", async (sharedOwner) => {
    const { sandbox, finalizeRun, toolResults, prisma, secretLoad } = await runRoutine(
      [{ name: "shell", args: { command: "printf bot-work" } }],
      { shared: true, sharedOwner, approvedShell: true, botCommandSecret: true },
    );
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(sandbox.execute).toHaveBeenCalledOnce();
    expect(toolResults[0]).toEqual(expect.objectContaining({ stdout: "bot-work" }));
    expect(prisma.agentSecret.findMany).not.toHaveBeenCalled();
    expect(sandbox.execute).toHaveBeenCalledWith(
      COMPUTER,
      expect.objectContaining({ env: { BOT_TOKEN: "fake-bot-command-value" } }),
      expect.objectContaining({ collaborationRestricted: true }),
    );
    expect(
      secretLoad.mock.calls.every(([ciphertext]) => ciphertext === "fake-bot-ciphertext"),
    ).toBe(true);
    expect(prisma.botSecret.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", spaceId: "space-1", botId: "bot-1" },
      }),
    );
  });

  it("refuses a shared bot computer assigned to another bot", async () => {
    const { run, runtimeRun } = await runRoutine([], { shared: true, otherComputerBot: true });
    expect(run.status).toBe("cancelled");
    expect(runtimeRun).not.toHaveBeenCalled();
    expect(provisionComputer).not.toHaveBeenCalled();
  });

  it.each([
    { native: true },
    { teamComputer: true },
    { computerOwner: "previous-owner" },
    { computerSpace: "other-space" },
  ])("refuses an invalid shared computer: %j", async (options) => {
    const { run, runtimeRun } = await runRoutine([], { shared: true, ...options });
    expect(run.status).toBe("cancelled");
    expect(runtimeRun).not.toHaveBeenCalled();
    expect(provisionComputer).not.toHaveBeenCalled();
  });

  it.each([false, true])("allows detached bot memory (owner: %s)", async (sharedOwner) => {
    const { runtimeRun, finalizeRun, toolResults, memoryCommit, sandbox } = await runRoutine(
      [
        { name: "remember", args: { content: "transferred bot fact" } },
        { name: "list_files", args: { path: "" } },
        { name: "shell", args: { command: "printf bot-work" } },
      ],
      { shared: true, sharedOwner, noComputer: true },
    );
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    const tools = runtimeRun.mock.calls[0]?.[0].tools?.map((tool) => tool.name);
    expect(tools).toContain("remember");
    expect(tools).not.toContain("shell");
    expect(tools).not.toContain("list_files");
    expect(memoryCommit).toHaveBeenCalled();
    expect(toolResults.slice(1)).toEqual([
      { error: expect.any(String) },
      { error: expect.any(String) },
    ]);
    expect(sandbox.listFiles).not.toHaveBeenCalled();
    expect(sandbox.execute).not.toHaveBeenCalled();
    expect(provisionComputer).not.toHaveBeenCalled();
  });

  it("cannot recover the previous owner's home through a no-computer takeover", async () => {
    const { finalizeRun } = await runRoutine([], {
      shared: true,
      noComputer: true,
      takeover: true,
    });
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    expect(provisionComputer).not.toHaveBeenCalled();
  });

  it("rechecks collaboration before each dispatched tool", async () => {
    const { sandbox } = await runRoutine(
      [
        { name: "list_files", args: {} },
        { name: "write_file", args: { path: "notes.txt", content: "not allowed" } },
      ],
      { shared: true, revokeAfterFirst: true, toolFailure: "recover" },
    );
    expect(sandbox.listFiles).toHaveBeenCalledOnce();
    expect(sandbox.writeFile).not.toHaveBeenCalled();
  });

  it("rejects a detached computer even after it was provisioned", async () => {
    const { sandbox } = await runRoutine(
      [
        { name: "list_files", args: {} },
        { name: "write_file", args: { path: "notes.txt", content: "not allowed" } },
      ],
      { shared: true, detachAfterFirst: true, toolFailure: "recover" },
    );
    expect(sandbox.listFiles).toHaveBeenCalledOnce();
    expect(sandbox.writeFile).not.toHaveBeenCalled();
    expect(provisionComputer).toHaveBeenCalledOnce();
  });

  it("accepts collaborator image context only from the explicitly shared bot", async () => {
    const { prisma, runtimeRun, finalizeRun } = await runRoutine([], {
      shared: true,
      attachments: "image",
    });
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(runtimeRun.mock.calls[0]?.[0].currentTurnImages).toHaveLength(1);
    expect(prisma.artifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: "bot-1",
          groupId: null,
          bot: { userId: "user-1", collaborationRestricted: true },
        }),
      }),
    );
  });

  it.each([
    { revoked: true },
    { revokedMembership: true },
    { revokedMembership: true, sharedOwner: true },
    { executionUserId: "coworker" },
  ])(
    "cancels a shared request before execution when authorization is invalid: %j",
    async (options) => {
      const { runtimeRun, run } = await runRoutine([], { shared: true, ...options });
      expect(run.status).toBe("cancelled");
      expect(runtimeRun).not.toHaveBeenCalled();
      expect(provisionComputer).not.toHaveBeenCalled();
    },
  );

  it("refuses a scripted runtime for shared requests", async () => {
    const { runtimeRun, finalizeRun } = await runRoutine([], { shared: true, scripted: true });
    expect(runtimeRun).not.toHaveBeenCalled();
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  });

  it("retries handed-off setup failures with durable attempt accounting and backoff", async () => {
    const onRunStarted = vi.fn();
    const { run, enqueue, runtimeRun, prisma } = await runRoutine([], {
      setupError: new Error("fixture setup outage"),
      onRunStarted,
    });
    expect(onRunStarted).toHaveBeenCalledExactlyOnceWith();
    expect(runtimeRun).not.toHaveBeenCalled();
    expect(run.status).toBe("queued");
    expect(prisma.attempt.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "setup_failed" }),
      }),
    );
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: "run.continue",
        payload: { runId: run.id },
        availableAt: expect.any(Date),
      }),
    );
  });

  it("retains the setup-failure limit after handing off a run", async () => {
    const onRunStarted = vi.fn();
    const { enqueue, finalizeRun } = await runRoutine([], {
      setupError: new Error("fixture setup outage"),
      onRunStarted,
      priorSetupFailures: 7,
    });
    expect(onRunStarted).toHaveBeenCalledExactlyOnceWith();
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("never starts the computer for a run that does not use it", async () => {
    const { finalizeRun, sandbox, sleepJobs } = await runRoutine([]);

    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(provisionComputer).not.toHaveBeenCalled();
    expect(sandbox.releaseScreen).not.toHaveBeenCalled();
    expect(sleepJobs).toEqual([]);
  });

  it.each(["file", "image"] as const)(
    "keeps %s attachments lazy and images available to the model",
    async (attachments) => {
      const { finalizeRun, sandbox, runtimeRun } = await runRoutine([], { attachments });
      expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
      expect(provisionComputer).not.toHaveBeenCalled();
      expect(sandbox.writeFile).not.toHaveBeenCalled();
      if (attachments === "image") {
        expect(runtimeRun.mock.calls[0]?.[0].currentTurnImages).toEqual([
          expect.objectContaining({ mimeType: "image/png", data: new Uint8Array([1, 2, 3, 4]) }),
        ]);
      }
      expect(sink.events).toContainEqual(
        expect.objectContaining({ message: "run.computer", reason: "none", ready: false }),
      );
      expect(JSON.stringify(sink.events)).not.toContain("private-upload");
      expect(JSON.stringify(sink.events)).not.toContain("private-storage-key");
    },
  );

  it.each([false, true])(
    "copies pending attachments before the first tool, including steering: %s",
    async (steering) => {
      const { finalizeRun, sandbox } = await runRoutine(
        [
          { name: "list_files", args: { path: "" } },
          { name: "list_files", args: { path: "" } },
        ],
        { attachments: "file", steering },
      );
      expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
      expect(provisionComputer).toHaveBeenCalledOnce();
      expect(sandbox.writeFile).toHaveBeenCalledOnce();
      expect(sandbox.writeFile.mock.invocationCallOrder[0]).toBeLessThan(
        sandbox.listFiles.mock.invocationCallOrder[0]!,
      );
      expect(sink.events.filter((event) => event.message === "computer.requested")).toEqual([
        expect.objectContaining({ reason: "tool", tool: "list_files" }),
      ]);
    },
  );

  it("shares provisioning and copies attachments once across parallel tools", async () => {
    const { sandbox, finalizeRun } = await runRoutine(
      [
        { name: "list_files", args: { path: "" } },
        { name: "list_files", args: { path: "" } },
      ],
      { attachments: "file", parallel: true },
    );
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(provisionComputer).toHaveBeenCalledOnce();
    expect(sandbox.writeFile).toHaveBeenCalledOnce();
    expect(sandbox.listFiles).toHaveBeenCalledTimes(2);
  });

  it("retries a transient attachment copy before a later tool without reprovisioning", async () => {
    const { sandbox, finalizeRun } = await runRoutine(
      [
        { name: "list_files", args: { path: "" } },
        { name: "list_files", args: { path: "" } },
      ],
      { attachments: "file", copyFailureOnce: true, toolFailure: "recover" },
    );
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(provisionComputer).toHaveBeenCalledOnce();
    expect(sandbox.writeFile).toHaveBeenCalledTimes(2);
    expect(sandbox.listFiles).toHaveBeenCalledOnce();
  });

  it("delivers steering text and inline images without copying onto an already-started computer", async () => {
    const { sandbox, finalizeRun, steeringInputs } = await runRoutine(
      [{ name: "list_files", args: { path: "" } }],
      { attachments: "image", steering: true, steeringAfterFirst: true, copyFailureOnce: true },
    );
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(provisionComputer).toHaveBeenCalledOnce();
    expect(sandbox.writeFile).not.toHaveBeenCalled();
    expect(steeringInputs).toEqual([
      expect.objectContaining({
        historyText: "Look at this",
        images: [
          expect.objectContaining({ mimeType: "image/png", data: new Uint8Array([1, 2, 3, 4]) }),
        ],
      }),
    ]);
  });

  it("copies steering attachments onto an already-started computer before the next tool", async () => {
    const { sandbox, finalizeRun } = await runRoutine(
      [
        { name: "list_files", args: { path: "" } },
        { name: "list_files", args: { path: "" } },
      ],
      { attachments: "file", steering: true, steeringAfterFirst: true },
    );
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(provisionComputer).toHaveBeenCalledOnce();
    expect(sandbox.writeFile).toHaveBeenCalledOnce();
    expect(sandbox.writeFile.mock.invocationCallOrder[0]).toBeGreaterThan(
      sandbox.listFiles.mock.invocationCallOrder[0]!,
    );
    expect(sandbox.writeFile.mock.invocationCallOrder[0]).toBeLessThan(
      sandbox.listFiles.mock.invocationCallOrder[1]!,
    );
  });

  it("does not boot for a steering attachment without computer tools", async () => {
    await runRoutine([], { attachments: "image", steering: true });
    expect(provisionComputer).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps native chat lazy when native access is unavailable: %s",
    async (nativeUnavailable) => {
      const { finalizeRun, sandbox } = await runRoutine([], { native: true, nativeUnavailable });
      expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
      expect(provisionComputer).not.toHaveBeenCalled();
      expect(sandbox.environment).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "desktop", botId: "home-1" }),
        expect.anything(),
      );
    },
  );

  it("starts the computer the first time a tool needs it and reuses it", async () => {
    const { finalizeRun, sandbox, sleepJobs, toolResults } = await runRoutine([
      { name: "list_files", args: { path: "" } },
      { name: "list_files", args: { path: "" } },
    ]);

    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(provisionComputer).toHaveBeenCalledOnce();
    expect(provisionComputer).toHaveBeenCalledWith(
      expect.anything(),
      "computer-1",
      expect.objectContaining({ runId: "run-1" }),
      "bot",
    );
    expect(sandbox.listFiles).toHaveBeenCalledTimes(2);
    expect(sandbox.listFiles).toHaveBeenCalledWith(COMPUTER, expect.any(String), expect.anything());
    expect(toolResults[0]).toMatchObject({ entries: [{ path: "notes.txt" }] });
    expect(sleepJobs).toHaveLength(1);
    expect(sandbox.releaseScreen).toHaveBeenCalledWith(COMPUTER, expect.anything());
  });

  it("completes the run when its closing workspace checkpoint fails", async () => {
    const { finalizeRun, sandbox } = await runRoutine(
      [{ name: "list_files", args: { path: "" } }],
      {
        attachments: "file",
        exportError: new Error("Boat API request failed (HTTP 502, sandbox_direct_failed)"),
      },
    );

    expect(sandbox.exportWorkspace).toHaveBeenCalled();
    expect(finalizeRun).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }));
    expect(sink.events).toContainEqual(
      expect.objectContaining({ level: "warn", message: "computer.checkpoint_deferred" }),
    );
  });

  it("starts the computer before handing its screen to the user", async () => {
    await runRoutine([], { takeover: true });

    expect(provisionComputer).toHaveBeenCalledOnce();
  });

  it("restarts the idle timer when it asks the user to take over", async () => {
    const { sleepJobs } = await runRoutine([], { takeover: true });

    // One from starting the computer, one from the takeover request.
    expect(sleepJobs).toHaveLength(2);
  });

  it("keeps setup-failure retry semantics when the computer cannot start", async () => {
    provisionComputer.mockRejectedValue(new Error("provider unavailable"));

    await expect(runRoutine([{ name: "list_files", args: { path: "" } }])).rejects.toThrow(
      "Run setup failed; retrying",
    );
    expect(provisionComputer).toHaveBeenCalledOnce();
  });

  it("fails the run instead of retrying once setup has failed too many times in a row", async () => {
    provisionComputer.mockRejectedValue(new Error("provider unavailable"));

    const { finalizeRun, enqueue, prisma } = await runRoutine(
      [{ name: "list_files", args: { path: "" } }],
      { priorSetupFailures: 7 },
    );

    expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "failed", error: "provider unavailable" }),
    );
    expect(enqueue).not.toHaveBeenCalled();
    // Busy-computer and database waits between failures neither count nor reset the streak.
    expect(prisma.attempt.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ NOT: { status: "setup_failed", error: null } }),
      }),
    );
  });

  it.each([undefined, "abort", "recover"] as const)(
    "finishes rate-limited runs without retrying when the model handles tool failure as %s",
    async (toolFailure) => {
      const error = new SandboxRateLimitError({ cause: new Error("Provider account limit") });
      provisionComputer.mockRejectedValue(error);

      const { finalizeRun, enqueue } = await runRoutine(
        [{ name: "list_files", args: { path: "" } }],
        { toolFailure },
      );

      expect(provisionComputer).toHaveBeenCalledOnce();
      expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ outcome: "failed", error: error.message }),
      );
      expect(enqueue).not.toHaveBeenCalled();
    },
  );
});

/** Models the run reads but these tests do not care about behave as empty tables. */
function withEmptyModels<T extends object>(prisma: T): T {
  const empty = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    count: async () => 0,
    updateMany: async () => ({ count: 0 }),
  };
  return new Proxy(prisma, {
    get: (target, key) => (key in target ? target[key as keyof T] : empty),
  });
}
