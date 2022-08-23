#!/usr/bin/env node
import 'source-map-support/register';

import * as _ from 'lodash';
import { Builtins, Cli, Command, Option } from 'clipanion';
import { loadConfig } from './lib/config';

const [ node, app, ...args ] = process.argv;

class ViewCommand extends Command {
    static paths = [['view']]

    cwd = Option.String('--cwd');
    config = Option.String('--config,-c', 'cohesion.yml');

    public async execute() {
        if (this.cwd)
            process.chdir(this.cwd);

        const config = await loadConfig(this.config);

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

        const config = await loadConfig(this.config);
        // console.log(config)

        // for await (const childConfig of config.resolveConfigs())
        //     console.log(childConfig);

        const vars = _(this.vars).map(v => v.split('=')).fromPairs().value()

        await config.exec(this.args, {
            vars
        });
    }
}

const cli = new Cli({
    binaryName: '[ cohesion, co ]',
    binaryLabel: 'Cohesion',
    binaryVersion: '1.0.0-alpha.9'
});

cli.register(ViewCommand);
cli.register(DefaultCommand);

cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);

cli.runExit(args).catch(err => {
    throw new Error(`Application failed to launch; ${err}`);
});
