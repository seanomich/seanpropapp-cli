import { loadConfig, updateConfig } from "../config.js";
import {
  generatePairToken,
  osc8Link,
  pairUrl,
} from "./pair-url.js";

export interface PairOptions {
  configDir?: string;
}

/**
 * Escape-hatch: generate a fresh pair URL without starting a bridge.
 * Assumes the bridge is already running and will pick up the new token
 * from the shared config on its next handshake.
 *
 * NOTE: in v1.4.0 the bridge holds tokens in-memory at start; a fully live
 * rotation flow is a v1.4.x follow-up (see Lane C-Polish doctor).
 */
export async function runPair(opts: PairOptions = {}): Promise<void> {
  const cfg = await loadConfig(opts.configDir);
  if (!cfg.bridge_port) {
    process.stderr.write(
      "Bridge not running. Start it first with: seanpropapp connect (or `seanpropapp bridge`).\n",
    );
    process.exitCode = 1;
    return;
  }

  const token = generatePairToken();
  await updateConfig({ pair_token: token }, opts.configDir);

  const url = pairUrl(token);
  process.stdout.write(`Pair URL: ${osc8Link(url, url)}\n`);
  process.stdout.write(`Or paste in browser: ${url}\n`);
}
