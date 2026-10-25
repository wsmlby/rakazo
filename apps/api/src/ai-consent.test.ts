import type { Actor } from "@rakazo/contracts";
import { AI_DISCLOSURE_VERSION } from "@rakazo/contracts";
import { currentDbContext, runAsTenant } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";

vi.mock("./thread-target.js", () => ({
  resolveThreadTarget: vi.fn(),
}));

import { aiConsentStatus, allowAiConsent } from "./ai-consent.js";
import type { RouterDeps } from "./router.js";
import { resolveThreadTarget } from "./thread-target.js";

function setup() {
  vi.mocked(resolveThreadTarget)
    .mockReset()
    .mockResolvedValue({
      kind: "bot",
      botId: "bot",
      bot: { userId: "user", collaborationRestricted: false },
    } as never);
  const upsert = vi.fn(async () => ({}));
  const deps = {
    env: { agentRuntime: "scripted" },
    prisma: {
      spaceModelPreference: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
      spaceModelRoleChoice: { findMany: vi.fn(async () => []) },
      userModelCredential: { findMany: vi.fn(async () => []) },
      secret: { findMany: vi.fn(async () => []) },
      bot: { findMany: vi.fn(async () => []) },
      routine: { findMany: vi.fn(async () => []) },
      spaceVoicePreference: {
        findFirst: vi.fn(async () => ({ credential: { provider: "openai" }, voiceId: "alloy" })),
        findMany: vi.fn(async () => [{ credential: { provider: "openai" } }]),
      },
      spaceMemoryConfig: { findUnique: vi.fn(async () => null) },
      deploymentSettings: { findUnique: vi.fn(async () => null) },
      aiDataConsent: { findMany: vi.fn(async () => []), upsert },
      $transaction: vi.fn(async (write: (tx: unknown) => Promise<unknown>) =>
        write({ aiDataConsent: { upsert } }),
      ),
    },
  } as unknown as RouterDeps;
  return { deps, upsert, actor: { userId: "user", spaceId: "space" } as Actor };
}
describe("consent grants", () => {
  it("includes reachable helper models and cloud services for a targeted send", async () => {
    const { deps, actor } = setup();
    deps.env.agentRuntime = "pi";
    deps.cloudAgent = {
      key: "test",
      spaceId: actor.spaceId,
      provider: { describe: () => ({ id: "cursor", capabilities: { offline: false } }) },
    } as RouterDeps["cloudAgent"];
    vi.mocked(deps.prisma.spaceModelPreference.findMany).mockResolvedValue([
      {
        modelId: "helper-model",
        isDefault: false,
        credential: { provider: "anthropic", secretId: "test-secret" },
      },
    ] as never);
    const status = await aiConsentStatus(deps, actor, { botId: "bot", uses: ["model"] });
    expect(status.recipients.map((recipient) => recipient.name)).toEqual(
      expect.arrayContaining(["Anthropic", "Cursor"]),
    );
    expect(deps.prisma.spaceVoicePreference.findMany).not.toHaveBeenCalled();
    expect(deps.prisma.bot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ["bot"] } }) }),
    );
    expect(deps.prisma.routine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: { in: ["bot"] },
          OR: [{ active: true }],
        }),
      }),
    );
  });
  it("includes an inactive routine only when the check is for that routine", async () => {
    const { deps, actor } = setup();
    deps.env.agentRuntime = "pi";
    await aiConsentStatus(deps, actor, { routineId: "routine-1", uses: ["model"] });
    expect(deps.prisma.routine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ active: true }, { id: "routine-1" }],
        }),
      }),
    );
  });
  it("includes every purpose's selected models in the provider-sharing disclosure until each is allowed", async () => {
    const { deps, actor } = setup();
    deps.env.agentRuntime = "pi";
    vi.mocked(deps.prisma.spaceModelRoleChoice.findMany).mockResolvedValue([
      {
        role: "main",
        position: 1,
        provider: "anthropic",
        modelId: "claude-backup",
        thinkingLevel: null,
      },
    ] as never);
    vi.mocked(deps.prisma.userModelCredential.findMany).mockResolvedValue([
      {
        id: "backup-credential",
        userId: actor.userId,
        provider: "anthropic",
        label: "fixture",
        secretId: "backup-secret",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ] as never);

    const status = await aiConsentStatus(deps, actor, { uses: ["model"] });

    expect(status.recipients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Anthropic",
          detail: "claude-backup",
          use: "model",
          allowed: false,
        }),
      ]),
    );
    expect(deps.prisma.spaceModelRoleChoice.findMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, spaceId: actor.spaceId },
      orderBy: [{ role: "asc" }, { position: "asc" }],
    });
  });
  it("discloses only the selected voice provider before a voice action", async () => {
    const { deps, actor } = setup();
    vi.mocked(deps.prisma.spaceVoicePreference.findMany).mockResolvedValue([
      { credential: { provider: "openai" } },
      { credential: { provider: "elevenlabs" } },
    ] as never);
    const status = await aiConsentStatus(deps, actor, { uses: ["voice"] });
    expect(status.recipients).toHaveLength(1);
    expect(status.recipients[0]?.name).toBe("OpenAI");
    expect(deps.prisma.spaceVoicePreference.findMany).not.toHaveBeenCalled();
  });
  it("returns an operator policy without requiring a hosted provider", async () => {
    const { deps, actor } = setup();
    deps.env.privacyPolicyUrl = "https://example.com/privacy";
    expect((await aiConsentStatus(deps, actor)).privacyUrl).toBe("https://example.com/privacy");
  });
  it("rejects stale disclosures, unknown recipients, and a changed account or Space", async () => {
    const { deps, actor, upsert } = setup();
    const current = await aiConsentStatus(deps, actor);
    const input = {
      scope: current.scope,
      version: current.version,
      keys: [current.recipients[0]!.key],
    };
    for (const invalid of [
      { ...input, version: "old" },
      { ...input, scope: "different-account" },
      { ...input, keys: ["unknown"] },
    ]) {
      await expect(allowAiConsent(deps, actor, invalid)).rejects.toThrow("changed");
    }
    expect(upsert).not.toHaveBeenCalled();
    await allowAiConsent(deps, actor, input);
    expect(upsert).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        create: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          recipientKey: input.keys[0],
          version: AI_DISCLOSURE_VERSION,
        },
      }),
    );
  });
});

