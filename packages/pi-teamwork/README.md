# @amaster.ai/pi-teamwork

Pi extension for team collaboration and project management. Provides LLM-callable tools to interact with issue trackers and project management systems.

## Supported Providers

- **Multica** — CLI-based adapter via [multica](https://github.com/multica-ai/multica)

## Configuration

Add to `.pi/settings.json`:

```json
{
  "pi-teamwork": {
    "enabled": true,
    "provider": "multica",
    "multica": {
      "binary": "multica",
      "workspace": "",
      "token": ""
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `enabled` | Enable/disable the extension |
| `provider` | Provider name (currently only `multica`) |
| `multica.binary` | Path to multica binary (default: `multica`) |
| `multica.workspace` | Workspace ID override |
| `multica.token` | Auth token for headless login |

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
