import { describe, expect, it } from "vitest";
import {
  assistantMessageImFixture,
  assistantThreadContextChangedFixture,
  assistantThreadStartedFixture,
  legacyMessageImFixture,
  type AssistantMessageImEvent,
  type AssistantThreadContextChangedEvent,
  type AssistantThreadStartedEvent,
  type LegacyMessageImEvent,
} from "./assistant-events.js";

type FixtureEvent =
  | AssistantThreadStartedEvent
  | AssistantThreadContextChangedEvent
  | AssistantMessageImEvent
  | LegacyMessageImEvent;

function parseFixture<T extends FixtureEvent>(fixture: T): T {
  return JSON.parse(JSON.stringify(fixture)) as T;
}

function expectEventCallbackShape(fixture: FixtureEvent): void {
  expect(fixture.type).toBe("event_callback");
  expect(fixture.token).toBeTruthy();
  expect(fixture.team_id).toBeTruthy();
  expect(fixture.api_app_id).toBeTruthy();
  expect(fixture.event_id).toBeTruthy();
  expect(fixture.event_time).toBeGreaterThan(0);
  expect(fixture.authorizations).toHaveLength(1);
  expect(fixture.authorizations[0]?.team_id).toBeTruthy();
  expect(fixture.authorizations[0]?.user_id).toBeTruthy();
}

describe("assistant Slack event fixtures", () => {
  it("parses the assistant_thread_started fixture to its declared shape", () => {
    const fixture: AssistantThreadStartedEvent = parseFixture(assistantThreadStartedFixture);

    expectEventCallbackShape(fixture);
    expect(fixture.event.type).toBe("assistant_thread_started");
    expect(fixture.event.event_ts).toBeTruthy();
    expect(fixture.event.assistant_thread.user_id).toBe("U123ABC456");
    expect(fixture.event.assistant_thread.channel_id).toBe("D123ABC456");
    expect(fixture.event.assistant_thread.thread_ts).toBe("1729999327.187299");
    expect(fixture.event.assistant_thread.context.channel_id).toBe("C123ABC456");
    expect(fixture.event.assistant_thread.context.team_id).toBeTruthy();
  });

  it("parses the assistant_thread_context_changed fixture to its declared shape", () => {
    const fixture: AssistantThreadContextChangedEvent = parseFixture(
      assistantThreadContextChangedFixture,
    );

    expectEventCallbackShape(fixture);
    expect(fixture.event.type).toBe("assistant_thread_context_changed");
    expect(fixture.event.event_ts).toBeTruthy();
    expect(fixture.event.assistant_thread.user_id).toBe("U123ABC456");
    expect(fixture.event.assistant_thread.channel_id).toBe("D123ABC456");
    expect(fixture.event.assistant_thread.thread_ts).toBe("1729999327.187299");
    expect(fixture.event.assistant_thread.context.channel_id).toBe("C987XYZ654");
    expect(fixture.event.assistant_thread.context.team_id).toBeTruthy();
  });

  it("parses the assistant-pane message.im fixture to its declared shape", () => {
    const fixture: AssistantMessageImEvent = parseFixture(assistantMessageImFixture);

    expectEventCallbackShape(fixture);
    expect(fixture.event.type).toBe("message");
    expect(fixture.event.channel_type).toBe("im");
    expect(fixture.event.channel).toBe("D123ABC456");
    expect(fixture.event.user).toBe("U123ABC456");
    expect(fixture.event.thread_ts).toBe("1729999327.187299");
    expect(fixture.event.text).toContain("Summarize");
  });

  it("parses the legacy message.im fixture to its declared shape", () => {
    const fixture: LegacyMessageImEvent = parseFixture(legacyMessageImFixture);

    expectEventCallbackShape(fixture);
    expect(fixture.event.type).toBe("message");
    expect(fixture.event.channel_type).toBe("im");
    expect(fixture.event.channel).toBe("DLEGACY123");
    expect(fixture.event.user).toBe("U123ABC456");
    expect(fixture.event.thread_ts).toBeUndefined();
    expect(fixture.event.text).toBe("Are you online?");
  });
});
