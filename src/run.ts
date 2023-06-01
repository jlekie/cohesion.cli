#!/usr/bin/env node
import 'source-map-support/register';

import * as _ from 'lodash';
import { Builtins, Cli, Command, Option } from 'clipanion';
import { loadApp, parseArgs, Config } from '.';
import { EventEmitter } from 'stream';
import * as Path from 'path';
import * as FS from 'fs-extra';

EventEmitter.defaultMaxListeners = 100;

const [ node, app, ...args ] = process.argv;

class ViewCommand extends Command {
    static paths = [['view']]

    cwd = Option.String('--cwd');
    config = Option.String('--config,-c', 'cohesion.yml');

    public async execute() {
        if (this.cwd)
            process.chdir(this.cwd);

        const config = await Config.loadConfig(this.config);

        console.log(config);
        for await (const subConfig of config.resolveConfigs())
            console.log(subConfig.path, subConfig.labels)
    }
}

class DefaultCommand extends Command {
    static paths = [Command.Default]

    cwd = Option.String('--cwd');
    config = Option.String('--config,-c', 'cohesion.yml');

    vars = Option.Array('--var', []);

    args = Option.Rest();

    public async execute() {
        if (this.cwd)
            process.chdir(this.cwd);

        const config = await Config.loadConfig(this.config);
        const app = await loadApp(config);
        // console.log(config)

        // for await (const childConfig of config.resolveConfigs())
        //     console.log(childConfig);

        const vars = _(this.vars).map(v => v.split('=')).fromPairs().value()

        if (this.args.length) {
            for (const arg of this.args) {
                const parsedArgs = parseArgs(arg)
                await app.exec(parsedArgs, {
                    vars,
                    stdout: this.context.stdout
                });
            }
        }
        else {
            await app.exec([], {
                vars,
                stdout: this.context.stdout
            });
        }
    }
}

const packageManifest = FS.readJsonSync(Path.resolve(__dirname, '../package.json'));
const cli = new Cli({
    binaryName: `[ ${Object.keys(packageManifest.bin)} ]`,
    binaryLabel: 'Cohesion',
    binaryVersion: packageManifest.version
});

cli.register(ViewCommand);
cli.register(DefaultCommand);

cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);

cli.runExit(args).catch(err => {
    throw new Error(`Application failed to launch; ${err}`);
});
