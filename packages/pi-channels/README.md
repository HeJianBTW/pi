# @amaster.ai/pi-channels

![pi-channels preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-channels/preview.png)

Pi extension for native messaging channels.

This package follows the same extension shape as the open-source `@e9n/pi-channels`
package: it registers a `notify` tool, channel events, route aliases, and an optional
chat bridge that turns incoming channel messages into pi prompts.

It does not depend on `@e9n/pi-channels` at runtime. That package is published as
a standalone extension source package with the older `@mariozechner/*` peer
namespace and Slack/Telegram dependencies. This package keeps the same channel
contract while targeting this repo's `@earendil-works/*` API surface and native
Feishu/WeCom adapters.

## Channels

- `feishu` - Native Feishu/Lark app messaging backed by the official
  `@larksuiteoapi/node-sdk`. Supports outgoing text messages, WebSocket events
  by default, and HTTP event callbacks as a fallback.
- `wecom` - Native WeCom self-built app messaging. Supports outgoing text
  messages, appchat messages, encrypted HTTP callbacks for text messages, token
  caching, request timeouts, and actionable API errors such as trusted-IP
  failures.
- `webhook` - Generic outgoing HTTP requests.

## Example

```json
{
  "pi-channels": {
    "adapters": {
      "feishu": {
        "type": "feishu",
        "appId": "${FEISHU_APP_ID}",
        "appSecret": "${FEISHU_APP_SECRET}",
        "eventMode": "websocket",
        "respondToMentionsOnly": true
      },
      "wecom": {
        "type": "wecom",
        "corpId": "${WECOM_CORP_ID}",
        "agentId": "${WECOM_AGENT_ID}",
        "secret": "${WECOM_SECRET}",
        "timeoutMs": 15000,
        "token": "${WECOM_CALLBACK_TOKEN}",
        "encodingAesKey": "${WECOM_ENCODING_AES_KEY}",
        "incoming": {
          "enabled": true,
          "port": 8788,
          "path": "/wecom/events"
        }
      }
    },
    "routes": {
      "ops": {
        "adapter": "feishu",
        "recipient": "oc_xxx"
      }
    },
    "bridge": {
      "enabled": true
    }
  }
}
```

### Feishu modes

WebSocket is the default and recommended mode because it does not require a
public callback URL:

```json
{
  "type": "feishu",
  "appId": "${FEISHU_APP_ID}",
  "appSecret": "${FEISHU_APP_SECRET}",
  "eventMode": "websocket",
  "respondToMentionsOnly": true,
  "allowedChatIds": ["oc_xxx"]
}
```

Use HTTP callback mode when the deployment already exposes a Feishu event URL.
The SDK handles challenge responses, token verification, and encrypted event
payloads:

```json
{
  "type": "feishu",
  "appId": "${FEISHU_APP_ID}",
  "appSecret": "${FEISHU_APP_SECRET}",
  "eventMode": "http",
  "verificationToken": "${FEISHU_VERIFICATION_TOKEN}",
  "encryptKey": "${FEISHU_ENCRYPT_KEY}",
  "botOpenId": "ou_xxx",
  "incoming": {
    "port": 8787,
    "path": "/feishu/events"
  }
}
```

Set `"eventMode": "off"` for outgoing-only usage.

## Tool

```text
notify(action: "send", adapter: "ops", text: "hello")
notify(action: "list")
notify(action: "test", adapter: "ops")
```

For Feishu, recipients default to `chat_id`. Prefix the recipient to override the
receive id type:

```text
chat_id:oc_xxx
open_id:ou_xxx
user_id:abc123
email:name@example.com
```

For WeCom, recipients default to `touser`. Prefix the recipient to send to parties
or tags. Prefix with `chat:` or `appchat:` to use the WeCom appchat API:

```text
user:zhangsan
party:2
tag:7
appchat:chat-id
```

If WeCom returns `60020 not allow to access from your ip`, the adapter raises a
typed `WeComApiError` with category `ip_whitelist`. Configure the trusted IP in
the WeCom console, or run pi behind a fixed egress proxy that is allowed by the
enterprise.

## Events

- `channel:send`
- `channel:receive`
- `channel:register`
- `channel:remove`
- `channel:list`

## Commands

```text
/channel list
/channel reload
/channel bridge on
/channel bridge off
/channel bridge status
```
