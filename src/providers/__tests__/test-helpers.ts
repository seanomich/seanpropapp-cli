import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

/**
 * Minimal stand-in for ChildProcessWithoutNullStreams used by provider tests.
 * Lets the test push stdout/stderr chunks and trigger exit codes deterministically.
 */
export class FakeChildProcess extends EventEmitter {
  public stdout: Readable;
  public stderr: Readable;
  public stdin: Writable;
  public exitCode: number | null = null;
  private stdoutChunks: Array<string | null>;
  private stderrChunks: Array<string | null>;
  public stdinData = "";

  constructor(opts: {
    stdoutChunks?: Array<string | null>;
    stderrChunks?: Array<string | null>;
    exitCode?: number;
    closeDelayMs?: number;
  } = {}) {
    super();
    this.stdoutChunks = opts.stdoutChunks ?? [];
    this.stderrChunks = opts.stderrChunks ?? [];

    const stdoutChunks = this.stdoutChunks;
    this.stdout = new Readable({
      read() {
        if (stdoutChunks.length === 0) {
          this.push(null);
          return;
        }
        const next = stdoutChunks.shift();
        if (next === undefined || next === null) {
          this.push(null);
          return;
        }
        this.push(Buffer.from(next));
        if (stdoutChunks.length === 0) this.push(null);
      },
    });

    const stderrChunks = this.stderrChunks;
    this.stderr = new Readable({
      read() {
        if (stderrChunks.length === 0) {
          this.push(null);
          return;
        }
        const next = stderrChunks.shift();
        if (next === undefined || next === null) {
          this.push(null);
          return;
        }
        this.push(Buffer.from(next));
        if (stderrChunks.length === 0) this.push(null);
      },
    });

    this.stdin = new Writable({
      write: (chunk, _enc, cb) => {
        this.stdinData += chunk.toString();
        cb();
      },
    });

    setTimeout(() => {
      this.exitCode = opts.exitCode ?? 0;
      this.emit("close", this.exitCode);
    }, opts.closeDelayMs ?? 5);
  }

  kill(_signal?: NodeJS.Signals | number): boolean {
    this.exitCode = 143;
    this.emit("close", this.exitCode);
    return true;
  }
}
