type SlackEventAuthorization = {
  team_id: string;
  user_id: string;
  is_bot: boolean;
  is_enterprise_install: boolean;
};

type SlackEventCallback<Event> = {
  token: string;
  team_id: string;
  api_app_id: string;
  event: Event;
  type: "event_callback";
  authorizations: SlackEventAuthorization[];
  event_id: string;
  event_time: number;
};

type AssistantThreadContext = {
  channel_id?: string;
  team_id?: string;
  enterprise_id?: string | null;
};

type AssistantThread = {
  user_id: string;
  context: AssistantThreadContext;
  channel_id: string;
  thread_ts: string;
};

type AssistantThreadStartedPayload = {
  type: "assistant_thread_started";
  assistant_thread: AssistantThread;
  event_ts: string;
};

type AssistantThreadContextChangedPayload = {
  type: "assistant_thread_context_changed";
  assistant_thread: AssistantThread;
  event_ts: string;
};

type MessageImPayload = {
  type: "message";
  channel: string;
  user: string;
  text: string;
  ts: string;
  event_ts: string;
  channel_type: "im";
  team: string;
  thread_ts?: string;
};

export type AssistantThreadStartedEvent = SlackEventCallback<AssistantThreadStartedPayload>;
export type AssistantThreadContextChangedEvent =
  SlackEventCallback<AssistantThreadContextChangedPayload>;
export type AssistantMessageImEvent = SlackEventCallback<MessageImPayload & { thread_ts: string }>;
export type LegacyMessageImEvent = SlackEventCallback<MessageImPayload>;

const baseAuthorizations: SlackEventAuthorization[] = [
  {
    team_id: "T123ABC456",
    user_id: "U123ABC456",
    is_bot: false,
    is_enterprise_install: false,
  },
];

/**
 * Slack sends `assistant_thread_started` when a user opens a new AI assistant
 * thread/container, including the Slack client context visible at that moment.
 *
 * @see https://docs.slack.dev/reference/events/assistant_thread_started/
 */
export const assistantThreadStartedFixture = {
  token: "XXYYZZ",
  team_id: "T123ABC456",
  api_app_id: "A123ABC456",
  event: {
    type: "assistant_thread_started",
    assistant_thread: {
      user_id: "U123ABC456",
      context: {
        channel_id: "C123ABC456",
        team_id: "T07XY8FPJ5C",
        enterprise_id: "E480293PS82",
      },
      channel_id: "D123ABC456",
      thread_ts: "1729999327.187299",
    },
    event_ts: "1715873754.429808",
  },
  type: "event_callback",
  authorizations: baseAuthorizations,
  event_id: "EvASSISTANTSTARTED1",
  event_time: 1715873754,
} satisfies AssistantThreadStartedEvent;

/**
 * Slack sends `assistant_thread_context_changed` when the user switches channels
 * while the AI assistant container remains open.
 *
 * @see https://docs.slack.dev/reference/events/assistant_thread_context_changed/
 */
export const assistantThreadContextChangedFixture = {
  token: "XXYYZZ",
  team_id: "T123ABC456",
  api_app_id: "A123ABC456",
  event: {
    type: "assistant_thread_context_changed",
    assistant_thread: {
      user_id: "U123ABC456",
      context: {
        channel_id: "C987XYZ654",
        team_id: "T07XY8FPJ5C",
        enterprise_id: "E480293PS82",
      },
      channel_id: "D123ABC456",
      thread_ts: "1729999327.187299",
    },
    event_ts: "1729999334.022142",
  },
  type: "event_callback",
  authorizations: baseAuthorizations,
  event_id: "EvASSISTANTCONTEXT1",
  event_time: 1729999334,
} satisfies AssistantThreadContextChangedEvent;

/**
 * Slack sends this `message.im` payload when a user types in, or clicks a
 * suggested prompt inside, an assistant app thread. Slack's assistant docs say
 * the message event itself does not include the assistant context; the
 * `thread_ts` links it back to the assistant thread context captured earlier.
 *
 * @see https://docs.slack.dev/ai/developing-agents/#listening-for-the-messageim-event
 * @see https://docs.slack.dev/tools/bolt-js/concepts/using-the-assistant-class/#handling-the-user-response
 */
export const assistantMessageImFixture = {
  token: "XXYYZZ",
  team_id: "T123ABC456",
  api_app_id: "A123ABC456",
  event: {
    type: "message",
    channel: "D123ABC456",
    user: "U123ABC456",
    text: "Summarize the channel I am viewing.",
    ts: "1729999350.000200",
    thread_ts: "1729999327.187299",
    event_ts: "1729999350.000200",
    channel_type: "im",
    team: "T123ABC456",
    // TODO(fixture): verify whether live assistant-pane message.im payloads expose any assistant-only marker beyond thread_ts/channel_type.
  },
  type: "event_callback",
  authorizations: baseAuthorizations,
  event_id: "EvASSISTANTMESSAGE1",
  event_time: 1729999350,
} satisfies AssistantMessageImEvent;

/**
 * Slack sends this regular `message.im` payload for a direct message with the
 * app outside the assistant-pane thread flow. It is included as a comparison
 * fixture for duplicate-routing and assistant-surface detection tests.
 *
 * @see https://docs.slack.dev/reference/events/message/
 */
export const legacyMessageImFixture = {
  token: "XXYYZZ",
  team_id: "T123ABC456",
  api_app_id: "A123ABC456",
  event: {
    type: "message",
    channel: "DLEGACY123",
    user: "U123ABC456",
    text: "Are you online?",
    ts: "1729999400.000300",
    event_ts: "1729999400.000300",
    channel_type: "im",
    team: "T123ABC456",
  },
  type: "event_callback",
  authorizations: baseAuthorizations,
  event_id: "EvLEGACYMESSAGE1",
  event_time: 1729999400,
} satisfies LegacyMessageImEvent;
