import { getSupportedThinkingLevels as getSupportedReasoningLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { DynamicBorder, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
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
  { value: "xhigh", description: "Maximum reasoning — best for complex problems" },
] as const;

type ReasoningLevel = (typeof REASONING_OPTIONS)[number]["value"];
type ReasoningOption = (typeof REASONING_OPTIONS)[number];

const REASONING_LEVELS = REASONING_OPTIONS.map((option) => option.value);
const REASONING_LEVEL_SET = new Set<string>(REASONING_LEVELS);
const REASONING_USAGE = `/reasoning <${REASONING_LEVELS.join("|")}>`;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("reasoning", {
    description: "Select reasoning level. Use /reasoning <level> to set directly.",
    getArgumentCompletions,
    handler: async (args, ctx) => {
      const argument = args.trim();

      if (argument) {
        const parsed = parseReasoningLevel(argument);
        if (parsed.error) {
          ctx.ui.notify(parsed.error, "warning");
          return;
        }

        setReasoningLevel(pi, ctx, parsed.level);
        return;
      }

      if (ctx.mode !== "tui") {
        const levels = getAvailableOptions(ctx.model).map((option) => option.value).join(", ");
        ctx.ui.notify(`Use ${REASONING_USAGE}. Available for current model: ${levels}`, "info");
        return;
      }

      const selected = await showReasoningSelector(ctx, pi.getThinkingLevel(), getAvailableOptions(ctx.model));
      if (selected !== null) setReasoningLevel(pi, ctx, selected);
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

function parseReasoningLevel(input: string): { level: ReasoningLevel; error?: undefined } | { level?: undefined; error: string } {
  const parts = input.split(/\s+/);
  if (parts.length !== 1) return { error: `Usage: ${REASONING_USAGE}` };

  const level = parts[0].toLowerCase();
  if (!isReasoningLevel(level)) {
    return { error: `Invalid reasoning level: "${parts[0]}". Use: ${REASONING_USAGE}` };
  }

  return { level };
}

async function showReasoningSelector(
  ctx: ExtensionCommandContext,
  current: ReasoningLevel,
  options: ReasoningOption[],
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
    container.addChild(new Text(theme.fg("accent", theme.bold("Select Reasoning Level")), 0, 0));
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

function setReasoningLevel(pi: ExtensionAPI, ctx: ExtensionCommandContext, requested: ReasoningLevel) {
  pi.setThinkingLevel(requested);

  const actual = pi.getThinkingLevel();
  if (actual === requested) {
    ctx.ui.notify(`Reasoning level: ${actual}`, "info");
    return;
  }

  ctx.ui.notify(
    `Reasoning level set to ${actual}; requested ${requested} is not supported by the current model.`,
    "warning",
  );
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
