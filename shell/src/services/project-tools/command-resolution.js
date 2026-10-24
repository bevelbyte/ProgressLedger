import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

// Windows package-manager shims (.cmd/.bat) cannot be launched directly by
// child_process.execFile with shell:false. Resolve npm's trusted shim to the
// real Node executable + npm CLI instead of introducing a shell interpreter.
function findOnPath(fileName) {
  const pathValue = process.env.PATH || "";
  for (const entry of pathValue.split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, fileName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveApprovedProjectCommand(command, argv = []) {
  if (process.platform !== "win32") return { command, argv };

  const base = String(command).toLowerCase();
  if (base !== "npm" && base !== "npm.cmd") return { command, argv };

  const shim = findOnPath("npm.cmd");
  if (!shim) {
    return {
      error: {
        code: "command-not-found",
        message: "approved npm command could not be resolved on PATH",
      },
    };
  }

  const nodeDir = dirname(shim);
  const nodeExe = join(nodeDir, "node.exe");
  const npmCli = join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(nodeExe) || !existsSync(npmCli)) {
    return {
      error: {
        code: "command-not-found",
        message: "approved npm command has no local Node/npm CLI backing it",
      },
    };
  }

  return { command: nodeExe, argv: [npmCli, ...argv] };
}