describe("shared bot consent", () => {
  function sharedSetup() {
    const fixture = setup();
    fixture.deps.env.agentRuntime = "pi";
    vi.mocked(resolveThreadTarget).mockResolvedValue({
      kind: "bot",
      botId: "bot",
      bot: { userId: "owner", collaborationRestricted: true },
    } as never);
    vi.mocked(fixture.deps.prisma.bot.findMany).mockResolvedValue([
      { modelProvider: null, modelId: null, thinkingLevel: null },
    ] as never);
    return fixture;
  }

  it("uses the owner's model connections and endpoint without returning secrets", async () => {
    const { deps, actor } = sharedSetup();
    vi.mocked(deps.prisma.bot.findMany).mockResolvedValue([
      { modelProvider: "openai-compatible", modelId: "owner-model", thinkingLevel: null },
    ] as never);
    vi.mocked(deps.prisma.userModelCredential.findMany).mockImplementation(
      async (input) =>
        (input?.where?.userId === "owner"
          ? [{ id: "owner-credential", provider: "openai-compatible", secretId: "owner-secret" }]
          : [
              { id: "viewer-credential", provider: "anthropic", secretId: "viewer-secret" },
            ]) as never,
    );
    vi.mocked(deps.prisma.secret.findMany).mockResolvedValue([
      { id: "owner-secret", ciphertext: "encrypted-fixture" },
    ] as never);
    deps.secrets = {
      load: vi.fn().mockResolvedValue(
        JSON.stringify({
          kind: "openai_compatible",
          baseUrl: "https://models.example.com/v1",
          apiKey: "fixture-key",
        }),
      ),
      put: vi.fn(),
    };
    const status = await aiConsentStatus(deps, actor, { botId: "bot", uses: ["model"] });
    expect(status.recipients).toEqual([
      expect.objectContaining({
        name: expect.stringContaining("models.example.com"),
        detail: "owner-model",
        allowed: false,
      }),
    ]);
    expect(deps.prisma.bot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: "owner" }) }),
    );
    expect(deps.prisma.secret.findMany).toHaveBeenCalledWith({
      where: { userId: "owner", spaceId: null, id: { in: ["owner-secret"] } },
    });
    expect(deps.prisma.userModelCredential.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: "owner" }) }),
    );
    expect(JSON.stringify(status)).not.toMatch(/fixture-key|ciphertext|owner-secret|viewer-secret/);
    expect(actor.userId).toBe("user");
  });

  it("uses owner defaults, helpers and fallback models while reading only viewer consent", async () => {
    const { deps, actor } = sharedSetup();
    vi.mocked(deps.prisma.spaceModelPreference.findMany).mockImplementation(
      async (input) =>
        (input?.where?.userId === "owner"
          ? [
              {
                modelId: "owner-helper",
                isDefault: false,
                credential: { provider: "google", secretId: "helper-secret" },
              },
            ]
          : [{ modelId: "viewer-model", credential: { provider: "openai" } }]) as never,
    );
    vi.mocked(deps.prisma.spaceModelRoleChoice.findMany).mockResolvedValue([
      { role: "main", position: 0, provider: "anthropic", modelId: "owner-main" },
      { role: "main", position: 1, provider: "mistral", modelId: "owner-backup" },
    ] as never);
    vi.mocked(deps.prisma.userModelCredential.findMany).mockImplementation(
      async (input) =>
        (input?.where?.userId === "owner"
          ? ["anthropic", "mistral"].map((provider) => ({
              id: provider,
              provider,
              secretId: `${provider}-secret`,
            }))
          : []) as never,
    );
    const query = { botId: "bot", uses: ["model"] } as const;
    const status = await aiConsentStatus(deps, actor, { ...query, uses: [...query.uses] });
    expect(status.recipients.map((recipient) => recipient.detail)).toEqual(
      expect.arrayContaining(["owner-main", "owner-backup", "owner-helper"]),
    );
    expect(status.recipients.every((recipient) => !recipient.allowed)).toBe(true);
    expect(JSON.stringify(status)).not.toContain("viewer-model");
    expect(deps.prisma.aiDataConsent.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { userId: actor.userId, spaceId: actor.spaceId, version: AI_DISCLOSURE_VERSION },
    });
    for (const call of vi.mocked(deps.prisma.spaceModelRoleChoice.findMany).mock.calls)
      expect(call[0]?.where).toMatchObject({ userId: "owner", spaceId: actor.spaceId });
    const recipient = status.recipients[0]!;
    vi.mocked(deps.prisma.aiDataConsent.findMany).mockResolvedValue([
      { recipientKey: recipient.key },
    ] as never);
    const allowed = await aiConsentStatus(deps, actor, { botId: "bot", uses: ["model"] });
    expect(allowed.recipients.find((row) => row.key === recipient.key)?.allowed).toBe(true);
  });

  it("keeps deployment defaults and Space memory while voice still uses the viewer", async () => {
    const { deps, actor } = sharedSetup();
    deps.env.deploymentModelConfigured = true;
    deps.env.defaultProvider = "openai";
    deps.env.defaultModel = "deployment-model";
    vi.mocked(deps.prisma.spaceMemoryConfig.findUnique).mockResolvedValue({
      provider: "supermemory",
      settings: { baseUrl: "https://memory.example.com" },
    } as never);
    const status = await aiConsentStatus(deps, actor, { botId: "bot" });
    expect(status.recipients).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ use: "model", detail: "deployment-model" }),
        expect.objectContaining({ use: "memory" }),
        expect.objectContaining({ use: "voice", name: "OpenAI" }),
      ]),
    );
    expect(deps.prisma.spaceMemoryConfig.findUnique).toHaveBeenCalledWith({
      where: { spaceId: actor.spaceId },
    });
    expect(deps.prisma.spaceVoicePreference.findMany).toHaveBeenCalledWith({
      where: { userId: actor.userId, spaceId: actor.spaceId },
      include: { credential: true },
    });
  });

  it("grants the target's recipients only to the viewer and rechecks target access", async () => {
    const { deps, actor, upsert } = sharedSetup();
    vi.mocked(deps.prisma.spaceModelPreference.findMany).mockResolvedValue([
      { modelId: "owner-helper", credential: { provider: "anthropic" } },
    ] as never);
    const query = { botId: "bot", uses: ["model"] as const };
    const status = await aiConsentStatus(deps, actor, { ...query, uses: [...query.uses] });
    const input = {
      scope: status.scope,
      version: status.version,
      keys: status.recipients.map((recipient) => recipient.key),
      query: { ...query, uses: [...query.uses] },
    };
    const granted = await allowAiConsent(deps, actor, input);
    expect(granted.recipients.every((recipient) => recipient.allowed)).toBe(true);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          userId: actor.userId,
          spaceId: actor.spaceId,
          recipientKey: input.keys[0],
          version: status.version,
        },
        where: {
          userId_spaceId_recipientKey: {
            userId: actor.userId,
            spaceId: actor.spaceId,
            recipientKey: input.keys[0],
          },
        },
      }),
    );
    upsert.mockClear();
    vi.mocked(resolveThreadTarget).mockRejectedValue(new Error("Access revoked"));
    await expect(allowAiConsent(deps, actor, input)).rejects.toThrow("Access revoked");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("limits the owner database context to model reads, not viewer consent or voice", async () => {
    const { deps, actor, upsert } = sharedSetup();
    const ownerContext = { kind: "tenant", userId: "owner", spaceId: actor.spaceId };
    const viewerContext = { kind: "tenant", userId: actor.userId, spaceId: actor.spaceId };
    vi.mocked(deps.prisma.spaceModelPreference.findMany).mockImplementation(async () => {
      expect(currentDbContext()).toEqual(ownerContext);
      return [
        {
          modelId: "owner-helper",
          credential: { provider: "anthropic", secretId: "owner-secret" },
        },
      ] as never;
    });
    vi.mocked(deps.prisma.spaceModelRoleChoice.findMany).mockImplementation(async () => {
      expect(currentDbContext()).toEqual(ownerContext);
      return [];
    });
    vi.mocked(deps.prisma.secret.findMany).mockImplementation(async () => {
      expect(currentDbContext()).toEqual(ownerContext);
      return [];
    });
    vi.mocked(deps.prisma.aiDataConsent.findMany).mockImplementation(async () => {
      expect(currentDbContext()).toEqual(viewerContext);
      return [];
    });
    vi.mocked(deps.prisma.spaceVoicePreference.findMany).mockImplementation(async () => {
      expect(currentDbContext()).toEqual(viewerContext);
      return [];
    });
    upsert.mockImplementation(async () => {
      expect(currentDbContext()).toEqual(viewerContext);
      return {};
    });
    await runAsTenant(actor, async () => {
      const query = { botId: "bot" };
      const status = await aiConsentStatus(deps, actor, query);
      await allowAiConsent(deps, actor, {
        scope: status.scope,
        version: status.version,
        keys: status.recipients.map((recipient) => recipient.key),
        query,
      });
      expect(currentDbContext()).toEqual(viewerContext);
    });
    expect(upsert).toHaveBeenCalledOnce();
    expect(currentDbContext()).toBeUndefined();
  });

  it("preserves viewer-owned model scope for groups and untargeted settings", async () => {
    const { deps, actor } = sharedSetup();
    vi.mocked(resolveThreadTarget).mockResolvedValue({
      kind: "group",
      memberBotIds: ["bot"],
    } as never);
    for (const query of [{ groupId: "group", uses: ["model"] }, { uses: ["model"] }])
      await aiConsentStatus(deps, actor, query as never);
    for (const call of vi.mocked(deps.prisma.spaceModelPreference.findMany).mock.calls)
      expect(call[0]?.where).toMatchObject({ userId: actor.userId, spaceId: actor.spaceId });
  });
});

it("discloses the self-hosted voice origin without its encrypted key", async () => {
  const { deps, actor } = setup();
  vi.mocked(deps.prisma.spaceVoicePreference.findFirst).mockResolvedValue({
    credential: { provider: "openai-compatible", secretId: "voice-secret" },
    voiceId: "af_heart",
  } as never);
  deps.prisma.secret.findFirst = vi
    .fn()
    .mockResolvedValue({ id: "voice-secret", ciphertext: "encrypted-fixture" });
  deps.secrets = {
    load: vi.fn().mockResolvedValue(
      JSON.stringify({
        kind: "openai_compatible",
        baseUrl: "http://100.64.0.10:8810/v1",
        apiKey: "local-test-key",
        ttsModel: "kokoro",
        sttModel: "whisper-1",
      }),
    ),
    put: vi.fn(),
  };
  const status = await aiConsentStatus(deps, actor, { uses: ["voice"] });
  expect(status.recipients).toHaveLength(1);
  expect(JSON.stringify(status)).toContain("http://100.64.0.10:8810");
  expect(JSON.stringify(status)).not.toContain("local-test-key");
  expect(JSON.stringify(status)).not.toContain("apiKey");
});
