/**
 * Minimal fallback view published when the renderer errors or is unavailable.
 * Intentionally plain — no agent branding, no marketing. Just a clear status
 * line so the user isn't staring at the "nothing here yet" default screen.
 */

export function buildHomeFallbackView(params: {
  accountName: string;
  reason: string;
  generatedAt: Date;
}): object[] {
  const { accountName, reason, generatedAt } = params;
  return [
    {
      type: "header",
      text: { type: "plain_text", text: `${accountName} · Home`, emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `_Home view unavailable._\n\n${truncate(reason, 200)}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Rendered ${generatedAt.toISOString()} · Reopen the tab to retry.`,
        },
      ],
    },
  ];
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}
