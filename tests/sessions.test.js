import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { filterSessions, listSessions, readSessionFile } from "../src/sessions.js";

test("parses sessions and ignores synthetic Codex context messages", async () => {
  const root = await mkdtemp(join(tmpdir(), "csb-"));
  try {
    const dir = join(root, "sessions", "2026", "05", "11");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "rollout-demo.jsonl");
    await writeFile(
      file,
      [
        json("session_meta", {
          id: "00000000-0000-4000-8000-000000000001",
          timestamp: "2026-05-11T10:00:00.000Z",
          cwd: "/workspace/sample-app",
          model_provider: "bridge"
        }),
        json("turn_context", {
          cwd: "/workspace/sample-app",
          model: "gpt-5.5"
        }),
        json("event_msg", {
          type: "user_message",
          message: "<environment_context><cwd>/private/demo</cwd></environment_context>"
        }),
        json("event_msg", {
          type: "user_message",
          message: "Fix flaky checkout flow after payment retry"
        }),
        json("event_msg", {
          type: "agent_message",
          message: "I reproduced the issue and added a regression test."
        })
      ].join("\n")
    );

    const sessions = await listSessions({ root, all: true });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].title, "Fix flaky checkout flow after payment retry");
    assert.equal(sessions[0].model, "gpt-5.5");

    const detail = await readSessionFile(file);
    assert.equal(detail.model, "gpt-5.5");
    assert.deepEqual(
      detail.timeline.map((item) => item.text),
      [
        "Fix flaky checkout flow after payment retry",
        "I reproduced the issue and added a regression test."
      ]
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filters sessions by query and current project", () => {
  const sessions = [
    {
      id: "one",
      title: "Fix checkout retry",
      cwd: process.cwd(),
      preview: "",
      model: "gpt-5.5",
      updatedAt: "2026-05-11T12:00:00.000Z"
    },
    {
      id: "two",
      title: "Update docs",
      cwd: "/workspace/docs",
      preview: "",
      model: "gpt-5.5",
      updatedAt: "2026-05-11T11:00:00.000Z"
    }
  ];

  assert.equal(filterSessions(sessions, { cwd: true, query: "checkout" }).length, 1);
  assert.equal(filterSessions(sessions, { all: true, query: "docs" })[0].id, "two");
});

function json(type, payload) {
  return JSON.stringify({
    timestamp: "2026-05-11T10:00:00.000Z",
    type,
    payload
  });
}
