#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
  .name("seanpropapp")
  .description(
    "Run SeanPropApp on your existing Claude Pro or ChatGPT Plus subscription.",
  )
  .version("0.1.0-alpha.1");

program
  .command("connect")
  .description("Start everything and pair with your browser (use this first)")
  .action(() => {
    console.log("not yet implemented");
  });

program
  .command("bridge")
  .description("Run the bridge server explicitly")
  .action(() => {
    console.log("not yet implemented");
  });

program
  .command("pair")
  .description("Generate a new pair URL")
  .action(() => {
    console.log("not yet implemented");
  });

program
  .command("mcp")
  .description("Run as MCP stdio server (Claude Desktop, Cursor)")
  .action(() => {
    console.log("not yet implemented");
  });

program
  .command("doctor")
  .description("Self-diagnostic")
  .action(() => {
    console.log("not yet implemented");
  });

program
  .command("autostart")
  .description("Install OS-native auto-start")
  .action(() => {
    console.log("not yet implemented");
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
