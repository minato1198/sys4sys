export {
  CLI_SCHEMA_VERSION,
  CLI_VERSION,
  formatSchemaJson,
  formatSchemaMarkdown,
  generateSchema,
  printSchema,
  type CliSchema,
  type CommandSchema,
  type JsonSchemaProperty,
} from "./commands/schema.js";
export { COMMANDS, GLOBAL_OPTIONS, commandNames } from "./commands/registry.js";
