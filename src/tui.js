import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import readline from "node:readline";
import { filterSessions, listSessions, readSessionFile } from "./sessions.js";
import { formatAge, shortenPath } from "./format.js";

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  clear: "\x1b[2J\x1b[H",
  hide: "\x1b[?25l",
  show: "\x1b[?25h",
  alt: "\x1b[?1049h",
  main: "\x1b[?1049l",
  noWrap: "\x1b[?7l",
  wrap: "\x1b[?7h",
  fg: (r, g, b) => `\x1b[38;2;${r};${g};${b}m`,
  bg: (r, g, b) => `\x1b[48;2;${r};${g};${b}m`
};

const palette = {
  page: [0, 0, 0],
  terminal: [0, 0, 0],
  terminalSoft: [0, 0, 0],
  panel: [0, 0, 0],
  panel2: [17, 24, 39],
  chromeBg: [0, 0, 0],
  cyan: [34, 211, 238],
  blue: [96, 165, 250],
  green: [52, 211, 153],
  lime: [163, 230, 53],
  yellow: [250, 204, 21],
  orange: [251, 146, 60],
  pink: [244, 114, 182],
  red: [248, 113, 113],
  violet: [167, 139, 250],
  ink: [230, 237, 243],
  muted: [139, 148, 158],
  dim: [95, 107, 122],
  line: [37, 48, 65],
  inputBg: [11, 18, 32],
  inputBorder: [51, 65, 85],
  activeBg: [12, 38, 52],
  rowAlt: [13, 17, 23],
  ink2: [201, 209, 217],
  black: [6, 16, 24]
};

const theme = {
  bg: ansi.bg(...palette.terminal),
  bgDark: ansi.bg(...palette.chromeBg),
  bgPage: ansi.bg(...palette.page),
  panel: ansi.bg(...palette.panel),
  panel2: ansi.bg(...palette.panel2),
  inputBg: ansi.bg(...palette.inputBg),
  activeBg: ansi.bg(...palette.activeBg),
  cyan: ansi.fg(...palette.cyan),
  blue: ansi.fg(...palette.blue),
  green: ansi.fg(...palette.green),
  lime: ansi.fg(...palette.lime),
  yellow: ansi.fg(...palette.yellow),
  orange: ansi.fg(...palette.orange),
  pink: ansi.fg(...palette.pink),
  violet: ansi.fg(...palette.violet),
  text: ansi.fg(...palette.ink),
  text2: ansi.fg(...palette.ink2),
  muted: ansi.fg(...palette.muted),
  dim: ansi.fg(...palette.dim),
  line: ansi.fg(...palette.line),
  inputBorder: ansi.fg(...palette.inputBorder),
  black: ansi.fg(...palette.black)
};

export async function runTui(options = {}) {
  const app = new SessionBrowser(options);
  await app.start();
}

class SessionBrowser {
  constructor(options) {
    this.options = options;
    this.allSessions = [];
    this.sessions = [];
    this.detail = null;
    this.selected = 0;
    this.offset = 0;
    this.query = options.query ?? "";
    this.scope = options.all ? "all" : "project";
    this.mode = "normal";
    this.message = "";
    this.loading = true;
    this.closed = false;
    this.indexedMs = 0;
  }

  async start() {
    await this.load();
    this.enterScreen();
    await this.loadDetail();
    this.render();
    this.bindKeys();
  }

  async load() {
    const started = Date.now();
    this.allSessions = await listSessions({ ...this.options, all: true, cwd: false, query: "" });
    this.indexedMs = Date.now() - started;
    this.applyFilters();

    if (this.scope === "project" && this.sessions.length === 0 && !this.options.cwd) {
      this.scope = "all";
      this.message = "No sessions for this project; showing all projects.";
      this.applyFilters();
    }

    this.loading = false;
  }

  applyFilters() {
    const previousId = this.sessions[this.selected]?.id;
    this.sessions = filterSessions(this.allSessions, {
      all: this.scope === "all",
      cwd: this.scope === "project",
      query: this.query
    });
    if (previousId) {
      const restored = this.sessions.findIndex((s) => s.id === previousId);
      if (restored >= 0) {
        this.selected = restored;
      } else {
        this.selected = clamp(this.selected, 0, Math.max(0, this.sessions.length - 1));
      }
    } else {
      this.selected = clamp(this.selected, 0, Math.max(0, this.sessions.length - 1));
    }
    this.offset = clamp(this.offset, 0, Math.max(0, this.sessions.length - 1));
  }

