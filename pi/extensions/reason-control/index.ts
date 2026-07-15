import { getSupportedThinkingLevels as getSupportedReasoningLevels, type Api, type Model } from "@earendil-works/pi-ai";
import {
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  SelectList,
  Text,
  type AutocompleteItem,
  type SelectItem,
} from "@earendil-works/pi-tui";

const REASONING_OPTIONS = [
  { value: "off", description: "No reasoning — fastest responses" },
  { value: "minimal", description: "Minimal reasoning effort" },
  { value: "low", description: "Low reasoning effort" },
  { value: "medium", description: "Balanced reasoning" },
  { value: "high", description: "High reasoning effort" },
  { value: "xhigh", description: "Extra-high reasoning effort — great for complex problems" },
  { value: "max", description: "Maximum reasoning — best for the hardest problems" },
] as const;

type ReasoningLevel = (typeof REASONING_OPTIONS)[number]["value"];
type ReasoningOption = (typeof REASONING_OPTIONS)[number];

const REASONING_LEVELS = REASONING_OPTIONS.map((option) => option.value);
const REASONING_LEVEL_SET = new Set<string>(REASONING_LEVELS);
const REASONING_USAGE = `/reasoning <${REASONING_LEVELS.join("|")}>`;
const REASONING_DEFAULT_USAGE = `/reasoning-default <${REASONING_LEVELS.join("|")}>`;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("reasoning", {
    description: "Set reasoning for the current session without changing the global default.",
    getArgumentCompletions,
    handler: async (args, ctx) => {
      const argument = args.trim();

      if (argument) {
        const parsed = parseReasoningLevel(argument, REASONING_USAGE);
        if (parsed.error) {
          ctx.ui.notify(parsed.error, "warning");
          return;
        }

        setSessionReasoningLevel(pi, ctx, parsed.level);
        return;
      }

      if (ctx.mode !== "tui") {
        const levels = getAvailableOptions(ctx.model).map((option) => option.value).join(", ");
        ctx.ui.notify(`Use ${REASONING_USAGE}. Available for current model: ${levels}`, "info");
        return;
      }

      const selected = await showReasoningSelector(
        ctx,
        pi.getThinkingLevel(),
        getAvailableOptions(ctx.model),
        "Select Session Reasoning Level",
      );
      if (selected !== null) setSessionReasoningLevel(pi, ctx, selected);
    },
  });

  pi.registerCommand("reasoning-default", {
    description: "Set reasoning for the current session and make it the global default.",
    getArgumentCompletions,
    handler: async (args, ctx) => {
      const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
        projectTrusted: ctx.isProjectTrusted(),
      });
      const loadErrors = settings.drainErrors();
      if (loadErrors.length > 0) {
        ctx.ui.notify(formatSettingsErrors("Could not load settings", loadErrors), "error");
        return;
      }

      const argument = args.trim();
      if (argument) {
        const parsed = parseReasoningLevel(argument, REASONING_DEFAULT_USAGE);
        if (parsed.error) {
          ctx.ui.notify(parsed.error, "warning");
          return;
        }

        await setDefaultReasoningLevel(pi, settings, ctx, parsed.level);
        return;
      }

      if (ctx.mode !== "tui") {
        const levels = getAvailableOptions(ctx.model).map((option) => option.value).join(", ");
        ctx.ui.notify(`Use ${REASONING_DEFAULT_USAGE}. Available for current model: ${levels}`, "info");
        return;
      }

      const selected = await showReasoningSelector(
        ctx,
        pi.getThinkingLevel(),
        getAvailableOptions(ctx.model),
        "Select Session + Default Reasoning Level",
      );
      if (selected !== null) await setDefaultReasoningLevel(pi, settings, ctx, selected);
    },
  });
}

function getArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const prefix = argumentPrefix.trim().toLowerCase();
  const matches = REASONING_OPTIONS.filter((option) => option.value.startsWith(prefix));

  if (matches.length === 0) return null;

  return matches.map((option) => ({
    value: option.value,
    label: option.value,
    description: option.description,
  }));
}

