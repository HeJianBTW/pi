# @amaster.ai/pi-computer-use

![pi-computer-use preview](https://raw.githubusercontent.com/TGYD-helige/pi/master/packages/pi-computer-use/preview.png)

Cross-platform computer-use tools for Pi desktop automation. The extension
exposes a native MCP tool surface with a `computer_use_` prefix. The bundled
runtime comes from the official
[Cua Driver Rust 0.9.0 release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.9.0).

## What it provides

- One Rust 0.9.0 driver line across macOS, Linux, and Windows
- 49 version-pinned upstream tools, including sessions, element tokens,
  accessibility + screenshot state, native input, browser tools, diagnostics,
  recording, and permission policy support
- Full MCP text, image, and `structuredContent` forwarding
- Owned daemon + MCP proxy lifecycle with reconnect and AbortSignal propagation
- A non-prompting permission probe on session start
- Once-per-session app-launch approval and confirmation for high-risk operations
- Bounded text and structured results before they enter Pi's context
- Optional secondary vision analysis through a configured Pi model

`get_window_state` is the primary perception tool. Cua Driver 0.9 returns the
accessibility tree, structured elements with `element_token`, and a screenshot in
one response. The standalone `screenshot` tool no longer exists.

## Install

```bash
bun add @amaster.ai/pi-computer-use
```

The package bundles signed/precompiled driver assets. No separate Cua Driver
installation is required.

## Configuration

Configure `.pi/settings.json` or `~/.pi/agent/settings.json`:

```json
{
  "pi-computer-use": {
    "mode": "bundled",
    "confirmAppLaunch": true,
    "confirmDangerousActions": true
  }
}
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"bundled" \| "path"` | `"bundled"` | Use the packaged 0.9.0 driver or a compatible custom binary |
| `binaryPath` | `string` | — | Custom driver path when `mode` is `"path"` |
| `extraArgs` | `string[]` | — | Additional arguments appended to `cua-driver mcp` |
| `confirmAppLaunch` | `boolean` | `true` | Ask once per app target before `launch_app` |
| `confirmDangerousActions` | `boolean` | `true` | Confirm high-risk tools such as `kill_app` and `replay_trajectory` |
| `visionModel` | `{ provider, model }` | — | Register `computer_use_analyze_screenshot` |

In non-interactive modes, confirmation-required tools return an error unless the
corresponding confirmation setting is explicitly disabled.

### Optional vision model

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

`computer_use_analyze_screenshot` requires both `pid` and `window_id`. It calls
`get_window_state`, reuses the returned image, and invokes the configured model.
Use it only when the primary model cannot resolve visual ambiguity.

## Runtime and permissions

At `session_start`, the extension starts the driver daemon and MCP proxy, then
registers the exact live `tools/list` surface for that platform and calls
`check_permissions({ prompt: false })`. The generated macOS 0.9.0 manifest is
used only to detect release drift. If startup discovery fails, the extension
registers `computer_use_connect` (and `/computer-use-connect`) so a later retry
can install the exact live platform contract without advertising another OS's schemas.

- **Bundled macOS:** launches the signed `CuaDriver.app` through LaunchServices,
  so Accessibility and Screen Recording grants belong to `com.trycua.driver`.
- **Custom macOS binary:** uses Cua Driver embedded mode and inherits the host
  application's TCC responsibility chain.
- **Linux/Windows:** starts an extension-owned daemon in the interactive user
  session and tears it down on session shutdown.

## Supported targets

| Platform | Bundled target |
| --- | --- |
| macOS ARM64 / x64 | `bin/darwin-universal/CuaDriver.app` |
| Linux x64 | `bin/linux-x64/cua-driver` |
| Linux ARM64 | `bin/linux-arm64/cua-driver` |
| Windows x64 | `bin/win32-x64/cua-driver.exe` + `cua-driver-uia.exe` |
| Windows ARM64 | `bin/win32-arm64/cua-driver.exe` + `cua-driver-uia.exe` |

## Canonical workflow

1. `computer_use_start_session`
2. `computer_use_launch_app` or `computer_use_list_windows`
3. `computer_use_get_window_state`
4. Act using `element_token`/`element_index`, falling back to pixels for
   custom-drawn surfaces
5. Re-run `computer_use_get_window_state` and verify the change
6. `computer_use_end_session`

Tool descriptions and schemas are discovered from the exact live driver, so the
model receives the platform-specific contract without a separate bundled skill.

## License

Apache-2.0 for this package. Bundled Cua Driver assets retain their upstream
license and release metadata.