  async loadDetail() {
    const session = this.sessions[this.selected];
    if (!session) {
      this.detail = null;
      return;
    }

    try {
      this.detail = await readSessionFile(session.file);
    } catch (error) {
      this.detail = { ...session, timeline: [], error: error.message };
    }
  }

  enterScreen() {
    process.stdout.write(ansi.alt + ansi.hide + ansi.noWrap + ansi.clear);
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.on("SIGINT", () => this.exit());
    process.stdout.on("resize", () => this.render());
  }

  bindKeys() {
    process.stdin.on("keypress", async (input, key = {}) => {
      if (this.closed) return;

      if (key.ctrl && key.name === "c") {
        this.exit();
        return;
      }

      if (this.mode === "search") {
        if (key.name === "escape" || key.name === "return") {
          this.mode = "normal";
          this.message = "";
          this.render();
          return;
        }

        if (key.name === "down") {
          await this.move(1);
          return;
        }

        if (key.name === "up") {
          await this.move(-1);
          return;
        }

        if (key.name === "pagedown") {
          await this.move(this.pageSize() - 1);
          return;
        }

        if (key.name === "pageup") {
          await this.move(-(this.pageSize() - 1));
          return;
        }

        if (key.name === "backspace") {
          this.query = this.query.slice(0, -1);
          this.applyFilters();
          await this.loadDetail();
          this.render();
          return;
        }

        if (input && input.length === 1 && !key.ctrl && !key.meta) {
          this.query += input;
          this.applyFilters();
          await this.loadDetail();
          this.render();
        }
        return;
      }

      if (key.name === "escape") {
        this.query = "";
        this.message = "";
        this.applyFilters();
        await this.loadDetail();
        this.render();
        return;
      }

      if (key.name === "q") {
        this.exit();
        return;
      }

      if (input === "/") {
        this.mode = "search";
        this.message = "Search mode. Enter or Esc returns to normal.";
        this.render();
        return;
      }

      if (key.name === "backspace") {
        this.query = this.query.slice(0, -1);
        this.applyFilters();
        await this.loadDetail();
        this.render();
        return;
      }

      if (key.name === "down") {
        await this.move(1);
        return;
      }

      if (key.name === "up") {
        await this.move(-1);
        return;
      }

      if (key.name === "pagedown") {
        await this.move(this.pageSize() - 1);
        return;
      }

      if (key.name === "pageup") {
        await this.move(-(this.pageSize() - 1));
        return;
      }

      if (key.name === "return") {
        this.runCodex("resume");
        return;
      }

      if (key.name === "f") {
        this.runCodex("fork");
        return;
      }

      if (key.name === "y") {
        this.copySelectedId();
        return;
      }

      if (input === "?") {
        this.message = "Type to search · Esc clears · a toggles all/project · y copies id.";
        this.render();
        return;
      }

      if (key.name === "a") {
        this.scope = this.scope === "all" ? "project" : "all";
        this.message = this.scope === "all" ? "Showing all projects." : "Showing this project.";
        this.applyFilters();
        await this.loadDetail();
        this.render();
        return;
      }

      if (input && input.length === 1 && !key.ctrl && !key.meta) this.render();
    });
  }

  async move(delta) {
    if (this.sessions.length === 0) return;
    this.message = "";
    this.selected = clamp(this.selected + delta, 0, this.sessions.length - 1);
    const page = this.pageSize();
    if (this.selected < this.offset) this.offset = this.selected;
    if (this.selected >= this.offset + page) this.offset = this.selected - page + 1;
    await this.loadDetail();
    this.render();
  }

  pageSize() {
    // Mirror the visible-session count computed in renderList so scrolling
    // and movement stay in lock-step. Falls back to a derived estimate
    // before the first render populates this.visibleSessions.
    if (this.visibleSessions) return this.visibleSessions;
    const rows = terminalSize().rows;
    return Math.max(1, Math.floor((rows - 15) / 2));
  }

  runCodex(command) {
    const session = this.sessions[this.selected];
    if (!session) return;

    this.cleanupScreen({ clear: false });
    const result = spawnSync("codex", [command, session.id], { stdio: "inherit" });
    process.exit(result.status ?? 1);
  }

