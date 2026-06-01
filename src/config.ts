import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const ProvidersDetectedSchema = z.object({
  claude: z.boolean().optional(),
  codex: z.boolean().optional(),
  gemini: z.boolean().optional(),
});

const ConfigSchema = z.object({
  pair_token: z.string().optional(),
  bridge_url: z.string().optional(),
  bridge_port: z.number().int().positive().optional(),
  paired_at: z.string().optional(),
  device_name: z.string().optional(),
  providers_detected: ProvidersDetectedSchema.optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

const DEFAULT_CONFIG_DIR_NAME = ".seanpropapp";

export function getConfigDir(override?: string): string {
  if (override) return override;
  return path.join(os.homedir(), DEFAULT_CONFIG_DIR_NAME);
}

export function getConfigPath(override?: string): string {
  return path.join(getConfigDir(override), "config.json");
}

export async function ensureConfigDir(override?: string): Promise<string> {
  const dir = getConfigDir(override);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export async function loadConfig(override?: string): Promise<Config> {
  const filePath = getConfigPath(override);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt file. Return empty rather than throwing so the CLI can recover.
    return {};
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) return {};
  return result.data;
}

export async function saveConfig(
  cfg: Config,
  override?: string,
): Promise<void> {
  await ensureConfigDir(override);
  const filePath = getConfigPath(override);
  const validated = ConfigSchema.parse(cfg);
  // Write file with 0600 perms so the pair token is not world-readable.
  await fs.writeFile(filePath, JSON.stringify(validated, null, 2), {
    mode: 0o600,
  });
}

export async function updateConfig(
  patch: Partial<Config>,
  override?: string,
): Promise<Config> {
  const existing = await loadConfig(override);
  const next: Config = { ...existing, ...patch };
  await saveConfig(next, override);
  return next;
}
