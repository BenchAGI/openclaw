# OpenClaw Slack

Official OpenClaw channel plugin for Slack channels, DMs, commands, and app events.

Install from OpenClaw:

```bash
openclaw plugin add @openclaw/slack
```

Configure the Slack app credentials and allowed workspaces/channels in OpenClaw. The plugin lets agents receive Slack events and reply through the configured Slack app.

Read-style agent actions (`readMessages`, `listPins`, `reactions`, and the channel scope of `downloadFile`) are authorized per requesting end user, not by bot-token visibility alone: when a request originates from a Slack conversation, reading any channel other than that conversation requires the requesting Slack user to be a member of the target channel. This applies under `groupPolicy: "open"` too, and the membership check fails closed. Owner-authenticated senders and non-Slack surfaces keep operator-level reads gated by config policy only.
