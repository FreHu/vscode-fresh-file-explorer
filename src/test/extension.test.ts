import * as assert from "assert";
import * as vscode from "vscode";
import { Commands } from "../commands/commandConstants";
import { ConfigKeys } from "../config/configKeyConstants";

suite("Extension Integration Tests", () => {
  const extensionId = "frehu.fresh-file-explorer";

  suite("Extension Activation", () => {
    test("should be present", () => {
      assert.ok(vscode.extensions.getExtension(extensionId));
    });

    test("should activate", async () => {
      const extension = vscode.extensions.getExtension(extensionId);
      await extension?.activate();
      assert.ok(extension?.isActive);
    });
  });

  suite("Command Registration", () => {
    // Dynamically get all commands from the Commands constant
    const commandsToTest = Object.values(Commands) as string[];

    // NOTE: command/config ↔ package.json parity is checked in the fast,
    // host-free tier (src/test/unit/packageJsonDrift.unit.test.ts). This suite
    // covers only what needs a live Extension Host: runtime registration.

    test("should register all extension commands", async () => {
      const allCommands = await vscode.commands.getCommands(true);
      const missingCommands = commandsToTest.filter(cmd => !allCommands.includes(cmd));
      assert.strictEqual(
        missingCommands.length,
        0,
        `Missing commands: ${missingCommands.join(", ")}`
      );
    });

    commandsToTest.forEach(command => {
      test(`should register command: ${command}`, async () => {
        const allCommands = await vscode.commands.getCommands(true);
        assert.ok(
          allCommands.includes(command),
          `Command ${command} is not registered`
        );
      });
    });
  });

  suite("Tree View", () => {
    test("should register Fresh Files tree view", async () => {
      // The tree view should be available after activation
      const extension = vscode.extensions.getExtension(extensionId);
      await extension?.activate();
      
      // We can't directly access the tree view, but we can verify
      // that commands related to it are available
      const allCommands = await vscode.commands.getCommands(true);
      assert.ok(allCommands.includes(Commands.REFRESH));
    });
  });

  suite("Configuration", () => {
    // Config key ↔ package.json parity lives in the host-free drift tier
    // (packageJsonDrift.unit.test.ts). This host test covers the one thing it
    // can't: that the values are actually readable through the VS Code API.

    test("should be able to read all configuration values", () => {
      const config = vscode.workspace.getConfiguration();
      
      // Test a few key config values are readable
      const timeWindows = config.get<number[]>(ConfigKeys.TIME_WINDOWS);
      assert.ok(Array.isArray(timeWindows), "timeWindows should be an array");
      
      const showDate = config.get<boolean>(ConfigKeys.DESCRIPTION_SHOW_DATE);
      assert.ok(
        typeof showDate === "boolean",
        "description.showDate should be a boolean"
      );
      
      const autoExpandDepth = config.get<number>(ConfigKeys.AUTO_EXPAND_DEPTH);
      assert.ok(
        typeof autoExpandDepth === "number",
        "autoExpandDepth should be a number"
      );
    });
  });

  suite("Output Channel", () => {
    test("should be able to execute show output command", async () => {
      await vscode.commands.executeCommand(Commands.SHOW_OUTPUT);
      // The command should not throw - output channel creation is internal
      assert.ok(true, "Show output command executed without error");
    });
  });
});
