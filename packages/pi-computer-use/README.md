# @amaster.ai/pi-computer-use

![pi-computer-use preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-computer-use/preview.png)

pi-coding-agent extension that wraps [cua-driver-rs](https://github.com/trycua/cua/), exposing desktop automation tools with a `computer_use_` prefix.

## Features

- **Zero external dependencies** — pre-compiled cua-driver-rs binaries bundled for all platforms
- **MCP stdio communication** — spawns `cua-driver mcp` via `StdioClientTransport`, JSON-RPC over stdio
- **Dynamic tool discovery** — auto-discovers upstream MCP tools and registers with `computer_use_` prefix; falls back to a built-in tool list when cua-driver fails to start
- **Smart tool filtering** — excludes non-essential tools (agent cursor, recording, config, raw screenshot), exposes 17 action tools + 1 vision tool
- **Optional visual analysis** — `computer_use_analyze_screenshot` via configurable vision model
- **Cross-platform permission handling** — detects platform-specific permission issues (macOS TCC, Windows UAC, Linux display server access) and returns actionable guidance
- **Graceful degradation** — tools are always registered even when cua-driver cannot connect; lazy reconnect is attempted on each tool call

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

## Exposed Tools (17 + 1 vision)

### Input

| Tool | Description |
|------|-------------|
| `computer_use_click` | Left-click via element_index or x/y coordinates |
| `computer_use_double_click` | Double-click at x/y or on an AX element |
| `computer_use_right_click` | Right-click (context menu) |
| `computer_use_type_text` | Insert text via AX or CGEvent fallback |
| `computer_use_press_key` | Press and release a single key |
| `computer_use_hotkey` | Press a key combination (e.g. Cmd+C) |
| `computer_use_scroll` | Scroll by line or page in a direction |
| `computer_use_drag` | Press-drag-release gesture between two points |
| `computer_use_set_value` | Set value on UI elements (popups, sliders, steppers) |

### Query

| Tool | Description |
|------|-------------|
| `computer_use_get_screen_size` | Get display dimensions and scale factor |
| `computer_use_get_cursor_position` | Get current mouse cursor position |
| `computer_use_get_accessibility_tree` | Lightweight desktop snapshot (apps, windows, bounds) |
| `computer_use_get_window_state` | Full AX tree of a window with actionable element indices |
| `computer_use_list_windows` | List all top-level windows with bounds and z-order |
| `computer_use_list_apps` | List running and installed apps with state flags |

### App Lifecycle

| Tool | Description |
|------|-------------|
| `computer_use_launch_app` | Launch an app in the background without focus steal |
| `computer_use_kill_app` | Force-terminate a process by pid |

### Vision (requires `visionModel` config)

| Tool | Description |
|------|-------------|
| `computer_use_analyze_screenshot` | Take a screenshot and analyze it with a vision model |

## Excluded Tools (16)

Agent cursor styling, recording/replay, config management, zoom, raw screenshot (use `analyze_screenshot` instead), and browser-specific operations are filtered out.

## Permissions

On `session_start`, the extension checks permissions via cua-driver's `check_permissions` tool. Platform-specific guidance is provided:

| Platform | Accessibility | Screen Capture |
|----------|--------------|----------------|
| macOS | System Settings → Privacy & Security → Accessibility | System Settings → Privacy & Security → Screen & System Audio Recording |
| Windows | Run as Administrator / UI Automation access | Check DRM or security policy |
| Linux | AT-SPI accessibility service | PipeWire portal or X11 access |

When cua-driver fails to connect (missing permissions, binary not found, etc.):
1. User is notified with a platform-appropriate warning
2. Tools are still registered using a built-in fallback schema
3. On each tool call, lazy reconnect is attempted; if it still fails, a friendly error with permission instructions is returned

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