  copySelectedId() {
    const session = this.sessions[this.selected];
    if (!session) return;

    const copied = copyText(session.id);
    this.message = copied ? "Copied session id." : `Session id: ${session.id}`;
    this.render();
  }

  exit(options = {}) {
    if (this.closed) return;
    this.closed = true;
    this.cleanupScreen(options);
    process.exit(0);
  }

  cleanupScreen(options = {}) {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write(ansi.wrap + ansi.show + (options.clear === false ? "" : ansi.clear) + ansi.main);
  }

  render() {
    if (this.closed) return;
    const { columns, rows } = terminalSize();
    const width = Math.min(Math.max(40, columns), 148);
    const height = Math.min(Math.max(20, rows), 40);
    const leftMargin = Math.max(0, Math.floor((columns - width) / 2));
    const topMargin = Math.max(0, Math.floor((rows - height) / 2));

    const railWidth = width >= 80 ? 6 : 0;
    const contentWidth = width - railWidth;
    const showDetail = contentWidth >= 84;
    const listWidth = showDetail
      ? clamp(Math.floor(contentWidth * 0.58), 56, Math.max(56, contentWidth - 60))
      : contentWidth;
    const detailWidth = showDetail ? contentWidth - listWidth : 0;
    // chrome(2) + powerline(2) + status(1) = 5
    const bodyHeight = Math.max(8, height - 5);

    const output = [
      ...this.renderChrome(width),
      ...this.renderPowerline(width),
      ...this.renderBody(railWidth, listWidth, detailWidth, bodyHeight),
      this.renderStatus(width)
    ];

    const margin = " ".repeat(leftMargin);
    const verticalPad = "\r\n".repeat(topMargin);
    process.stdout.write("\x1b[H\x1b[J" + verticalPad + output.slice(0, height).map((line) => margin + line).join("\r\n"));
  }

  renderChrome(width) {
    const dots =
      ansi.fg(255, 95, 86) + "●" + ansi.reset + "  " +
      ansi.fg(255, 189, 46) + "●" + ansi.reset + "  " +
      ansi.fg(39, 201, 63) + "●" + ansi.reset;
    const title = theme.text2 + "codex-session-browser - alternate screen" + ansi.reset;
    const size = theme.muted + `${width}x${Math.min(Math.max(1, terminalSize().rows), 40)}` + ansi.reset;
    const left = "  " + dots + "  ";
    const right = "  " + size + "  ";
    const centerWidth = Math.max(0, width - visibleWidth(left) - visibleWidth(right));
    const middle = centerText(title, centerWidth);
    return [
      fillLine(left + middle + right, width),
      fillLine(theme.line + "─".repeat(width) + ansi.reset, width)
    ];
  }

