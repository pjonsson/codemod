export type TelemetryEvent =
  | Readonly<{
      kind: "codemodExecuted";
      fileCount: number;
      executionId: string;
      codemodName: string;
    }>
  | Readonly<{
      kind: "failedToExecuteCommand";
      commandName: string;
    }>
  | Readonly<{
      kind: "codemodPublished";
      codemodName: string;
      version: string;
    }>;
