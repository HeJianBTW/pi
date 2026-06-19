import type { ExecFn } from '../types.js';

export type InstallResult = {
  installed: boolean;
  alreadyPresent: boolean;
  error?: string;
};

const BREW_TAP = 'multica-ai/tap/multica';
const INSTALL_SCRIPT_URL =
  'https://raw.githubusercontent.com/multica-ai/multica/main/scripts/install.sh';
const INSTALL_PS1_URL =
  'https://raw.githubusercontent.com/multica-ai/multica/main/scripts/install.ps1';

export async function ensureMulticaBinary(binary: string, exec: ExecFn): Promise<InstallResult> {
  if (await isAvailable(binary, exec)) {
    return { installed: true, alreadyPresent: true };
  }

  const platform = process.platform;
  let installError: string | undefined;

  if (platform === 'win32') {
    installError = await installWindows(exec);
  } else {
    installError = await installUnix(exec);
  }

  if (installError) {
    return { installed: false, alreadyPresent: false, error: installError };
  }

  if (await isAvailable(binary, exec)) {
    return { installed: true, alreadyPresent: false };
  }

  return {
    installed: false,
    alreadyPresent: false,
    error: 'multica binary not found on PATH after installation',
  };
}

async function isAvailable(binary: string, exec: ExecFn): Promise<boolean> {
  try {
    const { code } = await exec(binary, ['--version']);
    return code === 0;
  } catch {
    return false;
  }
}

async function installUnix(exec: ExecFn): Promise<string | undefined> {
  const hasBrew = await checkBrew(exec);

  if (hasBrew) {
    try {
      const { code } = await exec('brew', ['install', BREW_TAP]);
      if (code === 0) return undefined;
    } catch {
      // brew threw, fall through to curl
    }
  }

  return installViaCurl(exec);
}

async function checkBrew(exec: ExecFn): Promise<boolean> {
  try {
    const { code } = await exec('which', ['brew']);
    return code === 0;
  } catch {
    return false;
  }
}

async function installViaCurl(exec: ExecFn): Promise<string | undefined> {
  // multica's upstream install.sh tries `/usr/local/bin` first, then `sudo mv`,
  // and only falls back to `~/.local/bin` if `sudo` is missing entirely. On
  // CI runners (and other environments where the user has sudo configured but
  // no NOPASSWD), the sudo branch hangs on a password prompt and the script
  // exits non-zero before reaching the user-bin fallback.
  //
  // Force the user-bin path via MULTICA_BIN_DIR. macOS users who own
  // /usr/local/bin still take the first branch (writable), so this only
  // changes behavior for the cases that were broken.
  const userBin = `${process.env.HOME ?? ''}/.local/bin`;
  const cmd = `curl -fsSL ${INSTALL_SCRIPT_URL} | MULTICA_BIN_DIR=${JSON.stringify(userBin)} bash`;
  try {
    const { code, stderr } = await exec('bash', ['-c', cmd]);
    if (code !== 0) {
      return stderr.trim() || `install script exited with code ${code}`;
    }
    // ~/.local/bin isn't on the inherited PATH on every Linux runner; without
    // this the very next isAvailable() spawn(multica) misses the binary we
    // just dropped.
    if (process.env.HOME) {
      const path = process.env.PATH ?? '';
      if (!path.split(':').includes(userBin)) {
        process.env.PATH = path ? `${userBin}:${path}` : userBin;
      }
    }
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function installWindows(exec: ExecFn): Promise<string | undefined> {
  try {
    const { code, stderr } = await exec('powershell', ['-Command', `irm ${INSTALL_PS1_URL} | iex`]);
    if (code === 0) return undefined;
    return stderr.trim() || `install script exited with code ${code}`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