  renderPowerline(width) {
    const scope = this.scope === "all" ? "all projects" : projectName(process.cwd());
    const segments = [
      { text: "CSB", color: palette.cyan },
      { text: scope, color: palette.green },
      { text: `${this.sessions.length} matches`, color: palette.pink },
      { text: this.query ? `"${this.query}"` : "latest first", color: palette.yellow }
    ];

    let line = "";
    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      const next = segments[i + 1];
      line += ansi.bg(...seg.color) + theme.black + ansi.bold + `  ${seg.text}  ` + ansi.reset;
      const nextBg = next ? ansi.bg(...next.color) : BLACK_BG;
      line += nextBg + ansi.fg(...seg.color) + "" + ansi.reset;
    }
    const tail = BLACK_BG + theme.muted + ` local session store · indexed ${this.allSessions.length} files in ${this.indexedMs}ms` + ansi.reset;
    return [
      fillLine(line + tail, width),
      fillLine(theme.line + "─".repeat(width) + ansi.reset, width)
    ];
  }

  renderBody(railWidth, listWidth, detailWidth, height) {
    const rail = this.renderRail(railWidth, height);
    const list = this.renderList(listWidth, height, { borderRight: detailWidth > 0 });
    const detail = detailWidth > 0 ? this.renderDetail(detailWidth, height) : null;
    return Array.from({ length: height }, (_, index) => rail[index] + list[index] + (detail ? detail[index] : ""));
  }

  renderRail(width, height) {
    if (width <= 0) return Array.from({ length: height }, () => "");
    const icons = ["▤", "⌕", "↳", "?"];
    const innerWidth = Math.max(1, width - 1);
    const border = BLACK_BG + theme.line + "│" + ansi.reset;
    const blank = fillLine("", innerWidth) + border;
    const lines = [];
    lines.push(blank);
    for (let i = 0; i < icons.length; i += 1) {
      const active = i === 0;
      const color = active ? theme.cyan + ansi.bold : theme.muted;
      const iconCell = fillLine(center(color + icons[i] + ansi.reset, innerWidth), innerWidth) + border;
      lines.push(iconCell);
      lines.push(blank);
    }
    while (lines.length < height) lines.push(blank);
    return lines.slice(0, height);
  }

  renderList(width, height, options = {}) {
    const hasBorder = Boolean(options.borderRight);
    const innerWidth = hasBorder ? Math.max(1, width - 1) : width;
    const lines = [];

    lines.push(blankLine(innerWidth));
    lines.push(...this.renderQueryBox(innerWidth));
    lines.push(blankLine(innerWidth));
    lines.push(this.renderDivider(innerWidth));

    lines.push(blankLine(innerWidth));
    lines.push(headerLine(["", "UPDATED", "TURNS", "SESSION", "PROJECT"], listColumnWidths(innerWidth), innerWidth));
    lines.push(blankLine(innerWidth));

    const rowsPerSession = 2; // session line + 1 blank for spacing
    const visibleSessions = Math.max(1, Math.floor((height - lines.length - 1) / rowsPerSession));
    this.visibleSessions = visibleSessions;
    this.offset = clamp(this.offset, 0, Math.max(0, this.sessions.length - visibleSessions));
    const page = this.sessions.slice(this.offset, this.offset + visibleSessions);

    for (let index = 0; index < visibleSessions; index += 1) {
      const session = page[index];
      if (!session) {
        lines.push(blankLine(innerWidth));
        lines.push(blankLine(innerWidth));
        continue;
      }
      const absoluteIndex = this.offset + index;
      lines.push(this.renderSessionRow(session, absoluteIndex === this.selected, absoluteIndex, innerWidth));
      lines.push(blankLine(innerWidth));
    }

    while (lines.length < height) lines.push(blankLine(innerWidth));
    return withRightBorder(lines.slice(0, height), hasBorder);
  }

  renderQueryBox(width) {
    const pad = 2;
    const inner = Math.max(8, width - pad * 2);
    const queryText = this.query || (this.mode === "search" ? "" : "type / to search");
    const queryColor = this.query ? theme.text : theme.dim;
    const cursor = this.mode === "search" ? theme.cyan + "▋" + ansi.reset : "";

    const top = theme.inputBorder + "╭" + "─".repeat(inner - 2) + "╮" + ansi.reset;
    const bottom = theme.inputBorder + "╰" + "─".repeat(inner - 2) + "╯" + ansi.reset;

    const promptArrow = theme.green + ansi.bold + "❯" + ansi.reset;
    const innerTextWidth = inner - 4;
    const visibleQuery = truncateVisible(queryText, innerTextWidth - 3);
    const content = " " + promptArrow + " " + queryColor + visibleQuery + ansi.reset + cursor;
    const middleInside = visiblePad(content, inner - 2);
    const middle =
      theme.inputBorder + "│" + ansi.reset +
      middleInside +
      theme.inputBorder + "│" + ansi.reset;

    const padStr = " ".repeat(pad);
    return [
      fillLine(padStr + top, width),
      fillLine(padStr + middle, width),
      fillLine(padStr + bottom, width)
    ];
  }

  renderDivider(width) {
    return fillLine(theme.line + "─".repeat(Math.max(0, width)) + ansi.reset, width);
  }

  renderSessionRow(session, active, index, width) {
    const marker = active ? theme.cyan + ansi.bold + "▶" + ansi.reset : " ";
    const updated = (active ? ansi.bold : "") + theme.green + formatAge(session.updatedAt) + ansi.reset;
    const turns = (active ? ansi.bold : "") + theme.yellow + String(session.messageCount) + ansi.reset;
    const titleText = session.title;
    const title = active
      ? theme.text + ansi.bold + titleText + ansi.reset
      : theme.text2 + titleText + ansi.reset;
    const cwd = theme.violet + projectName(session.cwd) + ansi.reset;
    const columns = [marker, updated, turns, title, cwd];
    const widths = listColumnWidths(width);
    const cells = columns.map((value, i) => visiblePad(truncateVisible(value, widths[i]), widths[i]));
    // extra 4-space gap before project column
    const row = cells.slice(0, 4).join("  ") + "      " + cells[4];
    if (active) {
      const leftBar = ansi.fg(34, 211, 238) + "▌" + ansi.reset;
      const inner = " " + leftBar + " " + row;
      return fillLine(inner, width, ansi.bg(14, 46, 64));
    }
    const inner = "   " + row;
    return fillLine(inner, width);
  }

  renderDetail(width, height) {
    const detail = this.detail;
    const lines = [];

    if (!detail) {
      lines.push(blankLine(width));
      lines.push(fillLine("  " + theme.dim + "No session selected" + ansi.reset, width));
      lines.push(blankLine(width));
      lines.push(fillLine("  " + theme.muted + "Clear the search or switch scope to find sessions." + ansi.reset, width));
      while (lines.length < height) lines.push(blankLine(width));
      return lines.slice(0, height);
    }

    // Fixed 6-line pane head, aligned with list's query box bottom divider:
    // blank · id · blank · title-line-1 · title-line-2(or blank) · divider
    lines.push(blankLine(width));
    lines.push(fillLine("    " + theme.dim + detail.id + ansi.reset, width));
    lines.push(blankLine(width));
    const titleLines = wrapText(detail.title, width - 6).slice(0, 2);
    for (let i = 0; i < 2; i += 1) {
      const t = titleLines[i];
      if (t) {
        lines.push(fillLine("    " + theme.text + ansi.bold + t + ansi.reset, width));
      } else {
        lines.push(blankLine(width));
      }
    }
    lines.push(this.renderDivider(width));

    lines.push(blankLine(width));
    const stats = [
      ["MODEL", detail.model || "unknown"],
      ["TOOLS", String(detail.toolCount)]
    ];
    lines.push(...statGrid(stats, width));

    lines.push(blankLine(width));
    lines.push(fillLine("    " + theme.pink + ansi.bold + "COMMAND" + ansi.reset, width));
    lines.push(...commandBox(`codex resume ${detail.id}`, width));

    lines.push(blankLine(width));
    lines.push(fillLine("    " + theme.pink + ansi.bold + "TIMELINE PREVIEW" + ansi.reset, width));
    lines.push(blankLine(width));

    const remaining = Math.max(0, height - lines.length - 1);
    const events = previewTimeline(detail.timeline ?? [], Math.max(2, Math.floor(remaining / 2)));
    for (const item of events) {
      if (lines.length >= height) break;
      const roleColor = item.role === "user" ? theme.green : item.role === "tool" ? theme.orange : theme.cyan;
      const roleLabel = item.role === "assistant" ? "AGENT" : item.role.toUpperCase();
      const role = roleColor + ansi.bold + roleLabel + ansi.reset;
      const textLines = wrapText(item.text, Math.max(10, width - 18)).slice(0, 2);
      for (let i = 0; i < textLines.length; i += 1) {
        if (lines.length >= height) break;
        const gutter = "    " + roleColor + "│" + ansi.reset + " ";
        const rolePad = i === 0 ? visiblePad(role, 10) : " ".repeat(10);
        const content = theme.text2 + textLines[i] + ansi.reset;
        lines.push(fillLine(gutter + rolePad + "  " + content, width));
      }
      if (lines.length < height) lines.push(blankLine(width));
    }

    while (lines.length < height) lines.push(blankLine(width));
    return lines.slice(0, height);
  }

  renderStatus(width) {
    const indexText = this.sessions.length === 0
      ? "row 0 of 0"
      : `row ${this.selected + 1} of ${this.sessions.length}`;
    const message = this.message ? `  ·  ${this.message}` : "";
    const modeLabel = this.mode === "search" ? "SEARCH" : "NORMAL";
    const modeColor = this.mode === "search" ? ansi.bg(...palette.cyan) : ansi.bg(...palette.lime);
    const mode = modeColor + theme.black + ansi.bold + `  ${modeLabel}  ` + ansi.reset;

    const keys =
      theme.text + ansi.bold + "▤" + ansi.reset + theme.muted + " sessions  ·  " +
      theme.text + ansi.bold + "/" + ansi.reset + theme.muted + " search  ·  " +
      theme.text + ansi.bold + "↑/↓" + ansi.reset + theme.muted + " move  ·  " +
      theme.text + ansi.bold + "enter" + ansi.reset + theme.muted + " resume  ·  " +
      theme.text + ansi.bold + "f" + ansi.reset + theme.muted + " fork  ·  " +
      theme.text + ansi.bold + "y" + ansi.reset + theme.muted + " copy id  ·  " +
      theme.text + ansi.bold + "q" + ansi.reset + theme.muted + " quit" + message + ansi.reset;
    const right = theme.blue + ansi.bold + indexText + ansi.reset;

    const rightWidth = visibleWidth(right) + 2;
    const middleWidth = Math.max(0, width - visibleWidth(mode) - rightWidth);
    const middle = " " + visiblePad(keys, middleWidth - 1);

    return fillLine(mode + middle + right + "  ", width);
  }
}

