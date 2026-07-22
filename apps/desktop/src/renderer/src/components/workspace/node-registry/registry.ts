import {
  Bot,
  Box,
  CheckCircle2,
  FileCode2,
  FileDiff,
  Frame,
  GitBranch,
  GitPullRequest,
  Image,
  LayoutGrid,
  ListChecks,
  MonitorPlay,
  Network,
  NotebookPen,
  PanelTop,
  Play,
  Smartphone,
  TerminalSquare,
  TestTube2,
  Workflow,
  Video,
  type LucideIcon,
} from "lucide-react";

import type { ExtensionCanvasNodeTypeView } from "../../../../../shared/application/contracts.js";

export const NODE_KINDS = [
  "agent",
  "brief",
  "task",
  "file",
  "video",
  "diff",
  "terminal",
  "web-preview",
  "mobile-preview",
  "test",
  "review-gate",
  "git-pr",
  "diagram",
  "whiteboard",
  "note-image",
  "group-frame",
] as const;

export type BuiltInNodeKind = (typeof NODE_KINDS)[number];
export type NodeKind = BuiltInNodeKind | "extension";

export interface SharedNodeBehaviors {
  readonly resizable: true;
  readonly collapsible: true;
  readonly lockable: true;
  readonly duplicable: true;
  readonly deletable: true;
  readonly groupable: true;
  readonly commentable: true;
  readonly runHistory: true;
}

export interface NodeTypeDefinition {
  readonly key: string;
  readonly kind: NodeKind;
  readonly label: string;
  readonly description: string;
  readonly color: string;
  readonly icon: LucideIcon;
  readonly source: "built-in" | "installed-extension" | "persisted-extension";
  readonly behaviors: SharedNodeBehaviors;
  readonly ports?: ExtensionCanvasNodeTypeView["ports"];
}

export interface ExtensionNodeRegistration {
  readonly extensionId: string;
  readonly extensionVersion: string;
  readonly definition: ExtensionCanvasNodeTypeView;
}

export interface NodeDefinitionInput {
  readonly kind: NodeKind;
  readonly extensionId?: string;
  readonly extensionVersion?: string;
  readonly extensionNodeTypeId?: string;
  readonly extensionDefinition?: ExtensionCanvasNodeTypeView;
}

const SHARED_BEHAVIORS: SharedNodeBehaviors = Object.freeze({
  resizable: true,
  collapsible: true,
  lockable: true,
  duplicable: true,
  deletable: true,
  groupable: true,
  commentable: true,
  runHistory: true,
});

const BUILT_INS: readonly Omit<
  NodeTypeDefinition,
  "behaviors" | "source" | "key"
>[] = [
  builtin(
    "agent",
    "Agent",
    "Run an AI coding agent on this computer",
    "#d4a85b",
    Bot,
  ),
  builtin(
    "brief",
    "Product brief",
    "What to build and how to check it",
    "#8d7de8",
    NotebookPen,
  ),
  builtin(
    "task",
    "Task",
    "A piece of work to assign and run",
    "#58a6a6",
    ListChecks,
  ),
  builtin(
    "file",
    "File",
    "A live link to a file on this computer",
    "#6d9ed0",
    FileCode2,
  ),
  builtin(
    "video",
    "Video",
    "Watch a project video and share it with an agent",
    "#d0748b",
    Video,
  ),
  builtin(
    "diff",
    "Diff / review",
    "Review changes and choose what to keep",
    "#e27b68",
    FileDiff,
  ),
  builtin(
    "terminal",
    "Terminal",
    "Run commands on this computer",
    "#8dbd6f",
    TerminalSquare,
  ),
  builtin(
    "web-preview",
    "Web preview",
    "See your web app in its own window",
    "#6099c5",
    MonitorPlay,
  ),
  builtin(
    "mobile-preview",
    "Mobile preview",
    "See your app at phone and tablet sizes",
    "#a27bd3",
    Smartphone,
  ),
  builtin(
    "test",
    "Test",
    "Run the same checks every time",
    "#64a774",
    TestTube2,
  ),
  builtin(
    "review-gate",
    "Review gate",
    "Pause the workflow until work is approved",
    "#d39b55",
    CheckCircle2,
  ),
  builtin(
    "git-pr",
    "Git / PR",
    "Track branches, commits, and approvals",
    "#d06870",
    GitPullRequest,
  ),
  builtin(
    "diagram",
    "Diagram",
    "Turn Mermaid text into a diagram",
    "#7888d8",
    Network,
  ),
  builtin(
    "whiteboard",
    "Whiteboard",
    "Sketch and add notes freely",
    "#c482aa",
    PanelTop,
  ),
  builtin(
    "note-image",
    "Note / image",
    "A quick note or picture",
    "#c5a75f",
    Image,
  ),
  builtin(
    "group-frame",
    "Group",
    "Collect related nodes in one area",
    "#82909b",
    Frame,
  ),
];

