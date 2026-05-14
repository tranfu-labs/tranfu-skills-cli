import type { TfsError } from "../types.js";

export function emitError(e: TfsError): never {
  process.stderr.write(JSON.stringify(e) + "\n");
  process.exit(e.exit_code);
}
