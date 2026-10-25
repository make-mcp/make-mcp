interface Rule {
  allow: boolean;
  pattern: string;
}

export interface RobotsPolicy {
  isAllowed(path: string): boolean;
}

const ALLOW_ALL: RobotsPolicy = { isAllowed: () => true };

function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

export function pathMatches(pattern: string, path: string): boolean {
  return patternToRegExp(pattern).test(path);
}

/**
 * Minimal RFC 9309 parser: picks the group for our product token, falls back to `*`,
 * longest matching rule wins and `Allow` wins ties.
 */
export function parseRobots(text: string, productToken = "make-mcp"): RobotsPolicy {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | undefined;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match?.[1]) continue;
    const key = match[1].toLowerCase();
    const value = (match[2] ?? "").trim();

    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      if (value !== "") current.rules.push({ allow: key === "allow", pattern: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }

  const token = productToken.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && token.startsWith(a)));
  const selected = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes("*"));
  const rules = selected.flatMap((g) => g.rules);
  if (rules.length === 0) return ALLOW_ALL;

  return {
    isAllowed(path) {
      let best: Rule | undefined;
      for (const rule of rules) {
        if (!pathMatches(rule.pattern, path)) continue;
        if (
          !best ||
          rule.pattern.length > best.pattern.length ||
          (rule.pattern.length === best.pattern.length && rule.allow)
        ) {
          best = rule;
        }
      }
      return best ? best.allow : true;
    },
  };
}

export { ALLOW_ALL };
