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

## Commands

- `/pi-security-status` shows the active profile, audit count, and in-session grants.
- `/pi-security-audit [limit]` shows recent authorization decisions without raw sensitive output.
- `/pi-security-reset` clears in-session approval grants.

## Trust model

This module is an execution gate, not a filesystem sandbox by itself. Deny and approval decisions are enforceable because they run before Pi tool execution. Constraint decisions must be paired with a runtime that actually enforces the returned constraints.

Sensitive paths such as SSH keys, `.env`, credentials, tokens, private keys, and secret files are denied by baseline policy. Audit entries include tool names, resource summaries, risk level, and decision metadata, but they should not include plaintext secrets.
