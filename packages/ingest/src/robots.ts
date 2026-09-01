export interface RobotsRule {
  readonly allow: boolean;
  readonly pattern: string;
}

export interface RobotsGroup {
  readonly userAgents: readonly string[];
  readonly rules: readonly RobotsRule[];
}

interface MutableRobotsGroup {
  userAgents: string[];
  rules: RobotsRule[];
}

export function parseRobots(text: string): readonly RobotsGroup[] {
  const groups: MutableRobotsGroup[] = [];
  let current: MutableRobotsGroup | null = null;
  let lastLineWasUserAgent = false;

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = (rawLine.split("#")[0] ?? "").trim();
    if (line.length === 0) {
      continue;
    }
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      if (!lastLineWasUserAgent || current === null) {
        current = { rules: [], userAgents: [] };
        groups.push(current);
      }
      current.userAgents.push(value.toLowerCase());
      lastLineWasUserAgent = true;
      continue;
    }

    lastLineWasUserAgent = false;
    if (current === null) {
      continue;
    }
    if (field === "allow" || field === "disallow") {
      current.rules.push({ allow: field === "allow", pattern: value });
    }
  }

  return groups;
}

function ruleMatchLength(pattern: string, path: string): number | null {
  let body = pattern;
  let anchored = false;
  if (body.endsWith("$")) {
    anchored = true;
    body = body.slice(0, -1);
  }
  const escaped = body.replace(/[.+?^${}()|[\]\\]/gu, String.raw`\$&`).replaceAll("*", ".*");
  const expression = new RegExp(`^${escaped}${anchored ? "$" : ""}`, "u");
  return expression.test(path) ? pattern.length : null;
}

export function isPathAllowed(
  groups: readonly RobotsGroup[],
  userAgent: string,
  path: string,
): boolean {
  const token = userAgent.toLowerCase();
  let selected = groups.filter((group) =>
    group.userAgents.some((agent) => agent !== "*" && token.includes(agent)),
  );
  if (selected.length === 0) {
    selected = groups.filter((group) => group.userAgents.includes("*"));
  }
  if (selected.length === 0) {
    return true;
  }

  let bestLength = -1;
  let bestAllow = true;
  for (const group of selected) {
    for (const rule of group.rules) {
      if (rule.pattern.length === 0) {
        continue;
      }
      const matched = ruleMatchLength(rule.pattern, path);
      if (matched === null) {
        continue;
      }
      if (matched > bestLength || (matched === bestLength && rule.allow && !bestAllow)) {
        bestLength = matched;
        bestAllow = rule.allow;
      }
    }
  }
  return bestLength === -1 ? true : bestAllow;
}
