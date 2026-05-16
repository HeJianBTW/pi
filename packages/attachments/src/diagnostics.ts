import { spawn } from "node:child_process";

export type AttachmentDependencyCheck = {
  name: "libreoffice" | "imagemagick" | "ghostscript" | "tesseract" | "poppler";
  command: string;
  installed: boolean;
  version?: string;
};

export async function checkAttachmentHostDependencies(): Promise<AttachmentDependencyCheck[]> {
  const checks = [
    { name: "libreoffice" as const, command: "soffice", args: ["--version"] },
    { name: "imagemagick" as const, command: "magick", args: ["-version"] },
    { name: "ghostscript" as const, command: "gs", args: ["--version"] },
    { name: "tesseract" as const, command: "tesseract", args: ["--version"] },
    { name: "poppler" as const, command: "pdftotext", args: ["-v"] },
  ];
  return Promise.all(checks.map(async (check) => {
    const result = await run(check.command, check.args);
    return {
      name: check.name,
      command: check.command,
      installed: result.code === 0,
      ...(result.output ? { version: result.output.split(/\r?\n/)[0] } : {}),
    };
  }));
}

function run(command: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.on("error", () => resolve({ code: -1, output: "" }));
    child.on("close", (code) => resolve({ code, output: Buffer.concat(chunks).toString("utf8").trim() }));
  });
}