function parseReasoningLevel(
  input: string,
  usage: string,
): { level: ReasoningLevel; error?: undefined } | { level?: undefined; error: string } {
  const parts = input.split(/\s+/);
  if (parts.length !== 1) return { error: `Usage: ${usage}` };

  const level = parts[0].toLowerCase();
  if (!isReasoningLevel(level)) {
    return { error: `Invalid reasoning level: "${parts[0]}". Use: ${usage}` };
  }

  return { level };
}

async function showReasoningSelector(
  ctx: ExtensionCommandContext,
  current: ReasoningLevel,
  options: ReasoningOption[],
  title: string,
): Promise<ReasoningLevel | null> {
  const items: SelectItem[] = options.map((option) => ({
    value: option.value,
    label: option.value,
    description: option.description,
  }));

  return ctx.ui.custom<ReasoningLevel | null>((tui, theme, _kb, done) => {
    const container = new Container();
    const selectList = new SelectList(items, Math.min(items.length, 10), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });

    const currentIndex = items.findIndex((item) => item.value === current);
    if (currentIndex >= 0) selectList.setSelectedIndex(currentIndex);

    selectList.onSelect = (item) => done(item.value as ReasoningLevel);
    selectList.onCancel = () => done(null);

    container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 0, 0));
    container.addChild(new Text(theme.fg("dim", `Current: ${current}`), 0, 0));
    container.addChild(new Text("", 0, 0));
    container.addChild(selectList);
    container.addChild(new Text("", 0, 0));
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 0, 0));
    container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));

    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

function setSessionReasoningLevel(pi: ExtensionAPI, ctx: ExtensionCommandContext, requested: ReasoningLevel) {
  const actual = applySessionReasoningLevel(pi, requested);

  if (actual === requested) {
    ctx.ui.notify(`Session reasoning level: ${actual}`, "info");
    return;
  }

  ctx.ui.notify(
    `Session reasoning level set to ${actual}; requested ${requested} is not supported by the current model.`,
    "warning",
  );
}

async function setDefaultReasoningLevel(
  pi: ExtensionAPI,
  settings: SettingsManager,
  ctx: ExtensionCommandContext,
  requested: ReasoningLevel,
): Promise<void> {
  const actual = applySessionReasoningLevel(pi, requested);
  settings.setDefaultThinkingLevel(actual);
  await settings.flush();

  const errors = settings.drainErrors();
  if (errors.length > 0) {
    ctx.ui.notify(formatSettingsErrors("Session reasoning changed, but the default could not be saved", errors), "error");
    return;
  }

  if (actual === requested) {
    ctx.ui.notify(`Session and default reasoning level: ${actual}`, "info");
    return;
  }

  ctx.ui.notify(
    `Session and default reasoning level set to ${actual}; requested ${requested} is not supported by the current model.`,
    "warning",
  );
}

function applySessionReasoningLevel(pi: ExtensionAPI, requested: ReasoningLevel): ReasoningLevel {
  // Pi persists setThinkingLevel() to global settings by design. Suppress only
  // that write so the session entry is still recorded and can be resumed.
  const prototype = SettingsManager.prototype;
  const original = prototype.setDefaultThinkingLevel;
  prototype.setDefaultThinkingLevel = function (_level: Parameters<typeof original>[0]): void {};
  try {
    pi.setThinkingLevel(requested);
  } finally {
    prototype.setDefaultThinkingLevel = original;
  }
  return pi.getThinkingLevel();
}

function formatSettingsErrors(prefix: string, errors: Array<{ error: Error }>): string {
  return `${prefix}: ${errors.map(({ error }) => error.message).join("; ")}`;
}

function getAvailableOptions(model: Model<Api> | undefined): ReasoningOption[] {
  if (!model) return [...REASONING_OPTIONS];

  const supportedLevels = new Set(getSupportedReasoningLevels(model));
  const options = REASONING_OPTIONS.filter((option) => supportedLevels.has(option.value));

  return options.length > 0 ? options : [...REASONING_OPTIONS];
}

function isReasoningLevel(value: string): value is ReasoningLevel {
  return REASONING_LEVEL_SET.has(value);
}
