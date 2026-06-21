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

export interface JsonSchemaProperty {
  type: string | string[];
  description?: string;
  optional?: boolean;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  default?: any;
  additionalProperties?: boolean | JsonSchemaProperty;
  minimum?: number;
  maximum?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  annotations?: ToolAnnotations;
  inputSchema: {
    type: string;
    properties: Record<string, JsonSchemaProperty>;
    required?: string[];
  };
}
