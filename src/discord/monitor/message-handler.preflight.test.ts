import { ChannelType } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  preflightDiscordMessage,
  resolveDiscordAllowedBotIds,
  resolvePreflightMentionRequirement,
  shouldAcceptDiscordBotAuthor,
  shouldIgnoreBoundThreadWebhookMessage,
} from "./message-handler.preflight.js";
import {
  __testing as threadBindingTesting,
  createThreadBindingManager,
} from "./thread-bindings.js";

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();
  return {
    ...actual,
    getOAuthProviders: () => [],
  };
});

function createThreadBinding(
  overrides?: Partial<import("./thread-bindings.js").ThreadBindingRecord>,
) {
  return {
    accountId: "default",
    channelId: "parent-1",
    threadId: "thread-1",
    targetKind: "subagent",
    targetSessionKey: "agent:main:subagent:child-1",
    agentId: "main",
    boundBy: "test",
    boundAt: 1,
    webhookId: "wh-1",
    webhookToken: "tok-1",
    ...overrides,
  } satisfies import("./thread-bindings.js").ThreadBindingRecord;
}

async function runGuildPreflight(
  overrides: {
    author?: Partial<import("@buape/carbon").User>;
    content?: string;
    mentionedUsers?: Partial<import("@buape/carbon").User>[];
    channelRequireMention?: boolean;
    discordConfig?: Partial<
      NonNullable<import("../../config/config.js").OpenClawConfig["channels"]>["discord"]
    >;
  } = {},
) {
  const channelId = "triad-channel";
  const guildId = "guild-1";
  const author = {
    id: "approved-bot-1",
    bot: true,
    username: "GRIT",
    ...overrides.author,
  } as import("@buape/carbon").User;
  const message = {
    id: `m-${author.id}`,
    content: overrides.content ?? "ambient handoff",
    timestamp: new Date().toISOString(),
    channelId,
    attachments: [],
    mentionedUsers: (overrides.mentionedUsers ?? []) as import("@buape/carbon").User[],
    mentionedRoles: [],
    mentionedEveryone: false,
    author,
  } as unknown as import("@buape/carbon").Message;
  const client = {
    fetchChannel: async () => ({
      id: channelId,
      type: ChannelType.GuildText,
      name: "triad",
    }),
  } as unknown as import("@buape/carbon").Client;

  return await preflightDiscordMessage({
    cfg: {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    } as import("../../config/config.js").OpenClawConfig,
    discordConfig: {
      ...overrides.discordConfig,
    } as NonNullable<import("../../config/config.js").OpenClawConfig["channels"]>["discord"],
    accountId: "default",
    token: "token",
    runtime: {} as import("../../runtime.js").RuntimeEnv,
    botUserId: "openclaw-bot",
    guildHistories: new Map(),
    historyLimit: 0,
    mediaMaxBytes: 1_000_000,
    textLimit: 2_000,
    replyToMode: "all",
    dmEnabled: true,
    groupDmEnabled: true,
    ackReactionScope: "direct",
    groupPolicy: "allowlist",
    threadBindings: {
      getByThreadId: () => undefined,
    } as unknown as import("./thread-bindings.js").ThreadBindingManager,
    guildEntries: {
      [guildId]: {
        id: guildId,
        channels: {
          [channelId]: {
            requireMention: overrides.channelRequireMention,
          },
        },
      },
    },
    data: {
      channel_id: channelId,
      guild_id: guildId,
      guild: {
        id: guildId,
        name: "Guild One",
      },
      author,
      message,
    } as unknown as import("./listeners.js").DiscordMessageEvent,
    client,
  });
}

describe("resolvePreflightMentionRequirement", () => {
  it("requires mention when config requires mention and thread is not bound", () => {
    expect(
      resolvePreflightMentionRequirement({
        shouldRequireMention: true,
        isBoundThreadSession: false,
      }),
    ).toBe(true);
  });

  it("disables mention requirement for bound thread sessions", () => {
    expect(
      resolvePreflightMentionRequirement({
        shouldRequireMention: true,
        isBoundThreadSession: true,
      }),
    ).toBe(false);
  });

  it("keeps mention requirement disabled when config already disables it", () => {
    expect(
      resolvePreflightMentionRequirement({
        shouldRequireMention: false,
        isBoundThreadSession: false,
      }),
    ).toBe(false);
  });
});

describe("discord bot author allowlist", () => {
  beforeEach(() => {
    vi.stubEnv("DISCORD_ALLOWED_BOTS", "");
  });

  it("combines configured bot IDs with DISCORD_ALLOWED_BOTS", () => {
    expect([
      ...resolveDiscordAllowedBotIds({
        configured: ["111"],
        env: { DISCORD_ALLOWED_BOTS: "222, <@333>" },
      }),
    ]).toEqual(["111", "222", "333"]);
  });

  it("keeps bot-authored messages default-deny", () => {
    expect(
      shouldAcceptDiscordBotAuthor({
        authorId: "relay-bot-1",
        allowBots: false,
        allowedBotIds: new Set(),
      }),
    ).toBe(false);
  });

  it("does not let allowBots=mentions bypass a configured ID allowlist", () => {
    expect(
      shouldAcceptDiscordBotAuthor({
        authorId: "unapproved-bot",
        allowBots: "mentions",
        allowedBotIds: new Set(["approved-bot"]),
      }),
    ).toBe(false);
  });
});

