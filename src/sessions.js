import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";

export async function listSessions(options = {}) {
  const files = await findSessionFiles(join(options.root ?? `${process.env.HOME}/.codex`, "sessions"));
  const sessions = [];

  for (const file of files) {
    const session = await summarizeSession(file);
    if (session) sessions.push(session);
  }

  return filterSessions(sessions, options);
}

export async function readSessionDetail(idOrPrefix, options = {}) {
  const sessions = await listSessions({ ...options, all: true, limit: Number.POSITIVE_INFINITY });
  const matches = sessions.filter((session) => session.id === idOrPrefix || session.id.startsWith(idOrPrefix));

  if (matches.length === 0) {
    throw new Error(`No session matches "${idOrPrefix}".`);
  }
  if (matches.length > 1) {
    throw new Error(`Session prefix "${idOrPrefix}" is ambiguous (${matches.length} matches).`);
  }

  return parseSession(matches[0].file);
}

export async function readSessionFile(file) {
  return parseSession(file);
}

export function filterSessions(sessions, options = {}) {
  const cwd = process.cwd();
  const query = normalize(options.query);

  return sessions
    .filter((session) => options.all || !options.cwd || session.cwd === cwd)
    .filter((session) => !query || normalize(searchText(session)).includes(query))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

async function findSessionFiles(root) {
  const files = [];

  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
    }
  }

  await walk(root);
  return files;
}

async function summarizeSession(file) {
  const session = await parseSession(file, { summaryOnly: true });
  if (!session?.id) return null;
  return session;
}

async function parseSession(file, options = {}) {
  const fileStat = await stat(file);
  const session = {
    id: "",
    file,
    title: "Untitled session",
    cwd: "",
    createdAt: "",
    updatedAt: fileStat.mtime.toISOString(),
    model: "",
    messageCount: 0,
    toolCount: 0,
    preview: "",
    timeline: []
  };

  const reader = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  let lastTimelineKey = "";

  for await (const line of reader) {
    if (!line.trim()) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    session.updatedAt = record.timestamp ?? session.updatedAt;

    if (record.type === "session_meta") {
      session.id = record.payload?.id ?? session.id;
      session.createdAt = record.payload?.timestamp ?? record.timestamp ?? session.createdAt;
      session.cwd = record.payload?.cwd ?? session.cwd;
      session.model = record.payload?.model ?? record.payload?.model_provider ?? session.model;
      continue;
    }

    if (record.type === "turn_context") {
      session.cwd = record.payload?.cwd ?? session.cwd;
      session.model = record.payload?.model ?? session.model;
      continue;
    }

    const timelineItem = extractTimelineItem(record);
    if (!timelineItem) continue;

    const timelineKey = `${timelineItem.role}:${timelineItem.text}`;
    if (timelineKey === lastTimelineKey) continue;
    lastTimelineKey = timelineKey;

    if (timelineItem.kind === "tool") session.toolCount += 1;
    else session.messageCount += 1;

    if (!session.preview && timelineItem.role === "user") session.preview = timelineItem.text;
    if (session.title === "Untitled session" && timelineItem.role === "user") {
      session.title = makeTitle(timelineItem.text);
    }

    if (!options.summaryOnly) session.timeline.push(timelineItem);
  }

  return session.id ? session : null;
}

function extractTimelineItem(record) {
  const payload = record.payload ?? {};

  if (record.type === "event_msg" && payload.type === "user_message") {
    return makeMessage("user", payload.message, record.timestamp);
  }

  if (record.type === "event_msg" && payload.type === "agent_message") {
    return makeMessage("assistant", payload.message, record.timestamp);
  }

  if (record.type === "response_item" && payload.type === "message") {
    const role = payload.role === "user" ? "user" : "assistant";
    return makeMessage(role, extractContentText(payload.content), record.timestamp);
  }

  if (record.type === "response_item" && payload.type === "function_call") {
    return {
      kind: "tool",
      role: "tool",
      text: `${payload.name ?? "tool"} ${compact(payload.arguments ?? "")}`.trim(),
      timestamp: record.timestamp
    };
  }

  if (record.type === "event_msg" && payload.type === "exec_command_end") {
    const command = Array.isArray(payload.command) ? payload.command.join(" ") : "";
    return {
      kind: "tool",
      role: "tool",
      text: `exec ${compact(command)} -> ${payload.exit_code ?? "?"}`,
      timestamp: record.timestamp
    };
  }

  return null;
}

function makeMessage(role, text, timestamp) {
  const clean = compact(text);
  if (isSyntheticMessage(clean)) return null;
  if (!clean) return null;
  return { kind: "message", role, text: clean, timestamp };
}

function extractContentText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => part?.text ?? part?.output_text ?? "")
    .filter(Boolean)
    .join(" ");
}

function makeTitle(text) {
  return compact(text).slice(0, 96) || "Untitled session";
}

function searchText(session) {
  return [session.id, session.title, session.cwd, session.preview, session.model].join(" ");
}

function normalize(value) {
  return String(value ?? "").toLowerCase().trim();
}

function compact(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isSyntheticMessage(value) {
  return (
    value.startsWith("<environment_context>") ||
    value.startsWith("<permissions instructions>") ||
    value.startsWith("<collaboration_mode>") ||
    value.startsWith("<skills_instructions>") ||
    value.startsWith("<turn_aborted>") ||
    value.startsWith("The user interrupted the previous turn")
  );
}
