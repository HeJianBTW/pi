# @amaster.ai/pi-computer-use

pi-coding-agent extension that wraps [cua-driver-rs](https://github.com/trycua/cua/), exposing desktop automation tools with a `computer_use_` prefix.

## Features

- **Zero external dependencies** — pre-compiled cua-driver-rs binaries bundled for all platforms
- **MCP stdio communication** — spawns `cua-driver mcp` via `StdioClientTransport`, JSON-RPC over stdio
- **Dynamic tool discovery** — auto-discovers upstream MCP tools and registers with `computer_use_` prefix
- **Smart tool filtering** — excludes non-essential tools (agent cursor, recording, config), exposes 18 core tools
- **Optional visual analysis** — `computer_use_analyze_screenshot` via configurable vision model
- **Cross-platform** — darwin-arm64/x64, linux-x64, win32-x64/arm64

## Install

```bash
bun add @amaster.ai/pi-computer-use
```

Requires Node.js >= 20 and `@earendil-works/pi-coding-agent >= 0.74.0`.

## Usage

Install the package and pi-coding-agent will automatically discover and load the extension. All tools are registered on `session_start`.

Configure via `.pi/settings.json` (project-level) or `~/.pi/agent/settings.json` (user-level) under the `"pi-computer-use"` key:

```json
{
  "pi-computer-use": {
    "mode": "bundled"
  }
}
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `mode` | `'bundled' \| 'path'` | `'bundled'` | Binary resolution strategy |
| `binaryPath` | `string` | — | Custom cua-driver binary path (requires `mode: 'path'`) |
| `extraArgs` | `string[]` | — | Extra CLI arguments passed to cua-driver |
| `visionModel` | `VisionModelConfig` | — | Enable visual screenshot analysis |

### Vision Model (Optional)

Enable `computer_use_analyze_screenshot` by referencing a model already configured in Pi's model registry (`models.json`):

```json
{
  "pi-computer-use": {
    "visionModel": {
      "provider": "openai",
      "model": "gpt-4o"
    }
  }
}
```

The extension resolves API key, base URL, and headers from the model registry automatically — no need to duplicate credentials here.

## Exposed Tools (18)

### Core

| Tool | Description |
|------|-------------|
| `computer_use_screenshot` | Capture screen |
| `computer_use_click` | Click at coordinates |
| `computer_use_type_text` | Type text |
| `computer_use_press_key` | Press a keyboard key |
| `computer_use_scroll` | Scroll in a direction |
| `computer_use_hotkey` | Press key combination |

### Common

| Tool | Description |
|------|-------------|
| `computer_use_double_click` | Double-click |
| `computer_use_right_click` | Right-click (context menu) |
| `computer_use_drag` | Drag from one point to another |
| `computer_use_get_screen_size` | Get screen dimensions |
| `computer_use_get_accessibility_tree` | Get accessibility tree for element discovery |
| `computer_use_set_value` | Set form field value directly |
| `computer_use_get_cursor_position` | Get current cursor position |

### Situational

| Tool | Description |
|------|-------------|
| `computer_use_list_apps` | List running applications |
| `computer_use_list_windows` | List open windows |
| `computer_use_get_window_state` | Get window state/position |
| `computer_use_launch_app` | Launch an application |
| `computer_use_kill_app` | Kill an application |

## Excluded Tools (15)

Agent cursor styling, recording/replay, config management, and redundant operations (covered by other tools) are filtered out.

## Supported Platforms

| Platform | Binary |
|----------|--------|
| macOS ARM64 | `bin/darwin-arm64/cua-driver` |
| macOS x64 | `bin/darwin-x64/cua-driver` |
| Linux x64 | `bin/linux-x64/cua-driver` |
| Windows x64 | `bin/win32-x64/cua-driver.exe` |
| Windows ARM64 | `bin/win32-arm64/cua-driver.exe` |

## License

Apache-2.0
