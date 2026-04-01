export interface ToolAnnotations {
  /** If true, the tool only reads data and never modifies anything. Allows auto-approval. */
  readOnlyHint?: boolean;
  /** If true, the tool may perform irreversible or destructive actions. */
  destructiveHint?: boolean;
  /** If true, calling the tool twice with the same args has no additional side effects. */
  idempotentHint?: boolean;
  /** Human-readable title for the tool (shown in UI). */
  title?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  annotations?: ToolAnnotations;
  inputSchema: {
    type: string;
    properties: Record<string, {
      type: string;
      description?: string;
      optional?: boolean;
    }>;
    required?: string[];
  };
}