function terminalSize() {
  return {
    columns: process.stdout.columns || 120,
    rows: process.stdout.rows || 36
  };
}

const BLACK_BG = ansi.bg(0, 0, 0);

function blankLine(width) {
  return BLACK_BG + " ".repeat(Math.max(0, width)) + ansi.reset;
}

function headerLine(values, widths, width) {
  const cells = values.map((value, index) =>
    visiblePad(theme.dim + ansi.bold + truncateVisible(value, widths[index]) + ansi.reset, widths[index])
  );
  const row = cells.slice(0, 4).join("  ") + "      " + cells[4];
  return fillLine("   " + row, width);
}

function listColumnWidths(width) {
  // "   " (3) prefix + 4 separators "  " (8) + extra gap before project (4) = 15 overhead
  const overhead = 3 + 8 + 4;
  const project = 14;
  const updated = 10; // fits ISO date "2026-05-12"
  const fixed = 1 + updated + 5 + project;
  const titleWidth = Math.max(6, width - overhead - fixed);
  return [1, updated, 5, titleWidth, project];
}

function fillLine(value, width, bg = BLACK_BG) {
  const clipped = truncateVisible(value, width);
  // Re-assert bg after every reset inside the content so terminal default
  // background never leaks through between colored runs.
  const rebg = bg ? clipped.replace(/\x1b\[0m/g, "\x1b[0m" + bg) : clipped;
  return bg + rebg + " ".repeat(Math.max(0, width - visibleWidth(clipped))) + ansi.reset;
}

function centerText(value, width) {
  const visible = visibleWidth(value);
  if (visible >= width) return truncateVisible(value, width);
  const left = Math.floor((width - visible) / 2);
  return " ".repeat(left) + value + " ".repeat(width - visible - left);
}

function center(value, width) {
  return centerText(value, width);
}

function visiblePad(value, width) {
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function truncateVisible(value, maxWidth) {
  if (maxWidth <= 0) return "";
  if (visibleWidth(value) <= maxWidth) return value;
  if (maxWidth === 1) return "…" + ansi.reset;
  let result = "";
  let width = 0;
  let inAnsi = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\x1b") inAnsi = true;
    if (inAnsi) {
      result += char;
      if (char === "m") inAnsi = false;
      continue;
    }

    const charWidth = charVisibleWidth(char);
    if (width + charWidth > maxWidth - 1) break;
    result += char;
    width += charWidth;
  }

  return result + "…" + ansi.reset;
}

function withRightBorder(lines, enabled) {
  if (!enabled) return lines;
  return lines.map((line) => line + BLACK_BG + theme.line + "│" + ansi.reset);
}

function distributeWidths(totalWidth, count, gap = 1) {
  const usable = Math.max(count, totalWidth - gap * (count - 1));
  const base = Math.floor(usable / count);
  let remainder = usable - base * count;
  return Array.from({ length: count }, () => {
    const w = base + (remainder > 0 ? 1 : 0);
    remainder -= 1;
    return w;
  });
}

function statGrid(stats, width) {
  const padding = 4;
  const inner = width - padding * 2;
  const gap = 2;
  const columns = distributeWidths(inner, stats.length, gap);
  const pad = " ".repeat(padding);
  const join = " ".repeat(gap);

  const top = columns.map((w) => theme.line + "╭" + "─".repeat(Math.max(0, w - 2)) + "╮" + ansi.reset).join(join);
  const labels = columns.map((w, i) => {
    const inside = "  " + theme.dim + ansi.bold + truncateVisible(stats[i][0], w - 4) + ansi.reset;
    const content = visiblePad(inside, w - 2);
    return theme.line + "│" + ansi.reset + content + theme.line + "│" + ansi.reset;
  }).join(join);
  const values = columns.map((w, i) => {
    const inside = "  " + theme.text + ansi.bold + truncateVisible(stats[i][1], w - 4) + ansi.reset;
    const content = visiblePad(inside, w - 2);
    return theme.line + "│" + ansi.reset + content + theme.line + "│" + ansi.reset;
  }).join(join);
  const bottom = columns.map((w) => theme.line + "╰" + "─".repeat(Math.max(0, w - 2)) + "╯" + ansi.reset).join(join);

  return [
    fillLine(pad + top, width),
    fillLine(pad + labels, width),
    fillLine(pad + values, width),
    fillLine(pad + bottom, width)
  ];
}

function actionRow(width) {
  const padding = 4;
  const inner = width - padding * 2;
  const gap = 2;
  const cols = distributeWidths(inner, 3, gap);
  const buttons = [
    { text: "enter resume", primary: true },
    { text: "f fork", primary: false },
    { text: "y copy id", primary: false }
  ];

  const tops = [];
  const middles = [];
  const bottoms = [];

  buttons.forEach((b, i) => {
    const w = cols[i];
    const inside = Math.max(2, w - 2);
    const border = b.primary ? ansi.fg(52, 211, 153) : theme.inputBorder;
    const color = b.primary ? theme.green + ansi.bold : theme.text + ansi.bold;

    tops.push(border + "╭" + "─".repeat(inside) + "╮" + ansi.reset);
    const label = center(color + b.text + ansi.reset, inside);
    middles.push(border + "│" + ansi.reset + label + border + "│" + ansi.reset);
    bottoms.push(border + "╰" + "─".repeat(inside) + "╯" + ansi.reset);
  });

  const pad = " ".repeat(padding);
  const join = " ".repeat(gap);
  return [
    fillLine(pad + tops.join(join), width),
    fillLine(pad + middles.join(join), width),
    fillLine(pad + bottoms.join(join), width)
  ];
}

function commandBox(text, width) {
  const padding = 2;
  const inner = width - padding * 2;
  const border = ansi.fg(34, 211, 238);
  const top = border + "╭" + "─".repeat(Math.max(0, inner - 2)) + "╮" + ansi.reset;
  const bottom = border + "╰" + "─".repeat(Math.max(0, inner - 2)) + "╯" + ansi.reset;
  const inside = " " + theme.cyan + truncateVisible(text, inner - 4) + ansi.reset;
  const middle = border + "│" + ansi.reset + visiblePad(inside, inner - 2) + border + "│" + ansi.reset;
  const pad = " ".repeat(padding);
  return [
    fillLine(pad + top, width),
    fillLine(pad + middle, width),
    fillLine(pad + bottom, width)
  ];
}

function visibleWidth(value) {
  return stripAnsi(value).split("").reduce((total, char) => total + charVisibleWidth(char), 0);
}

function charVisibleWidth(char) {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0) return 0;
  if (code < 32) return 0;
  if (code >= 0x2500 && code <= 0x257f) return 1;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  ) {
    return 2;
  }
  return 1;
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function wrapText(value, width) {
  const words = String(value ?? "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";

  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (visibleWidth(next) <= width) {
      line = next;
    } else {
      if (line) lines.push(line);
      line = truncateVisible(word, width);
    }
  }

  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function previewTimeline(items, limit) {
  const messages = items.filter((item) => item.kind !== "tool");
  const source = messages.length >= 3 ? messages : items;
  return source.slice(-limit);
}

function projectName(path) {
  if (!path) return "—";
  return basename(path) || shortenPath(path, 16);
}

function copyText(value) {
  const commands = [
    ["pbcopy"],
    ["wl-copy"],
    ["xclip", "-selection", "clipboard"]
  ];

  for (const command of commands) {
    const result = spawnSync(command[0], command.slice(1), {
      input: value,
      stdio: ["pipe", "ignore", "ignore"]
    });
    if (result.status === 0) return true;
  }

  return false;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
