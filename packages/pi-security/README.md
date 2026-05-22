# Pi Security

`@amaster.ai/pi-security` provides a resource-aware security policy engine and a Pi extension entry point.

The core engine classifies tool calls into resources such as files, shell commands, network access, memory writes, MCP calls, and subagent spawns. It then applies profile rules to decide whether a call is allowed, denied, sandbox-only, allowed with constraints, or requires human approval.

## Pi extension

Install the extension entry point `@amaster.ai/pi-security/extension` and load the `pi-security` settings key through Pi `SettingsManager`:

```json
{
  "pi-security": {
    "enabled": true,
    "profile": "auto-review",
    "approvals": {
      "allowSessionGrants": true
    },
    "security": {
      "profiles": {
        "auto-review": {
          "rules": [
            {
              "id": "ask-file-writes",
              "tools": ["write_file", "edit_file"],
              "decision": { "kind": "ask", "reason": "File modifications require approval." }
            }
          ]
        }
      }
    }
  }
}
```

The extension listens to Pi `tool_call` and `user_bash` events. It does not register an LLM-callable tool that can bypass policy. Human approvals are requested through Pi UI primitives when UI is available; non-interactive contexts fail closed when a rule requires approval.

## Security profiles

Built-in profiles and their capability policies:

| Profile | Mode | Description |
|---------|------|-------------|
| `auto-review` | Denylist (`allow: ['*']`) | All tools exposed by default; risk-based rules gate dangerous ops |
| `admin` / `full-access` | Denylist (`allow: ['*']`) | All tools allowed, no security rules |
| `sandbox-exec` / `copilot` | Allowlist | Core tools + MCP allowed |
| `workspace-write` | Allowlist | File R/W, no shell |
| `workspace-read` | Allowlist | Read-only file access |
| `chat` | Allowlist | Memory search only |
| `scheduled` | Allowlist | Read + MCP, no mutations |
| `subagent` | Allowlist | Like sandbox-exec but no memory_write/sessions_spawn |

### Denylist vs Allowlist

- **Denylist mode** (`allow: ['*']`): All capabilities exposed; use `deny` array and security rules to block specific tools or risky operations. `auto-review` uses this mode — new tools are automatically available without config changes.
- **Allowlist mode** (explicit `allow` list): Only listed capabilities are exposed; unlisted tools are denied.

Custom profiles can override capability policies via settings:

```json
{
  "pi-security": {
    "security": {
      "profiles": {
        "auto-review": {
          "capabilities": {
            "deny": ["sessions_spawn"]
          }
        }
      }
    }
  }
}
```

## Commands

- `/pi-security-status` shows the active profile, audit count, and in-session grants.
- `/pi-security-audit [limit]` shows recent authorization decisions without raw sensitive output.
- `/pi-security-reset` clears in-session approval grants.

## Trust model

This module is an execution gate, not a filesystem sandbox by itself. Deny and approval decisions are enforceable because they run before Pi tool execution. Constraint decisions must be paired with a runtime that actually enforces the returned constraints.

Sensitive paths such as SSH keys, `.env`, credentials, tokens, private keys, and secret files are denied by baseline policy. Audit entries include tool names, resource summaries, risk level, and decision metadata, but they should not include plaintext secrets.
