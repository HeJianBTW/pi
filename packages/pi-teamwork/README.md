# @amaster.ai/pi-teamwork

Pi extension for team collaboration and project management. Provides LLM-callable tools to interact with issue trackers and project management systems.

## Supported Providers

- **Multica** — CLI-based adapter via [multica](https://github.com/multica-ai/multica)

## Configuration

This extension does **not** manage multica's setup or credentials — those live with the multica CLI itself. Pick one of two modes:

### Mode 1 — Pre-configured environment (recommended)

Run `multica setup` once on the machine and finish login through multica's normal flow. The extension will reuse that state, and you can leave the auth fields empty:

```json
{
  "pi-teamwork": {
    "enabled": true,
    "provider": "multica",
    "multica": {
      "workspace": ""
    }
  }
}
```

### Mode 2 — Headless token

For CI or non-interactive environments where you can't run `multica setup`. Issue a long-lived token from your multica server, and the extension will run `multica login --token <token>` on every `session_start`:

```json
{
  "pi-teamwork": {
    "enabled": true,
    "provider": "multica",
    "multica": {
      "token": "<token-from-multica-server>"
    }
  }
}
```

> ⚠️ `token` is a credential. Keep it out of version control — put it in a local-only settings file or inject via env-substituted config.

| Field | Description |
|-------|-------------|
| `enabled` | Enable/disable the extension |
| `provider` | Provider name (currently only `multica`) |
| `multica.binary` | Path to multica binary (default: `multica`) |
| `multica.workspace` | Workspace ID override; leave empty to use multica's default |
| `multica.token` | Headless-login token. Only set in mode 2; omit when multica is already logged in on the machine |

## Tools

| Tool | Description |
|------|-------------|
| `issue_list` | List issues with optional filters (status, assignee, project, limit) |
| `issue_get` | Get detailed info about a specific issue |
| `issue_create` | Create a new issue |
| `issue_update` | Update an existing issue (title, description, status, priority, assignee) |
| `issue_comment` | Add a comment to an issue |
| `project_list` | List all projects in the workspace |
| `teamwork_status` | Check provider/daemon status |

## Commands

- `/teamwork-status` — Show current provider status

## Architecture

```
src/
├── index.ts              # Generic tool layer (provider-agnostic)
├── types.ts              # TeamworkProvider interface + shared types
└── adapters/
    └── multica.ts        # Multica CLI adapter + initialization
```

The extension uses a provider pattern — `index.ts` registers tools that delegate to a `TeamworkProvider` interface. Adding a new provider (Linear, Jira, etc.) only requires implementing the interface and adding a factory branch in `session_start`.
