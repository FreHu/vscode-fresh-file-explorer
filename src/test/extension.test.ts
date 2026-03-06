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

    test("should define all commands in package.json", () => {
      const extension = vscode.extensions.getExtension("frehu.fresh-file-explorer");
      assert.ok(extension, "Extension should be available");

      const packageJson = extension.packageJSON;
      const definedCommands = packageJson.contributes?.commands?.map((cmd: any) => cmd.command) || [];

      const missingInPackageJson = commandsToTest.filter(cmd => !definedCommands.includes(cmd));
      assert.strictEqual(
        missingInPackageJson.length,
        0,
        `Commands missing in package.json: ${missingInPackageJson.join(", ")}`
      );
    });

    test("should have all package.json commands in Constants", () => {
      const extension = vscode.extensions.getExtension("frehu.fresh-file-explorer");
      assert.ok(extension, "Extension should be available");

      const packageJson = extension.packageJSON;
      const definedCommands = packageJson.contributes?.commands?.map((cmd: any) => cmd.command) || [];

      const missingInConstants = definedCommands.filter((cmd: string) => !commandsToTest.includes(cmd));
      assert.strictEqual(
        missingInConstants.length,
        0,
        `Commands in package.json but not in Commands constant: ${missingInConstants.join(", ")}`
      );
    });

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
    // Dynamically get all config keys from the ConfigKeys constant
    const configKeysToTest = Object.values(ConfigKeys) as string[];

    test("should define all config keys in package.json", () => {
      const extension = vscode.extensions.getExtension("frehu.fresh-file-explorer");
      assert.ok(extension, "Extension should be available");

      const packageJson = extension.packageJSON;
      const definedConfigs = Object.keys(packageJson.contributes?.configuration?.properties || {});

      const missingInPackageJson = configKeysToTest.filter(key => !definedConfigs.includes(key));
      assert.strictEqual(
        missingInPackageJson.length,
        0,
        `Config keys missing in package.json: ${missingInPackageJson.join(", ")}`
      );
    });

    test("should have all package.json config keys in ConfigKeys", () => {
      const extension = vscode.extensions.getExtension("frehu.fresh-file-explorer");
      assert.ok(extension, "Extension should be available");

      const packageJson = extension.packageJSON;
      const definedConfigs = Object.keys(packageJson.contributes?.configuration?.properties || {});

      const missingInConstants = definedConfigs.filter((key: string) => !configKeysToTest.includes(key));
      assert.strictEqual(
        missingInConstants.length,
        0,
        `Config keys in package.json but not in ConfigKeys constant: ${missingInConstants.join(", ")}`
      );
    });

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