const EXTENSION_ICONS: Readonly<
  Record<ExtensionCanvasNodeTypeView["icon"], LucideIcon>
> = {
  bot: Bot,
  box: Box,
  "check-circle": CheckCircle2,
  file: FileCode2,
  "git-branch": GitBranch,
  image: Image,
  layout: LayoutGrid,
  note: NotebookPen,
  play: Play,
  terminal: TerminalSquare,
  workflow: Workflow,
};

export class NodeTypeRegistry {
  readonly #definitions = new Map<string, NodeTypeDefinition>();

  public constructor(extensions: readonly ExtensionNodeRegistration[] = []) {
    for (const definition of BUILT_INS) {
      this.#register({
        ...definition,
        key: definition.kind,
        source: "built-in",
        behaviors: SHARED_BEHAVIORS,
      });
    }
    this.#register({
      key: "extension:unavailable",
      kind: "extension",
      label: "Extension node",
      description: "Fields from an explicitly installed local extension",
      color: "#7f8c98",
      icon: Box,
      source: "persisted-extension",
      behaviors: SHARED_BEHAVIORS,
      ports: [],
    });
    for (const extension of extensions) this.registerExtension(extension);
  }

  public registerExtension(registration: ExtensionNodeRegistration): void {
    const definition = registration.definition;
    this.#register({
      key: extensionNodeTypeKey(
        registration.extensionId,
        registration.extensionVersion,
        definition.id,
      ),
      kind: "extension",
      label: definition.displayName,
      description: definition.description,
      color: definition.color,
      icon: EXTENSION_ICONS[definition.icon],
      source: "installed-extension",
      behaviors: SHARED_BEHAVIORS,
      ports: definition.ports,
    });
  }

  public resolve(input: NodeDefinitionInput): NodeTypeDefinition {
    if (input.kind !== "extension") return this.#definitions.get(input.kind)!;
    const key = extensionInputKey(input);
    const installed = key === null ? undefined : this.#definitions.get(key);
    if (installed !== undefined) return installed;
    if (input.extensionDefinition !== undefined) {
      return {
        key: key ?? "extension:unavailable",
        kind: "extension",
        label: input.extensionDefinition.displayName,
        description: input.extensionDefinition.description,
        color: input.extensionDefinition.color,
        icon: EXTENSION_ICONS[input.extensionDefinition.icon],
        source: "persisted-extension",
        behaviors: SHARED_BEHAVIORS,
        ports: input.extensionDefinition.ports,
      };
    }
    return this.#definitions.get("extension:unavailable")!;
  }

  public builtIns(): readonly NodeTypeDefinition[] {
    return NODE_KINDS.map((kind) => this.#definitions.get(kind)!);
  }

  #register(definition: NodeTypeDefinition): void {
    if (this.#definitions.has(definition.key)) {
      throw new Error(
        `Node type registration already exists: ${definition.key}`,
      );
    }
    this.#definitions.set(definition.key, Object.freeze(definition));
  }
}

export const BUILT_IN_NODE_REGISTRY = new NodeTypeRegistry();

export const NODE_DEFINITIONS = Object.freeze(
  Object.fromEntries(
    [
      ...BUILT_IN_NODE_REGISTRY.builtIns(),
      BUILT_IN_NODE_REGISTRY.resolve({ kind: "extension" }),
    ].map((definition) => [definition.kind, definition]),
  ) as Record<NodeKind, NodeTypeDefinition>,
);

export function extensionNodeTypeKey(
  extensionId: string,
  extensionVersion: string,
  nodeTypeId: string,
): string {
  return `extension:${extensionId}:${extensionVersion}:${nodeTypeId}`;
}

function extensionInputKey(input: NodeDefinitionInput): string | null {
  return input.extensionId === undefined ||
    input.extensionVersion === undefined ||
    input.extensionNodeTypeId === undefined
    ? null
    : extensionNodeTypeKey(
        input.extensionId,
        input.extensionVersion,
        input.extensionNodeTypeId,
      );
}

function builtin(
  kind: BuiltInNodeKind,
  label: string,
  description: string,
  color: string,
  icon: LucideIcon,
): Omit<NodeTypeDefinition, "behaviors" | "source" | "key"> {
  return { kind, label, description, color, icon };
}
