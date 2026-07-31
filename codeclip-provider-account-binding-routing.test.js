const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveCodeClipProviderAccountBindingRoute,
} = require("./verticals/codeclip/provider-account-binding-routing");

function makeQueryClient(bindings = []) {
  return {
    async query(sql, params = []) {
      if (
        /FROM codeclip_provider_account_bindings/.test(sql) &&
        /provider_account_id = \$3/.test(sql)
      ) {
        const rows = bindings.filter(
          (row) =>
            row.vertical === params[0] &&
            row.provider === params[1] &&
            row.provider_account_id === params[2] &&
            row.status === "active"
        );
        return { rows: rows.slice(0, 2) };
      }
      return { rows: [] };
    },
  };
}

function bindingRow({
  id = "1",
  eventCode = "CC-TEST-1",
  providerAccountId = "account-1",
  channel = "messenger",
} = {}) {
  return {
    id,
    vertical: "codeclip",
    event_code: eventCode,
    provider: "meta",
    channel,
    provider_account_id: providerAccountId,
    status: "active",
    display_name: null,
    created_by: "test",
    metadata: {},
    created_at: "2026-07-31T00:00:00.000Z",
    updated_at: "2026-07-31T00:00:00.000Z",
    disabled_at: null,
  };
}

function codeClipEvent({
  code = "CC-TEST-1",
  activationChannels = ["messenger", "instagram"],
  activationKeyword = "vip",
  activationMethod = "both",
  status = "active",
} = {}) {
  return {
    id: `event-${code}`,
    code,
    vertical: "codeclip",
    status,
    activationChannels,
    activationKeyword,
    activationMethod,
    raw_event: {
      id: `event-${code}`,
      code,
      vertical: "codeclip",
      status,
      activationChannels,
      activationKeyword,
      activationMethod,
    },
  };
}

test("binding route requires envelope channel to match durable binding channel", async () => {
  const accountId = "shared-account-1";
  const event = codeClipEvent({
    code: "CC-MSG-1",
    activationChannels: ["messenger", "instagram"],
    activationKeyword: "vip",
  });
  const client = makeQueryClient([
    bindingRow({
      eventCode: event.code,
      providerAccountId: accountId,
      channel: "messenger",
    }),
  ]);

  const messengerOk = await resolveCodeClipProviderAccountBindingRoute({
    provider: "meta",
    providerAccountId: accountId,
    channel: "messenger",
    keyword: "vip",
    queryClient: client,
    getEventByCode: async () => event,
  });
  assert.equal(messengerOk.ok, true);
  assert.equal(messengerOk.binding.channel, "messenger");

  const instagramMismatch = await resolveCodeClipProviderAccountBindingRoute({
    provider: "meta",
    providerAccountId: accountId,
    channel: "instagram",
    keyword: "vip",
    queryClient: client,
    getEventByCode: async () => event,
  });
  assert.equal(instagramMismatch.ok, false);
  assert.equal(instagramMismatch.reason, "PROVIDER_BINDING_CHANNEL_MISMATCH");
});

test("Instagram binding rejects Messenger envelope channel", async () => {
  const accountId = "ig-account-1";
  const event = codeClipEvent({
    code: "CC-IG-1",
    activationChannels: ["instagram"],
    activationKeyword: "clip",
  });
  const client = makeQueryClient([
    bindingRow({
      eventCode: event.code,
      providerAccountId: accountId,
      channel: "instagram",
    }),
  ]);

  const result = await resolveCodeClipProviderAccountBindingRoute({
    provider: "meta",
    providerAccountId: accountId,
    channel: "messenger",
    keyword: "clip",
    queryClient: client,
    getEventByCode: async () => event,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "PROVIDER_BINDING_CHANNEL_MISMATCH");
});

test("Instagram binding accepts Instagram envelope and activation channels", async () => {
  const accountId = "ig-account-2";
  const event = codeClipEvent({
    code: "CC-IG-2",
    activationChannels: ["instagram"],
    activationKeyword: "clip",
  });
  const client = makeQueryClient([
    bindingRow({
      eventCode: event.code,
      providerAccountId: accountId,
      channel: "instagram",
    }),
  ]);

  const result = await resolveCodeClipProviderAccountBindingRoute({
    provider: "meta",
    providerAccountId: accountId,
    channel: "instagram",
    keyword: "clip",
    queryClient: client,
    getEventByCode: async () => event,
  });
  assert.equal(result.ok, true);
  assert.equal(result.eventCode, "CC-IG-2");
});

test("Instagram envelope does not match Messenger-only activation channels", async () => {
  const accountId = "ig-account-3";
  const event = codeClipEvent({
    code: "CC-MSG-ONLY",
    activationChannels: ["messenger"],
    activationKeyword: "clip",
  });
  const client = makeQueryClient([
    bindingRow({
      eventCode: event.code,
      providerAccountId: accountId,
      channel: "instagram",
    }),
  ]);

  const result = await resolveCodeClipProviderAccountBindingRoute({
    provider: "meta",
    providerAccountId: accountId,
    channel: "instagram",
    keyword: "clip",
    queryClient: client,
    getEventByCode: async () => event,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "NO_MATCH");
});

test("WhatsApp envelope cannot consume Messenger binding", async () => {
  const accountId = "shared-account-wa";
  const event = codeClipEvent({
    code: "CC-MSG-WA",
    activationChannels: ["messenger", "whatsapp"],
    activationKeyword: "clip",
  });
  const client = makeQueryClient([
    bindingRow({
      eventCode: event.code,
      providerAccountId: accountId,
      channel: "messenger",
    }),
  ]);

  const result = await resolveCodeClipProviderAccountBindingRoute({
    provider: "meta",
    providerAccountId: accountId,
    channel: "whatsapp",
    keyword: "clip",
    queryClient: client,
    getEventByCode: async () => event,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "PROVIDER_BINDING_CHANNEL_MISMATCH");
});
