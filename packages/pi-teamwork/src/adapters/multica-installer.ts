import type { ExecFn } from '../types.js';

export type InstallResult = {
  installed: boolean;
  alreadyPresent: boolean;
  error?: string;
};

export async function ensureMulticaBinary(binary: string, exec: ExecFn): Promise<InstallResult> {
  if (await isAvailable(binary, exec)) {
    return { installed: true, alreadyPresent: true };
  }

  return {
    installed: false,
    alreadyPresent: false,
    error: 'automatic installation is disabled; install a pinned multica release manually',
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
