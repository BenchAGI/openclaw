// Bench fork #80: the claude-cli-* backend family shares the Claude stream-json dialect.
import { describe, expect, it } from "vitest";
import type { CliToolUseStartDelta } from "./cli-output-contracts.js";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";

describe("claude-cli-* backend family dialect gate", () => {
  it("dispatches tool events for the claude-cli-ultracode backend without an explicit dialect", () => {
    // Regression: the ultracode variant resolves to backend/provider id
    // "claude-cli-ultracode" and never sets jsonlDialect. Until the dialect gate
    // recognized the claude-cli-* family, the parser silently skipped tool-event
    // dispatch, so a native AskUserQuestion never reached onToolUseStart.
    const starts: CliToolUseStartDelta[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli-ultracode",
      onAssistantDelta: () => undefined,
      onToolUseStart: (delta: CliToolUseStartDelta) => starts.push(delta),
    });

    parser.push(
      [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "toolu_ask", name: "AskUserQuestion", input: {} },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: '{"questions":[{"question":"Pick",' },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 1,
            delta: {
              type: "input_json_delta",
              partial_json: '"options":[{"label":"A"},{"label":"B"}]}]}',
            },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_stop", index: 1 },
        }),
      ].join("\n") + "\n",
    );
    parser.finish();

    expect(starts).toEqual([
      {
        toolCallId: "toolu_ask",
        name: "AskUserQuestion",
        args: { questions: [{ question: "Pick", options: [{ label: "A" }, { label: "B" }] }] },
      },
    ]);
  });

  it("streams native text deltas for the claude-cli-ultracode backend", () => {
    const deltas: string[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "claude",
        output: "jsonl",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli-ultracode",
      onAssistantDelta: (delta: { delta: string }) => deltas.push(delta.delta),
    });

    parser.push(
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
      }) + "\n",
    );
    parser.finish();

    expect(deltas).toEqual(["hi"]);
  });
});
