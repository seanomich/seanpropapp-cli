import * as readline from "node:readline";

/**
 * Tiny prompt helper. Returns true for empty / "y" / "yes" (case-insensitive)
 * to match the [Y/n] convention used by `connect`'s inline install prompt.
 */
export function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "" || trimmed === "y" || trimmed === "yes") {
        resolve(true);
      } else {
        resolve(false);
      }
    });
  });
}
