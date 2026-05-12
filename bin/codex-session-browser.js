#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { listSessions, readSessionDetail } from "../src/sessions.js";
import { formatAge, formatTable, shortenPath } from "../src/format.js";
import { runTui } from "../src/tui.js";

const args = process.argv.slice(2);
const commands = new Set(["tui", "list", "ls", "show", "resume", "fork", "help"]);
const defaultCommand = process.stdin.isTTY && process.stdout.isTTY ? "tui" : "list";
const command = args[0] && commands.has(args[0]) ? args.shift() : defaultCommand;

const options = parseOptions(args);

try {
  if (command === "tui") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      usage("TUI mode requires an interactive terminal.");
    }
    await runTui(options);
  } else if (command === "list" || command === "ls") {
    const sessions = await listSessions(options);
    printSessions(sessions, options);
  } else if (command === "show") {
    const id = args[0];
    if (!id) usage("Missing session id for show.");
    const detail = await readSessionDetail(id, options);
    printDetail(detail);
  } else if (command === "resume" || command === "fork") {
    const id = args[0];
    if (!id) usage(`Missing session id for ${command}.`);
    const detail = await readSessionDetail(id, options);
    const result = spawnSync("codex", [command, detail.id], { stdio: "inherit" });
    process.exit(result.status ?? 1);
  } else if (command === "help" || command === "--help" || command === "-h") {
    usage();
  } else {
    usage(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(`codex-session-browser: ${error.message}`);
  process.exit(1);
}

function parseOptions(argv) {
  const parsed = {
    all: false,
    cwd: false,
    limit: 20,
    query: "",
    root: process.env.CODEX_HOME || `${process.env.HOME}/.codex`,
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--all") parsed.all = true;
    else if (arg === "--cwd") parsed.cwd = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--limit" || arg === "-n") parsed.limit = Number(argv[++index] ?? parsed.limit);
    else if (arg === "--query" || arg === "-q") parsed.query = argv[++index] ?? "";
    else if (arg === "--root") parsed.root = argv[++index] ?? parsed.root;
    else if (arg === "--help" || arg === "-h") usage();
    else if (!parsed.query) parsed.query = arg;
    else parsed.query += ` ${arg}`;
  }

  return parsed;
}

function printSessions(sessions, opts) {
  if (opts.json) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  if (sessions.length === 0) {
    console.log("No Codex sessions found.");
    return;
  }

  const rows = sessions.slice(0, opts.limit).map((session) => ({
    updated: formatAge(session.updatedAt),
    turns: String(session.messageCount),
    tools: String(session.toolCount),
    cwd: shortenPath(session.cwd, 34),
    title: session.title,
    id: session.id
  }));

  console.log(formatTable(rows, ["updated", "turns", "tools", "cwd", "title", "id"]));
  console.log("");
  console.log(`Showing ${Math.min(opts.limit, sessions.length)} of ${sessions.length}. Use: codex-sessions show <id>`);
}

function printDetail(detail) {
  console.log(detail.title);
  console.log("=".repeat(Math.min(detail.title.length, 72)));
  console.log(`id:      ${detail.id}`);
  console.log(`cwd:     ${detail.cwd}`);
  console.log(`created: ${detail.createdAt}`);
  console.log(`updated: ${detail.updatedAt}`);
  console.log(`model:   ${detail.model ?? "unknown"}`);
  console.log("");
  console.log(`resume:  codex resume ${detail.id}`);
  console.log(`fork:    codex fork ${detail.id}`);
  console.log("");
  console.log("Timeline");
  console.log("--------");

  for (const item of detail.timeline.slice(-12)) {
    const prefix = item.role.padEnd(9);
    console.log(`${prefix} ${item.text}`);
  }
}

function usage(message) {
  if (message) console.error(message);
  console.log(`Usage:
  codex-sessions [query] [--cwd] [--all]
  codex-sessions list [query] [--cwd] [--all] [--limit 20] [--json]
  codex-sessions show <session-id-or-prefix>
  codex-sessions resume <session-id-or-prefix>
  codex-sessions fork <session-id-or-prefix>

Examples:
  codex-sessions --cwd retry
  codex-sessions list --all retry
  codex-sessions show 00000000
  codex-sessions resume 00000000`);
  process.exit(message ? 1 : 0);
}
