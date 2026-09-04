#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/cli/main.ts
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// node_modules/commander/lib/error.js
var CommanderError = class extends Error {
  /**
   * Constructs the CommanderError class
   * @param {number} exitCode suggested exit code which could be used with process.exit
   * @param {string} code an id string representing the error
   * @param {string} message human-readable description of the error
   */
  constructor(exitCode, code, message) {
    super(message);
    Error.captureStackTrace(this, this.constructor);
    this.name = this.constructor.name;
    this.code = code;
    this.exitCode = exitCode;
    this.nestedError = void 0;
  }
};
var InvalidArgumentError = class extends CommanderError {
  /**
   * Constructs the InvalidArgumentError class
   * @param {string} [message] explanation of why argument is invalid
   */
  constructor(message) {
    super(1, "commander.invalidArgument", message);
    Error.captureStackTrace(this, this.constructor);
    this.name = this.constructor.name;
  }
};

// node_modules/commander/lib/argument.js
var Argument = class {
  /**
   * Initialize a new command argument with the given name and description.
   * The default is that the argument is required, and you can explicitly
   * indicate this with <> around the name. Put [] around the name for an optional argument.
   *
   * @param {string} name
   * @param {string} [description]
   */
  constructor(name, description) {
    this.description = description || "";
    this.variadic = false;
    this.parseArg = void 0;
    this.defaultValue = void 0;
    this.defaultValueDescription = void 0;
    this.argChoices = void 0;
    switch (name[0]) {
      case "<":
        this.required = true;
        this._name = name.slice(1, -1);
        break;
      case "[":
        this.required = false;
        this._name = name.slice(1, -1);
        break;
      default:
        this.required = true;
        this._name = name;
        break;
    }
    if (this._name.endsWith("...")) {
      this.variadic = true;
      this._name = this._name.slice(0, -3);
    }
  }
  /**
   * Return argument name.
   *
   * @return {string}
   */
  name() {
    return this._name;
  }
  /**
   * @package
   */
  _collectValue(value, previous) {
    if (previous === this.defaultValue || !Array.isArray(previous)) {
      return [value];
    }
    previous.push(value);
    return previous;
  }
  /**
   * Set the default value, and optionally supply the description to be displayed in the help.
   *
   * @param {*} value
   * @param {string} [description]
   * @return {Argument}
   */
  default(value, description) {
    this.defaultValue = value;
    this.defaultValueDescription = description;
    return this;
  }
  /**
   * Set the custom handler for processing CLI command arguments into argument values.
   *
   * @param {Function} [fn]
   * @return {Argument}
   */
  argParser(fn) {
    this.parseArg = fn;
    return this;
  }
  /**
   * Only allow argument value to be one of choices.
   *
   * @param {string[]} values
   * @return {Argument}
   */
  choices(values) {
    this.argChoices = values.slice();
    this.parseArg = (arg, previous) => {
      if (!this.argChoices.includes(arg)) {
        throw new InvalidArgumentError(
          `Allowed choices are ${this.argChoices.join(", ")}.`
        );
      }
      if (this.variadic) {
        return this._collectValue(arg, previous);
      }
      return arg;
    };
    return this;
  }
  /**
   * Make argument required.
   *
   * @returns {Argument}
   */
  argRequired() {
    this.required = true;
    return this;
  }
  /**
   * Make argument optional.
   *
   * @returns {Argument}
   */
  argOptional() {
    this.required = false;
    return this;
  }
};
function humanReadableArgName(arg) {
  const nameOutput = arg.name() + (arg.variadic === true ? "..." : "");
  return arg.required ? "<" + nameOutput + ">" : "[" + nameOutput + "]";
}

// node_modules/commander/lib/command.js
import { EventEmitter } from "node:events";
import childProcess from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import process2 from "node:process";
import { stripVTControlCharacters as stripVTControlCharacters2 } from "node:util";

// node_modules/commander/lib/help.js
import { stripVTControlCharacters } from "node:util";
var Help = class {
  constructor() {
    this.helpWidth = void 0;
    this.minWidthToWrap = 40;
    this.sortSubcommands = false;
    this.sortOptions = false;
    this.showGlobalOptions = false;
  }
  /**
   * prepareContext is called by Commander after applying overrides from `Command.configureHelp()`
   * and just before calling `formatHelp()`.
   *
   * Commander just uses the helpWidth and the rest is provided for optional use by more complex subclasses.
   *
   * @param {{ error?: boolean, helpWidth?: number, outputHasColors?: boolean }} contextOptions
   */
  prepareContext(contextOptions) {
    this.helpWidth = this.helpWidth ?? contextOptions.helpWidth ?? 80;
  }
  /**
   * Get an array of the visible subcommands. Includes a placeholder for the implicit help command, if there is one.
   *
   * @param {Command} cmd
   * @returns {Command[]}
   */
  visibleCommands(cmd) {
    const visibleCommands = cmd.commands.filter((cmd2) => !cmd2._hidden);
    const helpCommand = cmd._getHelpCommand();
    if (helpCommand && !helpCommand._hidden) {
      visibleCommands.push(helpCommand);
    }
    if (this.sortSubcommands) {
      visibleCommands.sort((a, b) => {
        return a.name().localeCompare(b.name());
      });
    }
    return visibleCommands;
  }
  /**
   * Compare options for sort.
   *
   * @param {Option} a
   * @param {Option} b
   * @returns {number}
   */
  compareOptions(a, b) {
    const getSortKey = (option) => {
      return option.short ? option.short.replace(/^-/, "") : option.long.replace(/^--/, "");
    };
    return getSortKey(a).localeCompare(getSortKey(b));
  }
  /**
   * Get an array of the visible options. Includes a placeholder for the implicit help option, if there is one.
   *
   * @param {Command} cmd
   * @returns {Option[]}
   */
  visibleOptions(cmd) {
    const visibleOptions = cmd.options.filter((option) => !option.hidden);
    const helpOption = cmd._getHelpOption();
    if (helpOption && !helpOption.hidden) {
      const removeShort = helpOption.short && cmd._findOption(helpOption.short);
      const removeLong = helpOption.long && cmd._findOption(helpOption.long);
      if (!removeShort && !removeLong) {
        visibleOptions.push(helpOption);
      } else if (helpOption.long && !removeLong) {
        visibleOptions.push(
          cmd.createOption(helpOption.long, helpOption.description)
        );
      } else if (helpOption.short && !removeShort) {
        visibleOptions.push(
          cmd.createOption(helpOption.short, helpOption.description)
        );
      }
    }
    if (this.sortOptions) {
      visibleOptions.sort(this.compareOptions);
    }
    return visibleOptions;
  }
  /**
   * Get an array of the visible global options. (Not including help.)
   *
   * @param {Command} cmd
   * @returns {Option[]}
   */
  visibleGlobalOptions(cmd) {
    if (!this.showGlobalOptions) return [];
    const globalOptions = [];
    for (let ancestorCmd = cmd.parent; ancestorCmd; ancestorCmd = ancestorCmd.parent) {
      const visibleOptions = ancestorCmd.options.filter(
        (option) => !option.hidden
      );
      globalOptions.push(...visibleOptions);
    }
    if (this.sortOptions) {
      globalOptions.sort(this.compareOptions);
    }
    return globalOptions;
  }
  /**
   * Get an array of the arguments if any have a description.
   *
   * @param {Command} cmd
   * @returns {Argument[]}
   */
  visibleArguments(cmd) {
    if (cmd._argsDescription) {
      cmd.registeredArguments.forEach((argument) => {
        argument.description = argument.description || cmd._argsDescription[argument.name()] || "";
      });
    }
    if (cmd.registeredArguments.find((argument) => argument.description)) {
      return cmd.registeredArguments;
    }
    return [];
  }
  /**
   * Get the command term to show in the list of subcommands.
   *
   * @param {Command} cmd
   * @returns {string}
   */
  subcommandTerm(cmd) {
    const args = cmd.registeredArguments.map((arg) => humanReadableArgName(arg)).join(" ");
    return cmd._name + (cmd._aliases[0] ? "|" + cmd._aliases[0] : "") + (cmd.options.length ? " [options]" : "") + // simplistic check for non-help option
    (args ? " " + args : "");
  }
  /**
   * Get the option term to show in the list of options.
   *
   * @param {Option} option
   * @returns {string}
   */
  optionTerm(option) {
    return option.flags;
  }
  /**
   * Get the argument term to show in the list of arguments.
   *
   * @param {Argument} argument
   * @returns {string}
   */
  argumentTerm(argument) {
    return argument.name();
  }
  /**
   * Get the longest command term length.
   *
   * @param {Command} cmd
   * @param {Help} helper
   * @returns {number}
   */
  longestSubcommandTermLength(cmd, helper) {
    return helper.visibleCommands(cmd).reduce((max, command) => {
      return Math.max(
        max,
        this.displayWidth(
          helper.styleSubcommandTerm(helper.subcommandTerm(command))
        )
      );
    }, 0);
  }
  /**
   * Get the longest option term length.
   *
   * @param {Command} cmd
   * @param {Help} helper
   * @returns {number}
   */
  longestOptionTermLength(cmd, helper) {
    return helper.visibleOptions(cmd).reduce((max, option) => {
      return Math.max(
        max,
        this.displayWidth(helper.styleOptionTerm(helper.optionTerm(option)))
      );
    }, 0);
  }
  /**
   * Get the longest global option term length.
   *
   * @param {Command} cmd
   * @param {Help} helper
   * @returns {number}
   */
  longestGlobalOptionTermLength(cmd, helper) {
    return helper.visibleGlobalOptions(cmd).reduce((max, option) => {
      return Math.max(
        max,
        this.displayWidth(helper.styleOptionTerm(helper.optionTerm(option)))
      );
    }, 0);
  }
  /**
   * Get the longest argument term length.
   *
   * @param {Command} cmd
   * @param {Help} helper
   * @returns {number}
   */
  longestArgumentTermLength(cmd, helper) {
    return helper.visibleArguments(cmd).reduce((max, argument) => {
      return Math.max(
        max,
        this.displayWidth(
          helper.styleArgumentTerm(helper.argumentTerm(argument))
        )
      );
    }, 0);
  }
  /**
   * Get the command usage to be displayed at the top of the built-in help.
   *
   * @param {Command} cmd
   * @returns {string}
   */
  commandUsage(cmd) {
    let cmdName = cmd._name;
    if (cmd._aliases[0]) {
      cmdName = cmdName + "|" + cmd._aliases[0];
    }
    let ancestorCmdNames = "";
    for (let ancestorCmd = cmd.parent; ancestorCmd; ancestorCmd = ancestorCmd.parent) {
      ancestorCmdNames = ancestorCmd.name() + " " + ancestorCmdNames;
    }
    return ancestorCmdNames + cmdName + " " + cmd.usage();
  }
  /**
   * Get the description for the command.
   *
   * @param {Command} cmd
   * @returns {string}
   */
  commandDescription(cmd) {
    return cmd.description();
  }
  /**
   * Get the subcommand summary to show in the list of subcommands.
   * (Fallback to description for backwards compatibility.)
   *
   * @param {Command} cmd
   * @returns {string}
   */
  subcommandDescription(cmd) {
    return cmd.summary() || cmd.description();
  }
  /**
   * Get the option description to show in the list of options.
   *
   * @param {Option} option
   * @return {string}
   */
  optionDescription(option) {
    const extraInfo = [];
    if (option.argChoices) {
      extraInfo.push(
        // use stringify to match the display of the default value
        `choices: ${option.argChoices.map((choice) => JSON.stringify(choice)).join(", ")}`
      );
    }
    if (option.defaultValue !== void 0) {
      const showDefault = option.required || option.optional || option.isBoolean() && typeof option.defaultValue === "boolean";
      if (showDefault) {
        extraInfo.push(
          `default: ${option.defaultValueDescription || JSON.stringify(option.defaultValue)}`
        );
      }
    }
    if (option.presetArg !== void 0 && option.optional) {
      extraInfo.push(`preset: ${JSON.stringify(option.presetArg)}`);
    }
    if (option.envVar !== void 0) {
      extraInfo.push(`env: ${option.envVar}`);
    }
    if (extraInfo.length > 0) {
      const extraDescription = `(${extraInfo.join(", ")})`;
      if (option.description) {
        return `${option.description} ${extraDescription}`;
      }
      return extraDescription;
    }
    return option.description;
  }
  /**
   * Get the argument description to show in the list of arguments.
   *
   * @param {Argument} argument
   * @return {string}
   */
  argumentDescription(argument) {
    const extraInfo = [];
    if (argument.argChoices) {
      extraInfo.push(
        // use stringify to match the display of the default value
        `choices: ${argument.argChoices.map((choice) => JSON.stringify(choice)).join(", ")}`
      );
    }
    if (argument.defaultValue !== void 0) {
      extraInfo.push(
        `default: ${argument.defaultValueDescription || JSON.stringify(argument.defaultValue)}`
      );
    }
    if (extraInfo.length > 0) {
      const extraDescription = `(${extraInfo.join(", ")})`;
      if (argument.description) {
        return `${argument.description} ${extraDescription}`;
      }
      return extraDescription;
    }
    return argument.description;
  }
  /**
   * Format a list of items, given a heading and an array of formatted items.
   *
   * @param {string} heading
   * @param {string[]} items
   * @param {Help} helper
   * @returns string[]
   */
  formatItemList(heading, items, helper) {
    if (items.length === 0) return [];
    return [helper.styleTitle(heading), ...items, ""];
  }
  /**
   * Group items by their help group heading.
   *
   * @param {Command[] | Option[]} unsortedItems
   * @param {Command[] | Option[]} visibleItems
   * @param {Function} getGroup
   * @returns {Map<string, Command[] | Option[]>}
   */
  groupItems(unsortedItems, visibleItems, getGroup) {
    const result = /* @__PURE__ */ new Map();
    unsortedItems.forEach((item) => {
      const group = getGroup(item);
      if (!result.has(group)) result.set(group, []);
    });
    visibleItems.forEach((item) => {
      const group = getGroup(item);
      if (!result.has(group)) {
        result.set(group, []);
      }
      result.get(group).push(item);
    });
    return result;
  }
  /**
   * Generate the built-in help text.
   *
   * @param {Command} cmd
   * @param {Help} helper
   * @returns {string}
   */
  formatHelp(cmd, helper) {
    const termWidth = helper.padWidth(cmd, helper);
    const helpWidth = helper.helpWidth ?? 80;
    function callFormatItem(term, description) {
      return helper.formatItem(term, termWidth, description, helper);
    }
    let output = [
      `${helper.styleTitle("Usage:")} ${helper.styleUsage(helper.commandUsage(cmd))}`,
      ""
    ];
    const commandDescription = helper.commandDescription(cmd);
    if (commandDescription.length > 0) {
      output = output.concat([
        helper.boxWrap(
          helper.styleCommandDescription(commandDescription),
          helpWidth
        ),
        ""
      ]);
    }
    const argumentList = helper.visibleArguments(cmd).map((argument) => {
      return callFormatItem(
        helper.styleArgumentTerm(helper.argumentTerm(argument)),
        helper.styleArgumentDescription(helper.argumentDescription(argument))
      );
    });
    output = output.concat(
      this.formatItemList("Arguments:", argumentList, helper)
    );
    const optionGroups = this.groupItems(
      cmd.options,
      helper.visibleOptions(cmd),
      (option) => option.helpGroupHeading ?? "Options:"
    );
    optionGroups.forEach((options, group) => {
      const optionList = options.map((option) => {
        return callFormatItem(
          helper.styleOptionTerm(helper.optionTerm(option)),
          helper.styleOptionDescription(helper.optionDescription(option))
        );
      });
      output = output.concat(this.formatItemList(group, optionList, helper));
    });
    if (helper.showGlobalOptions) {
      const globalOptionList = helper.visibleGlobalOptions(cmd).map((option) => {
        return callFormatItem(
          helper.styleOptionTerm(helper.optionTerm(option)),
          helper.styleOptionDescription(helper.optionDescription(option))
        );
      });
      output = output.concat(
        this.formatItemList("Global Options:", globalOptionList, helper)
      );
    }
    const commandGroups = this.groupItems(
      cmd.commands,
      helper.visibleCommands(cmd),
      (sub) => sub.helpGroup() || "Commands:"
    );
    commandGroups.forEach((commands, group) => {
      const commandList = commands.map((sub) => {
        return callFormatItem(
          helper.styleSubcommandTerm(helper.subcommandTerm(sub)),
          helper.styleSubcommandDescription(helper.subcommandDescription(sub))
        );
      });
      output = output.concat(this.formatItemList(group, commandList, helper));
    });
    return output.join("\n");
  }
  /**
   * Return display width of string, ignoring ANSI escape sequences. Used in padding and wrapping calculations.
   *
   * @param {string} str
   * @returns {number}
   */
  displayWidth(str) {
    return stripVTControlCharacters(str).length;
  }
  /**
   * Style the title for displaying in the help. Called with 'Usage:', 'Options:', etc.
   *
   * @param {string} str
   * @returns {string}
   */
  styleTitle(str) {
    return str;
  }
  styleUsage(str) {
    return str.split(" ").map((word) => {
      if (word === "[options]") return this.styleOptionText(word);
      if (word === "[command]") return this.styleSubcommandText(word);
      if (word[0] === "[" || word[0] === "<")
        return this.styleArgumentText(word);
      return this.styleCommandText(word);
    }).join(" ");
  }
  styleCommandDescription(str) {
    return this.styleDescriptionText(str);
  }
  styleOptionDescription(str) {
    return this.styleDescriptionText(str);
  }
  styleSubcommandDescription(str) {
    return this.styleDescriptionText(str);
  }
  styleArgumentDescription(str) {
    return this.styleDescriptionText(str);
  }
  styleDescriptionText(str) {
    return str;
  }
  styleOptionTerm(str) {
    return this.styleOptionText(str);
  }
  styleSubcommandTerm(str) {
    return str.split(" ").map((word) => {
      if (word === "[options]") return this.styleOptionText(word);
      if (word[0] === "[" || word[0] === "<")
        return this.styleArgumentText(word);
      return this.styleSubcommandText(word);
    }).join(" ");
  }
  styleArgumentTerm(str) {
    return this.styleArgumentText(str);
  }
  styleOptionText(str) {
    return str;
  }
  styleArgumentText(str) {
    return str;
  }
  styleSubcommandText(str) {
    return str;
  }
  styleCommandText(str) {
    return str;
  }
  /**
   * Calculate the pad width from the maximum term length.
   *
   * @param {Command} cmd
   * @param {Help} helper
   * @returns {number}
   */
  padWidth(cmd, helper) {
    return Math.max(
      helper.longestOptionTermLength(cmd, helper),
      helper.longestGlobalOptionTermLength(cmd, helper),
      helper.longestSubcommandTermLength(cmd, helper),
      helper.longestArgumentTermLength(cmd, helper)
    );
  }
  /**
   * Detect manually wrapped and indented strings by checking for line break followed by whitespace.
   *
   * @param {string} str
   * @returns {boolean}
   */
  preformatted(str) {
    return /\n[^\S\r\n]/.test(str);
  }
  /**
   * Format the "item", which consists of a term and description. Pad the term and wrap the description, indenting the following lines.
   *
   * So "TTT", 5, "DDD DDDD DD DDD" might be formatted for this.helpWidth=17 like so:
   *   TTT  DDD DDDD
   *        DD DDD
   *
   * @param {string} term
   * @param {number} termWidth
   * @param {string} description
   * @param {Help} helper
   * @returns {string}
   */
  formatItem(term, termWidth, description, helper) {
    const itemIndent = 2;
    const itemIndentStr = " ".repeat(itemIndent);
    if (!description) return itemIndentStr + term;
    const paddedTerm = term.padEnd(
      termWidth + term.length - helper.displayWidth(term)
    );
    const spacerWidth = 2;
    const helpWidth = this.helpWidth ?? 80;
    const remainingWidth = helpWidth - termWidth - spacerWidth - itemIndent;
    let formattedDescription;
    if (remainingWidth < this.minWidthToWrap || helper.preformatted(description)) {
      formattedDescription = description;
    } else {
      const wrappedDescription = helper.boxWrap(description, remainingWidth);
      formattedDescription = wrappedDescription.replace(
        /\n/g,
        "\n" + " ".repeat(termWidth + spacerWidth)
      );
    }
    return itemIndentStr + paddedTerm + " ".repeat(spacerWidth) + formattedDescription.replace(/\n/g, `
${itemIndentStr}`);
  }
  /**
   * Wrap a string at whitespace, preserving existing line breaks.
   * Wrapping is skipped if the width is less than `minWidthToWrap`.
   *
   * @param {string} str
   * @param {number} width
   * @returns {string}
   */
  boxWrap(str, width) {
    if (width < this.minWidthToWrap) return str;
    const rawLines = str.split(/\r\n|\n/);
    const chunkPattern = /[\s]*[^\s]+/g;
    const wrappedLines = [];
    rawLines.forEach((line) => {
      const chunks = line.match(chunkPattern);
      if (chunks === null) {
        wrappedLines.push("");
        return;
      }
      let sumChunks = [chunks.shift()];
      let sumWidth = this.displayWidth(sumChunks[0]);
      chunks.forEach((chunk) => {
        const visibleWidth = this.displayWidth(chunk);
        if (sumWidth + visibleWidth <= width) {
          sumChunks.push(chunk);
          sumWidth += visibleWidth;
          return;
        }
        wrappedLines.push(sumChunks.join(""));
        const nextChunk = chunk.trimStart();
        sumChunks = [nextChunk];
        sumWidth = this.displayWidth(nextChunk);
      });
      wrappedLines.push(sumChunks.join(""));
    });
    return wrappedLines.join("\n");
  }
};

// node_modules/commander/lib/option.js
var Option = class {
  /**
   * Initialize a new `Option` with the given `flags` and `description`.
   *
   * @param {string} flags
   * @param {string} [description]
   */
  constructor(flags, description) {
    this.flags = flags;
    this.description = description || "";
    this.required = flags.includes("<");
    this.optional = flags.includes("[");
    this.variadic = /\w\.\.\.[>\]]$/.test(flags);
    this.mandatory = false;
    const optionFlags = splitOptionFlags(flags);
    this.short = optionFlags.shortFlag;
    this.long = optionFlags.longFlag;
    this.negate = false;
    if (this.long) {
      this.negate = this.long.startsWith("--no-");
    }
    this.defaultValue = void 0;
    this.defaultValueDescription = void 0;
    this.presetArg = void 0;
    this.envVar = void 0;
    this.parseArg = void 0;
    this.hidden = false;
    this.argChoices = void 0;
    this.conflictsWith = [];
    this.implied = void 0;
    this.helpGroupHeading = void 0;
  }
  /**
   * Set the default value, and optionally supply the description to be displayed in the help.
   *
   * @param {*} value
   * @param {string} [description]
   * @return {Option}
   */
  default(value, description) {
    this.defaultValue = value;
    this.defaultValueDescription = description;
    return this;
  }
  /**
   * Preset to use when option used without option-argument, especially optional but also boolean and negated.
   * The custom processing (parseArg) is called.
   *
   * @example
   * new Option('--color').default('GREYSCALE').preset('RGB');
   * new Option('--donate [amount]').preset('20').argParser(parseFloat);
   *
   * @param {*} arg
   * @return {Option}
   */
  preset(arg) {
    this.presetArg = arg;
    return this;
  }
  /**
   * Add option name(s) that conflict with this option.
   * An error will be displayed if conflicting options are found during parsing.
   *
   * @example
   * new Option('--rgb').conflicts('cmyk');
   * new Option('--js').conflicts(['ts', 'jsx']);
   *
   * @param {(string | string[])} names
   * @return {Option}
   */
  conflicts(names) {
    this.conflictsWith = this.conflictsWith.concat(names);
    return this;
  }
  /**
   * Specify implied option values for when this option is set and the implied options are not.
   *
   * The custom processing (parseArg) is not called on the implied values.
   *
   * @example
   * program
   *   .addOption(new Option('--log', 'write logging information to file'))
   *   .addOption(new Option('--trace', 'log extra details').implies({ log: 'trace.txt' }));
   *
   * @param {object} impliedOptionValues
   * @return {Option}
   */
  implies(impliedOptionValues) {
    let newImplied = impliedOptionValues;
    if (typeof impliedOptionValues === "string") {
      newImplied = { [impliedOptionValues]: true };
    }
    this.implied = Object.assign(this.implied || {}, newImplied);
    return this;
  }
  /**
   * Set environment variable to check for option value.
   *
   * An environment variable is only used if when processed the current option value is
   * undefined, or the source of the current value is 'default' or 'config' or 'env'.
   *
   * @param {string} name
   * @return {Option}
   */
  env(name) {
    this.envVar = name;
    return this;
  }
  /**
   * Set the custom handler for processing CLI option arguments into option values.
   *
   * @param {Function} [fn]
   * @return {Option}
   */
  argParser(fn) {
    this.parseArg = fn;
    return this;
  }
  /**
   * Whether the option is mandatory and must have a value after parsing.
   *
   * @param {boolean} [mandatory=true]
   * @return {Option}
   */
  makeOptionMandatory(mandatory = true) {
    this.mandatory = !!mandatory;
    return this;
  }
  /**
   * Hide option in help.
   *
   * @param {boolean} [hide=true]
   * @return {Option}
   */
  hideHelp(hide = true) {
    this.hidden = !!hide;
    return this;
  }
  /**
   * @package
   */
  _collectValue(value, previous) {
    if (previous === this.defaultValue || !Array.isArray(previous)) {
      return [value];
    }
    previous.push(value);
    return previous;
  }
  /**
   * Only allow option value to be one of choices.
   *
   * @param {string[]} values
   * @return {Option}
   */
  choices(values) {
    this.argChoices = values.slice();
    this.parseArg = (arg, previous) => {
      if (!this.argChoices.includes(arg)) {
        throw new InvalidArgumentError(
          `Allowed choices are ${this.argChoices.join(", ")}.`
        );
      }
      if (this.variadic) {
        return this._collectValue(arg, previous);
      }
      return arg;
    };
    return this;
  }
  /**
   * Return option name.
   *
   * @return {string}
   */
  name() {
    if (this.long) {
      return this.long.replace(/^--/, "");
    }
    return this.short.replace(/^-/, "");
  }
  /**
   * Return option name, in a camelcase format that can be used
   * as an object attribute key.
   *
   * @return {string}
   */
  attributeName() {
    if (this.negate) {
      return camelcase(this.name().replace(/^no-/, ""));
    }
    return camelcase(this.name());
  }
  /**
   * Set the help group heading.
   *
   * @param {string} heading
   * @return {Option}
   */
  helpGroup(heading) {
    this.helpGroupHeading = heading;
    return this;
  }
  /**
   * Check if `arg` matches the short or long flag.
   *
   * @param {string} arg
   * @return {boolean}
   * @package
   */
  is(arg) {
    return this.short === arg || this.long === arg;
  }
  /**
   * Return whether a boolean option.
   *
   * Options are one of boolean, negated, required argument, or optional argument.
   *
   * @return {boolean}
   * @package
   */
  isBoolean() {
    return !this.required && !this.optional && !this.negate;
  }
};
var DualOptions = class {
  /**
   * @param {Option[]} options
   */
  constructor(options) {
    this.positiveOptions = /* @__PURE__ */ new Map();
    this.negativeOptions = /* @__PURE__ */ new Map();
    this.dualOptions = /* @__PURE__ */ new Set();
    options.forEach((option) => {
      if (option.negate) {
        this.negativeOptions.set(option.attributeName(), option);
      } else {
        this.positiveOptions.set(option.attributeName(), option);
      }
    });
    this.negativeOptions.forEach((value, key) => {
      if (this.positiveOptions.has(key)) {
        this.dualOptions.add(key);
      }
    });
  }
  /**
   * Did the value come from the option, and not from possible matching dual option?
   *
   * @param {*} value
   * @param {Option} option
   * @returns {boolean}
   */
  valueFromOption(value, option) {
    const optionKey = option.attributeName();
    if (!this.dualOptions.has(optionKey)) return true;
    const preset = this.negativeOptions.get(optionKey).presetArg;
    const negativeValue = preset !== void 0 ? preset : false;
    return option.negate === (negativeValue === value);
  }
};
function camelcase(str) {
  return str.split("-").reduce((str2, word) => {
    return str2 + word[0].toUpperCase() + word.slice(1);
  });
}
function splitOptionFlags(flags) {
  let shortFlag;
  let longFlag;
  const shortFlagExp = /^-[^-]$/;
  const longFlagExp = /^--[^-]/;
  const flagParts = flags.split(/[ |,]+/).concat("guard");
  if (shortFlagExp.test(flagParts[0])) shortFlag = flagParts.shift();
  if (longFlagExp.test(flagParts[0])) longFlag = flagParts.shift();
  if (!shortFlag && shortFlagExp.test(flagParts[0]))
    shortFlag = flagParts.shift();
  if (!shortFlag && longFlagExp.test(flagParts[0])) {
    shortFlag = longFlag;
    longFlag = flagParts.shift();
  }
  if (flagParts[0].startsWith("-")) {
    const unsupportedFlag = flagParts[0];
    const baseError = `option creation failed due to '${unsupportedFlag}' in option flags '${flags}'`;
    if (/^-[^-][^-]/.test(unsupportedFlag))
      throw new Error(
        `${baseError}
- a short flag is a single dash and a single character
  - either use a single dash and a single character (for a short flag)
  - or use a double dash for a long option (and can have two, like '--ws, --workspace')`
      );
    if (shortFlagExp.test(unsupportedFlag))
      throw new Error(`${baseError}
- too many short flags`);
    if (longFlagExp.test(unsupportedFlag))
      throw new Error(`${baseError}
- too many long flags`);
    throw new Error(`${baseError}
- unrecognised flag format`);
  }
  if (shortFlag === void 0 && longFlag === void 0)
    throw new Error(
      `option creation failed due to no flags found in '${flags}'.`
    );
  return { shortFlag, longFlag };
}

// node_modules/commander/lib/suggestSimilar.js
var maxDistance = 3;
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > maxDistance)
    return Math.max(a.length, b.length);
  const d = [];
  for (let i = 0; i <= a.length; i++) {
    d[i] = [i];
  }
  for (let j = 0; j <= b.length; j++) {
    d[0][j] = j;
  }
  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      let cost;
      if (a[i - 1] === b[j - 1]) {
        cost = 0;
      } else {
        cost = 1;
      }
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        // deletion
        d[i][j - 1] + 1,
        // insertion
        d[i - 1][j - 1] + cost
        // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}
function suggestSimilar(word, candidates) {
  if (!candidates || candidates.length === 0) return "";
  candidates = Array.from(new Set(candidates));
  const searchingOptions = word.startsWith("--");
  if (searchingOptions) {
    word = word.slice(2);
    candidates = candidates.map((candidate) => candidate.slice(2));
  }
  let similar = [];
  let bestDistance = maxDistance;
  const minSimilarity = 0.4;
  candidates.forEach((candidate) => {
    if (candidate.length <= 1) return;
    const distance = editDistance(word, candidate);
    const length = Math.max(word.length, candidate.length);
    const similarity = (length - distance) / length;
    if (similarity > minSimilarity) {
      if (distance < bestDistance) {
        bestDistance = distance;
        similar = [candidate];
      } else if (distance === bestDistance) {
        similar.push(candidate);
      }
    }
  });
  similar.sort((a, b) => a.localeCompare(b));
  if (searchingOptions) {
    similar = similar.map((candidate) => `--${candidate}`);
  }
  if (similar.length > 1) {
    return `
(Did you mean one of ${similar.join(", ")}?)`;
  }
  if (similar.length === 1) {
    return `
(Did you mean ${similar[0]}?)`;
  }
  return "";
}

// node_modules/commander/lib/command.js
var Command = class _Command extends EventEmitter {
  /**
   * Initialize a new `Command`.
   *
   * @param {string} [name]
   */
  constructor(name) {
    super();
    this.commands = [];
    this.options = [];
    this.parent = null;
    this._allowUnknownOption = false;
    this._allowExcessArguments = false;
    this.registeredArguments = [];
    this._args = this.registeredArguments;
    this.args = [];
    this.rawArgs = [];
    this.processedArgs = [];
    this._scriptPath = null;
    this._name = name || "";
    this._optionValues = {};
    this._optionValueSources = {};
    this._storeOptionsAsProperties = false;
    this._actionHandler = null;
    this._executableHandler = false;
    this._executableFile = null;
    this._executableDir = null;
    this._defaultCommandName = null;
    this._exitCallback = null;
    this._aliases = [];
    this._combineFlagAndOptionalValue = true;
    this._description = "";
    this._summary = "";
    this._argsDescription = void 0;
    this._enablePositionalOptions = false;
    this._passThroughOptions = false;
    this._lifeCycleHooks = {};
    this._showHelpAfterError = false;
    this._showSuggestionAfterError = true;
    this._savedState = null;
    this._outputConfiguration = {
      writeOut: (str) => process2.stdout.write(str),
      writeErr: (str) => process2.stderr.write(str),
      outputError: (str, write) => write(str),
      getOutHelpWidth: () => process2.stdout.isTTY ? process2.stdout.columns : void 0,
      getErrHelpWidth: () => process2.stderr.isTTY ? process2.stderr.columns : void 0,
      getOutHasColors: () => useColor() ?? (process2.stdout.isTTY && process2.stdout.hasColors?.()),
      getErrHasColors: () => useColor() ?? (process2.stderr.isTTY && process2.stderr.hasColors?.()),
      stripColor: (str) => stripVTControlCharacters2(str)
    };
    this._hidden = false;
    this._helpOption = void 0;
    this._addImplicitHelpCommand = void 0;
    this._helpCommand = void 0;
    this._helpConfiguration = {};
    this._helpGroupHeading = void 0;
    this._defaultCommandGroup = void 0;
    this._defaultOptionGroup = void 0;
  }
  /**
   * Copy settings that are useful to have in common across root command and subcommands.
   *
   * (Used internally when adding a command using `.command()` so subcommands inherit parent settings.)
   *
   * @param {Command} sourceCommand
   * @return {Command} `this` command for chaining
   */
  copyInheritedSettings(sourceCommand) {
    this._outputConfiguration = sourceCommand._outputConfiguration;
    this._helpOption = sourceCommand._helpOption;
    this._helpCommand = sourceCommand._helpCommand;
    this._helpConfiguration = sourceCommand._helpConfiguration;
    this._exitCallback = sourceCommand._exitCallback;
    this._storeOptionsAsProperties = sourceCommand._storeOptionsAsProperties;
    this._combineFlagAndOptionalValue = sourceCommand._combineFlagAndOptionalValue;
    this._allowExcessArguments = sourceCommand._allowExcessArguments;
    this._enablePositionalOptions = sourceCommand._enablePositionalOptions;
    this._showHelpAfterError = sourceCommand._showHelpAfterError;
    this._showSuggestionAfterError = sourceCommand._showSuggestionAfterError;
    return this;
  }
  /**
   * @returns {Command[]}
   * @private
   */
  _getCommandAndAncestors() {
    const result = [];
    for (let command = this; command; command = command.parent) {
      result.push(command);
    }
    return result;
  }
  /**
   * Define a command.
   *
   * There are two styles of command: pay attention to where to put the description.
   *
   * @example
   * // Command implemented using action handler (description is supplied separately to `.command`)
   * program
   *   .command('clone <source> [destination]')
   *   .description('clone a repository into a newly created directory')
   *   .action((source, destination) => {
   *     console.log('clone command called');
   *   });
   *
   * // Command implemented using separate executable file (description is second parameter to `.command`)
   * program
   *   .command('start <service>', 'start named service')
   *   .command('stop [service]', 'stop named service, or all if no name supplied');
   *
   * @param {string} nameAndArgs - command name and arguments, args are `<required>` or `[optional]` and last may also be `variadic...`
   * @param {(object | string)} [actionOptsOrExecDesc] - configuration options (for action), or description (for executable)
   * @param {object} [execOpts] - configuration options (for executable)
   * @return {Command} returns new command for action handler, or `this` for executable command
   */
  command(nameAndArgs, actionOptsOrExecDesc, execOpts) {
    let desc = actionOptsOrExecDesc;
    let opts = execOpts;
    if (typeof desc === "object" && desc !== null) {
      opts = desc;
      desc = null;
    }
    opts = opts || {};
    const [, name, args] = nameAndArgs.match(/([^ ]+) *(.*)/);
    const cmd = this.createCommand(name);
    if (desc) {
      cmd.description(desc);
      cmd._executableHandler = true;
    }
    if (opts.isDefault) this._defaultCommandName = cmd._name;
    cmd._hidden = !!(opts.noHelp || opts.hidden);
    cmd._executableFile = opts.executableFile || null;
    if (args) cmd.arguments(args);
    this._registerCommand(cmd);
    cmd.parent = this;
    cmd.copyInheritedSettings(this);
    if (desc) return this;
    return cmd;
  }
  /**
   * Factory routine to create a new unattached command.
   *
   * See .command() for creating an attached subcommand, which uses this routine to
   * create the command. You can override createCommand to customise subcommands.
   *
   * @param {string} [name]
   * @return {Command} new command
   */
  createCommand(name) {
    return new _Command(name);
  }
  /**
   * You can customise the help with a subclass of Help by overriding createHelp,
   * or by overriding Help properties using configureHelp().
   *
   * @return {Help}
   */
  createHelp() {
    return Object.assign(new Help(), this.configureHelp());
  }
  /**
   * You can customise the help by overriding Help properties using configureHelp(),
   * or with a subclass of Help by overriding createHelp().
   *
   * @param {object} [configuration] - configuration options
   * @return {(Command | object)} `this` command for chaining, or stored configuration
   */
  configureHelp(configuration) {
    if (configuration === void 0) return this._helpConfiguration;
    this._helpConfiguration = configuration;
    return this;
  }
  /**
   * The default output goes to stdout and stderr. You can customise this for special
   * applications. You can also customise the display of errors by overriding outputError.
   *
   * The configuration properties are all functions:
   *
   *     // change how output being written, defaults to stdout and stderr
   *     writeOut(str)
   *     writeErr(str)
   *     // change how output being written for errors, defaults to writeErr
   *     outputError(str, write) // used for displaying errors and not used for displaying help
   *     // specify width for wrapping help
   *     getOutHelpWidth()
   *     getErrHelpWidth()
   *     // color support, currently only used with Help
   *     getOutHasColors()
   *     getErrHasColors()
   *     stripColor() // used to remove ANSI escape codes if output does not have colors
   *
   * @param {object} [configuration] - configuration options
   * @return {(Command | object)} `this` command for chaining, or stored configuration
   */
  configureOutput(configuration) {
    if (configuration === void 0) return this._outputConfiguration;
    this._outputConfiguration = {
      ...this._outputConfiguration,
      ...configuration
    };
    return this;
  }
  /**
   * Display the help or a custom message after an error occurs.
   *
   * @param {(boolean|string)} [displayHelp]
   * @return {Command} `this` command for chaining
   */
  showHelpAfterError(displayHelp = true) {
    if (typeof displayHelp !== "string") displayHelp = !!displayHelp;
    this._showHelpAfterError = displayHelp;
    return this;
  }
  /**
   * Display suggestion of similar commands for unknown commands, or options for unknown options.
   *
   * @param {boolean} [displaySuggestion]
   * @return {Command} `this` command for chaining
   */
  showSuggestionAfterError(displaySuggestion = true) {
    this._showSuggestionAfterError = !!displaySuggestion;
    return this;
  }
  /**
   * Add a prepared subcommand.
   *
   * See .command() for creating an attached subcommand which inherits settings from its parent.
   *
   * @param {Command} cmd - new subcommand
   * @param {object} [opts] - configuration options
   * @return {Command} `this` command for chaining
   */
  addCommand(cmd, opts) {
    if (!cmd._name) {
      throw new Error(`Command passed to .addCommand() must have a name
- specify the name in Command constructor or using .name()`);
    }
    opts = opts || {};
    if (opts.isDefault) this._defaultCommandName = cmd._name;
    if (opts.noHelp || opts.hidden) cmd._hidden = true;
    this._registerCommand(cmd);
    cmd.parent = this;
    cmd._checkForBrokenPassThrough();
    return this;
  }
  /**
   * Factory routine to create a new unattached argument.
   *
   * See .argument() for creating an attached argument, which uses this routine to
   * create the argument. You can override createArgument to return a custom argument.
   *
   * @param {string} name
   * @param {string} [description]
   * @return {Argument} new argument
   */
  createArgument(name, description) {
    return new Argument(name, description);
  }
  /**
   * Define argument syntax for command.
   *
   * The default is that the argument is required, and you can explicitly
   * indicate this with <> around the name. Put [] around the name for an optional argument.
   *
   * @example
   * program.argument('<input-file>');
   * program.argument('[output-file]');
   *
   * @param {string} name
   * @param {string} [description]
   * @param {(Function|*)} [parseArg] - custom argument processing function or default value
   * @param {*} [defaultValue]
   * @return {Command} `this` command for chaining
   */
  argument(name, description, parseArg, defaultValue) {
    const argument = this.createArgument(name, description);
    if (typeof parseArg === "function") {
      argument.default(defaultValue).argParser(parseArg);
    } else {
      argument.default(parseArg);
    }
    this.addArgument(argument);
    return this;
  }
  /**
   * Define argument syntax for command, adding multiple at once (without descriptions).
   *
   * See also .argument().
   *
   * @example
   * program.arguments('<cmd> [env]');
   *
   * @param {string} names
   * @return {Command} `this` command for chaining
   */
  arguments(names) {
    names.trim().split(/ +/).forEach((detail) => {
      this.argument(detail);
    });
    return this;
  }
  /**
   * Define argument syntax for command, adding a prepared argument.
   *
   * @param {Argument} argument
   * @return {Command} `this` command for chaining
   */
  addArgument(argument) {
    const previousArgument = this.registeredArguments.slice(-1)[0];
    if (previousArgument?.variadic) {
      throw new Error(
        `only the last argument can be variadic '${previousArgument.name()}'`
      );
    }
    if (argument.required && argument.defaultValue !== void 0 && argument.parseArg === void 0) {
      throw new Error(
        `a default value for a required argument is never used: '${argument.name()}'`
      );
    }
    this.registeredArguments.push(argument);
    return this;
  }
  /**
   * Customise or override default help command. By default a help command is automatically added if your command has subcommands.
   *
   * @example
   *    program.helpCommand('help [cmd]');
   *    program.helpCommand('help [cmd]', 'show help');
   *    program.helpCommand(false); // suppress default help command
   *    program.helpCommand(true); // add help command even if no subcommands
   *
   * @param {string|boolean} enableOrNameAndArgs - enable with custom name and/or arguments, or boolean to override whether added
   * @param {string} [description] - custom description
   * @return {Command} `this` command for chaining
   */
  helpCommand(enableOrNameAndArgs, description) {
    if (typeof enableOrNameAndArgs === "boolean") {
      this._addImplicitHelpCommand = enableOrNameAndArgs;
      if (enableOrNameAndArgs && this._defaultCommandGroup) {
        this._initCommandGroup(this._getHelpCommand());
      }
      return this;
    }
    const nameAndArgs = enableOrNameAndArgs ?? "help [command]";
    const [, helpName, helpArgs] = nameAndArgs.match(/([^ ]+) *(.*)/);
    const helpDescription = description ?? "display help for command";
    const helpCommand = this.createCommand(helpName);
    helpCommand.helpOption(false);
    if (helpArgs) helpCommand.arguments(helpArgs);
    if (helpDescription) helpCommand.description(helpDescription);
    this._addImplicitHelpCommand = true;
    this._helpCommand = helpCommand;
    if (enableOrNameAndArgs || description) this._initCommandGroup(helpCommand);
    return this;
  }
  /**
   * Add prepared custom help command.
   *
   * @param {(Command|string|boolean)} helpCommand - custom help command, or deprecated enableOrNameAndArgs as for `.helpCommand()`
   * @param {string} [deprecatedDescription] - deprecated custom description used with custom name only
   * @return {Command} `this` command for chaining
   */
  addHelpCommand(helpCommand, deprecatedDescription) {
    if (typeof helpCommand !== "object") {
      this.helpCommand(helpCommand, deprecatedDescription);
      return this;
    }
    this._addImplicitHelpCommand = true;
    this._helpCommand = helpCommand;
    this._initCommandGroup(helpCommand);
    return this;
  }
  /**
   * Lazy create help command.
   *
   * @return {(Command|null)}
   * @package
   */
  _getHelpCommand() {
    const hasImplicitHelpCommand = this._addImplicitHelpCommand ?? (this.commands.length && !this._actionHandler && !this._findCommand("help"));
    if (hasImplicitHelpCommand) {
      if (this._helpCommand === void 0) {
        this.helpCommand(void 0, void 0);
      }
      return this._helpCommand;
    }
    return null;
  }
  /**
   * Add hook for life cycle event.
   *
   * @param {string} event
   * @param {Function} listener
   * @return {Command} `this` command for chaining
   */
  hook(event, listener) {
    const allowedValues = ["preSubcommand", "preAction", "postAction"];
    if (!allowedValues.includes(event)) {
      throw new Error(`Unexpected value for event passed to hook : '${event}'.
Expecting one of '${allowedValues.join("', '")}'`);
    }
    if (this._lifeCycleHooks[event]) {
      this._lifeCycleHooks[event].push(listener);
    } else {
      this._lifeCycleHooks[event] = [listener];
    }
    return this;
  }
  /**
   * Register callback to use as replacement for calling process.exit.
   *
   * @param {Function} [fn] optional callback which will be passed a CommanderError, defaults to throwing
   * @return {Command} `this` command for chaining
   */
  exitOverride(fn) {
    if (fn) {
      this._exitCallback = fn;
    } else {
      this._exitCallback = (err) => {
        if (err.code !== "commander.executeSubCommandAsync") {
          throw err;
        } else {
        }
      };
    }
    return this;
  }
  /**
   * Call process.exit, and _exitCallback if defined.
   *
   * @param {number} exitCode exit code for using with process.exit
   * @param {string} code an id string representing the error
   * @param {string} message human-readable description of the error
   * @return never
   * @private
   */
  _exit(exitCode, code, message) {
    if (this._exitCallback) {
      this._exitCallback(new CommanderError(exitCode, code, message));
    }
    process2.exit(exitCode);
  }
  /**
   * Register callback `fn` for the command.
   *
   * @example
   * program
   *   .command('serve')
   *   .description('start service')
   *   .action(function() {
   *      // do work here
   *   });
   *
   * @param {Function} fn
   * @return {Command} `this` command for chaining
   */
  action(fn) {
    const listener = (args) => {
      const expectedArgsCount = this.registeredArguments.length;
      const actionArgs = args.slice(0, expectedArgsCount);
      if (this._storeOptionsAsProperties) {
        actionArgs[expectedArgsCount] = this;
      } else {
        actionArgs[expectedArgsCount] = this.opts();
      }
      actionArgs.push(this);
      return fn.apply(this, actionArgs);
    };
    this._actionHandler = listener;
    return this;
  }
  /**
   * Factory routine to create a new unattached option.
   *
   * See .option() for creating an attached option, which uses this routine to
   * create the option. You can override createOption to return a custom option.
   *
   * @param {string} flags
   * @param {string} [description]
   * @return {Option} new option
   */
  createOption(flags, description) {
    return new Option(flags, description);
  }
  /**
   * Wrap parseArgs to catch 'commander.invalidArgument'.
   *
   * @param {(Option | Argument)} target
   * @param {string} value
   * @param {*} previous
   * @param {string} invalidArgumentMessage
   * @private
   */
  _callParseArg(target, value, previous, invalidArgumentMessage) {
    try {
      return target.parseArg(value, previous);
    } catch (err) {
      if (err.code === "commander.invalidArgument") {
        const message = `${invalidArgumentMessage} ${err.message}`;
        this.error(message, { exitCode: err.exitCode, code: err.code });
      }
      throw err;
    }
  }
  /**
   * Check for option flag conflicts.
   * Register option if no conflicts found, or throw on conflict.
   *
   * @param {Option} option
   * @private
   */
  _registerOption(option) {
    const matchingOption = option.short && this._findOption(option.short) || option.long && this._findOption(option.long);
    if (matchingOption) {
      const matchingFlag = option.long && this._findOption(option.long) ? option.long : option.short;
      throw new Error(`Cannot add option '${option.flags}'${this._name && ` to command '${this._name}'`} due to conflicting flag '${matchingFlag}'
-  already used by option '${matchingOption.flags}'`);
    }
    this._initOptionGroup(option);
    this.options.push(option);
  }
  /**
   * Check for command name and alias conflicts with existing commands.
   * Register command if no conflicts found, or throw on conflict.
   *
   * @param {Command} command
   * @private
   */
  _registerCommand(command) {
    const knownBy = (cmd) => {
      return [cmd.name()].concat(cmd.aliases());
    };
    const alreadyUsed = knownBy(command).find(
      (name) => this._findCommand(name)
    );
    if (alreadyUsed) {
      const existingCmd = knownBy(this._findCommand(alreadyUsed)).join("|");
      const newCmd = knownBy(command).join("|");
      throw new Error(
        `cannot add command '${newCmd}' as already have command '${existingCmd}'`
      );
    }
    this._initCommandGroup(command);
    this.commands.push(command);
  }
  /**
   * Add an option.
   *
   * @param {Option} option
   * @return {Command} `this` command for chaining
   */
  addOption(option) {
    this._registerOption(option);
    const oname = option.name();
    const name = option.attributeName();
    if (option.defaultValue !== void 0) {
      this.setOptionValueWithSource(name, option.defaultValue, "default");
    }
    const handleOptionValue = (val, invalidValueMessage, valueSource) => {
      if (val == null && option.presetArg !== void 0) {
        val = option.presetArg;
      }
      const oldValue = this.getOptionValue(name);
      if (val !== null && option.parseArg) {
        val = this._callParseArg(option, val, oldValue, invalidValueMessage);
      } else if (val !== null && option.variadic) {
        val = option._collectValue(val, oldValue);
      }
      if (val == null) {
        if (option.negate) {
          val = false;
        } else if (option.isBoolean() || option.optional) {
          val = true;
        } else {
          val = "";
        }
      }
      this.setOptionValueWithSource(name, val, valueSource);
    };
    this.on("option:" + oname, (val) => {
      const invalidValueMessage = `error: option '${option.flags}' argument '${val}' is invalid.`;
      handleOptionValue(val, invalidValueMessage, "cli");
    });
    if (option.envVar) {
      this.on("optionEnv:" + oname, (val) => {
        const invalidValueMessage = `error: option '${option.flags}' value '${val}' from env '${option.envVar}' is invalid.`;
        handleOptionValue(val, invalidValueMessage, "env");
      });
    }
    return this;
  }
  /**
   * Internal implementation shared by .option() and .requiredOption()
   *
   * @return {Command} `this` command for chaining
   * @private
   */
  _optionEx(config, flags, description, fn, defaultValue) {
    if (typeof flags === "object" && flags instanceof Option) {
      throw new Error(
        "To add an Option object use addOption() instead of option() or requiredOption()"
      );
    }
    const option = this.createOption(flags, description);
    option.makeOptionMandatory(!!config.mandatory);
    if (typeof fn === "function") {
      option.default(defaultValue).argParser(fn);
    } else if (fn instanceof RegExp) {
      const regex = fn;
      fn = (val, def) => {
        const m = regex.exec(val);
        return m ? m[0] : def;
      };
      option.default(defaultValue).argParser(fn);
    } else {
      option.default(fn);
    }
    return this.addOption(option);
  }
  /**
   * Define option with `flags`, `description`, and optional argument parsing function or `defaultValue` or both.
   *
   * The `flags` string contains the short and/or long flags, separated by comma, a pipe or space. A required
   * option-argument is indicated by `<>` and an optional option-argument by `[]`.
   *
   * See the README for more details, and see also addOption() and requiredOption().
   *
   * @example
   * program
   *     .option('-p, --pepper', 'add pepper')
   *     .option('--pt, --pizza-type <TYPE>', 'type of pizza') // required option-argument
   *     .option('-c, --cheese [CHEESE]', 'add extra cheese', 'mozzarella') // optional option-argument with default
   *     .option('-t, --tip <VALUE>', 'add tip to purchase cost', parseFloat) // custom parse function
   *
   * @param {string} flags
   * @param {string} [description]
   * @param {(Function|*)} [parseArg] - custom option processing function or default value
   * @param {*} [defaultValue]
   * @return {Command} `this` command for chaining
   */
  option(flags, description, parseArg, defaultValue) {
    return this._optionEx({}, flags, description, parseArg, defaultValue);
  }
  /**
   * Add a required option which must have a value after parsing. This usually means
   * the option must be specified on the command line. (Otherwise the same as .option().)
   *
   * The `flags` string contains the short and/or long flags, separated by comma, a pipe or space.
   *
   * @param {string} flags
   * @param {string} [description]
   * @param {(Function|*)} [parseArg] - custom option processing function or default value
   * @param {*} [defaultValue]
   * @return {Command} `this` command for chaining
   */
  requiredOption(flags, description, parseArg, defaultValue) {
    return this._optionEx(
      { mandatory: true },
      flags,
      description,
      parseArg,
      defaultValue
    );
  }
  /**
   * Alter parsing of short flags with optional values.
   *
   * @example
   * // for `.option('-f,--flag [value]'):
   * program.combineFlagAndOptionalValue(true);  // `-f80` is treated like `--flag=80`, this is the default behaviour
   * program.combineFlagAndOptionalValue(false) // `-fb` is treated like `-f -b`
   *
   * @param {boolean} [combine] - if `true` or omitted, an optional value can be specified directly after the flag.
   * @return {Command} `this` command for chaining
   */
  combineFlagAndOptionalValue(combine = true) {
    this._combineFlagAndOptionalValue = !!combine;
    return this;
  }
  /**
   * Allow unknown options on the command line.
   *
   * @param {boolean} [allowUnknown] - if `true` or omitted, no error will be thrown for unknown options.
   * @return {Command} `this` command for chaining
   */
  allowUnknownOption(allowUnknown = true) {
    this._allowUnknownOption = !!allowUnknown;
    return this;
  }
  /**
   * Allow excess command-arguments on the command line. Pass false to make excess arguments an error.
   *
   * @param {boolean} [allowExcess] - if `true` or omitted, no error will be thrown for excess arguments.
   * @return {Command} `this` command for chaining
   */
  allowExcessArguments(allowExcess = true) {
    this._allowExcessArguments = !!allowExcess;
    return this;
  }
  /**
   * Enable positional options. Positional means global options are specified before subcommands which lets
   * subcommands reuse the same option names, and also enables subcommands to turn on passThroughOptions.
   * The default behaviour is non-positional and global options may appear anywhere on the command line.
   *
   * @param {boolean} [positional]
   * @return {Command} `this` command for chaining
   */
  enablePositionalOptions(positional = true) {
    this._enablePositionalOptions = !!positional;
    return this;
  }
  /**
   * Pass through options that come after command-arguments rather than treat them as command-options,
   * so actual command-options come before command-arguments. Turning this on for a subcommand requires
   * positional options to have been enabled on the program (parent commands).
   * The default behaviour is non-positional and options may appear before or after command-arguments.
   *
   * @param {boolean} [passThrough] for unknown options.
   * @return {Command} `this` command for chaining
   */
  passThroughOptions(passThrough = true) {
    this._passThroughOptions = !!passThrough;
    this._checkForBrokenPassThrough();
    return this;
  }
  /**
   * @private
   */
  _checkForBrokenPassThrough() {
    if (this.parent && this._passThroughOptions && !this.parent._enablePositionalOptions) {
      throw new Error(
        `passThroughOptions cannot be used for '${this._name}' without turning on enablePositionalOptions for parent command(s)`
      );
    }
  }
  /**
   * Whether to store option values as properties on command object,
   * or store separately (specify false). In both cases the option values can be accessed using .opts().
   *
   * @param {boolean} [storeAsProperties=true]
   * @return {Command} `this` command for chaining
   */
  storeOptionsAsProperties(storeAsProperties = true) {
    if (this.options.length) {
      throw new Error("call .storeOptionsAsProperties() before adding options");
    }
    if (Object.keys(this._optionValues).length) {
      throw new Error(
        "call .storeOptionsAsProperties() before setting option values"
      );
    }
    this._storeOptionsAsProperties = !!storeAsProperties;
    return this;
  }
  /**
   * Retrieve option value.
   *
   * @param {string} key
   * @return {object} value
   */
  getOptionValue(key) {
    if (this._storeOptionsAsProperties) {
      return this[key];
    }
    return this._optionValues[key];
  }
  /**
   * Store option value.
   *
   * @param {string} key
   * @param {object} value
   * @return {Command} `this` command for chaining
   */
  setOptionValue(key, value) {
    return this.setOptionValueWithSource(key, value, void 0);
  }
  /**
   * Store option value and where the value came from.
   *
   * @param {string} key
   * @param {object} value
   * @param {string} source - expected values are default/config/env/cli/implied
   * @return {Command} `this` command for chaining
   */
  setOptionValueWithSource(key, value, source) {
    if (this._storeOptionsAsProperties) {
      this[key] = value;
    } else {
      this._optionValues[key] = value;
    }
    this._optionValueSources[key] = source;
    return this;
  }
  /**
   * Get source of option value.
   * Expected values are default | config | env | cli | implied
   *
   * @param {string} key
   * @return {string}
   */
  getOptionValueSource(key) {
    return this._optionValueSources[key];
  }
  /**
   * Get source of option value. See also .optsWithGlobals().
   * Expected values are default | config | env | cli | implied
   *
   * @param {string} key
   * @return {string}
   */
  getOptionValueSourceWithGlobals(key) {
    let source;
    this._getCommandAndAncestors().forEach((cmd) => {
      if (cmd.getOptionValueSource(key) !== void 0) {
        source = cmd.getOptionValueSource(key);
      }
    });
    return source;
  }
  /**
   * Get user arguments from implied or explicit arguments.
   * Side-effects: set _scriptPath if args included script. Used for default program name, and subcommand searches.
   *
   * @private
   */
  _prepareUserArgs(argv, parseOptions) {
    if (argv !== void 0 && !Array.isArray(argv)) {
      throw new Error("first parameter to parse must be array or undefined");
    }
    parseOptions = parseOptions || {};
    if (argv === void 0 && parseOptions.from === void 0) {
      if (process2.versions?.electron) {
        parseOptions.from = "electron";
      }
      const execArgv = process2.execArgv ?? [];
      if (execArgv.includes("-e") || execArgv.includes("--eval") || execArgv.includes("-p") || execArgv.includes("--print")) {
        parseOptions.from = "eval";
      }
    }
    if (argv === void 0) {
      argv = process2.argv;
    }
    this.rawArgs = argv.slice();
    let userArgs;
    switch (parseOptions.from) {
      case void 0:
      case "node":
        this._scriptPath = argv[1];
        userArgs = argv.slice(2);
        break;
      case "electron":
        if (process2.defaultApp) {
          this._scriptPath = argv[1];
          userArgs = argv.slice(2);
        } else {
          userArgs = argv.slice(1);
        }
        break;
      case "user":
        userArgs = argv.slice(0);
        break;
      case "eval":
        userArgs = argv.slice(1);
        break;
      default:
        throw new Error(
          `unexpected parse option { from: '${parseOptions.from}' }`
        );
    }
    if (!this._name && this._scriptPath)
      this.nameFromFilename(this._scriptPath);
    this._name = this._name || "program";
    return userArgs;
  }
  /**
   * Parse `argv`, setting options and invoking commands when defined.
   *
   * Use parseAsync instead of parse if any of your action handlers are async.
   *
   * Call with no parameters to parse `process.argv`. Detects Electron and special node options like `node --eval`. Easy mode!
   *
   * Or call with an array of strings to parse, and optionally where the user arguments start by specifying where the arguments are `from`:
   * - `'node'`: default, `argv[0]` is the application and `argv[1]` is the script being run, with user arguments after that
   * - `'electron'`: `argv[0]` is the application and `argv[1]` varies depending on whether the electron application is packaged
   * - `'user'`: just user arguments
   *
   * @example
   * program.parse(); // parse process.argv and auto-detect electron and special node flags
   * program.parse(process.argv); // assume argv[0] is app and argv[1] is script
   * program.parse(my-args, { from: 'user' }); // just user supplied arguments, nothing special about argv[0]
   *
   * @param {string[]} [argv] - optional, defaults to process.argv
   * @param {object} [parseOptions] - optionally specify style of options with from: node/user/electron
   * @param {string} [parseOptions.from] - where the args are from: 'node', 'user', 'electron'
   * @return {Command} `this` command for chaining
   */
  parse(argv, parseOptions) {
    this._prepareForParse();
    const userArgs = this._prepareUserArgs(argv, parseOptions);
    this._parseCommand([], userArgs);
    return this;
  }
  /**
   * Parse `argv`, setting options and invoking commands when defined.
   *
   * Call with no parameters to parse `process.argv`. Detects Electron and special node options like `node --eval`. Easy mode!
   *
   * Or call with an array of strings to parse, and optionally where the user arguments start by specifying where the arguments are `from`:
   * - `'node'`: default, `argv[0]` is the application and `argv[1]` is the script being run, with user arguments after that
   * - `'electron'`: `argv[0]` is the application and `argv[1]` varies depending on whether the electron application is packaged
   * - `'user'`: just user arguments
   *
   * @example
   * await program.parseAsync(); // parse process.argv and auto-detect electron and special node flags
   * await program.parseAsync(process.argv); // assume argv[0] is app and argv[1] is script
   * await program.parseAsync(my-args, { from: 'user' }); // just user supplied arguments, nothing special about argv[0]
   *
   * @param {string[]} [argv]
   * @param {object} [parseOptions]
   * @param {string} parseOptions.from - where the args are from: 'node', 'user', 'electron'
   * @return {Promise}
   */
  async parseAsync(argv, parseOptions) {
    this._prepareForParse();
    const userArgs = this._prepareUserArgs(argv, parseOptions);
    await this._parseCommand([], userArgs);
    return this;
  }
  _prepareForParse() {
    if (this._savedState === null) {
      this.options.filter(
        (option) => option.negate && option.defaultValue === void 0 && this.getOptionValue(option.attributeName()) === void 0
      ).forEach((option) => {
        const positiveLongFlag = option.long.replace(/^--no-/, "--");
        if (!this._findOption(positiveLongFlag)) {
          this.setOptionValueWithSource(
            option.attributeName(),
            true,
            "default"
          );
        }
      });
      this.saveStateBeforeParse();
    } else {
      this.restoreStateBeforeParse();
    }
  }
  /**
   * Called the first time parse is called to save state and allow a restore before subsequent calls to parse.
   * Not usually called directly, but available for subclasses to save their custom state.
   *
   * This is called in a lazy way. Only commands used in parsing chain will have state saved.
   */
  saveStateBeforeParse() {
    this._savedState = {
      // name is stable if supplied by author, but may be unspecified for root command and deduced during parsing
      _name: this._name,
      // option values before parse have default values (including false for negated options)
      // shallow clones
      _optionValues: { ...this._optionValues },
      _optionValueSources: { ...this._optionValueSources }
    };
  }
  /**
   * Restore state before parse for calls after the first.
   * Not usually called directly, but available for subclasses to save their custom state.
   *
   * This is called in a lazy way. Only commands used in parsing chain will have state restored.
   */
  restoreStateBeforeParse() {
    if (this._storeOptionsAsProperties)
      throw new Error(`Can not call parse again when storeOptionsAsProperties is true.
- either make a new Command for each call to parse, or stop storing options as properties`);
    this._name = this._savedState._name;
    this._scriptPath = null;
    this.rawArgs = [];
    this._optionValues = { ...this._savedState._optionValues };
    this._optionValueSources = { ...this._savedState._optionValueSources };
    this.args = [];
    this.processedArgs = [];
  }
  /**
   * Throw if expected executable is missing. Add lots of help for author.
   *
   * @param {string} executableFile
   * @param {string} executableDir
   * @param {string} subcommandName
   */
  _checkForMissingExecutable(executableFile, executableDir, subcommandName) {
    if (fs.existsSync(executableFile)) return;
    const executableDirMessage = executableDir ? `searched for local subcommand relative to directory '${executableDir}'` : "no directory for search for local subcommand, use .executableDir() to supply a custom directory";
    const executableMissing = `'${executableFile}' does not exist
 - if '${subcommandName}' is not meant to be an executable command, remove description parameter from '.command()' and use '.description()' instead
 - if the default executable name is not suitable, use the executableFile option to supply a custom name or path
 - ${executableDirMessage}`;
    throw new Error(executableMissing);
  }
  /**
   * Execute a sub-command executable.
   *
   * @private
   */
  _executeSubCommand(subcommand, args) {
    args = args.slice();
    const sourceExt = [".js", ".ts", ".tsx", ".mjs", ".cjs"];
    function findFile(baseDir, baseName) {
      const localBin = path.resolve(baseDir, baseName);
      if (fs.existsSync(localBin)) return localBin;
      if (sourceExt.includes(path.extname(baseName))) return void 0;
      const foundExt = sourceExt.find(
        (ext) => fs.existsSync(`${localBin}${ext}`)
      );
      if (foundExt) return `${localBin}${foundExt}`;
      return void 0;
    }
    this._checkForMissingMandatoryOptions();
    this._checkForConflictingOptions();
    let executableFile = subcommand._executableFile || `${this._name}-${subcommand._name}`;
    let executableDir = this._executableDir || "";
    if (this._scriptPath) {
      let resolvedScriptPath;
      try {
        resolvedScriptPath = fs.realpathSync(this._scriptPath);
      } catch {
        resolvedScriptPath = this._scriptPath;
      }
      executableDir = path.resolve(
        path.dirname(resolvedScriptPath),
        executableDir
      );
    }
    if (executableDir) {
      let localFile = findFile(executableDir, executableFile);
      if (!localFile && !subcommand._executableFile && this._scriptPath) {
        const legacyName = path.basename(
          this._scriptPath,
          path.extname(this._scriptPath)
        );
        if (legacyName !== this._name) {
          localFile = findFile(
            executableDir,
            `${legacyName}-${subcommand._name}`
          );
        }
      }
      executableFile = localFile || executableFile;
    }
    const launchWithNode = sourceExt.includes(path.extname(executableFile));
    let proc;
    if (process2.platform !== "win32") {
      if (launchWithNode) {
        args.unshift(executableFile);
        args = incrementNodeInspectorPort(process2.execArgv).concat(args);
        proc = childProcess.spawn(process2.argv[0], args, { stdio: "inherit" });
      } else {
        proc = childProcess.spawn(executableFile, args, { stdio: "inherit" });
      }
    } else {
      this._checkForMissingExecutable(
        executableFile,
        executableDir,
        subcommand._name
      );
      args.unshift(executableFile);
      args = incrementNodeInspectorPort(process2.execArgv).concat(args);
      proc = childProcess.spawn(process2.execPath, args, { stdio: "inherit" });
    }
    if (!proc.killed) {
      const signals = ["SIGUSR1", "SIGUSR2", "SIGTERM", "SIGINT", "SIGHUP"];
      signals.forEach((signal) => {
        process2.on(signal, () => {
          if (proc.killed === false && proc.exitCode === null) {
            proc.kill(signal);
          }
        });
      });
    }
    const exitCallback = this._exitCallback;
    proc.on("close", (code) => {
      code = code ?? 1;
      if (!exitCallback) {
        process2.exit(code);
      } else {
        exitCallback(
          new CommanderError(
            code,
            "commander.executeSubCommandAsync",
            "(close)"
          )
        );
      }
    });
    proc.on("error", (err) => {
      if (err.code === "ENOENT") {
        this._checkForMissingExecutable(
          executableFile,
          executableDir,
          subcommand._name
        );
      } else if (err.code === "EACCES") {
        throw new Error(`'${executableFile}' not executable`);
      }
      if (!exitCallback) {
        process2.exit(1);
      } else {
        const wrappedError = new CommanderError(
          1,
          "commander.executeSubCommandAsync",
          "(error)"
        );
        wrappedError.nestedError = err;
        exitCallback(wrappedError);
      }
    });
    this.runningCommand = proc;
  }
  /**
   * @private
   */
  _dispatchSubcommand(commandName, operands, unknown) {
    const subCommand = this._findCommand(commandName);
    if (!subCommand) this.help({ error: true });
    subCommand._prepareForParse();
    let promiseChain;
    promiseChain = this._chainOrCallSubCommandHook(
      promiseChain,
      subCommand,
      "preSubcommand"
    );
    promiseChain = this._chainOrCall(promiseChain, () => {
      if (subCommand._executableHandler) {
        this._executeSubCommand(subCommand, operands.concat(unknown));
      } else {
        return subCommand._parseCommand(operands, unknown);
      }
    });
    return promiseChain;
  }
  /**
   * Invoke help directly if possible, or dispatch if necessary.
   * e.g. help foo
   *
   * @private
   */
  _dispatchHelpCommand(subcommandName) {
    if (!subcommandName) {
      this.help();
    }
    const subCommand = this._findCommand(subcommandName);
    if (subCommand && !subCommand._executableHandler) {
      subCommand.help();
    }
    return this._dispatchSubcommand(
      subcommandName,
      [],
      [this._getHelpOption()?.long ?? this._getHelpOption()?.short ?? "--help"]
    );
  }
  /**
   * Check this.args against expected this.registeredArguments.
   *
   * @private
   */
  _checkNumberOfArguments() {
    this.registeredArguments.forEach((arg, i) => {
      if (arg.required && this.args[i] == null) {
        this.missingArgument(arg.name());
      }
    });
    if (this.registeredArguments.length > 0 && this.registeredArguments[this.registeredArguments.length - 1].variadic) {
      return;
    }
    if (this.args.length > this.registeredArguments.length) {
      this._excessArguments(this.args);
    }
  }
  /**
   * Process this.args using this.registeredArguments and save as this.processedArgs!
   *
   * @private
   */
  _processArguments() {
    const myParseArg = (argument, value, previous) => {
      let parsedValue = value;
      if (value !== null && argument.parseArg) {
        const invalidValueMessage = `error: command-argument value '${value}' is invalid for argument '${argument.name()}'.`;
        parsedValue = this._callParseArg(
          argument,
          value,
          previous,
          invalidValueMessage
        );
      }
      return parsedValue;
    };
    this._checkNumberOfArguments();
    const processedArgs = [];
    this.registeredArguments.forEach((declaredArg, index) => {
      let value = declaredArg.defaultValue;
      if (declaredArg.variadic) {
        if (index < this.args.length) {
          value = this.args.slice(index);
          if (declaredArg.parseArg) {
            value = value.reduce((processed, v) => {
              return myParseArg(declaredArg, v, processed);
            }, declaredArg.defaultValue);
          }
        } else if (value === void 0) {
          value = [];
        }
      } else if (index < this.args.length) {
        value = this.args[index];
        if (declaredArg.parseArg) {
          value = myParseArg(declaredArg, value, declaredArg.defaultValue);
        }
      }
      processedArgs[index] = value;
    });
    this.processedArgs = processedArgs;
  }
  /**
   * Once we have a promise we chain, but call synchronously until then.
   *
   * @param {(Promise|undefined)} promise
   * @param {Function} fn
   * @return {(Promise|undefined)}
   * @private
   */
  _chainOrCall(promise, fn) {
    if (promise?.then && typeof promise.then === "function") {
      return promise.then(() => fn());
    }
    return fn();
  }
  /**
   *
   * @param {(Promise|undefined)} promise
   * @param {string} event
   * @return {(Promise|undefined)}
   * @private
   */
  _chainOrCallHooks(promise, event) {
    let result = promise;
    const hooks = [];
    this._getCommandAndAncestors().reverse().filter((cmd) => cmd._lifeCycleHooks[event] !== void 0).forEach((hookedCommand) => {
      hookedCommand._lifeCycleHooks[event].forEach((callback) => {
        hooks.push({ hookedCommand, callback });
      });
    });
    if (event === "postAction") {
      hooks.reverse();
    }
    hooks.forEach((hookDetail) => {
      result = this._chainOrCall(result, () => {
        return hookDetail.callback(hookDetail.hookedCommand, this);
      });
    });
    return result;
  }
  /**
   *
   * @param {(Promise|undefined)} promise
   * @param {Command} subCommand
   * @param {string} event
   * @return {(Promise|undefined)}
   * @private
   */
  _chainOrCallSubCommandHook(promise, subCommand, event) {
    let result = promise;
    if (this._lifeCycleHooks[event] !== void 0) {
      this._lifeCycleHooks[event].forEach((hook) => {
        result = this._chainOrCall(result, () => {
          return hook(this, subCommand);
        });
      });
    }
    return result;
  }
  /**
   * Process arguments in context of this command.
   * Returns action result, in case it is a promise.
   *
   * @private
   */
  _parseCommand(operands, unknown) {
    const parsed = this.parseOptions(unknown);
    this._parseOptionsEnv();
    this._parseOptionsImplied();
    operands = operands.concat(parsed.operands);
    unknown = parsed.unknown;
    this.args = operands.concat(unknown);
    if (operands && this._findCommand(operands[0])) {
      return this._dispatchSubcommand(operands[0], operands.slice(1), unknown);
    }
    if (this._getHelpCommand() && operands[0] === this._getHelpCommand().name()) {
      return this._dispatchHelpCommand(operands[1]);
    }
    if (this._defaultCommandName) {
      this._outputHelpIfRequested(unknown);
      return this._dispatchSubcommand(
        this._defaultCommandName,
        operands,
        unknown
      );
    }
    if (this.commands.length && this.args.length === 0 && !this._actionHandler && !this._defaultCommandName) {
      this.help({ error: true });
    }
    this._outputHelpIfRequested(parsed.unknown);
    this._checkForMissingMandatoryOptions();
    this._checkForConflictingOptions();
    const checkForUnknownOptions = () => {
      if (parsed.unknown.length > 0) {
        this.unknownOption(parsed.unknown[0]);
      }
    };
    const commandEvent = `command:${this.name()}`;
    if (this._actionHandler) {
      checkForUnknownOptions();
      this._processArguments();
      let promiseChain;
      promiseChain = this._chainOrCallHooks(promiseChain, "preAction");
      promiseChain = this._chainOrCall(
        promiseChain,
        () => this._actionHandler(this.processedArgs)
      );
      if (this.parent) {
        promiseChain = this._chainOrCall(promiseChain, () => {
          this.parent.emit(commandEvent, operands, unknown);
        });
      }
      promiseChain = this._chainOrCallHooks(promiseChain, "postAction");
      return promiseChain;
    }
    if (this.parent?.listenerCount(commandEvent)) {
      checkForUnknownOptions();
      this._processArguments();
      this.parent.emit(commandEvent, operands, unknown);
    } else if (operands.length) {
      if (this._findCommand("*")) {
        return this._dispatchSubcommand("*", operands, unknown);
      }
      if (this.listenerCount("command:*")) {
        this.emit("command:*", operands, unknown);
      } else if (this.commands.length) {
        this.unknownCommand();
      } else {
        checkForUnknownOptions();
        this._processArguments();
      }
    } else if (this.commands.length) {
      checkForUnknownOptions();
      this.help({ error: true });
    } else {
      checkForUnknownOptions();
      this._processArguments();
    }
  }
  /**
   * Find matching command.
   *
   * @private
   * @return {Command | undefined}
   */
  _findCommand(name) {
    if (!name) return void 0;
    return this.commands.find(
      (cmd) => cmd._name === name || cmd._aliases.includes(name)
    );
  }
  /**
   * Return an option matching `arg` if any.
   *
   * @param {string} arg
   * @return {Option}
   * @package
   */
  _findOption(arg) {
    return this.options.find((option) => option.is(arg));
  }
  /**
   * Display an error message if a mandatory option does not have a value.
   * Called after checking for help flags in leaf subcommand.
   *
   * @private
   */
  _checkForMissingMandatoryOptions() {
    this._getCommandAndAncestors().forEach((cmd) => {
      cmd.options.forEach((anOption) => {
        if (anOption.mandatory && cmd.getOptionValue(anOption.attributeName()) === void 0) {
          cmd.missingMandatoryOptionValue(anOption);
        }
      });
    });
  }
  /**
   * Display an error message if conflicting options are used together in this.
   *
   * @private
   */
  _checkForConflictingLocalOptions() {
    const definedNonDefaultOptions = this.options.filter((option) => {
      const optionKey = option.attributeName();
      if (this.getOptionValue(optionKey) === void 0) {
        return false;
      }
      return this.getOptionValueSource(optionKey) !== "default";
    });
    const optionsWithConflicting = definedNonDefaultOptions.filter(
      (option) => option.conflictsWith.length > 0
    );
    optionsWithConflicting.forEach((option) => {
      const conflictingAndDefined = definedNonDefaultOptions.find(
        (defined) => option.conflictsWith.includes(defined.attributeName())
      );
      if (conflictingAndDefined) {
        this._conflictingOption(option, conflictingAndDefined);
      }
    });
  }
  /**
   * Display an error message if conflicting options are used together.
   * Called after checking for help flags in leaf subcommand.
   *
   * @private
   */
  _checkForConflictingOptions() {
    this._getCommandAndAncestors().forEach((cmd) => {
      cmd._checkForConflictingLocalOptions();
    });
  }
  /**
   * Parse options from `argv` removing known options,
   * and return argv split into operands and unknown arguments.
   *
   * Side effects: modifies command by storing options. Does not reset state if called again.
   *
   * Examples:
   *
   *     argv => operands, unknown
   *     --known kkk op => [op], []
   *     op --known kkk => [op], []
   *     sub --unknown uuu op => [sub], [--unknown uuu op]
   *     sub -- --unknown uuu op => [sub --unknown uuu op], []
   *
   * @param {string[]} args
   * @return {{operands: string[], unknown: string[]}}
   */
  parseOptions(args) {
    const operands = [];
    const unknown = [];
    let dest = operands;
    function maybeOption(arg) {
      return arg.length > 1 && arg[0] === "-";
    }
    const negativeNumberArg = (arg) => {
      if (!/^-(\d+|\d*\.\d+)(e[+-]?\d+)?$/.test(arg)) return false;
      return !this._getCommandAndAncestors().some(
        (cmd) => cmd.options.map((opt) => opt.short).some((short) => /^-\d$/.test(short))
      );
    };
    let activeVariadicOption = null;
    let activeGroup = null;
    let i = 0;
    while (i < args.length || activeGroup) {
      const arg = activeGroup ?? args[i++];
      activeGroup = null;
      if (arg === "--") {
        if (dest === unknown) dest.push(arg);
        dest.push(...args.slice(i));
        break;
      }
      if (activeVariadicOption && (!maybeOption(arg) || negativeNumberArg(arg))) {
        this.emit(`option:${activeVariadicOption.name()}`, arg);
        continue;
      }
      activeVariadicOption = null;
      if (maybeOption(arg)) {
        const option = this._findOption(arg);
        if (option) {
          if (option.required) {
            const value = args[i++];
            if (value === void 0) this.optionMissingArgument(option);
            this.emit(`option:${option.name()}`, value);
          } else if (option.optional) {
            let value = null;
            if (i < args.length && (!maybeOption(args[i]) || negativeNumberArg(args[i]))) {
              value = args[i++];
            }
            this.emit(`option:${option.name()}`, value);
          } else {
            this.emit(`option:${option.name()}`);
          }
          activeVariadicOption = option.variadic ? option : null;
          continue;
        }
      }
      if (arg.length > 2 && arg[0] === "-" && arg[1] !== "-") {
        const option = this._findOption(`-${arg[1]}`);
        if (option) {
          if (option.required || option.optional && this._combineFlagAndOptionalValue) {
            this.emit(`option:${option.name()}`, arg.slice(2));
          } else {
            this.emit(`option:${option.name()}`);
            activeGroup = `-${arg.slice(2)}`;
          }
          continue;
        }
      }
      if (/^--[^=]+=/.test(arg)) {
        const index = arg.indexOf("=");
        const option = this._findOption(arg.slice(0, index));
        if (option && (option.required || option.optional)) {
          this.emit(`option:${option.name()}`, arg.slice(index + 1));
          continue;
        }
      }
      if (dest === operands && maybeOption(arg) && !(this.commands.length === 0 && negativeNumberArg(arg))) {
        dest = unknown;
      }
      if ((this._enablePositionalOptions || this._passThroughOptions) && operands.length === 0 && unknown.length === 0) {
        if (this._findCommand(arg)) {
          operands.push(arg);
          unknown.push(...args.slice(i));
          break;
        } else if (this._getHelpCommand() && arg === this._getHelpCommand().name()) {
          operands.push(arg, ...args.slice(i));
          break;
        } else if (this._defaultCommandName) {
          unknown.push(arg, ...args.slice(i));
          break;
        }
      }
      if (this._passThroughOptions) {
        dest.push(arg, ...args.slice(i));
        break;
      }
      dest.push(arg);
    }
    return { operands, unknown };
  }
  /**
   * Return an object containing local option values as key-value pairs.
   *
   * @return {object}
   */
  opts() {
    if (this._storeOptionsAsProperties) {
      const result = {};
      const len = this.options.length;
      for (let i = 0; i < len; i++) {
        const key = this.options[i].attributeName();
        result[key] = key === this._versionOptionName ? this._version : this[key];
      }
      return result;
    }
    return this._optionValues;
  }
  /**
   * Return an object containing merged local and global option values as key-value pairs.
   *
   * @return {object}
   */
  optsWithGlobals() {
    return this._getCommandAndAncestors().reduce(
      (combinedOptions, cmd) => Object.assign(combinedOptions, cmd.opts()),
      {}
    );
  }
  /**
   * Display error message and exit (or call exitOverride).
   *
   * @param {string} message
   * @param {object} [errorOptions]
   * @param {string} [errorOptions.code] - an id string representing the error
   * @param {number} [errorOptions.exitCode] - used with process.exit
   */
  error(message, errorOptions) {
    this._outputConfiguration.outputError(
      `${message}
`,
      this._outputConfiguration.writeErr
    );
    if (typeof this._showHelpAfterError === "string") {
      this._outputConfiguration.writeErr(`${this._showHelpAfterError}
`);
    } else if (this._showHelpAfterError) {
      this._outputConfiguration.writeErr("\n");
      this.outputHelp({ error: true });
    }
    const config = errorOptions || {};
    const exitCode = config.exitCode || 1;
    const code = config.code || "commander.error";
    this._exit(exitCode, code, message);
  }
  /**
   * Apply any option related environment variables, if option does
   * not have a value from cli or client code.
   *
   * @private
   */
  _parseOptionsEnv() {
    this.options.forEach((option) => {
      if (option.envVar && option.envVar in process2.env) {
        const optionKey = option.attributeName();
        if (this.getOptionValue(optionKey) === void 0 || ["default", "config", "env"].includes(
          this.getOptionValueSource(optionKey)
        )) {
          if (option.required || option.optional) {
            this.emit(`optionEnv:${option.name()}`, process2.env[option.envVar]);
          } else {
            this.emit(`optionEnv:${option.name()}`);
          }
        }
      }
    });
  }
  /**
   * Apply any implied option values, if option is undefined or default value.
   *
   * @private
   */
  _parseOptionsImplied() {
    const dualHelper = new DualOptions(this.options);
    const hasCustomOptionValue = (optionKey) => {
      return this.getOptionValue(optionKey) !== void 0 && !["default", "implied"].includes(this.getOptionValueSource(optionKey));
    };
    this.options.filter(
      (option) => option.implied !== void 0 && hasCustomOptionValue(option.attributeName()) && dualHelper.valueFromOption(
        this.getOptionValue(option.attributeName()),
        option
      )
    ).forEach((option) => {
      Object.keys(option.implied).filter((impliedKey) => !hasCustomOptionValue(impliedKey)).forEach((impliedKey) => {
        this.setOptionValueWithSource(
          impliedKey,
          option.implied[impliedKey],
          "implied"
        );
      });
    });
  }
  /**
   * Argument `name` is missing.
   *
   * @param {string} name
   * @private
   */
  missingArgument(name) {
    const message = `error: missing required argument '${name}'`;
    this.error(message, { code: "commander.missingArgument" });
  }
  /**
   * `Option` is missing an argument.
   *
   * @param {Option} option
   * @private
   */
  optionMissingArgument(option) {
    const message = `error: option '${option.flags}' argument missing`;
    this.error(message, { code: "commander.optionMissingArgument" });
  }
  /**
   * `Option` does not have a value, and is a mandatory option.
   *
   * @param {Option} option
   * @private
   */
  missingMandatoryOptionValue(option) {
    const message = `error: required option '${option.flags}' not specified`;
    this.error(message, { code: "commander.missingMandatoryOptionValue" });
  }
  /**
   * `Option` conflicts with another option.
   *
   * @param {Option} option
   * @param {Option} conflictingOption
   * @private
   */
  _conflictingOption(option, conflictingOption) {
    const findBestOptionFromValue = (option2) => {
      const optionKey = option2.attributeName();
      const optionValue = this.getOptionValue(optionKey);
      const negativeOption = this.options.find(
        (target) => target.negate && optionKey === target.attributeName()
      );
      const positiveOption = this.options.find(
        (target) => !target.negate && optionKey === target.attributeName()
      );
      if (negativeOption && (negativeOption.presetArg === void 0 && optionValue === false || negativeOption.presetArg !== void 0 && optionValue === negativeOption.presetArg)) {
        return negativeOption;
      }
      return positiveOption || option2;
    };
    const getErrorMessage = (option2) => {
      const bestOption = findBestOptionFromValue(option2);
      const optionKey = bestOption.attributeName();
      const source = this.getOptionValueSource(optionKey);
      if (source === "env") {
        return `environment variable '${bestOption.envVar}'`;
      }
      return `option '${bestOption.flags}'`;
    };
    const message = `error: ${getErrorMessage(option)} cannot be used with ${getErrorMessage(conflictingOption)}`;
    this.error(message, { code: "commander.conflictingOption" });
  }
  /**
   * Unknown option `flag`.
   *
   * @param {string} flag
   * @private
   */
  unknownOption(flag) {
    if (this._allowUnknownOption) return;
    let suggestion = "";
    if (flag.startsWith("--") && this._showSuggestionAfterError) {
      let candidateFlags = [];
      let command = this;
      do {
        const moreFlags = command.createHelp().visibleOptions(command).filter((option) => option.long).map((option) => option.long);
        candidateFlags = candidateFlags.concat(moreFlags);
        command = command.parent;
      } while (command && !command._enablePositionalOptions);
      suggestion = suggestSimilar(flag, candidateFlags);
    }
    const message = `error: unknown option '${flag}'${suggestion}`;
    this.error(message, { code: "commander.unknownOption" });
  }
  /**
   * Excess arguments, more than expected.
   *
   * @param {string[]} receivedArgs
   * @private
   */
  _excessArguments(receivedArgs) {
    if (this._allowExcessArguments) return;
    const expected = this.registeredArguments.length;
    const s = expected === 1 ? "" : "s";
    const received = receivedArgs.length;
    const forSubcommand = this.parent ? ` for '${this.name()}'` : "";
    const details = receivedArgs.join(", ");
    const message = `error: too many arguments${forSubcommand}. Expected ${expected} argument${s} but got ${received}: ${details}.`;
    this.error(message, { code: "commander.excessArguments" });
  }
  /**
   * Unknown command.
   *
   * @private
   */
  unknownCommand() {
    const unknownName = this.args[0];
    let suggestion = "";
    if (this._showSuggestionAfterError) {
      const candidateNames = [];
      this.createHelp().visibleCommands(this).forEach((command) => {
        candidateNames.push(command.name());
        if (command.alias()) candidateNames.push(command.alias());
      });
      suggestion = suggestSimilar(unknownName, candidateNames);
    }
    const message = `error: unknown command '${unknownName}'${suggestion}`;
    this.error(message, { code: "commander.unknownCommand" });
  }
  /**
   * Get or set the program version.
   *
   * This method auto-registers the "-V, --version" option which will print the version number.
   *
   * You can optionally supply the flags and description to override the defaults.
   *
   * @param {string} [str]
   * @param {string} [flags]
   * @param {string} [description]
   * @return {(this | string | undefined)} `this` command for chaining, or version string if no arguments
   */
  version(str, flags, description) {
    if (str === void 0) return this._version;
    this._version = str;
    flags = flags || "-V, --version";
    description = description || "output the version number";
    const versionOption = this.createOption(flags, description);
    this._versionOptionName = versionOption.attributeName();
    this._registerOption(versionOption);
    this.on("option:" + versionOption.name(), () => {
      this._outputConfiguration.writeOut(`${str}
`);
      this._exit(0, "commander.version", str);
    });
    return this;
  }
  /**
   * Set the description.
   *
   * @param {string} [str]
   * @param {object} [argsDescription]
   * @return {(string|Command)}
   */
  description(str, argsDescription) {
    if (str === void 0 && argsDescription === void 0)
      return this._description;
    this._description = str;
    if (argsDescription) {
      this._argsDescription = argsDescription;
    }
    return this;
  }
  /**
   * Set the summary. Used when listed as subcommand of parent.
   *
   * @param {string} [str]
   * @return {(string|Command)}
   */
  summary(str) {
    if (str === void 0) return this._summary;
    this._summary = str;
    return this;
  }
  /**
   * Set an alias for the command.
   *
   * You may call more than once to add multiple aliases. Only the first alias is shown in the auto-generated help.
   *
   * @param {string} [alias]
   * @return {(string|Command)}
   */
  alias(alias) {
    if (alias === void 0) return this._aliases[0];
    let command = this;
    if (this.commands.length !== 0 && this.commands[this.commands.length - 1]._executableHandler) {
      command = this.commands[this.commands.length - 1];
    }
    if (alias === command._name)
      throw new Error("Command alias can't be the same as its name");
    const matchingCommand = this.parent?._findCommand(alias);
    if (matchingCommand) {
      const existingCmd = [matchingCommand.name()].concat(matchingCommand.aliases()).join("|");
      throw new Error(
        `cannot add alias '${alias}' to command '${this.name()}' as already have command '${existingCmd}'`
      );
    }
    command._aliases.push(alias);
    return this;
  }
  /**
   * Set aliases for the command.
   *
   * Only the first alias is shown in the auto-generated help.
   *
   * @param {string[]} [aliases]
   * @return {(string[]|Command)}
   */
  aliases(aliases) {
    if (aliases === void 0) return this._aliases;
    aliases.forEach((alias) => this.alias(alias));
    return this;
  }
  /**
   * Set / get the command usage `str`.
   *
   * @param {string} [str]
   * @return {(string|Command)}
   */
  usage(str) {
    if (str === void 0) {
      if (this._usage) return this._usage;
      const args = this.registeredArguments.map((arg) => {
        return humanReadableArgName(arg);
      });
      return [].concat(
        this.options.length || this._helpOption !== null ? "[options]" : [],
        this.commands.length ? "[command]" : [],
        this.registeredArguments.length ? args : []
      ).join(" ");
    }
    this._usage = str;
    return this;
  }
  /**
   * Get or set the name of the command.
   *
   * @param {string} [str]
   * @return {(string|Command)}
   */
  name(str) {
    if (str === void 0) return this._name;
    this._name = str;
    return this;
  }
  /**
   * Set/get the help group heading for this subcommand in parent command's help.
   *
   * @param {string} [heading]
   * @return {Command | string}
   */
  helpGroup(heading) {
    if (heading === void 0) return this._helpGroupHeading ?? "";
    this._helpGroupHeading = heading;
    return this;
  }
  /**
   * Set/get the default help group heading for subcommands added to this command.
   * (This does not override a group set directly on the subcommand using .helpGroup().)
   *
   * @example
   * program.commandsGroup('Development Commands:);
   * program.command('watch')...
   * program.command('lint')...
   * ...
   *
   * @param {string} [heading]
   * @returns {Command | string}
   */
  commandsGroup(heading) {
    if (heading === void 0) return this._defaultCommandGroup ?? "";
    this._defaultCommandGroup = heading;
    return this;
  }
  /**
   * Set/get the default help group heading for options added to this command.
   * (This does not override a group set directly on the option using .helpGroup().)
   *
   * @example
   * program
   *   .optionsGroup('Development Options:')
   *   .option('-d, --debug', 'output extra debugging')
   *   .option('-p, --profile', 'output profiling information')
   *
   * @param {string} [heading]
   * @returns {Command | string}
   */
  optionsGroup(heading) {
    if (heading === void 0) return this._defaultOptionGroup ?? "";
    this._defaultOptionGroup = heading;
    return this;
  }
  /**
   * @param {Option} option
   * @private
   */
  _initOptionGroup(option) {
    if (this._defaultOptionGroup && !option.helpGroupHeading)
      option.helpGroup(this._defaultOptionGroup);
  }
  /**
   * @param {Command} cmd
   * @private
   */
  _initCommandGroup(cmd) {
    if (this._defaultCommandGroup && !cmd.helpGroup())
      cmd.helpGroup(this._defaultCommandGroup);
  }
  /**
   * Set the name of the command from script filename, such as process.argv[1],
   * or import.meta.filename.
   *
   * (Used internally and public although not documented in README.)
   *
   * @example
   * program.nameFromFilename(import.meta.filename);
   *
   * @param {string} filename
   * @return {Command}
   */
  nameFromFilename(filename) {
    this._name = path.basename(filename, path.extname(filename));
    return this;
  }
  /**
   * Get or set the directory for searching for executable subcommands of this command.
   *
   * @example
   * program.executableDir(import.meta.dirname);
   * // or
   * program.executableDir('subcommands');
   *
   * @param {string} [path]
   * @return {(string|null|Command)}
   */
  executableDir(path14) {
    if (path14 === void 0) return this._executableDir;
    this._executableDir = path14;
    return this;
  }
  /**
   * Return program help documentation.
   *
   * @param {{ error: boolean }} [contextOptions] - pass {error:true} to wrap for stderr instead of stdout
   * @return {string}
   */
  helpInformation(contextOptions) {
    const helper = this.createHelp();
    const context = this._getOutputContext(contextOptions);
    helper.prepareContext({
      error: context.error,
      helpWidth: context.helpWidth,
      outputHasColors: context.hasColors
    });
    const text = helper.formatHelp(this, helper);
    if (context.hasColors) return text;
    return this._outputConfiguration.stripColor(text);
  }
  /**
   * @typedef HelpContext
   * @type {object}
   * @property {boolean} error
   * @property {number} helpWidth
   * @property {boolean} hasColors
   * @property {function} write - includes stripColor if needed
   *
   * @returns {HelpContext}
   * @private
   */
  _getOutputContext(contextOptions) {
    contextOptions = contextOptions || {};
    const error = !!contextOptions.error;
    let baseWrite;
    let hasColors;
    let helpWidth;
    if (error) {
      baseWrite = (str) => this._outputConfiguration.writeErr(str);
      hasColors = this._outputConfiguration.getErrHasColors();
      helpWidth = this._outputConfiguration.getErrHelpWidth();
    } else {
      baseWrite = (str) => this._outputConfiguration.writeOut(str);
      hasColors = this._outputConfiguration.getOutHasColors();
      helpWidth = this._outputConfiguration.getOutHelpWidth();
    }
    const write = (str) => {
      if (!hasColors) str = this._outputConfiguration.stripColor(str);
      return baseWrite(str);
    };
    return { error, write, hasColors, helpWidth };
  }
  /**
   * Output help information for this command.
   *
   * Outputs built-in help, and custom text added using `.addHelpText()`.
   *
   * @param {{ error: boolean } | Function} [contextOptions] - pass {error:true} to write to stderr instead of stdout
   */
  outputHelp(contextOptions) {
    let deprecatedCallback;
    if (typeof contextOptions === "function") {
      deprecatedCallback = contextOptions;
      contextOptions = void 0;
    }
    const outputContext = this._getOutputContext(contextOptions);
    const eventContext = {
      error: outputContext.error,
      write: outputContext.write,
      command: this
    };
    this._getCommandAndAncestors().reverse().forEach((command) => command.emit("beforeAllHelp", eventContext));
    this.emit("beforeHelp", eventContext);
    let helpInformation = this.helpInformation({ error: outputContext.error });
    if (deprecatedCallback) {
      helpInformation = deprecatedCallback(helpInformation);
      if (typeof helpInformation !== "string" && !Buffer.isBuffer(helpInformation)) {
        throw new Error("outputHelp callback must return a string or a Buffer");
      }
    }
    outputContext.write(helpInformation);
    if (this._getHelpOption()?.long) {
      this.emit(this._getHelpOption().long);
    }
    this.emit("afterHelp", eventContext);
    this._getCommandAndAncestors().forEach(
      (command) => command.emit("afterAllHelp", eventContext)
    );
  }
  /**
   * You can pass in flags and a description to customise the built-in help option.
   * Pass in false to disable the built-in help option.
   *
   * @example
   * program.helpOption('-?, --help' 'show help'); // customise
   * program.helpOption(false); // disable
   *
   * @param {(string | boolean)} flags
   * @param {string} [description]
   * @return {Command} `this` command for chaining
   */
  helpOption(flags, description) {
    if (typeof flags === "boolean") {
      if (flags) {
        if (this._helpOption === null) this._helpOption = void 0;
        if (this._defaultOptionGroup) {
          this._initOptionGroup(this._getHelpOption());
        }
      } else {
        this._helpOption = null;
      }
      return this;
    }
    this._helpOption = this.createOption(
      flags ?? "-h, --help",
      description ?? "display help for command"
    );
    if (flags || description) this._initOptionGroup(this._helpOption);
    return this;
  }
  /**
   * Lazy create help option.
   * Returns null if has been disabled with .helpOption(false).
   *
   * @returns {(Option | null)} the help option
   * @package
   */
  _getHelpOption() {
    if (this._helpOption === void 0) {
      this.helpOption(void 0, void 0);
    }
    return this._helpOption;
  }
  /**
   * Supply your own option to use for the built-in help option.
   * This is an alternative to using helpOption() to customise the flags and description etc.
   *
   * @param {Option} option
   * @return {Command} `this` command for chaining
   */
  addHelpOption(option) {
    this._helpOption = option;
    this._initOptionGroup(option);
    return this;
  }
  /**
   * Output help information and exit.
   *
   * Outputs built-in help, and custom text added using `.addHelpText()`.
   *
   * @param {{ error: boolean }} [contextOptions] - pass {error:true} to write to stderr instead of stdout
   */
  help(contextOptions) {
    this.outputHelp(contextOptions);
    let exitCode = Number(process2.exitCode ?? 0);
    if (exitCode === 0 && contextOptions && typeof contextOptions !== "function" && contextOptions.error) {
      exitCode = 1;
    }
    this._exit(exitCode, "commander.help", "(outputHelp)");
  }
  /**
   * // Do a little typing to coordinate emit and listener for the help text events.
   * @typedef HelpTextEventContext
   * @type {object}
   * @property {boolean} error
   * @property {Command} command
   * @property {function} write
   */
  /**
   * Add additional text to be displayed with the built-in help.
   *
   * Position is 'before' or 'after' to affect just this command,
   * and 'beforeAll' or 'afterAll' to affect this command and all its subcommands.
   *
   * @param {string} position - before or after built-in help
   * @param {(string | Function)} text - string to add, or a function returning a string
   * @return {Command} `this` command for chaining
   */
  addHelpText(position, text) {
    const allowedValues = ["beforeAll", "before", "after", "afterAll"];
    if (!allowedValues.includes(position)) {
      throw new Error(`Unexpected value for position to addHelpText.
Expecting one of '${allowedValues.join("', '")}'`);
    }
    const helpEvent = `${position}Help`;
    this.on(helpEvent, (context) => {
      let helpStr;
      if (typeof text === "function") {
        helpStr = text({ error: context.error, command: context.command });
      } else {
        helpStr = text;
      }
      if (helpStr) {
        context.write(`${helpStr}
`);
      }
    });
    return this;
  }
  /**
   * Output help information if help flags specified
   *
   * @param {Array} args - array of options to search for help flags
   * @private
   */
  _outputHelpIfRequested(args) {
    const helpOption = this._getHelpOption();
    const helpRequested = helpOption && args.find((arg) => helpOption.is(arg));
    if (helpRequested) {
      this.outputHelp();
      this._exit(0, "commander.helpDisplayed", "(outputHelp)");
    }
  }
};
function incrementNodeInspectorPort(args) {
  return args.map((arg) => {
    if (!arg.startsWith("--inspect")) {
      return arg;
    }
    let debugOption;
    let debugHost = "127.0.0.1";
    let debugPort = "9229";
    let match;
    if ((match = arg.match(/^(--inspect(-brk)?)$/)) !== null) {
      debugOption = match[1];
    } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+)$/)) !== null) {
      debugOption = match[1];
      if (/^\d+$/.test(match[3])) {
        debugPort = match[3];
      } else {
        debugHost = match[3];
      }
    } else if ((match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+):(\d+)$/)) !== null) {
      debugOption = match[1];
      debugHost = match[3];
      debugPort = match[4];
    }
    if (debugOption && debugPort !== "0") {
      return `${debugOption}=${debugHost}:${parseInt(debugPort) + 1}`;
    }
    return arg;
  });
}
function useColor() {
  if (process2.env.NO_COLOR || process2.env.FORCE_COLOR === "0" || process2.env.FORCE_COLOR === "false")
    return false;
  if (process2.env.FORCE_COLOR || process2.env.CLICOLOR_FORCE !== void 0)
    return true;
  return void 0;
}

// node_modules/commander/index.js
var program = new Command();

// src/cli/commands/crew-init.ts
var FORMATS = ["toon", "json", "text"];
function isCliFormat(value) {
  return FORMATS.includes(value);
}
function buildCrewInitCommand() {
  return new Command("init").description("Scaffold a canonical .pi/bebop software crew in a project").option("--project <directory>", "Target project root (default: current working directory)").option("--format <format>", "Output format: toon (default), json, or text", "toon").showHelpAfterError(false).helpOption(false);
}

// node_modules/@sinclair/typebox/build/esm/type/guard/value.mjs
var value_exports = {};
__export(value_exports, {
  HasPropertyKey: () => HasPropertyKey,
  IsArray: () => IsArray,
  IsAsyncIterator: () => IsAsyncIterator,
  IsBigInt: () => IsBigInt,
  IsBoolean: () => IsBoolean,
  IsDate: () => IsDate,
  IsFunction: () => IsFunction,
  IsIterator: () => IsIterator,
  IsNull: () => IsNull,
  IsNumber: () => IsNumber,
  IsObject: () => IsObject,
  IsRegExp: () => IsRegExp,
  IsString: () => IsString,
  IsSymbol: () => IsSymbol,
  IsUint8Array: () => IsUint8Array,
  IsUndefined: () => IsUndefined
});
function HasPropertyKey(value, key) {
  return key in value;
}
function IsAsyncIterator(value) {
  return IsObject(value) && !IsArray(value) && !IsUint8Array(value) && Symbol.asyncIterator in value;
}
function IsArray(value) {
  return Array.isArray(value);
}
function IsBigInt(value) {
  return typeof value === "bigint";
}
function IsBoolean(value) {
  return typeof value === "boolean";
}
function IsDate(value) {
  return value instanceof globalThis.Date;
}
function IsFunction(value) {
  return typeof value === "function";
}
function IsIterator(value) {
  return IsObject(value) && !IsArray(value) && !IsUint8Array(value) && Symbol.iterator in value;
}
function IsNull(value) {
  return value === null;
}
function IsNumber(value) {
  return typeof value === "number";
}
function IsObject(value) {
  return typeof value === "object" && value !== null;
}
function IsRegExp(value) {
  return value instanceof globalThis.RegExp;
}
function IsString(value) {
  return typeof value === "string";
}
function IsSymbol(value) {
  return typeof value === "symbol";
}
function IsUint8Array(value) {
  return value instanceof globalThis.Uint8Array;
}
function IsUndefined(value) {
  return value === void 0;
}

// node_modules/@sinclair/typebox/build/esm/type/clone/value.mjs
function ArrayType(value) {
  return value.map((value2) => Visit(value2));
}
function DateType(value) {
  return new Date(value.getTime());
}
function Uint8ArrayType(value) {
  return new Uint8Array(value);
}
function RegExpType(value) {
  return new RegExp(value.source, value.flags);
}
function ObjectType(value) {
  const result = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    result[key] = Visit(value[key]);
  }
  for (const key of Object.getOwnPropertySymbols(value)) {
    result[key] = Visit(value[key]);
  }
  return result;
}
function Visit(value) {
  return IsArray(value) ? ArrayType(value) : IsDate(value) ? DateType(value) : IsUint8Array(value) ? Uint8ArrayType(value) : IsRegExp(value) ? RegExpType(value) : IsObject(value) ? ObjectType(value) : value;
}
function Clone(value) {
  return Visit(value);
}

// node_modules/@sinclair/typebox/build/esm/type/clone/type.mjs
function CloneType(schema, options) {
  return options === void 0 ? Clone(schema) : Clone({ ...options, ...schema });
}

// node_modules/@sinclair/typebox/build/esm/value/guard/guard.mjs
function IsAsyncIterator2(value) {
  return IsObject2(value) && globalThis.Symbol.asyncIterator in value;
}
function IsIterator2(value) {
  return IsObject2(value) && globalThis.Symbol.iterator in value;
}
function IsStandardObject(value) {
  return IsObject2(value) && (globalThis.Object.getPrototypeOf(value) === Object.prototype || globalThis.Object.getPrototypeOf(value) === null);
}
function IsPromise(value) {
  return value instanceof globalThis.Promise;
}
function IsDate2(value) {
  return value instanceof Date && globalThis.Number.isFinite(value.getTime());
}
function IsMap(value) {
  return value instanceof globalThis.Map;
}
function IsSet(value) {
  return value instanceof globalThis.Set;
}
function IsTypedArray(value) {
  return globalThis.ArrayBuffer.isView(value);
}
function IsUint8Array2(value) {
  return value instanceof globalThis.Uint8Array;
}
function HasPropertyKey2(value, key) {
  return key in value;
}
function IsObject2(value) {
  return value !== null && typeof value === "object";
}
function IsArray2(value) {
  return globalThis.Array.isArray(value) && !globalThis.ArrayBuffer.isView(value);
}
function IsUndefined2(value) {
  return value === void 0;
}
function IsNull2(value) {
  return value === null;
}
function IsBoolean2(value) {
  return typeof value === "boolean";
}
function IsNumber2(value) {
  return typeof value === "number";
}
function IsInteger(value) {
  return globalThis.Number.isInteger(value);
}
function IsBigInt2(value) {
  return typeof value === "bigint";
}
function IsString2(value) {
  return typeof value === "string";
}
function IsFunction2(value) {
  return typeof value === "function";
}
function IsSymbol2(value) {
  return typeof value === "symbol";
}
function IsValueType(value) {
  return IsBigInt2(value) || IsBoolean2(value) || IsNull2(value) || IsNumber2(value) || IsString2(value) || IsSymbol2(value) || IsUndefined2(value);
}

// node_modules/@sinclair/typebox/build/esm/system/policy.mjs
var TypeSystemPolicy;
(function(TypeSystemPolicy2) {
  TypeSystemPolicy2.InstanceMode = "default";
  TypeSystemPolicy2.ExactOptionalPropertyTypes = false;
  TypeSystemPolicy2.AllowArrayObject = false;
  TypeSystemPolicy2.AllowNaN = false;
  TypeSystemPolicy2.AllowNullVoid = false;
  function IsExactOptionalProperty(value, key) {
    return TypeSystemPolicy2.ExactOptionalPropertyTypes ? key in value : value[key] !== void 0;
  }
  TypeSystemPolicy2.IsExactOptionalProperty = IsExactOptionalProperty;
  function IsObjectLike(value) {
    const isObject = IsObject2(value);
    return TypeSystemPolicy2.AllowArrayObject ? isObject : isObject && !IsArray2(value);
  }
  TypeSystemPolicy2.IsObjectLike = IsObjectLike;
  function IsRecordLike(value) {
    return IsObjectLike(value) && !(value instanceof Date) && !(value instanceof Uint8Array);
  }
  TypeSystemPolicy2.IsRecordLike = IsRecordLike;
  function IsNumberLike(value) {
    return TypeSystemPolicy2.AllowNaN ? IsNumber2(value) : Number.isFinite(value);
  }
  TypeSystemPolicy2.IsNumberLike = IsNumberLike;
  function IsVoidLike(value) {
    const isUndefined = IsUndefined2(value);
    return TypeSystemPolicy2.AllowNullVoid ? isUndefined || value === null : isUndefined;
  }
  TypeSystemPolicy2.IsVoidLike = IsVoidLike;
})(TypeSystemPolicy || (TypeSystemPolicy = {}));

// node_modules/@sinclair/typebox/build/esm/type/create/immutable.mjs
function ImmutableArray(value) {
  return globalThis.Object.freeze(value).map((value2) => Immutable(value2));
}
function ImmutableDate(value) {
  return value;
}
function ImmutableUint8Array(value) {
  return value;
}
function ImmutableRegExp(value) {
  return value;
}
function ImmutableObject(value) {
  const result = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    result[key] = Immutable(value[key]);
  }
  for (const key of Object.getOwnPropertySymbols(value)) {
    result[key] = Immutable(value[key]);
  }
  return globalThis.Object.freeze(result);
}
function Immutable(value) {
  return IsArray(value) ? ImmutableArray(value) : IsDate(value) ? ImmutableDate(value) : IsUint8Array(value) ? ImmutableUint8Array(value) : IsRegExp(value) ? ImmutableRegExp(value) : IsObject(value) ? ImmutableObject(value) : value;
}

// node_modules/@sinclair/typebox/build/esm/type/create/type.mjs
function CreateType(schema, options) {
  const result = options !== void 0 ? { ...options, ...schema } : schema;
  switch (TypeSystemPolicy.InstanceMode) {
    case "freeze":
      return Immutable(result);
    case "clone":
      return Clone(result);
    default:
      return result;
  }
}

// node_modules/@sinclair/typebox/build/esm/type/error/error.mjs
var TypeBoxError = class extends Error {
  constructor(message) {
    super(message);
  }
};

// node_modules/@sinclair/typebox/build/esm/type/symbols/symbols.mjs
var TransformKind = Symbol.for("TypeBox.Transform");
var ReadonlyKind = Symbol.for("TypeBox.Readonly");
var OptionalKind = Symbol.for("TypeBox.Optional");
var Hint = Symbol.for("TypeBox.Hint");
var Kind = Symbol.for("TypeBox.Kind");

// node_modules/@sinclair/typebox/build/esm/type/guard/kind.mjs
function IsReadonly(value) {
  return IsObject(value) && value[ReadonlyKind] === "Readonly";
}
function IsOptional(value) {
  return IsObject(value) && value[OptionalKind] === "Optional";
}
function IsAny(value) {
  return IsKindOf(value, "Any");
}
function IsArgument(value) {
  return IsKindOf(value, "Argument");
}
function IsArray3(value) {
  return IsKindOf(value, "Array");
}
function IsAsyncIterator3(value) {
  return IsKindOf(value, "AsyncIterator");
}
function IsBigInt3(value) {
  return IsKindOf(value, "BigInt");
}
function IsBoolean3(value) {
  return IsKindOf(value, "Boolean");
}
function IsComputed(value) {
  return IsKindOf(value, "Computed");
}
function IsConstructor(value) {
  return IsKindOf(value, "Constructor");
}
function IsDate3(value) {
  return IsKindOf(value, "Date");
}
function IsFunction3(value) {
  return IsKindOf(value, "Function");
}
function IsInteger2(value) {
  return IsKindOf(value, "Integer");
}
function IsIntersect(value) {
  return IsKindOf(value, "Intersect");
}
function IsIterator3(value) {
  return IsKindOf(value, "Iterator");
}
function IsKindOf(value, kind) {
  return IsObject(value) && Kind in value && value[Kind] === kind;
}
function IsLiteralValue(value) {
  return IsBoolean(value) || IsNumber(value) || IsString(value);
}
function IsLiteral(value) {
  return IsKindOf(value, "Literal");
}
function IsMappedKey(value) {
  return IsKindOf(value, "MappedKey");
}
function IsMappedResult(value) {
  return IsKindOf(value, "MappedResult");
}
function IsNever(value) {
  return IsKindOf(value, "Never");
}
function IsNot(value) {
  return IsKindOf(value, "Not");
}
function IsNull3(value) {
  return IsKindOf(value, "Null");
}
function IsNumber3(value) {
  return IsKindOf(value, "Number");
}
function IsObject3(value) {
  return IsKindOf(value, "Object");
}
function IsPromise2(value) {
  return IsKindOf(value, "Promise");
}
function IsRecord(value) {
  return IsKindOf(value, "Record");
}
function IsRef(value) {
  return IsKindOf(value, "Ref");
}
function IsRegExp2(value) {
  return IsKindOf(value, "RegExp");
}
function IsString3(value) {
  return IsKindOf(value, "String");
}
function IsSymbol3(value) {
  return IsKindOf(value, "Symbol");
}
function IsTemplateLiteral(value) {
  return IsKindOf(value, "TemplateLiteral");
}
function IsThis(value) {
  return IsKindOf(value, "This");
}
function IsTransform(value) {
  return IsObject(value) && TransformKind in value;
}
function IsTuple(value) {
  return IsKindOf(value, "Tuple");
}
function IsUndefined3(value) {
  return IsKindOf(value, "Undefined");
}
function IsUnion(value) {
  return IsKindOf(value, "Union");
}
function IsUint8Array3(value) {
  return IsKindOf(value, "Uint8Array");
}
function IsUnknown(value) {
  return IsKindOf(value, "Unknown");
}
function IsUnsafe(value) {
  return IsKindOf(value, "Unsafe");
}
function IsVoid(value) {
  return IsKindOf(value, "Void");
}
function IsKind(value) {
  return IsObject(value) && Kind in value && IsString(value[Kind]);
}
function IsSchema(value) {
  return IsAny(value) || IsArgument(value) || IsArray3(value) || IsBoolean3(value) || IsBigInt3(value) || IsAsyncIterator3(value) || IsComputed(value) || IsConstructor(value) || IsDate3(value) || IsFunction3(value) || IsInteger2(value) || IsIntersect(value) || IsIterator3(value) || IsLiteral(value) || IsMappedKey(value) || IsMappedResult(value) || IsNever(value) || IsNot(value) || IsNull3(value) || IsNumber3(value) || IsObject3(value) || IsPromise2(value) || IsRecord(value) || IsRef(value) || IsRegExp2(value) || IsString3(value) || IsSymbol3(value) || IsTemplateLiteral(value) || IsThis(value) || IsTuple(value) || IsUndefined3(value) || IsUnion(value) || IsUint8Array3(value) || IsUnknown(value) || IsUnsafe(value) || IsVoid(value) || IsKind(value);
}

// node_modules/@sinclair/typebox/build/esm/type/guard/type.mjs
var type_exports = {};
__export(type_exports, {
  IsAny: () => IsAny2,
  IsArgument: () => IsArgument2,
  IsArray: () => IsArray4,
  IsAsyncIterator: () => IsAsyncIterator4,
  IsBigInt: () => IsBigInt4,
  IsBoolean: () => IsBoolean4,
  IsComputed: () => IsComputed2,
  IsConstructor: () => IsConstructor2,
  IsDate: () => IsDate4,
  IsFunction: () => IsFunction4,
  IsImport: () => IsImport,
  IsInteger: () => IsInteger3,
  IsIntersect: () => IsIntersect2,
  IsIterator: () => IsIterator4,
  IsKind: () => IsKind2,
  IsKindOf: () => IsKindOf2,
  IsLiteral: () => IsLiteral2,
  IsLiteralBoolean: () => IsLiteralBoolean,
  IsLiteralNumber: () => IsLiteralNumber,
  IsLiteralString: () => IsLiteralString,
  IsLiteralValue: () => IsLiteralValue2,
  IsMappedKey: () => IsMappedKey2,
  IsMappedResult: () => IsMappedResult2,
  IsNever: () => IsNever2,
  IsNot: () => IsNot2,
  IsNull: () => IsNull4,
  IsNumber: () => IsNumber4,
  IsObject: () => IsObject4,
  IsOptional: () => IsOptional2,
  IsPromise: () => IsPromise3,
  IsProperties: () => IsProperties,
  IsReadonly: () => IsReadonly2,
  IsRecord: () => IsRecord2,
  IsRecursive: () => IsRecursive,
  IsRef: () => IsRef2,
  IsRegExp: () => IsRegExp3,
  IsSchema: () => IsSchema2,
  IsString: () => IsString4,
  IsSymbol: () => IsSymbol4,
  IsTemplateLiteral: () => IsTemplateLiteral2,
  IsThis: () => IsThis2,
  IsTransform: () => IsTransform2,
  IsTuple: () => IsTuple2,
  IsUint8Array: () => IsUint8Array4,
  IsUndefined: () => IsUndefined4,
  IsUnion: () => IsUnion2,
  IsUnionLiteral: () => IsUnionLiteral,
  IsUnknown: () => IsUnknown2,
  IsUnsafe: () => IsUnsafe2,
  IsVoid: () => IsVoid2,
  TypeGuardUnknownTypeError: () => TypeGuardUnknownTypeError
});
var TypeGuardUnknownTypeError = class extends TypeBoxError {
};
var KnownTypes = [
  "Argument",
  "Any",
  "Array",
  "AsyncIterator",
  "BigInt",
  "Boolean",
  "Computed",
  "Constructor",
  "Date",
  "Enum",
  "Function",
  "Integer",
  "Intersect",
  "Iterator",
  "Literal",
  "MappedKey",
  "MappedResult",
  "Not",
  "Null",
  "Number",
  "Object",
  "Promise",
  "Record",
  "Ref",
  "RegExp",
  "String",
  "Symbol",
  "TemplateLiteral",
  "This",
  "Tuple",
  "Undefined",
  "Union",
  "Uint8Array",
  "Unknown",
  "Void"
];
function IsPattern(value) {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}
function IsControlCharacterFree(value) {
  if (!IsString(value))
    return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 7 && code <= 13 || code === 27 || code === 127) {
      return false;
    }
  }
  return true;
}
function IsAdditionalProperties(value) {
  return IsOptionalBoolean(value) || IsSchema2(value);
}
function IsOptionalBigInt(value) {
  return IsUndefined(value) || IsBigInt(value);
}
function IsOptionalNumber(value) {
  return IsUndefined(value) || IsNumber(value);
}
function IsOptionalBoolean(value) {
  return IsUndefined(value) || IsBoolean(value);
}
function IsOptionalString(value) {
  return IsUndefined(value) || IsString(value);
}
function IsOptionalPattern(value) {
  return IsUndefined(value) || IsString(value) && IsControlCharacterFree(value) && IsPattern(value);
}
function IsOptionalFormat(value) {
  return IsUndefined(value) || IsString(value) && IsControlCharacterFree(value);
}
function IsOptionalSchema(value) {
  return IsUndefined(value) || IsSchema2(value);
}
function IsReadonly2(value) {
  return IsObject(value) && value[ReadonlyKind] === "Readonly";
}
function IsOptional2(value) {
  return IsObject(value) && value[OptionalKind] === "Optional";
}
function IsAny2(value) {
  return IsKindOf2(value, "Any") && IsOptionalString(value.$id);
}
function IsArgument2(value) {
  return IsKindOf2(value, "Argument") && IsNumber(value.index);
}
function IsArray4(value) {
  return IsKindOf2(value, "Array") && value.type === "array" && IsOptionalString(value.$id) && IsSchema2(value.items) && IsOptionalNumber(value.minItems) && IsOptionalNumber(value.maxItems) && IsOptionalBoolean(value.uniqueItems) && IsOptionalSchema(value.contains) && IsOptionalNumber(value.minContains) && IsOptionalNumber(value.maxContains);
}
function IsAsyncIterator4(value) {
  return IsKindOf2(value, "AsyncIterator") && value.type === "AsyncIterator" && IsOptionalString(value.$id) && IsSchema2(value.items);
}
function IsBigInt4(value) {
  return IsKindOf2(value, "BigInt") && value.type === "bigint" && IsOptionalString(value.$id) && IsOptionalBigInt(value.exclusiveMaximum) && IsOptionalBigInt(value.exclusiveMinimum) && IsOptionalBigInt(value.maximum) && IsOptionalBigInt(value.minimum) && IsOptionalBigInt(value.multipleOf);
}
function IsBoolean4(value) {
  return IsKindOf2(value, "Boolean") && value.type === "boolean" && IsOptionalString(value.$id);
}
function IsComputed2(value) {
  return IsKindOf2(value, "Computed") && IsString(value.target) && IsArray(value.parameters) && value.parameters.every((schema) => IsSchema2(schema));
}
function IsConstructor2(value) {
  return IsKindOf2(value, "Constructor") && value.type === "Constructor" && IsOptionalString(value.$id) && IsArray(value.parameters) && value.parameters.every((schema) => IsSchema2(schema)) && IsSchema2(value.returns);
}
function IsDate4(value) {
  return IsKindOf2(value, "Date") && value.type === "Date" && IsOptionalString(value.$id) && IsOptionalNumber(value.exclusiveMaximumTimestamp) && IsOptionalNumber(value.exclusiveMinimumTimestamp) && IsOptionalNumber(value.maximumTimestamp) && IsOptionalNumber(value.minimumTimestamp) && IsOptionalNumber(value.multipleOfTimestamp);
}
function IsFunction4(value) {
  return IsKindOf2(value, "Function") && value.type === "Function" && IsOptionalString(value.$id) && IsArray(value.parameters) && value.parameters.every((schema) => IsSchema2(schema)) && IsSchema2(value.returns);
}
function IsImport(value) {
  return IsKindOf2(value, "Import") && HasPropertyKey(value, "$defs") && IsObject(value.$defs) && IsProperties(value.$defs) && HasPropertyKey(value, "$ref") && IsString(value.$ref) && value.$ref in value.$defs;
}
function IsInteger3(value) {
  return IsKindOf2(value, "Integer") && value.type === "integer" && IsOptionalString(value.$id) && IsOptionalNumber(value.exclusiveMaximum) && IsOptionalNumber(value.exclusiveMinimum) && IsOptionalNumber(value.maximum) && IsOptionalNumber(value.minimum) && IsOptionalNumber(value.multipleOf);
}
function IsProperties(value) {
  return IsObject(value) && Object.entries(value).every(([key, schema]) => IsControlCharacterFree(key) && IsSchema2(schema));
}
function IsIntersect2(value) {
  return IsKindOf2(value, "Intersect") && (IsString(value.type) && value.type !== "object" ? false : true) && IsArray(value.allOf) && value.allOf.every((schema) => IsSchema2(schema) && !IsTransform2(schema)) && IsOptionalString(value.type) && (IsOptionalBoolean(value.unevaluatedProperties) || IsOptionalSchema(value.unevaluatedProperties)) && IsOptionalString(value.$id);
}
function IsIterator4(value) {
  return IsKindOf2(value, "Iterator") && value.type === "Iterator" && IsOptionalString(value.$id) && IsSchema2(value.items);
}
function IsKindOf2(value, kind) {
  return IsObject(value) && Kind in value && value[Kind] === kind;
}
function IsLiteralString(value) {
  return IsLiteral2(value) && IsString(value.const);
}
function IsLiteralNumber(value) {
  return IsLiteral2(value) && IsNumber(value.const);
}
function IsLiteralBoolean(value) {
  return IsLiteral2(value) && IsBoolean(value.const);
}
function IsLiteral2(value) {
  return IsKindOf2(value, "Literal") && IsOptionalString(value.$id) && IsLiteralValue2(value.const);
}
function IsLiteralValue2(value) {
  return IsBoolean(value) || IsNumber(value) || IsString(value);
}
function IsMappedKey2(value) {
  return IsKindOf2(value, "MappedKey") && IsArray(value.keys) && value.keys.every((key) => IsNumber(key) || IsString(key));
}
function IsMappedResult2(value) {
  return IsKindOf2(value, "MappedResult") && IsProperties(value.properties);
}
function IsNever2(value) {
  return IsKindOf2(value, "Never") && IsObject(value.not) && Object.getOwnPropertyNames(value.not).length === 0;
}
function IsNot2(value) {
  return IsKindOf2(value, "Not") && IsSchema2(value.not);
}
function IsNull4(value) {
  return IsKindOf2(value, "Null") && value.type === "null" && IsOptionalString(value.$id);
}
function IsNumber4(value) {
  return IsKindOf2(value, "Number") && value.type === "number" && IsOptionalString(value.$id) && IsOptionalNumber(value.exclusiveMaximum) && IsOptionalNumber(value.exclusiveMinimum) && IsOptionalNumber(value.maximum) && IsOptionalNumber(value.minimum) && IsOptionalNumber(value.multipleOf);
}
function IsObject4(value) {
  return IsKindOf2(value, "Object") && value.type === "object" && IsOptionalString(value.$id) && IsProperties(value.properties) && IsAdditionalProperties(value.additionalProperties) && IsOptionalNumber(value.minProperties) && IsOptionalNumber(value.maxProperties);
}
function IsPromise3(value) {
  return IsKindOf2(value, "Promise") && value.type === "Promise" && IsOptionalString(value.$id) && IsSchema2(value.item);
}
function IsRecord2(value) {
  return IsKindOf2(value, "Record") && value.type === "object" && IsOptionalString(value.$id) && IsAdditionalProperties(value.additionalProperties) && IsObject(value.patternProperties) && ((schema) => {
    const keys = Object.getOwnPropertyNames(schema.patternProperties);
    return keys.length === 1 && IsPattern(keys[0]) && IsObject(schema.patternProperties) && IsSchema2(schema.patternProperties[keys[0]]);
  })(value);
}
function IsRecursive(value) {
  return IsObject(value) && Hint in value && value[Hint] === "Recursive";
}
function IsRef2(value) {
  return IsKindOf2(value, "Ref") && IsOptionalString(value.$id) && IsString(value.$ref);
}
function IsRegExp3(value) {
  return IsKindOf2(value, "RegExp") && IsOptionalString(value.$id) && IsString(value.source) && IsString(value.flags) && IsOptionalNumber(value.maxLength) && IsOptionalNumber(value.minLength);
}
function IsString4(value) {
  return IsKindOf2(value, "String") && value.type === "string" && IsOptionalString(value.$id) && IsOptionalNumber(value.minLength) && IsOptionalNumber(value.maxLength) && IsOptionalPattern(value.pattern) && IsOptionalFormat(value.format);
}
function IsSymbol4(value) {
  return IsKindOf2(value, "Symbol") && value.type === "symbol" && IsOptionalString(value.$id);
}
function IsTemplateLiteral2(value) {
  return IsKindOf2(value, "TemplateLiteral") && value.type === "string" && IsString(value.pattern) && value.pattern[0] === "^" && value.pattern[value.pattern.length - 1] === "$";
}
function IsThis2(value) {
  return IsKindOf2(value, "This") && IsOptionalString(value.$id) && IsString(value.$ref);
}
function IsTransform2(value) {
  return IsObject(value) && TransformKind in value;
}
function IsTuple2(value) {
  return IsKindOf2(value, "Tuple") && value.type === "array" && IsOptionalString(value.$id) && IsNumber(value.minItems) && IsNumber(value.maxItems) && value.minItems === value.maxItems && // empty
  (IsUndefined(value.items) && IsUndefined(value.additionalItems) && value.minItems === 0 || IsArray(value.items) && value.items.every((schema) => IsSchema2(schema)));
}
function IsUndefined4(value) {
  return IsKindOf2(value, "Undefined") && value.type === "undefined" && IsOptionalString(value.$id);
}
function IsUnionLiteral(value) {
  return IsUnion2(value) && value.anyOf.every((schema) => IsLiteralString(schema) || IsLiteralNumber(schema));
}
function IsUnion2(value) {
  return IsKindOf2(value, "Union") && IsOptionalString(value.$id) && IsObject(value) && IsArray(value.anyOf) && value.anyOf.every((schema) => IsSchema2(schema));
}
function IsUint8Array4(value) {
  return IsKindOf2(value, "Uint8Array") && value.type === "Uint8Array" && IsOptionalString(value.$id) && IsOptionalNumber(value.minByteLength) && IsOptionalNumber(value.maxByteLength);
}
function IsUnknown2(value) {
  return IsKindOf2(value, "Unknown") && IsOptionalString(value.$id);
}
function IsUnsafe2(value) {
  return IsKindOf2(value, "Unsafe");
}
function IsVoid2(value) {
  return IsKindOf2(value, "Void") && value.type === "void" && IsOptionalString(value.$id);
}
function IsKind2(value) {
  return IsObject(value) && Kind in value && IsString(value[Kind]) && !KnownTypes.includes(value[Kind]);
}
function IsSchema2(value) {
  return IsObject(value) && (IsAny2(value) || IsArgument2(value) || IsArray4(value) || IsBoolean4(value) || IsBigInt4(value) || IsAsyncIterator4(value) || IsComputed2(value) || IsConstructor2(value) || IsDate4(value) || IsFunction4(value) || IsInteger3(value) || IsIntersect2(value) || IsIterator4(value) || IsLiteral2(value) || IsMappedKey2(value) || IsMappedResult2(value) || IsNever2(value) || IsNot2(value) || IsNull4(value) || IsNumber4(value) || IsObject4(value) || IsPromise3(value) || IsRecord2(value) || IsRef2(value) || IsRegExp3(value) || IsString4(value) || IsSymbol4(value) || IsTemplateLiteral2(value) || IsThis2(value) || IsTuple2(value) || IsUndefined4(value) || IsUnion2(value) || IsUint8Array4(value) || IsUnknown2(value) || IsUnsafe2(value) || IsVoid2(value) || IsKind2(value));
}

// node_modules/@sinclair/typebox/build/esm/type/patterns/patterns.mjs
var PatternBoolean = "(true|false)";
var PatternNumber = "(0|[1-9][0-9]*)";
var PatternString = "(.*)";
var PatternNever = "(?!.*)";
var PatternBooleanExact = `^${PatternBoolean}$`;
var PatternNumberExact = `^${PatternNumber}$`;
var PatternStringExact = `^${PatternString}$`;
var PatternNeverExact = `^${PatternNever}$`;

// node_modules/@sinclair/typebox/build/esm/type/registry/format.mjs
var format_exports = {};
__export(format_exports, {
  Clear: () => Clear,
  Delete: () => Delete,
  Entries: () => Entries,
  Get: () => Get,
  Has: () => Has,
  Set: () => Set2
});
var map = /* @__PURE__ */ new Map();
function Entries() {
  return new Map(map);
}
function Clear() {
  return map.clear();
}
function Delete(format) {
  return map.delete(format);
}
function Has(format) {
  return map.has(format);
}
function Set2(format, func) {
  map.set(format, func);
}
function Get(format) {
  return map.get(format);
}

// node_modules/@sinclair/typebox/build/esm/type/registry/type.mjs
var type_exports2 = {};
__export(type_exports2, {
  Clear: () => Clear2,
  Delete: () => Delete2,
  Entries: () => Entries2,
  Get: () => Get2,
  Has: () => Has2,
  Set: () => Set3
});
var map2 = /* @__PURE__ */ new Map();
function Entries2() {
  return new Map(map2);
}
function Clear2() {
  return map2.clear();
}
function Delete2(kind) {
  return map2.delete(kind);
}
function Has2(kind) {
  return map2.has(kind);
}
function Set3(kind, func) {
  map2.set(kind, func);
}
function Get2(kind) {
  return map2.get(kind);
}

// node_modules/@sinclair/typebox/build/esm/type/sets/set.mjs
function SetIncludes(T, S) {
  return T.includes(S);
}
function SetDistinct(T) {
  return [...new Set(T)];
}
function SetIntersect(T, S) {
  return T.filter((L) => S.includes(L));
}
function SetIntersectManyResolve(T, Init) {
  return T.reduce((Acc, L) => {
    return SetIntersect(Acc, L);
  }, Init);
}
function SetIntersectMany(T) {
  return T.length === 1 ? T[0] : T.length > 1 ? SetIntersectManyResolve(T.slice(1), T[0]) : [];
}
function SetUnionMany(T) {
  const Acc = [];
  for (const L of T)
    Acc.push(...L);
  return Acc;
}

// node_modules/@sinclair/typebox/build/esm/type/any/any.mjs
function Any(options) {
  return CreateType({ [Kind]: "Any" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/array/array.mjs
function Array2(items, options) {
  return CreateType({ [Kind]: "Array", type: "array", items }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/argument/argument.mjs
function Argument2(index) {
  return CreateType({ [Kind]: "Argument", index });
}

// node_modules/@sinclair/typebox/build/esm/type/async-iterator/async-iterator.mjs
function AsyncIterator(items, options) {
  return CreateType({ [Kind]: "AsyncIterator", type: "AsyncIterator", items }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/computed/computed.mjs
function Computed(target, parameters, options) {
  return CreateType({ [Kind]: "Computed", target, parameters }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/discard/discard.mjs
function DiscardKey(value, key) {
  const { [key]: _, ...rest } = value;
  return rest;
}
function Discard(value, keys) {
  return keys.reduce((acc, key) => DiscardKey(acc, key), value);
}

// node_modules/@sinclair/typebox/build/esm/type/never/never.mjs
function Never(options) {
  return CreateType({ [Kind]: "Never", not: {} }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/mapped/mapped-result.mjs
function MappedResult(properties) {
  return CreateType({
    [Kind]: "MappedResult",
    properties
  });
}

// node_modules/@sinclair/typebox/build/esm/type/constructor/constructor.mjs
function Constructor(parameters, returns, options) {
  return CreateType({ [Kind]: "Constructor", type: "Constructor", parameters, returns }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/function/function.mjs
function Function(parameters, returns, options) {
  return CreateType({ [Kind]: "Function", type: "Function", parameters, returns }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/union/union-create.mjs
function UnionCreate(T, options) {
  return CreateType({ [Kind]: "Union", anyOf: T }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/union/union-evaluated.mjs
function IsUnionOptional(types) {
  return types.some((type) => IsOptional(type));
}
function RemoveOptionalFromRest(types) {
  return types.map((left) => IsOptional(left) ? RemoveOptionalFromType(left) : left);
}
function RemoveOptionalFromType(T) {
  return Discard(T, [OptionalKind]);
}
function ResolveUnion(types, options) {
  const isOptional = IsUnionOptional(types);
  return isOptional ? Optional(UnionCreate(RemoveOptionalFromRest(types), options)) : UnionCreate(RemoveOptionalFromRest(types), options);
}
function UnionEvaluated(T, options) {
  return T.length === 1 ? CreateType(T[0], options) : T.length === 0 ? Never(options) : ResolveUnion(T, options);
}

// node_modules/@sinclair/typebox/build/esm/type/union/union.mjs
function Union(types, options) {
  return types.length === 0 ? Never(options) : types.length === 1 ? CreateType(types[0], options) : UnionCreate(types, options);
}

// node_modules/@sinclair/typebox/build/esm/type/template-literal/parse.mjs
var TemplateLiteralParserError = class extends TypeBoxError {
};
function Unescape(pattern) {
  return pattern.replace(/\\\$/g, "$").replace(/\\\*/g, "*").replace(/\\\^/g, "^").replace(/\\\|/g, "|").replace(/\\\(/g, "(").replace(/\\\)/g, ")");
}
function IsNonEscaped(pattern, index, char) {
  return pattern[index] === char && pattern.charCodeAt(index - 1) !== 92;
}
function IsOpenParen(pattern, index) {
  return IsNonEscaped(pattern, index, "(");
}
function IsCloseParen(pattern, index) {
  return IsNonEscaped(pattern, index, ")");
}
function IsSeparator(pattern, index) {
  return IsNonEscaped(pattern, index, "|");
}
function IsGroup(pattern) {
  if (!(IsOpenParen(pattern, 0) && IsCloseParen(pattern, pattern.length - 1)))
    return false;
  let count = 0;
  for (let index = 0; index < pattern.length; index++) {
    if (IsOpenParen(pattern, index))
      count += 1;
    if (IsCloseParen(pattern, index))
      count -= 1;
    if (count === 0 && index !== pattern.length - 1)
      return false;
  }
  return true;
}
function InGroup(pattern) {
  return pattern.slice(1, pattern.length - 1);
}
function IsPrecedenceOr(pattern) {
  let count = 0;
  for (let index = 0; index < pattern.length; index++) {
    if (IsOpenParen(pattern, index))
      count += 1;
    if (IsCloseParen(pattern, index))
      count -= 1;
    if (IsSeparator(pattern, index) && count === 0)
      return true;
  }
  return false;
}
function IsPrecedenceAnd(pattern) {
  for (let index = 0; index < pattern.length; index++) {
    if (IsOpenParen(pattern, index))
      return true;
  }
  return false;
}
function Or(pattern) {
  let [count, start] = [0, 0];
  const expressions = [];
  for (let index = 0; index < pattern.length; index++) {
    if (IsOpenParen(pattern, index))
      count += 1;
    if (IsCloseParen(pattern, index))
      count -= 1;
    if (IsSeparator(pattern, index) && count === 0) {
      const range2 = pattern.slice(start, index);
      if (range2.length > 0)
        expressions.push(TemplateLiteralParse(range2));
      start = index + 1;
    }
  }
  const range = pattern.slice(start);
  if (range.length > 0)
    expressions.push(TemplateLiteralParse(range));
  if (expressions.length === 0)
    return { type: "const", const: "" };
  if (expressions.length === 1)
    return expressions[0];
  return { type: "or", expr: expressions };
}
function And(pattern) {
  function Group(value, index) {
    if (!IsOpenParen(value, index))
      throw new TemplateLiteralParserError(`TemplateLiteralParser: Index must point to open parens`);
    let count = 0;
    for (let scan = index; scan < value.length; scan++) {
      if (IsOpenParen(value, scan))
        count += 1;
      if (IsCloseParen(value, scan))
        count -= 1;
      if (count === 0)
        return [index, scan];
    }
    throw new TemplateLiteralParserError(`TemplateLiteralParser: Unclosed group parens in expression`);
  }
  function Range(pattern2, index) {
    for (let scan = index; scan < pattern2.length; scan++) {
      if (IsOpenParen(pattern2, scan))
        return [index, scan];
    }
    return [index, pattern2.length];
  }
  const expressions = [];
  for (let index = 0; index < pattern.length; index++) {
    if (IsOpenParen(pattern, index)) {
      const [start, end] = Group(pattern, index);
      const range = pattern.slice(start, end + 1);
      expressions.push(TemplateLiteralParse(range));
      index = end;
    } else {
      const [start, end] = Range(pattern, index);
      const range = pattern.slice(start, end);
      if (range.length > 0)
        expressions.push(TemplateLiteralParse(range));
      index = end - 1;
    }
  }
  return expressions.length === 0 ? { type: "const", const: "" } : expressions.length === 1 ? expressions[0] : { type: "and", expr: expressions };
}
function TemplateLiteralParse(pattern) {
  return IsGroup(pattern) ? TemplateLiteralParse(InGroup(pattern)) : IsPrecedenceOr(pattern) ? Or(pattern) : IsPrecedenceAnd(pattern) ? And(pattern) : { type: "const", const: Unescape(pattern) };
}
function TemplateLiteralParseExact(pattern) {
  return TemplateLiteralParse(pattern.slice(1, pattern.length - 1));
}

// node_modules/@sinclair/typebox/build/esm/type/template-literal/finite.mjs
var TemplateLiteralFiniteError = class extends TypeBoxError {
};
function IsNumberExpression(expression) {
  return expression.type === "or" && expression.expr.length === 2 && expression.expr[0].type === "const" && expression.expr[0].const === "0" && expression.expr[1].type === "const" && expression.expr[1].const === "[1-9][0-9]*";
}
function IsBooleanExpression(expression) {
  return expression.type === "or" && expression.expr.length === 2 && expression.expr[0].type === "const" && expression.expr[0].const === "true" && expression.expr[1].type === "const" && expression.expr[1].const === "false";
}
function IsStringExpression(expression) {
  return expression.type === "const" && expression.const === ".*";
}
function IsTemplateLiteralExpressionFinite(expression) {
  return IsNumberExpression(expression) || IsStringExpression(expression) ? false : IsBooleanExpression(expression) ? true : expression.type === "and" ? expression.expr.every((expr) => IsTemplateLiteralExpressionFinite(expr)) : expression.type === "or" ? expression.expr.every((expr) => IsTemplateLiteralExpressionFinite(expr)) : expression.type === "const" ? true : (() => {
    throw new TemplateLiteralFiniteError(`Unknown expression type`);
  })();
}
function IsTemplateLiteralFinite(schema) {
  const expression = TemplateLiteralParseExact(schema.pattern);
  return IsTemplateLiteralExpressionFinite(expression);
}

// node_modules/@sinclair/typebox/build/esm/type/template-literal/generate.mjs
var TemplateLiteralGenerateError = class extends TypeBoxError {
};
function* GenerateReduce(buffer) {
  if (buffer.length === 1)
    return yield* buffer[0];
  for (const left of buffer[0]) {
    for (const right of GenerateReduce(buffer.slice(1))) {
      yield `${left}${right}`;
    }
  }
}
function* GenerateAnd(expression) {
  return yield* GenerateReduce(expression.expr.map((expr) => [...TemplateLiteralExpressionGenerate(expr)]));
}
function* GenerateOr(expression) {
  for (const expr of expression.expr)
    yield* TemplateLiteralExpressionGenerate(expr);
}
function* GenerateConst(expression) {
  return yield expression.const;
}
function* TemplateLiteralExpressionGenerate(expression) {
  return expression.type === "and" ? yield* GenerateAnd(expression) : expression.type === "or" ? yield* GenerateOr(expression) : expression.type === "const" ? yield* GenerateConst(expression) : (() => {
    throw new TemplateLiteralGenerateError("Unknown expression");
  })();
}
function TemplateLiteralGenerate(schema) {
  const expression = TemplateLiteralParseExact(schema.pattern);
  return IsTemplateLiteralExpressionFinite(expression) ? [...TemplateLiteralExpressionGenerate(expression)] : [];
}

// node_modules/@sinclair/typebox/build/esm/type/literal/literal.mjs
function Literal(value, options) {
  return CreateType({
    [Kind]: "Literal",
    const: value,
    type: typeof value
  }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/boolean/boolean.mjs
function Boolean2(options) {
  return CreateType({ [Kind]: "Boolean", type: "boolean" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/bigint/bigint.mjs
function BigInt2(options) {
  return CreateType({ [Kind]: "BigInt", type: "bigint" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/number/number.mjs
function Number2(options) {
  return CreateType({ [Kind]: "Number", type: "number" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/string/string.mjs
function String2(options) {
  return CreateType({ [Kind]: "String", type: "string" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/template-literal/syntax.mjs
function* FromUnion(syntax) {
  const trim = syntax.trim().replace(/"|'/g, "");
  return trim === "boolean" ? yield Boolean2() : trim === "number" ? yield Number2() : trim === "bigint" ? yield BigInt2() : trim === "string" ? yield String2() : yield (() => {
    const literals = trim.split("|").map((literal) => Literal(literal.trim()));
    return literals.length === 0 ? Never() : literals.length === 1 ? literals[0] : UnionEvaluated(literals);
  })();
}
function* FromTerminal(syntax) {
  if (syntax[1] !== "{") {
    const L = Literal("$");
    const R = FromSyntax(syntax.slice(1));
    return yield* [L, ...R];
  }
  for (let i = 2; i < syntax.length; i++) {
    if (syntax[i] === "}") {
      const L = FromUnion(syntax.slice(2, i));
      const R = FromSyntax(syntax.slice(i + 1));
      return yield* [...L, ...R];
    }
  }
  yield Literal(syntax);
}
function* FromSyntax(syntax) {
  for (let i = 0; i < syntax.length; i++) {
    if (syntax[i] === "$") {
      const L = Literal(syntax.slice(0, i));
      const R = FromTerminal(syntax.slice(i));
      return yield* [L, ...R];
    }
  }
  yield Literal(syntax);
}
function TemplateLiteralSyntax(syntax) {
  return [...FromSyntax(syntax)];
}

// node_modules/@sinclair/typebox/build/esm/type/template-literal/pattern.mjs
var TemplateLiteralPatternError = class extends TypeBoxError {
};
function Escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function Visit2(schema, acc) {
  return IsTemplateLiteral(schema) ? schema.pattern.slice(1, schema.pattern.length - 1) : IsUnion(schema) ? `(${schema.anyOf.map((schema2) => Visit2(schema2, acc)).join("|")})` : IsNumber3(schema) ? `${acc}${PatternNumber}` : IsInteger2(schema) ? `${acc}${PatternNumber}` : IsBigInt3(schema) ? `${acc}${PatternNumber}` : IsString3(schema) ? `${acc}${PatternString}` : IsLiteral(schema) ? `${acc}${Escape(schema.const.toString())}` : IsBoolean3(schema) ? `${acc}${PatternBoolean}` : (() => {
    throw new TemplateLiteralPatternError(`Unexpected Kind '${schema[Kind]}'`);
  })();
}
function TemplateLiteralPattern(kinds) {
  return `^${kinds.map((schema) => Visit2(schema, "")).join("")}$`;
}

// node_modules/@sinclair/typebox/build/esm/type/template-literal/union.mjs
function TemplateLiteralToUnion(schema) {
  const R = TemplateLiteralGenerate(schema);
  const L = R.map((S) => Literal(S));
  return UnionEvaluated(L);
}

// node_modules/@sinclair/typebox/build/esm/type/template-literal/template-literal.mjs
function TemplateLiteral(unresolved, options) {
  const pattern = IsString(unresolved) ? TemplateLiteralPattern(TemplateLiteralSyntax(unresolved)) : TemplateLiteralPattern(unresolved);
  return CreateType({ [Kind]: "TemplateLiteral", type: "string", pattern }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/indexed/indexed-property-keys.mjs
function FromTemplateLiteral(templateLiteral) {
  const keys = TemplateLiteralGenerate(templateLiteral);
  return keys.map((key) => key.toString());
}
function FromUnion2(types) {
  const result = [];
  for (const type of types)
    result.push(...IndexPropertyKeys(type));
  return result;
}
function FromLiteral(literalValue) {
  return [literalValue.toString()];
}
function IndexPropertyKeys(type) {
  return [...new Set(IsTemplateLiteral(type) ? FromTemplateLiteral(type) : IsUnion(type) ? FromUnion2(type.anyOf) : IsLiteral(type) ? FromLiteral(type.const) : IsNumber3(type) ? ["[number]"] : IsInteger2(type) ? ["[number]"] : [])];
}

// node_modules/@sinclair/typebox/build/esm/type/indexed/indexed-from-mapped-result.mjs
function FromProperties(type, properties, options) {
  const result = {};
  for (const K2 of Object.getOwnPropertyNames(properties)) {
    result[K2] = Index(type, IndexPropertyKeys(properties[K2]), options);
  }
  return result;
}
function FromMappedResult(type, mappedResult, options) {
  return FromProperties(type, mappedResult.properties, options);
}
function IndexFromMappedResult(type, mappedResult, options) {
  const properties = FromMappedResult(type, mappedResult, options);
  return MappedResult(properties);
}

// node_modules/@sinclair/typebox/build/esm/type/indexed/indexed.mjs
function FromRest(types, key) {
  return types.map((type) => IndexFromPropertyKey(type, key));
}
function FromIntersectRest(types) {
  return types.filter((type) => !IsNever(type));
}
function FromIntersect(types, key) {
  return IntersectEvaluated(FromIntersectRest(FromRest(types, key)));
}
function FromUnionRest(types) {
  return types.some((L) => IsNever(L)) ? [] : types;
}
function FromUnion3(types, key) {
  return UnionEvaluated(FromUnionRest(FromRest(types, key)));
}
function FromTuple(types, key) {
  return key in types ? types[key] : key === "[number]" ? UnionEvaluated(types) : Never();
}
function FromArray(type, key) {
  return key === "[number]" ? type : Never();
}
function FromProperty(properties, propertyKey) {
  return propertyKey in properties ? properties[propertyKey] : Never();
}
function IndexFromPropertyKey(type, propertyKey) {
  return IsIntersect(type) ? FromIntersect(type.allOf, propertyKey) : IsUnion(type) ? FromUnion3(type.anyOf, propertyKey) : IsTuple(type) ? FromTuple(type.items ?? [], propertyKey) : IsArray3(type) ? FromArray(type.items, propertyKey) : IsObject3(type) ? FromProperty(type.properties, propertyKey) : Never();
}
function IndexFromPropertyKeys(type, propertyKeys) {
  return propertyKeys.map((propertyKey) => IndexFromPropertyKey(type, propertyKey));
}
function FromSchema(type, propertyKeys) {
  return UnionEvaluated(IndexFromPropertyKeys(type, propertyKeys));
}
function Index(type, key, options) {
  if (IsRef(type) || IsRef(key)) {
    const error = `Index types using Ref parameters require both Type and Key to be of TSchema`;
    if (!IsSchema(type) || !IsSchema(key))
      throw new TypeBoxError(error);
    return Computed("Index", [type, key]);
  }
  if (IsMappedResult(key))
    return IndexFromMappedResult(type, key, options);
  if (IsMappedKey(key))
    return IndexFromMappedKey(type, key, options);
  return CreateType(IsSchema(key) ? FromSchema(type, IndexPropertyKeys(key)) : FromSchema(type, key), options);
}

// node_modules/@sinclair/typebox/build/esm/type/indexed/indexed-from-mapped-key.mjs
function MappedIndexPropertyKey(type, key, options) {
  return { [key]: Index(type, [key], Clone(options)) };
}
function MappedIndexPropertyKeys(type, propertyKeys, options) {
  return propertyKeys.reduce((result, left) => {
    return { ...result, ...MappedIndexPropertyKey(type, left, options) };
  }, {});
}
function MappedIndexProperties(type, mappedKey, options) {
  return MappedIndexPropertyKeys(type, mappedKey.keys, options);
}
function IndexFromMappedKey(type, mappedKey, options) {
  const properties = MappedIndexProperties(type, mappedKey, options);
  return MappedResult(properties);
}

// node_modules/@sinclair/typebox/build/esm/type/iterator/iterator.mjs
function Iterator(items, options) {
  return CreateType({ [Kind]: "Iterator", type: "Iterator", items }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/object/object.mjs
function RequiredArray(properties) {
  return globalThis.Object.keys(properties).filter((key) => !IsOptional(properties[key]));
}
function _Object_(properties, options) {
  const required = RequiredArray(properties);
  const schema = required.length > 0 ? { [Kind]: "Object", type: "object", required, properties } : { [Kind]: "Object", type: "object", properties };
  return CreateType(schema, options);
}
var Object2 = _Object_;

// node_modules/@sinclair/typebox/build/esm/type/promise/promise.mjs
function Promise2(item, options) {
  return CreateType({ [Kind]: "Promise", type: "Promise", item }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/readonly/readonly.mjs
function RemoveReadonly(schema) {
  return CreateType(Discard(schema, [ReadonlyKind]));
}
function AddReadonly(schema) {
  return CreateType({ ...schema, [ReadonlyKind]: "Readonly" });
}
function ReadonlyWithFlag(schema, F) {
  return F === false ? RemoveReadonly(schema) : AddReadonly(schema);
}
function Readonly(schema, enable) {
  const F = enable ?? true;
  return IsMappedResult(schema) ? ReadonlyFromMappedResult(schema, F) : ReadonlyWithFlag(schema, F);
}

// node_modules/@sinclair/typebox/build/esm/type/readonly/readonly-from-mapped-result.mjs
function FromProperties2(K, F) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(K))
    Acc[K2] = Readonly(K[K2], F);
  return Acc;
}
function FromMappedResult2(R, F) {
  return FromProperties2(R.properties, F);
}
function ReadonlyFromMappedResult(R, F) {
  const P = FromMappedResult2(R, F);
  return MappedResult(P);
}

// node_modules/@sinclair/typebox/build/esm/type/tuple/tuple.mjs
function Tuple(types, options) {
  return CreateType(types.length > 0 ? { [Kind]: "Tuple", type: "array", items: types, additionalItems: false, minItems: types.length, maxItems: types.length } : { [Kind]: "Tuple", type: "array", minItems: types.length, maxItems: types.length }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/mapped/mapped.mjs
function FromMappedResult3(K, P) {
  return K in P ? FromSchemaType(K, P[K]) : MappedResult(P);
}
function MappedKeyToKnownMappedResultProperties(K) {
  return { [K]: Literal(K) };
}
function MappedKeyToUnknownMappedResultProperties(P) {
  const Acc = {};
  for (const L of P)
    Acc[L] = Literal(L);
  return Acc;
}
function MappedKeyToMappedResultProperties(K, P) {
  return SetIncludes(P, K) ? MappedKeyToKnownMappedResultProperties(K) : MappedKeyToUnknownMappedResultProperties(P);
}
function FromMappedKey(K, P) {
  const R = MappedKeyToMappedResultProperties(K, P);
  return FromMappedResult3(K, R);
}
function FromRest2(K, T) {
  return T.map((L) => FromSchemaType(K, L));
}
function FromProperties3(K, T) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(T))
    Acc[K2] = FromSchemaType(K, T[K2]);
  return Acc;
}
function FromSchemaType(K, T) {
  const options = { ...T };
  return (
    // unevaluated modifier types
    IsOptional(T) ? Optional(FromSchemaType(K, Discard(T, [OptionalKind]))) : IsReadonly(T) ? Readonly(FromSchemaType(K, Discard(T, [ReadonlyKind]))) : (
      // unevaluated mapped types
      IsMappedResult(T) ? FromMappedResult3(K, T.properties) : IsMappedKey(T) ? FromMappedKey(K, T.keys) : (
        // unevaluated types
        IsConstructor(T) ? Constructor(FromRest2(K, T.parameters), FromSchemaType(K, T.returns), options) : IsFunction3(T) ? Function(FromRest2(K, T.parameters), FromSchemaType(K, T.returns), options) : IsAsyncIterator3(T) ? AsyncIterator(FromSchemaType(K, T.items), options) : IsIterator3(T) ? Iterator(FromSchemaType(K, T.items), options) : IsIntersect(T) ? Intersect(FromRest2(K, T.allOf), options) : IsUnion(T) ? Union(FromRest2(K, T.anyOf), options) : IsTuple(T) ? Tuple(FromRest2(K, T.items ?? []), options) : IsObject3(T) ? Object2(FromProperties3(K, T.properties), options) : IsArray3(T) ? Array2(FromSchemaType(K, T.items), options) : IsPromise2(T) ? Promise2(FromSchemaType(K, T.item), options) : T
      )
    )
  );
}
function MappedFunctionReturnType(K, T) {
  const Acc = {};
  for (const L of K)
    Acc[L] = FromSchemaType(L, T);
  return Acc;
}
function Mapped(key, map3, options) {
  const K = IsSchema(key) ? IndexPropertyKeys(key) : key;
  const RT = map3({ [Kind]: "MappedKey", keys: K });
  const R = MappedFunctionReturnType(K, RT);
  return Object2(R, options);
}

// node_modules/@sinclair/typebox/build/esm/type/optional/optional.mjs
function RemoveOptional(schema) {
  return CreateType(Discard(schema, [OptionalKind]));
}
function AddOptional(schema) {
  return CreateType({ ...schema, [OptionalKind]: "Optional" });
}
function OptionalWithFlag(schema, F) {
  return F === false ? RemoveOptional(schema) : AddOptional(schema);
}
function Optional(schema, enable) {
  const F = enable ?? true;
  return IsMappedResult(schema) ? OptionalFromMappedResult(schema, F) : OptionalWithFlag(schema, F);
}

// node_modules/@sinclair/typebox/build/esm/type/optional/optional-from-mapped-result.mjs
function FromProperties4(P, F) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(P))
    Acc[K2] = Optional(P[K2], F);
  return Acc;
}
function FromMappedResult4(R, F) {
  return FromProperties4(R.properties, F);
}
function OptionalFromMappedResult(R, F) {
  const P = FromMappedResult4(R, F);
  return MappedResult(P);
}

// node_modules/@sinclair/typebox/build/esm/type/intersect/intersect-create.mjs
function IntersectCreate(T, options = {}) {
  const allObjects = T.every((schema) => IsObject3(schema));
  const clonedUnevaluatedProperties = IsSchema(options.unevaluatedProperties) ? { unevaluatedProperties: options.unevaluatedProperties } : {};
  return CreateType(options.unevaluatedProperties === false || IsSchema(options.unevaluatedProperties) || allObjects ? { ...clonedUnevaluatedProperties, [Kind]: "Intersect", type: "object", allOf: T } : { ...clonedUnevaluatedProperties, [Kind]: "Intersect", allOf: T }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/intersect/intersect-evaluated.mjs
function IsIntersectOptional(types) {
  return types.every((left) => IsOptional(left));
}
function RemoveOptionalFromType2(type) {
  return Discard(type, [OptionalKind]);
}
function RemoveOptionalFromRest2(types) {
  return types.map((left) => IsOptional(left) ? RemoveOptionalFromType2(left) : left);
}
function ResolveIntersect(types, options) {
  return IsIntersectOptional(types) ? Optional(IntersectCreate(RemoveOptionalFromRest2(types), options)) : IntersectCreate(RemoveOptionalFromRest2(types), options);
}
function IntersectEvaluated(types, options = {}) {
  if (types.length === 1)
    return CreateType(types[0], options);
  if (types.length === 0)
    return Never(options);
  if (types.some((schema) => IsTransform(schema)))
    throw new Error("Cannot intersect transform types");
  return ResolveIntersect(types, options);
}

// node_modules/@sinclair/typebox/build/esm/type/intersect/intersect.mjs
function Intersect(types, options) {
  if (types.length === 1)
    return CreateType(types[0], options);
  if (types.length === 0)
    return Never(options);
  if (types.some((schema) => IsTransform(schema)))
    throw new Error("Cannot intersect transform types");
  return IntersectCreate(types, options);
}

// node_modules/@sinclair/typebox/build/esm/type/ref/ref.mjs
function Ref(...args) {
  const [$ref, options] = typeof args[0] === "string" ? [args[0], args[1]] : [args[0].$id, args[1]];
  if (typeof $ref !== "string")
    throw new TypeBoxError("Ref: $ref must be a string");
  return CreateType({ [Kind]: "Ref", $ref }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/awaited/awaited.mjs
function FromComputed(target, parameters) {
  return Computed("Awaited", [Computed(target, parameters)]);
}
function FromRef($ref) {
  return Computed("Awaited", [Ref($ref)]);
}
function FromIntersect2(types) {
  return Intersect(FromRest3(types));
}
function FromUnion4(types) {
  return Union(FromRest3(types));
}
function FromPromise(type) {
  return Awaited(type);
}
function FromRest3(types) {
  return types.map((type) => Awaited(type));
}
function Awaited(type, options) {
  return CreateType(IsComputed(type) ? FromComputed(type.target, type.parameters) : IsIntersect(type) ? FromIntersect2(type.allOf) : IsUnion(type) ? FromUnion4(type.anyOf) : IsPromise2(type) ? FromPromise(type.item) : IsRef(type) ? FromRef(type.$ref) : type, options);
}

// node_modules/@sinclair/typebox/build/esm/type/keyof/keyof-property-keys.mjs
function FromRest4(types) {
  const result = [];
  for (const L of types)
    result.push(KeyOfPropertyKeys(L));
  return result;
}
function FromIntersect3(types) {
  const propertyKeysArray = FromRest4(types);
  const propertyKeys = SetUnionMany(propertyKeysArray);
  return propertyKeys;
}
function FromUnion5(types) {
  const propertyKeysArray = FromRest4(types);
  const propertyKeys = SetIntersectMany(propertyKeysArray);
  return propertyKeys;
}
function FromTuple2(types) {
  return types.map((_, indexer) => indexer.toString());
}
function FromArray2(_) {
  return ["[number]"];
}
function FromProperties5(T) {
  return globalThis.Object.getOwnPropertyNames(T);
}
function FromPatternProperties(patternProperties) {
  if (!includePatternProperties)
    return [];
  const patternPropertyKeys = globalThis.Object.getOwnPropertyNames(patternProperties);
  return patternPropertyKeys.map((key) => {
    return key[0] === "^" && key[key.length - 1] === "$" ? key.slice(1, key.length - 1) : key;
  });
}
function KeyOfPropertyKeys(type) {
  return IsIntersect(type) ? FromIntersect3(type.allOf) : IsUnion(type) ? FromUnion5(type.anyOf) : IsTuple(type) ? FromTuple2(type.items ?? []) : IsArray3(type) ? FromArray2(type.items) : IsObject3(type) ? FromProperties5(type.properties) : IsRecord(type) ? FromPatternProperties(type.patternProperties) : [];
}
var includePatternProperties = false;
function KeyOfPattern(schema) {
  includePatternProperties = true;
  const keys = KeyOfPropertyKeys(schema);
  includePatternProperties = false;
  const pattern = keys.map((key) => `(${key})`);
  return `^(${pattern.join("|")})$`;
}

// node_modules/@sinclair/typebox/build/esm/type/keyof/keyof.mjs
function FromComputed2(target, parameters) {
  return Computed("KeyOf", [Computed(target, parameters)]);
}
function FromRef2($ref) {
  return Computed("KeyOf", [Ref($ref)]);
}
function KeyOfFromType(type, options) {
  const propertyKeys = KeyOfPropertyKeys(type);
  const propertyKeyTypes = KeyOfPropertyKeysToRest(propertyKeys);
  const result = UnionEvaluated(propertyKeyTypes);
  return CreateType(result, options);
}
function KeyOfPropertyKeysToRest(propertyKeys) {
  return propertyKeys.map((L) => L === "[number]" ? Number2() : Literal(L));
}
function KeyOf(type, options) {
  return IsComputed(type) ? FromComputed2(type.target, type.parameters) : IsRef(type) ? FromRef2(type.$ref) : IsMappedResult(type) ? KeyOfFromMappedResult(type, options) : KeyOfFromType(type, options);
}

// node_modules/@sinclair/typebox/build/esm/type/keyof/keyof-from-mapped-result.mjs
function FromProperties6(properties, options) {
  const result = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(properties))
    result[K2] = KeyOf(properties[K2], Clone(options));
  return result;
}
function FromMappedResult5(mappedResult, options) {
  return FromProperties6(mappedResult.properties, options);
}
function KeyOfFromMappedResult(mappedResult, options) {
  const properties = FromMappedResult5(mappedResult, options);
  return MappedResult(properties);
}

// node_modules/@sinclair/typebox/build/esm/type/keyof/keyof-property-entries.mjs
function KeyOfPropertyEntries(schema) {
  const keys = KeyOfPropertyKeys(schema);
  const schemas = IndexFromPropertyKeys(schema, keys);
  return keys.map((_, index) => [keys[index], schemas[index]]);
}

// node_modules/@sinclair/typebox/build/esm/type/composite/composite.mjs
function CompositeKeys(T) {
  const Acc = [];
  for (const L of T)
    Acc.push(...KeyOfPropertyKeys(L));
  return SetDistinct(Acc);
}
function FilterNever(T) {
  return T.filter((L) => !IsNever(L));
}
function CompositeProperty(T, K) {
  const Acc = [];
  for (const L of T)
    Acc.push(...IndexFromPropertyKeys(L, [K]));
  return FilterNever(Acc);
}
function CompositeProperties(T, K) {
  const Acc = {};
  for (const L of K) {
    Acc[L] = IntersectEvaluated(CompositeProperty(T, L));
  }
  return Acc;
}
function Composite(T, options) {
  const K = CompositeKeys(T);
  const P = CompositeProperties(T, K);
  const R = Object2(P, options);
  return R;
}

// node_modules/@sinclair/typebox/build/esm/type/date/date.mjs
function Date2(options) {
  return CreateType({ [Kind]: "Date", type: "Date" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/null/null.mjs
function Null(options) {
  return CreateType({ [Kind]: "Null", type: "null" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/symbol/symbol.mjs
function Symbol2(options) {
  return CreateType({ [Kind]: "Symbol", type: "symbol" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/undefined/undefined.mjs
function Undefined(options) {
  return CreateType({ [Kind]: "Undefined", type: "undefined" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/uint8array/uint8array.mjs
function Uint8Array2(options) {
  return CreateType({ [Kind]: "Uint8Array", type: "Uint8Array" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/unknown/unknown.mjs
function Unknown(options) {
  return CreateType({ [Kind]: "Unknown" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/const/const.mjs
function FromArray3(T) {
  return T.map((L) => FromValue(L, false));
}
function FromProperties7(value) {
  const Acc = {};
  for (const K of globalThis.Object.getOwnPropertyNames(value))
    Acc[K] = Readonly(FromValue(value[K], false));
  return Acc;
}
function ConditionalReadonly(T, root) {
  return root === true ? T : Readonly(T);
}
function FromValue(value, root) {
  return IsAsyncIterator(value) ? ConditionalReadonly(Any(), root) : IsIterator(value) ? ConditionalReadonly(Any(), root) : IsArray(value) ? Readonly(Tuple(FromArray3(value))) : IsUint8Array(value) ? Uint8Array2() : IsDate(value) ? Date2() : IsObject(value) ? ConditionalReadonly(Object2(FromProperties7(value)), root) : IsFunction(value) ? ConditionalReadonly(Function([], Unknown()), root) : IsUndefined(value) ? Undefined() : IsNull(value) ? Null() : IsSymbol(value) ? Symbol2() : IsBigInt(value) ? BigInt2() : IsNumber(value) ? Literal(value) : IsBoolean(value) ? Literal(value) : IsString(value) ? Literal(value) : Object2({});
}
function Const(T, options) {
  return CreateType(FromValue(T, true), options);
}

// node_modules/@sinclair/typebox/build/esm/type/constructor-parameters/constructor-parameters.mjs
function ConstructorParameters(schema, options) {
  return IsConstructor(schema) ? Tuple(schema.parameters, options) : Never(options);
}

// node_modules/@sinclair/typebox/build/esm/type/enum/enum.mjs
function Enum(item, options) {
  if (IsUndefined(item))
    throw new Error("Enum undefined or empty");
  const values1 = globalThis.Object.getOwnPropertyNames(item).filter((key) => isNaN(key)).map((key) => item[key]);
  const values2 = [...new Set(values1)];
  const anyOf = values2.map((value) => Literal(value));
  return Union(anyOf, { ...options, [Hint]: "Enum" });
}

// node_modules/@sinclair/typebox/build/esm/type/extends/extends-check.mjs
var ExtendsResolverError = class extends TypeBoxError {
};
var ExtendsResult;
(function(ExtendsResult2) {
  ExtendsResult2[ExtendsResult2["Union"] = 0] = "Union";
  ExtendsResult2[ExtendsResult2["True"] = 1] = "True";
  ExtendsResult2[ExtendsResult2["False"] = 2] = "False";
})(ExtendsResult || (ExtendsResult = {}));
function IntoBooleanResult(result) {
  return result === ExtendsResult.False ? result : ExtendsResult.True;
}
function Throw(message) {
  throw new ExtendsResolverError(message);
}
function IsStructuralRight(right) {
  return type_exports.IsNever(right) || type_exports.IsIntersect(right) || type_exports.IsUnion(right) || type_exports.IsUnknown(right) || type_exports.IsAny(right);
}
function StructuralRight(left, right) {
  return type_exports.IsNever(right) ? FromNeverRight(left, right) : type_exports.IsIntersect(right) ? FromIntersectRight(left, right) : type_exports.IsUnion(right) ? FromUnionRight(left, right) : type_exports.IsUnknown(right) ? FromUnknownRight(left, right) : type_exports.IsAny(right) ? FromAnyRight(left, right) : Throw("StructuralRight");
}
function FromAnyRight(left, right) {
  return ExtendsResult.True;
}
function FromAny(left, right) {
  return type_exports.IsIntersect(right) ? FromIntersectRight(left, right) : type_exports.IsUnion(right) && right.anyOf.some((schema) => type_exports.IsAny(schema) || type_exports.IsUnknown(schema)) ? ExtendsResult.True : type_exports.IsUnion(right) ? ExtendsResult.Union : type_exports.IsUnknown(right) ? ExtendsResult.True : type_exports.IsAny(right) ? ExtendsResult.True : ExtendsResult.Union;
}
function FromArrayRight(left, right) {
  return type_exports.IsUnknown(left) ? ExtendsResult.False : type_exports.IsAny(left) ? ExtendsResult.Union : type_exports.IsNever(left) ? ExtendsResult.True : ExtendsResult.False;
}
function FromArray4(left, right) {
  return type_exports.IsObject(right) && IsObjectArrayLike(right) ? ExtendsResult.True : IsStructuralRight(right) ? StructuralRight(left, right) : !type_exports.IsArray(right) ? ExtendsResult.False : IntoBooleanResult(Visit3(left.items, right.items));
}
function FromAsyncIterator(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : !type_exports.IsAsyncIterator(right) ? ExtendsResult.False : IntoBooleanResult(Visit3(left.items, right.items));
}
function FromBigInt(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsRecord(right) ? FromRecordRight(left, right) : type_exports.IsBigInt(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromBooleanRight(left, right) {
  return type_exports.IsLiteralBoolean(left) ? ExtendsResult.True : type_exports.IsBoolean(left) ? ExtendsResult.True : ExtendsResult.False;
}
function FromBoolean(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsRecord(right) ? FromRecordRight(left, right) : type_exports.IsBoolean(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromConstructor(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : !type_exports.IsConstructor(right) ? ExtendsResult.False : left.parameters.length > right.parameters.length ? ExtendsResult.False : !left.parameters.every((schema, index) => IntoBooleanResult(Visit3(right.parameters[index], schema)) === ExtendsResult.True) ? ExtendsResult.False : IntoBooleanResult(Visit3(left.returns, right.returns));
}
function FromDate(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsRecord(right) ? FromRecordRight(left, right) : type_exports.IsDate(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromFunction(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : !type_exports.IsFunction(right) ? ExtendsResult.False : left.parameters.length > right.parameters.length ? ExtendsResult.False : !left.parameters.every((schema, index) => IntoBooleanResult(Visit3(right.parameters[index], schema)) === ExtendsResult.True) ? ExtendsResult.False : IntoBooleanResult(Visit3(left.returns, right.returns));
}
function FromIntegerRight(left, right) {
  return type_exports.IsLiteral(left) && value_exports.IsNumber(left.const) ? ExtendsResult.True : type_exports.IsNumber(left) || type_exports.IsInteger(left) ? ExtendsResult.True : ExtendsResult.False;
}
function FromInteger(left, right) {
  return type_exports.IsInteger(right) || type_exports.IsNumber(right) ? ExtendsResult.True : IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsRecord(right) ? FromRecordRight(left, right) : ExtendsResult.False;
}
function FromIntersectRight(left, right) {
  return right.allOf.every((schema) => Visit3(left, schema) === ExtendsResult.True) ? ExtendsResult.True : ExtendsResult.False;
}
function FromIntersect4(left, right) {
  return left.allOf.some((schema) => Visit3(schema, right) === ExtendsResult.True) ? ExtendsResult.True : ExtendsResult.False;
}
function FromIterator(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : !type_exports.IsIterator(right) ? ExtendsResult.False : IntoBooleanResult(Visit3(left.items, right.items));
}
function FromLiteral2(left, right) {
  return type_exports.IsLiteral(right) && right.const === left.const ? ExtendsResult.True : IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsRecord(right) ? FromRecordRight(left, right) : type_exports.IsString(right) ? FromStringRight(left, right) : type_exports.IsNumber(right) ? FromNumberRight(left, right) : type_exports.IsInteger(right) ? FromIntegerRight(left, right) : type_exports.IsBoolean(right) ? FromBooleanRight(left, right) : ExtendsResult.False;
}
function FromNeverRight(left, right) {
  return ExtendsResult.False;
}
function FromNever(left, right) {
  return ExtendsResult.True;
}
function UnwrapTNot(schema) {
  let [current, depth] = [schema, 0];
  while (true) {
    if (!type_exports.IsNot(current))
      break;
    current = current.not;
    depth += 1;
  }
  return depth % 2 === 0 ? current : Unknown();
}
function FromNot(left, right) {
  return type_exports.IsNot(left) ? Visit3(UnwrapTNot(left), right) : type_exports.IsNot(right) ? Visit3(left, UnwrapTNot(right)) : Throw("Invalid fallthrough for Not");
}
function FromNull(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsRecord(right) ? FromRecordRight(left, right) : type_exports.IsNull(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromNumberRight(left, right) {
  return type_exports.IsLiteralNumber(left) ? ExtendsResult.True : type_exports.IsNumber(left) || type_exports.IsInteger(left) ? ExtendsResult.True : ExtendsResult.False;
}
function FromNumber(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsRecord(right) ? FromRecordRight(left, right) : type_exports.IsInteger(right) || type_exports.IsNumber(right) ? ExtendsResult.True : ExtendsResult.False;
}
function IsObjectPropertyCount(schema, count) {
  return Object.getOwnPropertyNames(schema.properties).length === count;
}
function IsObjectStringLike(schema) {
  return IsObjectArrayLike(schema);
}
function IsObjectSymbolLike(schema) {
  return IsObjectPropertyCount(schema, 0) || IsObjectPropertyCount(schema, 1) && "description" in schema.properties && type_exports.IsUnion(schema.properties.description) && schema.properties.description.anyOf.length === 2 && (type_exports.IsString(schema.properties.description.anyOf[0]) && type_exports.IsUndefined(schema.properties.description.anyOf[1]) || type_exports.IsString(schema.properties.description.anyOf[1]) && type_exports.IsUndefined(schema.properties.description.anyOf[0]));
}
function IsObjectNumberLike(schema) {
  return IsObjectPropertyCount(schema, 0);
}
function IsObjectBooleanLike(schema) {
  return IsObjectPropertyCount(schema, 0);
}
function IsObjectBigIntLike(schema) {
  return IsObjectPropertyCount(schema, 0);
}
function IsObjectDateLike(schema) {
  return IsObjectPropertyCount(schema, 0);
}
function IsObjectUint8ArrayLike(schema) {
  return IsObjectArrayLike(schema);
}
function IsObjectFunctionLike(schema) {
  const length = Number2();
  return IsObjectPropertyCount(schema, 0) || IsObjectPropertyCount(schema, 1) && "length" in schema.properties && IntoBooleanResult(Visit3(schema.properties["length"], length)) === ExtendsResult.True;
}
function IsObjectConstructorLike(schema) {
  return IsObjectPropertyCount(schema, 0);
}
function IsObjectArrayLike(schema) {
  const length = Number2();
  return IsObjectPropertyCount(schema, 0) || IsObjectPropertyCount(schema, 1) && "length" in schema.properties && IntoBooleanResult(Visit3(schema.properties["length"], length)) === ExtendsResult.True;
}
function IsObjectPromiseLike(schema) {
  const then = Function([Any()], Any());
  return IsObjectPropertyCount(schema, 0) || IsObjectPropertyCount(schema, 1) && "then" in schema.properties && IntoBooleanResult(Visit3(schema.properties["then"], then)) === ExtendsResult.True;
}
function Property(left, right) {
  return Visit3(left, right) === ExtendsResult.False ? ExtendsResult.False : type_exports.IsOptional(left) && !type_exports.IsOptional(right) ? ExtendsResult.False : ExtendsResult.True;
}
function FromObjectRight(left, right) {
  return type_exports.IsUnknown(left) ? ExtendsResult.False : type_exports.IsAny(left) ? ExtendsResult.Union : type_exports.IsNever(left) || type_exports.IsLiteralString(left) && IsObjectStringLike(right) || type_exports.IsLiteralNumber(left) && IsObjectNumberLike(right) || type_exports.IsLiteralBoolean(left) && IsObjectBooleanLike(right) || type_exports.IsSymbol(left) && IsObjectSymbolLike(right) || type_exports.IsBigInt(left) && IsObjectBigIntLike(right) || type_exports.IsString(left) && IsObjectStringLike(right) || type_exports.IsSymbol(left) && IsObjectSymbolLike(right) || type_exports.IsNumber(left) && IsObjectNumberLike(right) || type_exports.IsInteger(left) && IsObjectNumberLike(right) || type_exports.IsBoolean(left) && IsObjectBooleanLike(right) || type_exports.IsUint8Array(left) && IsObjectUint8ArrayLike(right) || type_exports.IsDate(left) && IsObjectDateLike(right) || type_exports.IsConstructor(left) && IsObjectConstructorLike(right) || type_exports.IsFunction(left) && IsObjectFunctionLike(right) ? ExtendsResult.True : type_exports.IsRecord(left) && type_exports.IsString(RecordKey(left)) ? (() => {
    return right[Hint] === "Record" ? ExtendsResult.True : ExtendsResult.False;
  })() : type_exports.IsRecord(left) && type_exports.IsNumber(RecordKey(left)) ? (() => {
    return IsObjectPropertyCount(right, 0) ? ExtendsResult.True : ExtendsResult.False;
  })() : ExtendsResult.False;
}
function FromObject(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsRecord(right) ? FromRecordRight(left, right) : !type_exports.IsObject(right) ? ExtendsResult.False : (() => {
    for (const key of Object.getOwnPropertyNames(right.properties)) {
      if (!(key in left.properties) && !type_exports.IsOptional(right.properties[key])) {
        return ExtendsResult.False;
      }
      if (type_exports.IsOptional(right.properties[key])) {
        return ExtendsResult.True;
      }
      if (Property(left.properties[key], right.properties[key]) === ExtendsResult.False) {
        return ExtendsResult.False;
      }
    }
    return ExtendsResult.True;
  })();
}
function FromPromise2(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) && IsObjectPromiseLike(right) ? ExtendsResult.True : !type_exports.IsPromise(right) ? ExtendsResult.False : IntoBooleanResult(Visit3(left.item, right.item));
}
function RecordKey(schema) {
  return PatternNumberExact in schema.patternProperties ? Number2() : PatternStringExact in schema.patternProperties ? String2() : Throw("Unknown record key pattern");
}
function RecordValue(schema) {
  return PatternNumberExact in schema.patternProperties ? schema.patternProperties[PatternNumberExact] : PatternStringExact in schema.patternProperties ? schema.patternProperties[PatternStringExact] : Throw("Unable to get record value schema");
}
function FromRecordRight(left, right) {
  const [Key, Value] = [RecordKey(right), RecordValue(right)];
  return type_exports.IsLiteralString(left) && type_exports.IsNumber(Key) && IntoBooleanResult(Visit3(left, Value)) === ExtendsResult.True ? ExtendsResult.True : type_exports.IsUint8Array(left) && type_exports.IsNumber(Key) ? Visit3(left, Value) : type_exports.IsString(left) && type_exports.IsNumber(Key) ? Visit3(left, Value) : type_exports.IsArray(left) && type_exports.IsNumber(Key) ? Visit3(left, Value) : type_exports.IsObject(left) ? (() => {
    for (const key of Object.getOwnPropertyNames(left.properties)) {
      if (Property(Value, left.properties[key]) === ExtendsResult.False) {
        return ExtendsResult.False;
      }
    }
    return ExtendsResult.True;
  })() : ExtendsResult.False;
}
function FromRecord(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : !type_exports.IsRecord(right) ? ExtendsResult.False : Visit3(RecordValue(left), RecordValue(right));
}
function FromRegExp(left, right) {
  const L = type_exports.IsRegExp(left) ? String2() : left;
  const R = type_exports.IsRegExp(right) ? String2() : right;
  return Visit3(L, R);
}
function FromStringRight(left, right) {
  return type_exports.IsLiteral(left) && value_exports.IsString(left.const) ? ExtendsResult.True : type_exports.IsString(left) ? ExtendsResult.True : ExtendsResult.False;
}
function FromString(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsRecord(right) ? FromRecordRight(left, right) : type_exports.IsString(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromSymbol(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsRecord(right) ? FromRecordRight(left, right) : type_exports.IsSymbol(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromTemplateLiteral2(left, right) {
  return type_exports.IsTemplateLiteral(left) ? Visit3(TemplateLiteralToUnion(left), right) : type_exports.IsTemplateLiteral(right) ? Visit3(left, TemplateLiteralToUnion(right)) : Throw("Invalid fallthrough for TemplateLiteral");
}
function IsArrayOfTuple(left, right) {
  return type_exports.IsArray(right) && left.items !== void 0 && left.items.every((schema) => Visit3(schema, right.items) === ExtendsResult.True);
}
function FromTupleRight(left, right) {
  return type_exports.IsNever(left) ? ExtendsResult.True : type_exports.IsUnknown(left) ? ExtendsResult.False : type_exports.IsAny(left) ? ExtendsResult.Union : ExtendsResult.False;
}
function FromTuple3(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) && IsObjectArrayLike(right) ? ExtendsResult.True : type_exports.IsArray(right) && IsArrayOfTuple(left, right) ? ExtendsResult.True : !type_exports.IsTuple(right) ? ExtendsResult.False : value_exports.IsUndefined(left.items) && !value_exports.IsUndefined(right.items) || !value_exports.IsUndefined(left.items) && value_exports.IsUndefined(right.items) ? ExtendsResult.False : value_exports.IsUndefined(left.items) && !value_exports.IsUndefined(right.items) ? ExtendsResult.True : left.items.every((schema, index) => Visit3(schema, right.items[index]) === ExtendsResult.True) ? ExtendsResult.True : ExtendsResult.False;
}
function FromUint8Array(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsRecord(right) ? FromRecordRight(left, right) : type_exports.IsUint8Array(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromUndefined(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsRecord(right) ? FromRecordRight(left, right) : type_exports.IsVoid(right) ? FromVoidRight(left, right) : type_exports.IsUndefined(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromUnionRight(left, right) {
  return right.anyOf.some((schema) => Visit3(left, schema) === ExtendsResult.True) ? ExtendsResult.True : ExtendsResult.False;
}
function FromUnion6(left, right) {
  return left.anyOf.every((schema) => Visit3(schema, right) === ExtendsResult.True) ? ExtendsResult.True : ExtendsResult.False;
}
function FromUnknownRight(left, right) {
  return ExtendsResult.True;
}
function FromUnknown(left, right) {
  return type_exports.IsNever(right) ? FromNeverRight(left, right) : type_exports.IsIntersect(right) ? FromIntersectRight(left, right) : type_exports.IsUnion(right) ? FromUnionRight(left, right) : type_exports.IsAny(right) ? FromAnyRight(left, right) : type_exports.IsString(right) ? FromStringRight(left, right) : type_exports.IsNumber(right) ? FromNumberRight(left, right) : type_exports.IsInteger(right) ? FromIntegerRight(left, right) : type_exports.IsBoolean(right) ? FromBooleanRight(left, right) : type_exports.IsArray(right) ? FromArrayRight(left, right) : type_exports.IsTuple(right) ? FromTupleRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsUnknown(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromVoidRight(left, right) {
  return type_exports.IsUndefined(left) ? ExtendsResult.True : type_exports.IsUndefined(left) ? ExtendsResult.True : ExtendsResult.False;
}
function FromVoid(left, right) {
  return type_exports.IsIntersect(right) ? FromIntersectRight(left, right) : type_exports.IsUnion(right) ? FromUnionRight(left, right) : type_exports.IsUnknown(right) ? FromUnknownRight(left, right) : type_exports.IsAny(right) ? FromAnyRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsVoid(right) ? ExtendsResult.True : ExtendsResult.False;
}
function Visit3(left, right) {
  return (
    // resolvable
    type_exports.IsTemplateLiteral(left) || type_exports.IsTemplateLiteral(right) ? FromTemplateLiteral2(left, right) : type_exports.IsRegExp(left) || type_exports.IsRegExp(right) ? FromRegExp(left, right) : type_exports.IsNot(left) || type_exports.IsNot(right) ? FromNot(left, right) : (
      // standard
      type_exports.IsAny(left) ? FromAny(left, right) : type_exports.IsArray(left) ? FromArray4(left, right) : type_exports.IsBigInt(left) ? FromBigInt(left, right) : type_exports.IsBoolean(left) ? FromBoolean(left, right) : type_exports.IsAsyncIterator(left) ? FromAsyncIterator(left, right) : type_exports.IsConstructor(left) ? FromConstructor(left, right) : type_exports.IsDate(left) ? FromDate(left, right) : type_exports.IsFunction(left) ? FromFunction(left, right) : type_exports.IsInteger(left) ? FromInteger(left, right) : type_exports.IsIntersect(left) ? FromIntersect4(left, right) : type_exports.IsIterator(left) ? FromIterator(left, right) : type_exports.IsLiteral(left) ? FromLiteral2(left, right) : type_exports.IsNever(left) ? FromNever(left, right) : type_exports.IsNull(left) ? FromNull(left, right) : type_exports.IsNumber(left) ? FromNumber(left, right) : type_exports.IsObject(left) ? FromObject(left, right) : type_exports.IsRecord(left) ? FromRecord(left, right) : type_exports.IsString(left) ? FromString(left, right) : type_exports.IsSymbol(left) ? FromSymbol(left, right) : type_exports.IsTuple(left) ? FromTuple3(left, right) : type_exports.IsPromise(left) ? FromPromise2(left, right) : type_exports.IsUint8Array(left) ? FromUint8Array(left, right) : type_exports.IsUndefined(left) ? FromUndefined(left, right) : type_exports.IsUnion(left) ? FromUnion6(left, right) : type_exports.IsUnknown(left) ? FromUnknown(left, right) : type_exports.IsVoid(left) ? FromVoid(left, right) : Throw(`Unknown left type operand '${left[Kind]}'`)
    )
  );
}
function ExtendsCheck(left, right) {
  return Visit3(left, right);
}

// node_modules/@sinclair/typebox/build/esm/type/extends/extends-from-mapped-result.mjs
function FromProperties8(P, Right, True, False, options) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(P))
    Acc[K2] = Extends(P[K2], Right, True, False, Clone(options));
  return Acc;
}
function FromMappedResult6(Left, Right, True, False, options) {
  return FromProperties8(Left.properties, Right, True, False, options);
}
function ExtendsFromMappedResult(Left, Right, True, False, options) {
  const P = FromMappedResult6(Left, Right, True, False, options);
  return MappedResult(P);
}

// node_modules/@sinclair/typebox/build/esm/type/extends/extends.mjs
function ExtendsResolve(left, right, trueType, falseType) {
  const R = ExtendsCheck(left, right);
  return R === ExtendsResult.Union ? Union([trueType, falseType]) : R === ExtendsResult.True ? trueType : falseType;
}
function Extends(L, R, T, F, options) {
  return IsMappedResult(L) ? ExtendsFromMappedResult(L, R, T, F, options) : IsMappedKey(L) ? CreateType(ExtendsFromMappedKey(L, R, T, F, options)) : CreateType(ExtendsResolve(L, R, T, F), options);
}

// node_modules/@sinclair/typebox/build/esm/type/extends/extends-from-mapped-key.mjs
function FromPropertyKey(K, U, L, R, options) {
  return {
    [K]: Extends(Literal(K), U, L, R, Clone(options))
  };
}
function FromPropertyKeys(K, U, L, R, options) {
  return K.reduce((Acc, LK) => {
    return { ...Acc, ...FromPropertyKey(LK, U, L, R, options) };
  }, {});
}
function FromMappedKey2(K, U, L, R, options) {
  return FromPropertyKeys(K.keys, U, L, R, options);
}
function ExtendsFromMappedKey(T, U, L, R, options) {
  const P = FromMappedKey2(T, U, L, R, options);
  return MappedResult(P);
}

// node_modules/@sinclair/typebox/build/esm/type/extends/extends-undefined.mjs
function Intersect2(schema) {
  return schema.allOf.every((schema2) => ExtendsUndefinedCheck(schema2));
}
function Union2(schema) {
  return schema.anyOf.some((schema2) => ExtendsUndefinedCheck(schema2));
}
function Not(schema) {
  return !ExtendsUndefinedCheck(schema.not);
}
function ExtendsUndefinedCheck(schema) {
  return schema[Kind] === "Intersect" ? Intersect2(schema) : schema[Kind] === "Union" ? Union2(schema) : schema[Kind] === "Not" ? Not(schema) : schema[Kind] === "Undefined" ? true : false;
}

// node_modules/@sinclair/typebox/build/esm/type/exclude/exclude-from-template-literal.mjs
function ExcludeFromTemplateLiteral(L, R) {
  return Exclude(TemplateLiteralToUnion(L), R);
}

// node_modules/@sinclair/typebox/build/esm/type/exclude/exclude.mjs
function ExcludeRest(L, R) {
  const excluded = L.filter((inner) => ExtendsCheck(inner, R) === ExtendsResult.False);
  return excluded.length === 1 ? excluded[0] : Union(excluded);
}
function Exclude(L, R, options = {}) {
  if (IsTemplateLiteral(L))
    return CreateType(ExcludeFromTemplateLiteral(L, R), options);
  if (IsMappedResult(L))
    return CreateType(ExcludeFromMappedResult(L, R), options);
  return CreateType(IsUnion(L) ? ExcludeRest(L.anyOf, R) : ExtendsCheck(L, R) !== ExtendsResult.False ? Never() : L, options);
}

// node_modules/@sinclair/typebox/build/esm/type/exclude/exclude-from-mapped-result.mjs
function FromProperties9(P, U) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(P))
    Acc[K2] = Exclude(P[K2], U);
  return Acc;
}
function FromMappedResult7(R, T) {
  return FromProperties9(R.properties, T);
}
function ExcludeFromMappedResult(R, T) {
  const P = FromMappedResult7(R, T);
  return MappedResult(P);
}

// node_modules/@sinclair/typebox/build/esm/type/extract/extract-from-template-literal.mjs
function ExtractFromTemplateLiteral(L, R) {
  return Extract(TemplateLiteralToUnion(L), R);
}

// node_modules/@sinclair/typebox/build/esm/type/extract/extract.mjs
function ExtractRest(L, R) {
  const extracted = L.filter((inner) => ExtendsCheck(inner, R) !== ExtendsResult.False);
  return extracted.length === 1 ? extracted[0] : Union(extracted);
}
function Extract(L, R, options) {
  if (IsTemplateLiteral(L))
    return CreateType(ExtractFromTemplateLiteral(L, R), options);
  if (IsMappedResult(L))
    return CreateType(ExtractFromMappedResult(L, R), options);
  return CreateType(IsUnion(L) ? ExtractRest(L.anyOf, R) : ExtendsCheck(L, R) !== ExtendsResult.False ? L : Never(), options);
}

// node_modules/@sinclair/typebox/build/esm/type/extract/extract-from-mapped-result.mjs
function FromProperties10(P, T) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(P))
    Acc[K2] = Extract(P[K2], T);
  return Acc;
}
function FromMappedResult8(R, T) {
  return FromProperties10(R.properties, T);
}
function ExtractFromMappedResult(R, T) {
  const P = FromMappedResult8(R, T);
  return MappedResult(P);
}

// node_modules/@sinclair/typebox/build/esm/type/instance-type/instance-type.mjs
function InstanceType(schema, options) {
  return IsConstructor(schema) ? CreateType(schema.returns, options) : Never(options);
}

// node_modules/@sinclair/typebox/build/esm/type/readonly-optional/readonly-optional.mjs
function ReadonlyOptional(schema) {
  return Readonly(Optional(schema));
}

// node_modules/@sinclair/typebox/build/esm/type/record/record.mjs
function RecordCreateFromPattern(pattern, T, options) {
  return CreateType({ [Kind]: "Record", type: "object", patternProperties: { [pattern]: T } }, options);
}
function RecordCreateFromKeys(K, T, options) {
  const result = {};
  for (const K2 of K)
    result[K2] = T;
  return Object2(result, { ...options, [Hint]: "Record" });
}
function FromTemplateLiteralKey(K, T, options) {
  return IsTemplateLiteralFinite(K) ? RecordCreateFromKeys(IndexPropertyKeys(K), T, options) : RecordCreateFromPattern(K.pattern, T, options);
}
function FromUnionKey(key, type, options) {
  return RecordCreateFromKeys(IndexPropertyKeys(Union(key)), type, options);
}
function FromLiteralKey(key, type, options) {
  return RecordCreateFromKeys([key.toString()], type, options);
}
function FromRegExpKey(key, type, options) {
  return RecordCreateFromPattern(key.source, type, options);
}
function FromStringKey(key, type, options) {
  const pattern = IsUndefined(key.pattern) ? PatternStringExact : key.pattern;
  return RecordCreateFromPattern(pattern, type, options);
}
function FromAnyKey(_, type, options) {
  return RecordCreateFromPattern(PatternStringExact, type, options);
}
function FromNeverKey(_key, type, options) {
  return RecordCreateFromPattern(PatternNeverExact, type, options);
}
function FromBooleanKey(_key, type, options) {
  return Object2({ true: type, false: type }, options);
}
function FromIntegerKey(_key, type, options) {
  return RecordCreateFromPattern(PatternNumberExact, type, options);
}
function FromNumberKey(_, type, options) {
  return RecordCreateFromPattern(PatternNumberExact, type, options);
}
function Record(key, type, options = {}) {
  return IsUnion(key) ? FromUnionKey(key.anyOf, type, options) : IsTemplateLiteral(key) ? FromTemplateLiteralKey(key, type, options) : IsLiteral(key) ? FromLiteralKey(key.const, type, options) : IsBoolean3(key) ? FromBooleanKey(key, type, options) : IsInteger2(key) ? FromIntegerKey(key, type, options) : IsNumber3(key) ? FromNumberKey(key, type, options) : IsRegExp2(key) ? FromRegExpKey(key, type, options) : IsString3(key) ? FromStringKey(key, type, options) : IsAny(key) ? FromAnyKey(key, type, options) : IsNever(key) ? FromNeverKey(key, type, options) : Never(options);
}
function RecordPattern(record) {
  return globalThis.Object.getOwnPropertyNames(record.patternProperties)[0];
}
function RecordKey2(type) {
  const pattern = RecordPattern(type);
  return pattern === PatternStringExact ? String2() : pattern === PatternNumberExact ? Number2() : String2({ pattern });
}
function RecordValue2(type) {
  return type.patternProperties[RecordPattern(type)];
}

// node_modules/@sinclair/typebox/build/esm/type/instantiate/instantiate.mjs
function FromConstructor2(args, type) {
  type.parameters = FromTypes(args, type.parameters);
  type.returns = FromType(args, type.returns);
  return type;
}
function FromFunction2(args, type) {
  type.parameters = FromTypes(args, type.parameters);
  type.returns = FromType(args, type.returns);
  return type;
}
function FromIntersect5(args, type) {
  type.allOf = FromTypes(args, type.allOf);
  return type;
}
function FromUnion7(args, type) {
  type.anyOf = FromTypes(args, type.anyOf);
  return type;
}
function FromTuple4(args, type) {
  if (IsUndefined(type.items))
    return type;
  type.items = FromTypes(args, type.items);
  return type;
}
function FromArray5(args, type) {
  type.items = FromType(args, type.items);
  return type;
}
function FromAsyncIterator2(args, type) {
  type.items = FromType(args, type.items);
  return type;
}
function FromIterator2(args, type) {
  type.items = FromType(args, type.items);
  return type;
}
function FromPromise3(args, type) {
  type.item = FromType(args, type.item);
  return type;
}
function FromObject2(args, type) {
  const mappedProperties = FromProperties11(args, type.properties);
  return { ...type, ...Object2(mappedProperties) };
}
function FromRecord2(args, type) {
  const mappedKey = FromType(args, RecordKey2(type));
  const mappedValue = FromType(args, RecordValue2(type));
  const result = Record(mappedKey, mappedValue);
  return { ...type, ...result };
}
function FromArgument(args, argument) {
  return argument.index in args ? args[argument.index] : Unknown();
}
function FromProperty2(args, type) {
  const isReadonly = IsReadonly(type);
  const isOptional = IsOptional(type);
  const mapped = FromType(args, type);
  return isReadonly && isOptional ? ReadonlyOptional(mapped) : isReadonly && !isOptional ? Readonly(mapped) : !isReadonly && isOptional ? Optional(mapped) : mapped;
}
function FromProperties11(args, properties) {
  return globalThis.Object.getOwnPropertyNames(properties).reduce((result, key) => {
    return { ...result, [key]: FromProperty2(args, properties[key]) };
  }, {});
}
function FromTypes(args, types) {
  return types.map((type) => FromType(args, type));
}
function FromType(args, type) {
  return IsConstructor(type) ? FromConstructor2(args, type) : IsFunction3(type) ? FromFunction2(args, type) : IsIntersect(type) ? FromIntersect5(args, type) : IsUnion(type) ? FromUnion7(args, type) : IsTuple(type) ? FromTuple4(args, type) : IsArray3(type) ? FromArray5(args, type) : IsAsyncIterator3(type) ? FromAsyncIterator2(args, type) : IsIterator3(type) ? FromIterator2(args, type) : IsPromise2(type) ? FromPromise3(args, type) : IsObject3(type) ? FromObject2(args, type) : IsRecord(type) ? FromRecord2(args, type) : IsArgument(type) ? FromArgument(args, type) : type;
}
function Instantiate(type, args) {
  return FromType(args, CloneType(type));
}

// node_modules/@sinclair/typebox/build/esm/type/integer/integer.mjs
function Integer(options) {
  return CreateType({ [Kind]: "Integer", type: "integer" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/intrinsic/intrinsic-from-mapped-key.mjs
function MappedIntrinsicPropertyKey(K, M, options) {
  return {
    [K]: Intrinsic(Literal(K), M, Clone(options))
  };
}
function MappedIntrinsicPropertyKeys(K, M, options) {
  const result = K.reduce((Acc, L) => {
    return { ...Acc, ...MappedIntrinsicPropertyKey(L, M, options) };
  }, {});
  return result;
}
function MappedIntrinsicProperties(T, M, options) {
  return MappedIntrinsicPropertyKeys(T["keys"], M, options);
}
function IntrinsicFromMappedKey(T, M, options) {
  const P = MappedIntrinsicProperties(T, M, options);
  return MappedResult(P);
}

// node_modules/@sinclair/typebox/build/esm/type/intrinsic/intrinsic.mjs
function ApplyUncapitalize(value) {
  const [first, rest] = [value.slice(0, 1), value.slice(1)];
  return [first.toLowerCase(), rest].join("");
}
function ApplyCapitalize(value) {
  const [first, rest] = [value.slice(0, 1), value.slice(1)];
  return [first.toUpperCase(), rest].join("");
}
function ApplyUppercase(value) {
  return value.toUpperCase();
}
function ApplyLowercase(value) {
  return value.toLowerCase();
}
function FromTemplateLiteral3(schema, mode, options) {
  const expression = TemplateLiteralParseExact(schema.pattern);
  const finite = IsTemplateLiteralExpressionFinite(expression);
  if (!finite)
    return { ...schema, pattern: FromLiteralValue(schema.pattern, mode) };
  const strings = [...TemplateLiteralExpressionGenerate(expression)];
  const literals = strings.map((value) => Literal(value));
  const mapped = FromRest5(literals, mode);
  const union = Union(mapped);
  return TemplateLiteral([union], options);
}
function FromLiteralValue(value, mode) {
  return typeof value === "string" ? mode === "Uncapitalize" ? ApplyUncapitalize(value) : mode === "Capitalize" ? ApplyCapitalize(value) : mode === "Uppercase" ? ApplyUppercase(value) : mode === "Lowercase" ? ApplyLowercase(value) : value : value.toString();
}
function FromRest5(T, M) {
  return T.map((L) => Intrinsic(L, M));
}
function Intrinsic(schema, mode, options = {}) {
  return (
    // Intrinsic-Mapped-Inference
    IsMappedKey(schema) ? IntrinsicFromMappedKey(schema, mode, options) : (
      // Standard-Inference
      IsTemplateLiteral(schema) ? FromTemplateLiteral3(schema, mode, options) : IsUnion(schema) ? Union(FromRest5(schema.anyOf, mode), options) : IsLiteral(schema) ? Literal(FromLiteralValue(schema.const, mode), options) : (
        // Default Type
        CreateType(schema, options)
      )
    )
  );
}

// node_modules/@sinclair/typebox/build/esm/type/intrinsic/capitalize.mjs
function Capitalize(T, options = {}) {
  return Intrinsic(T, "Capitalize", options);
}

// node_modules/@sinclair/typebox/build/esm/type/intrinsic/lowercase.mjs
function Lowercase(T, options = {}) {
  return Intrinsic(T, "Lowercase", options);
}

// node_modules/@sinclair/typebox/build/esm/type/intrinsic/uncapitalize.mjs
function Uncapitalize(T, options = {}) {
  return Intrinsic(T, "Uncapitalize", options);
}

// node_modules/@sinclair/typebox/build/esm/type/intrinsic/uppercase.mjs
function Uppercase(T, options = {}) {
  return Intrinsic(T, "Uppercase", options);
}

// node_modules/@sinclair/typebox/build/esm/type/omit/omit-from-mapped-result.mjs
function FromProperties12(properties, propertyKeys, options) {
  const result = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(properties))
    result[K2] = Omit(properties[K2], propertyKeys, Clone(options));
  return result;
}
function FromMappedResult9(mappedResult, propertyKeys, options) {
  return FromProperties12(mappedResult.properties, propertyKeys, options);
}
function OmitFromMappedResult(mappedResult, propertyKeys, options) {
  const properties = FromMappedResult9(mappedResult, propertyKeys, options);
  return MappedResult(properties);
}

// node_modules/@sinclair/typebox/build/esm/type/omit/omit.mjs
function FromIntersect6(types, propertyKeys) {
  return types.map((type) => OmitResolve(type, propertyKeys));
}
function FromUnion8(types, propertyKeys) {
  return types.map((type) => OmitResolve(type, propertyKeys));
}
function FromProperty3(properties, key) {
  const { [key]: _, ...R } = properties;
  return R;
}
function FromProperties13(properties, propertyKeys) {
  return propertyKeys.reduce((T, K2) => FromProperty3(T, K2), properties);
}
function FromObject3(type, propertyKeys, properties) {
  const options = Discard(type, [TransformKind, "$id", "required", "properties"]);
  const mappedProperties = FromProperties13(properties, propertyKeys);
  return Object2(mappedProperties, options);
}
function UnionFromPropertyKeys(propertyKeys) {
  const result = propertyKeys.reduce((result2, key) => IsLiteralValue(key) ? [...result2, Literal(key)] : result2, []);
  return Union(result);
}
function OmitResolve(type, propertyKeys) {
  return IsIntersect(type) ? Intersect(FromIntersect6(type.allOf, propertyKeys)) : IsUnion(type) ? Union(FromUnion8(type.anyOf, propertyKeys)) : IsObject3(type) ? FromObject3(type, propertyKeys, type.properties) : Object2({});
}
function Omit(type, key, options) {
  const typeKey = IsArray(key) ? UnionFromPropertyKeys(key) : key;
  const propertyKeys = IsSchema(key) ? IndexPropertyKeys(key) : key;
  const isTypeRef = IsRef(type);
  const isKeyRef = IsRef(key);
  return IsMappedResult(type) ? OmitFromMappedResult(type, propertyKeys, options) : IsMappedKey(key) ? OmitFromMappedKey(type, key, options) : isTypeRef && isKeyRef ? Computed("Omit", [type, typeKey], options) : !isTypeRef && isKeyRef ? Computed("Omit", [type, typeKey], options) : isTypeRef && !isKeyRef ? Computed("Omit", [type, typeKey], options) : CreateType({ ...OmitResolve(type, propertyKeys), ...options });
}

// node_modules/@sinclair/typebox/build/esm/type/omit/omit-from-mapped-key.mjs
function FromPropertyKey2(type, key, options) {
  return { [key]: Omit(type, [key], Clone(options)) };
}
function FromPropertyKeys2(type, propertyKeys, options) {
  return propertyKeys.reduce((Acc, LK) => {
    return { ...Acc, ...FromPropertyKey2(type, LK, options) };
  }, {});
}
function FromMappedKey3(type, mappedKey, options) {
  return FromPropertyKeys2(type, mappedKey.keys, options);
}
function OmitFromMappedKey(type, mappedKey, options) {
  const properties = FromMappedKey3(type, mappedKey, options);
  return MappedResult(properties);
}

// node_modules/@sinclair/typebox/build/esm/type/pick/pick-from-mapped-result.mjs
function FromProperties14(properties, propertyKeys, options) {
  const result = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(properties))
    result[K2] = Pick(properties[K2], propertyKeys, Clone(options));
  return result;
}
function FromMappedResult10(mappedResult, propertyKeys, options) {
  return FromProperties14(mappedResult.properties, propertyKeys, options);
}
function PickFromMappedResult(mappedResult, propertyKeys, options) {
  const properties = FromMappedResult10(mappedResult, propertyKeys, options);
  return MappedResult(properties);
}

// node_modules/@sinclair/typebox/build/esm/type/pick/pick.mjs
function FromIntersect7(types, propertyKeys) {
  return types.map((type) => PickResolve(type, propertyKeys));
}
function FromUnion9(types, propertyKeys) {
  return types.map((type) => PickResolve(type, propertyKeys));
}
function FromProperties15(properties, propertyKeys) {
  const result = {};
  for (const K2 of propertyKeys)
    if (K2 in properties)
      result[K2] = properties[K2];
  return result;
}
function FromObject4(Type2, keys, properties) {
  const options = Discard(Type2, [TransformKind, "$id", "required", "properties"]);
  const mappedProperties = FromProperties15(properties, keys);
  return Object2(mappedProperties, options);
}
function UnionFromPropertyKeys2(propertyKeys) {
  const result = propertyKeys.reduce((result2, key) => IsLiteralValue(key) ? [...result2, Literal(key)] : result2, []);
  return Union(result);
}
function PickResolve(type, propertyKeys) {
  return IsIntersect(type) ? Intersect(FromIntersect7(type.allOf, propertyKeys)) : IsUnion(type) ? Union(FromUnion9(type.anyOf, propertyKeys)) : IsObject3(type) ? FromObject4(type, propertyKeys, type.properties) : Object2({});
}
function Pick(type, key, options) {
  const typeKey = IsArray(key) ? UnionFromPropertyKeys2(key) : key;
  const propertyKeys = IsSchema(key) ? IndexPropertyKeys(key) : key;
  const isTypeRef = IsRef(type);
  const isKeyRef = IsRef(key);
  return IsMappedResult(type) ? PickFromMappedResult(type, propertyKeys, options) : IsMappedKey(key) ? PickFromMappedKey(type, key, options) : isTypeRef && isKeyRef ? Computed("Pick", [type, typeKey], options) : !isTypeRef && isKeyRef ? Computed("Pick", [type, typeKey], options) : isTypeRef && !isKeyRef ? Computed("Pick", [type, typeKey], options) : CreateType({ ...PickResolve(type, propertyKeys), ...options });
}

// node_modules/@sinclair/typebox/build/esm/type/pick/pick-from-mapped-key.mjs
function FromPropertyKey3(type, key, options) {
  return {
    [key]: Pick(type, [key], Clone(options))
  };
}
function FromPropertyKeys3(type, propertyKeys, options) {
  return propertyKeys.reduce((result, leftKey) => {
    return { ...result, ...FromPropertyKey3(type, leftKey, options) };
  }, {});
}
function FromMappedKey4(type, mappedKey, options) {
  return FromPropertyKeys3(type, mappedKey.keys, options);
}
function PickFromMappedKey(type, mappedKey, options) {
  const properties = FromMappedKey4(type, mappedKey, options);
  return MappedResult(properties);
}

// node_modules/@sinclair/typebox/build/esm/type/partial/partial.mjs
function FromComputed3(target, parameters) {
  return Computed("Partial", [Computed(target, parameters)]);
}
function FromRef3($ref) {
  return Computed("Partial", [Ref($ref)]);
}
function FromProperties16(properties) {
  const partialProperties = {};
  for (const K of globalThis.Object.getOwnPropertyNames(properties))
    partialProperties[K] = Optional(properties[K]);
  return partialProperties;
}
function FromObject5(type, properties) {
  const options = Discard(type, [TransformKind, "$id", "required", "properties"]);
  const mappedProperties = FromProperties16(properties);
  return Object2(mappedProperties, options);
}
function FromRest6(types) {
  return types.map((type) => PartialResolve(type));
}
function PartialResolve(type) {
  return (
    // Mappable
    IsComputed(type) ? FromComputed3(type.target, type.parameters) : IsRef(type) ? FromRef3(type.$ref) : IsIntersect(type) ? Intersect(FromRest6(type.allOf)) : IsUnion(type) ? Union(FromRest6(type.anyOf)) : IsObject3(type) ? FromObject5(type, type.properties) : (
      // Intrinsic
      IsBigInt3(type) ? type : IsBoolean3(type) ? type : IsInteger2(type) ? type : IsLiteral(type) ? type : IsNull3(type) ? type : IsNumber3(type) ? type : IsString3(type) ? type : IsSymbol3(type) ? type : IsUndefined3(type) ? type : (
        // Passthrough
        Object2({})
      )
    )
  );
}
function Partial(type, options) {
  if (IsMappedResult(type)) {
    return PartialFromMappedResult(type, options);
  } else {
    return CreateType({ ...PartialResolve(type), ...options });
  }
}

// node_modules/@sinclair/typebox/build/esm/type/partial/partial-from-mapped-result.mjs
function FromProperties17(K, options) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(K))
    Acc[K2] = Partial(K[K2], Clone(options));
  return Acc;
}
function FromMappedResult11(R, options) {
  return FromProperties17(R.properties, options);
}
function PartialFromMappedResult(R, options) {
  const P = FromMappedResult11(R, options);
  return MappedResult(P);
}

// node_modules/@sinclair/typebox/build/esm/type/required/required.mjs
function FromComputed4(target, parameters) {
  return Computed("Required", [Computed(target, parameters)]);
}
function FromRef4($ref) {
  return Computed("Required", [Ref($ref)]);
}
function FromProperties18(properties) {
  const requiredProperties = {};
  for (const K of globalThis.Object.getOwnPropertyNames(properties))
    requiredProperties[K] = Discard(properties[K], [OptionalKind]);
  return requiredProperties;
}
function FromObject6(type, properties) {
  const options = Discard(type, [TransformKind, "$id", "required", "properties"]);
  const mappedProperties = FromProperties18(properties);
  return Object2(mappedProperties, options);
}
function FromRest7(types) {
  return types.map((type) => RequiredResolve(type));
}
function RequiredResolve(type) {
  return (
    // Mappable
    IsComputed(type) ? FromComputed4(type.target, type.parameters) : IsRef(type) ? FromRef4(type.$ref) : IsIntersect(type) ? Intersect(FromRest7(type.allOf)) : IsUnion(type) ? Union(FromRest7(type.anyOf)) : IsObject3(type) ? FromObject6(type, type.properties) : (
      // Intrinsic
      IsBigInt3(type) ? type : IsBoolean3(type) ? type : IsInteger2(type) ? type : IsLiteral(type) ? type : IsNull3(type) ? type : IsNumber3(type) ? type : IsString3(type) ? type : IsSymbol3(type) ? type : IsUndefined3(type) ? type : (
        // Passthrough
        Object2({})
      )
    )
  );
}
function Required(type, options) {
  if (IsMappedResult(type)) {
    return RequiredFromMappedResult(type, options);
  } else {
    return CreateType({ ...RequiredResolve(type), ...options });
  }
}

// node_modules/@sinclair/typebox/build/esm/type/required/required-from-mapped-result.mjs
function FromProperties19(P, options) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(P))
    Acc[K2] = Required(P[K2], options);
  return Acc;
}
function FromMappedResult12(R, options) {
  return FromProperties19(R.properties, options);
}
function RequiredFromMappedResult(R, options) {
  const P = FromMappedResult12(R, options);
  return MappedResult(P);
}

// node_modules/@sinclair/typebox/build/esm/type/module/compute.mjs
function DereferenceParameters(moduleProperties, types) {
  return types.map((type) => {
    return IsRef(type) ? Dereference(moduleProperties, type.$ref) : FromType2(moduleProperties, type);
  });
}
function Dereference(moduleProperties, ref) {
  return ref in moduleProperties ? IsRef(moduleProperties[ref]) ? Dereference(moduleProperties, moduleProperties[ref].$ref) : FromType2(moduleProperties, moduleProperties[ref]) : Never();
}
function FromAwaited(parameters) {
  return Awaited(parameters[0]);
}
function FromIndex(parameters) {
  return Index(parameters[0], parameters[1]);
}
function FromKeyOf(parameters) {
  return KeyOf(parameters[0]);
}
function FromPartial(parameters) {
  return Partial(parameters[0]);
}
function FromOmit(parameters) {
  return Omit(parameters[0], parameters[1]);
}
function FromPick(parameters) {
  return Pick(parameters[0], parameters[1]);
}
function FromRequired(parameters) {
  return Required(parameters[0]);
}
function FromComputed5(moduleProperties, target, parameters) {
  const dereferenced = DereferenceParameters(moduleProperties, parameters);
  return target === "Awaited" ? FromAwaited(dereferenced) : target === "Index" ? FromIndex(dereferenced) : target === "KeyOf" ? FromKeyOf(dereferenced) : target === "Partial" ? FromPartial(dereferenced) : target === "Omit" ? FromOmit(dereferenced) : target === "Pick" ? FromPick(dereferenced) : target === "Required" ? FromRequired(dereferenced) : Never();
}
function FromArray6(moduleProperties, type) {
  return Array2(FromType2(moduleProperties, type));
}
function FromAsyncIterator3(moduleProperties, type) {
  return AsyncIterator(FromType2(moduleProperties, type));
}
function FromConstructor3(moduleProperties, parameters, instanceType) {
  return Constructor(FromTypes2(moduleProperties, parameters), FromType2(moduleProperties, instanceType));
}
function FromFunction3(moduleProperties, parameters, returnType) {
  return Function(FromTypes2(moduleProperties, parameters), FromType2(moduleProperties, returnType));
}
function FromIntersect8(moduleProperties, types) {
  return Intersect(FromTypes2(moduleProperties, types));
}
function FromIterator3(moduleProperties, type) {
  return Iterator(FromType2(moduleProperties, type));
}
function FromObject7(moduleProperties, properties) {
  return Object2(globalThis.Object.keys(properties).reduce((result, key) => {
    return { ...result, [key]: FromType2(moduleProperties, properties[key]) };
  }, {}));
}
function FromRecord3(moduleProperties, type) {
  const [value, pattern] = [FromType2(moduleProperties, RecordValue2(type)), RecordPattern(type)];
  const result = CloneType(type);
  result.patternProperties[pattern] = value;
  return result;
}
function FromTransform(moduleProperties, transform) {
  return IsRef(transform) ? { ...Dereference(moduleProperties, transform.$ref), [TransformKind]: transform[TransformKind] } : transform;
}
function FromTuple5(moduleProperties, types) {
  return Tuple(FromTypes2(moduleProperties, types));
}
function FromUnion10(moduleProperties, types) {
  return Union(FromTypes2(moduleProperties, types));
}
function FromTypes2(moduleProperties, types) {
  return types.map((type) => FromType2(moduleProperties, type));
}
function FromType2(moduleProperties, type) {
  return (
    // Modifiers
    IsOptional(type) ? CreateType(FromType2(moduleProperties, Discard(type, [OptionalKind])), type) : IsReadonly(type) ? CreateType(FromType2(moduleProperties, Discard(type, [ReadonlyKind])), type) : (
      // Transform
      IsTransform(type) ? CreateType(FromTransform(moduleProperties, type), type) : (
        // Types
        IsArray3(type) ? CreateType(FromArray6(moduleProperties, type.items), type) : IsAsyncIterator3(type) ? CreateType(FromAsyncIterator3(moduleProperties, type.items), type) : IsComputed(type) ? CreateType(FromComputed5(moduleProperties, type.target, type.parameters)) : IsConstructor(type) ? CreateType(FromConstructor3(moduleProperties, type.parameters, type.returns), type) : IsFunction3(type) ? CreateType(FromFunction3(moduleProperties, type.parameters, type.returns), type) : IsIntersect(type) ? CreateType(FromIntersect8(moduleProperties, type.allOf), type) : IsIterator3(type) ? CreateType(FromIterator3(moduleProperties, type.items), type) : IsObject3(type) ? CreateType(FromObject7(moduleProperties, type.properties), type) : IsRecord(type) ? CreateType(FromRecord3(moduleProperties, type)) : IsTuple(type) ? CreateType(FromTuple5(moduleProperties, type.items || []), type) : IsUnion(type) ? CreateType(FromUnion10(moduleProperties, type.anyOf), type) : type
      )
    )
  );
}
function ComputeType(moduleProperties, key) {
  return key in moduleProperties ? FromType2(moduleProperties, moduleProperties[key]) : Never();
}
function ComputeModuleProperties(moduleProperties) {
  return globalThis.Object.getOwnPropertyNames(moduleProperties).reduce((result, key) => {
    return { ...result, [key]: ComputeType(moduleProperties, key) };
  }, {});
}

// node_modules/@sinclair/typebox/build/esm/type/module/module.mjs
var TModule = class {
  constructor($defs) {
    const computed = ComputeModuleProperties($defs);
    const identified = this.WithIdentifiers(computed);
    this.$defs = identified;
  }
  /** `[Json]` Imports a Type by Key. */
  Import(key, options) {
    const $defs = { ...this.$defs, [key]: CreateType(this.$defs[key], options) };
    return CreateType({ [Kind]: "Import", $defs, $ref: key });
  }
  // prettier-ignore
  WithIdentifiers($defs) {
    return globalThis.Object.getOwnPropertyNames($defs).reduce((result, key) => {
      return { ...result, [key]: { ...$defs[key], $id: key } };
    }, {});
  }
};
function Module(properties) {
  return new TModule(properties);
}

// node_modules/@sinclair/typebox/build/esm/type/not/not.mjs
function Not2(type, options) {
  return CreateType({ [Kind]: "Not", not: type }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/parameters/parameters.mjs
function Parameters(schema, options) {
  return IsFunction3(schema) ? Tuple(schema.parameters, options) : Never();
}

// node_modules/@sinclair/typebox/build/esm/type/recursive/recursive.mjs
var Ordinal = 0;
function Recursive(callback, options = {}) {
  if (IsUndefined(options.$id))
    options.$id = `T${Ordinal++}`;
  const thisType = CloneType(callback({ [Kind]: "This", $ref: `${options.$id}` }));
  thisType.$id = options.$id;
  return CreateType({ [Hint]: "Recursive", ...thisType }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/regexp/regexp.mjs
function RegExp2(unresolved, options) {
  const expr = IsString(unresolved) ? new globalThis.RegExp(unresolved) : unresolved;
  return CreateType({ [Kind]: "RegExp", type: "RegExp", source: expr.source, flags: expr.flags }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/rest/rest.mjs
function RestResolve(T) {
  return IsIntersect(T) ? T.allOf : IsUnion(T) ? T.anyOf : IsTuple(T) ? T.items ?? [] : [];
}
function Rest(T) {
  return RestResolve(T);
}

// node_modules/@sinclair/typebox/build/esm/type/return-type/return-type.mjs
function ReturnType(schema, options) {
  return IsFunction3(schema) ? CreateType(schema.returns, options) : Never(options);
}

// node_modules/@sinclair/typebox/build/esm/type/transform/transform.mjs
var TransformDecodeBuilder = class {
  constructor(schema) {
    this.schema = schema;
  }
  Decode(decode) {
    return new TransformEncodeBuilder(this.schema, decode);
  }
};
var TransformEncodeBuilder = class {
  constructor(schema, decode) {
    this.schema = schema;
    this.decode = decode;
  }
  EncodeTransform(encode2, schema) {
    const Encode2 = (value) => schema[TransformKind].Encode(encode2(value));
    const Decode2 = (value) => this.decode(schema[TransformKind].Decode(value));
    const Codec = { Encode: Encode2, Decode: Decode2 };
    return { ...schema, [TransformKind]: Codec };
  }
  EncodeSchema(encode2, schema) {
    const Codec = { Decode: this.decode, Encode: encode2 };
    return { ...schema, [TransformKind]: Codec };
  }
  Encode(encode2) {
    return IsTransform(this.schema) ? this.EncodeTransform(encode2, this.schema) : this.EncodeSchema(encode2, this.schema);
  }
};
function Transform(schema) {
  return new TransformDecodeBuilder(schema);
}

// node_modules/@sinclair/typebox/build/esm/type/unsafe/unsafe.mjs
function Unsafe(options = {}) {
  return CreateType({ [Kind]: options[Kind] ?? "Unsafe" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/void/void.mjs
function Void(options) {
  return CreateType({ [Kind]: "Void", type: "void" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/type/type.mjs
var type_exports3 = {};
__export(type_exports3, {
  Any: () => Any,
  Argument: () => Argument2,
  Array: () => Array2,
  AsyncIterator: () => AsyncIterator,
  Awaited: () => Awaited,
  BigInt: () => BigInt2,
  Boolean: () => Boolean2,
  Capitalize: () => Capitalize,
  Composite: () => Composite,
  Const: () => Const,
  Constructor: () => Constructor,
  ConstructorParameters: () => ConstructorParameters,
  Date: () => Date2,
  Enum: () => Enum,
  Exclude: () => Exclude,
  Extends: () => Extends,
  Extract: () => Extract,
  Function: () => Function,
  Index: () => Index,
  InstanceType: () => InstanceType,
  Instantiate: () => Instantiate,
  Integer: () => Integer,
  Intersect: () => Intersect,
  Iterator: () => Iterator,
  KeyOf: () => KeyOf,
  Literal: () => Literal,
  Lowercase: () => Lowercase,
  Mapped: () => Mapped,
  Module: () => Module,
  Never: () => Never,
  Not: () => Not2,
  Null: () => Null,
  Number: () => Number2,
  Object: () => Object2,
  Omit: () => Omit,
  Optional: () => Optional,
  Parameters: () => Parameters,
  Partial: () => Partial,
  Pick: () => Pick,
  Promise: () => Promise2,
  Readonly: () => Readonly,
  ReadonlyOptional: () => ReadonlyOptional,
  Record: () => Record,
  Recursive: () => Recursive,
  Ref: () => Ref,
  RegExp: () => RegExp2,
  Required: () => Required,
  Rest: () => Rest,
  ReturnType: () => ReturnType,
  String: () => String2,
  Symbol: () => Symbol2,
  TemplateLiteral: () => TemplateLiteral,
  Transform: () => Transform,
  Tuple: () => Tuple,
  Uint8Array: () => Uint8Array2,
  Uncapitalize: () => Uncapitalize,
  Undefined: () => Undefined,
  Union: () => Union,
  Unknown: () => Unknown,
  Unsafe: () => Unsafe,
  Uppercase: () => Uppercase,
  Void: () => Void
});

// node_modules/@sinclair/typebox/build/esm/type/type/index.mjs
var Type = type_exports3;

// node_modules/@sinclair/typebox/build/esm/errors/function.mjs
function DefaultErrorFunction(error) {
  switch (error.errorType) {
    case ValueErrorType.ArrayContains:
      return "Expected array to contain at least one matching value";
    case ValueErrorType.ArrayMaxContains:
      return `Expected array to contain no more than ${error.schema.maxContains} matching values`;
    case ValueErrorType.ArrayMinContains:
      return `Expected array to contain at least ${error.schema.minContains} matching values`;
    case ValueErrorType.ArrayMaxItems:
      return `Expected array length to be less or equal to ${error.schema.maxItems}`;
    case ValueErrorType.ArrayMinItems:
      return `Expected array length to be greater or equal to ${error.schema.minItems}`;
    case ValueErrorType.ArrayUniqueItems:
      return "Expected array elements to be unique";
    case ValueErrorType.Array:
      return "Expected array";
    case ValueErrorType.AsyncIterator:
      return "Expected AsyncIterator";
    case ValueErrorType.BigIntExclusiveMaximum:
      return `Expected bigint to be less than ${error.schema.exclusiveMaximum}`;
    case ValueErrorType.BigIntExclusiveMinimum:
      return `Expected bigint to be greater than ${error.schema.exclusiveMinimum}`;
    case ValueErrorType.BigIntMaximum:
      return `Expected bigint to be less or equal to ${error.schema.maximum}`;
    case ValueErrorType.BigIntMinimum:
      return `Expected bigint to be greater or equal to ${error.schema.minimum}`;
    case ValueErrorType.BigIntMultipleOf:
      return `Expected bigint to be a multiple of ${error.schema.multipleOf}`;
    case ValueErrorType.BigInt:
      return "Expected bigint";
    case ValueErrorType.Boolean:
      return "Expected boolean";
    case ValueErrorType.DateExclusiveMinimumTimestamp:
      return `Expected Date timestamp to be greater than ${error.schema.exclusiveMinimumTimestamp}`;
    case ValueErrorType.DateExclusiveMaximumTimestamp:
      return `Expected Date timestamp to be less than ${error.schema.exclusiveMaximumTimestamp}`;
    case ValueErrorType.DateMinimumTimestamp:
      return `Expected Date timestamp to be greater or equal to ${error.schema.minimumTimestamp}`;
    case ValueErrorType.DateMaximumTimestamp:
      return `Expected Date timestamp to be less or equal to ${error.schema.maximumTimestamp}`;
    case ValueErrorType.DateMultipleOfTimestamp:
      return `Expected Date timestamp to be a multiple of ${error.schema.multipleOfTimestamp}`;
    case ValueErrorType.Date:
      return "Expected Date";
    case ValueErrorType.Function:
      return "Expected function";
    case ValueErrorType.IntegerExclusiveMaximum:
      return `Expected integer to be less than ${error.schema.exclusiveMaximum}`;
    case ValueErrorType.IntegerExclusiveMinimum:
      return `Expected integer to be greater than ${error.schema.exclusiveMinimum}`;
    case ValueErrorType.IntegerMaximum:
      return `Expected integer to be less or equal to ${error.schema.maximum}`;
    case ValueErrorType.IntegerMinimum:
      return `Expected integer to be greater or equal to ${error.schema.minimum}`;
    case ValueErrorType.IntegerMultipleOf:
      return `Expected integer to be a multiple of ${error.schema.multipleOf}`;
    case ValueErrorType.Integer:
      return "Expected integer";
    case ValueErrorType.IntersectUnevaluatedProperties:
      return "Unexpected property";
    case ValueErrorType.Intersect:
      return "Expected all values to match";
    case ValueErrorType.Iterator:
      return "Expected Iterator";
    case ValueErrorType.Literal:
      return `Expected ${typeof error.schema.const === "string" ? `'${error.schema.const}'` : error.schema.const}`;
    case ValueErrorType.Never:
      return "Never";
    case ValueErrorType.Not:
      return "Value should not match";
    case ValueErrorType.Null:
      return "Expected null";
    case ValueErrorType.NumberExclusiveMaximum:
      return `Expected number to be less than ${error.schema.exclusiveMaximum}`;
    case ValueErrorType.NumberExclusiveMinimum:
      return `Expected number to be greater than ${error.schema.exclusiveMinimum}`;
    case ValueErrorType.NumberMaximum:
      return `Expected number to be less or equal to ${error.schema.maximum}`;
    case ValueErrorType.NumberMinimum:
      return `Expected number to be greater or equal to ${error.schema.minimum}`;
    case ValueErrorType.NumberMultipleOf:
      return `Expected number to be a multiple of ${error.schema.multipleOf}`;
    case ValueErrorType.Number:
      return "Expected number";
    case ValueErrorType.Object:
      return "Expected object";
    case ValueErrorType.ObjectAdditionalProperties:
      return "Unexpected property";
    case ValueErrorType.ObjectMaxProperties:
      return `Expected object to have no more than ${error.schema.maxProperties} properties`;
    case ValueErrorType.ObjectMinProperties:
      return `Expected object to have at least ${error.schema.minProperties} properties`;
    case ValueErrorType.ObjectRequiredProperty:
      return "Expected required property";
    case ValueErrorType.Promise:
      return "Expected Promise";
    case ValueErrorType.RegExp:
      return "Expected string to match regular expression";
    case ValueErrorType.StringFormatUnknown:
      return `Unknown format '${error.schema.format}'`;
    case ValueErrorType.StringFormat:
      return `Expected string to match '${error.schema.format}' format`;
    case ValueErrorType.StringMaxLength:
      return `Expected string length less or equal to ${error.schema.maxLength}`;
    case ValueErrorType.StringMinLength:
      return `Expected string length greater or equal to ${error.schema.minLength}`;
    case ValueErrorType.StringPattern:
      return `Expected string to match '${error.schema.pattern}'`;
    case ValueErrorType.String:
      return "Expected string";
    case ValueErrorType.Symbol:
      return "Expected symbol";
    case ValueErrorType.TupleLength:
      return `Expected tuple to have ${error.schema.maxItems || 0} elements`;
    case ValueErrorType.Tuple:
      return "Expected tuple";
    case ValueErrorType.Uint8ArrayMaxByteLength:
      return `Expected byte length less or equal to ${error.schema.maxByteLength}`;
    case ValueErrorType.Uint8ArrayMinByteLength:
      return `Expected byte length greater or equal to ${error.schema.minByteLength}`;
    case ValueErrorType.Uint8Array:
      return "Expected Uint8Array";
    case ValueErrorType.Undefined:
      return "Expected undefined";
    case ValueErrorType.Union:
      return "Expected union value";
    case ValueErrorType.Void:
      return "Expected void";
    case ValueErrorType.Kind:
      return `Expected kind '${error.schema[Kind]}'`;
    default:
      return "Unknown error type";
  }
}
var errorFunction = DefaultErrorFunction;
function GetErrorFunction() {
  return errorFunction;
}

// node_modules/@sinclair/typebox/build/esm/value/deref/deref.mjs
var TypeDereferenceError = class extends TypeBoxError {
  constructor(schema) {
    super(`Unable to dereference schema with $id '${schema.$ref}'`);
    this.schema = schema;
  }
};
function Resolve(schema, references) {
  const target = references.find((target2) => target2.$id === schema.$ref);
  if (target === void 0)
    throw new TypeDereferenceError(schema);
  return Deref(target, references);
}
function Pushref(schema, references) {
  if (!IsString2(schema.$id) || references.some((target) => target.$id === schema.$id))
    return references;
  references.push(schema);
  return references;
}
function Deref(schema, references) {
  return schema[Kind] === "This" || schema[Kind] === "Ref" ? Resolve(schema, references) : schema;
}

// node_modules/@sinclair/typebox/build/esm/value/hash/hash.mjs
var ValueHashError = class extends TypeBoxError {
  constructor(value) {
    super(`Unable to hash value`);
    this.value = value;
  }
};
var ByteMarker;
(function(ByteMarker2) {
  ByteMarker2[ByteMarker2["Undefined"] = 0] = "Undefined";
  ByteMarker2[ByteMarker2["Null"] = 1] = "Null";
  ByteMarker2[ByteMarker2["Boolean"] = 2] = "Boolean";
  ByteMarker2[ByteMarker2["Number"] = 3] = "Number";
  ByteMarker2[ByteMarker2["String"] = 4] = "String";
  ByteMarker2[ByteMarker2["Object"] = 5] = "Object";
  ByteMarker2[ByteMarker2["Array"] = 6] = "Array";
  ByteMarker2[ByteMarker2["Date"] = 7] = "Date";
  ByteMarker2[ByteMarker2["Uint8Array"] = 8] = "Uint8Array";
  ByteMarker2[ByteMarker2["Symbol"] = 9] = "Symbol";
  ByteMarker2[ByteMarker2["BigInt"] = 10] = "BigInt";
})(ByteMarker || (ByteMarker = {}));
var Accumulator = BigInt("14695981039346656037");
var [Prime, Size] = [BigInt("1099511628211"), BigInt(
  "18446744073709551616"
  /* 2 ^ 64 */
)];
var Bytes = Array.from({ length: 256 }).map((_, i) => BigInt(i));
var F64 = new Float64Array(1);
var F64In = new DataView(F64.buffer);
var F64Out = new Uint8Array(F64.buffer);
function* NumberToBytes(value) {
  const byteCount = value === 0 ? 1 : Math.ceil(Math.floor(Math.log2(value) + 1) / 8);
  for (let i = 0; i < byteCount; i++) {
    yield value >> 8 * (byteCount - 1 - i) & 255;
  }
}
function ArrayType2(value) {
  FNV1A64(ByteMarker.Array);
  for (const item of value) {
    Visit4(item);
  }
}
function BooleanType(value) {
  FNV1A64(ByteMarker.Boolean);
  FNV1A64(value ? 1 : 0);
}
function BigIntType(value) {
  FNV1A64(ByteMarker.BigInt);
  F64In.setBigInt64(0, value);
  for (const byte of F64Out) {
    FNV1A64(byte);
  }
}
function DateType2(value) {
  FNV1A64(ByteMarker.Date);
  Visit4(value.getTime());
}
function NullType(value) {
  FNV1A64(ByteMarker.Null);
}
function NumberType(value) {
  FNV1A64(ByteMarker.Number);
  F64In.setFloat64(0, value);
  for (const byte of F64Out) {
    FNV1A64(byte);
  }
}
function ObjectType2(value) {
  FNV1A64(ByteMarker.Object);
  for (const key of globalThis.Object.getOwnPropertyNames(value).sort()) {
    Visit4(key);
    Visit4(value[key]);
  }
}
function StringType(value) {
  FNV1A64(ByteMarker.String);
  for (let i = 0; i < value.length; i++) {
    for (const byte of NumberToBytes(value.charCodeAt(i))) {
      FNV1A64(byte);
    }
  }
}
function SymbolType(value) {
  FNV1A64(ByteMarker.Symbol);
  Visit4(value.description);
}
function Uint8ArrayType2(value) {
  FNV1A64(ByteMarker.Uint8Array);
  for (let i = 0; i < value.length; i++) {
    FNV1A64(value[i]);
  }
}
function UndefinedType(value) {
  return FNV1A64(ByteMarker.Undefined);
}
function Visit4(value) {
  if (IsArray2(value))
    return ArrayType2(value);
  if (IsBoolean2(value))
    return BooleanType(value);
  if (IsBigInt2(value))
    return BigIntType(value);
  if (IsDate2(value))
    return DateType2(value);
  if (IsNull2(value))
    return NullType(value);
  if (IsNumber2(value))
    return NumberType(value);
  if (IsObject2(value))
    return ObjectType2(value);
  if (IsString2(value))
    return StringType(value);
  if (IsSymbol2(value))
    return SymbolType(value);
  if (IsUint8Array2(value))
    return Uint8ArrayType2(value);
  if (IsUndefined2(value))
    return UndefinedType(value);
  throw new ValueHashError(value);
}
function FNV1A64(byte) {
  Accumulator = Accumulator ^ Bytes[byte];
  Accumulator = Accumulator * Prime % Size;
}
function Hash(value) {
  Accumulator = BigInt("14695981039346656037");
  Visit4(value);
  return Accumulator;
}

// node_modules/@sinclair/typebox/build/esm/value/check/check.mjs
var ValueCheckUnknownTypeError = class extends TypeBoxError {
  constructor(schema) {
    super(`Unknown type`);
    this.schema = schema;
  }
};
function IsAnyOrUnknown(schema) {
  return schema[Kind] === "Any" || schema[Kind] === "Unknown";
}
function IsDefined(value) {
  return value !== void 0;
}
function FromAny2(schema, references, value) {
  return true;
}
function FromArgument2(schema, references, value) {
  return true;
}
function FromArray7(schema, references, value) {
  if (!IsArray2(value))
    return false;
  if (IsDefined(schema.minItems) && !(value.length >= schema.minItems)) {
    return false;
  }
  if (IsDefined(schema.maxItems) && !(value.length <= schema.maxItems)) {
    return false;
  }
  for (const element of value) {
    if (!Visit5(schema.items, references, element))
      return false;
  }
  if (schema.uniqueItems === true && !(function() {
    const set = /* @__PURE__ */ new Set();
    for (const element of value) {
      const hashed = Hash(element);
      if (set.has(hashed)) {
        return false;
      } else {
        set.add(hashed);
      }
    }
    return true;
  })()) {
    return false;
  }
  if (!(IsDefined(schema.contains) || IsNumber2(schema.minContains) || IsNumber2(schema.maxContains))) {
    return true;
  }
  const containsSchema = IsDefined(schema.contains) ? schema.contains : Never();
  const containsCount = value.reduce((acc, value2) => Visit5(containsSchema, references, value2) ? acc + 1 : acc, 0);
  if (containsCount === 0) {
    return false;
  }
  if (IsNumber2(schema.minContains) && containsCount < schema.minContains) {
    return false;
  }
  if (IsNumber2(schema.maxContains) && containsCount > schema.maxContains) {
    return false;
  }
  return true;
}
function FromAsyncIterator4(schema, references, value) {
  return IsAsyncIterator2(value);
}
function FromBigInt2(schema, references, value) {
  if (!IsBigInt2(value))
    return false;
  if (IsDefined(schema.exclusiveMaximum) && !(value < schema.exclusiveMaximum)) {
    return false;
  }
  if (IsDefined(schema.exclusiveMinimum) && !(value > schema.exclusiveMinimum)) {
    return false;
  }
  if (IsDefined(schema.maximum) && !(value <= schema.maximum)) {
    return false;
  }
  if (IsDefined(schema.minimum) && !(value >= schema.minimum)) {
    return false;
  }
  if (IsDefined(schema.multipleOf) && !(value % schema.multipleOf === BigInt(0))) {
    return false;
  }
  return true;
}
function FromBoolean2(schema, references, value) {
  return IsBoolean2(value);
}
function FromConstructor4(schema, references, value) {
  return Visit5(schema.returns, references, value.prototype);
}
function FromDate2(schema, references, value) {
  if (!IsDate2(value))
    return false;
  if (IsDefined(schema.exclusiveMaximumTimestamp) && !(value.getTime() < schema.exclusiveMaximumTimestamp)) {
    return false;
  }
  if (IsDefined(schema.exclusiveMinimumTimestamp) && !(value.getTime() > schema.exclusiveMinimumTimestamp)) {
    return false;
  }
  if (IsDefined(schema.maximumTimestamp) && !(value.getTime() <= schema.maximumTimestamp)) {
    return false;
  }
  if (IsDefined(schema.minimumTimestamp) && !(value.getTime() >= schema.minimumTimestamp)) {
    return false;
  }
  if (IsDefined(schema.multipleOfTimestamp) && !(value.getTime() % schema.multipleOfTimestamp === 0)) {
    return false;
  }
  return true;
}
function FromFunction4(schema, references, value) {
  return IsFunction2(value);
}
function FromImport(schema, references, value) {
  const definitions = globalThis.Object.values(schema.$defs);
  const target = schema.$defs[schema.$ref];
  return Visit5(target, [...references, ...definitions], value);
}
function FromInteger2(schema, references, value) {
  if (!IsInteger(value)) {
    return false;
  }
  if (IsDefined(schema.exclusiveMaximum) && !(value < schema.exclusiveMaximum)) {
    return false;
  }
  if (IsDefined(schema.exclusiveMinimum) && !(value > schema.exclusiveMinimum)) {
    return false;
  }
  if (IsDefined(schema.maximum) && !(value <= schema.maximum)) {
    return false;
  }
  if (IsDefined(schema.minimum) && !(value >= schema.minimum)) {
    return false;
  }
  if (IsDefined(schema.multipleOf) && !(value % schema.multipleOf === 0)) {
    return false;
  }
  return true;
}
function FromIntersect9(schema, references, value) {
  const check1 = schema.allOf.every((schema2) => Visit5(schema2, references, value));
  if (schema.unevaluatedProperties === false) {
    const keyPattern = new RegExp(KeyOfPattern(schema));
    const check2 = Object.getOwnPropertyNames(value).every((key) => keyPattern.test(key));
    return check1 && check2;
  } else if (IsSchema(schema.unevaluatedProperties)) {
    const keyCheck = new RegExp(KeyOfPattern(schema));
    const check2 = Object.getOwnPropertyNames(value).every((key) => keyCheck.test(key) || Visit5(schema.unevaluatedProperties, references, value[key]));
    return check1 && check2;
  } else {
    return check1;
  }
}
function FromIterator4(schema, references, value) {
  return IsIterator2(value);
}
function FromLiteral3(schema, references, value) {
  return value === schema.const;
}
function FromNever2(schema, references, value) {
  return false;
}
function FromNot2(schema, references, value) {
  return !Visit5(schema.not, references, value);
}
function FromNull2(schema, references, value) {
  return IsNull2(value);
}
function FromNumber2(schema, references, value) {
  if (!TypeSystemPolicy.IsNumberLike(value))
    return false;
  if (IsDefined(schema.exclusiveMaximum) && !(value < schema.exclusiveMaximum)) {
    return false;
  }
  if (IsDefined(schema.exclusiveMinimum) && !(value > schema.exclusiveMinimum)) {
    return false;
  }
  if (IsDefined(schema.minimum) && !(value >= schema.minimum)) {
    return false;
  }
  if (IsDefined(schema.maximum) && !(value <= schema.maximum)) {
    return false;
  }
  if (IsDefined(schema.multipleOf) && !(value % schema.multipleOf === 0)) {
    return false;
  }
  return true;
}
function FromObject8(schema, references, value) {
  if (!TypeSystemPolicy.IsObjectLike(value))
    return false;
  if (IsDefined(schema.minProperties) && !(Object.getOwnPropertyNames(value).length >= schema.minProperties)) {
    return false;
  }
  if (IsDefined(schema.maxProperties) && !(Object.getOwnPropertyNames(value).length <= schema.maxProperties)) {
    return false;
  }
  const knownKeys = Object.getOwnPropertyNames(schema.properties);
  for (const knownKey of knownKeys) {
    const property = schema.properties[knownKey];
    if (schema.required && schema.required.includes(knownKey)) {
      if (!Visit5(property, references, value[knownKey])) {
        return false;
      }
      if ((ExtendsUndefinedCheck(property) || IsAnyOrUnknown(property)) && !(knownKey in value)) {
        return false;
      }
    } else {
      if (TypeSystemPolicy.IsExactOptionalProperty(value, knownKey) && !Visit5(property, references, value[knownKey])) {
        return false;
      }
    }
  }
  if (schema.additionalProperties === false) {
    const valueKeys = Object.getOwnPropertyNames(value);
    if (schema.required && schema.required.length === knownKeys.length && valueKeys.length === knownKeys.length) {
      return true;
    } else {
      return valueKeys.every((valueKey) => knownKeys.includes(valueKey));
    }
  } else if (typeof schema.additionalProperties === "object") {
    const valueKeys = Object.getOwnPropertyNames(value);
    return valueKeys.every((key) => knownKeys.includes(key) || Visit5(schema.additionalProperties, references, value[key]));
  } else {
    return true;
  }
}
function FromPromise4(schema, references, value) {
  return IsPromise(value);
}
function FromRecord4(schema, references, value) {
  if (!TypeSystemPolicy.IsRecordLike(value)) {
    return false;
  }
  if (IsDefined(schema.minProperties) && !(Object.getOwnPropertyNames(value).length >= schema.minProperties)) {
    return false;
  }
  if (IsDefined(schema.maxProperties) && !(Object.getOwnPropertyNames(value).length <= schema.maxProperties)) {
    return false;
  }
  const [patternKey, patternSchema] = Object.entries(schema.patternProperties)[0];
  const regex = new RegExp(patternKey);
  const check1 = Object.entries(value).every(([key, value2]) => {
    return regex.test(key) ? Visit5(patternSchema, references, value2) : true;
  });
  const check2 = typeof schema.additionalProperties === "object" ? Object.entries(value).every(([key, value2]) => {
    return !regex.test(key) ? Visit5(schema.additionalProperties, references, value2) : true;
  }) : true;
  const check3 = schema.additionalProperties === false ? Object.getOwnPropertyNames(value).every((key) => {
    return regex.test(key);
  }) : true;
  return check1 && check2 && check3;
}
function FromRef5(schema, references, value) {
  return Visit5(Deref(schema, references), references, value);
}
function FromRegExp2(schema, references, value) {
  const regex = new RegExp(schema.source, schema.flags);
  if (IsDefined(schema.minLength)) {
    if (!(value.length >= schema.minLength))
      return false;
  }
  if (IsDefined(schema.maxLength)) {
    if (!(value.length <= schema.maxLength))
      return false;
  }
  return regex.test(value);
}
function FromString2(schema, references, value) {
  if (!IsString2(value)) {
    return false;
  }
  if (IsDefined(schema.minLength)) {
    if (!(value.length >= schema.minLength))
      return false;
  }
  if (IsDefined(schema.maxLength)) {
    if (!(value.length <= schema.maxLength))
      return false;
  }
  if (IsDefined(schema.pattern)) {
    const regex = new RegExp(schema.pattern);
    if (!regex.test(value))
      return false;
  }
  if (IsDefined(schema.format)) {
    if (!format_exports.Has(schema.format))
      return false;
    const func = format_exports.Get(schema.format);
    return func(value);
  }
  return true;
}
function FromSymbol2(schema, references, value) {
  return IsSymbol2(value);
}
function FromTemplateLiteral4(schema, references, value) {
  return IsString2(value) && new RegExp(schema.pattern).test(value);
}
function FromThis(schema, references, value) {
  return Visit5(Deref(schema, references), references, value);
}
function FromTuple6(schema, references, value) {
  if (!IsArray2(value)) {
    return false;
  }
  if (schema.items === void 0 && !(value.length === 0)) {
    return false;
  }
  if (!(value.length === schema.maxItems)) {
    return false;
  }
  if (!schema.items) {
    return true;
  }
  for (let i = 0; i < schema.items.length; i++) {
    if (!Visit5(schema.items[i], references, value[i]))
      return false;
  }
  return true;
}
function FromUndefined2(schema, references, value) {
  return IsUndefined2(value);
}
function FromUnion11(schema, references, value) {
  return schema.anyOf.some((inner) => Visit5(inner, references, value));
}
function FromUint8Array2(schema, references, value) {
  if (!IsUint8Array2(value)) {
    return false;
  }
  if (IsDefined(schema.maxByteLength) && !(value.length <= schema.maxByteLength)) {
    return false;
  }
  if (IsDefined(schema.minByteLength) && !(value.length >= schema.minByteLength)) {
    return false;
  }
  return true;
}
function FromUnknown2(schema, references, value) {
  return true;
}
function FromVoid2(schema, references, value) {
  return TypeSystemPolicy.IsVoidLike(value);
}
function FromKind(schema, references, value) {
  if (!type_exports2.Has(schema[Kind]))
    return false;
  const func = type_exports2.Get(schema[Kind]);
  return func(schema, value);
}
function Visit5(schema, references, value) {
  const references_ = IsDefined(schema.$id) ? Pushref(schema, references) : references;
  const schema_ = schema;
  switch (schema_[Kind]) {
    case "Any":
      return FromAny2(schema_, references_, value);
    case "Argument":
      return FromArgument2(schema_, references_, value);
    case "Array":
      return FromArray7(schema_, references_, value);
    case "AsyncIterator":
      return FromAsyncIterator4(schema_, references_, value);
    case "BigInt":
      return FromBigInt2(schema_, references_, value);
    case "Boolean":
      return FromBoolean2(schema_, references_, value);
    case "Constructor":
      return FromConstructor4(schema_, references_, value);
    case "Date":
      return FromDate2(schema_, references_, value);
    case "Function":
      return FromFunction4(schema_, references_, value);
    case "Import":
      return FromImport(schema_, references_, value);
    case "Integer":
      return FromInteger2(schema_, references_, value);
    case "Intersect":
      return FromIntersect9(schema_, references_, value);
    case "Iterator":
      return FromIterator4(schema_, references_, value);
    case "Literal":
      return FromLiteral3(schema_, references_, value);
    case "Never":
      return FromNever2(schema_, references_, value);
    case "Not":
      return FromNot2(schema_, references_, value);
    case "Null":
      return FromNull2(schema_, references_, value);
    case "Number":
      return FromNumber2(schema_, references_, value);
    case "Object":
      return FromObject8(schema_, references_, value);
    case "Promise":
      return FromPromise4(schema_, references_, value);
    case "Record":
      return FromRecord4(schema_, references_, value);
    case "Ref":
      return FromRef5(schema_, references_, value);
    case "RegExp":
      return FromRegExp2(schema_, references_, value);
    case "String":
      return FromString2(schema_, references_, value);
    case "Symbol":
      return FromSymbol2(schema_, references_, value);
    case "TemplateLiteral":
      return FromTemplateLiteral4(schema_, references_, value);
    case "This":
      return FromThis(schema_, references_, value);
    case "Tuple":
      return FromTuple6(schema_, references_, value);
    case "Undefined":
      return FromUndefined2(schema_, references_, value);
    case "Union":
      return FromUnion11(schema_, references_, value);
    case "Uint8Array":
      return FromUint8Array2(schema_, references_, value);
    case "Unknown":
      return FromUnknown2(schema_, references_, value);
    case "Void":
      return FromVoid2(schema_, references_, value);
    default:
      if (!type_exports2.Has(schema_[Kind]))
        throw new ValueCheckUnknownTypeError(schema_);
      return FromKind(schema_, references_, value);
  }
}
function Check(...args) {
  return args.length === 3 ? Visit5(args[0], args[1], args[2]) : Visit5(args[0], [], args[1]);
}

// node_modules/@sinclair/typebox/build/esm/errors/errors.mjs
var ValueErrorType;
(function(ValueErrorType2) {
  ValueErrorType2[ValueErrorType2["ArrayContains"] = 0] = "ArrayContains";
  ValueErrorType2[ValueErrorType2["ArrayMaxContains"] = 1] = "ArrayMaxContains";
  ValueErrorType2[ValueErrorType2["ArrayMaxItems"] = 2] = "ArrayMaxItems";
  ValueErrorType2[ValueErrorType2["ArrayMinContains"] = 3] = "ArrayMinContains";
  ValueErrorType2[ValueErrorType2["ArrayMinItems"] = 4] = "ArrayMinItems";
  ValueErrorType2[ValueErrorType2["ArrayUniqueItems"] = 5] = "ArrayUniqueItems";
  ValueErrorType2[ValueErrorType2["Array"] = 6] = "Array";
  ValueErrorType2[ValueErrorType2["AsyncIterator"] = 7] = "AsyncIterator";
  ValueErrorType2[ValueErrorType2["BigIntExclusiveMaximum"] = 8] = "BigIntExclusiveMaximum";
  ValueErrorType2[ValueErrorType2["BigIntExclusiveMinimum"] = 9] = "BigIntExclusiveMinimum";
  ValueErrorType2[ValueErrorType2["BigIntMaximum"] = 10] = "BigIntMaximum";
  ValueErrorType2[ValueErrorType2["BigIntMinimum"] = 11] = "BigIntMinimum";
  ValueErrorType2[ValueErrorType2["BigIntMultipleOf"] = 12] = "BigIntMultipleOf";
  ValueErrorType2[ValueErrorType2["BigInt"] = 13] = "BigInt";
  ValueErrorType2[ValueErrorType2["Boolean"] = 14] = "Boolean";
  ValueErrorType2[ValueErrorType2["DateExclusiveMaximumTimestamp"] = 15] = "DateExclusiveMaximumTimestamp";
  ValueErrorType2[ValueErrorType2["DateExclusiveMinimumTimestamp"] = 16] = "DateExclusiveMinimumTimestamp";
  ValueErrorType2[ValueErrorType2["DateMaximumTimestamp"] = 17] = "DateMaximumTimestamp";
  ValueErrorType2[ValueErrorType2["DateMinimumTimestamp"] = 18] = "DateMinimumTimestamp";
  ValueErrorType2[ValueErrorType2["DateMultipleOfTimestamp"] = 19] = "DateMultipleOfTimestamp";
  ValueErrorType2[ValueErrorType2["Date"] = 20] = "Date";
  ValueErrorType2[ValueErrorType2["Function"] = 21] = "Function";
  ValueErrorType2[ValueErrorType2["IntegerExclusiveMaximum"] = 22] = "IntegerExclusiveMaximum";
  ValueErrorType2[ValueErrorType2["IntegerExclusiveMinimum"] = 23] = "IntegerExclusiveMinimum";
  ValueErrorType2[ValueErrorType2["IntegerMaximum"] = 24] = "IntegerMaximum";
  ValueErrorType2[ValueErrorType2["IntegerMinimum"] = 25] = "IntegerMinimum";
  ValueErrorType2[ValueErrorType2["IntegerMultipleOf"] = 26] = "IntegerMultipleOf";
  ValueErrorType2[ValueErrorType2["Integer"] = 27] = "Integer";
  ValueErrorType2[ValueErrorType2["IntersectUnevaluatedProperties"] = 28] = "IntersectUnevaluatedProperties";
  ValueErrorType2[ValueErrorType2["Intersect"] = 29] = "Intersect";
  ValueErrorType2[ValueErrorType2["Iterator"] = 30] = "Iterator";
  ValueErrorType2[ValueErrorType2["Kind"] = 31] = "Kind";
  ValueErrorType2[ValueErrorType2["Literal"] = 32] = "Literal";
  ValueErrorType2[ValueErrorType2["Never"] = 33] = "Never";
  ValueErrorType2[ValueErrorType2["Not"] = 34] = "Not";
  ValueErrorType2[ValueErrorType2["Null"] = 35] = "Null";
  ValueErrorType2[ValueErrorType2["NumberExclusiveMaximum"] = 36] = "NumberExclusiveMaximum";
  ValueErrorType2[ValueErrorType2["NumberExclusiveMinimum"] = 37] = "NumberExclusiveMinimum";
  ValueErrorType2[ValueErrorType2["NumberMaximum"] = 38] = "NumberMaximum";
  ValueErrorType2[ValueErrorType2["NumberMinimum"] = 39] = "NumberMinimum";
  ValueErrorType2[ValueErrorType2["NumberMultipleOf"] = 40] = "NumberMultipleOf";
  ValueErrorType2[ValueErrorType2["Number"] = 41] = "Number";
  ValueErrorType2[ValueErrorType2["ObjectAdditionalProperties"] = 42] = "ObjectAdditionalProperties";
  ValueErrorType2[ValueErrorType2["ObjectMaxProperties"] = 43] = "ObjectMaxProperties";
  ValueErrorType2[ValueErrorType2["ObjectMinProperties"] = 44] = "ObjectMinProperties";
  ValueErrorType2[ValueErrorType2["ObjectRequiredProperty"] = 45] = "ObjectRequiredProperty";
  ValueErrorType2[ValueErrorType2["Object"] = 46] = "Object";
  ValueErrorType2[ValueErrorType2["Promise"] = 47] = "Promise";
  ValueErrorType2[ValueErrorType2["RegExp"] = 48] = "RegExp";
  ValueErrorType2[ValueErrorType2["StringFormatUnknown"] = 49] = "StringFormatUnknown";
  ValueErrorType2[ValueErrorType2["StringFormat"] = 50] = "StringFormat";
  ValueErrorType2[ValueErrorType2["StringMaxLength"] = 51] = "StringMaxLength";
  ValueErrorType2[ValueErrorType2["StringMinLength"] = 52] = "StringMinLength";
  ValueErrorType2[ValueErrorType2["StringPattern"] = 53] = "StringPattern";
  ValueErrorType2[ValueErrorType2["String"] = 54] = "String";
  ValueErrorType2[ValueErrorType2["Symbol"] = 55] = "Symbol";
  ValueErrorType2[ValueErrorType2["TupleLength"] = 56] = "TupleLength";
  ValueErrorType2[ValueErrorType2["Tuple"] = 57] = "Tuple";
  ValueErrorType2[ValueErrorType2["Uint8ArrayMaxByteLength"] = 58] = "Uint8ArrayMaxByteLength";
  ValueErrorType2[ValueErrorType2["Uint8ArrayMinByteLength"] = 59] = "Uint8ArrayMinByteLength";
  ValueErrorType2[ValueErrorType2["Uint8Array"] = 60] = "Uint8Array";
  ValueErrorType2[ValueErrorType2["Undefined"] = 61] = "Undefined";
  ValueErrorType2[ValueErrorType2["Union"] = 62] = "Union";
  ValueErrorType2[ValueErrorType2["Void"] = 63] = "Void";
})(ValueErrorType || (ValueErrorType = {}));
var ValueErrorsUnknownTypeError = class extends TypeBoxError {
  constructor(schema) {
    super("Unknown type");
    this.schema = schema;
  }
};
function EscapeKey(key) {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}
function IsDefined2(value) {
  return value !== void 0;
}
var ValueErrorIterator = class {
  constructor(iterator) {
    this.iterator = iterator;
  }
  [Symbol.iterator]() {
    return this.iterator;
  }
  /** Returns the first value error or undefined if no errors */
  First() {
    const next = this.iterator.next();
    return next.done ? void 0 : next.value;
  }
};
function Create(errorType, schema, path14, value, errors = []) {
  return {
    type: errorType,
    schema,
    path: path14,
    value,
    message: GetErrorFunction()({ errorType, path: path14, schema, value, errors }),
    errors
  };
}
function* FromAny3(schema, references, path14, value) {
}
function* FromArgument3(schema, references, path14, value) {
}
function* FromArray8(schema, references, path14, value) {
  if (!IsArray2(value)) {
    return yield Create(ValueErrorType.Array, schema, path14, value);
  }
  if (IsDefined2(schema.minItems) && !(value.length >= schema.minItems)) {
    yield Create(ValueErrorType.ArrayMinItems, schema, path14, value);
  }
  if (IsDefined2(schema.maxItems) && !(value.length <= schema.maxItems)) {
    yield Create(ValueErrorType.ArrayMaxItems, schema, path14, value);
  }
  for (let i = 0; i < value.length; i++) {
    yield* Visit6(schema.items, references, `${path14}/${i}`, value[i]);
  }
  if (schema.uniqueItems === true && !(function() {
    const set = /* @__PURE__ */ new Set();
    for (const element of value) {
      const hashed = Hash(element);
      if (set.has(hashed)) {
        return false;
      } else {
        set.add(hashed);
      }
    }
    return true;
  })()) {
    yield Create(ValueErrorType.ArrayUniqueItems, schema, path14, value);
  }
  if (!(IsDefined2(schema.contains) || IsDefined2(schema.minContains) || IsDefined2(schema.maxContains))) {
    return;
  }
  const containsSchema = IsDefined2(schema.contains) ? schema.contains : Never();
  const containsCount = value.reduce((acc, value2, index) => Visit6(containsSchema, references, `${path14}${index}`, value2).next().done === true ? acc + 1 : acc, 0);
  if (containsCount === 0) {
    yield Create(ValueErrorType.ArrayContains, schema, path14, value);
  }
  if (IsNumber2(schema.minContains) && containsCount < schema.minContains) {
    yield Create(ValueErrorType.ArrayMinContains, schema, path14, value);
  }
  if (IsNumber2(schema.maxContains) && containsCount > schema.maxContains) {
    yield Create(ValueErrorType.ArrayMaxContains, schema, path14, value);
  }
}
function* FromAsyncIterator5(schema, references, path14, value) {
  if (!IsAsyncIterator2(value))
    yield Create(ValueErrorType.AsyncIterator, schema, path14, value);
}
function* FromBigInt3(schema, references, path14, value) {
  if (!IsBigInt2(value))
    return yield Create(ValueErrorType.BigInt, schema, path14, value);
  if (IsDefined2(schema.exclusiveMaximum) && !(value < schema.exclusiveMaximum)) {
    yield Create(ValueErrorType.BigIntExclusiveMaximum, schema, path14, value);
  }
  if (IsDefined2(schema.exclusiveMinimum) && !(value > schema.exclusiveMinimum)) {
    yield Create(ValueErrorType.BigIntExclusiveMinimum, schema, path14, value);
  }
  if (IsDefined2(schema.maximum) && !(value <= schema.maximum)) {
    yield Create(ValueErrorType.BigIntMaximum, schema, path14, value);
  }
  if (IsDefined2(schema.minimum) && !(value >= schema.minimum)) {
    yield Create(ValueErrorType.BigIntMinimum, schema, path14, value);
  }
  if (IsDefined2(schema.multipleOf) && !(value % schema.multipleOf === BigInt(0))) {
    yield Create(ValueErrorType.BigIntMultipleOf, schema, path14, value);
  }
}
function* FromBoolean3(schema, references, path14, value) {
  if (!IsBoolean2(value))
    yield Create(ValueErrorType.Boolean, schema, path14, value);
}
function* FromConstructor5(schema, references, path14, value) {
  yield* Visit6(schema.returns, references, path14, value.prototype);
}
function* FromDate3(schema, references, path14, value) {
  if (!IsDate2(value))
    return yield Create(ValueErrorType.Date, schema, path14, value);
  if (IsDefined2(schema.exclusiveMaximumTimestamp) && !(value.getTime() < schema.exclusiveMaximumTimestamp)) {
    yield Create(ValueErrorType.DateExclusiveMaximumTimestamp, schema, path14, value);
  }
  if (IsDefined2(schema.exclusiveMinimumTimestamp) && !(value.getTime() > schema.exclusiveMinimumTimestamp)) {
    yield Create(ValueErrorType.DateExclusiveMinimumTimestamp, schema, path14, value);
  }
  if (IsDefined2(schema.maximumTimestamp) && !(value.getTime() <= schema.maximumTimestamp)) {
    yield Create(ValueErrorType.DateMaximumTimestamp, schema, path14, value);
  }
  if (IsDefined2(schema.minimumTimestamp) && !(value.getTime() >= schema.minimumTimestamp)) {
    yield Create(ValueErrorType.DateMinimumTimestamp, schema, path14, value);
  }
  if (IsDefined2(schema.multipleOfTimestamp) && !(value.getTime() % schema.multipleOfTimestamp === 0)) {
    yield Create(ValueErrorType.DateMultipleOfTimestamp, schema, path14, value);
  }
}
function* FromFunction5(schema, references, path14, value) {
  if (!IsFunction2(value))
    yield Create(ValueErrorType.Function, schema, path14, value);
}
function* FromImport2(schema, references, path14, value) {
  const definitions = globalThis.Object.values(schema.$defs);
  const target = schema.$defs[schema.$ref];
  yield* Visit6(target, [...references, ...definitions], path14, value);
}
function* FromInteger3(schema, references, path14, value) {
  if (!IsInteger(value))
    return yield Create(ValueErrorType.Integer, schema, path14, value);
  if (IsDefined2(schema.exclusiveMaximum) && !(value < schema.exclusiveMaximum)) {
    yield Create(ValueErrorType.IntegerExclusiveMaximum, schema, path14, value);
  }
  if (IsDefined2(schema.exclusiveMinimum) && !(value > schema.exclusiveMinimum)) {
    yield Create(ValueErrorType.IntegerExclusiveMinimum, schema, path14, value);
  }
  if (IsDefined2(schema.maximum) && !(value <= schema.maximum)) {
    yield Create(ValueErrorType.IntegerMaximum, schema, path14, value);
  }
  if (IsDefined2(schema.minimum) && !(value >= schema.minimum)) {
    yield Create(ValueErrorType.IntegerMinimum, schema, path14, value);
  }
  if (IsDefined2(schema.multipleOf) && !(value % schema.multipleOf === 0)) {
    yield Create(ValueErrorType.IntegerMultipleOf, schema, path14, value);
  }
}
function* FromIntersect10(schema, references, path14, value) {
  let hasError = false;
  for (const inner of schema.allOf) {
    for (const error of Visit6(inner, references, path14, value)) {
      hasError = true;
      yield error;
    }
  }
  if (hasError) {
    return yield Create(ValueErrorType.Intersect, schema, path14, value);
  }
  if (schema.unevaluatedProperties === false) {
    const keyCheck = new RegExp(KeyOfPattern(schema));
    for (const valueKey of Object.getOwnPropertyNames(value)) {
      if (!keyCheck.test(valueKey)) {
        yield Create(ValueErrorType.IntersectUnevaluatedProperties, schema, `${path14}/${valueKey}`, value);
      }
    }
  }
  if (typeof schema.unevaluatedProperties === "object") {
    const keyCheck = new RegExp(KeyOfPattern(schema));
    for (const valueKey of Object.getOwnPropertyNames(value)) {
      if (!keyCheck.test(valueKey)) {
        const next = Visit6(schema.unevaluatedProperties, references, `${path14}/${valueKey}`, value[valueKey]).next();
        if (!next.done)
          yield next.value;
      }
    }
  }
}
function* FromIterator5(schema, references, path14, value) {
  if (!IsIterator2(value))
    yield Create(ValueErrorType.Iterator, schema, path14, value);
}
function* FromLiteral4(schema, references, path14, value) {
  if (!(value === schema.const))
    yield Create(ValueErrorType.Literal, schema, path14, value);
}
function* FromNever3(schema, references, path14, value) {
  yield Create(ValueErrorType.Never, schema, path14, value);
}
function* FromNot3(schema, references, path14, value) {
  if (Visit6(schema.not, references, path14, value).next().done === true)
    yield Create(ValueErrorType.Not, schema, path14, value);
}
function* FromNull3(schema, references, path14, value) {
  if (!IsNull2(value))
    yield Create(ValueErrorType.Null, schema, path14, value);
}
function* FromNumber3(schema, references, path14, value) {
  if (!TypeSystemPolicy.IsNumberLike(value))
    return yield Create(ValueErrorType.Number, schema, path14, value);
  if (IsDefined2(schema.exclusiveMaximum) && !(value < schema.exclusiveMaximum)) {
    yield Create(ValueErrorType.NumberExclusiveMaximum, schema, path14, value);
  }
  if (IsDefined2(schema.exclusiveMinimum) && !(value > schema.exclusiveMinimum)) {
    yield Create(ValueErrorType.NumberExclusiveMinimum, schema, path14, value);
  }
  if (IsDefined2(schema.maximum) && !(value <= schema.maximum)) {
    yield Create(ValueErrorType.NumberMaximum, schema, path14, value);
  }
  if (IsDefined2(schema.minimum) && !(value >= schema.minimum)) {
    yield Create(ValueErrorType.NumberMinimum, schema, path14, value);
  }
  if (IsDefined2(schema.multipleOf) && !(value % schema.multipleOf === 0)) {
    yield Create(ValueErrorType.NumberMultipleOf, schema, path14, value);
  }
}
function* FromObject9(schema, references, path14, value) {
  if (!TypeSystemPolicy.IsObjectLike(value))
    return yield Create(ValueErrorType.Object, schema, path14, value);
  if (IsDefined2(schema.minProperties) && !(Object.getOwnPropertyNames(value).length >= schema.minProperties)) {
    yield Create(ValueErrorType.ObjectMinProperties, schema, path14, value);
  }
  if (IsDefined2(schema.maxProperties) && !(Object.getOwnPropertyNames(value).length <= schema.maxProperties)) {
    yield Create(ValueErrorType.ObjectMaxProperties, schema, path14, value);
  }
  const requiredKeys = Array.isArray(schema.required) ? schema.required : [];
  const knownKeys = Object.getOwnPropertyNames(schema.properties);
  const unknownKeys = Object.getOwnPropertyNames(value);
  for (const requiredKey of requiredKeys) {
    if (unknownKeys.includes(requiredKey))
      continue;
    yield Create(ValueErrorType.ObjectRequiredProperty, schema.properties[requiredKey], `${path14}/${EscapeKey(requiredKey)}`, void 0);
  }
  if (schema.additionalProperties === false) {
    for (const valueKey of unknownKeys) {
      if (!knownKeys.includes(valueKey)) {
        yield Create(ValueErrorType.ObjectAdditionalProperties, schema, `${path14}/${EscapeKey(valueKey)}`, value[valueKey]);
      }
    }
  }
  if (typeof schema.additionalProperties === "object") {
    for (const valueKey of unknownKeys) {
      if (knownKeys.includes(valueKey))
        continue;
      yield* Visit6(schema.additionalProperties, references, `${path14}/${EscapeKey(valueKey)}`, value[valueKey]);
    }
  }
  for (const knownKey of knownKeys) {
    const property = schema.properties[knownKey];
    if (schema.required && schema.required.includes(knownKey)) {
      yield* Visit6(property, references, `${path14}/${EscapeKey(knownKey)}`, value[knownKey]);
      if (ExtendsUndefinedCheck(schema) && !(knownKey in value)) {
        yield Create(ValueErrorType.ObjectRequiredProperty, property, `${path14}/${EscapeKey(knownKey)}`, void 0);
      }
    } else {
      if (TypeSystemPolicy.IsExactOptionalProperty(value, knownKey)) {
        yield* Visit6(property, references, `${path14}/${EscapeKey(knownKey)}`, value[knownKey]);
      }
    }
  }
}
function* FromPromise5(schema, references, path14, value) {
  if (!IsPromise(value))
    yield Create(ValueErrorType.Promise, schema, path14, value);
}
function* FromRecord5(schema, references, path14, value) {
  if (!TypeSystemPolicy.IsRecordLike(value))
    return yield Create(ValueErrorType.Object, schema, path14, value);
  if (IsDefined2(schema.minProperties) && !(Object.getOwnPropertyNames(value).length >= schema.minProperties)) {
    yield Create(ValueErrorType.ObjectMinProperties, schema, path14, value);
  }
  if (IsDefined2(schema.maxProperties) && !(Object.getOwnPropertyNames(value).length <= schema.maxProperties)) {
    yield Create(ValueErrorType.ObjectMaxProperties, schema, path14, value);
  }
  const [patternKey, patternSchema] = Object.entries(schema.patternProperties)[0];
  const regex = new RegExp(patternKey);
  for (const [propertyKey, propertyValue] of Object.entries(value)) {
    if (regex.test(propertyKey))
      yield* Visit6(patternSchema, references, `${path14}/${EscapeKey(propertyKey)}`, propertyValue);
  }
  if (typeof schema.additionalProperties === "object") {
    for (const [propertyKey, propertyValue] of Object.entries(value)) {
      if (!regex.test(propertyKey))
        yield* Visit6(schema.additionalProperties, references, `${path14}/${EscapeKey(propertyKey)}`, propertyValue);
    }
  }
  if (schema.additionalProperties === false) {
    for (const [propertyKey, propertyValue] of Object.entries(value)) {
      if (regex.test(propertyKey))
        continue;
      return yield Create(ValueErrorType.ObjectAdditionalProperties, schema, `${path14}/${EscapeKey(propertyKey)}`, propertyValue);
    }
  }
}
function* FromRef6(schema, references, path14, value) {
  yield* Visit6(Deref(schema, references), references, path14, value);
}
function* FromRegExp3(schema, references, path14, value) {
  if (!IsString2(value))
    return yield Create(ValueErrorType.String, schema, path14, value);
  if (IsDefined2(schema.minLength) && !(value.length >= schema.minLength)) {
    yield Create(ValueErrorType.StringMinLength, schema, path14, value);
  }
  if (IsDefined2(schema.maxLength) && !(value.length <= schema.maxLength)) {
    yield Create(ValueErrorType.StringMaxLength, schema, path14, value);
  }
  const regex = new RegExp(schema.source, schema.flags);
  if (!regex.test(value)) {
    return yield Create(ValueErrorType.RegExp, schema, path14, value);
  }
}
function* FromString3(schema, references, path14, value) {
  if (!IsString2(value))
    return yield Create(ValueErrorType.String, schema, path14, value);
  if (IsDefined2(schema.minLength) && !(value.length >= schema.minLength)) {
    yield Create(ValueErrorType.StringMinLength, schema, path14, value);
  }
  if (IsDefined2(schema.maxLength) && !(value.length <= schema.maxLength)) {
    yield Create(ValueErrorType.StringMaxLength, schema, path14, value);
  }
  if (IsString2(schema.pattern)) {
    const regex = new RegExp(schema.pattern);
    if (!regex.test(value)) {
      yield Create(ValueErrorType.StringPattern, schema, path14, value);
    }
  }
  if (IsString2(schema.format)) {
    if (!format_exports.Has(schema.format)) {
      yield Create(ValueErrorType.StringFormatUnknown, schema, path14, value);
    } else {
      const format = format_exports.Get(schema.format);
      if (!format(value)) {
        yield Create(ValueErrorType.StringFormat, schema, path14, value);
      }
    }
  }
}
function* FromSymbol3(schema, references, path14, value) {
  if (!IsSymbol2(value))
    yield Create(ValueErrorType.Symbol, schema, path14, value);
}
function* FromTemplateLiteral5(schema, references, path14, value) {
  if (!IsString2(value))
    return yield Create(ValueErrorType.String, schema, path14, value);
  const regex = new RegExp(schema.pattern);
  if (!regex.test(value)) {
    yield Create(ValueErrorType.StringPattern, schema, path14, value);
  }
}
function* FromThis2(schema, references, path14, value) {
  yield* Visit6(Deref(schema, references), references, path14, value);
}
function* FromTuple7(schema, references, path14, value) {
  if (!IsArray2(value))
    return yield Create(ValueErrorType.Tuple, schema, path14, value);
  if (schema.items === void 0 && !(value.length === 0)) {
    return yield Create(ValueErrorType.TupleLength, schema, path14, value);
  }
  if (!(value.length === schema.maxItems)) {
    return yield Create(ValueErrorType.TupleLength, schema, path14, value);
  }
  if (!schema.items) {
    return;
  }
  for (let i = 0; i < schema.items.length; i++) {
    yield* Visit6(schema.items[i], references, `${path14}/${i}`, value[i]);
  }
}
function* FromUndefined3(schema, references, path14, value) {
  if (!IsUndefined2(value))
    yield Create(ValueErrorType.Undefined, schema, path14, value);
}
function* FromUnion12(schema, references, path14, value) {
  if (Check(schema, references, value))
    return;
  const errors = schema.anyOf.map((variant) => new ValueErrorIterator(Visit6(variant, references, path14, value)));
  yield Create(ValueErrorType.Union, schema, path14, value, errors);
}
function* FromUint8Array3(schema, references, path14, value) {
  if (!IsUint8Array2(value))
    return yield Create(ValueErrorType.Uint8Array, schema, path14, value);
  if (IsDefined2(schema.maxByteLength) && !(value.length <= schema.maxByteLength)) {
    yield Create(ValueErrorType.Uint8ArrayMaxByteLength, schema, path14, value);
  }
  if (IsDefined2(schema.minByteLength) && !(value.length >= schema.minByteLength)) {
    yield Create(ValueErrorType.Uint8ArrayMinByteLength, schema, path14, value);
  }
}
function* FromUnknown3(schema, references, path14, value) {
}
function* FromVoid3(schema, references, path14, value) {
  if (!TypeSystemPolicy.IsVoidLike(value))
    yield Create(ValueErrorType.Void, schema, path14, value);
}
function* FromKind2(schema, references, path14, value) {
  const check = type_exports2.Get(schema[Kind]);
  if (!check(schema, value))
    yield Create(ValueErrorType.Kind, schema, path14, value);
}
function* Visit6(schema, references, path14, value) {
  const references_ = IsDefined2(schema.$id) ? [...references, schema] : references;
  const schema_ = schema;
  switch (schema_[Kind]) {
    case "Any":
      return yield* FromAny3(schema_, references_, path14, value);
    case "Argument":
      return yield* FromArgument3(schema_, references_, path14, value);
    case "Array":
      return yield* FromArray8(schema_, references_, path14, value);
    case "AsyncIterator":
      return yield* FromAsyncIterator5(schema_, references_, path14, value);
    case "BigInt":
      return yield* FromBigInt3(schema_, references_, path14, value);
    case "Boolean":
      return yield* FromBoolean3(schema_, references_, path14, value);
    case "Constructor":
      return yield* FromConstructor5(schema_, references_, path14, value);
    case "Date":
      return yield* FromDate3(schema_, references_, path14, value);
    case "Function":
      return yield* FromFunction5(schema_, references_, path14, value);
    case "Import":
      return yield* FromImport2(schema_, references_, path14, value);
    case "Integer":
      return yield* FromInteger3(schema_, references_, path14, value);
    case "Intersect":
      return yield* FromIntersect10(schema_, references_, path14, value);
    case "Iterator":
      return yield* FromIterator5(schema_, references_, path14, value);
    case "Literal":
      return yield* FromLiteral4(schema_, references_, path14, value);
    case "Never":
      return yield* FromNever3(schema_, references_, path14, value);
    case "Not":
      return yield* FromNot3(schema_, references_, path14, value);
    case "Null":
      return yield* FromNull3(schema_, references_, path14, value);
    case "Number":
      return yield* FromNumber3(schema_, references_, path14, value);
    case "Object":
      return yield* FromObject9(schema_, references_, path14, value);
    case "Promise":
      return yield* FromPromise5(schema_, references_, path14, value);
    case "Record":
      return yield* FromRecord5(schema_, references_, path14, value);
    case "Ref":
      return yield* FromRef6(schema_, references_, path14, value);
    case "RegExp":
      return yield* FromRegExp3(schema_, references_, path14, value);
    case "String":
      return yield* FromString3(schema_, references_, path14, value);
    case "Symbol":
      return yield* FromSymbol3(schema_, references_, path14, value);
    case "TemplateLiteral":
      return yield* FromTemplateLiteral5(schema_, references_, path14, value);
    case "This":
      return yield* FromThis2(schema_, references_, path14, value);
    case "Tuple":
      return yield* FromTuple7(schema_, references_, path14, value);
    case "Undefined":
      return yield* FromUndefined3(schema_, references_, path14, value);
    case "Union":
      return yield* FromUnion12(schema_, references_, path14, value);
    case "Uint8Array":
      return yield* FromUint8Array3(schema_, references_, path14, value);
    case "Unknown":
      return yield* FromUnknown3(schema_, references_, path14, value);
    case "Void":
      return yield* FromVoid3(schema_, references_, path14, value);
    default:
      if (!type_exports2.Has(schema_[Kind]))
        throw new ValueErrorsUnknownTypeError(schema);
      return yield* FromKind2(schema_, references_, path14, value);
  }
}
function Errors(...args) {
  const iterator = args.length === 3 ? Visit6(args[0], args[1], "", args[2]) : Visit6(args[0], [], "", args[1]);
  return new ValueErrorIterator(iterator);
}

// node_modules/@sinclair/typebox/build/esm/value/assert/assert.mjs
var __classPrivateFieldSet = function(receiver, state, value, kind, f) {
  if (kind === "m") throw new TypeError("Private method is not writable");
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
};
var __classPrivateFieldGet = function(receiver, state, kind, f) {
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _AssertError_instances;
var _AssertError_iterator;
var _AssertError_Iterator;
var AssertError = class extends TypeBoxError {
  constructor(iterator) {
    const error = iterator.First();
    super(error === void 0 ? "Invalid Value" : error.message);
    _AssertError_instances.add(this);
    _AssertError_iterator.set(this, void 0);
    __classPrivateFieldSet(this, _AssertError_iterator, iterator, "f");
    this.error = error;
  }
  /** Returns an iterator for each error in this value. */
  Errors() {
    return new ValueErrorIterator(__classPrivateFieldGet(this, _AssertError_instances, "m", _AssertError_Iterator).call(this));
  }
};
_AssertError_iterator = /* @__PURE__ */ new WeakMap(), _AssertError_instances = /* @__PURE__ */ new WeakSet(), _AssertError_Iterator = function* _AssertError_Iterator2() {
  if (this.error)
    yield this.error;
  yield* __classPrivateFieldGet(this, _AssertError_iterator, "f");
};
function AssertValue(schema, references, value) {
  if (Check(schema, references, value))
    return;
  throw new AssertError(Errors(schema, references, value));
}
function Assert(...args) {
  return args.length === 3 ? AssertValue(args[0], args[1], args[2]) : AssertValue(args[0], [], args[1]);
}

// node_modules/@sinclair/typebox/build/esm/value/clone/clone.mjs
function FromObject10(value) {
  const Acc = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    Acc[key] = Clone2(value[key]);
  }
  for (const key of Object.getOwnPropertySymbols(value)) {
    Acc[key] = Clone2(value[key]);
  }
  return Acc;
}
function FromArray9(value) {
  return value.map((element) => Clone2(element));
}
function FromTypedArray(value) {
  return value.slice();
}
function FromMap(value) {
  return new Map(Clone2([...value.entries()]));
}
function FromSet(value) {
  return new Set(Clone2([...value.entries()]));
}
function FromDate4(value) {
  return new Date(value.toISOString());
}
function FromValue2(value) {
  return value;
}
function Clone2(value) {
  if (IsArray2(value))
    return FromArray9(value);
  if (IsDate2(value))
    return FromDate4(value);
  if (IsTypedArray(value))
    return FromTypedArray(value);
  if (IsMap(value))
    return FromMap(value);
  if (IsSet(value))
    return FromSet(value);
  if (IsObject2(value))
    return FromObject10(value);
  if (IsValueType(value))
    return FromValue2(value);
  throw new Error("ValueClone: Unable to clone value");
}

// node_modules/@sinclair/typebox/build/esm/value/create/create.mjs
var ValueCreateError = class extends TypeBoxError {
  constructor(schema, message) {
    super(message);
    this.schema = schema;
  }
};
function FromDefault(value) {
  return IsFunction2(value) ? value() : Clone2(value);
}
function FromAny4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return {};
  }
}
function FromArgument4(schema, references) {
  return {};
}
function FromArray10(schema, references) {
  if (schema.uniqueItems === true && !HasPropertyKey2(schema, "default")) {
    throw new ValueCreateError(schema, "Array with the uniqueItems constraint requires a default value");
  } else if ("contains" in schema && !HasPropertyKey2(schema, "default")) {
    throw new ValueCreateError(schema, "Array with the contains constraint requires a default value");
  } else if ("default" in schema) {
    return FromDefault(schema.default);
  } else if (schema.minItems !== void 0) {
    return Array.from({ length: schema.minItems }).map((item) => {
      return Visit7(schema.items, references);
    });
  } else {
    return [];
  }
}
function FromAsyncIterator6(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return (async function* () {
    })();
  }
}
function FromBigInt4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return BigInt(0);
  }
}
function FromBoolean4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return false;
  }
}
function FromConstructor6(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    const value = Visit7(schema.returns, references);
    if (typeof value === "object" && !Array.isArray(value)) {
      return class {
        constructor() {
          for (const [key, val] of Object.entries(value)) {
            const self = this;
            self[key] = val;
          }
        }
      };
    } else {
      return class {
      };
    }
  }
}
function FromDate5(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else if (schema.minimumTimestamp !== void 0) {
    return new Date(schema.minimumTimestamp);
  } else {
    return /* @__PURE__ */ new Date();
  }
}
function FromFunction6(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return () => Visit7(schema.returns, references);
  }
}
function FromImport3(schema, references) {
  const definitions = globalThis.Object.values(schema.$defs);
  const target = schema.$defs[schema.$ref];
  return Visit7(target, [...references, ...definitions]);
}
function FromInteger4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else if (schema.minimum !== void 0) {
    return schema.minimum;
  } else {
    return 0;
  }
}
function FromIntersect11(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    const value = schema.allOf.reduce((acc, schema2) => {
      const next = Visit7(schema2, references);
      return typeof next === "object" ? { ...acc, ...next } : next;
    }, {});
    if (!Check(schema, references, value))
      throw new ValueCreateError(schema, "Intersect produced invalid value. Consider using a default value.");
    return value;
  }
}
function FromIterator6(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return (function* () {
    })();
  }
}
function FromLiteral5(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return schema.const;
  }
}
function FromNever4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    throw new ValueCreateError(schema, "Never types cannot be created. Consider using a default value.");
  }
}
function FromNot4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    throw new ValueCreateError(schema, "Not types must have a default value");
  }
}
function FromNull4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return null;
  }
}
function FromNumber4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else if (schema.minimum !== void 0) {
    return schema.minimum;
  } else {
    return 0;
  }
}
function FromObject11(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    const required = new Set(schema.required);
    const Acc = {};
    for (const [key, subschema] of Object.entries(schema.properties)) {
      if (!required.has(key))
        continue;
      Acc[key] = Visit7(subschema, references);
    }
    return Acc;
  }
}
function FromPromise6(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return Promise.resolve(Visit7(schema.item, references));
  }
}
function FromRecord6(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return {};
  }
}
function FromRef7(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return Visit7(Deref(schema, references), references);
  }
}
function FromRegExp4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    throw new ValueCreateError(schema, "RegExp types cannot be created. Consider using a default value.");
  }
}
function FromString4(schema, references) {
  if (schema.pattern !== void 0) {
    if (!HasPropertyKey2(schema, "default")) {
      throw new ValueCreateError(schema, "String types with patterns must specify a default value");
    } else {
      return FromDefault(schema.default);
    }
  } else if (schema.format !== void 0) {
    if (!HasPropertyKey2(schema, "default")) {
      throw new ValueCreateError(schema, "String types with formats must specify a default value");
    } else {
      return FromDefault(schema.default);
    }
  } else {
    if (HasPropertyKey2(schema, "default")) {
      return FromDefault(schema.default);
    } else if (schema.minLength !== void 0) {
      return Array.from({ length: schema.minLength }).map(() => " ").join("");
    } else {
      return "";
    }
  }
}
function FromSymbol4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else if ("value" in schema) {
    return Symbol.for(schema.value);
  } else {
    return Symbol();
  }
}
function FromTemplateLiteral6(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  }
  if (!IsTemplateLiteralFinite(schema))
    throw new ValueCreateError(schema, "Can only create template literals that produce a finite variants. Consider using a default value.");
  const generated = TemplateLiteralGenerate(schema);
  return generated[0];
}
function FromThis3(schema, references) {
  if (recursiveDepth++ > recursiveMaxDepth)
    throw new ValueCreateError(schema, "Cannot create recursive type as it appears possibly infinite. Consider using a default.");
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return Visit7(Deref(schema, references), references);
  }
}
function FromTuple8(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  }
  if (schema.items === void 0) {
    return [];
  } else {
    return Array.from({ length: schema.minItems }).map((_, index) => Visit7(schema.items[index], references));
  }
}
function FromUndefined4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return void 0;
  }
}
function FromUnion13(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else if (schema.anyOf.length === 0) {
    throw new Error("ValueCreate.Union: Cannot create Union with zero variants");
  } else {
    return Visit7(schema.anyOf[0], references);
  }
}
function FromUint8Array4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else if (schema.minByteLength !== void 0) {
    return new Uint8Array(schema.minByteLength);
  } else {
    return new Uint8Array(0);
  }
}
function FromUnknown4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return {};
  }
}
function FromVoid4(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    return void 0;
  }
}
function FromKind3(schema, references) {
  if (HasPropertyKey2(schema, "default")) {
    return FromDefault(schema.default);
  } else {
    throw new Error("User defined types must specify a default value");
  }
}
function Visit7(schema, references) {
  const references_ = Pushref(schema, references);
  const schema_ = schema;
  switch (schema_[Kind]) {
    case "Any":
      return FromAny4(schema_, references_);
    case "Argument":
      return FromArgument4(schema_, references_);
    case "Array":
      return FromArray10(schema_, references_);
    case "AsyncIterator":
      return FromAsyncIterator6(schema_, references_);
    case "BigInt":
      return FromBigInt4(schema_, references_);
    case "Boolean":
      return FromBoolean4(schema_, references_);
    case "Constructor":
      return FromConstructor6(schema_, references_);
    case "Date":
      return FromDate5(schema_, references_);
    case "Function":
      return FromFunction6(schema_, references_);
    case "Import":
      return FromImport3(schema_, references_);
    case "Integer":
      return FromInteger4(schema_, references_);
    case "Intersect":
      return FromIntersect11(schema_, references_);
    case "Iterator":
      return FromIterator6(schema_, references_);
    case "Literal":
      return FromLiteral5(schema_, references_);
    case "Never":
      return FromNever4(schema_, references_);
    case "Not":
      return FromNot4(schema_, references_);
    case "Null":
      return FromNull4(schema_, references_);
    case "Number":
      return FromNumber4(schema_, references_);
    case "Object":
      return FromObject11(schema_, references_);
    case "Promise":
      return FromPromise6(schema_, references_);
    case "Record":
      return FromRecord6(schema_, references_);
    case "Ref":
      return FromRef7(schema_, references_);
    case "RegExp":
      return FromRegExp4(schema_, references_);
    case "String":
      return FromString4(schema_, references_);
    case "Symbol":
      return FromSymbol4(schema_, references_);
    case "TemplateLiteral":
      return FromTemplateLiteral6(schema_, references_);
    case "This":
      return FromThis3(schema_, references_);
    case "Tuple":
      return FromTuple8(schema_, references_);
    case "Undefined":
      return FromUndefined4(schema_, references_);
    case "Union":
      return FromUnion13(schema_, references_);
    case "Uint8Array":
      return FromUint8Array4(schema_, references_);
    case "Unknown":
      return FromUnknown4(schema_, references_);
    case "Void":
      return FromVoid4(schema_, references_);
    default:
      if (!type_exports2.Has(schema_[Kind]))
        throw new ValueCreateError(schema_, "Unknown type");
      return FromKind3(schema_, references_);
  }
}
var recursiveMaxDepth = 512;
var recursiveDepth = 0;
function Create2(...args) {
  recursiveDepth = 0;
  return args.length === 2 ? Visit7(args[0], args[1]) : Visit7(args[0], []);
}

// node_modules/@sinclair/typebox/build/esm/value/cast/cast.mjs
var ValueCastError = class extends TypeBoxError {
  constructor(schema, message) {
    super(message);
    this.schema = schema;
  }
};
function ScoreUnion(schema, references, value) {
  if (schema[Kind] === "Object" && typeof value === "object" && !IsNull2(value)) {
    const object = schema;
    const keys = Object.getOwnPropertyNames(value);
    const entries = Object.entries(object.properties);
    return entries.reduce((acc, [key, schema2]) => {
      const literal = schema2[Kind] === "Literal" && schema2.const === value[key] ? 100 : 0;
      const checks = Check(schema2, references, value[key]) ? 10 : 0;
      const exists = keys.includes(key) ? 1 : 0;
      return acc + (literal + checks + exists);
    }, 0);
  } else if (schema[Kind] === "Union") {
    const schemas = schema.anyOf.map((schema2) => Deref(schema2, references));
    const scores = schemas.map((schema2) => ScoreUnion(schema2, references, value));
    return Math.max(...scores);
  } else {
    return Check(schema, references, value) ? 1 : 0;
  }
}
function SelectUnion(union, references, value) {
  const schemas = union.anyOf.map((schema) => Deref(schema, references));
  let [select, best] = [schemas[0], 0];
  for (const schema of schemas) {
    const score = ScoreUnion(schema, references, value);
    if (score > best) {
      select = schema;
      best = score;
    }
  }
  return select;
}
function CastUnion(union, references, value) {
  if ("default" in union) {
    return typeof value === "function" ? union.default : Clone2(union.default);
  } else {
    const schema = SelectUnion(union, references, value);
    return Cast(schema, references, value);
  }
}
function DefaultClone(schema, references, value) {
  return Check(schema, references, value) ? Clone2(value) : Create2(schema, references);
}
function Default(schema, references, value) {
  return Check(schema, references, value) ? value : Create2(schema, references);
}
function FromArray11(schema, references, value) {
  if (Check(schema, references, value))
    return Clone2(value);
  const created = IsArray2(value) ? Clone2(value) : Create2(schema, references);
  const minimum = IsNumber2(schema.minItems) && created.length < schema.minItems ? [...created, ...Array.from({ length: schema.minItems - created.length }, () => null)] : created;
  const maximum = IsNumber2(schema.maxItems) && minimum.length > schema.maxItems ? minimum.slice(0, schema.maxItems) : minimum;
  const casted = maximum.map((value2) => Visit8(schema.items, references, value2));
  if (schema.uniqueItems !== true)
    return casted;
  const unique = [...new Set(casted)];
  if (!Check(schema, references, unique))
    throw new ValueCastError(schema, "Array cast produced invalid data due to uniqueItems constraint");
  return unique;
}
function FromConstructor7(schema, references, value) {
  if (Check(schema, references, value))
    return Create2(schema, references);
  const required = new Set(schema.returns.required || []);
  const result = function() {
  };
  for (const [key, property] of Object.entries(schema.returns.properties)) {
    if (!required.has(key) && value.prototype[key] === void 0)
      continue;
    result.prototype[key] = Visit8(property, references, value.prototype[key]);
  }
  return result;
}
function FromImport4(schema, references, value) {
  const definitions = globalThis.Object.values(schema.$defs);
  const target = schema.$defs[schema.$ref];
  return Visit8(target, [...references, ...definitions], value);
}
function IntersectAssign(correct, value) {
  if (IsObject2(correct) && !IsObject2(value) || !IsObject2(correct) && IsObject2(value))
    return correct;
  if (!IsObject2(correct) || !IsObject2(value))
    return value;
  return globalThis.Object.getOwnPropertyNames(correct).reduce((result, key) => {
    const property = key in value ? IntersectAssign(correct[key], value[key]) : correct[key];
    return { ...result, [key]: property };
  }, {});
}
function FromIntersect12(schema, references, value) {
  if (Check(schema, references, value))
    return value;
  const correct = Create2(schema, references);
  const assigned = IntersectAssign(correct, value);
  return Check(schema, references, assigned) ? assigned : correct;
}
function FromNever5(schema, references, value) {
  throw new ValueCastError(schema, "Never types cannot be cast");
}
function FromObject12(schema, references, value) {
  if (Check(schema, references, value))
    return value;
  if (value === null || typeof value !== "object")
    return Create2(schema, references);
  const required = new Set(schema.required || []);
  const result = {};
  for (const [key, property] of Object.entries(schema.properties)) {
    if (!required.has(key) && value[key] === void 0)
      continue;
    result[key] = Visit8(property, references, value[key]);
  }
  if (typeof schema.additionalProperties === "object") {
    const propertyNames = Object.getOwnPropertyNames(schema.properties);
    for (const propertyName of Object.getOwnPropertyNames(value)) {
      if (propertyNames.includes(propertyName))
        continue;
      result[propertyName] = Visit8(schema.additionalProperties, references, value[propertyName]);
    }
  }
  return result;
}
function FromRecord7(schema, references, value) {
  if (Check(schema, references, value))
    return Clone2(value);
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Date)
    return Create2(schema, references);
  const subschemaPropertyName = Object.getOwnPropertyNames(schema.patternProperties)[0];
  const subschema = schema.patternProperties[subschemaPropertyName];
  const result = {};
  for (const [propKey, propValue] of Object.entries(value)) {
    result[propKey] = Visit8(subschema, references, propValue);
  }
  return result;
}
function FromRef8(schema, references, value) {
  return Visit8(Deref(schema, references), references, value);
}
function FromThis4(schema, references, value) {
  return Visit8(Deref(schema, references), references, value);
}
function FromTuple9(schema, references, value) {
  if (Check(schema, references, value))
    return Clone2(value);
  if (!IsArray2(value))
    return Create2(schema, references);
  if (schema.items === void 0)
    return [];
  return schema.items.map((schema2, index) => Visit8(schema2, references, value[index]));
}
function FromUnion14(schema, references, value) {
  return Check(schema, references, value) ? Clone2(value) : CastUnion(schema, references, value);
}
function Visit8(schema, references, value) {
  const references_ = IsString2(schema.$id) ? Pushref(schema, references) : references;
  const schema_ = schema;
  switch (schema[Kind]) {
    // --------------------------------------------------------------
    // Structural
    // --------------------------------------------------------------
    case "Array":
      return FromArray11(schema_, references_, value);
    case "Constructor":
      return FromConstructor7(schema_, references_, value);
    case "Import":
      return FromImport4(schema_, references_, value);
    case "Intersect":
      return FromIntersect12(schema_, references_, value);
    case "Never":
      return FromNever5(schema_, references_, value);
    case "Object":
      return FromObject12(schema_, references_, value);
    case "Record":
      return FromRecord7(schema_, references_, value);
    case "Ref":
      return FromRef8(schema_, references_, value);
    case "This":
      return FromThis4(schema_, references_, value);
    case "Tuple":
      return FromTuple9(schema_, references_, value);
    case "Union":
      return FromUnion14(schema_, references_, value);
    // --------------------------------------------------------------
    // DefaultClone
    // --------------------------------------------------------------
    case "Date":
    case "Symbol":
    case "Uint8Array":
      return DefaultClone(schema, references, value);
    // --------------------------------------------------------------
    // Default
    // --------------------------------------------------------------
    default:
      return Default(schema_, references_, value);
  }
}
function Cast(...args) {
  return args.length === 3 ? Visit8(args[0], args[1], args[2]) : Visit8(args[0], [], args[1]);
}

// node_modules/@sinclair/typebox/build/esm/value/clean/clean.mjs
function IsCheckable(schema) {
  return IsKind(schema) && schema[Kind] !== "Unsafe";
}
function FromArray12(schema, references, value) {
  if (!IsArray2(value))
    return value;
  return value.map((value2) => Visit9(schema.items, references, value2));
}
function FromImport5(schema, references, value) {
  const definitions = globalThis.Object.values(schema.$defs);
  const target = schema.$defs[schema.$ref];
  return Visit9(target, [...references, ...definitions], value);
}
function FromIntersect13(schema, references, value) {
  const unevaluatedProperties = schema.unevaluatedProperties;
  const intersections = schema.allOf.map((schema2) => Visit9(schema2, references, Clone2(value)));
  const composite = intersections.reduce((acc, value2) => IsObject2(value2) ? { ...acc, ...value2 } : value2, {});
  if (!IsObject2(value) || !IsObject2(composite) || !IsKind(unevaluatedProperties))
    return composite;
  const knownkeys = KeyOfPropertyKeys(schema);
  for (const key of Object.getOwnPropertyNames(value)) {
    if (knownkeys.includes(key))
      continue;
    if (Check(unevaluatedProperties, references, value[key])) {
      composite[key] = Visit9(unevaluatedProperties, references, value[key]);
    }
  }
  return composite;
}
function FromObject13(schema, references, value) {
  if (!IsObject2(value) || IsArray2(value))
    return value;
  const additionalProperties = schema.additionalProperties;
  for (const key of Object.getOwnPropertyNames(value)) {
    if (HasPropertyKey2(schema.properties, key)) {
      value[key] = Visit9(schema.properties[key], references, value[key]);
      continue;
    }
    if (IsKind(additionalProperties) && Check(additionalProperties, references, value[key])) {
      value[key] = Visit9(additionalProperties, references, value[key]);
      continue;
    }
    delete value[key];
  }
  return value;
}
function FromRecord8(schema, references, value) {
  if (!IsObject2(value))
    return value;
  const additionalProperties = schema.additionalProperties;
  const propertyKeys = Object.getOwnPropertyNames(value);
  const [propertyKey, propertySchema] = Object.entries(schema.patternProperties)[0];
  const propertyKeyTest = new RegExp(propertyKey);
  for (const key of propertyKeys) {
    if (propertyKeyTest.test(key)) {
      value[key] = Visit9(propertySchema, references, value[key]);
      continue;
    }
    if (IsKind(additionalProperties) && Check(additionalProperties, references, value[key])) {
      value[key] = Visit9(additionalProperties, references, value[key]);
      continue;
    }
    delete value[key];
  }
  return value;
}
function FromRef9(schema, references, value) {
  return Visit9(Deref(schema, references), references, value);
}
function FromThis5(schema, references, value) {
  return Visit9(Deref(schema, references), references, value);
}
function FromTuple10(schema, references, value) {
  if (!IsArray2(value))
    return value;
  if (IsUndefined2(schema.items))
    return [];
  const length = Math.min(value.length, schema.items.length);
  for (let i = 0; i < length; i++) {
    value[i] = Visit9(schema.items[i], references, value[i]);
  }
  return value.length > length ? value.slice(0, length) : value;
}
function FromUnion15(schema, references, value) {
  for (const inner of schema.anyOf) {
    if (IsCheckable(inner) && Check(inner, references, value)) {
      return Visit9(inner, references, value);
    }
  }
  return value;
}
function Visit9(schema, references, value) {
  const references_ = IsString2(schema.$id) ? Pushref(schema, references) : references;
  const schema_ = schema;
  switch (schema_[Kind]) {
    case "Array":
      return FromArray12(schema_, references_, value);
    case "Import":
      return FromImport5(schema_, references_, value);
    case "Intersect":
      return FromIntersect13(schema_, references_, value);
    case "Object":
      return FromObject13(schema_, references_, value);
    case "Record":
      return FromRecord8(schema_, references_, value);
    case "Ref":
      return FromRef9(schema_, references_, value);
    case "This":
      return FromThis5(schema_, references_, value);
    case "Tuple":
      return FromTuple10(schema_, references_, value);
    case "Union":
      return FromUnion15(schema_, references_, value);
    default:
      return value;
  }
}
function Clean(...args) {
  return args.length === 3 ? Visit9(args[0], args[1], args[2]) : Visit9(args[0], [], args[1]);
}

// node_modules/@sinclair/typebox/build/esm/value/convert/convert.mjs
function IsStringNumeric(value) {
  return IsString2(value) && !isNaN(value) && !isNaN(parseFloat(value));
}
function IsValueToString(value) {
  return IsBigInt2(value) || IsBoolean2(value) || IsNumber2(value);
}
function IsValueTrue(value) {
  return value === true || IsNumber2(value) && value === 1 || IsBigInt2(value) && value === BigInt("1") || IsString2(value) && (value.toLowerCase() === "true" || value === "1");
}
function IsValueFalse(value) {
  return value === false || IsNumber2(value) && (value === 0 || Object.is(value, -0)) || IsBigInt2(value) && value === BigInt("0") || IsString2(value) && (value.toLowerCase() === "false" || value === "0" || value === "-0");
}
function IsTimeStringWithTimeZone(value) {
  return IsString2(value) && /^(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i.test(value);
}
function IsTimeStringWithoutTimeZone(value) {
  return IsString2(value) && /^(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)?$/i.test(value);
}
function IsDateTimeStringWithTimeZone(value) {
  return IsString2(value) && /^\d\d\d\d-[0-1]\d-[0-3]\dt(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)(?:\.\d+)?(?:z|[+-]\d\d(?::?\d\d)?)$/i.test(value);
}
function IsDateTimeStringWithoutTimeZone(value) {
  return IsString2(value) && /^\d\d\d\d-[0-1]\d-[0-3]\dt(?:[0-2]\d:[0-5]\d:[0-5]\d|23:59:60)?$/i.test(value);
}
function IsDateString(value) {
  return IsString2(value) && /^\d\d\d\d-[0-1]\d-[0-3]\d$/i.test(value);
}
function TryConvertLiteralString(value, target) {
  const conversion = TryConvertString(value);
  return conversion === target ? conversion : value;
}
function TryConvertLiteralNumber(value, target) {
  const conversion = TryConvertNumber(value);
  return conversion === target ? conversion : value;
}
function TryConvertLiteralBoolean(value, target) {
  const conversion = TryConvertBoolean(value);
  return conversion === target ? conversion : value;
}
function TryConvertLiteral(schema, value) {
  return IsString2(schema.const) ? TryConvertLiteralString(value, schema.const) : IsNumber2(schema.const) ? TryConvertLiteralNumber(value, schema.const) : IsBoolean2(schema.const) ? TryConvertLiteralBoolean(value, schema.const) : value;
}
function TryConvertBoolean(value) {
  return IsValueTrue(value) ? true : IsValueFalse(value) ? false : value;
}
function TryConvertBigInt(value) {
  const truncateInteger = (value2) => value2.split(".")[0];
  return IsStringNumeric(value) ? BigInt(truncateInteger(value)) : IsNumber2(value) ? BigInt(Math.trunc(value)) : IsValueFalse(value) ? BigInt(0) : IsValueTrue(value) ? BigInt(1) : value;
}
function TryConvertString(value) {
  return IsSymbol2(value) && value.description !== void 0 ? value.description.toString() : IsValueToString(value) ? value.toString() : value;
}
function TryConvertNumber(value) {
  return IsStringNumeric(value) ? parseFloat(value) : IsValueTrue(value) ? 1 : IsValueFalse(value) ? 0 : value;
}
function TryConvertInteger(value) {
  return IsStringNumeric(value) ? parseInt(value) : IsNumber2(value) ? Math.trunc(value) : IsValueTrue(value) ? 1 : IsValueFalse(value) ? 0 : value;
}
function TryConvertNull(value) {
  return IsString2(value) && value.toLowerCase() === "null" ? null : value;
}
function TryConvertUndefined(value) {
  return IsString2(value) && value === "undefined" ? void 0 : value;
}
function TryConvertDate(value) {
  return IsDate2(value) ? value : IsNumber2(value) ? new Date(value) : IsValueTrue(value) ? /* @__PURE__ */ new Date(1) : IsValueFalse(value) ? /* @__PURE__ */ new Date(0) : IsStringNumeric(value) ? new Date(parseInt(value)) : IsTimeStringWithoutTimeZone(value) ? /* @__PURE__ */ new Date(`1970-01-01T${value}.000Z`) : IsTimeStringWithTimeZone(value) ? /* @__PURE__ */ new Date(`1970-01-01T${value}`) : IsDateTimeStringWithoutTimeZone(value) ? /* @__PURE__ */ new Date(`${value}.000Z`) : IsDateTimeStringWithTimeZone(value) ? new Date(value) : IsDateString(value) ? /* @__PURE__ */ new Date(`${value}T00:00:00.000Z`) : value;
}
function Default2(value) {
  return value;
}
function FromArray13(schema, references, value) {
  const elements = IsArray2(value) ? value : [value];
  return elements.map((element) => Visit10(schema.items, references, element));
}
function FromBigInt5(schema, references, value) {
  return TryConvertBigInt(value);
}
function FromBoolean5(schema, references, value) {
  return TryConvertBoolean(value);
}
function FromDate6(schema, references, value) {
  return TryConvertDate(value);
}
function FromImport6(schema, references, value) {
  const definitions = globalThis.Object.values(schema.$defs);
  const target = schema.$defs[schema.$ref];
  return Visit10(target, [...references, ...definitions], value);
}
function FromInteger5(schema, references, value) {
  return TryConvertInteger(value);
}
function FromIntersect14(schema, references, value) {
  return schema.allOf.reduce((value2, schema2) => Visit10(schema2, references, value2), value);
}
function FromLiteral6(schema, references, value) {
  return TryConvertLiteral(schema, value);
}
function FromNull5(schema, references, value) {
  return TryConvertNull(value);
}
function FromNumber5(schema, references, value) {
  return TryConvertNumber(value);
}
function FromObject14(schema, references, value) {
  if (!IsObject2(value) || IsArray2(value))
    return value;
  for (const propertyKey of Object.getOwnPropertyNames(schema.properties)) {
    if (!HasPropertyKey2(value, propertyKey))
      continue;
    value[propertyKey] = Visit10(schema.properties[propertyKey], references, value[propertyKey]);
  }
  return value;
}
function FromRecord9(schema, references, value) {
  const isConvertable = IsObject2(value) && !IsArray2(value);
  if (!isConvertable)
    return value;
  const propertyKey = Object.getOwnPropertyNames(schema.patternProperties)[0];
  const property = schema.patternProperties[propertyKey];
  for (const [propKey, propValue] of Object.entries(value)) {
    value[propKey] = Visit10(property, references, propValue);
  }
  return value;
}
function FromRef10(schema, references, value) {
  return Visit10(Deref(schema, references), references, value);
}
function FromString5(schema, references, value) {
  return TryConvertString(value);
}
function FromSymbol5(schema, references, value) {
  return IsString2(value) || IsNumber2(value) ? Symbol(value) : value;
}
function FromThis6(schema, references, value) {
  return Visit10(Deref(schema, references), references, value);
}
function FromTuple11(schema, references, value) {
  const isConvertable = IsArray2(value) && !IsUndefined2(schema.items);
  if (!isConvertable)
    return value;
  return value.map((value2, index) => {
    return index < schema.items.length ? Visit10(schema.items[index], references, value2) : value2;
  });
}
function FromUndefined5(schema, references, value) {
  return TryConvertUndefined(value);
}
function FromUnion16(schema, references, value) {
  for (const subschema of schema.anyOf) {
    if (Check(subschema, references, value)) {
      return value;
    }
  }
  for (const subschema of schema.anyOf) {
    const converted = Visit10(subschema, references, Clone2(value));
    if (!Check(subschema, references, converted))
      continue;
    return converted;
  }
  return value;
}
function Visit10(schema, references, value) {
  const references_ = Pushref(schema, references);
  const schema_ = schema;
  switch (schema[Kind]) {
    case "Array":
      return FromArray13(schema_, references_, value);
    case "BigInt":
      return FromBigInt5(schema_, references_, value);
    case "Boolean":
      return FromBoolean5(schema_, references_, value);
    case "Date":
      return FromDate6(schema_, references_, value);
    case "Import":
      return FromImport6(schema_, references_, value);
    case "Integer":
      return FromInteger5(schema_, references_, value);
    case "Intersect":
      return FromIntersect14(schema_, references_, value);
    case "Literal":
      return FromLiteral6(schema_, references_, value);
    case "Null":
      return FromNull5(schema_, references_, value);
    case "Number":
      return FromNumber5(schema_, references_, value);
    case "Object":
      return FromObject14(schema_, references_, value);
    case "Record":
      return FromRecord9(schema_, references_, value);
    case "Ref":
      return FromRef10(schema_, references_, value);
    case "String":
      return FromString5(schema_, references_, value);
    case "Symbol":
      return FromSymbol5(schema_, references_, value);
    case "This":
      return FromThis6(schema_, references_, value);
    case "Tuple":
      return FromTuple11(schema_, references_, value);
    case "Undefined":
      return FromUndefined5(schema_, references_, value);
    case "Union":
      return FromUnion16(schema_, references_, value);
    default:
      return Default2(value);
  }
}
function Convert(...args) {
  return args.length === 3 ? Visit10(args[0], args[1], args[2]) : Visit10(args[0], [], args[1]);
}

// node_modules/@sinclair/typebox/build/esm/value/transform/decode.mjs
var TransformDecodeCheckError = class extends TypeBoxError {
  constructor(schema, value, error) {
    super(`Unable to decode value as it does not match the expected schema`);
    this.schema = schema;
    this.value = value;
    this.error = error;
  }
};
var TransformDecodeError = class extends TypeBoxError {
  constructor(schema, path14, value, error) {
    super(error instanceof Error ? error.message : "Unknown error");
    this.schema = schema;
    this.path = path14;
    this.value = value;
    this.error = error;
  }
};
function Default3(schema, path14, value) {
  try {
    return IsTransform(schema) ? schema[TransformKind].Decode(value) : value;
  } catch (error) {
    throw new TransformDecodeError(schema, path14, value, error);
  }
}
function FromArray14(schema, references, path14, value) {
  return IsArray2(value) ? Default3(schema, path14, value.map((value2, index) => Visit11(schema.items, references, `${path14}/${index}`, value2))) : Default3(schema, path14, value);
}
function FromIntersect15(schema, references, path14, value) {
  if (!IsObject2(value) || IsValueType(value))
    return Default3(schema, path14, value);
  const knownEntries = KeyOfPropertyEntries(schema);
  const knownKeys = knownEntries.map((entry) => entry[0]);
  const knownProperties = { ...value };
  for (const [knownKey, knownSchema] of knownEntries)
    if (knownKey in knownProperties) {
      knownProperties[knownKey] = Visit11(knownSchema, references, `${path14}/${knownKey}`, knownProperties[knownKey]);
    }
  if (!IsTransform(schema.unevaluatedProperties)) {
    return Default3(schema, path14, knownProperties);
  }
  const unknownKeys = Object.getOwnPropertyNames(knownProperties);
  const unevaluatedProperties = schema.unevaluatedProperties;
  const unknownProperties = { ...knownProperties };
  for (const key of unknownKeys)
    if (!knownKeys.includes(key)) {
      unknownProperties[key] = Default3(unevaluatedProperties, `${path14}/${key}`, unknownProperties[key]);
    }
  return Default3(schema, path14, unknownProperties);
}
function FromImport7(schema, references, path14, value) {
  const additional = globalThis.Object.values(schema.$defs);
  const target = schema.$defs[schema.$ref];
  const result = Visit11(target, [...references, ...additional], path14, value);
  return Default3(schema, path14, result);
}
function FromNot5(schema, references, path14, value) {
  return Default3(schema, path14, Visit11(schema.not, references, path14, value));
}
function FromObject15(schema, references, path14, value) {
  if (!IsObject2(value))
    return Default3(schema, path14, value);
  const knownKeys = KeyOfPropertyKeys(schema);
  const knownProperties = { ...value };
  for (const key of knownKeys) {
    if (!HasPropertyKey2(knownProperties, key))
      continue;
    if (IsUndefined2(knownProperties[key]) && (!IsUndefined3(schema.properties[key]) || TypeSystemPolicy.IsExactOptionalProperty(knownProperties, key)))
      continue;
    knownProperties[key] = Visit11(schema.properties[key], references, `${path14}/${key}`, knownProperties[key]);
  }
  if (!IsSchema(schema.additionalProperties)) {
    return Default3(schema, path14, knownProperties);
  }
  const unknownKeys = Object.getOwnPropertyNames(knownProperties);
  const additionalProperties = schema.additionalProperties;
  const unknownProperties = { ...knownProperties };
  for (const key of unknownKeys)
    if (!knownKeys.includes(key)) {
      unknownProperties[key] = Default3(additionalProperties, `${path14}/${key}`, unknownProperties[key]);
    }
  return Default3(schema, path14, unknownProperties);
}
function FromRecord10(schema, references, path14, value) {
  if (!IsObject2(value))
    return Default3(schema, path14, value);
  const pattern = Object.getOwnPropertyNames(schema.patternProperties)[0];
  const knownKeys = new RegExp(pattern);
  const knownProperties = { ...value };
  for (const key of Object.getOwnPropertyNames(value))
    if (knownKeys.test(key)) {
      knownProperties[key] = Visit11(schema.patternProperties[pattern], references, `${path14}/${key}`, knownProperties[key]);
    }
  if (!IsSchema(schema.additionalProperties)) {
    return Default3(schema, path14, knownProperties);
  }
  const unknownKeys = Object.getOwnPropertyNames(knownProperties);
  const additionalProperties = schema.additionalProperties;
  const unknownProperties = { ...knownProperties };
  for (const key of unknownKeys)
    if (!knownKeys.test(key)) {
      unknownProperties[key] = Default3(additionalProperties, `${path14}/${key}`, unknownProperties[key]);
    }
  return Default3(schema, path14, unknownProperties);
}
function FromRef11(schema, references, path14, value) {
  const target = Deref(schema, references);
  return Default3(schema, path14, Visit11(target, references, path14, value));
}
function FromThis7(schema, references, path14, value) {
  const target = Deref(schema, references);
  return Default3(schema, path14, Visit11(target, references, path14, value));
}
function FromTuple12(schema, references, path14, value) {
  return IsArray2(value) && IsArray2(schema.items) ? Default3(schema, path14, schema.items.map((schema2, index) => Visit11(schema2, references, `${path14}/${index}`, value[index]))) : Default3(schema, path14, value);
}
function FromUnion17(schema, references, path14, value) {
  for (const subschema of schema.anyOf) {
    if (!Check(subschema, references, value))
      continue;
    const decoded = Visit11(subschema, references, path14, value);
    return Default3(schema, path14, decoded);
  }
  return Default3(schema, path14, value);
}
function Visit11(schema, references, path14, value) {
  const references_ = Pushref(schema, references);
  const schema_ = schema;
  switch (schema[Kind]) {
    case "Array":
      return FromArray14(schema_, references_, path14, value);
    case "Import":
      return FromImport7(schema_, references_, path14, value);
    case "Intersect":
      return FromIntersect15(schema_, references_, path14, value);
    case "Not":
      return FromNot5(schema_, references_, path14, value);
    case "Object":
      return FromObject15(schema_, references_, path14, value);
    case "Record":
      return FromRecord10(schema_, references_, path14, value);
    case "Ref":
      return FromRef11(schema_, references_, path14, value);
    case "Symbol":
      return Default3(schema_, path14, value);
    case "This":
      return FromThis7(schema_, references_, path14, value);
    case "Tuple":
      return FromTuple12(schema_, references_, path14, value);
    case "Union":
      return FromUnion17(schema_, references_, path14, value);
    default:
      return Default3(schema_, path14, value);
  }
}
function TransformDecode(schema, references, value) {
  return Visit11(schema, references, "", value);
}

// node_modules/@sinclair/typebox/build/esm/value/transform/encode.mjs
var TransformEncodeCheckError = class extends TypeBoxError {
  constructor(schema, value, error) {
    super(`The encoded value does not match the expected schema`);
    this.schema = schema;
    this.value = value;
    this.error = error;
  }
};
var TransformEncodeError = class extends TypeBoxError {
  constructor(schema, path14, value, error) {
    super(`${error instanceof Error ? error.message : "Unknown error"}`);
    this.schema = schema;
    this.path = path14;
    this.value = value;
    this.error = error;
  }
};
function Default4(schema, path14, value) {
  try {
    return IsTransform(schema) ? schema[TransformKind].Encode(value) : value;
  } catch (error) {
    throw new TransformEncodeError(schema, path14, value, error);
  }
}
function FromArray15(schema, references, path14, value) {
  const defaulted = Default4(schema, path14, value);
  return IsArray2(defaulted) ? defaulted.map((value2, index) => Visit12(schema.items, references, `${path14}/${index}`, value2)) : defaulted;
}
function FromImport8(schema, references, path14, value) {
  const additional = globalThis.Object.values(schema.$defs);
  const target = schema.$defs[schema.$ref];
  const result = Default4(schema, path14, value);
  return Visit12(target, [...references, ...additional], path14, result);
}
function FromIntersect16(schema, references, path14, value) {
  const defaulted = Default4(schema, path14, value);
  if (!IsObject2(value) || IsValueType(value))
    return defaulted;
  const knownEntries = KeyOfPropertyEntries(schema);
  const knownKeys = knownEntries.map((entry) => entry[0]);
  const knownProperties = { ...defaulted };
  for (const [knownKey, knownSchema] of knownEntries)
    if (knownKey in knownProperties) {
      knownProperties[knownKey] = Visit12(knownSchema, references, `${path14}/${knownKey}`, knownProperties[knownKey]);
    }
  if (!IsTransform(schema.unevaluatedProperties)) {
    return knownProperties;
  }
  const unknownKeys = Object.getOwnPropertyNames(knownProperties);
  const unevaluatedProperties = schema.unevaluatedProperties;
  const properties = { ...knownProperties };
  for (const key of unknownKeys)
    if (!knownKeys.includes(key)) {
      properties[key] = Default4(unevaluatedProperties, `${path14}/${key}`, properties[key]);
    }
  return properties;
}
function FromNot6(schema, references, path14, value) {
  return Default4(schema.not, path14, Default4(schema, path14, value));
}
function FromObject16(schema, references, path14, value) {
  const defaulted = Default4(schema, path14, value);
  if (!IsObject2(defaulted))
    return defaulted;
  const knownKeys = KeyOfPropertyKeys(schema);
  const knownProperties = { ...defaulted };
  for (const key of knownKeys) {
    if (!HasPropertyKey2(knownProperties, key))
      continue;
    if (IsUndefined2(knownProperties[key]) && (!IsUndefined3(schema.properties[key]) || TypeSystemPolicy.IsExactOptionalProperty(knownProperties, key)))
      continue;
    knownProperties[key] = Visit12(schema.properties[key], references, `${path14}/${key}`, knownProperties[key]);
  }
  if (!IsSchema(schema.additionalProperties)) {
    return knownProperties;
  }
  const unknownKeys = Object.getOwnPropertyNames(knownProperties);
  const additionalProperties = schema.additionalProperties;
  const properties = { ...knownProperties };
  for (const key of unknownKeys)
    if (!knownKeys.includes(key)) {
      properties[key] = Default4(additionalProperties, `${path14}/${key}`, properties[key]);
    }
  return properties;
}
function FromRecord11(schema, references, path14, value) {
  const defaulted = Default4(schema, path14, value);
  if (!IsObject2(value))
    return defaulted;
  const pattern = Object.getOwnPropertyNames(schema.patternProperties)[0];
  const knownKeys = new RegExp(pattern);
  const knownProperties = { ...defaulted };
  for (const key of Object.getOwnPropertyNames(value))
    if (knownKeys.test(key)) {
      knownProperties[key] = Visit12(schema.patternProperties[pattern], references, `${path14}/${key}`, knownProperties[key]);
    }
  if (!IsSchema(schema.additionalProperties)) {
    return knownProperties;
  }
  const unknownKeys = Object.getOwnPropertyNames(knownProperties);
  const additionalProperties = schema.additionalProperties;
  const properties = { ...knownProperties };
  for (const key of unknownKeys)
    if (!knownKeys.test(key)) {
      properties[key] = Default4(additionalProperties, `${path14}/${key}`, properties[key]);
    }
  return properties;
}
function FromRef12(schema, references, path14, value) {
  const target = Deref(schema, references);
  const resolved = Visit12(target, references, path14, value);
  return Default4(schema, path14, resolved);
}
function FromThis8(schema, references, path14, value) {
  const target = Deref(schema, references);
  const resolved = Visit12(target, references, path14, value);
  return Default4(schema, path14, resolved);
}
function FromTuple13(schema, references, path14, value) {
  const value1 = Default4(schema, path14, value);
  return IsArray2(schema.items) ? schema.items.map((schema2, index) => Visit12(schema2, references, `${path14}/${index}`, value1[index])) : [];
}
function FromUnion18(schema, references, path14, value) {
  for (const subschema of schema.anyOf) {
    if (!Check(subschema, references, value))
      continue;
    const value1 = Visit12(subschema, references, path14, value);
    return Default4(schema, path14, value1);
  }
  for (const subschema of schema.anyOf) {
    const value1 = Visit12(subschema, references, path14, value);
    if (!Check(schema, references, value1))
      continue;
    return Default4(schema, path14, value1);
  }
  return Default4(schema, path14, value);
}
function Visit12(schema, references, path14, value) {
  const references_ = Pushref(schema, references);
  const schema_ = schema;
  switch (schema[Kind]) {
    case "Array":
      return FromArray15(schema_, references_, path14, value);
    case "Import":
      return FromImport8(schema_, references_, path14, value);
    case "Intersect":
      return FromIntersect16(schema_, references_, path14, value);
    case "Not":
      return FromNot6(schema_, references_, path14, value);
    case "Object":
      return FromObject16(schema_, references_, path14, value);
    case "Record":
      return FromRecord11(schema_, references_, path14, value);
    case "Ref":
      return FromRef12(schema_, references_, path14, value);
    case "This":
      return FromThis8(schema_, references_, path14, value);
    case "Tuple":
      return FromTuple13(schema_, references_, path14, value);
    case "Union":
      return FromUnion18(schema_, references_, path14, value);
    default:
      return Default4(schema_, path14, value);
  }
}
function TransformEncode(schema, references, value) {
  return Visit12(schema, references, "", value);
}

// node_modules/@sinclair/typebox/build/esm/value/transform/has.mjs
function FromArray16(schema, references) {
  return IsTransform(schema) || Visit13(schema.items, references);
}
function FromAsyncIterator7(schema, references) {
  return IsTransform(schema) || Visit13(schema.items, references);
}
function FromConstructor8(schema, references) {
  return IsTransform(schema) || Visit13(schema.returns, references) || schema.parameters.some((schema2) => Visit13(schema2, references));
}
function FromFunction7(schema, references) {
  return IsTransform(schema) || Visit13(schema.returns, references) || schema.parameters.some((schema2) => Visit13(schema2, references));
}
function FromIntersect17(schema, references) {
  return IsTransform(schema) || IsTransform(schema.unevaluatedProperties) || schema.allOf.some((schema2) => Visit13(schema2, references));
}
function FromImport9(schema, references) {
  const additional = globalThis.Object.getOwnPropertyNames(schema.$defs).reduce((result, key) => [...result, schema.$defs[key]], []);
  const target = schema.$defs[schema.$ref];
  return IsTransform(schema) || Visit13(target, [...additional, ...references]);
}
function FromIterator7(schema, references) {
  return IsTransform(schema) || Visit13(schema.items, references);
}
function FromNot7(schema, references) {
  return IsTransform(schema) || Visit13(schema.not, references);
}
function FromObject17(schema, references) {
  return IsTransform(schema) || Object.values(schema.properties).some((schema2) => Visit13(schema2, references)) || IsSchema(schema.additionalProperties) && Visit13(schema.additionalProperties, references);
}
function FromPromise7(schema, references) {
  return IsTransform(schema) || Visit13(schema.item, references);
}
function FromRecord12(schema, references) {
  const pattern = Object.getOwnPropertyNames(schema.patternProperties)[0];
  const property = schema.patternProperties[pattern];
  return IsTransform(schema) || Visit13(property, references) || IsSchema(schema.additionalProperties) && IsTransform(schema.additionalProperties);
}
function FromRef13(schema, references) {
  if (IsTransform(schema))
    return true;
  return Visit13(Deref(schema, references), references);
}
function FromThis9(schema, references) {
  if (IsTransform(schema))
    return true;
  return Visit13(Deref(schema, references), references);
}
function FromTuple14(schema, references) {
  return IsTransform(schema) || !IsUndefined2(schema.items) && schema.items.some((schema2) => Visit13(schema2, references));
}
function FromUnion19(schema, references) {
  return IsTransform(schema) || schema.anyOf.some((schema2) => Visit13(schema2, references));
}
function Visit13(schema, references) {
  const references_ = Pushref(schema, references);
  const schema_ = schema;
  if (schema.$id && visited.has(schema.$id))
    return false;
  if (schema.$id)
    visited.add(schema.$id);
  switch (schema[Kind]) {
    case "Array":
      return FromArray16(schema_, references_);
    case "AsyncIterator":
      return FromAsyncIterator7(schema_, references_);
    case "Constructor":
      return FromConstructor8(schema_, references_);
    case "Function":
      return FromFunction7(schema_, references_);
    case "Import":
      return FromImport9(schema_, references_);
    case "Intersect":
      return FromIntersect17(schema_, references_);
    case "Iterator":
      return FromIterator7(schema_, references_);
    case "Not":
      return FromNot7(schema_, references_);
    case "Object":
      return FromObject17(schema_, references_);
    case "Promise":
      return FromPromise7(schema_, references_);
    case "Record":
      return FromRecord12(schema_, references_);
    case "Ref":
      return FromRef13(schema_, references_);
    case "This":
      return FromThis9(schema_, references_);
    case "Tuple":
      return FromTuple14(schema_, references_);
    case "Union":
      return FromUnion19(schema_, references_);
    default:
      return IsTransform(schema);
  }
}
var visited = /* @__PURE__ */ new Set();
function HasTransform(schema, references) {
  visited.clear();
  return Visit13(schema, references);
}

// node_modules/@sinclair/typebox/build/esm/value/decode/decode.mjs
function Decode(...args) {
  const [schema, references, value] = args.length === 3 ? [args[0], args[1], args[2]] : [args[0], [], args[1]];
  if (!Check(schema, references, value))
    throw new TransformDecodeCheckError(schema, value, Errors(schema, references, value).First());
  return HasTransform(schema, references) ? TransformDecode(schema, references, value) : value;
}

// node_modules/@sinclair/typebox/build/esm/value/default/default.mjs
function ValueOrDefault(schema, value) {
  const defaultValue = HasPropertyKey2(schema, "default") ? schema.default : void 0;
  const clone = IsFunction2(defaultValue) ? defaultValue() : Clone2(defaultValue);
  return IsUndefined2(value) ? clone : IsObject2(value) && IsObject2(clone) ? Object.assign(clone, value) : value;
}
function HasDefaultProperty(schema) {
  return IsKind(schema) && "default" in schema;
}
function FromArray17(schema, references, value) {
  if (IsArray2(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = Visit14(schema.items, references, value[i]);
    }
    return value;
  }
  const defaulted = ValueOrDefault(schema, value);
  if (!IsArray2(defaulted))
    return defaulted;
  for (let i = 0; i < defaulted.length; i++) {
    defaulted[i] = Visit14(schema.items, references, defaulted[i]);
  }
  return defaulted;
}
function FromDate7(schema, references, value) {
  return IsDate2(value) ? value : ValueOrDefault(schema, value);
}
function FromImport10(schema, references, value) {
  const definitions = globalThis.Object.values(schema.$defs);
  const target = schema.$defs[schema.$ref];
  return Visit14(target, [...references, ...definitions], value);
}
function FromIntersect18(schema, references, value) {
  const defaulted = ValueOrDefault(schema, value);
  return schema.allOf.reduce((acc, schema2) => {
    const next = Visit14(schema2, references, defaulted);
    return IsObject2(next) ? { ...acc, ...next } : next;
  }, {});
}
function FromObject18(schema, references, value) {
  const defaulted = ValueOrDefault(schema, value);
  if (!IsObject2(defaulted))
    return defaulted;
  const knownPropertyKeys = Object.getOwnPropertyNames(schema.properties);
  for (const key of knownPropertyKeys) {
    const propertyValue = Visit14(schema.properties[key], references, defaulted[key]);
    if (IsUndefined2(propertyValue))
      continue;
    defaulted[key] = Visit14(schema.properties[key], references, defaulted[key]);
  }
  if (!HasDefaultProperty(schema.additionalProperties))
    return defaulted;
  for (const key of Object.getOwnPropertyNames(defaulted)) {
    if (knownPropertyKeys.includes(key))
      continue;
    defaulted[key] = Visit14(schema.additionalProperties, references, defaulted[key]);
  }
  return defaulted;
}
function FromRecord13(schema, references, value) {
  const defaulted = ValueOrDefault(schema, value);
  if (!IsObject2(defaulted))
    return defaulted;
  const additionalPropertiesSchema = schema.additionalProperties;
  const [propertyKeyPattern, propertySchema] = Object.entries(schema.patternProperties)[0];
  const knownPropertyKey = new RegExp(propertyKeyPattern);
  for (const key of Object.getOwnPropertyNames(defaulted)) {
    if (!(knownPropertyKey.test(key) && HasDefaultProperty(propertySchema)))
      continue;
    defaulted[key] = Visit14(propertySchema, references, defaulted[key]);
  }
  if (!HasDefaultProperty(additionalPropertiesSchema))
    return defaulted;
  for (const key of Object.getOwnPropertyNames(defaulted)) {
    if (knownPropertyKey.test(key))
      continue;
    defaulted[key] = Visit14(additionalPropertiesSchema, references, defaulted[key]);
  }
  return defaulted;
}
function FromRef14(schema, references, value) {
  return Visit14(Deref(schema, references), references, ValueOrDefault(schema, value));
}
function FromThis10(schema, references, value) {
  return Visit14(Deref(schema, references), references, value);
}
function FromTuple15(schema, references, value) {
  const defaulted = ValueOrDefault(schema, value);
  if (!IsArray2(defaulted) || IsUndefined2(schema.items))
    return defaulted;
  const [items, max] = [schema.items, Math.max(schema.items.length, defaulted.length)];
  for (let i = 0; i < max; i++) {
    if (i < items.length)
      defaulted[i] = Visit14(items[i], references, defaulted[i]);
  }
  return defaulted;
}
function FromUnion20(schema, references, value) {
  const defaulted = ValueOrDefault(schema, value);
  for (const inner of schema.anyOf) {
    const result = Visit14(inner, references, Clone2(defaulted));
    if (Check(inner, references, result)) {
      return result;
    }
  }
  return defaulted;
}
function Visit14(schema, references, value) {
  const references_ = Pushref(schema, references);
  const schema_ = schema;
  switch (schema_[Kind]) {
    case "Array":
      return FromArray17(schema_, references_, value);
    case "Date":
      return FromDate7(schema_, references_, value);
    case "Import":
      return FromImport10(schema_, references_, value);
    case "Intersect":
      return FromIntersect18(schema_, references_, value);
    case "Object":
      return FromObject18(schema_, references_, value);
    case "Record":
      return FromRecord13(schema_, references_, value);
    case "Ref":
      return FromRef14(schema_, references_, value);
    case "This":
      return FromThis10(schema_, references_, value);
    case "Tuple":
      return FromTuple15(schema_, references_, value);
    case "Union":
      return FromUnion20(schema_, references_, value);
    default:
      return ValueOrDefault(schema_, value);
  }
}
function Default5(...args) {
  return args.length === 3 ? Visit14(args[0], args[1], args[2]) : Visit14(args[0], [], args[1]);
}

// node_modules/@sinclair/typebox/build/esm/value/pointer/pointer.mjs
var pointer_exports = {};
__export(pointer_exports, {
  Delete: () => Delete3,
  Format: () => Format,
  Get: () => Get3,
  Has: () => Has3,
  Set: () => Set4,
  ValuePointerRootDeleteError: () => ValuePointerRootDeleteError,
  ValuePointerRootSetError: () => ValuePointerRootSetError
});
var ValuePointerRootSetError = class extends TypeBoxError {
  constructor(value, path14, update) {
    super("Cannot set root value");
    this.value = value;
    this.path = path14;
    this.update = update;
  }
};
var ValuePointerRootDeleteError = class extends TypeBoxError {
  constructor(value, path14) {
    super("Cannot delete root value");
    this.value = value;
    this.path = path14;
  }
};
function Escape2(component) {
  return component.indexOf("~") === -1 ? component : component.replace(/~1/g, "/").replace(/~0/g, "~");
}
function* Format(pointer) {
  if (pointer === "")
    return;
  let [start, end] = [0, 0];
  for (let i = 0; i < pointer.length; i++) {
    const char = pointer.charAt(i);
    if (char === "/") {
      if (i === 0) {
        start = i + 1;
      } else {
        end = i;
        yield Escape2(pointer.slice(start, end));
        start = i + 1;
      }
    } else {
      end = i;
    }
  }
  yield Escape2(pointer.slice(start));
}
function Set4(value, pointer, update) {
  if (pointer === "")
    throw new ValuePointerRootSetError(value, pointer, update);
  let [owner, next, key] = [null, value, ""];
  for (const component of Format(pointer)) {
    if (next[component] === void 0)
      next[component] = {};
    owner = next;
    next = next[component];
    key = component;
  }
  owner[key] = update;
}
function Delete3(value, pointer) {
  if (pointer === "")
    throw new ValuePointerRootDeleteError(value, pointer);
  let [owner, next, key] = [null, value, ""];
  for (const component of Format(pointer)) {
    if (next[component] === void 0 || next[component] === null)
      return;
    owner = next;
    next = next[component];
    key = component;
  }
  if (Array.isArray(owner)) {
    const index = parseInt(key);
    owner.splice(index, 1);
  } else {
    delete owner[key];
  }
}
function Has3(value, pointer) {
  if (pointer === "")
    return true;
  let [owner, next, key] = [null, value, ""];
  for (const component of Format(pointer)) {
    if (next[component] === void 0)
      return false;
    owner = next;
    next = next[component];
    key = component;
  }
  return Object.getOwnPropertyNames(owner).includes(key);
}
function Get3(value, pointer) {
  if (pointer === "")
    return value;
  let current = value;
  for (const component of Format(pointer)) {
    if (current[component] === void 0)
      return void 0;
    current = current[component];
  }
  return current;
}

// node_modules/@sinclair/typebox/build/esm/value/equal/equal.mjs
function ObjectType3(left, right) {
  if (!IsObject2(right))
    return false;
  const leftKeys = [...Object.keys(left), ...Object.getOwnPropertySymbols(left)];
  const rightKeys = [...Object.keys(right), ...Object.getOwnPropertySymbols(right)];
  if (leftKeys.length !== rightKeys.length)
    return false;
  return leftKeys.every((key) => Equal(left[key], right[key]));
}
function DateType3(left, right) {
  return IsDate2(right) && left.getTime() === right.getTime();
}
function ArrayType3(left, right) {
  if (!IsArray2(right) || left.length !== right.length)
    return false;
  return left.every((value, index) => Equal(value, right[index]));
}
function TypedArrayType(left, right) {
  if (!IsTypedArray(right) || left.length !== right.length || Object.getPrototypeOf(left).constructor.name !== Object.getPrototypeOf(right).constructor.name)
    return false;
  return left.every((value, index) => Equal(value, right[index]));
}
function ValueType(left, right) {
  return left === right;
}
function Equal(left, right) {
  if (IsDate2(left))
    return DateType3(left, right);
  if (IsTypedArray(left))
    return TypedArrayType(left, right);
  if (IsArray2(left))
    return ArrayType3(left, right);
  if (IsObject2(left))
    return ObjectType3(left, right);
  if (IsValueType(left))
    return ValueType(left, right);
  throw new Error("ValueEquals: Unable to compare value");
}

// node_modules/@sinclair/typebox/build/esm/value/delta/delta.mjs
var Insert = Object2({
  type: Literal("insert"),
  path: String2(),
  value: Unknown()
});
var Update = Object2({
  type: Literal("update"),
  path: String2(),
  value: Unknown()
});
var Delete4 = Object2({
  type: Literal("delete"),
  path: String2()
});
var Edit = Union([Insert, Update, Delete4]);
var ValueDiffError = class extends TypeBoxError {
  constructor(value, message) {
    super(message);
    this.value = value;
  }
};
function CreateUpdate(path14, value) {
  return { type: "update", path: path14, value };
}
function CreateInsert(path14, value) {
  return { type: "insert", path: path14, value };
}
function CreateDelete(path14) {
  return { type: "delete", path: path14 };
}
function AssertDiffable(value) {
  if (globalThis.Object.getOwnPropertySymbols(value).length > 0)
    throw new ValueDiffError(value, "Cannot diff objects with symbols");
}
function* ObjectType4(path14, current, next) {
  AssertDiffable(current);
  AssertDiffable(next);
  if (!IsStandardObject(next))
    return yield CreateUpdate(path14, next);
  const currentKeys = globalThis.Object.getOwnPropertyNames(current);
  const nextKeys = globalThis.Object.getOwnPropertyNames(next);
  for (const key of nextKeys) {
    if (HasPropertyKey2(current, key))
      continue;
    yield CreateInsert(`${path14}/${key}`, next[key]);
  }
  for (const key of currentKeys) {
    if (!HasPropertyKey2(next, key))
      continue;
    if (Equal(current, next))
      continue;
    yield* Visit15(`${path14}/${key}`, current[key], next[key]);
  }
  for (const key of currentKeys) {
    if (HasPropertyKey2(next, key))
      continue;
    yield CreateDelete(`${path14}/${key}`);
  }
}
function* ArrayType4(path14, current, next) {
  if (!IsArray2(next))
    return yield CreateUpdate(path14, next);
  for (let i = 0; i < Math.min(current.length, next.length); i++) {
    yield* Visit15(`${path14}/${i}`, current[i], next[i]);
  }
  for (let i = 0; i < next.length; i++) {
    if (i < current.length)
      continue;
    yield CreateInsert(`${path14}/${i}`, next[i]);
  }
  for (let i = current.length - 1; i >= 0; i--) {
    if (i < next.length)
      continue;
    yield CreateDelete(`${path14}/${i}`);
  }
}
function* TypedArrayType2(path14, current, next) {
  if (!IsTypedArray(next) || current.length !== next.length || globalThis.Object.getPrototypeOf(current).constructor.name !== globalThis.Object.getPrototypeOf(next).constructor.name)
    return yield CreateUpdate(path14, next);
  for (let i = 0; i < Math.min(current.length, next.length); i++) {
    yield* Visit15(`${path14}/${i}`, current[i], next[i]);
  }
}
function* ValueType2(path14, current, next) {
  if (current === next)
    return;
  yield CreateUpdate(path14, next);
}
function* Visit15(path14, current, next) {
  if (IsStandardObject(current))
    return yield* ObjectType4(path14, current, next);
  if (IsArray2(current))
    return yield* ArrayType4(path14, current, next);
  if (IsTypedArray(current))
    return yield* TypedArrayType2(path14, current, next);
  if (IsValueType(current))
    return yield* ValueType2(path14, current, next);
  throw new ValueDiffError(current, "Unable to diff value");
}
function Diff(current, next) {
  return [...Visit15("", current, next)];
}
function IsRootUpdate(edits) {
  return edits.length > 0 && edits[0].path === "" && edits[0].type === "update";
}
function IsIdentity(edits) {
  return edits.length === 0;
}
function Patch(current, edits) {
  if (IsRootUpdate(edits)) {
    return Clone2(edits[0].value);
  }
  if (IsIdentity(edits)) {
    return Clone2(current);
  }
  const clone = Clone2(current);
  for (const edit of edits) {
    switch (edit.type) {
      case "insert": {
        pointer_exports.Set(clone, edit.path, edit.value);
        break;
      }
      case "update": {
        pointer_exports.Set(clone, edit.path, edit.value);
        break;
      }
      case "delete": {
        pointer_exports.Delete(clone, edit.path);
        break;
      }
    }
  }
  return clone;
}

// node_modules/@sinclair/typebox/build/esm/value/encode/encode.mjs
function Encode(...args) {
  const [schema, references, value] = args.length === 3 ? [args[0], args[1], args[2]] : [args[0], [], args[1]];
  const encoded = HasTransform(schema, references) ? TransformEncode(schema, references, value) : value;
  if (!Check(schema, references, encoded))
    throw new TransformEncodeCheckError(schema, encoded, Errors(schema, references, encoded).First());
  return encoded;
}

// node_modules/@sinclair/typebox/build/esm/value/mutate/mutate.mjs
function IsStandardObject2(value) {
  return IsObject2(value) && !IsArray2(value);
}
var ValueMutateError = class extends TypeBoxError {
  constructor(message) {
    super(message);
  }
};
function ObjectType5(root, path14, current, next) {
  if (!IsStandardObject2(current)) {
    pointer_exports.Set(root, path14, Clone2(next));
  } else {
    const currentKeys = Object.getOwnPropertyNames(current);
    const nextKeys = Object.getOwnPropertyNames(next);
    for (const currentKey of currentKeys) {
      if (!nextKeys.includes(currentKey)) {
        delete current[currentKey];
      }
    }
    for (const nextKey of nextKeys) {
      if (!currentKeys.includes(nextKey)) {
        current[nextKey] = null;
      }
    }
    for (const nextKey of nextKeys) {
      Visit16(root, `${path14}/${nextKey}`, current[nextKey], next[nextKey]);
    }
  }
}
function ArrayType5(root, path14, current, next) {
  if (!IsArray2(current)) {
    pointer_exports.Set(root, path14, Clone2(next));
  } else {
    for (let index = 0; index < next.length; index++) {
      Visit16(root, `${path14}/${index}`, current[index], next[index]);
    }
    current.splice(next.length);
  }
}
function TypedArrayType3(root, path14, current, next) {
  if (IsTypedArray(current) && current.length === next.length) {
    for (let i = 0; i < current.length; i++) {
      current[i] = next[i];
    }
  } else {
    pointer_exports.Set(root, path14, Clone2(next));
  }
}
function ValueType3(root, path14, current, next) {
  if (current === next)
    return;
  pointer_exports.Set(root, path14, next);
}
function Visit16(root, path14, current, next) {
  if (IsArray2(next))
    return ArrayType5(root, path14, current, next);
  if (IsTypedArray(next))
    return TypedArrayType3(root, path14, current, next);
  if (IsStandardObject2(next))
    return ObjectType5(root, path14, current, next);
  if (IsValueType(next))
    return ValueType3(root, path14, current, next);
}
function IsNonMutableValue(value) {
  return IsTypedArray(value) || IsValueType(value);
}
function IsMismatchedValue(current, next) {
  return IsStandardObject2(current) && IsArray2(next) || IsArray2(current) && IsStandardObject2(next);
}
function Mutate(current, next) {
  if (IsNonMutableValue(current) || IsNonMutableValue(next))
    throw new ValueMutateError("Only object and array types can be mutated at the root level");
  if (IsMismatchedValue(current, next))
    throw new ValueMutateError("Cannot assign due type mismatch of assignable values");
  Visit16(current, "", current, next);
}

// node_modules/@sinclair/typebox/build/esm/value/parse/parse.mjs
var ParseError = class extends TypeBoxError {
  constructor(message) {
    super(message);
  }
};
var ParseRegistry;
(function(ParseRegistry2) {
  const registry = /* @__PURE__ */ new Map([
    ["Assert", (type, references, value) => {
      Assert(type, references, value);
      return value;
    }],
    ["Cast", (type, references, value) => Cast(type, references, value)],
    ["Clean", (type, references, value) => Clean(type, references, value)],
    ["Clone", (_type, _references, value) => Clone2(value)],
    ["Convert", (type, references, value) => Convert(type, references, value)],
    ["Decode", (type, references, value) => HasTransform(type, references) ? TransformDecode(type, references, value) : value],
    ["Default", (type, references, value) => Default5(type, references, value)],
    ["Encode", (type, references, value) => HasTransform(type, references) ? TransformEncode(type, references, value) : value]
  ]);
  function Delete5(key) {
    registry.delete(key);
  }
  ParseRegistry2.Delete = Delete5;
  function Set5(key, callback) {
    registry.set(key, callback);
  }
  ParseRegistry2.Set = Set5;
  function Get4(key) {
    return registry.get(key);
  }
  ParseRegistry2.Get = Get4;
})(ParseRegistry || (ParseRegistry = {}));
var ParseDefault = [
  "Clone",
  "Clean",
  "Default",
  "Convert",
  "Assert",
  "Decode"
];
function ParseValue(operations, type, references, value) {
  return operations.reduce((value2, operationKey) => {
    const operation = ParseRegistry.Get(operationKey);
    if (IsUndefined2(operation))
      throw new ParseError(`Unable to find Parse operation '${operationKey}'`);
    return operation(type, references, value2);
  }, value);
}
function Parse(...args) {
  const [operations, schema, references, value] = args.length === 4 ? [args[0], args[1], args[2], args[3]] : args.length === 3 ? IsArray2(args[0]) ? [args[0], args[1], [], args[2]] : [ParseDefault, args[0], args[1], args[2]] : args.length === 2 ? [ParseDefault, args[0], [], args[1]] : (() => {
    throw new ParseError("Invalid Arguments");
  })();
  return ParseValue(operations, schema, references, value);
}

// node_modules/@sinclair/typebox/build/esm/value/value/value.mjs
var value_exports2 = {};
__export(value_exports2, {
  Assert: () => Assert,
  Cast: () => Cast,
  Check: () => Check,
  Clean: () => Clean,
  Clone: () => Clone2,
  Convert: () => Convert,
  Create: () => Create2,
  Decode: () => Decode,
  Default: () => Default5,
  Diff: () => Diff,
  Edit: () => Edit,
  Encode: () => Encode,
  Equal: () => Equal,
  Errors: () => Errors,
  Hash: () => Hash,
  Mutate: () => Mutate,
  Parse: () => Parse,
  Patch: () => Patch,
  ValueErrorIterator: () => ValueErrorIterator
});

// src/domain/messages.ts
var ExtractedMessageSchema = Type.Object(
  {
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    content: Type.String(),
    timestamp: Type.Number()
  },
  { additionalProperties: false }
);

// src/domain/guest-membership.ts
var MAX_GUEST_IDENTITY_BYTES = 256;
var MAX_GUEST_NAME_BYTES = 256;
var MAX_GUEST_ENDPOINT_BYTES = 512;
var GUEST_CAPABILITIES = ["follow-up", "member-request", "member-response", "broadcast"];
var GuestCapabilitySchema = Type.Union(GUEST_CAPABILITIES.map((capability) => Type.Literal(capability)));
var GUEST_THREATS = [
  "guessed-or-stolen-socket",
  "replayed-approval",
  "capability-leakage",
  "stale-endpoint",
  "name-collision",
  "cross-crew-confusion",
  "unauthorized-approval-or-revocation",
  "compromised-crew"
];
var GuestThreatSchema = Type.Union(GUEST_THREATS.map((threat) => Type.Literal(threat)));
var GuestThreatModelSchema = Type.Object(
  {
    threats: Type.Array(GuestThreatSchema, {
      minItems: GUEST_THREATS.length,
      maxItems: GUEST_THREATS.length,
      uniqueItems: true
    })
  },
  { additionalProperties: false }
);
var BoundedText = (maxLength) => Type.String({ minLength: 1, maxLength, pattern: "^[^\\u0000\\r\\n]+$" });
var GuestSchema = Type.Object(
  {
    identity: BoundedText(MAX_GUEST_IDENTITY_BYTES),
    callbackEndpoint: BoundedText(MAX_GUEST_ENDPOINT_BYTES)
  },
  { additionalProperties: false }
);
var CrewSelectorSchema = Type.Object(
  {
    id: BoundedText(MAX_GUEST_IDENTITY_BYTES),
    displayName: BoundedText(MAX_GUEST_NAME_BYTES)
  },
  { additionalProperties: false }
);
var GuestJoinRequestSchema = Type.Object(
  {
    requestId: BoundedText(MAX_GUEST_IDENTITY_BYTES),
    crew: CrewSelectorSchema,
    guestIdentity: BoundedText(MAX_GUEST_IDENTITY_BYTES),
    guestName: BoundedText(MAX_GUEST_NAME_BYTES),
    callbackEndpoint: BoundedText(MAX_GUEST_ENDPOINT_BYTES),
    submittedByMember: BoundedText(MAX_GUEST_NAME_BYTES)
  },
  { additionalProperties: false }
);
var GuestApprovalSchema = Type.Object(
  {
    requestId: BoundedText(MAX_GUEST_IDENTITY_BYTES),
    crew: CrewSelectorSchema,
    guestIdentity: BoundedText(MAX_GUEST_IDENTITY_BYTES),
    guestName: BoundedText(MAX_GUEST_NAME_BYTES),
    callbackEndpoint: BoundedText(MAX_GUEST_ENDPOINT_BYTES),
    approver: BoundedText(MAX_GUEST_NAME_BYTES)
  },
  { additionalProperties: false }
);
var GuestRevocationSchema = Type.Object(
  {
    crew: CrewSelectorSchema,
    guestIdentity: BoundedText(MAX_GUEST_IDENTITY_BYTES),
    revokedBy: BoundedText(MAX_GUEST_NAME_BYTES)
  },
  { additionalProperties: false }
);
var GuestMembershipRecordSchema = Type.Object(
  {
    crew: CrewSelectorSchema,
    guestIdentity: BoundedText(MAX_GUEST_IDENTITY_BYTES),
    guestName: BoundedText(MAX_GUEST_NAME_BYTES),
    callbackEndpoint: BoundedText(MAX_GUEST_ENDPOINT_BYTES),
    approvedBy: BoundedText(MAX_GUEST_NAME_BYTES)
  },
  { additionalProperties: false }
);
var GuestOriginSchema = Type.Object(
  {
    kind: Type.Literal("guest"),
    identity: BoundedText(MAX_GUEST_IDENTITY_BYTES),
    name: BoundedText(MAX_GUEST_NAME_BYTES)
  },
  { additionalProperties: false }
);

// src/domain/message-payload.ts
var MESSAGE_KINDS = [
  "follow-up",
  "member request",
  "redirect",
  "interrupt",
  "inbox",
  "broadcast",
  "external intake",
  "member response"
];
var MessageKindSchema = Type.Union(MESSAGE_KINDS.map((kind) => Type.Literal(kind)));
var MAX_MESSAGE_CONTENT_BYTES = 1e6;
var MAX_MESSAGE_INSTRUCTIONS = 32;
var MAX_MESSAGE_INSTRUCTION_BYTES = 1e5;
var MAX_MESSAGE_PAYLOAD_BYTES = 1e6;
var MAX_MESSAGE_ORIGIN_FIELD_BYTES = 256;
var MAX_MESSAGE_REPLY_FIELD_BYTES = 256;
var NonEmptyText = Type.String({ minLength: 1 });
var CrewOriginSchema = Type.Object(
  { kind: Type.Literal("crew"), name: NonEmptyText, role: NonEmptyText },
  { additionalProperties: false }
);
var ExternalOriginSchema = Type.Object(
  { kind: Type.Literal("external"), label: NonEmptyText },
  { additionalProperties: false }
);
var MessageOriginSchema = Type.Union([CrewOriginSchema, ExternalOriginSchema, GuestOriginSchema]);
var MessageInstructionsSchema = Type.Optional(
  Type.Array(NonEmptyText, { minItems: 1, maxItems: MAX_MESSAGE_INSTRUCTIONS })
);
var ReplyToSchema = Type.Object(
  { sessionId: NonEmptyText, sessionName: Type.Optional(NonEmptyText) },
  { additionalProperties: false }
);
var MessagePayloadSchema = Type.Object(
  {
    content: Type.String({ minLength: 1, maxLength: MAX_MESSAGE_CONTENT_BYTES }),
    instructions: MessageInstructionsSchema,
    origin: Type.Optional(MessageOriginSchema),
    kind: Type.Optional(MessageKindSchema),
    sentAt: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
    replyTo: Type.Optional(ReplyToSchema)
  },
  { additionalProperties: false }
);
var utf8Bytes = (value) => Buffer.byteLength(value, "utf8");
var messagePayloadUtf8Bytes = (payload) => utf8Bytes(JSON.stringify(payload));
var invalidContent = (value) => value.trim().length === 0 || value.includes("\0") || utf8Bytes(value) > MAX_MESSAGE_CONTENT_BYTES;
var invalidInstruction = (value) => value.trim().length === 0 || value.includes("\0") || utf8Bytes(value) > MAX_MESSAGE_INSTRUCTION_BYTES;
var invalidIdentity = (value, limit) => value.trim().length === 0 || value !== value.trim() || value.includes("\0") || utf8Bytes(value) > limit;
function isMessagePayload(value) {
  if (!value_exports2.Check(MessagePayloadSchema, value) || typeof value !== "object" || value === null) return false;
  const payload = value;
  if (invalidContent(payload.content)) return false;
  const instructions = payload.instructions ?? [];
  if (instructions.some(invalidInstruction)) return false;
  if (payload.sentAt !== void 0 && (!Number.isSafeInteger(payload.sentAt) || payload.sentAt < 0)) return false;
  if (payload.origin) {
    const fields = payload.origin.kind === "crew" ? [payload.origin.name, payload.origin.role] : payload.origin.kind === "guest" ? [payload.origin.identity, payload.origin.name] : [payload.origin.label];
    if (fields.some((field) => invalidIdentity(field, MAX_MESSAGE_ORIGIN_FIELD_BYTES))) return false;
  }
  if (payload.replyTo) {
    const fields = [payload.replyTo.sessionId, payload.replyTo.sessionName].filter(
      (field) => field !== void 0
    );
    if (fields.some((field) => invalidIdentity(field, MAX_MESSAGE_REPLY_FIELD_BYTES))) return false;
  }
  return messagePayloadUtf8Bytes(payload) <= MAX_MESSAGE_PAYLOAD_BYTES;
}

// src/domain/member-status.ts
var MAX_MEMBER_STATUS_LABEL_BYTES = 256;
var ISO_TIMESTAMP_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";
var IsoTimestampSchema = Type.String({ pattern: ISO_TIMESTAMP_PATTERN });
var PublicLabelSchema = Type.String({ minLength: 1, maxLength: MAX_MEMBER_STATUS_LABEL_BYTES });
var MemberStatusIdentitySchema = Type.Object(
  { name: PublicLabelSchema, role: PublicLabelSchema },
  { additionalProperties: false }
);
var OnlineMemberStatusSchema = Type.Object(
  {
    member: MemberStatusIdentitySchema,
    presence: Type.Literal("online"),
    activity: Type.Union([Type.Literal("idle"), Type.Literal("busy"), Type.Literal("compacting")]),
    hasPendingMessages: Type.Boolean(),
    observedAt: IsoTimestampSchema
  },
  { additionalProperties: false }
);
var OfflineMemberStatusSchema = Type.Object(
  {
    member: MemberStatusIdentitySchema,
    presence: Type.Literal("offline"),
    activity: Type.Literal("unavailable"),
    hasPendingMessages: Type.Literal("unavailable"),
    observedAt: IsoTimestampSchema
  },
  { additionalProperties: false }
);
var MemberStatusSchema = Type.Union([OnlineMemberStatusSchema, OfflineMemberStatusSchema]);
var UTF8_ENCODER = new TextEncoder();
var utf8Bytes2 = (value) => UTF8_ENCODER.encode(value).byteLength;
var containsUnsafeLineContent = (value) => /[\0\r\n]/u.test(value);
var isSafeBoundedText = (value, limit) => value.trim().length > 0 && value === value.trim() && !containsUnsafeLineContent(value) && utf8Bytes2(value) <= limit;
function isIsoTimestamp(value) {
  if (typeof value !== "string" || !new RegExp(ISO_TIMESTAMP_PATTERN, "u").test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
function isStatusIdentity(value) {
  return isSafeBoundedText(value.name, MAX_MEMBER_STATUS_LABEL_BYTES) && isSafeBoundedText(value.role, MAX_MEMBER_STATUS_LABEL_BYTES);
}
function isMemberStatus(value) {
  if (!value_exports2.Check(MemberStatusSchema, value)) return false;
  const status = value;
  return isStatusIdentity(status.member) && isIsoTimestamp(status.observedAt);
}
function formatMemberStatus(status) {
  if (!isMemberStatus(status)) throw new TypeError("invalid member status");
  const member = `${status.member.name} (${status.member.role})`;
  if (status.presence === "offline") return `${member} \u2014 offline \u2014 activity unavailable`;
  const pending = status.hasPendingMessages ? " \u2014 pending messages" : "";
  return `${member} \u2014 online \u2014 ${status.activity}${pending}`;
}

// src/domain/member-idle-wait.ts
var ISO_TIMESTAMP_PATTERN2 = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";
var IsoTimestampSchema2 = Type.String({ pattern: ISO_TIMESTAMP_PATTERN2 });
var PublicLabelSchema2 = Type.String({ minLength: 1, maxLength: 256 });
var MemberIdleWaitIdentitySchema = Type.Object(
  { name: PublicLabelSchema2, role: PublicLabelSchema2 },
  { additionalProperties: false }
);
var IdleMemberIdleWaitOutcomeSchema = Type.Object(
  {
    outcome: Type.Literal("idle"),
    disposition: Type.Union([Type.Literal("already-idle"), Type.Literal("became-idle")]),
    observedAt: IsoTimestampSchema2
  },
  { additionalProperties: false }
);
var OfflineMemberIdleWaitOutcomeSchema = Type.Object(
  { outcome: Type.Literal("offline"), observedAt: IsoTimestampSchema2 },
  { additionalProperties: false }
);
var TimeoutMemberIdleWaitOutcomeSchema = Type.Object(
  { outcome: Type.Literal("timeout"), observedAt: IsoTimestampSchema2 },
  { additionalProperties: false }
);
var MessageReceivedMemberIdleWaitOutcomeSchema = Type.Object(
  { outcome: Type.Literal("message-received"), observedAt: IsoTimestampSchema2 },
  { additionalProperties: false }
);
var MemberIdleWaitOutcomeSchema = Type.Union([
  IdleMemberIdleWaitOutcomeSchema,
  OfflineMemberIdleWaitOutcomeSchema,
  TimeoutMemberIdleWaitOutcomeSchema,
  MessageReceivedMemberIdleWaitOutcomeSchema
]);
var MemberIdleWaitResultSchema = Type.Union([
  Type.Object(
    {
      member: MemberIdleWaitIdentitySchema,
      outcome: Type.Literal("idle"),
      disposition: Type.Union([Type.Literal("already-idle"), Type.Literal("became-idle")]),
      observedAt: IsoTimestampSchema2
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      member: MemberIdleWaitIdentitySchema,
      outcome: Type.Literal("offline"),
      observedAt: IsoTimestampSchema2
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      member: MemberIdleWaitIdentitySchema,
      outcome: Type.Literal("timeout"),
      observedAt: IsoTimestampSchema2
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      member: MemberIdleWaitIdentitySchema,
      outcome: Type.Literal("message-received"),
      observedAt: IsoTimestampSchema2
    },
    { additionalProperties: false }
  )
]);
var UTF8_ENCODER2 = new TextEncoder();
var utf8Bytes3 = (value) => UTF8_ENCODER2.encode(value).byteLength;
var isSafeBoundedText2 = (value, limit) => value.trim().length > 0 && value === value.trim() && !/[\0\r\n]/u.test(value) && utf8Bytes3(value) <= limit;
function isIsoTimestamp2(value) {
  if (typeof value !== "string" || !new RegExp(ISO_TIMESTAMP_PATTERN2, "u").test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}
function isIdleWaitIdentity(value) {
  return isSafeBoundedText2(value.name, 256) && isSafeBoundedText2(value.role, 256);
}
function isMemberIdleWaitResult(value) {
  if (!value_exports2.Check(MemberIdleWaitResultSchema, value)) return false;
  const result = value;
  return isIdleWaitIdentity(result.member) && isIsoTimestamp2(result.observedAt);
}
function formatMemberIdleWaitResult(result) {
  if (!isMemberIdleWaitResult(result)) throw new TypeError("invalid member idle wait result");
  const member = `${result.member.name} (${result.member.role})`;
  if (result.outcome === "idle") return `[${member}] idle \u2014 ${result.disposition} at ${result.observedAt}`;
  if (result.outcome === "message-received")
    return `[${member}] message-received at ${result.observedAt} \u2014 released because a Bebop message is ready; process it under its delivery mode. No idle or completion claim was made.`;
  return `[${member}] ${result.outcome} at ${result.observedAt}`;
}

// src/domain/protocol.ts
var JSON_RPC_VERSION = "2.0";
var RpcIdSchema = Type.Union([Type.String({ minLength: 1 }), Type.Integer()]);
var UnknownMethodParamsSchema = Type.Union([Type.Null(), Type.Object({}, { additionalProperties: true })]);
var MessageSendParamsSchema = Type.Object(
  {
    ...MessagePayloadSchema.properties,
    delivery: Type.Optional(Type.Union([Type.Literal("follow_up"), Type.Literal("immediate")]))
  },
  { additionalProperties: false }
);
var SubscribeParamsSchema = Type.Object({ event: Type.Literal("turn_end") }, { additionalProperties: false });
var EmptyParamsSchema = Type.Object({}, { additionalProperties: false });
var MAX_PRESENCE_HINT_FIELD_BYTES = 256;
var PresenceHintTextSchema = Type.String({
  minLength: 1,
  maxLength: MAX_PRESENCE_HINT_FIELD_BYTES,
  pattern: "^[^\\u0000]+$"
});
var PresenceHintParamsSchema = Type.Object(
  {
    member: Type.Object(
      { identity: PresenceHintTextSchema, name: PresenceHintTextSchema, role: PresenceHintTextSchema },
      { additionalProperties: false }
    ),
    state: Type.Union([Type.Literal("online"), Type.Literal("offline")]),
    instanceId: PresenceHintTextSchema
  },
  { additionalProperties: false }
);
var MessageSendRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal(JSON_RPC_VERSION),
    id: RpcIdSchema,
    method: Type.Literal("message.send"),
    params: MessageSendParamsSchema
  },
  { additionalProperties: false }
);
var { replyTo: _replyTo, ...InterruptPayloadProperties } = MessagePayloadSchema.properties;
var InterruptPayloadSchema = Type.Object(InterruptPayloadProperties, { additionalProperties: false });
var InterruptParamsSchema = Type.Object({ payload: InterruptPayloadSchema }, { additionalProperties: false });
var InterruptResultSchema = Type.Object(
  {
    interruptId: Type.String({ minLength: 1 }),
    disposition: Type.Union([Type.Literal("interrupt-requested"), Type.Literal("direct")])
  },
  { additionalProperties: false }
);
var InterruptRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal(JSON_RPC_VERSION),
    id: RpcIdSchema,
    method: Type.Literal("message.interrupt"),
    params: InterruptParamsSchema
  },
  { additionalProperties: false }
);
var SubscribeRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal(JSON_RPC_VERSION),
    id: RpcIdSchema,
    method: Type.Literal("event.subscribe"),
    params: SubscribeParamsSchema
  },
  { additionalProperties: false }
);
var StatusRequestSchema = Type.Object(
  { jsonrpc: Type.Literal(JSON_RPC_VERSION), id: RpcIdSchema, method: Type.Literal("session.status") },
  { additionalProperties: false }
);
var GetMessageRequestSchema = Type.Object(
  { jsonrpc: Type.Literal(JSON_RPC_VERSION), id: RpcIdSchema, method: Type.Literal("session.get_message") },
  { additionalProperties: false }
);
var ClearRequestSchema = Type.Object(
  { jsonrpc: Type.Literal(JSON_RPC_VERSION), id: RpcIdSchema, method: Type.Literal("session.clear") },
  { additionalProperties: false }
);
var AbortRequestSchema = Type.Object(
  { jsonrpc: Type.Literal(JSON_RPC_VERSION), id: RpcIdSchema, method: Type.Literal("session.abort") },
  { additionalProperties: false }
);
var PresenceHintResultSchema = Type.Object({ accepted: Type.Boolean() }, { additionalProperties: false });
var MAX_MEMBER_STATUS_TARGET_BYTES = 256;
var MemberStatusTargetSchema = Type.String({ minLength: 1, maxLength: MAX_MEMBER_STATUS_TARGET_BYTES });
var MemberStatusParamsSchema = Type.Object(
  { member: MemberStatusTargetSchema },
  { additionalProperties: false }
);
var MemberStatusResultSchema = Type.Object({ status: MemberStatusSchema }, { additionalProperties: false });
var PresenceHintRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal(JSON_RPC_VERSION),
    id: RpcIdSchema,
    method: Type.Literal("presence.hint"),
    params: PresenceHintParamsSchema
  },
  { additionalProperties: false }
);
var MemberStatusRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal(JSON_RPC_VERSION),
    id: RpcIdSchema,
    method: Type.Literal("member.status"),
    params: MemberStatusParamsSchema
  },
  { additionalProperties: false }
);
var MemberStatusCommandSchema = Type.Object(
  {
    type: Type.Literal("member_status"),
    member: MemberStatusTargetSchema,
    id: Type.Optional(RpcIdSchema)
  },
  { additionalProperties: false }
);
var MemberStatusTargetParamsSchema = Type.Object(
  { target: MemberStatusTargetSchema },
  { additionalProperties: false }
);
var MemberStatusTargetRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal(JSON_RPC_VERSION),
    id: RpcIdSchema,
    method: Type.Literal("member.status_target"),
    params: MemberStatusTargetParamsSchema
  },
  { additionalProperties: false }
);
var MemberStatusTargetCommandSchema = Type.Object(
  {
    type: Type.Literal("member_status_target"),
    target: MemberStatusTargetSchema,
    id: Type.Optional(RpcIdSchema)
  },
  { additionalProperties: false }
);
var MemberMessageContentSchema = Type.String({
  minLength: 1,
  maxLength: MAX_MESSAGE_CONTENT_BYTES
});
var MemberMessageParamsSchema = Type.Object(
  {
    target: MemberStatusTargetSchema,
    message: MemberMessageContentSchema,
    instructions: MessageInstructionsSchema
  },
  { additionalProperties: false }
);
var MemberFollowUpParamsSchema = MemberMessageParamsSchema;
var MemberRedirectParamsSchema = MemberMessageParamsSchema;
var MemberFollowUpRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal(JSON_RPC_VERSION),
    id: RpcIdSchema,
    method: Type.Literal("member.follow_up"),
    params: MemberFollowUpParamsSchema
  },
  { additionalProperties: false }
);
var MemberRedirectRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal(JSON_RPC_VERSION),
    id: RpcIdSchema,
    method: Type.Literal("member.redirect"),
    params: MemberRedirectParamsSchema
  },
  { additionalProperties: false }
);
var MemberFollowUpCommandSchema = Type.Object(
  {
    type: Type.Literal("member_follow_up"),
    target: MemberStatusTargetSchema,
    message: MemberMessageContentSchema,
    instructions: MessageInstructionsSchema,
    id: Type.Optional(RpcIdSchema)
  },
  { additionalProperties: false }
);
var MemberRedirectCommandSchema = Type.Object(
  {
    type: Type.Literal("member_redirect"),
    target: MemberStatusTargetSchema,
    message: MemberMessageContentSchema,
    instructions: MessageInstructionsSchema,
    id: Type.Optional(RpcIdSchema)
  },
  { additionalProperties: false }
);
var RequestOutcomeRequestIdSchema = Type.String({ minLength: 1, maxLength: 128 });
var RequestOutcomeTimeoutSchema = Type.Integer({ minimum: 1, maximum: 600 });
var MemberRequestParamsSchema = Type.Object(
  {
    requestId: RequestOutcomeRequestIdSchema,
    payload: MessagePayloadSchema,
    timeoutSeconds: RequestOutcomeTimeoutSchema
  },
  { additionalProperties: false }
);
var MemberRequestRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal(JSON_RPC_VERSION),
    id: RpcIdSchema,
    method: Type.Literal("member.request"),
    params: MemberRequestParamsSchema
  },
  { additionalProperties: false }
);
var MemberRequestCommandSchema = Type.Object(
  {
    type: Type.Literal("member_request"),
    ...MemberRequestParamsSchema.properties,
    id: Type.Optional(RpcIdSchema)
  },
  { additionalProperties: false }
);
var MemberRequestResultSchema = Type.Object(
  {
    accepted: Type.Literal(true),
    requestId: RequestOutcomeRequestIdSchema,
    member: Type.Object(
      { name: Type.String({ minLength: 1 }), role: Type.String({ minLength: 1 }) },
      { additionalProperties: false }
    )
  },
  { additionalProperties: false }
);
var MemberResponseParamsSchema = Type.Object(
  {
    requestId: RequestOutcomeRequestIdSchema,
    message: MemberMessageContentSchema,
    instructions: MessageInstructionsSchema
  },
  { additionalProperties: false }
);
var MemberResponseRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal(JSON_RPC_VERSION),
    id: RpcIdSchema,
    method: Type.Literal("member.respond"),
    params: MemberResponseParamsSchema
  },
  { additionalProperties: false }
);
var MemberResponseCommandSchema = Type.Object(
  {
    type: Type.Literal("member_response"),
    ...MemberResponseParamsSchema.properties,
    id: Type.Optional(RpcIdSchema)
  },
  { additionalProperties: false }
);
var MemberUpdateResponseSchema = Type.Object(
  {
    kind: Type.Literal("response"),
    requestId: RequestOutcomeRequestIdSchema,
    member: Type.Object(
      { name: Type.String({ minLength: 1 }), role: Type.String({ minLength: 1 }) },
      { additionalProperties: false }
    ),
    message: MemberMessageContentSchema,
    instructions: Type.Optional(MessageInstructionsSchema)
  },
  { additionalProperties: false }
);
var MemberUpdateMechanicalSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("offline"), Type.Literal("timeout")]),
    requestId: RequestOutcomeRequestIdSchema,
    member: Type.Object(
      { name: Type.String({ minLength: 1 }), role: Type.String({ minLength: 1 }) },
      { additionalProperties: false }
    )
  },
  { additionalProperties: false }
);
var MemberUpdateIdleSchema = Type.Object(
  {
    kind: Type.Literal("idle"),
    requestId: RequestOutcomeRequestIdSchema,
    member: Type.Object(
      { name: Type.String({ minLength: 1 }), role: Type.String({ minLength: 1 }) },
      { additionalProperties: false }
    )
  },
  { additionalProperties: false }
);
var MemberUpdateNotificationSchema = Type.Object(
  {
    jsonrpc: Type.Literal(JSON_RPC_VERSION),
    method: Type.Literal("member.update"),
    params: Type.Union([MemberUpdateResponseSchema, MemberUpdateMechanicalSchema, MemberUpdateIdleSchema])
  },
  { additionalProperties: false }
);
var MemberUpdateResultSchema = Type.Union([MemberUpdateResponseSchema, MemberUpdateMechanicalSchema]);
var MemberInterruptParamsSchema = Type.Object(
  {
    target: MemberStatusTargetSchema,
    message: MemberMessageContentSchema,
    instructions: MessageInstructionsSchema
  },
  { additionalProperties: false }
);
var MemberInterruptRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal(JSON_RPC_VERSION),
    id: RpcIdSchema,
    method: Type.Literal("member.interrupt"),
    params: MemberInterruptParamsSchema
  },
  { additionalProperties: false }
);
var MemberInterruptCommandSchema = Type.Object(
  {
    type: Type.Literal("member_interrupt"),
    target: MemberStatusTargetSchema,
    message: MemberMessageContentSchema,
    instructions: MessageInstructionsSchema,
    id: Type.Optional(RpcIdSchema)
  },
  { additionalProperties: false }
);
var MemberInterruptResultSchema = Type.Object(
  {
    member: Type.Object(
      { name: Type.String({ minLength: 1 }), role: Type.String({ minLength: 1 }) },
      { additionalProperties: false }
    ),
    interruptId: Type.String({ minLength: 1 }),
    disposition: Type.Union([Type.Literal("direct"), Type.Literal("interrupt-requested")])
  },
  { additionalProperties: false }
);
var MemberInboxSendParamsSchema = Type.Object(
  {
    target: MemberStatusTargetSchema,
    message: MemberMessageContentSchema,
    instructions: MessageInstructionsSchema
  },
  { additionalProperties: false }
);
var CrewBroadcastParamsSchema = Type.Object(
  { message: MemberMessageContentSchema, instructions: MessageInstructionsSchema },
  { additionalProperties: false }
);
var MemberInboxSendRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal(JSON_RPC_VERSION),
    id: RpcIdSchema,
    method: Type.Literal("member.inbox_send"),
    params: MemberInboxSendParamsSchema
  },
  { additionalProperties: false }
);
var CrewBroadcastRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal(JSON_RPC_VERSION),
    id: RpcIdSchema,
    method: Type.Literal("crew.broadcast"),
    params: CrewBroadcastParamsSchema
  },
  { additionalProperties: false }
);
var MemberInboxSendCommandSchema = Type.Object(
  {
    type: Type.Literal("member_inbox_send"),
    target: MemberStatusTargetSchema,
    message: MemberMessageContentSchema,
    instructions: MessageInstructionsSchema,
    id: Type.Optional(RpcIdSchema)
  },
  { additionalProperties: false }
);
var CrewBroadcastCommandSchema = Type.Object(
  {
    type: Type.Literal("crew_broadcast"),
    message: MemberMessageContentSchema,
    instructions: MessageInstructionsSchema,
    id: Type.Optional(RpcIdSchema)
  },
  { additionalProperties: false }
);
var GuestJoinParamsSchema = Type.Object(
  {
    guestIdentity: Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000\\r\\n]+$" }),
    guestName: Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000\\r\\n]+$" }),
    callbackEndpoint: Type.String({ minLength: 1, maxLength: 512, pattern: "^[^\\u0000\\r\\n]+$" })
  },
  { additionalProperties: false }
);
var GuestJoinRpcRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal(JSON_RPC_VERSION),
    id: RpcIdSchema,
    method: Type.Literal("guest.join"),
    params: GuestJoinParamsSchema
  },
  { additionalProperties: false }
);
var GuestJoinCommandSchema = Type.Object(
  {
    type: Type.Literal("guest_join"),
    ...GuestJoinParamsSchema.properties,
    id: Type.Optional(RpcIdSchema)
  },
  { additionalProperties: false }
);
var GuestJoinCrewSchema = Type.Object(
  { id: Type.String({ minLength: 1 }), displayName: Type.String({ minLength: 1 }) },
  { additionalProperties: false }
);
var GuestJoinResultSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("pending"), Type.Literal("approved")]),
    requestId: Type.String({ minLength: 1 }),
    crew: GuestJoinCrewSchema,
    /** Member-issued capability; delivered on the approved join response only. */
    capability: Type.Optional(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000\\r\\n]+$" }))
  },
  { additionalProperties: false }
);
var GuestLeaveParamsSchema = Type.Object(
  {
    guestIdentity: Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000\\r\\n]+$" }),
    crewId: Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\u0000\\r\\n]+$" }),
    callbackEndpoint: Type.String({ minLength: 1, maxLength: 512, pattern: "^[^\\u0000\\r\\n]+$" })
  },
  { additionalProperties: false }
);
var GuestSendBoundedText = (maxLength) => Type.String({ minLength: 1, maxLength, pattern: "^[^\\u0000\\r\\n]+$" });
var GuestSendParamsSchema = Type.Object(
  {
    crewId: GuestSendBoundedText(256),
    guestIdentity: GuestSendBoundedText(256),
    callbackEndpoint: GuestSendBoundedText(512),
    capability: GuestSendBoundedText(256),
    target: GuestSendBoundedText(256),
    content: Type.String({ minLength: 1, maxLength: 1e6 }),
    instructions: Type.Optional(Type.Array(GuestSendBoundedText(1e5), { maxItems: 32 }))
  },
  { additionalProperties: false }
);
var GuestSendResultSchema = Type.Object(
  {
    deliveryId: Type.String({ minLength: 1 }),
    disposition: Type.Union([Type.Literal("direct"), Type.Literal("queued"), Type.Literal("steered")]),
    fromGuestName: Type.String({ minLength: 1 })
  },
  { additionalProperties: false }
);
var GuestSendCommandSchema = Type.Object(
  {
    type: Type.Literal("guest_send"),
    ...GuestSendParamsSchema.properties,
    id: Type.Optional(RpcIdSchema)
  },
  { additionalProperties: false }
);
var GuestLeaveRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal(JSON_RPC_VERSION),
    id: RpcIdSchema,
    method: Type.Literal("guest.leave"),
    params: GuestLeaveParamsSchema
  },
  { additionalProperties: false }
);
var GuestLeaveCommandSchema = Type.Object(
  { type: Type.Literal("guest_leave"), ...GuestLeaveParamsSchema.properties, id: Type.Optional(RpcIdSchema) },
  { additionalProperties: false }
);
var MemberMessageResultSchema = Type.Object(
  {
    member: Type.Object(
      { name: Type.String({ minLength: 1 }), role: Type.String({ minLength: 1 }) },
      { additionalProperties: false }
    ),
    deliveryId: Type.String({ minLength: 1 }),
    disposition: Type.Union([Type.Literal("direct"), Type.Literal("queued"), Type.Literal("steered")])
  },
  { additionalProperties: false }
);
var MemberInboxSendResultSchema = Type.Object(
  {
    member: Type.Object(
      { name: Type.String({ minLength: 1 }), role: Type.String({ minLength: 1 }) },
      { additionalProperties: false }
    ),
    itemId: Type.String({ minLength: 1 }),
    persisted: Type.Literal(true),
    hint: Type.Union([Type.Literal("sent"), Type.Literal("skipped")])
  },
  { additionalProperties: false }
);
var BroadcastDispositionBaseSchema = {
  member: Type.String({ minLength: 1 }),
  role: Type.String({ minLength: 1 })
};
var BroadcastDispositionSchema = Type.Union([
  Type.Object(
    {
      ...BroadcastDispositionBaseSchema,
      deliveryId: Type.String({ minLength: 1 }),
      disposition: Type.Literal("delivered")
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      ...BroadcastDispositionBaseSchema,
      disposition: Type.Literal("failed"),
      code: Type.String({ minLength: 1 })
    },
    { additionalProperties: false }
  )
]);
var BroadcastSummarySchema = Type.Object(
  {
    delivered: Type.Integer({ minimum: 0 }),
    failed: Type.Integer({ minimum: 0 }),
    total: Type.Integer({ minimum: 0 })
  },
  { additionalProperties: false }
);
var CrewBroadcastResultSchema = Type.Object(
  {
    dispositions: Type.Array(BroadcastDispositionSchema),
    summary: BroadcastSummarySchema
  },
  { additionalProperties: false }
);
var MAX_MEMBER_IDLE_WAIT_TIMEOUT = 7200;
var MIN_MEMBER_IDLE_WAIT_TIMEOUT = 60;
var MemberIdleWaitTimeoutSchema = Type.Integer({
  minimum: MIN_MEMBER_IDLE_WAIT_TIMEOUT,
  maximum: MAX_MEMBER_IDLE_WAIT_TIMEOUT
});
var MemberIdleWaitParamsSchema = Type.Object(
  {
    member: MemberStatusTargetSchema,
    timeoutSeconds: Type.Optional(MemberIdleWaitTimeoutSchema)
  },
  { additionalProperties: false }
);
var MemberIdleWaitSubscribeResultSchema = Type.Object(
  { subscriptionId: Type.String({ minLength: 1 }), event: Type.Literal("member_idle") },
  { additionalProperties: false }
);
var MemberIdleWaitRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal(JSON_RPC_VERSION),
    id: RpcIdSchema,
    method: Type.Literal("member.idle_wait"),
    params: MemberIdleWaitParamsSchema
  },
  { additionalProperties: false }
);
var MemberIdleWaitCommandSchema = Type.Object(
  {
    type: Type.Literal("member_idle_wait"),
    member: MemberStatusTargetSchema,
    timeoutSeconds: Type.Optional(MemberIdleWaitTimeoutSchema),
    id: Type.Optional(RpcIdSchema)
  },
  { additionalProperties: false }
);
var MemberIdleWaitNotificationSchema = Type.Object(
  {
    jsonrpc: Type.Literal(JSON_RPC_VERSION),
    method: Type.Literal("member.idle_wait"),
    params: Type.Object(
      { subscriptionId: Type.String({ minLength: 1 }), result: MemberIdleWaitResultSchema },
      { additionalProperties: false }
    )
  },
  { additionalProperties: false }
);
var KnownRequestSchema = Type.Union([
  MessageSendRequestSchema,
  InterruptRequestSchema,
  SubscribeRequestSchema,
  StatusRequestSchema,
  GetMessageRequestSchema,
  ClearRequestSchema,
  AbortRequestSchema,
  PresenceHintRequestSchema,
  MemberStatusRequestSchema,
  MemberStatusTargetRequestSchema,
  MemberRequestRequestSchema,
  MemberResponseRequestSchema,
  MemberFollowUpRequestSchema,
  MemberRedirectRequestSchema,
  MemberInterruptRequestSchema,
  MemberInboxSendRequestSchema,
  CrewBroadcastRequestSchema,
  GuestJoinRpcRequestSchema,
  GuestLeaveRequestSchema,
  MemberIdleWaitRequestSchema
]);
var GenericRequestSchema = Type.Object(
  {
    jsonrpc: Type.Literal(JSON_RPC_VERSION),
    id: RpcIdSchema,
    method: Type.String({ minLength: 1 }),
    params: Type.Optional(UnknownMethodParamsSchema)
  },
  { additionalProperties: false }
);
var RpcRequestSchema = Type.Union([KnownRequestSchema, GenericRequestSchema]);
var RpcErrorSchema = Type.Object(
  {
    code: Type.Integer(),
    message: Type.String(),
    data: Type.Optional(Type.Object({ code: Type.Optional(Type.String()) }, { additionalProperties: false }))
  },
  { additionalProperties: false }
);
var ResponseIdSchema = Type.Union([RpcIdSchema, Type.Null()]);
var StatusResultSchema = Type.Object(
  { status: Type.Union([Type.Literal("stopped"), Type.Literal("online"), Type.Literal("joined")]) },
  { additionalProperties: false }
);
var SendResultSchema = Type.Object(
  {
    deliveryId: Type.String({ minLength: 1 }),
    disposition: Type.Union([Type.Literal("direct"), Type.Literal("queued"), Type.Literal("steered")])
  },
  { additionalProperties: false }
);
var GetMessageResultSchema = Type.Object(
  { message: Type.Union([ExtractedMessageSchema, Type.Null()]) },
  { additionalProperties: false }
);
var ClearResultSchema = Type.Object(
  {
    cleared: Type.Literal(true),
    alreadyAtRoot: Type.Optional(Type.Boolean()),
    targetId: Type.Optional(Type.String())
  },
  { additionalProperties: false }
);
var SubscribeResultSchema = Type.Object(
  { subscriptionId: Type.String({ minLength: 1 }), event: Type.Literal("turn_end") },
  { additionalProperties: false }
);
var EmptyResultSchema = Type.Object({}, { additionalProperties: false });
var RpcMethodResultSchema = Type.Union([
  StatusResultSchema,
  SendResultSchema,
  InterruptResultSchema,
  GetMessageResultSchema,
  ClearResultSchema,
  SubscribeResultSchema,
  PresenceHintResultSchema,
  MemberStatusResultSchema,
  MemberRequestResultSchema,
  MemberUpdateResultSchema,
  MemberMessageResultSchema,
  MemberInterruptResultSchema,
  MemberInboxSendResultSchema,
  CrewBroadcastResultSchema,
  GuestJoinResultSchema,
  GuestSendResultSchema,
  MemberIdleWaitSubscribeResultSchema,
  EmptyResultSchema
]);
var RpcResponseSchema = Type.Union([
  Type.Object(
    { jsonrpc: Type.Literal(JSON_RPC_VERSION), id: ResponseIdSchema, result: RpcMethodResultSchema },
    { additionalProperties: false }
  ),
  Type.Object(
    { jsonrpc: Type.Literal(JSON_RPC_VERSION), id: ResponseIdSchema, error: RpcErrorSchema },
    { additionalProperties: false }
  )
]);
var TurnEndNotificationSchema = Type.Object(
  {
    jsonrpc: Type.Literal(JSON_RPC_VERSION),
    method: Type.Literal("session.turn_end"),
    params: Type.Object(
      {
        subscriptionId: Type.String({ minLength: 1 }),
        message: Type.Optional(Type.Union([ExtractedMessageSchema, Type.Null()])),
        turnIndex: Type.Optional(Type.Integer())
      },
      { additionalProperties: false }
    )
  },
  { additionalProperties: false }
);
function isMemberInterruptResult(value) {
  return value_exports2.Check(MemberInterruptResultSchema, value);
}
function isMemberMessageResult(value) {
  return value_exports2.Check(MemberMessageResultSchema, value);
}
function isMemberInboxSendResult(value) {
  return value_exports2.Check(MemberInboxSendResultSchema, value);
}
function isCrewBroadcastResult(value) {
  if (!value_exports2.Check(CrewBroadcastResultSchema, value)) return false;
  const result = value;
  const delivered = result.dispositions.filter((item) => item.disposition === "delivered").length;
  const failed = result.dispositions.filter((item) => item.disposition === "failed").length;
  return result.summary.total === result.dispositions.length && result.summary.delivered === delivered && result.summary.failed === failed;
}
var MessageSendCommandSchema = Type.Object(
  {
    type: Type.Literal("send"),
    payload: MessagePayloadSchema,
    delivery: Type.Optional(Type.Union([Type.Literal("follow_up"), Type.Literal("immediate")])),
    id: Type.Optional(RpcIdSchema)
  },
  { additionalProperties: false }
);
var InterruptCommandSchema = Type.Object(
  {
    type: Type.Literal("interrupt"),
    payload: InterruptPayloadSchema,
    id: Type.Optional(RpcIdSchema)
  },
  { additionalProperties: false }
);
var SubscribeCommandSchema = Type.Object(
  {
    type: Type.Literal("subscribe"),
    ...SubscribeParamsSchema.properties,
    id: Type.Optional(RpcIdSchema)
  },
  { additionalProperties: false }
);
var StatusCommandSchema = Type.Object(
  { type: Type.Literal("status"), id: Type.Optional(RpcIdSchema) },
  { additionalProperties: false }
);
var GetMessageCommandSchema = Type.Object(
  { type: Type.Literal("get_message"), id: Type.Optional(RpcIdSchema) },
  { additionalProperties: false }
);
var ClearCommandSchema = Type.Object(
  { type: Type.Literal("clear"), id: Type.Optional(RpcIdSchema) },
  { additionalProperties: false }
);
var AbortCommandSchema = Type.Object(
  { type: Type.Literal("abort"), id: Type.Optional(RpcIdSchema) },
  { additionalProperties: false }
);
var PresenceHintCommandSchema = Type.Object(
  { type: Type.Literal("presence_hint"), ...PresenceHintParamsSchema.properties, id: Type.Optional(RpcIdSchema) },
  { additionalProperties: false }
);
var RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603
};
var RpcCommandResponseSchema = Type.Object(
  {
    type: Type.Literal("response"),
    command: Type.String({ minLength: 1 }),
    success: Type.Boolean(),
    error: Type.Optional(Type.String()),
    data: Type.Optional(RpcMethodResultSchema),
    id: RpcIdSchema
  },
  { additionalProperties: false }
);
var RpcTurnEndNotificationSchema = Type.Object(
  {
    type: Type.Literal("event"),
    event: Type.Literal("turn_end"),
    data: Type.Optional(
      Type.Object(
        {
          message: Type.Optional(Type.Union([ExtractedMessageSchema, Type.Null()])),
          turnIndex: Type.Optional(Type.Integer())
        },
        { additionalProperties: false }
      )
    ),
    subscriptionId: Type.String({ minLength: 1 })
  },
  { additionalProperties: false }
);
function isPresenceHintParams(value) {
  if (!value_exports2.Check(PresenceHintParamsSchema, value)) return false;
  const params = value;
  return [params.member.identity, params.member.name, params.member.role, params.instanceId].every(
    (field) => field.trim() === field && Buffer.byteLength(field, "utf8") <= MAX_PRESENCE_HINT_FIELD_BYTES
  );
}
function isRpcRequest(value) {
  return value_exports2.Check(RpcRequestSchema, value);
}
function isRpcResponse(value) {
  return value_exports2.Check(RpcResponseSchema, value);
}
function isTurnEndNotification(value) {
  return value_exports2.Check(TurnEndNotificationSchema, value);
}
var invalidCommandParams = (message) => ({ code: RPC_ERROR.invalidParams, message });
var COMMAND_REGISTRY = {
  send: {
    method: "message.send",
    requestSchema: MessageSendRequestSchema,
    resultSchema: SendResultSchema,
    toParams: (command) => {
      const send = command;
      return { ...send.payload, delivery: send.delivery ?? "follow_up" };
    },
    fromParams: (params, id) => {
      const rawParams = params && typeof params === "object" ? params : void 0;
      const payload = rawParams ? {
        content: rawParams.content,
        ...rawParams.instructions === void 0 ? {} : { instructions: rawParams.instructions },
        ...rawParams.origin === void 0 ? {} : { origin: rawParams.origin },
        ...rawParams.kind === void 0 ? {} : { kind: rawParams.kind },
        ...rawParams.sentAt === void 0 ? {} : { sentAt: rawParams.sentAt },
        ...rawParams.replyTo === void 0 ? {} : { replyTo: rawParams.replyTo }
      } : void 0;
      if (!value_exports2.Check(MessageSendParamsSchema, params) || !isMessagePayload(payload))
        return invalidCommandParams("Invalid message.send params");
      const validParams = params;
      return {
        type: "send",
        payload,
        delivery: validParams.delivery ?? "follow_up",
        id
      };
    }
  },
  interrupt: {
    method: "message.interrupt",
    requestSchema: InterruptRequestSchema,
    resultSchema: InterruptResultSchema,
    toParams: (command) => ({ payload: command.payload }),
    fromParams: (params, id) => {
      if (!value_exports2.Check(InterruptParamsSchema, params))
        return invalidCommandParams("Invalid message.interrupt params");
      const payload = params.payload;
      if (!isMessagePayload(payload)) return invalidCommandParams("Invalid message.interrupt payload");
      return { type: "interrupt", payload, id };
    }
  },
  member_status: {
    method: "member.status",
    requestSchema: MemberStatusRequestSchema,
    resultSchema: MemberStatusResultSchema,
    toParams: (command) => ({ member: command.member }),
    fromParams: (params, id) => {
      if (!value_exports2.Check(MemberStatusParamsSchema, params))
        return invalidCommandParams("Invalid member.status params");
      return { type: "member_status", member: params.member, id };
    }
  },
  member_status_target: {
    method: "member.status_target",
    requestSchema: MemberStatusTargetRequestSchema,
    resultSchema: MemberStatusResultSchema,
    toParams: (command) => ({ target: command.target }),
    fromParams: (params, id) => {
      if (!value_exports2.Check(MemberStatusTargetParamsSchema, params))
        return invalidCommandParams("Invalid member.status_target params");
      return { type: "member_status_target", target: params.target, id };
    }
  },
  member_request: {
    method: "member.request",
    requestSchema: MemberRequestRequestSchema,
    resultSchema: MemberRequestResultSchema,
    toParams: (command) => {
      const request = command;
      return { requestId: request.requestId, payload: request.payload, timeoutSeconds: request.timeoutSeconds };
    },
    fromParams: (params, id) => {
      if (!value_exports2.Check(MemberRequestParamsSchema, params))
        return invalidCommandParams("Invalid member.request params");
      const requestParams = params;
      if (!isMessagePayload(requestParams.payload)) return invalidCommandParams("Invalid member.request payload");
      return { type: "member_request", ...requestParams, id };
    }
  },
  member_response: {
    method: "member.respond",
    requestSchema: MemberResponseRequestSchema,
    resultSchema: EmptyResultSchema,
    toParams: (command) => {
      const response = command;
      return {
        requestId: response.requestId,
        message: response.message,
        ...response.instructions === void 0 ? {} : { instructions: response.instructions }
      };
    },
    fromParams: (params, id) => {
      if (!value_exports2.Check(MemberResponseParamsSchema, params))
        return invalidCommandParams("Invalid member.respond params");
      return { type: "member_response", ...params, id };
    }
  },
  member_interrupt: {
    method: "member.interrupt",
    requestSchema: MemberInterruptRequestSchema,
    resultSchema: MemberInterruptResultSchema,
    toParams: (command) => {
      const interrupt = command;
      return {
        target: interrupt.target,
        message: interrupt.message,
        ...interrupt.instructions === void 0 ? {} : { instructions: interrupt.instructions }
      };
    },
    fromParams: (params, id) => {
      if (!value_exports2.Check(MemberInterruptParamsSchema, params))
        return invalidCommandParams("Invalid member.interrupt params");
      const interrupt = params;
      return {
        type: "member_interrupt",
        target: interrupt.target,
        message: interrupt.message,
        ...interrupt.instructions === void 0 ? {} : { instructions: interrupt.instructions },
        id
      };
    }
  },
  member_follow_up: {
    method: "member.follow_up",
    requestSchema: MemberFollowUpRequestSchema,
    resultSchema: MemberMessageResultSchema,
    toParams: (command) => {
      const followUp = command;
      return {
        target: followUp.target,
        message: followUp.message,
        ...followUp.instructions === void 0 ? {} : { instructions: followUp.instructions }
      };
    },
    fromParams: (params, id) => {
      if (!value_exports2.Check(MemberFollowUpParamsSchema, params))
        return invalidCommandParams("Invalid member.follow_up params");
      const delivery = params;
      return {
        type: "member_follow_up",
        target: delivery.target,
        message: delivery.message,
        ...delivery.instructions === void 0 ? {} : { instructions: delivery.instructions },
        id
      };
    }
  },
  member_redirect: {
    method: "member.redirect",
    requestSchema: MemberRedirectRequestSchema,
    resultSchema: MemberMessageResultSchema,
    toParams: (command) => {
      const redirect = command;
      return {
        target: redirect.target,
        message: redirect.message,
        ...redirect.instructions === void 0 ? {} : { instructions: redirect.instructions }
      };
    },
    fromParams: (params, id) => {
      if (!value_exports2.Check(MemberRedirectParamsSchema, params))
        return invalidCommandParams("Invalid member.redirect params");
      const delivery = params;
      return {
        type: "member_redirect",
        target: delivery.target,
        message: delivery.message,
        ...delivery.instructions === void 0 ? {} : { instructions: delivery.instructions },
        id
      };
    }
  },
  member_inbox_send: {
    method: "member.inbox_send",
    requestSchema: MemberInboxSendRequestSchema,
    resultSchema: MemberInboxSendResultSchema,
    toParams: (command) => {
      const delivery = command;
      return {
        target: delivery.target,
        message: delivery.message,
        ...delivery.instructions === void 0 ? {} : { instructions: delivery.instructions }
      };
    },
    fromParams: (params, id) => {
      if (!value_exports2.Check(MemberInboxSendParamsSchema, params))
        return invalidCommandParams("Invalid member.inbox_send params");
      const delivery = params;
      return {
        type: "member_inbox_send",
        target: delivery.target,
        message: delivery.message,
        ...delivery.instructions === void 0 ? {} : { instructions: delivery.instructions },
        id
      };
    }
  },
  crew_broadcast: {
    method: "crew.broadcast",
    requestSchema: CrewBroadcastRequestSchema,
    resultSchema: CrewBroadcastResultSchema,
    toParams: (command) => {
      const broadcast = command;
      return {
        message: broadcast.message,
        ...broadcast.instructions === void 0 ? {} : { instructions: broadcast.instructions }
      };
    },
    fromParams: (params, id) => {
      if (!value_exports2.Check(CrewBroadcastParamsSchema, params))
        return invalidCommandParams("Invalid crew.broadcast params");
      const delivery = params;
      return {
        type: "crew_broadcast",
        message: delivery.message,
        ...delivery.instructions === void 0 ? {} : { instructions: delivery.instructions },
        id
      };
    }
  },
  guest_join: {
    method: "guest.join",
    requestSchema: GuestJoinRpcRequestSchema,
    resultSchema: GuestJoinResultSchema,
    toParams: (command) => {
      const join6 = command;
      return {
        guestIdentity: join6.guestIdentity,
        guestName: join6.guestName,
        callbackEndpoint: join6.callbackEndpoint
      };
    },
    fromParams: (params, id) => {
      if (!value_exports2.Check(GuestJoinParamsSchema, params)) return invalidCommandParams("Invalid guest.join params");
      return { type: "guest_join", ...params, id };
    }
  },
  guest_send: {
    method: "guest.send",
    requestSchema: GuestSendCommandSchema,
    resultSchema: GuestSendResultSchema,
    toParams: (command) => {
      const send = command;
      return {
        crewId: send.crewId,
        guestIdentity: send.guestIdentity,
        callbackEndpoint: send.callbackEndpoint,
        capability: send.capability,
        target: send.target,
        content: send.content,
        ...send.instructions === void 0 ? {} : { instructions: send.instructions }
      };
    },
    fromParams: (params, id) => {
      if (!value_exports2.Check(GuestSendParamsSchema, params)) return invalidCommandParams("Invalid guest.send params");
      return { type: "guest_send", ...params, id };
    }
  },
  guest_leave: {
    method: "guest.leave",
    requestSchema: GuestLeaveRequestSchema,
    resultSchema: EmptyResultSchema,
    toParams: (command) => {
      const leave = command;
      return {
        guestIdentity: leave.guestIdentity,
        crewId: leave.crewId,
        callbackEndpoint: leave.callbackEndpoint
      };
    },
    fromParams: (params, id) => {
      if (!value_exports2.Check(GuestLeaveParamsSchema, params)) return invalidCommandParams("Invalid guest.leave params");
      return { type: "guest_leave", ...params, id };
    }
  },
  member_idle_wait: {
    method: "member.idle_wait",
    requestSchema: MemberIdleWaitRequestSchema,
    resultSchema: MemberIdleWaitSubscribeResultSchema,
    toParams: (command) => {
      const wait = command;
      return {
        member: wait.member,
        ...wait.timeoutSeconds === void 0 ? {} : { timeoutSeconds: wait.timeoutSeconds }
      };
    },
    fromParams: (params, id) => {
      if (!value_exports2.Check(MemberIdleWaitParamsSchema, params))
        return invalidCommandParams("Invalid member.idle_wait params");
      const waitParams = params;
      return {
        type: "member_idle_wait",
        member: waitParams.member,
        ...waitParams.timeoutSeconds === void 0 ? {} : { timeoutSeconds: waitParams.timeoutSeconds },
        id
      };
    }
  },
  subscribe: {
    method: "event.subscribe",
    requestSchema: SubscribeRequestSchema,
    resultSchema: SubscribeResultSchema,
    toParams: (command) => ({ event: command.event }),
    fromParams: (params, id) => value_exports2.Check(SubscribeParamsSchema, params) ? { type: "subscribe", event: "turn_end", id } : invalidCommandParams("Invalid event.subscribe params")
  },
  status: {
    method: "session.status",
    requestSchema: StatusRequestSchema,
    resultSchema: StatusResultSchema,
    toParams: () => void 0,
    fromParams: (params, id) => params === void 0 ? { type: "status", id } : invalidCommandParams("Invalid session.status params")
  },
  get_message: {
    method: "session.get_message",
    requestSchema: GetMessageRequestSchema,
    resultSchema: GetMessageResultSchema,
    toParams: () => void 0,
    fromParams: (params, id) => params === void 0 ? { type: "get_message", id } : invalidCommandParams("Invalid session.get_message params")
  },
  clear: {
    method: "session.clear",
    requestSchema: ClearRequestSchema,
    resultSchema: ClearResultSchema,
    toParams: () => void 0,
    fromParams: (params, id) => params === void 0 ? { type: "clear", id } : invalidCommandParams("Invalid session.clear params")
  },
  abort: {
    method: "session.abort",
    requestSchema: AbortRequestSchema,
    resultSchema: EmptyResultSchema,
    toParams: () => void 0,
    fromParams: (params, id) => params === void 0 ? { type: "abort", id } : invalidCommandParams("Invalid session.abort params")
  },
  presence_hint: {
    method: "presence.hint",
    requestSchema: PresenceHintRequestSchema,
    resultSchema: PresenceHintResultSchema,
    toParams: (command) => {
      const hint = command;
      return { member: hint.member, state: hint.state, instanceId: hint.instanceId };
    },
    fromParams: (params, id) => isPresenceHintParams(params) ? { type: "presence_hint", ...params, id } : invalidCommandParams("Invalid presence.hint params")
  }
};
function commandDefinitionForMethod(method) {
  return Object.values(COMMAND_REGISTRY).find((definition) => definition.method === method);
}
function methodResultSchema(method) {
  return commandDefinitionForMethod(method)?.resultSchema;
}
function isMethodResult(method, value) {
  const schema = methodResultSchema(method);
  return schema ? value_exports2.Check(schema, value) : false;
}
function isMemberStatusResult(value) {
  return value_exports2.Check(MemberStatusResultSchema, value);
}
function isGuestJoinResult(value) {
  return value_exports2.Check(GuestJoinResultSchema, value);
}
function isMemberIdleWaitSubscribeResult(value) {
  return value_exports2.Check(MemberIdleWaitSubscribeResultSchema, value);
}
function isMemberIdleWaitNotification(value) {
  return value_exports2.Check(MemberIdleWaitNotificationSchema, value);
}
function isSubscribeResult(value) {
  return value_exports2.Check(SubscribeResultSchema, value);
}
function serializeRequest(request) {
  if (!isRpcRequest(request)) throw new Error("Invalid JSON-RPC request");
  return `${JSON.stringify(request)}
`;
}
function commandToRequest(command, id) {
  const definition = COMMAND_REGISTRY[command.type];
  const params = definition.toParams(command);
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    method: definition.method,
    ...params === void 0 ? {} : { params }
  };
}

// src/domain/session-id.ts
function isSafeSessionId(sessionId) {
  return !sessionId.includes("/") && !sessionId.includes("\\") && !sessionId.includes("..") && sessionId.length > 0;
}
function isSafeAlias(alias) {
  return !alias.includes("/") && !alias.includes("\\") && !alias.includes("..") && alias.length > 0;
}

// src/domain/crew-manifest.ts
import * as path2 from "node:path";
var CREW_MANIFEST_VERSION = 1;
var CREW_MANIFEST_V2 = 2;
var DEFAULT_CREW_MANIFEST_FILE = "crew.json";
var MAX_MEMBER_DESCRIPTION_BYTES = 256;
var CrewManifestError = class extends Error {
  code;
  manifestPath;
  validMemberNames;
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CrewManifestError";
    this.code = code;
    this.manifestPath = details.manifestPath;
    this.validMemberNames = details.validMemberNames;
  }
};
function invalid(message, code = "invalid-manifest") {
  throw new CrewManifestError(code, message);
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireText(value, field) {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    invalid(`${field} must be a non-empty string`, "invalid-member");
  }
  return value;
}
function requireDescription(value, field) {
  if (typeof value !== "string") {
    invalid(`${field} must be a non-empty string`, "invalid-member");
  }
  const description = value;
  if (description.trim().length === 0) invalid(`${field} must be a non-empty string`, "invalid-member");
  if (description !== description.trim())
    invalid(`${field} must not have leading or trailing whitespace`, "invalid-member");
  if (/[\r\n]/.test(description)) invalid(`${field} must be a single line`, "invalid-member");
  if (description.includes("\0")) invalid(`${field} must not contain NUL`, "invalid-member");
  try {
    encodeURIComponent(description);
  } catch {
    invalid(`${field} must be valid Unicode`, "invalid-member");
  }
  if (Buffer.byteLength(description, "utf8") > MAX_MEMBER_DESCRIPTION_BYTES) {
    invalid(`${field} must be at most ${MAX_MEMBER_DESCRIPTION_BYTES} UTF-8 bytes`, "invalid-member");
  }
  return description;
}
function resolveCrewMemberSocketPath(member, manifestPath) {
  if (typeof manifestPath !== "string" || manifestPath.trim().length === 0 || manifestPath.includes("\0")) {
    invalid("manifest path must be a non-empty path");
  }
  if (path2.isAbsolute(member.socket)) {
    invalid("member socket path must be relative to the crew manifest", "invalid-socket-path");
  }
  const socketsRoot = path2.resolve(path2.dirname(manifestPath), "sockets");
  const socketPath = path2.resolve(path2.dirname(manifestPath), member.socket);
  const relativePath = path2.relative(socketsRoot, socketPath);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${path2.sep}`) || path2.isAbsolute(relativePath)) {
    invalid("member socket path must remain under the crew sockets directory", "invalid-socket-path");
  }
  return socketPath;
}
function parseCrewManifest(input, manifestPath = DEFAULT_CREW_MANIFEST_FILE) {
  if (!isRecord(input)) invalid("manifest must be an object");
  if (input.version !== CREW_MANIFEST_VERSION && input.version !== CREW_MANIFEST_V2) {
    throw new CrewManifestError("invalid-version", `unsupported manifest version: ${String(input.version)}`);
  }
  const commonInstructionsFile = input.commonInstructionsFile;
  const validCommonInstructionsFile = typeof commonInstructionsFile === "string" ? commonInstructionsFile : void 0;
  if (commonInstructionsFile !== void 0) {
    if (input.version !== CREW_MANIFEST_V2) {
      throw new CrewManifestError(
        "invalid-version",
        "commonInstructionsFile requires manifest version 2; version 1 runtimes reject this extension"
      );
    }
    if (typeof commonInstructionsFile !== "string" || commonInstructionsFile.trim().length === 0 || commonInstructionsFile.includes("\0") || path2.isAbsolute(commonInstructionsFile)) {
      invalid("commonInstructionsFile must be a non-empty relative path", "invalid-common-instructions-file");
    }
    const instructionsRoot = path2.resolve(path2.dirname(manifestPath), "instructions");
    const resolved = path2.resolve(path2.dirname(manifestPath), validCommonInstructionsFile);
    const relative4 = path2.relative(instructionsRoot, resolved);
    if (!relative4 || relative4 === ".." || relative4.startsWith(`..${path2.sep}`) || path2.isAbsolute(relative4)) {
      invalid(
        "commonInstructionsFile must remain under the instructions directory",
        "invalid-common-instructions-file"
      );
    }
  }
  if (!Array.isArray(input.members) || input.members.length === 0) {
    throw new CrewManifestError("invalid-members", "members must be a non-empty array");
  }
  const rawPresence = input.presence;
  let presence = { notifications: true };
  if (rawPresence !== void 0) {
    if (!isRecord(rawPresence) || Object.keys(rawPresence).some((key) => key !== "notifications") || typeof rawPresence.notifications !== "boolean") {
      throw new CrewManifestError("invalid-manifest", "presence must contain only boolean notifications");
    }
    presence = { notifications: rawPresence.notifications };
  }
  const names = /* @__PURE__ */ new Set();
  const socketPaths = /* @__PURE__ */ new Map();
  const members = [];
  for (const [index, rawMember] of input.members.entries()) {
    if (!isRecord(rawMember)) invalid(`members[${index}] must be an object`, "invalid-member");
    const name = requireText(rawMember.name, `members[${index}].name`);
    const role = requireText(rawMember.role, `members[${index}].role`);
    const socket = requireText(rawMember.socket, `members[${index}].socket`);
    const instructions = rawMember.instructions;
    if (instructions !== void 0 && (typeof instructions !== "string" || instructions.trim().length === 0 || instructions.includes("\0"))) {
      invalid(`members[${index}].instructions must be a non-empty string without NUL`, "invalid-member");
    }
    const instructionsFile = rawMember.instructionsFile;
    if (instructionsFile !== void 0 && (typeof instructionsFile !== "string" || instructionsFile.trim().length === 0 || instructionsFile.includes("\0"))) {
      invalid(
        `members[${index}].instructionsFile must be a non-empty relative path`,
        "invalid-instructions-file"
      );
    }
    if (instructions !== void 0 && instructionsFile !== void 0) {
      invalid(`members[${index}] must define only one of instructions or instructionsFile`, "invalid-member");
    }
    const rawDescription = rawMember.description;
    const validDescription = rawDescription === void 0 ? void 0 : requireDescription(rawDescription, `members[${index}].description`);
    const validInstructions = typeof instructions === "string" ? instructions : void 0;
    const validInstructionsFile = typeof instructionsFile === "string" ? instructionsFile : void 0;
    if (validInstructionsFile !== void 0) {
      if (path2.isAbsolute(validInstructionsFile))
        invalid(`members[${index}].instructionsFile must be relative`, "invalid-instructions-file");
      const instructionsRoot = path2.resolve(path2.dirname(manifestPath), "instructions");
      const resolved = path2.resolve(path2.dirname(manifestPath), validInstructionsFile);
      const relative4 = path2.relative(instructionsRoot, resolved);
      if (!relative4 || relative4 === ".." || relative4.startsWith(`..${path2.sep}`) || path2.isAbsolute(relative4)) {
        invalid(
          `members[${index}].instructionsFile must remain under the instructions directory`,
          "invalid-instructions-file"
        );
      }
    }
    if (names.has(name)) {
      throw new CrewManifestError("duplicate-member-name", `duplicate member name: ${name}`);
    }
    names.add(name);
    const member = {
      name,
      role,
      socket,
      socketPath: resolveCrewMemberSocketPath({ socket }, manifestPath),
      ...validInstructions === void 0 ? {} : { instructions: validInstructions },
      ...validInstructionsFile === void 0 ? {} : { instructionsFile: validInstructionsFile },
      ...validDescription === void 0 ? {} : { description: validDescription }
    };
    const samePath = socketPaths.get(member.socketPath) ?? [];
    samePath.push(member);
    socketPaths.set(member.socketPath, samePath);
    members.push(member);
  }
  for (const [socketPath, matchingMembers] of socketPaths) {
    if (matchingMembers.length > 1) {
      throw new CrewManifestError("duplicate-socket-path", `duplicate socket path: ${socketPath}`);
    }
  }
  let crew;
  const rawCrew = input.crew;
  if (rawCrew !== void 0) {
    if (!isRecord(rawCrew)) invalid("crew must be an object", "invalid-crew-config");
    const crewKeys = Object.keys(rawCrew);
    if (crewKeys.some((key) => key !== "id" && key !== "displayName"))
      invalid("crew contains unknown fields", "invalid-crew-config");
    const id = rawCrew.id;
    if (typeof id !== "string" || id.trim().length === 0 || id !== id.trim() || id.includes("\0"))
      invalid("crew.id must be a non-empty trimmed string without NUL", "invalid-crew-identity");
    const displayName = rawCrew.displayName;
    if (typeof displayName !== "string" || displayName.trim().length === 0 || displayName !== displayName.trim() || displayName.includes("\0"))
      invalid("crew.displayName must be a non-empty trimmed string without NUL", "invalid-crew-display-name");
    crew = { id, displayName };
  }
  let guestAdmission;
  const rawGuestAdmission = input.guestAdmission;
  if (rawGuestAdmission !== void 0) {
    if (!crew) invalid("guestAdmission requires crew identity metadata", "invalid-guest-admission");
    if (!isRecord(rawGuestAdmission)) invalid("guestAdmission must be an object", "invalid-guest-admission");
    const admissionKeys = Object.keys(rawGuestAdmission);
    if (admissionKeys.length !== 1 || admissionKeys[0] !== "approvers")
      invalid("guestAdmission must contain only the approvers field", "invalid-guest-admission");
    const rawApprovers = rawGuestAdmission.approvers;
    if (!Array.isArray(rawApprovers) || rawApprovers.length === 0)
      invalid("guestAdmission.approvers must be a non-empty array", "invalid-guest-approvers");
    const approvers = rawApprovers;
    if (approvers.some(
      (approver) => typeof approver !== "string" || approver.trim().length === 0 || approver !== approver.trim() || approver.includes("\0")
    ))
      invalid("guestAdmission.approvers must contain exact trimmed member names", "invalid-guest-approver");
    const seenApprovers = /* @__PURE__ */ new Set();
    for (const approver of approvers) {
      if (seenApprovers.has(approver))
        throw new CrewManifestError("duplicate-guest-approver", `duplicate Guest approver: ${approver}`);
      seenApprovers.add(approver);
      if (!names.has(approver))
        throw new CrewManifestError(
          "invalid-guest-approver",
          `Guest approver is not a configured member: ${approver}`
        );
    }
    const approverSet = new Set(approvers);
    guestAdmission = {
      approvers: members.filter((member) => approverSet.has(member.name)).map((member) => member.name)
    };
  }
  let intake;
  const rawIntake = input.intake;
  if (rawIntake !== void 0) {
    if (!isRecord(rawIntake)) invalid("intake must be an object", "invalid-intake-config");
    const keys = Object.keys(rawIntake);
    if (keys.length !== 1 || keys[0] !== "contact")
      invalid("intake must contain only the contact field", "invalid-intake-config");
    const contact = rawIntake.contact;
    if (typeof contact !== "string" || contact.trim().length === 0 || contact !== contact.trim() || contact.includes("\0"))
      invalid("intake.contact must be a non-empty trimmed member name", "invalid-intake-config");
    if (!names.has(contact)) {
      const validMemberNames = members.map((member) => member.name);
      throw new CrewManifestError(
        "invalid-intake-contact",
        `Crew configuration invalid: manifest path ${manifestPath}; intake.contact rejected value '${contact}'; valid exact member names in manifest order: [${validMemberNames.join(", ")}]. Fixes: change intake.contact to one of those exact names, or add a member named '${contact}'; remove intake to disable external intake.`,
        { manifestPath, validMemberNames }
      );
    }
    intake = { contact };
  }
  return {
    version: input.version,
    ...validCommonInstructionsFile === void 0 ? {} : { commonInstructionsFile: validCommonInstructionsFile },
    members,
    presence,
    ...intake === void 0 ? {} : { intake },
    ...crew === void 0 ? {} : { crew },
    ...guestAdmission === void 0 ? {} : { guestAdmission }
  };
}

// src/domain/crew-intake.ts
var CrewIntakeError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "CrewIntakeError";
    this.code = code;
  }
};
function resolveIntakeContact(manifest) {
  const contact = manifest.intake?.contact;
  if (contact === void 0) return { enabled: false, reason: "external-intake-disabled" };
  const member = manifest.members.find((candidate) => candidate.name === contact);
  if (!member) throw new CrewIntakeError("unknown-contact", `intake contact is not a configured member: ${contact}`);
  return { enabled: true, contact: member };
}
function createExternalIntakePayload(input) {
  const payload = {
    content: input.content,
    origin: { kind: "external", label: input.label },
    kind: "external intake",
    ...input.instructions === void 0 ? {} : { instructions: [...input.instructions] }
  };
  if (!isMessagePayload(payload)) throw new CrewIntakeError("invalid-payload", "invalid external intake message");
  return payload;
}

// src/domain/presence.ts
var DEFAULT_CONFIG = Object.freeze({ notifications: true });

// src/domain/crew-init.ts
var CREW_INIT_PROJECT_DIR = ".pi/bebop";
var CREW_INIT_MANIFEST_REL = `${CREW_INIT_PROJECT_DIR}/crew.json`;
var CREW_INIT_GITIGNORE_REL = `${CREW_INIT_PROJECT_DIR}/.gitignore`;
var CREW_INIT_INSTRUCTIONS_REL = `${CREW_INIT_PROJECT_DIR}/instructions`;
var CREW_INIT_SOCKETS_REL = `${CREW_INIT_PROJECT_DIR}/sockets/`;
var NEWLINE = "\n";
function crewInitManagedPaths() {
  return [
    CREW_INIT_PROJECT_DIR + "/",
    CREW_INIT_GITIGNORE_REL,
    CREW_INIT_MANIFEST_REL,
    `${CREW_INIT_INSTRUCTIONS_REL}/common.md`,
    `${CREW_INIT_INSTRUCTIONS_REL}/lead.md`,
    `${CREW_INIT_INSTRUCTIONS_REL}/product.md`,
    `${CREW_INIT_INSTRUCTIONS_REL}/developer.md`,
    `${CREW_INIT_INSTRUCTIONS_REL}/quality.md`,
    CREW_INIT_SOCKETS_REL
  ];
}
function crewInitGitignore() {
  return [
    "# Runtime-owned member endpoints and durable inbox (created by Bebop).",
    "",
    "sockets/",
    "inbox/",
    ""
  ].join(NEWLINE);
}
function crewInitCrewJson() {
  return [
    "{",
    '  "version": 2,',
    '  "commonInstructionsFile": "instructions/common.md",',
    '  "presence": { "notifications": true },',
    '  "intake": { "contact": "product" },',
    '  "members": [',
    "    {",
    '      "name": "lead",',
    '      "role": "lead",',
    '      "description": "Coordinates ownership, verification, and integration",',
    '      "socket": "sockets/lead.sock",',
    '      "instructionsFile": "instructions/lead.md"',
    "    },",
    "    {",
    '      "name": "product",',
    '      "role": "product",',
    '      "description": "Shapes problems, acceptance criteria, and shared language",',
    '      "socket": "sockets/product.sock",',
    '      "instructionsFile": "instructions/product.md"',
    "    },",
    "    {",
    '      "name": "developer",',
    '      "role": "developer",',
    '      "description": "Builds domain and application changes",',
    '      "socket": "sockets/developer.sock",',
    '      "instructionsFile": "instructions/developer.md"',
    "    },",
    "    {",
    '      "name": "quality",',
    '      "role": "quality",',
    '      "description": "Verifies acceptance and failure paths",',
    '      "socket": "sockets/quality.sock",',
    '      "instructionsFile": "instructions/quality.md"',
    "    }",
    "  ]",
    "}",
    ""
  ].join(NEWLINE);
}
function crewInitCommonInstructions() {
  return [
    "# Common crew instructions",
    "",
    "These instructions apply to every crew member.",
    "",
    "- Keep communication explicit, bounded, and evidence-based.",
    "- Use Follow-up for information, Request for one correlated answer, and Inbox when durable delivery is required.",
    "- Report blockers and uncertainty instead of claiming completion without verification.",
    ""
  ].join(NEWLINE);
}
function crewInitInstructions(role) {
  switch (role) {
    case "lead":
      return [
        "# Lead role instructions",
        "",
        "## Mission",
        "Coordinate exact ownership, timing, independent verification, and integration evidence without turning Bebop into a task, Git, review, or CI system.",
        "",
        "## Expected inputs",
        "- A shaped problem with acceptance criteria, constraints, and non-goals from product.",
        "- Explicit blocker or completion evidence from a named developer.",
        "- Independent findings and verdict from a named quality member.",
        "",
        "## Expected outputs",
        "- A bounded assignment naming owner, outcome, acceptance reference, and expected evidence.",
        "- An explicit verification request to a different named member.",
        "- An integration decision grounded in developer and quality evidence.",
        "",
        "## Escalation",
        "1. Send follow-up for normal new information.",
        "2. Use redirect_member only when the target should change its next model step.",
        "3. Use interrupt_member only to abort and recover work that is stuck, harmful, or based on invalid assumptions.",
        "",
        "## Definition of done",
        "- One exact implementation owner and one independent verifier were identified.",
        "- Acceptance and failure-path evidence were reported through normal crew messages.",
        "- Integration decision and remaining risk are explicit.",
        ""
      ].join(NEWLINE);
    case "product":
      return [
        "# Product role instructions",
        "",
        "## Mission",
        "Turn incoming needs into clear problems and acceptance boundaries, then hand an actionable outcome to lead without prescribing implementation.",
        "",
        "## Expected inputs",
        "- One-way unverified external messages received through Crew Intake when this member is configured as exact crew contact.",
        "- Clarification or feasibility feedback from lead, developer, or quality.",
        "- Existing product language, constraints, and external planning artifacts.",
        "",
        "## Expected outputs",
        "- Problem-first statement and desired outcome.",
        "- Testable acceptance criteria plus non-goals and constraints.",
        "- A bounded handoff to lead.",
        "",
        "## Escalation",
        "- Send shaped work with send_follow_up; use send_to_inbox when durable delivery matters.",
        "",
        "## Definition of done",
        "- Problem, outcome, acceptance criteria, and constraints are explicit.",
        "- Handoff to lead is bounded; external stakeholder state stays in native systems.",
        ""
      ].join(NEWLINE);
    case "developer":
      return [
        "# Developer role instructions",
        "",
        "## Mission",
        "Implement one explicitly owned change using host-project conventions and deterministic feedback, then report evidence and blockers without claiming workflow state Bebop does not own.",
        "",
        "## Expected inputs",
        "- A named assignment with problem/outcome, acceptance reference, constraints, and expected evidence.",
        "- Follow-up or Redirect guidance from coordinating members.",
        "- Independent quality findings after handoff.",
        "",
        "## Expected outputs",
        "- A small readable change within assigned ownership.",
        "- Deterministic tests for acceptance and failure paths.",
        "- A bounded report: paths/change, checks, coverage/risk, blockers, and known limitations.",
        "- An explicit quality handoff; no self-approval. Ask an independent member to verify before closing.",
        "",
        "## Escalation",
        "- Use send_follow_up for clarification, evidence, and ordinary blockers.",
        "- Never redirect or interrupt another member merely to accelerate a response.",
        "- Escalate external dependency, unsafe assumption, overlapping ownership, or unverifiable acceptance to lead.",
        "",
        "## Definition of done",
        "- Acceptance and unhappy paths have evidence; an independent member verified the change.",
        "- Candidate is formatted and relevant checks pass or exact failures are reported.",
        "- Independent quality member received exact review scope.",
        ""
      ].join(NEWLINE);
    case "quality":
      return [
        "# Quality role instructions",
        "",
        "## Mission",
        "Independently verify acceptance, failure paths, lifecycle behavior, and regression risk; report evidence and verdict without silently becoming implementer.",
        "",
        "## Expected inputs",
        "- Exact candidate paths or commit, acceptance reference, expected behavior, checks already run, and known risks from developer or lead.",
        "- Clarification messages and adopted crew-wide constraints.",
        "- Host-project test, coverage, watcher, package, and review tooling.",
        "",
        "## Expected outputs",
        "- PASS, FAIL, or BLOCKED verdict tied to acceptance criteria.",
        "- Reproduction/evidence for each finding with severity and impacted path.",
        "- Checks, coverage/risk evidence, and remaining uncertainty.",
        "",
        "## Escalation",
        "- Send normal findings with send_follow_up to an exact developer name and verdict to lead.",
        "- Use redirect_member only when active direction should change; use interrupt_member only when continuing is actively harmful.",
        "",
        "## Definition of done",
        "- Happy and unhappy paths, privacy/security boundaries, and nearby regressions were verified proportionate to risk.",
        "- Verdict and evidence were reported.",
        ""
      ].join(NEWLINE);
  }
}
function crewInitTemplateBytes() {
  return {
    [CREW_INIT_GITIGNORE_REL]: crewInitGitignore(),
    [CREW_INIT_MANIFEST_REL]: crewInitCrewJson(),
    [`${CREW_INIT_INSTRUCTIONS_REL}/common.md`]: crewInitCommonInstructions(),
    [`${CREW_INIT_INSTRUCTIONS_REL}/lead.md`]: crewInitInstructions("lead"),
    [`${CREW_INIT_INSTRUCTIONS_REL}/product.md`]: crewInitInstructions("product"),
    [`${CREW_INIT_INSTRUCTIONS_REL}/developer.md`]: crewInitInstructions("developer"),
    [`${CREW_INIT_INSTRUCTIONS_REL}/quality.md`]: crewInitInstructions("quality")
  };
}
function classifyCrewInitTarget(snapshot) {
  const rootKind = snapshot.readRootKind();
  if (rootKind !== "directory") {
    return {
      kind: "conflict",
      code: "project-root-not-directory",
      path: ".",
      nextStep: "Choose a directory project root or remove the conflicting file before running crew init"
    };
  }
  const templates = crewInitTemplateBytes();
  let missing = 0;
  for (const relative4 of crewInitManagedPaths()) {
    if (relative4.endsWith("/")) {
      const entry2 = snapshot.readPath(relative4);
      if (entry2.kind === "missing") {
        missing += 1;
        continue;
      }
      if (entry2.kind === "symlink")
        return conflict(relative4, "symlinked-managed-path", "Remove the symlink or choose another project");
      if (entry2.kind !== "directory")
        return conflict(relative4, "managed-path-shape", "Remove the file or choose another project");
      continue;
    }
    const expected = templates[relative4];
    const entry = snapshot.readPath(relative4);
    if (entry.kind === "missing") {
      missing += 1;
      continue;
    }
    if (entry.kind === "symlink")
      return conflict(relative4, "symlinked-managed-path", "Remove the symlink or choose another project");
    if (entry.kind !== "file")
      return conflict(relative4, "managed-path-shape", "Remove the directory or choose another project");
    if (entry.bytes !== expected)
      return conflict(
        relative4,
        "managed-file-differs",
        `Review ${relative4}; edit it or move it aside, then rerun crew init`
      );
  }
  if (missing === crewInitManagedPaths().length) return { kind: "created" };
  if (missing === 0) return { kind: "unchanged" };
  return {
    kind: "conflict",
    code: "partial-layout",
    path: ".pi/bebop",
    nextStep: "Some managed files already exist; no partial update is performed. Review .pi/bebop or choose another project, then rerun crew init"
  };
}
function conflict(path14, code, nextStep) {
  return { kind: "conflict", code, path: path14, nextStep };
}
function redactCrewInitPath(path14) {
  if (path14.includes("secret") || path14.includes("credential") || path14.includes("token")) return "<redacted>";
  const normalized = path14.split(/[\\/]+/).filter(Boolean);
  if (normalized.length <= 3) return path14;
  return normalized.slice(-3).join("/");
}
function crewInitHelp() {
  return [
    "pi-bebop crew init [--project <directory>] [--format toon|json|text]",
    "",
    "Scaffold a canonical .pi/bebop software crew in a project. Non-interactive and idempotent;",
    "never overwrites existing content and never requires --force.",
    "",
    "Options:",
    "  --project <directory>   Target project root (default: current working directory)",
    "  --format <format>       Output format: toon (default), json, or text",
    "  --help                  Show this help",
    "",
    "Files created (deterministic, versioned):",
    "  .pi/bebop/crew.json",
    "  .pi/bebop/.gitignore",
    "  .pi/bebop/instructions/{common,lead,product,developer,quality}.md",
    "  .pi/bebop/sockets/",
    "",
    "Exit codes:",
    "  0  created or byte-identical no-op",
    "  1  filesystem/conflict/operational failure",
    "  2  usage error",
    "",
    "Examples:",
    "  pi-bebop crew init",
    "  pi-bebop crew init --project /path/to/project",
    "  pi-bebop crew init --format json",
    "",
    "Review crew.json contact/names/common and role instructions before starting member processes.",
    ""
  ].join(NEWLINE);
}

// src/domain/crew-role.ts
function projectCrewRoles(manifest) {
  const seen = /* @__PURE__ */ new Set();
  const roles = [];
  for (const member of manifest.members) {
    if (seen.has(member.role)) continue;
    seen.add(member.role);
    roles.push(member.role);
  }
  return { roles, roleCount: roles.length, memberCount: manifest.members.length };
}

// src/domain/member-inbox.ts
var INBOX_VERSION = 1;
var MAX_INBOX_ITEMS = 64;
var MAX_INBOX_ID_BYTES = 128;
var MAX_INBOX_TARGET_FIELD_BYTES = 256;
var NonEmptyText2 = Type.String({ minLength: 1 });
var InboxTargetSchema = Type.Object(
  { name: NonEmptyText2, socketPath: NonEmptyText2 },
  { additionalProperties: false }
);
var InboxItemSchema = Type.Object(
  {
    version: Type.Literal(INBOX_VERSION),
    id: NonEmptyText2,
    target: InboxTargetSchema,
    payload: MessagePayloadSchema,
    enqueuedAt: Type.Number(),
    sequence: Type.Integer({ minimum: 0 })
  },
  { additionalProperties: false }
);
var MemberInboxSchema = Type.Object(
  {
    version: Type.Literal(INBOX_VERSION),
    target: InboxTargetSchema,
    offering: Type.Union([Type.Literal("active"), Type.Literal("paused")]),
    items: Type.Array(InboxItemSchema, { maxItems: MAX_INBOX_ITEMS })
  },
  { additionalProperties: false }
);
var utf8Bytes4 = (value) => Buffer.byteLength(value, "utf8");
var invalidTextField = (value, limit) => value.trim().length === 0 || value !== value.trim() || value.includes("\0") || utf8Bytes4(value) > limit;
function fnv1a(text) {
  let hash = 2166136261;
  for (const byte of Buffer.from(text, "utf8")) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16);
}
function createInboxItemId(target, sequence, payload) {
  return `inbox-${sequence.toString(16)}-${fnv1a(JSON.stringify({ target, sequence, payload }))}`;
}
function isInboxTarget(value) {
  if (!value_exports2.Check(InboxTargetSchema, value)) return false;
  const target = value;
  return ![target.name, target.socketPath].some((field) => invalidTextField(field, MAX_INBOX_TARGET_FIELD_BYTES));
}
function isInboxItem(value) {
  if (!value_exports2.Check(InboxItemSchema, value)) return false;
  const item = value;
  if (invalidTextField(item.id, MAX_INBOX_ID_BYTES)) return false;
  if (!isInboxTarget(item.target)) return false;
  if (!Number.isFinite(item.enqueuedAt) || item.enqueuedAt < 0) return false;
  return isMessagePayload(item.payload);
}
function nextInboxSequence(items, floor = 0) {
  let next = floor;
  for (const item of items) if (item.sequence + 1 > next) next = item.sequence + 1;
  return next;
}

// src/domain/guest-registry.ts
var GUEST_REGISTRY_VERSION = 1;
var GUEST_REGISTRY_STATUSES = ["pending", "approved", "denied", "revoked"];
var GUEST_REGISTRY_DIGEST_LENGTH = 64;
var GuestRegistryText = (maxLength) => Type.String({ minLength: 1, maxLength, pattern: "^[^\\u0000\\r\\n]+$" });
var GuestRegistryEntrySchema = Type.Object(
  {
    status: Type.Union(GUEST_REGISTRY_STATUSES.map((status) => Type.Literal(status))),
    crew: CrewSelectorSchema,
    guestIdentity: Type.String({ minLength: 1 }),
    guestName: GuestRegistryText(MAX_GUEST_NAME_BYTES),
    callbackEndpoint: GuestRegistryText(512),
    capabilityDigest: Type.String({
      minLength: GUEST_REGISTRY_DIGEST_LENGTH,
      maxLength: GUEST_REGISTRY_DIGEST_LENGTH
    }),
    approver: Type.Optional(GuestRegistryText(MAX_GUEST_IDENTITY_BYTES)),
    order: Type.Integer({ minimum: 1 }),
    revision: Type.Integer({ minimum: 1 })
  },
  { additionalProperties: false }
);
var GuestRegistryFileSchema = Type.Object(
  {
    version: Type.Literal(GUEST_REGISTRY_VERSION),
    crew: CrewSelectorSchema,
    revision: Type.Integer({ minimum: 1 }),
    entries: Type.Array(GuestRegistryEntrySchema, { maxItems: 256 })
  },
  { additionalProperties: false }
);

// src/cli/commands/send.ts
function collect(value, previous) {
  return previous.concat([value]);
}
function buildSendCommand() {
  return new Command("send").description("Deliver a message to a Pi session (--socket) or durable Crew Intake (--crew)").option("--socket <path>", "Direct delivery socket path").option("--crew <manifest>", "Crew manifest path (durable intake, caller consent)").option("--message <text>", "Message text").option("--stdin", "Read message from stdin").option("--instruction <value>", "Instruction (repeatable, ordered)", collect, []).option("--from <label>", "Claimed external origin label").option("--mode <mode>", "steer or follow_up", "steer").option("--wait <wait>", "turn_end or accepted", "turn_end").option("--timeout <duration>", "Duration such as 500ms, 30s, or 5m", "5m").option("--format <format>", "toon, json, or text", "toon").option("--full", "Full response without truncation").showHelpAfterError(false).helpOption(false);
}
function readSendLeafOptions(parsed) {
  const opts = parsed.opts();
  return {
    ...opts.socket === void 0 ? {} : { socketPath: opts.socket },
    ...opts.crew === void 0 ? {} : { crewPath: opts.crew },
    ...opts.message === void 0 ? {} : { message: opts.message },
    instructions: opts.instruction ?? [],
    ...opts.from === void 0 ? {} : { origin: { kind: "external", label: opts.from } },
    stdin: opts.stdin ?? false,
    mode: opts.mode ?? "steer",
    wait: opts.wait ?? "turn_end",
    timeout: opts.timeout ?? "5m",
    format: opts.format ?? "toon",
    full: opts.full ?? false
  };
}
function sendHelp(program2 = buildSendCommand()) {
  const lines = [
    "pi-bebop send (--socket <path> | --crew <manifest>) (--message <text> | --stdin) [options]",
    "",
    program2.description(),
    "",
    "Options:"
  ];
  for (const option of program2.options) {
    const flags = option.flags;
    const description = option.description;
    const hasDefault = option.defaultValue !== void 0;
    const defaultText = hasDefault ? ` (default: ${String(option.defaultValue)})` : "";
    lines.push(`  ${flags}   ${description}${defaultText}`);
  }
  lines.push(
    "",
    `Repeated --instruction values are collected in order (maximum ${MAX_MESSAGE_INSTRUCTIONS}).`,
    "",
    "Examples:",
    '  pi-bebop send --socket .pi/bebop/sockets/dev.sock --message "hello"',
    '  pi-bebop send --crew .pi/bebop/crew.json --message "persisted intake" --from CI',
    "  pi-bebop send --socket .pi/bebop/sockets/dev.sock --stdin --mode follow_up",
    ""
  );
  return lines.join("\n");
}

// src/cli/parser.ts
import path3 from "node:path";

// src/cli/arguments.ts
var UsageError = class extends Error {
  code = "usage";
};

// src/cli/parser.ts
var VALID_FLAGS = "--project <directory>, --format toon|json|text, --help";
var VALUE_FLAGS = /* @__PURE__ */ new Set(["--project", "--format"]);
var FORMAT_ALTERNATIVES = "toon, json, text";
function parseCrewInitCommand(args, cwd = process.cwd()) {
  const tokens = [];
  let help = false;
  const seen = /* @__PURE__ */ new Set();
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    const equals = raw.indexOf("=");
    const flag = equals > 0 ? raw.slice(0, equals) : raw;
    if (flag === "--help") {
      if (help) throw new UsageError("Duplicate flag: --help");
      help = true;
      continue;
    }
    if (VALUE_FLAGS.has(flag)) {
      if (seen.has(flag)) throw new UsageError(`Duplicate flag: ${flag}`);
      seen.add(flag);
      if (equals > 0) {
        tokens.push(raw);
        continue;
      }
      if (args[index + 1] === "--" && args[index + 2] !== void 0) {
        tokens.push(`${flag}=${args[index + 2]}`);
        index += 2;
        continue;
      }
      tokens.push(raw);
      continue;
    }
    tokens.push(raw);
  }
  const program2 = buildCrewInitCommand().exitOverride().configureOutput({ writeOut: () => {
  }, writeErr: () => {
  }, outputError: () => {
  } });
  let opts;
  try {
    program2.parse(tokens, { from: "user" });
    opts = program2.opts();
  } catch (error) {
    if (error instanceof CommanderError) throw mapCommanderError(error);
    throw error;
  }
  const format = opts.format ?? "toon";
  if (!isCliFormat(format))
    throw new UsageError(`Invalid --format '${format}'; valid alternatives: ${FORMAT_ALTERNATIVES}`);
  const project = opts.project;
  return {
    command: "crew-init",
    ...project === void 0 ? {} : { project: path3.resolve(cwd, project) },
    format,
    ...help ? { help: true } : {}
  };
}
function mapCommanderError(error) {
  if (error.code === "commander.optionMissingArgument") {
    const match = /--[a-z-]+/.exec(error.message);
    const flag = match?.[0] ?? "--format";
    return new UsageError(`Missing value for ${flag}`);
  }
  if (error.code === "commander.unknownOption") {
    const match = /unknown option '(--?[^']+)'/.exec(error.message);
    const flag = match?.[1] ?? "";
    return new UsageError(`Unknown flag '${flag}'; valid flags: ${VALID_FLAGS}`);
  }
  if (error.code === "commander.excessArguments") {
    const match = /got \d+: ([^\n.]+)/.exec(error.message);
    const positional = match?.[1]?.split(",")[0]?.trim() ?? "";
    return new UsageError(`Unknown flag '${positional}'; valid flags: ${VALID_FLAGS}`);
  }
  return new UsageError(error.message);
}
var SEND_VALID_FLAGS = "--socket, --message, --stdin, --instruction, --from, --mode, --wait, --timeout, --format, --full";
var SEND_SINGLE_VALUE_FLAGS = /* @__PURE__ */ new Set([
  "--socket",
  "--crew",
  "--message",
  "--mode",
  "--wait",
  "--timeout",
  "--format",
  "--from"
]);
var SEND_BOOLEAN_FLAGS = /* @__PURE__ */ new Set(["--stdin", "--full"]);
function parsePositiveDurationMs(value) {
  const match = /^(\d+)(ms|s|m)$/.exec(value);
  if (!match || Number(match[1]) < 1)
    throw new UsageError(`Invalid --timeout '${value}'; use a positive duration such as 500ms, 30s, or 5m`);
  const multiplier = match[2] === "m" ? 6e4 : match[2] === "s" ? 1e3 : 1;
  const result = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(result)) throw new UsageError(`Invalid --timeout '${value}'; duration is too large`);
  return result;
}
function validateOriginLabel(label3) {
  if (label3.trim().length === 0 || label3 !== label3.trim() || label3.includes("\0") || Buffer.byteLength(label3, "utf8") > MAX_MESSAGE_ORIGIN_FIELD_BYTES)
    throw new UsageError(
      "--from must be trimmed, non-empty, within the UTF-8 byte limit, and must not contain NUL"
    );
}
function validateSendSemantics(leaf, seen, cwd) {
  const hasSocket = leaf.socketPath !== void 0;
  const hasCrew = leaf.crewPath !== void 0;
  if (hasSocket === hasCrew)
    throw new UsageError(
      "Choose exactly one target: --socket <path> for direct delivery or --crew <manifest> for durable intake"
    );
  if (hasCrew) {
    for (const incompatible of ["--mode", "--wait", "--timeout"]) {
      if (seen.has(incompatible))
        throw new UsageError(
          `${incompatible} is not supported with --crew; external intake is one-way persisted delivery`
        );
    }
  }
  if (leaf.origin !== void 0) validateOriginLabel(leaf.origin.label);
  const hasMessage = leaf.message !== void 0;
  if (hasMessage && leaf.stdin)
    throw new UsageError("Choose exactly one message source: --message <text> or --stdin");
  if (!hasMessage && !leaf.stdin) throw new UsageError("Missing message source; use --message <text> or --stdin");
  if (hasMessage && leaf.message.length === 0) throw new UsageError("--message must not be empty");
  if (leaf.mode !== "steer" && leaf.mode !== "follow_up")
    throw new UsageError(`Invalid --mode '${leaf.mode}'; valid alternatives: steer, follow_up`);
  if (leaf.wait !== "turn_end" && leaf.wait !== "accepted")
    throw new UsageError(`Invalid --wait '${leaf.wait}'; valid alternatives: turn_end, accepted`);
  if (!isCliFormat(leaf.format))
    throw new UsageError(`Invalid --format '${leaf.format}'; valid alternatives: toon, json, text`);
  return {
    command: "send",
    ...hasSocket ? { socketPath: path3.resolve(cwd, leaf.socketPath) } : {},
    ...hasCrew ? { crewPath: path3.resolve(cwd, leaf.crewPath) } : {},
    ...hasMessage ? { message: leaf.message } : {},
    instructions: leaf.instructions,
    ...leaf.origin === void 0 ? {} : { origin: leaf.origin },
    stdin: leaf.stdin,
    mode: leaf.mode,
    wait: leaf.wait,
    timeoutMs: parsePositiveDurationMs(leaf.timeout),
    format: leaf.format,
    full: leaf.full
  };
}
function parseSendCommand(args, cwd = process.cwd()) {
  const tokens = [];
  let help = false;
  const seen = /* @__PURE__ */ new Set();
  const instructionValues = [];
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    const equals = raw.indexOf("=");
    const flag = equals > 0 ? raw.slice(0, equals) : raw;
    if (flag === "--help") {
      if (help) throw new UsageError("Duplicate flag: --help");
      help = true;
      continue;
    }
    if (flag === "--instruction") {
      let value;
      let escaped = false;
      if (equals > 0) value = raw.slice(equals + 1);
      else if (args[index + 1] === "--" && args[index + 2] !== void 0) {
        value = args[index + 2];
        escaped = true;
        index += 2;
      } else value = args[++index];
      if (value === void 0 || equals < 0 && !escaped && value.startsWith("--"))
        throw new UsageError("Missing value for --instruction");
      instructionValues.push(value);
      if (instructionValues.length > MAX_MESSAGE_INSTRUCTIONS)
        throw new UsageError(`Too many --instruction values; maximum is ${MAX_MESSAGE_INSTRUCTIONS}`);
      continue;
    }
    if (SEND_SINGLE_VALUE_FLAGS.has(flag) || SEND_BOOLEAN_FLAGS.has(flag)) {
      if (seen.has(flag)) throw new UsageError(`Duplicate flag: ${flag}`);
      seen.add(flag);
      if (SEND_BOOLEAN_FLAGS.has(flag) || equals > 0) {
        tokens.push(raw);
        continue;
      }
      if (args[index + 1] === "--" && args[index + 2] !== void 0) {
        tokens.push(`${flag}=${args[index + 2]}`);
        index += 2;
        continue;
      }
      tokens.push(raw);
      continue;
    }
    tokens.push(raw);
  }
  const program2 = buildSendCommand().exitOverride().configureOutput({
    writeOut: () => {
    },
    writeErr: () => {
    },
    outputError: () => {
    }
  });
  let leaf;
  try {
    program2.parse(tokens, { from: "user" });
    leaf = readSendLeafOptions(program2);
  } catch (error) {
    if (error instanceof CommanderError) throw mapSendCommanderError(error);
    throw error;
  }
  if (instructionValues.length > 0) leaf = { ...leaf, instructions: instructionValues };
  if (help) {
    if (leaf.origin !== void 0) validateOriginLabel(leaf.origin.label);
    if (!isCliFormat(leaf.format))
      throw new UsageError(`Invalid --format '${leaf.format}'; valid alternatives: toon, json, text`);
    return {
      command: "send",
      ...leaf.socketPath === void 0 ? {} : { socketPath: path3.resolve(cwd, leaf.socketPath) },
      ...leaf.crewPath === void 0 ? {} : { crewPath: path3.resolve(cwd, leaf.crewPath) },
      ...leaf.message === void 0 ? {} : { message: leaf.message },
      instructions: leaf.instructions,
      ...leaf.origin === void 0 ? {} : { origin: leaf.origin },
      stdin: leaf.stdin,
      mode: leaf.mode,
      wait: leaf.wait,
      timeoutMs: parsePositiveDurationMs(leaf.timeout),
      format: leaf.format,
      full: leaf.full,
      help: true
    };
  }
  const options = validateSendSemantics(leaf, seen, cwd);
  return options;
}
function mapSendCommanderError(error) {
  if (error.code === "commander.optionMissingArgument") {
    const match = /--[a-z-]+/.exec(error.message);
    const flag = match?.[0] ?? "--message";
    return new UsageError(`Missing value for ${flag}`);
  }
  if (error.code === "commander.unknownOption") {
    const match = /unknown option '(--?[^']+)'/.exec(error.message);
    const flag = match?.[1] ?? "";
    return new UsageError(`Unknown flag '${flag}'; valid flags: ${SEND_VALID_FLAGS}`);
  }
  if (error.code === "commander.excessArguments") {
    const match = /got \d+: ([^\n.]+)/.exec(error.message);
    const positional = match?.[1]?.split(",")[0]?.trim() ?? "";
    return new UsageError(`Unknown flag '${positional}'; valid flags: ${SEND_VALID_FLAGS}`);
  }
  return new UsageError(error.message);
}

// src/cli/commands/home-handler.ts
import { promises as fs2 } from "node:fs";
import path4 from "node:path";
function homeExecutable(env, argv1) {
  if (!argv1) return "pi-bebop";
  return argv1.replace(env.HOME ?? "~", "~");
}
function redactHome(env, value) {
  const home = env.HOME;
  if (!home) return value;
  return value.replace(home, "~");
}
async function runHomeCommand(cwd, commands, env = process.env, argv1 = process.argv[1]) {
  const project = cwd;
  const scaffoldAbs = path4.join(project, ".pi/bebop/crew.json");
  let scaffold = "missing";
  try {
    await fs2.stat(scaffoldAbs);
    scaffold = "present";
  } catch {
    scaffold = "missing";
  }
  return {
    kind: "result",
    result: {
      ok: true,
      target: "",
      status: "home",
      data: {
        executable: homeExecutable(env, argv1),
        purpose: "Pi Bebop crew coordination CLI",
        project: redactHome(env, project),
        scaffold,
        commands: [...commands],
        ...scaffold === "missing" ? { next: "pi-bebop crew init" } : { next: "pi --crew-role lead" }
      }
    },
    format: "toon",
    full: false
  };
}

// src/application/crew-init-flow.ts
function errnoCode(error) {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
}
function createCrewInitFlow(adapter) {
  const classify = async (projectAbs) => {
    const rootKind = await adapter.readKind(projectAbs);
    const snapshot = {
      readRootKind: () => rootKind,
      readPath: async (relative4) => {
        const abs = `${projectAbs}/${relative4}`;
        const kind = await adapter.readKind(abs);
        if (kind === "missing") return { kind: "missing" };
        if (kind === "symlink") return { kind: "symlink" };
        if (kind !== "file") return { kind: "directory" };
        const bytes = await adapter.readFile(abs);
        return { kind: "file", bytes };
      }
    };
    const reads = crewInitManagedPaths().map((relative4) => snapshot.readPath(relative4));
    const entries = await Promise.all(reads);
    const entryByPath = /* @__PURE__ */ new Map();
    crewInitManagedPaths().forEach((relative4, index) => entryByPath.set(relative4, entries[index]));
    const syncSnapshot = {
      readRootKind: () => rootKind,
      readPath: (relative4) => entryByPath.get(relative4) ?? { kind: "missing" }
    };
    return classifyCrewInitTarget(syncSnapshot);
  };
  const run = async (projectAbs) => {
    const verdict = await classify(projectAbs);
    if (verdict.kind === "unchanged") {
      return {
        ok: true,
        status: "unchanged",
        project: projectAbs,
        manifestPath: CREW_INIT_MANIFEST_REL,
        createdPaths: [],
        verifiedPaths: crewInitManagedPaths().filter((p) => !p.endsWith("/")),
        nextCommands: [`pi --crew-role lead`, `pi --crew-role developer`]
      };
    }
    if (verdict.kind === "conflict") {
      return {
        ok: false,
        error: {
          code: verdict.code,
          message: `Crew init conflict at ${redactCrewInitPath(verdict.path)}: ${verdict.nextStep}`
        }
      };
    }
    let staging;
    try {
      staging = await adapter.createStaging(projectAbs);
      const templates = crewInitTemplateBytes();
      for (const relative4 of crewInitManagedPaths()) {
        if (relative4.endsWith("/")) continue;
        const stagingRelative = relative4.replace(`${CREW_INIT_PROJECT_DIR}/`, "");
        await adapter.writeFile(`${staging}/${stagingRelative}`, templates[relative4]);
      }
      await adapter.mkdir(`${staging}/${CREW_INIT_SOCKETS_REL.replace(`${CREW_INIT_PROJECT_DIR}/`, "")}`);
      const targetAbs = `${projectAbs}/${CREW_INIT_PROJECT_DIR}`;
      try {
        await adapter.publishStaging(staging, targetAbs);
      } catch (error) {
        const code = errnoCode(error);
        if (code === "ENOTEMPTY" || code === "EEXIST") {
          const after = await classify(projectAbs);
          if (after.kind === "unchanged") {
            return {
              ok: true,
              status: "unchanged",
              project: projectAbs,
              manifestPath: CREW_INIT_MANIFEST_REL,
              createdPaths: [],
              verifiedPaths: crewInitManagedPaths().filter((p) => !p.endsWith("/")),
              nextCommands: [`pi --crew-role lead`, `pi --crew-role developer`]
            };
          }
          if (after.kind === "conflict") {
            return {
              ok: false,
              error: {
                code: after.code,
                message: `Crew init conflict at ${redactCrewInitPath(after.path)}: ${after.nextStep}`
              }
            };
          }
        }
        return {
          ok: false,
          error: {
            code: code === "EACCES" || code === "EPERM" ? "permission-denied" : "publish-failed",
            message: `Failed to publish crew scaffold: ${redactCrewInitPath(projectAbs)}`
          }
        };
      }
      staging = void 0;
      return {
        ok: true,
        status: "created",
        project: projectAbs,
        manifestPath: CREW_INIT_MANIFEST_REL,
        createdPaths: crewInitManagedPaths().filter((p) => !p.endsWith("/")),
        verifiedPaths: [],
        nextCommands: [`pi --crew-role lead`, `pi --crew-role developer`]
      };
    } catch (error) {
      const code = errnoCode(error);
      return {
        ok: false,
        error: {
          code: code === "EACCES" || code === "EPERM" ? "permission-denied" : code === "ENOTDIR" ? "managed-path-shape" : "staging-failed",
          message: `Crew init failed: ${redactCrewInitPath(projectAbs)}`
        }
      };
    } finally {
      if (staging) await adapter.remove(staging);
    }
  };
  return { run, classify };
}

// src/infra/crew-init-fs.ts
import { promises as fs3 } from "node:fs";
import * as path5 from "node:path";
import { randomUUID } from "node:crypto";
function isErrno(error) {
  return typeof error === "object" && error !== null && "code" in error;
}
function createNodeCrewInitFsAdapter() {
  const kindOf = async (absPath) => {
    try {
      const stat = await fs3.lstat(absPath);
      if (stat.isSymbolicLink()) return "symlink";
      if (stat.isDirectory()) return "directory";
      return "file";
    } catch (error) {
      if (isErrno(error) && error.code === "ENOENT") return "missing";
      throw error;
    }
  };
  return {
    readKind: kindOf,
    async readFile(absPath) {
      try {
        return await fs3.readFile(absPath, "utf8");
      } catch (error) {
        if (isErrno(error) && error.code === "ENOENT") return void 0;
        throw error;
      }
    },
    async writeFile(absPath, bytes) {
      await fs3.mkdir(path5.dirname(absPath), { recursive: true });
      await fs3.writeFile(absPath, bytes, "utf8");
    },
    async mkdir(absPath) {
      await fs3.mkdir(absPath, { recursive: true });
    },
    async createStaging(projectAbs) {
      const dotPi = path5.join(projectAbs, ".pi");
      await fs3.mkdir(dotPi, { recursive: true });
      const staging = path5.join(dotPi, `.bebop-init-${randomUUID()}`);
      await fs3.mkdir(staging);
      return staging;
    },
    async publishStaging(stagingAbs, targetAbs) {
      await fs3.mkdir(path5.dirname(targetAbs), { recursive: true });
      await fs3.rename(stagingAbs, targetAbs);
    },
    async remove(absPath) {
      await fs3.rm(absPath, { recursive: true, force: true });
    },
    async touchFile(absPath) {
      const stat = await fs3.stat(absPath);
      const now = /* @__PURE__ */ new Date();
      await fs3.utimes(absPath, now, stat.mtime);
    },
    async mtimeNs(absPath) {
      try {
        const stat = await fs3.stat(absPath);
        return Math.round(stat.mtimeMs * 1e6);
      } catch {
        return void 0;
      }
    }
  };
}

// src/infra/crew-manifest-store.ts
import { promises as fs4 } from "node:fs";
import * as path7 from "node:path";

// src/infra/crew-layout.ts
import * as path6 from "node:path";
var CONFIG_DIR_NAME = ".pi";
var BEBOP_DIR_NAME = "bebop";
var COMPATIBILITY_DIR_NAME = "crew";
var CREW_LAYOUTS = [BEBOP_DIR_NAME, COMPATIBILITY_DIR_NAME];
function getTrustedCrewManifestPaths(projectRoot) {
  const root = path6.resolve(projectRoot, CONFIG_DIR_NAME);
  return CREW_LAYOUTS.map((layout) => path6.join(root, layout, DEFAULT_CREW_MANIFEST_FILE));
}
function isTrustedCrewManifestPath(manifestPath, projectRoot) {
  if (!manifestPath || !projectRoot || manifestPath.includes("\0") || projectRoot.includes("\0")) return false;
  return getTrustedCrewManifestPaths(projectRoot).includes(path6.resolve(manifestPath));
}

// src/infra/crew-manifest-store.ts
var MAX_CREW_INSTRUCTIONS_FILE_BYTES = 64 * 1024;
var CrewManifestReadError = class extends Error {
  code;
  constructor(code, message, options) {
    super(message, options);
    this.name = "CrewManifestReadError";
    this.code = code;
  }
};
async function readInstructionFileBounded(filePath, maxBytes) {
  const handle = await fs4.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
async function loadInstructionText(realFile, label3, readInstructionFile) {
  let before;
  try {
    before = await fs4.stat(realFile);
  } catch (error) {
    const code = error.code === "ENOENT" ? "instructions-file-missing" : "instructions-file-unreadable";
    throw new CrewManifestReadError(code, `${label3} could not be read`, { cause: error });
  }
  if (before.isDirectory()) throw new CrewManifestReadError("instructions-file-directory", `${label3} is a directory`);
  if (!before.isFile())
    throw new CrewManifestReadError("instructions-file-unreadable", `${label3} is not a regular file`);
  if (before.size > MAX_CREW_INSTRUCTIONS_FILE_BYTES)
    throw new CrewManifestReadError(
      "instructions-file-oversized",
      `${label3} exceeds ${MAX_CREW_INSTRUCTIONS_FILE_BYTES} bytes`
    );
  let bytes;
  try {
    bytes = await readInstructionFile(realFile, MAX_CREW_INSTRUCTIONS_FILE_BYTES);
  } catch (error) {
    throw new CrewManifestReadError("instructions-file-unreadable", `${label3} could not be read`, { cause: error });
  }
  let after;
  try {
    after = await fs4.stat(realFile);
  } catch (error) {
    throw new CrewManifestReadError("instructions-file-changed", `${label3} changed while loading`, {
      cause: error
    });
  }
  if (bytes.byteLength > MAX_CREW_INSTRUCTIONS_FILE_BYTES || after.size > MAX_CREW_INSTRUCTIONS_FILE_BYTES)
    throw new CrewManifestReadError(
      "instructions-file-oversized",
      `${label3} exceeds ${MAX_CREW_INSTRUCTIONS_FILE_BYTES} bytes`
    );
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    throw new CrewManifestReadError("instructions-file-changed", `${label3} changed while loading`);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new CrewManifestReadError("instructions-file-invalid-encoding", `${label3} is not valid UTF-8`, {
      cause: error
    });
  }
  if (text.trim().length === 0) throw new CrewManifestReadError("instructions-file-empty", `${label3} is blank`);
  if (text.includes("\0")) throw new CrewManifestReadError("instructions-file-nul", `${label3} contains NUL`);
  return text;
}
async function readTrustedCrewManifest(manifestPath, projectRoot, isProjectTrusted, readFile = (filePath, encoding) => fs4.readFile(filePath, encoding), readInstructionFile = readInstructionFileBounded) {
  const trusted = typeof isProjectTrusted === "function" ? isProjectTrusted() : isProjectTrusted;
  if (!trusted)
    throw new CrewManifestReadError("untrusted-project", "cannot read crew manifest from an untrusted project");
  const normalizedPath = path7.resolve(manifestPath);
  if (!isTrustedCrewManifestPath(normalizedPath, projectRoot)) {
    throw new CrewManifestReadError(
      "untrusted-path",
      `crew manifest is not trusted project-local configuration: ${manifestPath}`
    );
  }
  let contents;
  try {
    contents = await readFile(normalizedPath, "utf8");
  } catch (error) {
    throw new CrewManifestReadError("read-failed", `failed to read crew manifest: ${normalizedPath}`, {
      cause: error
    });
  }
  let input;
  try {
    input = JSON.parse(contents);
  } catch (error) {
    throw new CrewManifestReadError("invalid-json", `invalid JSON in crew manifest: ${normalizedPath}`, {
      cause: error
    });
  }
  const manifest = parseCrewManifest(input, normalizedPath);
  const hasCommonInstructions = manifest.commonInstructionsFile !== void 0;
  const hasRoleInstructions = manifest.members.some((member) => member.instructionsFile !== void 0);
  if (!hasCommonInstructions && !hasRoleInstructions) return manifest;
  const crewRoot = path7.dirname(normalizedPath);
  let realCrewRoot;
  let realInstructionsRoot;
  try {
    realCrewRoot = await fs4.realpath(crewRoot);
    realInstructionsRoot = await fs4.realpath(path7.join(crewRoot, "instructions"));
  } catch (error) {
    throw new CrewManifestReadError(
      "instructions-directory-failed",
      "failed to resolve the member instructions directory",
      { cause: error }
    );
  }
  const rootRelative = path7.relative(realCrewRoot, realInstructionsRoot);
  if (!rootRelative || rootRelative === ".." || rootRelative.startsWith(`..${path7.sep}`) || path7.isAbsolute(rootRelative)) {
    throw new CrewManifestReadError(
      "instructions-file-unsafe",
      "crew instructions directory is outside the trusted crew directory"
    );
  }
  let commonInstructions;
  if (manifest.commonInstructionsFile !== void 0) {
    const requested = path7.resolve(crewRoot, manifest.commonInstructionsFile);
    let realFile;
    try {
      realFile = await fs4.realpath(requested);
    } catch (error) {
      const code = error.code === "ENOENT" ? "instructions-file-missing" : "instructions-file-unreadable";
      throw new CrewManifestReadError(code, "commonInstructionsFile could not be resolved", { cause: error });
    }
    const relative4 = path7.relative(realInstructionsRoot, realFile);
    if (!relative4 || relative4 === ".." || relative4.startsWith(`..${path7.sep}`) || path7.isAbsolute(relative4)) {
      throw new CrewManifestReadError(
        "instructions-file-unsafe",
        "commonInstructionsFile is outside instructions/"
      );
    }
    commonInstructions = await loadInstructionText(realFile, "commonInstructionsFile", readInstructionFile);
  }
  const members = [];
  for (const member of manifest.members) {
    if (member.instructionsFile === void 0) {
      members.push(member);
      continue;
    }
    const requested = path7.resolve(crewRoot, member.instructionsFile);
    let realFile;
    try {
      realFile = await fs4.realpath(requested);
    } catch (error) {
      const code = error.code === "ENOENT" ? "instructions-file-missing" : "instructions-file-unreadable";
      throw new CrewManifestReadError(code, `members.${member.name}.instructionsFile could not be resolved`, {
        cause: error
      });
    }
    const relative4 = path7.relative(realInstructionsRoot, realFile);
    if (!relative4 || relative4 === ".." || relative4.startsWith(`..${path7.sep}`) || path7.isAbsolute(relative4)) {
      throw new CrewManifestReadError(
        "instructions-file-unsafe",
        `members.${member.name}.instructionsFile is outside instructions/`
      );
    }
    const text = await loadInstructionText(
      realFile,
      `members.${member.name}.instructionsFile`,
      readInstructionFile
    );
    members.push({ ...member, instructions: text, instructionsFile: void 0 });
  }
  return {
    ...manifest,
    ...commonInstructions === void 0 ? {} : { commonInstructions },
    members
  };
}

// src/infra/member-inbox-store.ts
import { promises as fs5 } from "node:fs";
import * as path8 from "node:path";
import { createHash } from "node:crypto";
var INBOX_DIR_NAME = "inbox";
var QUARANTINE_DIR_NAME = "quarantine";
var LOCK_FILE_NAME = ".lock";
var TEMP_PREFIX = ".tmp-";
var MAX_INBOX_ITEM_FILE_BYTES = 11e5;
var DEFAULT_INBOX_LIST_LIMIT = 32;
var MemberInboxStoreError = class extends Error {
  code;
  constructor(code, message, options) {
    super(message, options);
    this.name = "MemberInboxStoreError";
    this.code = code;
  }
};
var defaultDependencies = {
  mkdir: (directory, options) => fs5.mkdir(directory, options),
  readdir: (directory) => fs5.readdir(directory),
  readFile: (filePath) => fs5.readFile(filePath),
  writeFile: (filePath, data) => fs5.writeFile(filePath, data, "utf8"),
  rename: (oldPath, newPath) => fs5.rename(oldPath, newPath),
  unlink: (filePath) => fs5.unlink(filePath),
  stat: (filePath) => fs5.stat(filePath),
  realpath: (filePath) => fs5.realpath(filePath),
  openLock: async (lockPath) => {
    const handle = await fs5.open(lockPath, "wx");
    return async () => {
      await handle.close();
      try {
        await fs5.unlink(lockPath);
      } catch (error) {
        if (!isCode(error, "ENOENT")) throw error;
      }
    };
  },
  lockDeadlineMs: 2e3,
  lockPollMs: 25
};
function isCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
var isInside = (parent, child) => {
  const relative4 = path8.relative(parent, child);
  return relative4 !== "" && !relative4.startsWith(`..${path8.sep}`) && relative4 !== ".." && !path8.isAbsolute(relative4);
};
function memberInboxStorageKey(socketPath) {
  return `member-${createHash("sha256").update(path8.resolve(socketPath)).digest("hex").slice(0, 24)}`;
}
async function openTrustedMemberInboxStore(options) {
  if (!options.isProjectTrusted())
    throw new MemberInboxStoreError("untrusted-project", "cannot open member inbox in an untrusted project");
  const manifestPath = path8.resolve(options.manifestPath);
  if (!isTrustedCrewManifestPath(manifestPath, options.projectRoot))
    throw new MemberInboxStoreError(
      "untrusted-path",
      `member inbox storage is not trusted project-local configuration: ${manifestPath}`
    );
  const member = options.member;
  const socketsRoot = path8.join(path8.dirname(manifestPath), "sockets");
  const socketPath = path8.resolve(member.socketPath);
  if (path8.dirname(socketPath) !== socketsRoot)
    throw new MemberInboxStoreError(
      "invalid-member",
      `member socket path must stay under the manifest sockets directory: ${socketPath}`
    );
  const target = { name: member.name, socketPath };
  if (!isInboxTarget(target))
    throw new MemberInboxStoreError("invalid-member", "member identity must be a non-empty name and socket path");
  const deps = { ...defaultDependencies, ...options.deps };
  const layoutDir = path8.dirname(manifestPath);
  const inboxRoot = path8.join(layoutDir, INBOX_DIR_NAME);
  const memberKey = memberInboxStorageKey(socketPath);
  const memberDir = path8.join(inboxRoot, memberKey);
  const realLayout = await deps.realpath(layoutDir);
  const realInboxRoot = await ensureContainedDirectory(inboxRoot, realLayout, deps);
  const store = {
    memberKey,
    async enqueue(payload, now) {
      if (!isMessagePayload(payload))
        throw new MemberInboxStoreError("invalid-payload", "inbox payload must be a valid message payload");
      await ensureMemberDir(realInboxRoot, memberDir, deps);
      return await withLock(memberDir, deps, async () => {
        const items = await readItems(memberDir, realInboxRoot, socketPath, deps);
        if (items.length >= MAX_INBOX_ITEMS)
          throw new MemberInboxStoreError(
            "capacity-exceeded",
            `member inbox is full: ${items.length}/${MAX_INBOX_ITEMS} items`
          );
        const sequence = nextInboxSequence(items);
        const item = {
          version: INBOX_VERSION,
          id: createInboxItemId(target, sequence, payload),
          target,
          payload,
          enqueuedAt: now,
          sequence
        };
        await persistItem(memberDir, item, deps);
        return { item };
      });
    },
    async enqueueWithId(payload, now, id) {
      if (!isMessagePayload(payload))
        throw new MemberInboxStoreError("invalid-payload", "inbox payload must be a valid message payload");
      assertSafeItemId(id);
      await ensureMemberDir(realInboxRoot, memberDir, deps);
      return await withLock(memberDir, deps, async () => {
        const items = await readItems(memberDir, realInboxRoot, socketPath, deps);
        const existing = items.find((item2) => item2.id === id);
        if (existing) {
          const sameTarget = existing.target.name === target.name && existing.target.socketPath === target.socketPath;
          const samePayload = JSON.stringify(existing.payload) === JSON.stringify(payload);
          if (!sameTarget || !samePayload)
            throw new MemberInboxStoreError(
              "idempotency-conflict",
              `item id already exists with a different target or payload: ${id}`
            );
          return { alreadyPersisted: true, itemId: id };
        }
        if (items.length >= MAX_INBOX_ITEMS)
          throw new MemberInboxStoreError(
            "capacity-exceeded",
            `member inbox is full: ${items.length}/${MAX_INBOX_ITEMS} items`
          );
        const sequence = nextInboxSequence(items);
        const item = {
          version: INBOX_VERSION,
          id,
          target,
          payload,
          enqueuedAt: now,
          sequence
        };
        await persistItem(memberDir, item, deps);
        return { item };
      });
    },
    async peekOldest() {
      const items = await readItems(memberDir, realInboxRoot, socketPath, deps);
      return items[0] ?? null;
    },
    async list(limit = DEFAULT_INBOX_LIST_LIMIT) {
      const items = await readItems(memberDir, realInboxRoot, socketPath, deps);
      return items.slice(0, Math.max(0, limit)).map(
        (item) => ({
          id: item.id,
          sequence: item.sequence,
          enqueuedAt: item.enqueuedAt,
          bytes: Buffer.byteLength(JSON.stringify(item), "utf8")
        })
      );
    },
    async count() {
      return (await readItems(memberDir, realInboxRoot, socketPath, deps)).length;
    },
    async remove(id) {
      return await removeItem(memberDir, realInboxRoot, id, deps);
    },
    async cancel(id) {
      return await removeItem(memberDir, realInboxRoot, id, deps);
    }
  };
  return store;
}
async function ensureContainedDirectory(directory, realParent, deps) {
  await deps.mkdir(directory, { recursive: true });
  const real = await deps.realpath(directory);
  if (!isInside(realParent, real))
    throw new MemberInboxStoreError("untrusted-path", "member inbox directory escapes the trusted crew layout");
  return real;
}
async function ensureMemberDir(realInboxRoot, memberDir, deps) {
  await deps.mkdir(memberDir, { recursive: true });
  const real = await deps.realpath(memberDir);
  if (!isInside(realInboxRoot, real))
    throw new MemberInboxStoreError("untrusted-path", "member inbox directory escapes the trusted inbox root");
  return real;
}
async function withLock(memberDir, deps, operation) {
  const lockPath = path8.join(memberDir, LOCK_FILE_NAME);
  const deadline = Date.now() + deps.lockDeadlineMs;
  let release = null;
  while (!release) {
    try {
      release = await deps.openLock(lockPath);
    } catch (error) {
      if (!isCode(error, "EEXIST") || Date.now() >= deadline)
        throw new MemberInboxStoreError(
          "lock-conflict",
          `member inbox is locked by another writer: ${memberDir}`,
          { cause: error }
        );
      await new Promise((resolve7) => setTimeout(resolve7, deps.lockPollMs));
    }
  }
  try {
    return await operation();
  } finally {
    await release();
  }
}
async function readItems(memberDir, realInboxRoot, expectedSocketPath, deps) {
  const realMemberDir = await ensureMemberDir(realInboxRoot, memberDir, deps);
  const entries = await deps.readdir(memberDir).catch((error) => {
    throw new MemberInboxStoreError("read-failed", `failed to read member inbox: ${memberDir}`, { cause: error });
  });
  const items = [];
  for (const name of entries.sort()) {
    if (name === QUARANTINE_DIR_NAME || name === LOCK_FILE_NAME || name.startsWith(TEMP_PREFIX)) continue;
    if (!name.endsWith(".json")) continue;
    const filePath = path8.join(memberDir, name);
    const record = await readRecord(filePath, realMemberDir, expectedSocketPath, deps);
    if (record) items.push(record);
  }
  items.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  return items;
}
async function readRecord(filePath, realMemberDir, expectedSocketPath, deps) {
  try {
    const real = await deps.realpath(filePath);
    if (!isInside(realMemberDir, real)) throw new Error("record resolves outside the member inbox directory");
    const stat = await deps.stat(real);
    if (!stat.isFile()) throw new Error("record is not a regular file");
    if (stat.size > MAX_INBOX_ITEM_FILE_BYTES) throw new Error("record exceeds the size limit");
    const raw = JSON.parse((await deps.readFile(real)).toString("utf8"));
    if (!isInboxItem(raw) || raw.target.socketPath !== expectedSocketPath) throw new Error("record is malformed");
    return raw;
  } catch {
    await quarantine(filePath, deps);
    return null;
  }
}
async function quarantine(filePath, deps) {
  try {
    const quarantineDir = path8.join(path8.dirname(filePath), QUARANTINE_DIR_NAME);
    await deps.mkdir(quarantineDir, { recursive: true });
    const name = path8.basename(filePath);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const target = attempt === 0 ? name : `${name}.${attempt}`;
      const targetPath = path8.join(quarantineDir, target);
      try {
        await deps.rename(filePath, targetPath);
        return;
      } catch (error) {
        if (!isCode(error, "ENOENT")) continue;
        return;
      }
    }
    throw new MemberInboxStoreError("quarantine-failed", `failed to quarantine inbox record: ${filePath}`);
  } catch (error) {
    if (error instanceof MemberInboxStoreError) throw error;
    throw new MemberInboxStoreError("quarantine-failed", `failed to quarantine inbox record: ${filePath}`, {
      cause: error
    });
  }
}
async function silentUnlink(filePath, deps) {
  try {
    await deps.unlink(filePath);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
}
async function persistItem(memberDir, item, deps) {
  const finalPath = path8.join(memberDir, `${item.id}.json`);
  const tempPath = path8.join(memberDir, `${TEMP_PREFIX}${item.id}.json`);
  try {
    await deps.writeFile(tempPath, JSON.stringify(item));
    await deps.rename(tempPath, finalPath);
  } catch (error) {
    await silentUnlink(tempPath, deps);
    throw new MemberInboxStoreError("write-failed", `failed to persist inbox item: ${memberDir}`, {
      cause: error
    });
  }
}
function assertSafeItemId(id) {
  if (typeof id !== "string" || id.length === 0 || id.includes("/") || id.includes("\\") || id.includes("..") || id.includes("\0"))
    throw new MemberInboxStoreError("invalid-item-id", "inbox item id must be a safe file name");
}
async function removeItem(memberDir, realInboxRoot, id, deps) {
  assertSafeItemId(id);
  await ensureMemberDir(realInboxRoot, memberDir, deps);
  try {
    await deps.unlink(path8.join(memberDir, `${id}.json`));
    return { removed: true };
  } catch (error) {
    if (isCode(error, "ENOENT")) return { removed: false };
    throw new MemberInboxStoreError("write-failed", `failed to remove inbox item: ${memberDir}`, { cause: error });
  }
}

// src/application/external-intake.ts
var ExternalIntakeError = class extends Error {
  code;
  constructor(code, message, options) {
    super(message, options);
    this.name = "ExternalIntakeError";
    this.code = code;
  }
};
function projectRootOf(manifestPath) {
  const normalized = manifestPath.split(/[\\/]/);
  return normalized.slice(0, -3).join("/") || "/";
}
function mapManifestLoadError(error) {
  if (error instanceof CrewManifestError)
    return new ExternalIntakeError("invalid-manifest", error.message, { cause: error });
  if (error instanceof CrewManifestReadError) {
    if (error.code === "untrusted-path")
      return new ExternalIntakeError("untrusted-path", error.message, { cause: error });
    if (error.code === "read-failed")
      return new ExternalIntakeError("read-failed", error.message, { cause: error });
    if (error.code === "invalid-json")
      return new ExternalIntakeError("invalid-json", error.message, { cause: error });
    return new ExternalIntakeError("invalid-manifest", error.message, { cause: error });
  }
  return new ExternalIntakeError("invalid-manifest", `failed to load crew manifest: ${String(error)}`, {
    cause: error
  });
}
function mapStoreOpenError(error) {
  if (error instanceof MemberInboxStoreError) {
    if (error.code === "untrusted-project" || error.code === "untrusted-path")
      return new ExternalIntakeError("inbox-untrusted", error.message, { cause: error });
    return new ExternalIntakeError("intake-storage-failed", error.message, { cause: error });
  }
  return new ExternalIntakeError("intake-storage-failed", `failed to open contact inbox: ${String(error)}`, {
    cause: error
  });
}
function mapEnqueueError(error) {
  if (error instanceof MemberInboxStoreError) {
    if (error.code === "capacity-exceeded")
      return new ExternalIntakeError("inbox-full", error.message, { cause: error });
    if (error.code === "untrusted-project" || error.code === "untrusted-path")
      return new ExternalIntakeError("inbox-untrusted", error.message, { cause: error });
    if (error.code === "lock-conflict" || error.code === "write-failed" || error.code === "read-failed" || error.code === "quarantine-failed")
      return new ExternalIntakeError("storage-unavailable", error.message, { cause: error });
    return new ExternalIntakeError("intake-storage-failed", error.message, { cause: error });
  }
  return new ExternalIntakeError("intake-storage-failed", `failed to persist intake message: ${String(error)}`, {
    cause: error
  });
}
async function submitExternalIntake(request, dependencies) {
  let manifest;
  try {
    manifest = await dependencies.loadManifest(request.manifestPath);
  } catch (error) {
    throw mapManifestLoadError(error);
  }
  const resolution = resolveIntakeContact(manifest);
  if (!resolution.enabled)
    throw new ExternalIntakeError(
      "external-intake-disabled",
      "external crew intake is disabled: the manifest has no configured crew contact"
    );
  const contact = resolution.contact;
  let payload;
  try {
    payload = createExternalIntakePayload({
      label: request.label,
      content: request.content,
      instructions: request.instructions
    });
  } catch {
    throw new ExternalIntakeError("invalid-payload", "external intake message is invalid");
  }
  const projectRoot = projectRootOf(request.manifestPath);
  let store;
  try {
    store = await dependencies.openStore({
      manifestPath: request.manifestPath,
      projectRoot,
      member: { name: contact.name, role: contact.role, socketPath: contact.socketPath }
    });
  } catch (error) {
    throw mapStoreOpenError(error);
  }
  let item;
  try {
    ({ item } = await store.enqueue(payload, dependencies.now?.() ?? Date.now()));
  } catch (error) {
    throw mapEnqueueError(error);
  }
  return {
    ok: true,
    itemId: item.id,
    persisted: true,
    contact: contact.name,
    contactRole: contact.role
  };
}

// src/infra/rpc-client.ts
import * as net from "node:net";
import { randomUUID as randomUUID2 } from "node:crypto";
var RpcProtocolError = class extends Error {
  code;
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "RpcProtocolError";
    this.code = code;
  }
};
function getAbortError(signal) {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason.length > 0) return new Error(reason);
  return new Error("Operation aborted");
}
function nextId() {
  return `rpc_${randomUUID2()}`;
}
function commandResponse(command, wire) {
  if ("error" in wire) return { type: "response", command, success: false, error: wire.error.message, id: wire.id };
  return { type: "response", command, success: true, data: wire.result, id: wire.id };
}
async function sendRpcCommand(socketPath, command, options = {}) {
  const { timeout = 5e3, waitForEvent, signal, classifyLostAck = false } = options;
  const requestId = command.id ?? nextId();
  const request = commandToRequest(command, requestId);
  const subscriptionId = nextId();
  const subscribeRequest = waitForEvent === "turn_end" ? commandToRequest({ type: "subscribe", event: "turn_end", id: subscriptionId }, subscriptionId) : void 0;
  return new Promise((resolve7, reject) => {
    if (signal?.aborted) {
      reject(getAbortError(signal));
      return;
    }
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let primaryResponse = null;
    let subscriptionAcknowledged = false;
    let settled = false;
    let dispatched = false;
    let timeoutHandle;
    const seenIds = /* @__PURE__ */ new Set();
    const cleanup = () => {
      clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
    };
    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      error ? reject(error) : resolve7(result);
    };
    const outcomeUnknown = () => new RpcProtocolError(
      "outcome-unknown",
      "Delivery outcome unknown: the request was dispatched but its acknowledgement was lost"
    );
    const onAbort = () => settle(classifyLostAck && dispatched ? outcomeUnknown() : getAbortError(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    timeoutHandle = setTimeout(
      () => settle(classifyLostAck && dispatched ? outcomeUnknown() : new Error("RPC request timeout")),
      timeout
    );
    socket.on("connect", () => {
      try {
        socket.write(serializeRequest(request));
        dispatched = true;
        if (subscribeRequest) socket.write(serializeRequest(subscribeRequest));
      } catch (error) {
        settle(error instanceof Error ? error : new Error("Failed to write RPC request"));
      }
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line) continue;
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          settle(new RpcProtocolError("malformed-response", "Malformed JSON-RPC response"));
          return;
        }
        if (isTurnEndNotification(value)) {
          if (!waitForEvent || value.params.subscriptionId !== subscriptionId) {
            settle(new RpcProtocolError("unexpected-notification", "Unexpected JSON-RPC notification"));
            return;
          }
          if (!subscriptionAcknowledged) {
            settle(
              new RpcProtocolError(
                "out-of-order-ack",
                "Notification arrived before subscription acknowledgement"
              )
            );
            return;
          }
          if (!primaryResponse) {
            settle(
              new RpcProtocolError(
                "out-of-order-response",
                "Notification arrived before primary response"
              )
            );
            return;
          }
          settle(void 0, {
            response: primaryResponse,
            event: { message: value.params.message ?? void 0, turnIndex: value.params.turnIndex }
          });
          return;
        }
        if (!isRpcResponse(value)) {
          settle(new RpcProtocolError("malformed-response", "Malformed JSON-RPC response envelope"));
          return;
        }
        if (value.id === null || value.id !== requestId && (!subscribeRequest || value.id !== subscriptionId)) {
          settle(new RpcProtocolError("mismatched-id", "JSON-RPC response id did not match request"));
          return;
        }
        if (seenIds.has(value.id)) {
          settle(new RpcProtocolError("duplicate-id", "Duplicate JSON-RPC response id"));
          return;
        }
        seenIds.add(value.id);
        const isPrimary = value.id === requestId;
        if ("error" in value) {
          settle(new RpcProtocolError(value.error.data?.code ?? "remote-error", value.error.message));
          return;
        }
        const method = isPrimary ? request.method : "event.subscribe";
        if (!isMethodResult(method, value.result)) {
          settle(new RpcProtocolError("invalid-result", "Invalid JSON-RPC method result"));
          return;
        }
        if (isPrimary) {
          primaryResponse = commandResponse(command.type, value);
          if (!primaryResponse.success) {
            settle(new RpcProtocolError("remote-error", primaryResponse.error ?? "Remote request failed"));
            return;
          }
          if (!waitForEvent) {
            settle(void 0, { response: primaryResponse });
            return;
          }
        } else {
          if (!isSubscribeResult(value.result) || value.result.subscriptionId !== subscriptionId) {
            settle(
              new RpcProtocolError(
                "mismatched-subscription-id",
                "Subscription acknowledgement id did not match request"
              )
            );
            return;
          }
          subscriptionAcknowledged = true;
        }
      }
    });
    socket.on("error", (error) => settle(classifyLostAck && dispatched ? outcomeUnknown() : error));
    socket.on(
      "end",
      () => settle(classifyLostAck && dispatched ? outcomeUnknown() : new Error("Socket ended before RPC completed"))
    );
    socket.on(
      "close",
      () => settle(classifyLostAck && dispatched ? outcomeUnknown() : new Error("Socket closed before RPC completed"))
    );
  });
}
function mapIdleSocketError(error) {
  const code = error?.code;
  if (code === "ENOENT" || code === "ECONNREFUSED" || code === "ENOTCONN")
    return { ok: false, code: "transport-error", transportCode: code };
  return { ok: false, code: "transport-error" };
}
function mapIdleRemoteError(message) {
  const text = String(message ?? "");
  return /capacity/i.test(text) ? "capacity-exceeded" : /not-joined|unknown|ambiguous|self-wait/i.test(text) ? "remote-rejected" : "remote-rejected";
}
async function sendMemberIdleWait(socketPath, command, options) {
  const { timeoutSeconds, signal } = options;
  const requestId = command.id ?? nextId();
  const request = commandToRequest(command, requestId);
  return new Promise((resolve7) => {
    if (signal?.aborted) {
      resolve7({ ok: false, code: "aborted" });
      return;
    }
    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    let subscriptionAcknowledged = false;
    let terminalReceived = false;
    let timeoutHandle;
    const cleanup = () => {
      clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
      socket.removeAllListeners();
    };
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      resolve7(outcome);
    };
    const onAbort = () => finish({ ok: false, code: "aborted" });
    signal?.addEventListener("abort", onAbort, { once: true });
    timeoutHandle = setTimeout(() => finish({ ok: false, code: "timeout" }), timeoutSeconds * 1e3);
    socket.on("connect", () => {
      try {
        socket.write(serializeRequest(request));
      } catch {
        finish({ ok: false, code: "transport-error" });
      }
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        if (!line) continue;
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          finish({ ok: false, code: "malformed-response" });
          return;
        }
        if (isMemberIdleWaitNotification(value)) {
          if (value.params.subscriptionId !== requestId || !subscriptionAcknowledged) {
            finish({ ok: false, code: "malformed-response" });
            return;
          }
          terminalReceived = true;
          finish({ ok: true, result: value.params.result });
          return;
        }
        if (!isRpcResponse(value)) {
          finish({ ok: false, code: "malformed-response" });
          return;
        }
        if (value.id !== requestId) {
          finish({ ok: false, code: "malformed-response" });
          return;
        }
        if ("error" in value) {
          finish({ ok: false, code: mapIdleRemoteError(value.error.message) });
          return;
        }
        if (!isMemberIdleWaitSubscribeResult(value.result)) {
          finish({ ok: false, code: "malformed-response" });
          return;
        }
        subscriptionAcknowledged = true;
      }
    });
    socket.on("error", (error) => finish(mapIdleSocketError(error)));
    socket.on("end", () => finish({ ok: false, code: "offline" }));
    socket.on("close", () => {
      if (!settled && !terminalReceived) finish({ ok: false, code: "offline" });
    });
  });
}

// src/application/direct-message.ts
var DirectMessageError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "DirectMessageError";
    this.code = code;
  }
};
async function sendDirectMessage(request, sendRpc = sendRpcCommand) {
  const payload = {
    content: request.message,
    ...request.instructions === void 0 ? {} : { instructions: [...request.instructions] },
    ...request.origin === void 0 ? {} : { origin: request.origin },
    ...request.sender === void 0 ? {} : { replyTo: request.sender }
  };
  if (!isMessagePayload(payload))
    throw new DirectMessageError("remote-rejected", "Invalid structured message payload");
  const command = {
    type: "send",
    payload,
    delivery: request.mode === "steer" ? "immediate" : "follow_up"
  };
  const options = request.wait === "turn_end" ? {
    ...request.timeoutMs === void 0 ? {} : { timeout: request.timeoutMs },
    waitForEvent: "turn_end",
    signal: request.signal
  } : { ...request.timeoutMs === void 0 ? {} : { timeout: request.timeoutMs }, signal: request.signal };
  const result = await sendRpc(request.socketPath, command, options);
  if (!result.response.success)
    throw new DirectMessageError(
      "remote-rejected",
      result.response.error ?? "Remote endpoint rejected the message"
    );
  if (request.wait === "accepted") return { status: "accepted", data: result.response.data };
  if (result.event?.message === void 0) {
    if (request.requireAssistantResponse)
      throw new DirectMessageError("missing-assistant-response", "Turn completed without an assistant response");
    return {
      status: "completed",
      ...result.event?.turnIndex === void 0 ? {} : { turnIndex: result.event.turnIndex }
    };
  }
  return {
    status: "completed",
    message: result.event.message,
    ...result.event?.turnIndex === void 0 ? {} : { turnIndex: result.event.turnIndex }
  };
}

// src/cli/errors.ts
function errorCode(error) {
  if (error instanceof ExternalIntakeError) return error.code;
  if (error instanceof DirectMessageError) return error.code;
  if (error instanceof Error && error.name === "AbortError") return "aborted";
  if (error instanceof Error && /timeout/i.test(error.message)) return "timeout";
  const systemCode = error instanceof Error ? error.code : void 0;
  if (systemCode === "EACCES" || systemCode === "EPERM") return "permission-denied";
  if (systemCode === "ENOENT") return "offline";
  if (error instanceof Error && /JSON|malformed|parse/i.test(error.message)) return "malformed-response";
  return "offline";
}
function requestedFormat(args) {
  let format = "toon";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--format") {
      const value = args[index + 1];
      if (value === "json" || value === "text") format = value;
    } else if (arg.startsWith("--format=")) {
      const value = arg.slice("--format=".length);
      if (value === "json" || value === "text") format = value;
    }
  }
  return format;
}
function usageResult(message, code = "usage") {
  return {
    ok: false,
    target: "",
    status: "usage",
    error: { code, message }
  };
}
function errorResult(message, target, code) {
  return {
    ok: false,
    target,
    status: "error",
    error: { code, message }
  };
}

// src/cli/commands/crew-init-handler.ts
async function runCrewInitCommand(options, cwd) {
  if (options.help) return { kind: "help", text: crewInitHelp() };
  const project = options.project ?? cwd;
  try {
    const result = await createCrewInitFlow(createNodeCrewInitFsAdapter()).run(project);
    if (result.ok === false) {
      return {
        kind: "result",
        result: errorResult(result.error.message, project, result.error.code),
        format: options.format,
        full: false
      };
    }
    return {
      kind: "result",
      result: {
        ok: true,
        target: project,
        status: result.status,
        response: result.status === "created" ? "Scaffolded .pi/bebop crew; review names/contact/instructions before joining" : "Crew scaffold already present and byte-identical",
        data: {
          status: result.status,
          project: result.project,
          manifestPath: result.manifestPath,
          createdPaths: result.createdPaths,
          verifiedPaths: result.verifiedPaths,
          nextCommands: result.nextCommands
        }
      },
      format: options.format,
      full: false
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Crew init failed";
    return {
      kind: "result",
      result: errorResult(message, project, "operational"),
      format: options.format,
      full: false
    };
  }
}

// src/cli/message-input.ts
var MAX_STDIN_BYTES = 1e6;
function readStdinMessage(input, signal, maxBytes = MAX_STDIN_BYTES) {
  return new Promise((resolve7, reject) => {
    let data = "";
    const cleanup = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onData = (chunk) => {
      data += chunk;
      if (Buffer.byteLength(data, "utf8") > maxBytes) {
        cleanup();
        input.pause();
        input.destroy();
        reject(new UsageError(`--stdin exceeds the ${maxBytes}-byte message limit`));
      }
    };
    const onEnd = () => {
      cleanup();
      resolve7(data);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      input.pause();
      input.destroy();
      reject(
        signal.reason instanceof Error ? signal.reason : Object.assign(new Error("Operation aborted"), { name: "AbortError" })
      );
    };
    input.setEncoding("utf8");
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// src/cli/commands/direct-send-adapter.ts
var defaultDirectSendDependencies = {
  send: (request) => sendDirectMessage(request)
};
async function deliverDirectMessage(options, message, signal, deps = defaultDirectSendDependencies) {
  const result = await deps.send({
    socketPath: options.socketPath,
    message,
    ...options.instructions.length === 0 ? {} : { instructions: options.instructions },
    ...options.origin === void 0 ? {} : { origin: options.origin },
    mode: options.mode,
    wait: options.wait,
    timeoutMs: options.timeoutMs,
    signal,
    requireAssistantResponse: true
  });
  return {
    kind: "result",
    result: {
      ok: true,
      target: options.socketPath,
      status: result.status,
      response: result.message?.content,
      data: result.data,
      turnIndex: result.turnIndex
    },
    format: options.format,
    full: options.full
  };
}

// src/cli/commands/crew-intake-adapter.ts
import { promises as fs6 } from "node:fs";
import path9 from "node:path";
var defaultCrewIntakeDependencies = {
  submit: (request, deps) => submitExternalIntake(request, deps),
  io: { readFile: (filePath, encoding) => fs6.readFile(filePath, encoding) }
};
function createCrewManifestLoader(cwd, io = defaultCrewIntakeDependencies.io) {
  return async (manifestPath) => {
    const resolved = path9.resolve(cwd, manifestPath);
    const projectRoot = path9.resolve(path9.dirname(resolved), "..", "..");
    if (!isTrustedCrewManifestPath(resolved, projectRoot)) {
      throw new CrewManifestReadError(
        "untrusted-path",
        `crew manifest must be in an exact supported layout (.pi/bebop or .pi/crew): ${manifestPath}`
      );
    }
    let contents;
    try {
      contents = await io.readFile(resolved, "utf8");
    } catch (error) {
      throw new CrewManifestReadError("read-failed", `failed to read crew manifest: ${resolved}`, {
        cause: error
      });
    }
    let input;
    try {
      input = JSON.parse(contents);
    } catch (error) {
      throw new CrewManifestReadError("invalid-json", `invalid JSON in crew manifest: ${resolved}`, {
        cause: error
      });
    }
    return parseCrewManifest(input, resolved);
  };
}
async function deliverCrewIntake(options, message, context, deps = defaultCrewIntakeDependencies) {
  const ack = await deps.submit(
    {
      manifestPath: options.crewPath,
      label: options.origin?.label ?? "external",
      content: message,
      instructions: options.instructions.length === 0 ? void 0 : options.instructions
    },
    {
      loadManifest: createCrewManifestLoader(context.cwd, deps.io),
      // Caller consent replaces Pi trust for the standalone CLI: the explicit
      // --crew path (already layout-validated) plus filesystem permissions are
      // the consent; the store re-validates the exact layout. We never report
      // the project as Pi-trusted.
      openStore: async (storeOptions) => openTrustedMemberInboxStore({
        manifestPath: storeOptions.manifestPath,
        projectRoot: storeOptions.projectRoot,
        isProjectTrusted: () => true,
        member: storeOptions.member
      })
    }
  );
  return {
    kind: "result",
    result: {
      ok: true,
      target: options.crewPath,
      status: "persisted",
      response: `Persisted for ${ack.contact} (${ack.contactRole}) \u2014 inbox item ${ack.itemId}`,
      data: ack
    },
    format: options.format,
    full: options.full
  };
}

// src/cli/commands/send-handler.ts
var defaultSendHandlerAdapters = {
  readStdin: readStdinMessage,
  deliverDirect: deliverDirectMessage,
  intake: deliverCrewIntake
};
async function runSendCommand(options, context, adapters = defaultSendHandlerAdapters) {
  const target = options.crewPath ?? options.socketPath ?? "";
  try {
    if (options.help) return { kind: "help", text: sendHelp() };
    let message = options.message;
    if (options.stdin) {
      message = await adapters.readStdin(context.input, context.signal);
      if (message.length === 0)
        throw new UsageError("--stdin received empty input; provide UTF-8 message content");
    }
    if (options.crewPath !== void 0) return await adapters.intake(options, message, context);
    return await adapters.deliverDirect(options, message, context.signal);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    const messageText = error instanceof Error ? error.message : "Unknown operational failure";
    return {
      kind: "result",
      result: errorResult(messageText, target, errorCode(error)),
      format: options.format,
      full: options.full
    };
  }
}

// src/infra/socket-endpoint.ts
import { promises as fs7 } from "node:fs";
import * as path10 from "node:path";
async function resolveMemberEndpoint(socketPath) {
  try {
    const target = await fs7.readlink(socketPath);
    return path10.resolve(path10.dirname(socketPath), target);
  } catch {
    return socketPath;
  }
}

// src/infra/intray-paths.ts
import * as os from "node:os";
import * as path11 from "node:path";
var CONTROL_DIR = path11.join(os.homedir(), ".pi", "bebop");
var SOCKET_SUFFIX = ".sock";
function getSocketPath(sessionId) {
  return path11.join(CONTROL_DIR, `${sessionId}${SOCKET_SUFFIX}`);
}
function getAliasPath(alias) {
  return path11.join(CONTROL_DIR, `${alias}.alias`);
}

// src/cli/source-session.ts
var SESSION_LIST_HINT = "pi-bebop session list";
function resolveSourceSession(input) {
  const explicit = input.explicitSession;
  if (explicit !== void 0 && explicit !== "") {
    if (!isSafeSessionId(explicit) && !isSafeAlias(explicit))
      return {
        ok: false,
        code: "invalid-session",
        message: `Invalid --session '${explicit}'; use a safe session id or alias, or ${SESSION_LIST_HINT}`
      };
    return { ok: true, kind: "id", idSocketPath: getSocketPath(explicit), aliasSocketPath: getAliasPath(explicit) };
  }
  const environment = input.environmentSession;
  if (environment !== void 0 && environment !== "") {
    if (!isSafeSessionId(environment))
      return {
        ok: false,
        code: "invalid-session",
        message: `Invalid PI_SESSION_ID '${environment}'; the environment fallback accepts a safe exact session id only`
      };
    return {
      ok: true,
      kind: "id",
      idSocketPath: getSocketPath(environment),
      aliasSocketPath: getAliasPath(environment)
    };
  }
  return {
    ok: false,
    code: "session-required",
    message: `No source session; pass --session <id|alias> or set PI_SESSION_ID, or run ${SESSION_LIST_HINT}`
  };
}

// src/cli/commands/member-status.ts
var FORMATS2 = ["toon", "json", "text"];
var MAX_TARGET_BYTES = 256;
function isCliFormat2(value) {
  return FORMATS2.includes(value);
}
function buildMemberStatusCommand() {
  return new Command("status").description("Show one crew member's mechanical Pi runtime state (read-only)").option("--session <id|alias>", "Source joined Pi session id or alias (default: PI_SESSION_ID)").option("--format <format>", "Output format: toon (default), json, or text", "toon").argument("[<member>]", "Crew member name or unique role").showHelpAfterError(false).helpOption(false);
}
function memberStatusHelp() {
  return [
    "pi-bebop member status <member> [--session <id|alias>] [--format toon|json|text]",
    "",
    "Show one crew member's mechanical Pi runtime state (online/offline, idle/busy/compacting,",
    "pending-message signal) and the observation time. Read-only: never",
    "starts, steers, or interrupts the target turn. Activity is mechanical and",
    "never verified task progress. For intent, progress, a report, or a verdict,",
    "ask the member explicitly with send_member_request instead of relying on status.",
    "",
    "Options:",
    "  --session <id|alias>   Source joined Pi session id or alias (default: PI_SESSION_ID)",
    "  --format <format>      toon (default), json, or text",
    "",
    "Source: the query runs through one already-joined Pi session, which derives",
    "membership and trust authoritatively. The CLI never loads a crew manifest.",
    "A configured target that is offline is a successful offline result, not an error.",
    "",
    `Discover sessions with: ${SESSION_LIST_HINT}`,
    ""
  ].join("\n");
}
var VALID_FLAGS2 = "--session <id|alias>, --format toon|json|text, --help";
function mapCommanderError2(error) {
  const match = /--[a-z-]+/.exec(error.message);
  const flag = match?.[0] ?? "--format";
  if (error.code === "commander.optionMissingArgument") return new UsageError(`Missing value for ${flag}`);
  if (error.code === "commander.unknownOption") {
    const unknown = /unknown option '(--?[^']+)'/.exec(error.message)?.[1] ?? "";
    return new UsageError(`Unknown flag '${unknown}'; valid flags: ${VALID_FLAGS2}`);
  }
  if (error.code === "commander.excessArguments")
    return new UsageError(`Too many arguments; valid flags: ${VALID_FLAGS2}`);
  return new UsageError(error.message);
}
function parseMemberStatusCommand(args, _cwd = process.cwd()) {
  const tokens = [];
  let help = false;
  const seen = /* @__PURE__ */ new Set();
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    const equals = raw.indexOf("=");
    const flag = equals > 0 ? raw.slice(0, equals) : raw;
    if (flag === "--help") {
      if (help) throw new UsageError("Duplicate flag: --help");
      help = true;
      continue;
    }
    if (flag === "--session" || flag === "--format") {
      if (seen.has(flag)) throw new UsageError(`Duplicate flag: ${flag}`);
      seen.add(flag);
      if (equals > 0) {
        tokens.push(raw);
        continue;
      }
      if (args[index + 1] === "--" && args[index + 2] !== void 0) {
        tokens.push(`${flag}=${args[index + 2]}`);
        index += 2;
        continue;
      }
      tokens.push(raw);
      continue;
    }
    tokens.push(raw);
  }
  const program2 = buildMemberStatusCommand().exitOverride().configureOutput({ writeOut: () => {
  }, writeErr: () => {
  }, outputError: () => {
  } });
  let opts;
  try {
    program2.parse(tokens, { from: "user" });
    opts = program2.opts();
  } catch (error) {
    if (error instanceof CommanderError) throw mapCommanderError2(error);
    throw error;
  }
  const format = opts.format ?? "toon";
  if (!isCliFormat2(format))
    throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
  const member = program2.args[0] ?? "";
  if (!help && member.trim().length === 0)
    throw new UsageError("Missing <member>; provide a crew member name or unique role");
  if (!help && (member !== member.trim() || Buffer.byteLength(member, "utf8") > MAX_TARGET_BYTES))
    throw new UsageError(`<member> must be trimmed and at most ${MAX_TARGET_BYTES} UTF-8 bytes`);
  return {
    command: "member-status",
    member: member.trim(),
    ...opts.session === void 0 ? {} : { session: opts.session },
    format,
    ...help ? { help: true } : {}
  };
}
function isSourceFailure(source) {
  return !source.ok;
}
function isStatusFailure(outcome) {
  return !outcome.ok;
}
function mapTransportError(error) {
  if (error instanceof Error && error.name === "AbortError") return { ok: false, code: "aborted" };
  const systemCode = error instanceof Error ? error.code : void 0;
  if (systemCode === "ENOENT") return { ok: false, code: "unknown-session" };
  if (systemCode === "ECONNREFUSED" || systemCode === "ENOTCONN") return { ok: false, code: "offline-session" };
  if (error instanceof Error && /timed? ?out|timeout/i.test(error.message)) return { ok: false, code: "timeout" };
  return { ok: false, code: "transport-error" };
}
async function statusThroughSocket(socketPath, target, signal) {
  const resolved = await resolveMemberEndpoint(socketPath);
  try {
    const { response } = await sendRpcCommand(
      resolved,
      { type: "member_status_target", target },
      { timeout: 5e3, signal }
    );
    if (!response.success) return { ok: false, code: response.error ?? "remote-rejected" };
    if (!isMemberStatusResult(response.data)) return { ok: false, code: "malformed-response" };
    return { ok: true, status: response.data.status };
  } catch (error) {
    if (error instanceof RpcProtocolError && error.code === "remote-error") {
      return { ok: false, code: error.message.replace(/^remote-error:\s*/, "") };
    }
    throw error;
  }
}
var defaultMemberStatusCliDependencies = {
  resolveSource: (input) => resolveSourceSession(input),
  sendStatus: async (source, target, signal) => {
    try {
      return await statusThroughSocket(source.idSocketPath, target, signal);
    } catch (idError) {
      const mapped = mapTransportError(idError);
      if (mapped.code !== "unknown-session") return mapped;
      try {
        return await statusThroughSocket(source.aliasSocketPath, target, signal);
      } catch (aliasError) {
        return mapTransportError(aliasError);
      }
    }
  },
  environmentSession: () => process.env.PI_SESSION_ID
};
async function runMemberStatusCommand(options, context, deps = defaultMemberStatusCliDependencies) {
  if (options.help) return { kind: "help", text: memberStatusHelp() };
  const target = options.member;
  const source = deps.resolveSource({
    explicitSession: options.session,
    environmentSession: deps.environmentSession()
  });
  if (isSourceFailure(source)) {
    return {
      kind: "result",
      result: usageResult(source.message, source.code),
      format: options.format,
      full: false
    };
  }
  const outcome = await deps.sendStatus(source, target, context.signal);
  if (isStatusFailure(outcome)) {
    return {
      kind: "result",
      result: errorResult(`Member status failed: ${outcome.code}`, target, outcome.code),
      format: options.format,
      full: false
    };
  }
  return {
    kind: "result",
    result: {
      ok: true,
      target,
      status: "observed",
      response: formatMemberStatus(outcome.status),
      data: { status: outcome.status }
    },
    format: options.format,
    full: false
  };
}

// src/cli/commands/member-idle-wait.ts
var MAX_TARGET_BYTES2 = 256;
var VALID_FLAGS3 = "--session <id|alias>, --timeout <duration>, --format toon|json|text, --help";
function mapCommanderError3(error) {
  const match = /--[a-z-]+/.exec(error.message);
  const flag = match?.[0] ?? "--timeout";
  if (error.code === "commander.optionMissingArgument") return new UsageError(`Missing value for ${flag}`);
  if (error.code === "commander.unknownOption") {
    const unknown = /unknown option '(--?[^']+)'/.exec(error.message)?.[1] ?? "";
    return new UsageError(`Unknown flag '${unknown}'; valid flags: ${VALID_FLAGS3}`);
  }
  if (error.code === "commander.excessArguments")
    return new UsageError(`Too many arguments; valid flags: ${VALID_FLAGS3}`);
  return new UsageError(error.message);
}
function parseTimeout(value) {
  let milliseconds;
  try {
    milliseconds = parsePositiveDurationMs(value);
  } catch {
    throw new UsageError(`Invalid --timeout '${value}'; use a whole-second duration from 1s through 10m`);
  }
  if (milliseconds % 1e3 !== 0 || milliseconds < 1e3 || milliseconds > 6e5)
    throw new UsageError(`Invalid --timeout '${value}'; use a whole-second duration from 1s through 10m`);
  return milliseconds / 1e3;
}
function buildMemberIdleWaitCommand() {
  return new Command("wait-idle").description("Wait once for a crew member to become idle or go offline").option("--session <id|alias>", "Source joined Pi session id or alias (default: PI_SESSION_ID)").option("--timeout <duration>", "Whole-second wait duration from 1s through 10m", "5m").option("--format <format>", "Output format: toon (default), json, or text", "toon").argument("[<member>]", "Crew member name or unique role").showHelpAfterError(false).helpOption(false);
}
function memberIdleWaitHelp() {
  return [
    "pi-bebop member wait-idle <member> [--session <id|alias>] [--timeout <duration>] [--format toon|json|text]",
    "",
    "Wait once for a configured crew member to become idle, go offline, or reach the timeout.",
    "This is event-driven: it never polls, sends a message, or claims task completion.",
    "Already-idle, became-idle, offline, timeout, and aborted outcomes are distinct.",
    "",
    "Options:",
    "  --session <id|alias>   Source joined Pi session id or alias (default: PI_SESSION_ID)",
    "  --timeout <duration>   Whole seconds from 1s through 10m (default: 5m)",
    "  --format <format>      toon (default), json, or text",
    "",
    `Discover sessions with: ${SESSION_LIST_HINT}`,
    ""
  ].join("\n");
}
function parseMemberIdleWaitCommand(args, _cwd = process.cwd()) {
  const tokens = [];
  let help = false;
  const seen = /* @__PURE__ */ new Set();
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    const equals = raw.indexOf("=");
    const flag = equals > 0 ? raw.slice(0, equals) : raw;
    if (flag === "--help") {
      if (help) throw new UsageError("Duplicate flag: --help");
      help = true;
      continue;
    }
    if (flag === "--session" || flag === "--timeout" || flag === "--format") {
      if (seen.has(flag)) throw new UsageError(`Duplicate flag: ${flag}`);
      seen.add(flag);
      if (equals > 0) tokens.push(raw);
      else tokens.push(raw);
      continue;
    }
    tokens.push(raw);
  }
  const program2 = buildMemberIdleWaitCommand().exitOverride().configureOutput({ writeOut: () => {
  }, writeErr: () => {
  }, outputError: () => {
  } });
  let opts;
  try {
    program2.parse(tokens, { from: "user" });
    opts = program2.opts();
  } catch (error) {
    if (error instanceof CommanderError) throw mapCommanderError3(error);
    throw error;
  }
  const format = opts.format ?? "toon";
  if (!["toon", "json", "text"].includes(format))
    throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
  const member = program2.args[0] ?? "";
  if (!help && member.trim().length === 0)
    throw new UsageError("Missing <member>; provide a crew member name or unique role");
  if (!help && (member !== member.trim() || Buffer.byteLength(member, "utf8") > MAX_TARGET_BYTES2))
    throw new UsageError(`<member> must be trimmed and at most ${MAX_TARGET_BYTES2} UTF-8 bytes`);
  return {
    command: "member-idle-wait",
    member: member.trim(),
    ...opts.session === void 0 ? {} : { session: opts.session },
    timeoutSeconds: parseTimeout(opts.timeout ?? "5m"),
    format,
    ...help ? { help: true } : {}
  };
}
function mapIdleWaitTransportError(error) {
  if (error instanceof Error && error.name === "AbortError") return { ok: false, code: "aborted" };
  const code = error instanceof Error ? error.code : void 0;
  if (code === "ENOENT") return { ok: false, code: "unknown-session" };
  if (code === "ECONNREFUSED" || code === "ENOTCONN") return { ok: false, code: "offline-session" };
  if (error instanceof Error && /timed? ?out|timeout/i.test(error.message)) return { ok: false, code: "timeout" };
  return { ok: false, code: "transport-error" };
}
function normalizeIdleWaitTransportOutcome(outcome) {
  if (outcome.ok || !("transportCode" in outcome)) return outcome;
  if (outcome.transportCode === "ENOENT") return { ok: false, code: "unknown-session" };
  if (outcome.transportCode === "ECONNREFUSED" || outcome.transportCode === "ENOTCONN")
    return { ok: false, code: "offline-session" };
  return outcome;
}
async function waitThroughSocket(socketPath, target, timeoutSeconds, signal) {
  try {
    const resolved = await resolveMemberEndpoint(socketPath);
    return normalizeIdleWaitTransportOutcome(
      await sendMemberIdleWait(
        resolved,
        { type: "member_idle_wait", member: target },
        { timeoutSeconds, signal }
      )
    );
  } catch (error) {
    return mapIdleWaitTransportError(error);
  }
}
var defaultMemberIdleWaitCliDependencies = {
  resolveSource: (input) => resolveSourceSession(input),
  sendWait: async (source, target, timeoutSeconds, signal) => {
    const primary = await waitThroughSocket(source.idSocketPath, target, timeoutSeconds, signal);
    if (primary.ok || !("code" in primary) || primary.code !== "unknown-session") return primary;
    return waitThroughSocket(source.aliasSocketPath, target, timeoutSeconds, signal);
  },
  environmentSession: () => process.env.PI_SESSION_ID
};
async function runMemberIdleWaitCommand(options, context, deps = defaultMemberIdleWaitCliDependencies) {
  if (options.help) return { kind: "help", text: memberIdleWaitHelp() };
  const source = deps.resolveSource({
    explicitSession: options.session,
    environmentSession: deps.environmentSession()
  });
  if (!source.ok)
    return {
      kind: "result",
      result: usageResult(
        "message" in source ? source.message : "Unable to resolve source session",
        "code" in source ? source.code : "invalid-session"
      ),
      format: options.format,
      full: false
    };
  let outcome;
  try {
    outcome = await deps.sendWait(source, options.member, options.timeoutSeconds, context.signal);
  } catch (error) {
    outcome = mapIdleWaitTransportError(error);
  }
  if (!outcome.ok)
    return {
      kind: "result",
      result: errorResult(
        `Member idle wait failed: ${"code" in outcome ? outcome.code : "transport-error"}`,
        options.member,
        "code" in outcome ? outcome.code : "transport-error"
      ),
      format: options.format,
      full: false
    };
  if (!isMemberIdleWaitResult(outcome.result))
    return {
      kind: "result",
      result: errorResult("Member idle wait failed: malformed-response", options.member, "malformed-response"),
      format: options.format,
      full: false
    };
  return {
    kind: "result",
    result: {
      ok: true,
      target: options.member,
      status: "observed",
      response: formatMemberIdleWaitResult(outcome.result),
      data: { result: outcome.result }
    },
    format: options.format,
    full: false
  };
}

// src/cli/commands/session-list.ts
import { promises as fs8 } from "node:fs";
import path12 from "node:path";

// src/infra/member-endpoint.ts
import * as net2 from "node:net";
function probeMemberEndpoint(socketPath, dependencies = {}) {
  const createConnection3 = dependencies.createConnection ?? ((target) => net2.createConnection(target));
  const setTimer = dependencies.setTimeout ?? globalThis.setTimeout;
  const clearTimer = dependencies.clearTimeout ?? globalThis.clearTimeout;
  const signal = dependencies.signal;
  return new Promise((resolve7) => {
    const socket = createConnection3(socketPath);
    let settled = false;
    let timer;
    const onAbort = () => finish(false);
    const finish = (alive) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve7(alive);
    };
    timer = setTimer(() => finish(false), dependencies.timeoutMs ?? 300);
    if (signal) {
      if (signal.aborted) {
        finish(false);
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

// src/cli/commands/session-list.ts
var MAX_FILESYSTEM_ENTRIES = 256;
var MAX_OUTPUT_SESSIONS = 100;
var MAX_ALIASES_PER_SESSION = 8;
var PROBE_TIMEOUT_MS = 500;
function buildSessionListCommand() {
  return new Command("list").description("List reachable Pi sessions with safe aliases and joined state").option("--format <format>", "Output format: toon (default), json, or text", "toon").showHelpAfterError(false).helpOption(false);
}
function sessionListHelp() {
  return [
    "pi-bebop session list [--format toon|json|text]",
    "",
    "List reachable Pi sessions: session id, safe aliases, and joined state",
    "(joined, unjoined, or unknown). Bounded discovery for shell callers;",
    "never exposes socket paths, messages, prompts, model details, instructions,",
    "or tool history.",
    "",
    "Options:",
    "  --format <format>   toon (default), json, or text",
    "",
    "Use the reported session id as --session <id> for member commands.",
    ""
  ].join("\n");
}
var FORMATS3 = ["toon", "json", "text"];
function isCliFormat3(value) {
  return FORMATS3.includes(value);
}
function parseSessionListCommand(args, _cwd = process.cwd()) {
  const tokens = [];
  let help = false;
  let seenFormat = false;
  for (const raw of args) {
    const equals = raw.indexOf("=");
    const flag = equals > 0 ? raw.slice(0, equals) : raw;
    if (flag === "--help") {
      if (help) throw new UsageError("Duplicate flag: --help");
      help = true;
      continue;
    }
    if (flag === "--format") {
      if (seenFormat) throw new UsageError("Duplicate flag: --format");
      seenFormat = true;
      tokens.push(raw);
      continue;
    }
    tokens.push(raw);
  }
  const program2 = buildSessionListCommand().exitOverride().configureOutput({ writeOut: () => {
  }, writeErr: () => {
  }, outputError: () => {
  } });
  let opts;
  try {
    program2.parse(tokens, { from: "user" });
    opts = program2.opts();
  } catch (error) {
    if (error instanceof CommanderError) {
      const match = /--[a-z-]+/.exec(error.message);
      const flag = match?.[0] ?? "--format";
      throw new UsageError(
        error.code === "commander.optionMissingArgument" ? `Missing value for ${flag}` : error.message
      );
    }
    throw error;
  }
  const format = opts.format ?? "toon";
  if (!isCliFormat3(format))
    throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
  return { command: "session-list", format, ...help ? { help: true } : {} };
}
var defaultSessionListDependencies = {
  controlDir: () => CONTROL_DIR,
  readDir: (dir) => fs8.readdir(dir),
  readAliasTarget: async (aliasPath) => {
    try {
      return await fs8.readlink(aliasPath);
    } catch {
      return null;
    }
  },
  probe: (socketPath) => probeMemberEndpoint(socketPath, { timeoutMs: PROBE_TIMEOUT_MS }),
  queryStatus: async (socketPath) => {
    try {
      const { response } = await sendRpcCommand(socketPath, { type: "status" }, { timeout: PROBE_TIMEOUT_MS });
      if (!response.success || response.data === void 0) return null;
      const status = response.data.status;
      return status === "joined" || status === "online" || status === "stopped" ? status : null;
    } catch {
      return null;
    }
  }
};
async function runSessionListCommand(options, _context, deps = defaultSessionListDependencies) {
  if (options.help) return { kind: "help", text: sessionListHelp() };
  const dir = deps.controlDir();
  let entries;
  try {
    entries = await deps.readDir(dir);
  } catch {
    return {
      kind: "result",
      result: errorResult(`Control store unavailable: ${dir}`, "", "control-store-unavailable"),
      format: options.format,
      full: false
    };
  }
  const scanned = await scanSessionDirectory(dir, entries, deps);
  const ids = [...scanned.socketIds].sort((a, b) => {
    const primaryA = scanned.aliasesBySession.get(a)?.slice().sort()[0] ?? "";
    const primaryB = scanned.aliasesBySession.get(b)?.slice().sort()[0] ?? "";
    return primaryA === primaryB ? a.localeCompare(b) : primaryA.localeCompare(primaryB);
  });
  const { sessions, omitted } = await collectLiveSessions(ids, scanned.aliasesBySession, scanned.omitted, deps);
  if (sessions.length === 0) {
    return {
      kind: "result",
      result: {
        ok: true,
        target: "",
        status: "empty",
        data: {
          status: "empty",
          sessions: [],
          total: 0,
          omitted: 0,
          next: "start and join a Pi session, then rerun pi-bebop session list"
        }
      },
      format: options.format,
      full: false
    };
  }
  return {
    kind: "result",
    result: {
      ok: true,
      target: "",
      status: "listed",
      data: { sessions, total: sessions.length, omitted }
    },
    format: options.format,
    full: false
  };
}
async function scanSessionDirectory(dir, entries, deps) {
  const omitted = Math.max(0, entries.length - MAX_FILESYSTEM_ENTRIES);
  const aliasesBySession = /* @__PURE__ */ new Map();
  const socketIds = /* @__PURE__ */ new Set();
  for (const entry of entries.slice(0, MAX_FILESYSTEM_ENTRIES)) {
    if (entry.endsWith(".sock")) {
      const id2 = entry.slice(0, -".sock".length);
      if (isSafeSessionId(id2)) socketIds.add(id2);
      continue;
    }
    if (!entry.endsWith(".alias")) continue;
    const alias = entry.slice(0, -".alias".length);
    if (!isSafeAlias(alias)) continue;
    const target = await deps.readAliasTarget(path12.join(dir, entry));
    if (target === null) continue;
    const base = path12.basename(target);
    const id = base.endsWith(".sock") ? base.slice(0, -".sock".length) : base;
    if (!isSafeSessionId(id)) continue;
    const list = aliasesBySession.get(id) ?? [];
    if (list.length < MAX_ALIASES_PER_SESSION) list.push(alias);
    aliasesBySession.set(id, list);
  }
  return { omitted, aliasesBySession, socketIds };
}
async function collectLiveSessions(ids, aliasesBySession, initialOmitted, deps) {
  const sessions = [];
  let omitted = initialOmitted;
  for (const id of ids) {
    if (sessions.length >= MAX_OUTPUT_SESSIONS) {
      omitted += 1;
      continue;
    }
    if (!await deps.probe(getSocketPathOf(id, deps))) continue;
    const status = await deps.queryStatus(getSocketPathOf(id, deps));
    sessions.push({
      sessionId: id,
      aliases: (aliasesBySession.get(id) ?? []).slice().sort(),
      membership: status === "joined" ? "joined" : status === "online" ? "unjoined" : "unknown"
    });
  }
  return { sessions, omitted };
}
function getSocketPathOf(id, deps) {
  return `${deps.controlDir()}/${id}.sock`;
}

// src/cli/commands/guest.ts
var FORMATS4 = ["toon", "json", "text"];
function isCliFormat4(value) {
  return FORMATS4.includes(value);
}
function validValue(value) {
  return value !== void 0 && value.length > 0 && value.trim() === value && !value.includes("\0");
}
function requireValue(value, flag) {
  if (!validValue(value)) throw new UsageError(`Guest ${flag} requires a non-empty value.`);
  return value;
}
function normalizeFormat(value, flag = "--format") {
  const format = value ?? "toon";
  if (!isCliFormat4(format)) throw new UsageError(`Invalid ${flag} '${format}'; valid alternatives: toon, json, text`);
  return format;
}
function tokenize(args) {
  const tokens = [];
  let format;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    const equals = raw.indexOf("=");
    const flag = equals > 0 ? raw.slice(0, equals) : raw;
    if (flag === "--format") {
      if (format !== void 0) throw new UsageError("Duplicate flag: --format");
      format = equals > 0 ? raw.slice(equals + 1) : args[++index];
      continue;
    }
    if (flag === "--help") {
      help = true;
      continue;
    }
    tokens.push(raw);
  }
  return { tokens, format, help };
}
function buildGuestJoinCommand() {
  return new Command("join").description("Request Guest admission from a live Member socket").argument("<member-socket>", "Live Member socket path").requiredOption("--identity <guest-identity>", "Stable Guest identity for idempotent replays").requiredOption("--as <guest-name>", "Guest display name").requiredOption("--callback <socket>", "This session's callback socket path").option("--format <format>", "Output format: toon (default), json, or text", "toon").showHelpAfterError(false).helpOption(false);
}
function buildGuestLeaveCommand() {
  return new Command("leave").description("Leave one Crew by revoking the admission at its Member socket").argument("<member-socket>", "Live Member socket path").requiredOption("--crew <crew-id>", "Crew id to leave").requiredOption("--identity <guest-identity>", "This session's Guest identity").requiredOption("--callback <socket>", "The callback socket path used at join time").option("--format <format>", "Output format: toon (default), json, or text", "toon").showHelpAfterError(false).helpOption(false);
}
function parseWith(command, args, parse) {
  const program2 = command.exitOverride().configureOutput({
    writeOut: () => {
    },
    writeErr: () => {
    },
    outputError: () => {
    }
  });
  let options;
  try {
    program2.parse([...args], { from: "user" });
    options = program2.opts();
  } catch (error) {
    if (error instanceof CommanderError) {
      const match = /--[a-z-]+/.exec(error.message);
      const flag = match?.[0] ?? "--as";
      throw new UsageError(
        error.code === "commander.optionMissingArgument" ? `Missing value for ${flag}` : error.message
      );
    }
    throw error;
  }
  const positional = program2.args[0];
  if (!validValue(positional)) throw new UsageError("Guest commands require one live Member socket target.");
  return parse(options, positional);
}
function parseGuestJoinCommand(args) {
  const { tokens, format, help } = tokenize(args);
  if (help)
    return {
      command: "guest-join",
      target: "",
      guestIdentity: "",
      guestName: "",
      callback: "",
      format: normalizeFormat(format),
      help: true
    };
  const options = parseWith(buildGuestJoinCommand(), tokens, (opts, target) => {
    if (opts.as !== void 0 && !validValue(String(opts.as)))
      throw new UsageError("Guest --as requires a non-empty value.");
    return { ...opts, target };
  });
  return {
    command: "guest-join",
    target: String(options.target),
    guestIdentity: requireValue(String(options.identity ?? ""), "--identity <guest-identity>"),
    guestName: requireValue(String(options.as ?? ""), "--as <guest-name>"),
    callback: requireValue(String(options.callback ?? ""), "--callback <socket>"),
    format: normalizeFormat(format)
  };
}
function parseGuestLeaveCommand(args) {
  const { tokens, format, help } = tokenize(args);
  if (help)
    return {
      command: "guest-leave",
      target: "",
      crewId: "",
      guestIdentity: "",
      callback: "",
      format: normalizeFormat(format),
      help: true
    };
  const options = parseWith(buildGuestLeaveCommand(), tokens, (opts, target) => ({ ...opts, target }));
  return {
    command: "guest-leave",
    target: String(options.target),
    crewId: requireValue(String(options.crew ?? ""), "--crew <crew-id>"),
    guestIdentity: requireValue(String(options.identity ?? ""), "--identity <guest-identity>"),
    callback: requireValue(String(options.callback ?? ""), "--callback <socket>"),
    format: normalizeFormat(format)
  };
}
function guestJoinHelp() {
  return [
    "pi-bebop guest join <member-socket> --identity <guest-identity> --as <guest-name> --callback <socket> [--format toon|json|text]",
    "",
    "Request Guest admission from one live Member. The response stays `pending`",
    "until an exact configured approver accepts; repeating the identical request",
    "is idempotent. Never exposes capabilities or manifest internals.",
    "",
    "Options:",
    "  --identity <guest-identity> Stable Guest identity (required; keep it stable)",
    "  --as <guest-name>           Guest display name (required)",
    "  --callback <socket>    This session's callback socket path (required)",
    "  --format <format>      toon (default), json, or text",
    "",
    "Use `/guest crews` inside the session to list pending and approved crews.",
    ""
  ].join("\n");
}
function guestLeaveHelp() {
  return [
    "pi-bebop guest leave <member-socket> --crew <crew-id> --identity <guest-identity> --callback <socket> [--format toon|json|text]",
    "",
    "Revoke one Crew membership at its Member socket. The Member validates the",
    "guest identity, crew id, and callback endpoint before revoking.",
    "",
    "Options:",
    "  --crew <crew-id>            Crew id to leave (required)",
    "  --identity <guest-identity> Guest identity used at join time (required)",
    "  --callback <socket>         Callback socket path used at join time (required)",
    "  --format <format>           toon (default), json, or text",
    ""
  ].join("\n");
}
var defaultGuestCliDependencies = { sendCommand: sendRpcCommand };
function guestWireErrorCode(error) {
  if (error instanceof RpcProtocolError && error.code === "remote-error") {
    const memberCode = error.message.slice("remote-error:".length).trim();
    if (memberCode.length > 0) return memberCode;
  }
  if (error instanceof RpcProtocolError) return error.code;
  const code = errorCode(error);
  return code === "offline" ? "join-failed" : code;
}
function targetFromError(error) {
  return error instanceof Error && error.message.length > 0 ? error.message : "transport error";
}
async function runGuestJoinCommand(options, _context, deps = defaultGuestCliDependencies) {
  if (options.help) return { kind: "help", text: guestJoinHelp() };
  try {
    const { response } = await deps.sendCommand(
      options.target,
      {
        type: "guest_join",
        guestIdentity: options.guestIdentity,
        guestName: options.guestName,
        callbackEndpoint: options.callback
      },
      { timeout: 5e3 }
    );
    if (!response.success || !isGuestJoinResult(response.data)) {
      return {
        kind: "result",
        result: errorResult(
          response.error ?? "invalid admission response",
          options.target,
          response.error ?? "invalid-admission-response"
        ),
        format: options.format,
        full: false
      };
    }
    return {
      kind: "result",
      result: {
        ok: true,
        target: options.target,
        status: response.data.status,
        data: {
          status: response.data.status,
          requestId: response.data.requestId,
          crew: response.data.crew,
          next: response.data.status === "pending" ? "wait for an exact configured approver to run /crew guest approve" : "admission approved"
        }
      },
      format: options.format,
      full: false
    };
  } catch (error) {
    const code = guestWireErrorCode(error);
    return {
      kind: "result",
      result: errorResult(targetFromError(error), options.target, code),
      format: options.format,
      full: false
    };
  }
}
async function runGuestLeaveCommand(options, _context, deps = defaultGuestCliDependencies) {
  if (options.help) return { kind: "help", text: guestLeaveHelp() };
  try {
    const { response } = await deps.sendCommand(
      options.target,
      {
        type: "guest_leave",
        guestIdentity: options.guestIdentity,
        crewId: options.crewId,
        callbackEndpoint: options.callback
      },
      { timeout: 5e3 }
    );
    if (!response.success) {
      return {
        kind: "result",
        result: errorResult(
          response.error ?? "remote rejection",
          options.target,
          response.error ?? "leave-failed"
        ),
        format: options.format,
        full: false
      };
    }
    return {
      kind: "result",
      result: {
        ok: true,
        target: options.target,
        status: "left",
        data: { status: "left", crew: options.crewId }
      },
      format: options.format,
      full: false
    };
  } catch (error) {
    const code = guestWireErrorCode(error);
    return {
      kind: "result",
      result: errorResult(targetFromError(error), options.target, code),
      format: options.format,
      full: false
    };
  }
}

// src/cli/commands/member-message.ts
var FORMATS5 = ["toon", "json", "text"];
var MAX_TARGET_BYTES3 = 256;
var MAX_MESSAGE_BYTES = 1e6;
var MAX_INSTRUCTION_BYTES = 1e5;
function isCliFormat5(value) {
  return FORMATS5.includes(value);
}
function intentWord(intent) {
  return intent === "follow_up" ? "follow-up" : "redirect";
}
function buildMemberMessageCommand(intent) {
  const word = intentWord(intent);
  const label3 = intent === "follow_up" ? "Follow-up" : "Redirect";
  const description = intent === "follow_up" ? "Send a normal follow-up to a joined crew member (accepted-delivery only)" : "Insert a message into a crew member's active work (accepted-delivery only)";
  return new Command(word).description(description).option("--session <id|alias>", "Source joined Pi session id or alias (default: PI_SESSION_ID)").option("--message <text>", "Message text").option("--stdin", "Read message from stdin").option("--instruction <value>", "Instruction (repeatable, ordered)", collect2, []).option("--format <format>", "Output format: toon (default), json, or text", "toon").argument("[<member>]", "Crew member name or unique role").showHelpAfterError(false).helpOption(false);
}
function collect2(value, previous) {
  return previous.concat([value]);
}
function memberMessageHelp(intent) {
  const word = intentWord(intent);
  const delivery = intent === "follow_up" ? "waits behind the target's active work" : "enters before the target's next model step";
  return [
    `pi-bebop member ${word} <member> [--session <id|alias>] (--message <text> | --stdin) [--instruction <text>...] [--format toon|json|text]`,
    "",
    `Send a member ${label(intent)} through one already-joined Pi session, which derives`,
    "membership and trust authoritatively. The CLI never loads a crew manifest.",
    "",
    `Delivery: online normal ${label(intent)}; ${delivery}. Accepted means the message was`,
    "accepted for delivery \u2014 it NEVER means replied, delivered work, or completed.",
    "There is no wait_for flag: Pi cannot prove delivery-level response correlation.",
    "",
    "Options:",
    "  --session <id|alias>    Source joined Pi session id or alias (default: PI_SESSION_ID)",
    "  --message <text>        Message text (exactly one of --message or --stdin)",
    "  --stdin                 Read the message from stdin",
    "  --instruction <text>    Ordered instruction (repeatable, at most 32)",
    "  --format <format>       toon (default), json, or text",
    "",
    `Discover sessions with: ${SESSION_LIST_HINT}`,
    ""
  ].join("\n");
}
function label(intent) {
  return intent === "follow_up" ? "Follow-up" : "Redirect";
}
var VALID_FLAGS4 = "--session <id|alias>, --message <text>, --stdin, --instruction <text>, --format toon|json|text, --help";
function mapCommanderError4(error) {
  const match = /--[a-z-]+/.exec(error.message);
  const flag = match?.[0] ?? "--format";
  if (error.code === "commander.optionMissingArgument") return new UsageError(`Missing value for ${flag}`);
  if (error.code === "commander.unknownOption") {
    const unknown = /unknown option '(--?[^']+)'/.exec(error.message)?.[1] ?? "";
    if (unknown.startsWith("--wait"))
      return new UsageError(
        `Unknown flag '${unknown}'; this command is accepted-delivery only and never waits for a reply`
      );
    return new UsageError(`Unknown flag '${unknown}'; valid flags: ${VALID_FLAGS4}`);
  }
  if (error.code === "commander.excessArguments")
    return new UsageError(`Too many arguments; valid flags: ${VALID_FLAGS4}`);
  return new UsageError(error.message);
}
var SINGLE_VALUE_FLAGS = /* @__PURE__ */ new Set(["--session", "--message", "--format"]);
function validateMessageContent(message, source) {
  if (message.length === 0 || message.trim().length === 0)
    throw new UsageError(`--${source} received empty content; provide UTF-8 message text`);
  if (message.includes("\0")) throw new UsageError(`--${source} must not contain NUL bytes`);
  if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES)
    throw new UsageError(`--${source} exceeds the ${MAX_MESSAGE_BYTES}-byte message limit`);
}
function validateInstructions(instructions) {
  if (instructions.length > MAX_MESSAGE_INSTRUCTIONS)
    throw new UsageError(`Too many --instruction values; maximum is ${MAX_MESSAGE_INSTRUCTIONS}`);
  for (const instruction of instructions) {
    if (instruction.length === 0 || instruction !== instruction.trim())
      throw new UsageError("Each --instruction must be trimmed and non-empty");
    if (instruction.includes("\0")) throw new UsageError("--instruction must not contain NUL bytes");
    if (Buffer.byteLength(instruction, "utf8") > MAX_INSTRUCTION_BYTES)
      throw new UsageError(`--instruction exceeds the ${MAX_INSTRUCTION_BYTES}-byte limit`);
  }
}
function parseMemberMessageCommand(args, intent, _cwd = process.cwd()) {
  const tokens = [];
  let help = false;
  const seen = /* @__PURE__ */ new Set();
  const instructionValues = [];
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    const equals = raw.indexOf("=");
    const flag = equals > 0 ? raw.slice(0, equals) : raw;
    if (flag === "--help") {
      if (help) throw new UsageError("Duplicate flag: --help");
      help = true;
      continue;
    }
    if (flag === "--instruction") {
      let value;
      let escaped = false;
      if (equals > 0) value = raw.slice(equals + 1);
      else if (args[index + 1] === "--" && args[index + 2] !== void 0) {
        value = args[index + 2];
        escaped = true;
        index += 2;
      } else value = args[++index];
      if (value === void 0 || equals < 0 && !escaped && value.startsWith("--"))
        throw new UsageError("Missing value for --instruction");
      instructionValues.push(value);
      continue;
    }
    if (SINGLE_VALUE_FLAGS.has(flag) || flag === "--stdin") {
      if (seen.has(flag)) throw new UsageError(`Duplicate flag: ${flag}`);
      seen.add(flag);
      if (flag === "--stdin" || equals > 0) {
        tokens.push(raw);
        continue;
      }
      if (args[index + 1] === "--" && args[index + 2] !== void 0) {
        tokens.push(`${flag}=${args[index + 2]}`);
        index += 2;
        continue;
      }
      tokens.push(raw);
      continue;
    }
    tokens.push(raw);
  }
  const program2 = buildMemberMessageCommand(intent).exitOverride().configureOutput({ writeOut: () => {
  }, writeErr: () => {
  }, outputError: () => {
  } });
  let opts;
  try {
    program2.parse(tokens, { from: "user" });
    opts = program2.opts();
  } catch (error) {
    if (error instanceof CommanderError) throw mapCommanderError4(error);
    throw error;
  }
  const format = opts.format ?? "toon";
  if (!isCliFormat5(format))
    throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
  validateInstructions(instructionValues);
  const member = program2.args[0] ?? "";
  if (!help && member.trim().length === 0)
    throw new UsageError("Missing <member>; provide a crew member name or unique role");
  if (!help && (member !== member.trim() || Buffer.byteLength(member, "utf8") > MAX_TARGET_BYTES3))
    throw new UsageError(`<member> must be trimmed and at most ${MAX_TARGET_BYTES3} UTF-8 bytes`);
  const hasMessage = opts.message !== void 0;
  const hasStdin = opts.stdin === true;
  if (!help) {
    if (hasMessage && hasStdin)
      throw new UsageError("Choose exactly one message source: --message <text> or --stdin");
    if (!hasMessage && !hasStdin) throw new UsageError("Missing message source; use --message <text> or --stdin");
    if (hasMessage && opts.message.trim().length === 0) throw new UsageError("--message must not be empty");
    if (hasMessage) validateMessageContent(opts.message, "message");
  }
  return {
    command: intent === "follow_up" ? "member-follow-up" : "member-redirect",
    intent,
    member: member.trim(),
    ...opts.session === void 0 ? {} : { session: opts.session },
    ...hasMessage ? { message: opts.message } : {},
    instructions: instructionValues,
    stdin: hasStdin,
    format,
    ...help ? { help: true } : {}
  };
}
function mapTransportError2(error) {
  if (error instanceof RpcProtocolError && error.code === "outcome-unknown")
    return { ok: false, code: "outcome-unknown" };
  if (error instanceof Error && error.name === "AbortError") return { ok: false, code: "aborted" };
  const systemCode = error instanceof Error ? error.code : void 0;
  if (systemCode === "ENOENT") return { ok: false, code: "unknown-session" };
  if (systemCode === "ECONNREFUSED" || systemCode === "ENOTCONN") return { ok: false, code: "offline-session" };
  if (error instanceof Error && /timed? ?out|timeout/i.test(error.message)) return { ok: false, code: "timeout" };
  return { ok: false, code: "transport-error" };
}
async function deliverThroughSocket(source, command, signal) {
  const resolved = await resolveMemberEndpoint(source.idSocketPath);
  try {
    const { response } = await sendRpcCommand(
      resolved,
      {
        type: command.type,
        target: command.target,
        message: command.message,
        ...command.instructions.length === 0 ? {} : { instructions: [...command.instructions] }
      },
      { timeout: 5e3, signal }
    );
    if (!response.success) return { ok: false, code: response.error ?? "remote-rejected" };
    if (!isMemberMessageResult(response.data)) return { ok: false, code: "malformed-response" };
    return { ok: true, result: response.data };
  } catch (error) {
    if (error instanceof RpcProtocolError && error.code === "remote-error") {
      return { ok: false, code: error.message.replace(/^remote-error:\s*/, "") };
    }
    throw error;
  }
}
var defaultMemberMessageCliDependencies = {
  resolveSource: (input) => resolveSourceSession(input),
  readStdin: readStdinMessage,
  deliverMessage: async (source, command, signal) => {
    try {
      return await deliverThroughSocket(source, command, signal);
    } catch (idError) {
      const mapped = mapTransportError2(idError);
      if (mapped.code !== "unknown-session") return mapped;
      try {
        return await deliverThroughSocket({ ...source, idSocketPath: source.aliasSocketPath }, command, signal);
      } catch (aliasError) {
        return mapTransportError2(aliasError);
      }
    }
  },
  environmentSession: () => process.env.PI_SESSION_ID
};
async function runMemberMessageCommand(options, context, deps = defaultMemberMessageCliDependencies) {
  if (options.help) return { kind: "help", text: memberMessageHelp(options.intent) };
  const target = options.member;
  const source = deps.resolveSource({
    explicitSession: options.session,
    environmentSession: deps.environmentSession()
  });
  if (!isSourceFailure2(source)) {
    let message = options.message;
    if (options.stdin) {
      message = await deps.readStdin(context.input, context.signal);
      validateMessageContent(message, "stdin");
    }
    if (message === void 0) throw new UsageError("Missing message source; use --message <text> or --stdin");
    const outcome = await deps.deliverMessage(
      source,
      {
        type: options.intent === "redirect" ? "member_redirect" : "member_follow_up",
        target,
        message,
        instructions: options.instructions
      },
      context.signal
    );
    if (outcome.ok === false) {
      return {
        kind: "result",
        result: errorResult(`Member delivery failed: ${outcome.code}`, target, outcome.code),
        format: options.format,
        full: false
      };
    }
    return {
      kind: "result",
      result: {
        ok: true,
        target,
        status: "accepted",
        response: `${outcome.result.member.name} (${outcome.result.member.role}) \u2014 ${outcome.result.disposition} \u2014 delivery ${outcome.result.deliveryId}`,
        data: {
          member: outcome.result.member,
          deliveryId: outcome.result.deliveryId,
          disposition: outcome.result.disposition
        }
      },
      format: options.format,
      full: false
    };
  }
  return {
    kind: "result",
    result: usageResult(source.message, source.code),
    format: options.format,
    full: false
  };
}
function isSourceFailure2(source) {
  return !source.ok;
}

// src/cli/commands/durable-message.ts
var FORMATS6 = ["toon", "json", "text"];
var MAX_TARGET_BYTES4 = 256;
var MAX_MESSAGE_BYTES2 = 1e6;
var MAX_INSTRUCTION_BYTES2 = 1e5;
function isCliFormat6(value) {
  return FORMATS6.includes(value);
}
function label2(intent) {
  return intent === "inbox" ? "Inbox" : "Broadcast";
}
function commandWords(intent) {
  return intent === "inbox" ? ["member", "inbox", "send"] : ["crew", "broadcast"];
}
function buildDurableMessageCommand(intent) {
  const words = commandWords(intent);
  const command = words[words.length - 1];
  let program2 = new Command(command).description(
    intent === "inbox" ? "Persist one durable Inbox item for a crew member" : "Send a transient non-interrupting Broadcast Follow-up to every other crew member"
  ).option("--session <id|alias>", "Source joined Pi session id or alias (default: PI_SESSION_ID)").option("--message <text>", "Message text").option("--stdin", "Read message from stdin").option("--instruction <value>", "Instruction (repeatable, ordered)", collect3, []).option("--format <format>", "Output format: toon (default), json, or text", "toon");
  if (intent === "inbox") program2 = program2.argument("[<member>]");
  return program2.showHelpAfterError(false).helpOption(false);
}
function collect3(value, previous) {
  return previous.concat([value]);
}
function durableMessageHelp(intent) {
  const command = intent === "inbox" ? "member inbox send <member>" : "crew broadcast";
  const target = intent === "inbox" ? "one configured member" : "every other configured member in manifest order";
  return [
    `pi-bebop ${command} [--session <id|alias>] (--message <text> | --stdin) [--instruction <text>...] [--format toon|json|text]`,
    "",
    intent === "inbox" ? `${label2(intent)} persists durable Inbox data for ${target}.` : `${label2(intent)} sends one transient Follow-up to ${target}; each recipient is attempted independently.`,
    intent === "inbox" ? "The selected joined source derives membership, trust, origin, manifest, and storage paths." : "The selected joined source derives membership, origin, and manifest; the sender is excluded.",
    "The CLI never accepts caller-supplied source identity, manifest, socket, or reply fields.",
    "",
    intent === "inbox" ? "Success means persisted (and an optional best-effort hint), never read, delivered, or completed." : "Success means every recipient accepted a Follow-up; partial delivery reports each failed recipient.",
    "There is no wait_for flag: the delivery acknowledgement is the only guarantee; it never proves the model read or acted.",
    intent === "broadcast" ? "Broadcast never writes or falls back to Inbox, redirects, interrupts, or expects a Response." : "",
    "",
    "Options:",
    "  --session <id|alias>    Source joined Pi session id or alias (default: PI_SESSION_ID)",
    "  --message <text>        Message text (exactly one of --message or --stdin)",
    "  --stdin                 Read the message from stdin",
    "  --instruction <text>    Ordered instruction (repeatable, at most 32)",
    "  --format <format>       toon (default), json, or text",
    "",
    `Discover sessions with: ${SESSION_LIST_HINT}`,
    ""
  ].filter((line) => line !== "").join("\n") + "\n";
}
var VALID_FLAGS5 = "--session <id|alias>, --message <text>, --stdin, --instruction <text>, --format toon|json|text, --help";
function mapCommanderError5(error) {
  if (error.code === "commander.optionMissingArgument") return new UsageError("Missing option value");
  if (error.code === "commander.unknownOption") {
    const unknown = /unknown option '([^']+)'/.exec(error.message)?.[1] ?? "";
    if (unknown.startsWith("--wait"))
      return new UsageError(`Unknown flag '${unknown}'; this command never waits for delivery`);
    return new UsageError(`Unknown flag '${unknown}'; valid flags: ${VALID_FLAGS5}`);
  }
  if (error.code === "commander.excessArguments")
    return new UsageError(`Too many arguments; valid flags: ${VALID_FLAGS5}`);
  return new UsageError(error.message);
}
function validateContent(message, source) {
  if (message.length === 0 || message.trim().length === 0) throw new UsageError(`--${source} received empty content`);
  if (message.includes("\0")) throw new UsageError(`--${source} must not contain NUL bytes`);
  if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES2)
    throw new UsageError(`--${source} exceeds the ${MAX_MESSAGE_BYTES2}-byte message limit`);
}
function validateInstructions2(instructions) {
  if (instructions.length > 32) throw new UsageError("Too many --instruction values; maximum is 32");
  for (const instruction of instructions) {
    if (instruction.length === 0 || instruction !== instruction.trim())
      throw new UsageError("Each --instruction must be trimmed and non-empty");
    if (instruction.includes("\0")) throw new UsageError("--instruction must not contain NUL bytes");
    if (Buffer.byteLength(instruction, "utf8") > MAX_INSTRUCTION_BYTES2)
      throw new UsageError(`--instruction exceeds the ${MAX_INSTRUCTION_BYTES2}-byte limit`);
  }
}
function parseDurableMessageCommand(args, intent, cwd = process.cwd()) {
  const tokens = [];
  const instructions = [];
  let help = false;
  const seen = /* @__PURE__ */ new Set();
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    const equals = raw.indexOf("=");
    const flag = equals > 0 ? raw.slice(0, equals) : raw;
    if (flag === "--help") {
      if (help) throw new UsageError("Duplicate flag: --help");
      help = true;
      continue;
    }
    if (flag === "--instruction") {
      const value = equals > 0 ? raw.slice(equals + 1) : args[++index];
      if (value === void 0 || value.startsWith("--")) throw new UsageError("Missing value for --instruction");
      instructions.push(value);
      continue;
    }
    if (["--session", "--message", "--stdin", "--format"].includes(flag)) {
      if (seen.has(flag)) throw new UsageError(`Duplicate flag: ${flag}`);
      seen.add(flag);
      tokens.push(raw);
      continue;
    }
    tokens.push(raw);
  }
  const program2 = buildDurableMessageCommand(intent).exitOverride().configureOutput({ writeOut: () => {
  }, writeErr: () => {
  }, outputError: () => {
  } });
  let opts;
  try {
    program2.parse(tokens, { from: "user" });
    opts = program2.opts();
  } catch (error) {
    if (error instanceof CommanderError) throw mapCommanderError5(error);
    throw error;
  }
  const format = opts.format ?? "toon";
  if (!isCliFormat6(format))
    throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
  validateInstructions2(instructions);
  const member = intent === "inbox" ? program2.args[0] ?? "" : void 0;
  if (!help && intent === "inbox" && (!member || member.trim().length === 0))
    throw new UsageError("Missing <member>");
  if (!help && intent === "inbox" && (member !== member.trim() || Buffer.byteLength(member, "utf8") > MAX_TARGET_BYTES4))
    throw new UsageError(`<member> must be trimmed and at most ${MAX_TARGET_BYTES4} UTF-8 bytes`);
  const hasMessage = opts.message !== void 0;
  const hasStdin = opts.stdin === true;
  if (!help) {
    if (hasMessage === hasStdin)
      throw new UsageError("Choose exactly one message source: --message <text> or --stdin");
    if (hasMessage) validateContent(opts.message, "message");
  }
  return {
    command: intent === "inbox" ? "member-inbox-send" : "crew-broadcast",
    intent,
    ...member === void 0 ? {} : { member: member.trim() },
    ...opts.session === void 0 ? {} : { session: opts.session },
    ...hasMessage ? { message: opts.message } : {},
    instructions,
    stdin: hasStdin,
    format,
    ...help ? { help: true } : {}
  };
}
var REMOTE_MESSAGE_CODES = /* @__PURE__ */ new Set([
  "not-joined",
  "unknown-sender",
  "unknown-member",
  "ambiguous-role",
  "self-send",
  "invalid-payload",
  "untrusted-project",
  "inbox-full",
  "inbox-untrusted-path",
  "storage-unavailable",
  "storage-failed",
  "invalid-item-id",
  "aborted",
  "no-recipients"
]);
function transportError(error) {
  if (error instanceof RpcProtocolError && (error.code === "outcome-unknown" || REMOTE_MESSAGE_CODES.has(error.code)))
    return { ok: false, code: error.code };
  if (error instanceof Error && error.name === "AbortError") return { ok: false, code: "aborted" };
  const systemCode = error instanceof Error ? error.code : void 0;
  if (systemCode === "ENOENT") return { ok: false, code: "unknown-session" };
  if (systemCode === "ECONNREFUSED" || systemCode === "ENOTCONN") return { ok: false, code: "offline-session" };
  if (error instanceof Error && /timeout/i.test(error.message)) return { ok: false, code: "timeout" };
  return { ok: false, code: "transport-error" };
}
async function deliverSocket(source, command, signal) {
  const { response } = await sendRpcCommand(
    await resolveMemberEndpoint(source.idSocketPath),
    { ...command, ...command.instructions === void 0 ? {} : { instructions: [...command.instructions] } },
    { timeout: 5e3, signal, classifyLostAck: true }
  );
  if (!response.success) return { ok: false, code: response.error ?? "remote-rejected" };
  if (command.type === "member_inbox_send" && isMemberInboxSendResult(response.data))
    return { ok: true, result: response.data };
  if (command.type === "crew_broadcast" && isCrewBroadcastResult(response.data))
    return { ok: true, result: response.data };
  return { ok: false, code: "malformed-response" };
}
var defaultDurableMessageCliDependencies = {
  resolveSource: (input) => resolveSourceSession(input),
  readStdin: readStdinMessage,
  deliver: async (source, command, signal) => {
    try {
      return await deliverSocket(source, command, signal);
    } catch (error) {
      const mapped = transportError(error);
      if (mapped.code !== "unknown-session" || source.aliasSocketPath === source.idSocketPath) return mapped;
      try {
        return await deliverSocket({ ...source, idSocketPath: source.aliasSocketPath }, command, signal);
      } catch (aliasError) {
        return transportError(aliasError);
      }
    }
  },
  environmentSession: () => process.env.PI_SESSION_ID
};
function inboxOutcome(result, member, format) {
  return {
    kind: "result",
    result: {
      ok: true,
      target: member ?? "member",
      status: "persisted",
      response: `${result.member.name} (${result.member.role}) \u2014 persisted ${result.itemId}`,
      data: result
    },
    format,
    full: false
  };
}
function broadcastOutcome(result, format) {
  const partial = result.summary.failed > 0;
  return {
    kind: "result",
    result: {
      ok: !partial,
      target: "crew",
      status: partial ? "partial" : "delivered",
      response: `${result.summary.delivered} delivered, ${result.summary.failed} failed`,
      data: result,
      ...partial ? {
        error: {
          code: "partial",
          message: "Broadcast partially delivered; inspect each recipient disposition"
        }
      } : {}
    },
    format,
    full: false
  };
}
async function runDurableMessageCommand(options, context, deps = defaultDurableMessageCliDependencies) {
  if (options.help) return { kind: "help", text: durableMessageHelp(options.intent) };
  const source = deps.resolveSource({
    explicitSession: options.session,
    environmentSession: deps.environmentSession()
  });
  if (source.ok === false)
    return {
      kind: "result",
      result: usageResult(source.message, source.code),
      format: options.format,
      full: false
    };
  let message = options.message;
  if (options.stdin) {
    message = await deps.readStdin(context.input, context.signal);
    validateContent(message, "stdin");
  }
  const instructions = options.instructions.length === 0 ? void 0 : options.instructions;
  const command = options.intent === "inbox" ? {
    type: "member_inbox_send",
    target: options.member,
    message,
    ...instructions === void 0 ? {} : { instructions }
  } : { type: "crew_broadcast", message, ...instructions === void 0 ? {} : { instructions } };
  const outcome = await deps.deliver(source, command, context.signal);
  if (outcome.ok === false)
    return {
      kind: "result",
      result: errorResult(`Durable message failed: ${outcome.code}`, options.member ?? "crew", outcome.code),
      format: options.format,
      full: false
    };
  return options.intent === "inbox" ? inboxOutcome(outcome.result, options.member, options.format) : broadcastOutcome(outcome.result, options.format);
}

// src/cli/commands/member-interrupt.ts
function buildMemberInterruptCommand() {
  return new Command("interrupt").description("Hard-interrupt stuck or harmful work and deliver recovery guidance (best-effort, no rollback)").option("--session <id|alias>", "Source joined Pi session id or alias (default: PI_SESSION_ID)").option("--message <text>", "Recovery guidance message").option("--stdin", "Read recovery guidance from stdin").option("--instruction <value>", "Instruction (repeatable, ordered)", collect4, []).option("--format <format>", "Output format: toon (default), json, or text", "toon").argument("[<member>]", "Crew member name or unique role").showHelpAfterError(false).helpOption(false);
}
function collect4(value, previous) {
  return previous.concat([value]);
}
function memberInterruptHelp() {
  return [
    "pi-bebop member interrupt <member> [--session <id|alias>] (--message <text> | --stdin) [--instruction <text>...] [--format toon|json|text]",
    "",
    "Hard-interrupt a joined crew member only when work is stuck, harmful, or based on invalid assumptions.",
    "The target owns recovery evidence ordering. Abort is best-effort: it cannot roll back completed effects,",
    "non-cooperative work, filesystem changes, network effects, or claim target completion.",
    "An accepted result means recovery was handed off with a disposition; it never means work was undone or done.",
    "",
    "Options:",
    "  --session <id|alias>    Source joined Pi session id or alias (default: PI_SESSION_ID)",
    "  --message <text>        Recovery guidance (exactly one of --message or --stdin)",
    "  --stdin                 Read recovery guidance from stdin",
    "  --instruction <text>    Ordered instruction (repeatable, at most 32)",
    "  --format <format>       toon (default), json, or text",
    "",
    `Discover sessions with: ${SESSION_LIST_HINT}`,
    ""
  ].join("\n");
}
function parseMemberInterruptCommand(args, cwd = process.cwd()) {
  const parsed = parseMemberMessageCommand(args, "follow_up", cwd);
  return {
    command: "member-interrupt",
    member: parsed.member,
    ...parsed.session === void 0 ? {} : { session: parsed.session },
    ...parsed.message === void 0 ? {} : { message: parsed.message },
    instructions: parsed.instructions,
    stdin: parsed.stdin,
    format: parsed.format,
    ...parsed.help ? { help: true } : {}
  };
}
function mapInterruptTransportError(error) {
  if (error instanceof RpcProtocolError && error.code === "remote-error")
    return { ok: false, code: error.message.replace(/^remote-error:\s*/, "") };
  if (error instanceof RpcProtocolError && error.code === "outcome-unknown")
    return { ok: false, code: "outcome-unknown" };
  if (error instanceof Error && error.name === "AbortError") return { ok: false, code: "aborted" };
  if (error instanceof Error && /timeout/i.test(error.message)) return { ok: false, code: "timeout" };
  const code = error instanceof Error ? error.code : void 0;
  if (code === "ENOENT") return { ok: false, code: "unknown-session" };
  if (code === "ECONNREFUSED" || code === "ENOTCONN") return { ok: false, code: "offline-session" };
  return { ok: false, code: "transport-error" };
}
async function deliverThroughSocket2(source, command, signal) {
  const endpoint = await resolveMemberEndpoint(source.idSocketPath);
  try {
    const { response } = await sendRpcCommand(endpoint, command, { timeout: 5e3, signal, classifyLostAck: true });
    if (!response.success) return { ok: false, code: response.error ?? "remote-rejected" };
    if (!isMemberInterruptResult(response.data)) return { ok: false, code: "invalid-ack" };
    return { ok: true, result: response.data };
  } catch (error) {
    return mapInterruptTransportError(error);
  }
}
var defaultMemberInterruptCliDependencies = {
  resolveSource: (input) => resolveSourceSession(input),
  readStdin: readStdinMessage,
  deliverInterrupt: deliverThroughSocket2,
  environmentSession: () => process.env.PI_SESSION_ID
};
async function runMemberInterruptCommand(options, context, deps = defaultMemberInterruptCliDependencies) {
  if (options.help) return { kind: "help", text: memberInterruptHelp() };
  const source = deps.resolveSource({
    explicitSession: options.session,
    environmentSession: deps.environmentSession()
  });
  if (source.ok === false)
    return {
      kind: "result",
      result: usageResult(source.message, source.code),
      format: options.format,
      full: false
    };
  let message = options.message;
  if (options.stdin) {
    message = await deps.readStdin(context.input, context.signal);
    if (message.trim().length === 0)
      throw new UsageError("--stdin received empty content; provide UTF-8 recovery guidance");
  }
  if (message === void 0) throw new UsageError("Missing message source; use --message <text> or --stdin");
  const command = {
    type: "member_interrupt",
    target: options.member,
    message,
    ...options.instructions.length === 0 ? {} : { instructions: [...options.instructions] }
  };
  const outcome = await deps.deliverInterrupt(source, command, context.signal);
  if (outcome.ok === false)
    return {
      kind: "result",
      result: errorResult(`Member interrupt failed: ${outcome.code}`, options.member, outcome.code),
      format: options.format,
      full: false
    };
  const text = outcome.result.disposition === "direct" ? "idle target; recovery handed off directly" : "abort requested best-effort; recovery handed off ahead of queued follow-ups";
  return {
    kind: "result",
    result: {
      ok: true,
      target: options.member,
      status: "accepted",
      response: `${text} (${outcome.result.interruptId})`,
      data: outcome.result
    },
    format: options.format,
    full: false
  };
}

// src/cli/commands/crew-roles.ts
import { promises as fs9 } from "node:fs";
import * as path13 from "node:path";
var FORMATS7 = ["toon", "json", "text"];
function isCliFormat7(value) {
  return FORMATS7.includes(value);
}
function buildCrewRolesCommand() {
  return new Command("roles").description("List configured crew roles (read-only discovery)").option("--format <format>", "Output format: toon (default), json, or text", "toon").option("--full", "Full response without truncation").showHelpAfterError(false).helpOption(false);
}
function crewRolesHelp() {
  return [
    "pi-bebop crew roles [--format toon|json|text] [--full]",
    "",
    "List the configured crew roles in the project's crew manifest. Read-only",
    "discovery for choosing --crew-role <role> at Pi startup: prints distinct",
    "exact role values in first-manifest-appearance order plus manifest-level",
    "counts. Never starts a server, never joins a member, never mutates files,",
    "and never exposes member names, instructions, socket paths, or session",
    "destinations.",
    "",
    "Options:",
    "  --format <format>   toon (default), json, or text",
    "  --full              Full response without truncation",
    "",
    "Manifest resolution: reads .pi/bebop/crew.json (or the .pi/crew",
    "compatibility layout) rooted at the current working directory.",
    ""
  ].join("\n");
}
function parseCrewRolesCommand(args, _cwd = process.cwd()) {
  const tokens = [];
  let help = false;
  let full = false;
  let seenFormat = false;
  for (const raw of args) {
    const equals = raw.indexOf("=");
    const flag = equals > 0 ? raw.slice(0, equals) : raw;
    if (flag === "--help") {
      if (help) throw new UsageError("Duplicate flag: --help");
      help = true;
      continue;
    }
    if (flag === "--full") {
      if (full) throw new UsageError("Duplicate flag: --full");
      full = true;
      tokens.push(raw);
      continue;
    }
    if (flag === "--format") {
      if (seenFormat) throw new UsageError("Duplicate flag: --format");
      seenFormat = true;
      tokens.push(raw);
      continue;
    }
    tokens.push(raw);
  }
  const program2 = buildCrewRolesCommand().exitOverride().configureOutput({ writeOut: () => {
  }, writeErr: () => {
  }, outputError: () => {
  } });
  let opts;
  try {
    program2.parse(tokens, { from: "user" });
    opts = program2.opts();
  } catch (error) {
    if (error instanceof CommanderError) {
      const match = /--[a-z-]+/.exec(error.message);
      const flag = match?.[0] ?? "--format";
      throw new UsageError(
        error.code === "commander.optionMissingArgument" ? `Missing value for ${flag}` : error.message
      );
    }
    throw error;
  }
  const format = opts.format ?? "toon";
  if (!isCliFormat7(format))
    throw new UsageError(`Invalid --format '${format}'; valid alternatives: toon, json, text`);
  return { command: "crew-roles", format, full, ...help ? { help: true } : {} };
}
var defaultCrewRolesDependencies = {
  manifestExists: async (manifestPath) => {
    try {
      await fs9.access(manifestPath);
      return true;
    } catch {
      return false;
    }
  },
  // Caller-consent framing (TASK-0040): the explicit CLI working directory is
  // the consent. The trusted store re-validates the exact layout and the
  // full manifest parsing/instruction rules; we never report Pi-trust.
  readManifest: (manifestPath, projectRoot) => readTrustedCrewManifest(manifestPath, projectRoot, () => true)
};
function mapManifestError(error, manifestPath) {
  if (error instanceof CrewManifestReadError) return errorResult(error.message, manifestPath, error.code);
  if (error instanceof CrewManifestError) return errorResult(error.message, manifestPath, error.code);
  const message = error instanceof Error ? error.message : "Crew manifest read failed";
  return errorResult(message, manifestPath, "operational");
}
async function runCrewRolesCommand(options, context, deps = defaultCrewRolesDependencies) {
  if (options.help) return { kind: "help", text: crewRolesHelp() };
  const projectRoot = path13.resolve(context.cwd);
  const manifestPaths = getTrustedCrewManifestPaths(projectRoot);
  const existing = (await Promise.all(
    manifestPaths.map(async (manifestPath2) => ({
      manifestPath: manifestPath2,
      exists: await deps.manifestExists(manifestPath2)
    }))
  )).filter((item) => item.exists);
  if (existing.length === 0) {
    return {
      kind: "result",
      result: errorResult(
        "no supported crew manifest found beneath the project",
        projectRoot,
        "missing-manifest"
      ),
      format: options.format,
      full: options.full
    };
  }
  if (existing.length > 1) {
    return {
      kind: "result",
      result: errorResult(
        "both supported crew manifests exist (.pi/bebop and .pi/crew); remove one",
        projectRoot,
        "ambiguous-manifest"
      ),
      format: options.format,
      full: options.full
    };
  }
  const manifestPath = existing[0].manifestPath;
  let manifest;
  try {
    manifest = await deps.readManifest(manifestPath, projectRoot);
  } catch (error) {
    return {
      kind: "result",
      result: mapManifestError(error, manifestPath),
      format: options.format,
      full: options.full
    };
  }
  const projection = projectCrewRoles(manifest);
  const roles = [...projection.roles];
  return {
    kind: "result",
    result: {
      ok: true,
      target: manifestPath,
      status: "listed",
      response: `${projection.roleCount} configured role${projection.roleCount === 1 ? "" : "s"}: ${roles.join(", ")}`,
      data: { roles, roleCount: projection.roleCount, memberCount: projection.memberCount }
    },
    format: options.format,
    full: options.full
  };
}

// src/cli/registry.ts
function findOrCreate(parent, name, description) {
  const existing = parent.commands.find((candidate) => candidate.name() === name);
  if (existing) return existing;
  const child = new Command(name);
  if (description !== void 0) child.description(description);
  parent.addCommand(child);
  return child;
}
var GROUP_DESCRIPTIONS = {
  crew: "Crew commands",
  guest: "Guest commands",
  member: "Member commands",
  session: "Session commands"
};
function buildRootCommand(leaves) {
  const root = new Command("pi-bebop").description("Pi Bebop crew coordination CLI");
  for (const leaf of leaves) {
    if (leaf.names.length === 0) continue;
    if (leaf.names.length === 1) {
      root.addCommand(leaf.build());
      continue;
    }
    let parent = root;
    for (const word of leaf.names.slice(0, -1)) {
      parent = findOrCreate(parent, word, GROUP_DESCRIPTIONS[word]);
    }
    parent.addCommand(leaf.build());
  }
  return root;
}
function composeRegistry(leaves) {
  const vocabulary = leaves.filter((leaf) => leaf.names.length > 0).map((leaf) => leaf.names.join(" "));
  const effectiveLeaves = leaves.map(
    (leaf) => leaf.id === "home" ? {
      ...leaf,
      run: (_options, context) => runHomeCommand(context.cwd, vocabulary, process.env, process.argv[1])
    } : leaf
  );
  const byId = new Map(effectiveLeaves.map((leaf) => [leaf.id, leaf]));
  return {
    leaves: effectiveLeaves,
    vocabulary: () => vocabulary,
    leafById: (id) => {
      const leaf = byId.get(id);
      if (leaf === void 0) throw new UsageError(`Unknown command '${id}'`);
      return leaf;
    },
    parseCliCommand: (args, cwd = process.cwd()) => {
      if (args.length === 0) {
        const home = byId.get("home");
        if (home === void 0) throw new UsageError("No command provided");
        return home.parse([], cwd);
      }
      let best;
      for (const leaf of effectiveLeaves) {
        if (leaf.names.length === 0 || leaf.names.length > args.length) continue;
        let matches = true;
        for (let index = 0; index < leaf.names.length; index += 1) {
          if (leaf.names[index] !== args[index]) {
            matches = false;
            break;
          }
        }
        if (matches && (best === void 0 || leaf.names.length > best.leaf.names.length)) {
          best = { leaf, tokens: args.slice(leaf.names.length) };
        }
      }
      if (best === void 0)
        throw new UsageError(`Invalid command '${args[0] ?? ""}'; valid commands: ${vocabulary.join(", ")}`);
      return best.leaf.parse(best.tokens, cwd);
    },
    root: () => buildRootCommand(effectiveLeaves)
  };
}
var homeLeaf = {
  id: "home",
  names: [],
  build: () => new Command("home"),
  // never added to the root tree (no command word)
  help: () => "",
  parse: () => ({ command: "home" }),
  // Vocabulary is wired by composeRegistry; this base body is never used.
  run: (_options, context) => runHomeCommand(context.cwd, [], process.env, process.argv[1])
};
var sendLeaf = {
  id: "send",
  names: ["send"],
  build: () => buildSendCommand(),
  help: () => sendHelp(),
  parse: (tokens, cwd) => parseSendCommand([...tokens], cwd),
  run: (options, context) => runSendCommand(options, context)
};
var crewInitLeaf = {
  id: "crew-init",
  names: ["crew", "init"],
  build: () => buildCrewInitCommand(),
  help: () => crewInitHelp(),
  parse: (tokens, cwd) => parseCrewInitCommand([...tokens], cwd),
  run: (options, context) => runCrewInitCommand(options, context.cwd)
};
var guestJoinLeaf = {
  id: "guest-join",
  names: ["guest", "join"],
  build: () => buildGuestJoinCommand(),
  help: () => guestJoinHelp(),
  parse: (tokens) => parseGuestJoinCommand(tokens),
  run: (options, context) => runGuestJoinCommand(options, context)
};
var guestLeaveLeaf = {
  id: "guest-leave",
  names: ["guest", "leave"],
  build: () => buildGuestLeaveCommand(),
  help: () => guestLeaveHelp(),
  parse: (tokens) => parseGuestLeaveCommand(tokens),
  run: (options, context) => runGuestLeaveCommand(options, context)
};
var crewRolesLeaf = {
  id: "crew-roles",
  names: ["crew", "roles"],
  build: () => buildCrewRolesCommand(),
  help: () => crewRolesHelp(),
  parse: (tokens, cwd) => parseCrewRolesCommand([...tokens], cwd),
  run: (options, context) => runCrewRolesCommand(options, context)
};
var memberStatusLeaf = {
  id: "member-status",
  names: ["member", "status"],
  build: () => buildMemberStatusCommand(),
  help: () => memberStatusHelp(),
  parse: (tokens, cwd) => parseMemberStatusCommand([...tokens], cwd),
  run: (options, context) => runMemberStatusCommand(options, context)
};
var memberIdleWaitLeaf = {
  id: "member-idle-wait",
  names: ["member", "wait-idle"],
  build: () => buildMemberIdleWaitCommand(),
  help: () => memberIdleWaitHelp(),
  parse: (tokens, cwd) => parseMemberIdleWaitCommand([...tokens], cwd),
  run: (options, context) => runMemberIdleWaitCommand(options, context)
};
var sessionListLeaf = {
  id: "session-list",
  names: ["session", "list"],
  build: () => buildSessionListCommand(),
  help: () => sessionListHelp(),
  parse: (tokens, cwd) => parseSessionListCommand([...tokens], cwd),
  run: (options, context) => runSessionListCommand(options, context)
};
var memberFollowUpLeaf = {
  id: "member-follow-up",
  names: ["member", "follow-up"],
  build: () => buildMemberMessageCommand("follow_up"),
  help: () => memberMessageHelp("follow_up"),
  parse: (tokens, cwd) => parseMemberMessageCommand([...tokens], "follow_up", cwd),
  run: (options, context) => runMemberMessageCommand(options, context)
};
var memberRedirectLeaf = {
  id: "member-redirect",
  names: ["member", "redirect"],
  build: () => buildMemberMessageCommand("redirect"),
  help: () => memberMessageHelp("redirect"),
  parse: (tokens, cwd) => parseMemberMessageCommand([...tokens], "redirect", cwd),
  run: (options, context) => runMemberMessageCommand(options, context)
};
var memberInboxSendLeaf = {
  id: "member-inbox-send",
  names: ["member", "inbox", "send"],
  build: () => buildDurableMessageCommand("inbox"),
  help: () => durableMessageHelp("inbox"),
  parse: (tokens, cwd) => parseDurableMessageCommand([...tokens], "inbox", cwd),
  run: (options, context) => runDurableMessageCommand(options, context)
};
var memberInterruptLeaf = {
  id: "member-interrupt",
  names: ["member", "interrupt"],
  build: () => buildMemberInterruptCommand(),
  help: () => memberInterruptHelp(),
  parse: (tokens, cwd) => parseMemberInterruptCommand([...tokens], cwd),
  run: (options, context) => runMemberInterruptCommand(options, context)
};
var crewBroadcastLeaf = {
  id: "crew-broadcast",
  names: ["crew", "broadcast"],
  build: () => buildDurableMessageCommand("broadcast"),
  help: () => durableMessageHelp("broadcast"),
  parse: (tokens, cwd) => parseDurableMessageCommand([...tokens], "broadcast", cwd),
  run: (options, context) => runDurableMessageCommand(options, context)
};
function createCliRegistry() {
  return composeRegistry([
    homeLeaf,
    sendLeaf,
    crewInitLeaf,
    crewRolesLeaf,
    memberStatusLeaf,
    memberIdleWaitLeaf,
    sessionListLeaf,
    memberFollowUpLeaf,
    memberRedirectLeaf,
    memberInterruptLeaf,
    memberInboxSendLeaf,
    crewBroadcastLeaf,
    guestJoinLeaf,
    guestLeaveLeaf
  ]);
}

// node_modules/@toon-format/toon/dist/index.mjs
var NULL_LITERAL = "null";
var DELIMITERS = {
  comma: ",",
  tab: "	",
  pipe: "|"
};
var DEFAULT_DELIMITER = DELIMITERS.comma;
function escapeString(value) {
  return value.replace(/\\/g, `\\\\`).replace(/"/g, `\\"`).replace(/\n/g, `\\n`).replace(/\r/g, `\\r`).replace(/\t/g, `\\t`).replace(/[\u0000-\u001F]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
var FETCH_LINE = Symbol("fetch-line");
function isBooleanOrNullLiteral(token) {
  return token === "true" || token === "false" || token === "null";
}
function setOwnProperty(target, key, value) {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true
    });
    return;
  }
  target[key] = value;
}
var COMMENT_LINE_PATTERN = new RegExp(`(?:^\uFEFF?|\\n) *#`);
var RawString = class {
  constructor(value) {
    if (COMMENT_LINE_PATTERN.test(value)) throw new TypeError(`Raw string must not contain a line starting with "#": ${JSON.stringify(value)}`);
    this.value = value;
  }
};
function isRawString(value) {
  return value instanceof RawString;
}
var SURROGATE_PATTERN = /[\uD800-\uDFFF]/;
function normalizeValue(value) {
  if (value === null) return null;
  if (isRawString(value)) return value;
  if (typeof value === "object" && value !== null && "toJSON" in value && typeof value.toJSON === "function") {
    const next = value.toJSON();
    if (next !== value) return normalizeValue(next);
  }
  if (typeof value === "string") {
    assertNoLoneSurrogate(value, "string value");
    return value;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Object.is(value, -0)) return 0;
    if (!Number.isFinite(value)) return null;
    return value;
  }
  if (typeof value === "bigint") {
    if (value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER) return Number(value);
    return value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value instanceof Set) return Array.from(value).map(normalizeValue);
  if (value instanceof Map) return Object.fromEntries(Array.from(value, ([k, v]) => [String(k), normalizeValue(v)]));
  if (isPlainObject(value)) {
    const encodedValues = {};
    for (const key in value) if (Object.hasOwn(value, key)) {
      assertNoLoneSurrogate(key, "object key");
      setOwnProperty(encodedValues, key, normalizeValue(value[key]));
    }
    return encodedValues;
  }
  return null;
}
function assertNoLoneSurrogate(value, context) {
  if (!SURROGATE_PATTERN.test(value)) return;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 55296 || code > 57343) continue;
    const isHighSurrogate = code <= 56319;
    const next = value.charCodeAt(index + 1);
    if (isHighSurrogate && next >= 56320 && next <= 57343) {
      index++;
      continue;
    }
    throw new TypeError(`Cannot encode ${context} containing an unpaired surrogate U+${code.toString(16).toUpperCase()} at index ${index}`);
  }
}
function isJsonPrimitive(value) {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
function isEncodablePrimitive(value) {
  return isJsonPrimitive(value) || isRawString(value);
}
function isJsonArray(value) {
  return Array.isArray(value);
}
function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !isRawString(value);
}
function isEmptyObject(value) {
  return Object.keys(value).length === 0;
}
function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}
function isArrayOfPrimitives(value) {
  return value.length === 0 || value.every((item) => isEncodablePrimitive(item));
}
function isArrayOfArrays(value) {
  return value.length === 0 || value.every((item) => isJsonArray(item));
}
function isArrayOfObjects(value) {
  return value.length === 0 || value.every((item) => isJsonObject(item));
}
var NUMERIC_LIKE_PATTERN = /^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;
function assertValidDelimiter(delimiter) {
  if (!Object.values(DELIMITERS).includes(delimiter)) throw new TypeError(`Invalid delimiter ${JSON.stringify(delimiter)}. Valid delimiters are: comma (,), tab (\\t), pipe (|)`);
}
function isValidUnquotedKey(key) {
  return /^[A-Z_][\w.]*$/i.test(key);
}
function isSafeUnquoted(value, delimiter = DEFAULT_DELIMITER) {
  if (!value) return false;
  if (/^[ \t]|[ \t]$/.test(value)) return false;
  if (isBooleanOrNullLiteral(value) || isNumericLike(value)) return false;
  if (value.includes(":")) return false;
  if (value.includes('"') || value.includes("\\")) return false;
  if (/[[\]{}]/.test(value)) return false;
  if (/[\u0000-\u001F]/.test(value)) return false;
  if (value.includes(delimiter)) return false;
  if (value.startsWith("-")) return false;
  if (value.startsWith("#")) return false;
  return true;
}
function isNumericLike(value) {
  return NUMERIC_LIKE_PATTERN.test(value);
}
function encodePrimitive(value, delimiter) {
  if (isRawString(value)) return value.value;
  if (value === null) return NULL_LITERAL;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  return encodeStringLiteral(value, delimiter);
}
function encodeStringLiteral(value, delimiter = DEFAULT_DELIMITER) {
  if (isSafeUnquoted(value, delimiter)) return value;
  return `"${escapeString(value)}"`;
}
function encodeKey(key) {
  if (isValidUnquotedKey(key)) return key;
  return `"${escapeString(key)}"`;
}
function encodeAndJoinPrimitives(values, delimiter = DEFAULT_DELIMITER) {
  return values.map((v) => encodePrimitive(v, delimiter)).join(delimiter);
}
function formatHeader(length, options) {
  const key = options?.key;
  const fields = options?.fields;
  const delimiter = options?.delimiter ?? ",";
  let header = "";
  if (key != null) header += encodeKey(key);
  header += `[${length}${options?.keyed ? ":" : ""}${delimiter !== DEFAULT_DELIMITER ? delimiter : ""}]`;
  if (fields) header += `{${formatFieldSegment(fields, delimiter)}}`;
  header += ":";
  return header;
}
function formatFieldSegment(fields, delimiter) {
  return fields.map((field) => encodeKey(field.name) + (field.children ? `{${formatFieldSegment(field.children, delimiter)}}` : "")).join(delimiter);
}
function extractTabularFields(rows) {
  if (rows.length === 0) return;
  const firstKeys = Object.keys(rows[0]);
  if (firstKeys.length === 0) return;
  for (const row of rows) {
    if (Object.keys(row).length !== firstKeys.length) return;
    for (const key of firstKeys) if (!Object.hasOwn(row, key)) return;
  }
  const fieldNodes = [];
  for (const key of firstKeys) {
    const fieldNode = classifyColumn(key, rows.map((row) => row[key]));
    if (!fieldNode) return;
    fieldNodes.push(fieldNode);
  }
  return fieldNodes;
}
function extractKeyedTabularFields(value) {
  const entryValues = Object.values(value);
  if (entryValues.length < 2) return;
  if (!entryValues.every((entryValue) => isJsonObject(entryValue) && !isEmptyObject(entryValue))) return;
  return extractTabularFields(entryValues);
}
function collectRowLeaves(row, fields) {
  const leaves = [];
  collectLeafValues(row, fields, leaves);
  return leaves;
}
function classifyColumn(name, values) {
  if (values.every((value) => isEncodablePrimitive(value))) return { name };
  if (!values.every((value) => isJsonObject(value) && !isEmptyObject(value))) return;
  const children = extractTabularFields(values);
  if (!children) return;
  return {
    name,
    children
  };
}
function collectLeafValues(row, fields, leaves) {
  for (const field of fields) {
    const value = row[field.name];
    if (field.children) collectLeafValues(value, field.children, leaves);
    else leaves.push(value);
  }
}
function* encodeJsonValue(value, options, depth) {
  if (isEncodablePrimitive(value)) {
    const encodedPrimitive = encodePrimitive(value, options.delimiter);
    if (encodedPrimitive !== "") yield encodedPrimitive;
    return;
  }
  if (isJsonArray(value)) yield* encodeArrayLines(void 0, value, depth, options);
  else if (isJsonObject(value)) {
    const keyedFields = extractKeyedTabularFields(value);
    if (keyedFields) {
      yield* encodeKeyedObjectLines(void 0, value, keyedFields, depth, options);
      return;
    }
    yield* encodeObjectLines(value, depth, options);
  }
}
function* encodeObjectLines(value, depth, options) {
  for (const [key, val] of Object.entries(value)) yield* encodeKeyValuePairLines(key, val, depth, options);
}
function* encodeKeyValuePairLines(key, value, depth, options) {
  const encodedKey = encodeKey(key);
  if (isEncodablePrimitive(value)) yield indentedLine(depth, `${encodedKey}: ${encodePrimitive(value, options.delimiter)}`, options.indentSize);
  else if (isJsonArray(value)) yield* encodeArrayLines(key, value, depth, options);
  else if (isJsonObject(value)) {
    const keyedFields = extractKeyedTabularFields(value);
    if (keyedFields) {
      yield* encodeKeyedObjectLines(key, value, keyedFields, depth, options);
      return;
    }
    yield indentedLine(depth, `${encodedKey}:`, options.indentSize);
    if (!isEmptyObject(value)) yield* encodeObjectLines(value, depth + 1, options);
  }
}
function* encodeKeyedObjectLines(key, value, fields, depth, options) {
  const entries = Object.entries(value);
  yield indentedLine(depth, formatHeader(entries.length, {
    key,
    fields,
    delimiter: options.delimiter,
    keyed: true
  }), options.indentSize);
  yield* encodeKeyedEntryRowsLines(entries, fields, depth + 1, options);
}
function* encodeKeyedEntryRowsLines(entries, fields, depth, options) {
  for (const [entryKey, entryValue] of entries) {
    const leaves = collectRowLeaves(entryValue, fields);
    yield indentedLine(depth, `${encodeKey(entryKey)}: ${encodeAndJoinPrimitives(leaves, options.delimiter)}`, options.indentSize);
  }
}
function* encodeArrayLines(key, value, depth, options) {
  if (value.length === 0) {
    yield indentedLine(depth, key != null ? `${encodeKey(key)}: []` : "[]", options.indentSize);
    return;
  }
  if (isArrayOfPrimitives(value)) {
    yield indentedLine(depth, encodeInlineArrayLine(value, options.delimiter, key), options.indentSize);
    return;
  }
  if (isArrayOfArrays(value)) {
    if (value.every((arr) => isArrayOfPrimitives(arr))) {
      yield* encodeArrayOfArraysAsListItemsLines(key, value, depth, options);
      return;
    }
  }
  if (isArrayOfObjects(value)) {
    const fields = extractTabularFields(value);
    if (fields) yield* encodeArrayOfObjectsAsTabularLines(key, value, fields, depth, options);
    else yield* encodeMixedArrayAsListItemsLines(key, value, depth, options);
    return;
  }
  yield* encodeMixedArrayAsListItemsLines(key, value, depth, options);
}
function* encodeArrayOfArraysAsListItemsLines(prefix, values, depth, options) {
  yield indentedLine(depth, formatHeader(values.length, {
    key: prefix,
    delimiter: options.delimiter
  }), options.indentSize);
  for (const arr of values) if (isArrayOfPrimitives(arr)) {
    const arrayLine = encodeInlineArrayLine(arr, options.delimiter);
    yield indentedListItem(depth + 1, arrayLine, options.indentSize);
  }
}
function encodeInlineArrayLine(values, delimiter, prefix) {
  const header = formatHeader(values.length, {
    key: prefix,
    delimiter
  });
  const joinedValue = encodeAndJoinPrimitives(values, delimiter);
  if (values.length === 0) return header;
  return `${header} ${joinedValue}`;
}
function* encodeArrayOfObjectsAsTabularLines(prefix, rows, fields, depth, options) {
  yield indentedLine(depth, formatHeader(rows.length, {
    key: prefix,
    fields,
    delimiter: options.delimiter
  }), options.indentSize);
  yield* writeTabularRowsLines(rows, fields, depth + 1, options);
}
function* writeTabularRowsLines(rows, fields, depth, options) {
  for (const row of rows) yield indentedLine(depth, encodeAndJoinPrimitives(collectRowLeaves(row, fields), options.delimiter), options.indentSize);
}
function* encodeMixedArrayAsListItemsLines(prefix, items, depth, options) {
  yield indentedLine(depth, formatHeader(items.length, {
    key: prefix,
    delimiter: options.delimiter
  }), options.indentSize);
  for (const item of items) yield* encodeListItemValueLines(item, depth + 1, options);
}
function* encodeObjectAsListItemLines(obj, depth, options) {
  if (isEmptyObject(obj)) {
    yield indentedLine(depth, "-", options.indentSize);
    return;
  }
  const entries = Object.entries(obj);
  const [firstKey, firstValue] = entries[0];
  const restEntries = entries.slice(1);
  if (isJsonArray(firstValue) && isArrayOfObjects(firstValue)) {
    const fields = extractTabularFields(firstValue);
    if (fields) {
      yield indentedListItem(depth, formatHeader(firstValue.length, {
        key: firstKey,
        fields,
        delimiter: options.delimiter
      }), options.indentSize);
      yield* writeTabularRowsLines(firstValue, fields, depth + 2, options);
      if (restEntries.length > 0) yield* encodeObjectLines(Object.fromEntries(restEntries), depth + 1, options);
      return;
    }
  }
  if (isJsonObject(firstValue)) {
    const keyedFields = extractKeyedTabularFields(firstValue);
    if (keyedFields) {
      const keyedEntries = Object.entries(firstValue);
      yield indentedListItem(depth, formatHeader(keyedEntries.length, {
        key: firstKey,
        fields: keyedFields,
        delimiter: options.delimiter,
        keyed: true
      }), options.indentSize);
      yield* encodeKeyedEntryRowsLines(keyedEntries, keyedFields, depth + 2, options);
      if (restEntries.length > 0) yield* encodeObjectLines(Object.fromEntries(restEntries), depth + 1, options);
      return;
    }
  }
  const encodedKey = encodeKey(firstKey);
  if (isEncodablePrimitive(firstValue)) yield indentedListItem(depth, `${encodedKey}: ${encodePrimitive(firstValue, options.delimiter)}`, options.indentSize);
  else if (isJsonArray(firstValue)) if (firstValue.length === 0) yield indentedListItem(depth, `${encodedKey}: []`, options.indentSize);
  else if (isArrayOfPrimitives(firstValue)) yield indentedListItem(depth, `${encodedKey}${encodeInlineArrayLine(firstValue, options.delimiter)}`, options.indentSize);
  else {
    yield indentedListItem(depth, `${encodedKey}${formatHeader(firstValue.length, { delimiter: options.delimiter })}`, options.indentSize);
    for (const item of firstValue) yield* encodeListItemValueLines(item, depth + 2, options);
  }
  else if (isJsonObject(firstValue)) {
    yield indentedListItem(depth, `${encodedKey}:`, options.indentSize);
    if (!isEmptyObject(firstValue)) yield* encodeObjectLines(firstValue, depth + 2, options);
  }
  if (restEntries.length > 0) yield* encodeObjectLines(Object.fromEntries(restEntries), depth + 1, options);
}
function* encodeListItemValueLines(value, depth, options) {
  if (isEncodablePrimitive(value)) yield indentedListItem(depth, encodePrimitive(value, options.delimiter), options.indentSize);
  else if (isJsonArray(value)) if (isArrayOfPrimitives(value)) yield indentedListItem(depth, encodeInlineArrayLine(value, options.delimiter), options.indentSize);
  else {
    yield indentedListItem(depth, formatHeader(value.length, { delimiter: options.delimiter }), options.indentSize);
    for (const item of value) yield* encodeListItemValueLines(item, depth + 1, options);
  }
  else if (isJsonObject(value)) yield* encodeObjectAsListItemLines(value, depth, options);
}
function indentedLine(depth, content, indentSize) {
  return " ".repeat(indentSize * depth) + content;
}
function indentedListItem(depth, content, indentSize) {
  return indentedLine(depth, "- " + content, indentSize);
}
function applyReplacer(root, replacer) {
  const replacedRoot = replacer("", root, []);
  if (replacedRoot === void 0) return transformChildren(root, replacer, []);
  return transformReplaced(root, replacedRoot, replacer, []);
}
function transformReplaced(original, replaced, replacer, path14) {
  if (isRawString(replaced) && !isEncodablePrimitive(original)) return transformChildren(original, replacer, path14);
  return transformChildren(normalizeValue(replaced), replacer, path14);
}
function transformChildren(value, replacer, path14) {
  if (isJsonObject(value)) return transformObject(value, replacer, path14);
  if (isJsonArray(value)) return transformArray(value, replacer, path14);
  return value;
}
function transformObject(obj, replacer, path14) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const childPath = [...path14, key];
    const replacedValue = replacer(key, value, childPath);
    if (replacedValue === void 0) continue;
    setOwnProperty(result, key, transformReplaced(value, replacedValue, replacer, childPath));
  }
  return result;
}
function transformArray(arr, replacer, path14) {
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    const value = arr[i];
    const childPath = [...path14, i];
    const replacedValue = replacer(String(i), value, childPath);
    if (replacedValue === void 0) continue;
    result.push(transformReplaced(value, replacedValue, replacer, childPath));
  }
  return result;
}
function encode(input, options) {
  return Array.from(encodeLines(input, options)).join("\n");
}
function encodeLines(input, options) {
  const normalizedValue = normalizeValue(input);
  const resolvedOptions = resolveOptions(options);
  return encodeJsonValue(resolvedOptions.replacer ? applyReplacer(normalizedValue, resolvedOptions.replacer) : normalizedValue, resolvedOptions, 0);
}
function resolveOptions(options) {
  const delimiter = options?.delimiter ?? DEFAULT_DELIMITER;
  assertValidDelimiter(delimiter);
  return {
    indentSize: options?.indentSize ?? options?.indent ?? 2,
    delimiter,
    replacer: options?.replacer
  };
}

// src/cli/output.ts
function writeOutcome(output, outcome) {
  if (outcome.kind === "help") {
    output.write(outcome.text);
    return 0;
  }
  output.write(`${renderCliResult(outcome.result, outcome.format, outcome.full)}
`);
  if (outcome.result.status === "usage") return 2;
  return outcome.result.ok ? 0 : 1;
}
var MAX_RESPONSE = 2e3;
function renderCliResult(result, format, full) {
  if (format === "text") {
    if (!result.ok) return result.error?.message ?? "Operation failed";
    if (result.status === "persisted") return result.response ?? "Message persisted";
    return result.response ?? (result.status === "accepted" ? "Message accepted" : "Message completed");
  }
  const output = { ...result };
  if (result.response !== void 0) {
    const response = full ? result.response : result.response.slice(0, MAX_RESPONSE);
    output.response = response;
    output.truncation = {
      truncated: response.length < result.response.length,
      originalChars: result.response.length,
      shownChars: response.length
    };
  }
  return format === "json" ? JSON.stringify(output) : encode(output);
}

// src/cli/root-help.ts
function rootCliHelp(commands) {
  const listed = commands.length === 0 ? "  (none)" : commands.map((command) => `  ${command}`).join("\n");
  return [
    "pi-bebop \u2014 Pi Bebop crew coordination CLI",
    "",
    "Usage:",
    "  pi-bebop <command> [args] [flags]",
    "  pi-bebop --help | -h",
    "",
    "Commands:",
    listed,
    "",
    "Run 'pi-bebop <command> --help' for command details.",
    ""
  ].join("\n");
}

// src/cli/run.ts
function parsedFormat(options, args) {
  return options && typeof options.format === "string" ? options.format : requestedFormat(args);
}
async function runCli(args, cwd = process.cwd(), input = process.stdin, output = process.stdout) {
  const registry = createCliRegistry();
  if (args.length > 0 && (args[0] === "-h" || args[0] === "--help")) {
    return writeOutcome(output, { kind: "help", text: rootCliHelp(registry.vocabulary()) });
  }
  let options;
  try {
    options = registry.parseCliCommand(args, cwd);
  } catch (error) {
    return writeOutcome(output, {
      kind: "result",
      result: usageResult(error.message),
      format: requestedFormat(args),
      full: false
    });
  }
  const controller = new AbortController();
  const abortError = Object.assign(new Error("Operation aborted"), { name: "AbortError" });
  const abort = () => controller.abort(abortError);
  process.once("SIGINT", abort);
  try {
    const context = { cwd, input, signal: controller.signal };
    const leaf = registry.leafById(options.command);
    const outcome = await leaf.run(options, context);
    return writeOutcome(output, outcome);
  } catch (error) {
    if (error instanceof UsageError) {
      return writeOutcome(output, {
        kind: "result",
        result: usageResult(error.message),
        format: parsedFormat(options, args),
        full: false
      });
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", abort);
  }
}

// src/cli/main.ts
function isCliEntrypoint(argv1, moduleUrl) {
  if (typeof argv1 !== "string" || argv1.length === 0) return false;
  try {
    const invoked = realpathSync(argv1);
    const modulePath = realpathSync(fileURLToPath(moduleUrl));
    const normalized = modulePath.replaceAll("\\", "/");
    return invoked === modulePath && normalized.endsWith("/dist/cli/main.js");
  } catch {
    return false;
  }
}
if (isCliEntrypoint(process.argv[1], import.meta.url)) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "CLI failure"}
`);
    process.exitCode = 1;
  });
}
export {
  errorCode,
  isCliEntrypoint,
  runCli
};
