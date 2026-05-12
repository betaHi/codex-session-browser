export function formatAge(value) {
  if (!value) return "";
  const date = new Date(value);
  const diff = Date.now() - date.getTime();
  if (!Number.isFinite(diff)) return String(value);

  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;

  return date.toISOString().slice(0, 10);
}

export function shortenPath(value, maxLength = 40) {
  if (!value || value.length <= maxLength) return value ?? "";
  const home = process.env.HOME;
  const compact = home && value.startsWith(home) ? `~${value.slice(home.length)}` : value;
  if (compact.length <= maxLength) return compact;

  const parts = compact.split("/");
  const last = parts.pop();
  const parent = parts.pop();
  return `.../${parent}/${last}`.slice(-maxLength);
}

export function formatTable(rows, columns) {
  const widths = Object.fromEntries(
    columns.map((column) => [
      column,
      Math.min(
        Math.max(column.length, ...rows.map((row) => String(row[column] ?? "").length)),
        column === "title" ? 48 : 36
      )
    ])
  );

  const header = columns.map((column) => pad(column, widths[column])).join("  ");
  const divider = columns.map((column) => "-".repeat(widths[column])).join("  ");
  const body = rows.map((row) =>
    columns
      .map((column) => pad(truncate(String(row[column] ?? ""), widths[column]), widths[column]))
      .join("  ")
  );

  return [header, divider, ...body].join("\n");
}

function truncate(value, width) {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function pad(value, width) {
  return value + " ".repeat(Math.max(0, width - value.length));
}
