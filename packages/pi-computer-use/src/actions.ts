import type { ComputerClient } from './computer-client.js';

export interface ComputerAction {
  type: string;
  x?: number;
  y?: number;
  button?: string;
  text?: string;
  keys?: string[];
  scroll_x?: number;
  scroll_y?: number;
  path?: Array<[number, number]>;
  command?: string;
}

export async function dispatchAction(
  client: ComputerClient,
  action: ComputerAction,
): Promise<string | undefined> {
  switch (action.type) {
    case 'screenshot':
      return undefined;

    case 'click': {
      const cmd = action.button === 'right' ? 'right_click' : 'left_click';
      await client.sendCommand(cmd, { x: action.x, y: action.y });
      return `Clicked (${action.button ?? 'left'}) at (${action.x}, ${action.y})`;
    }

    case 'double_click':
      await client.sendCommand('double_click', { x: action.x, y: action.y });
      return `Double-clicked at (${action.x}, ${action.y})`;

    case 'type':
      await client.sendCommand('type_text', { text: action.text });
      return `Typed "${action.text}"`;

    case 'keypress':
      await client.sendCommand('hotkey', { keys: action.keys });
      return `Pressed keys: ${action.keys?.join('+')}`;

    case 'scroll':
      await client.sendCommand('scroll', {
        x: action.scroll_x ?? 0,
        y: action.scroll_y ?? 0,
      });
      return `Scrolled (${action.scroll_x ?? 0}, ${action.scroll_y ?? 0})`;

    case 'move':
      await client.sendCommand('move_cursor', { x: action.x, y: action.y });
      return `Moved cursor to (${action.x}, ${action.y})`;

    case 'drag':
      await client.sendCommand('drag', { path: action.path, button: action.button ?? 'left' });
      return `Dragged along ${action.path?.length ?? 0} points`;

    case 'wait':
      await new Promise((r) => setTimeout(r, 1_000));
      return 'Waited 1 second';

    case 'run_command': {
      const result = await client.sendCommand('run_command', { command: action.command });
      const stdout = (result.stdout as string) ?? '';
      const stderr = (result.stderr as string) ?? '';
      const output = [stdout, stderr].filter(Boolean).join('\n');
      return output || 'Command executed (no output)';
    }

    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }
}