describe("preflightDiscordMessage", () => {
  beforeEach(() => {
    vi.stubEnv("DISCORD_ALLOWED_BOTS", "");
  });

  it("bypasses mention gating in bound threads for allowed bot senders", async () => {
    const threadBinding = createThreadBinding();
    const threadId = "thread-bot-focus";
    const parentId = "channel-parent-focus";
    const client = {
      fetchChannel: async (channelId: string) => {
        if (channelId === threadId) {
          return {
            id: threadId,
            type: ChannelType.PublicThread,
            name: "focus",
            parentId,
            ownerId: "owner-1",
          };
        }
        if (channelId === parentId) {
          return {
            id: parentId,
            type: ChannelType.GuildText,
            name: "general",
          };
        }
        return null;
      },
    } as unknown as import("@buape/carbon").Client;
    const message = {
      id: "m-bot-1",
      content: "relay message without mention",
      timestamp: new Date().toISOString(),
      channelId: threadId,
      attachments: [],
      mentionedUsers: [],
      mentionedRoles: [],
      mentionedEveryone: false,
      author: {
        id: "relay-bot-1",
        bot: true,
        username: "Relay",
      },
    } as unknown as import("@buape/carbon").Message;

    const result = await preflightDiscordMessage({
      cfg: {
        session: {
          mainKey: "main",
          scope: "per-sender",
        },
      } as import("../../config/config.js").OpenClawConfig,
      discordConfig: {
        allowBots: true,
      } as NonNullable<import("../../config/config.js").OpenClawConfig["channels"]>["discord"],
      accountId: "default",
      token: "token",
      runtime: {} as import("../../runtime.js").RuntimeEnv,
      botUserId: "openclaw-bot",
      guildHistories: new Map(),
      historyLimit: 0,
      mediaMaxBytes: 1_000_000,
      textLimit: 2_000,
      replyToMode: "all",
      dmEnabled: true,
      groupDmEnabled: true,
      ackReactionScope: "direct",
      groupPolicy: "open",
      threadBindings: {
        getByThreadId: (id: string) => (id === threadId ? threadBinding : undefined),
      } as import("./thread-bindings.js").ThreadBindingManager,
      data: {
        channel_id: threadId,
        guild_id: "guild-1",
        guild: {
          id: "guild-1",
          name: "Guild One",
        },
        author: message.author,
        message,
      } as unknown as import("./listeners.js").DiscordMessageEvent,
      client,
    });

    expect(result).not.toBeNull();
    expect(result?.boundSessionKey).toBe(threadBinding.targetSessionKey);
    expect(result?.shouldRequireMention).toBe(false);
  });

  it("allows an approved bot without mention when the channel disables mention gating", async () => {
    const result = await runGuildPreflight({
      channelRequireMention: false,
      discordConfig: {
        allowedBots: ["approved-bot-1"],
      },
    });

    expect(result).not.toBeNull();
    expect(result?.shouldRequireMention).toBe(false);
  });

  it("keeps approved bots subject to channel mention requirements", async () => {
    const result = await runGuildPreflight({
      channelRequireMention: true,
      discordConfig: {
        allowedBots: ["approved-bot-1"],
      },
    });

    expect(result).toBeNull();
  });

  it("allows an approved bot with an explicit mention in mention-gated channels", async () => {
    const result = await runGuildPreflight({
      channelRequireMention: true,
      content: "<@openclaw-bot> status",
      mentionedUsers: [{ id: "openclaw-bot" }],
      discordConfig: {
        allowedBots: ["approved-bot-1"],
      },
    });

    expect(result).not.toBeNull();
    expect(result?.effectiveWasMentioned).toBe(true);
  });

  it("ignores unapproved bots even when they mention the bot", async () => {
    const result = await runGuildPreflight({
      author: {
        id: "other-bot",
      },
      channelRequireMention: false,
      content: "<@openclaw-bot> status",
      mentionedUsers: [{ id: "openclaw-bot" }],
      discordConfig: {
        allowBots: "mentions",
        allowedBots: ["approved-bot-1"],
      },
    });

    expect(result).toBeNull();
  });
});

describe("shouldIgnoreBoundThreadWebhookMessage", () => {
  beforeEach(() => {
    threadBindingTesting.resetThreadBindingsForTests();
  });

  it("returns true when inbound webhook id matches the bound thread webhook", () => {
    expect(
      shouldIgnoreBoundThreadWebhookMessage({
        webhookId: "wh-1",
        threadBinding: createThreadBinding(),
      }),
    ).toBe(true);
  });

  it("returns false when webhook ids differ", () => {
    expect(
      shouldIgnoreBoundThreadWebhookMessage({
        webhookId: "wh-other",
        threadBinding: createThreadBinding(),
      }),
    ).toBe(false);
  });

  it("returns false when there is no bound thread webhook", () => {
    expect(
      shouldIgnoreBoundThreadWebhookMessage({
        webhookId: "wh-1",
        threadBinding: createThreadBinding({ webhookId: undefined }),
      }),
    ).toBe(false);
  });

  it("returns true for recently unbound thread webhook echoes", async () => {
    const manager = createThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });
    const binding = await manager.bindTarget({
      threadId: "thread-1",
      channelId: "parent-1",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child-1",
      agentId: "main",
      webhookId: "wh-1",
      webhookToken: "tok-1",
    });
    expect(binding).not.toBeNull();

    manager.unbindThread({
      threadId: "thread-1",
      sendFarewell: false,
    });

    expect(
      shouldIgnoreBoundThreadWebhookMessage({
        accountId: "default",
        threadId: "thread-1",
        webhookId: "wh-1",
      }),
    ).toBe(true);
  });
});
